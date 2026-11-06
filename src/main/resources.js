'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { paths } = require('./paths');

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_FILES = 20000;
const MANIFEST_TIMEOUT_MS = 2500;
const MANIFEST_COOLDOWN_MS = 15 * 60 * 1000;

const FALLBACK_MODPACK = {
  name: 'Chernobyl Z',
  minecraft: '1.20.1',
  forge: '47.4.28',
  revision: 1,
  manifestUrl: '',
  server: { name: 'Chernobyl Z', host: 'ChernobylZ.refugenodes.com', port: 25836 },
  channels: {
    COMPLETA: { label: 'COMPLETA', description: 'PCs potentes · ~6 GB RAM', memory: { min: 2048, max: 6144 } },
  },
  files: [],
};

let modpackCache = null;
let newsCache = null;
let authCache = null;

const FALLBACK_AUTH = {
  clientId: '',
  tenant: 'consumers',
  scope: 'XboxLive.signin offline_access',
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function isAllowedUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:') return true;
    // Solo para pruebas locales; en producción el manifiesto debe ir por HTTPS.
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (path.isAbsolute(value) || /^[a-z]:/i.test(value)) return false;
  return !value.split(/[\\/]+/).includes('..');
}

/** Valida un manifiesto remoto antes de confiar en sus rutas y URLs. */
function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.revision) || raw.revision < 1) return null;
  if (raw.minecraft != null && !/^[0-9A-Za-z._-]+$/.test(String(raw.minecraft))) return null;
  if (raw.forge != null && !/^[0-9A-Za-z._-]+$/.test(String(raw.forge))) return null;
  if (!raw.channels || typeof raw.channels !== 'object' || Array.isArray(raw.channels)) return null;
  if (Object.keys(raw.channels).length === 0) return null;

  for (const [id, channel] of Object.entries(raw.channels)) {
    if (!/^[A-Z0-9_-]+$/.test(id)) return null;
    if (!channel || typeof channel !== 'object' || Array.isArray(channel)) return null;
  }

  if (!Array.isArray(raw.files) || raw.files.length > MAX_MANIFEST_FILES) return null;
  for (const file of raw.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return null;
    if (!isSafeRelativePath(file.path)) return null;
    if (!isAllowedUrl(file.url)) return null;
    if (file.size != null && (!Number.isFinite(Number(file.size)) || Number(file.size) < 0)) return null;
    if (file.sha1 != null && !/^[a-f0-9]{40}$/i.test(String(file.sha1))) return null;
    if (file.channels != null) {
      if (!Array.isArray(file.channels) || !file.channels.every((channel) => typeof channel === 'string')) {
        return null;
      }
    }
  }

  if (raw.mods != null) {
    if (!Array.isArray(raw.mods)) return null;
    for (const mod of raw.mods) {
      if (!mod || typeof mod !== 'object' || Array.isArray(mod)) return null;
      if (mod.file != null && !isSafeRelativePath(mod.file)) return null;
    }
  }

  return raw;
}

function normalizeModpack(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    ...FALLBACK_MODPACK,
    ...raw,
    revision: Number(raw.revision) || 1,
    channels: { ...FALLBACK_MODPACK.channels, ...(raw.channels || {}) },
    files: Array.isArray(raw.files) ? raw.files : [],
  };
}

function readBundledModpack() {
  return normalizeModpack(readJson(paths.resource('modpack.json'), null)) || normalizeModpack(FALLBACK_MODPACK);
}

function loadModpack() {
  if (!modpackCache) {
    const bundled = readBundledModpack();
    const meta = readJson(paths.remoteModpackMeta, null);
    // Solo usamos la caché si pertenece a la misma URL configurada en el
    // manifiesto incluido; así un cambio de host no deja datos viejos.
    const cached = bundled.manifestUrl && meta?.url === bundled.manifestUrl
      ? normalizeModpack(validateManifest(readJson(paths.remoteModpack, null)))
      : null;
    const chosen = cached && cached.revision > bundled.revision ? cached : bundled;
    // La URL de refresco siempre sale del manifiesto incluido en el launcher:
    // un manifiesto remoto no puede cambiar de dónde se descargan los suyos.
    modpackCache = { ...chosen, manifestUrl: bundled.manifestUrl || '' };
  }
  return modpackCache;
}

/**
 * Descarga el manifiesto remoto si está configurado. Es opcional: sin
 * `manifestUrl` el launcher funciona exactamente igual con el manifiesto local.
 * Si la red falla o el JSON no es válido, conserva el manifiesto actual.
 */
async function refreshModpack(urlOverride = '', options = {}) {
  const bundled = readBundledModpack();
  const url = String(urlOverride || bundled.manifestUrl || '').trim();
  if (!url) return { updated: false, reason: 'sin-url' };
  if (!isAllowedUrl(url)) return { updated: false, reason: 'url-invalida' };

  const current = loadModpack();
  const meta = readJson(paths.remoteModpackMeta, null);
  const now = Date.now();
  if (
    !options.force &&
    meta &&
    meta.url === url &&
    now - Number(meta.fetchedAt) < MANIFEST_COOLDOWN_MS
  ) {
    return { updated: false, reason: 'reciente', revision: current.revision };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);

  try {
    const requestUrl = new URL(url);
    requestUrl.searchParams.set('_', String(now));
    const response = await fetch(requestUrl, {
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!isAllowedUrl(response.url)) throw new Error('redirección no permitida');

    const declared = Number(response.headers.get('content-length')) || 0;
    if (declared > MAX_MANIFEST_BYTES) throw new Error('manifiesto demasiado grande');

    const text = await response.text();
    if (text.length > MAX_MANIFEST_BYTES) throw new Error('manifiesto demasiado grande');

    const remote = validateManifest(JSON.parse(text));
    if (!remote) throw new Error('manifiesto inválido');

    fs.mkdirSync(paths.cache, { recursive: true });
    fs.writeFileSync(paths.remoteModpackMeta, JSON.stringify({ url, fetchedAt: now }, null, 2), 'utf8');

    if (remote.revision <= current.revision) {
      return { updated: false, reason: 'sin-cambios', revision: current.revision };
    }

    fs.writeFileSync(paths.remoteModpack, JSON.stringify(remote, null, 2), 'utf8');
    modpackCache = {
      ...normalizeModpack(remote),
      manifestUrl: bundled.manifestUrl || '',
    };
    console.log(`[manifest] Actualizado a la revisión ${remote.revision}.`);
    return { updated: true, revision: remote.revision };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'tiempo agotado' : String(error?.message || error);
    console.warn(`[manifest] No se pudo actualizar (${reason}); se usa el manifiesto local.`);
    return { updated: false, reason: 'error', error: reason };
  } finally {
    clearTimeout(timer);
  }
}

function getChannel(id) {
  const modpack = loadModpack();
  const key = String(id || '').toUpperCase();
  const channel = modpack.channels[key] || modpack.channels.COMPLETA || Object.values(modpack.channels)[0];
  return { ...channel, id: modpack.channels[key] ? key : Object.keys(modpack.channels)[0] };
}

/** Archivos que pertenecen a un canal (los sin `channels` aplican a todos). */
function filesForChannel(id) {
  const modpack = loadModpack();
  return modpack.files.filter((file) => {
    if (!Array.isArray(file.channels) || file.channels.length === 0) return true;
    return file.channels.map((channel) => String(channel).toUpperCase()).includes(String(id).toUpperCase());
  });
}

function loadNews() {
  if (!newsCache) {
    const raw = readJson(paths.resource('news.json'), { items: [] });
    newsCache = Array.isArray(raw.items) ? raw.items : [];
  }
  return newsCache;
}

function loadLinks() {
  return readJson(paths.resource('links.json'), {
    discord: '',
    store: '',
    youtube: '',
    tiktok: '',
    instagram: '',
  });
}

/** Configuración de la app de Azure usada para el login Microsoft. */
function loadAuth() {
  if (!authCache) {
    const raw = readJson(paths.resource('auth.json'), null) || {};
    authCache = { ...FALLBACK_AUTH, ...raw };
  }
  return authCache;
}

module.exports = {
  loadModpack,
  refreshModpack,
  getChannel,
  filesForChannel,
  loadNews,
  loadLinks,
  loadAuth,
};
