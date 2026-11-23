'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { paths } = require('./paths');

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_FILES = 20000;
const MANIFEST_TIMEOUT_MS = 5000;
const MANIFEST_COOLDOWN_MS = 15 * 60 * 1000;
const NEWS_URL = 'https://github.com/PapuBeto/DefChernobylLauncher/releases/download/modpack-assets/news.json';
const NEWS_TIMEOUT_MS = 4500;
const MAX_NEWS_BYTES = 1024 * 1024;
const MAX_NEWS_ITEMS = 100;

const FALLBACK_MODPACK = {
  name: 'Chernobyl Z',
  minecraft: '1.20.1',
  forge: '47.4.28',
  revision: 1,
  manifestUrl: '',
  server: { name: 'Chernobyl Z', host: 'ChernobylZ.refugenodes.com', port: 25836 },
  channels: {
    COMPLETA: { label: 'COMPLETA', description: 'PCs potentes · ~6 GB RAM', memory: { min: 2048, max: 6144 } },
    LITE: { label: 'LITE', description: 'Gama baja-media · ~4 GB RAM', memory: { min: 1536, max: 4096 } },
    PRUEBAS: { label: 'PRUEBAS', description: 'Versión experimental · Puede fallar', memory: { min: 2048, max: 6144 } },
  },
  files: [],
};

let modpackCache = null;
let newsCache = null;
let authCache = null;
const inFlightNews = new Map();

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

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temporary, file);
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

function normalizeChannels(rawChannels) {
  if (Array.isArray(rawChannels)) {
    const map = {};
    for (const entry of rawChannels) {
      if (typeof entry !== 'string') continue;
      const id = entry.trim().toUpperCase();
      if (!/^[A-Z0-9_-]+$/.test(id)) continue;
      const base = FALLBACK_MODPACK.channels[id];
      map[id] = base ? { ...base } : { label: id };
    }
    return Object.keys(map).length > 0 ? map : null;
  }

  if (!rawChannels || typeof rawChannels !== 'object') return null;

  const map = {};
  for (const [rawId, channel] of Object.entries(rawChannels)) {
    const id = String(rawId).trim().toUpperCase();
    if (!/^[A-Z0-9_-]+$/.test(id)) return null;
    if (!channel || typeof channel !== 'object' || Array.isArray(channel)) return null;
    const base = FALLBACK_MODPACK.channels[id] || {};
    map[id] = { label: id, ...base, ...channel };
  }
  return Object.keys(map).length > 0 ? map : null;
}

/** Valida un manifiesto remoto antes de confiar en sus rutas y URLs. */
function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.revision) || raw.revision < 1) return null;
  if (raw.minecraft != null && !/^[0-9A-Za-z._-]+$/.test(String(raw.minecraft))) return null;
  if (raw.forge != null && !/^[0-9A-Za-z._-]+$/.test(String(raw.forge))) return null;

  const channels = normalizeChannels(raw.channels);
  if (!channels) return null;

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
  const channels = normalizeChannels(raw.channels);
  return {
    ...FALLBACK_MODPACK,
    ...raw,
    revision: Number(raw.revision) || 1,
    channels: channels || { ...FALLBACK_MODPACK.channels },
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
    const useRemote = Boolean(cached && cached.revision > bundled.revision);
    const chosen = useRemote ? cached : bundled;
    // La URL de refresco siempre sale del manifiesto incluido en el launcher:
    // un manifiesto remoto no puede cambiar de dónde se descargan los suyos.
    modpackCache = {
      ...chosen,
      manifestUrl: bundled.manifestUrl || '',
      source: useRemote ? 'remote' : 'bundled',
    };
  }
  return modpackCache;
}

async function fetchRemoteJson(url, { timeoutMs, maxBytes, limitError }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestUrl = new URL(url);
    requestUrl.searchParams.set('_', String(Date.now()));
    const response = await fetch(requestUrl, {
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!isAllowedUrl(response.url)) throw new Error('redirección no permitida');

    const declared = Number(response.headers.get('content-length')) || 0;
    if (declared > maxBytes) throw new Error(limitError);

    const text = (await response.text()).replace(/^\uFEFF/, '');
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(limitError);

    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
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

  try {
    const parsed = await fetchRemoteJson(url, {
      timeoutMs: MANIFEST_TIMEOUT_MS,
      maxBytes: MAX_MANIFEST_BYTES,
      limitError: 'manifiesto demasiado grande',
    });
    const remote = validateManifest(parsed);
    if (!remote) throw new Error('manifiesto inválido');

    fs.mkdirSync(paths.cache, { recursive: true });

    if (remote.revision <= current.revision) {
      writeJsonAtomic(paths.remoteModpackMeta, { url, fetchedAt: now });
      return { updated: false, reason: 'sin-cambios', revision: current.revision };
    }

    writeJsonAtomic(paths.remoteModpack, remote);
    writeJsonAtomic(paths.remoteModpackMeta, { url, fetchedAt: now });
    modpackCache = {
      ...normalizeModpack(remote),
      manifestUrl: bundled.manifestUrl || '',
      source: 'remote',
    };
    console.log(`[manifest] Actualizado a la revisión ${remote.revision}.`);
    return { updated: true, revision: remote.revision };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'tiempo agotado' : String(error?.message || error);
    console.warn(`[manifest] No se pudo actualizar (${reason}); se usa el manifiesto local.`);
    return { updated: false, reason: 'error', error: reason };
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

/** Valida la estructura de noticias remotas o empaquetadas antes de exponerlas al renderer. */
function validateNews(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Array.isArray(raw.items) || raw.items.length > MAX_NEWS_ITEMS) return null;

  const items = [];
  for (let i = 0; i < raw.items.length; i += 1) {
    const item = raw.items[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (typeof item.title !== 'string' || !item.title.trim()) return null;

    for (const field of ['id', 'shortTitle', 'date', 'tag', 'body', 'description', 'type']) {
      if (item[field] != null && typeof item[field] !== 'string') return null;
    }
    if (item.featured != null && typeof item.featured !== 'boolean') return null;

    const bodyText = typeof item.body === 'string'
      ? item.body.trim()
      : (typeof item.description === 'string' ? item.description.trim() : '');

    const normalized = {
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `news-${i + 1}`,
      title: item.title.trim(),
      date: typeof item.date === 'string' ? item.date.trim() : '',
      tag: typeof item.tag === 'string' ? item.tag.trim() : '',
      body: bodyText,
      description: bodyText,
      type: ['update', 'fix', 'server'].includes(item.type) ? item.type : 'update',
    };
    if (typeof item.shortTitle === 'string' && item.shortTitle.trim()) {
      normalized.shortTitle = item.shortTitle.trim();
    }
    if (typeof item.featured === 'boolean') {
      normalized.featured = item.featured;
    }
    items.push(normalized);
  }

  return {
    version: Number(raw.version) || 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    items,
  };
}

function readBundledNews() {
  return validateNews(readJson(paths.resource('news.json'), null)) || { version: 1, updatedAt: '', items: [] };
}

function loadNews() {
  if (!newsCache) {
    const cached = validateNews(readJson(paths.remoteNews, null));
    const bundled = readBundledNews();
    newsCache = (cached || bundled).items;
  }
  return newsCache;
}

/**
 * Descarga `news.json` desde GitHub Releases sin lanzar excepciones. Si la red
 * falla o el JSON es inválido, conserva la caché local o el `news.json` incluido.
 */
async function refreshNews(urlOverride = '') {
  const url = String(urlOverride || NEWS_URL).trim();
  if (!url) return { updated: false, changed: false, reason: 'sin-url', items: loadNews() };
  if (!isAllowedUrl(url)) return { updated: false, changed: false, reason: 'url-invalida', items: loadNews() };

  if (inFlightNews.has(url)) {
    return inFlightNews.get(url);
  }

  const task = (async () => {
    try {
      const raw = await fetchRemoteJson(url, {
        timeoutMs: NEWS_TIMEOUT_MS,
        maxBytes: MAX_NEWS_BYTES,
        limitError: 'archivo de noticias demasiado grande',
      });
      const valid = validateNews(raw);
      if (!valid) throw new Error('noticias inválidas');

      const previous = loadNews();
      const changed = JSON.stringify(previous) !== JSON.stringify(valid.items);
      writeJsonAtomic(paths.remoteNews, valid);
      newsCache = valid.items;

      if (changed) {
        console.log(`[news] Actualizadas ${valid.items.length} noticias remotas.`);
      }
      return { updated: true, changed, count: valid.items.length, items: valid.items };
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'tiempo agotado' : String(error?.message || error);
      console.warn(`[news] No se pudo actualizar (${reason}); se usan las noticias locales.`);
      return { updated: false, changed: false, reason: 'error', error: reason, items: loadNews() };
    } finally {
      inFlightNews.delete(url);
    }
  })();

  inFlightNews.set(url, task);
  return task;
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
  refreshNews,
  loadLinks,
  loadAuth,
};
