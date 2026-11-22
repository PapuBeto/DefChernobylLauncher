'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { paths } = require('./paths');
const authManager = require('./auth');

/**
 * Descarga la textura de la skin del perfil y la devuelve como data URL para
 * que el renderer pueda recortar la cara sin CORS ni conexión al abrir el launcher.
 * Solo se aceptan texturas de Mojang.
 */

const memory = new Map();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;
const MOJANG_PROFILE_LOOKUP = 'https://api.mojang.com/users/profiles/minecraft';
const MOJANG_SESSION_PROFILE = 'https://sessionserver.mojang.com/session/minecraft/profile';

function normalizeTextureUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.hostname !== 'textures.minecraft.net') return null;
    if (!/^\/texture\/[a-f0-9]+$/i.test(url.pathname)) return null;
    return `https://textures.minecraft.net${url.pathname}`;
  } catch {
    return null;
  }
}

function cacheDir() {
  return path.join(paths.cache, 'skins');
}

function cacheFile(url) {
  return path.join(cacheDir(), `${url.split('/').pop()}.png`);
}

/** Mapa perfil → URL de textura, para no preguntar a Mojang en cada arranque. */
function readUrls() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(cacheDir(), 'urls.json'), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeUrls(map) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(path.join(cacheDir(), 'urls.json'), JSON.stringify(map, null, 2), 'utf8');
  } catch {
    // La caché es opcional: si falla, se vuelve a resolver la próxima vez.
  }
}

async function fetchSessionSkin(uuid, options = {}) {
  const cleanUuid = String(uuid || '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(cleanUuid)) return null;

  let response;
  try {
    response = await fetch(`${MOJANG_SESSION_PROFILE}/${cleanUuid}`, {
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    if (options.strict) {
      throw new Error('No se pudo conectar con Mojang. Comprueba tu conexión a internet.');
    }
    return null;
  }

  if (response.status === 429) {
    if (options.strict) {
      throw new Error('Mojang ha limitado las búsquedas. Espera un momento e inténtalo de nuevo.');
    }
    return null;
  }

  if (!response.ok) {
    if (options.strict && response.status !== 404 && response.status !== 204) {
      throw new Error(`Mojang devolvió un error al leer la skin (HTTP ${response.status}).`);
    }
    return null;
  }

  let profile;
  try {
    profile = await response.json();
  } catch {
    if (options.strict) throw new Error('Mojang devolvió una respuesta inválida.');
    return null;
  }

  const encoded = profile?.properties?.find((item) => item.name === 'textures')?.value;
  if (!encoded) return null;

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    if (options.strict) throw new Error('No se pudo leer la textura del perfil en Mojang.');
    return null;
  }

  const skin = decoded?.textures?.SKIN;
  const url = normalizeTextureUrl(skin?.url);
  if (!url) return null;

  const variant = String(skin?.metadata?.model || '').toLowerCase() === 'slim'
    ? 'slim'
    : 'classic';

  return { url, variant };
}

/**
 * Resuelve la textura: primero lo guardado en accounts.json, luego la caché y
 * por último el perfil público de Mojang (funciona con sesiones antiguas).
 */
async function resolveUrl(profileId) {
  const stored = normalizeTextureUrl(authManager.skinUrl(profileId));
  if (stored) return stored;

  const urls = readUrls();
  const cached = normalizeTextureUrl(urls[profileId]);
  if (cached) return cached;

  const match = /^ms:([0-9a-f-]{32,36})$/i.exec(String(profileId));
  if (!match) return null;

  const resolved = await fetchSessionSkin(match[1]);
  if (!resolved?.url) return null;

  urls[profileId] = resolved.url;
  writeUrls(urls);
  return resolved.url;
}

/** Olvida la URL cacheada de un perfil (tras cambiar o restaurar su skin). */
function forget(profileId) {
  const urls = readUrls();
  if (!Object.prototype.hasOwnProperty.call(urls, profileId)) return;
  delete urls[profileId];
  writeUrls(urls);
}

async function textureDataUrl(rawUrl) {
  const url = normalizeTextureUrl(rawUrl);
  if (!url) return null;

  if (memory.has(url)) return memory.get(url);

  const file = cacheFile(url);
  let buffer = null;

  try {
    buffer = fs.readFileSync(file);
  } catch {
    buffer = null;
  }

  if (!buffer) {
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    } catch {
      throw new Error('No se pudo descargar la textura de Mojang. Comprueba tu conexión.');
    }

    if (!response.ok) {
      throw new Error(`No se pudo descargar la skin (HTTP ${response.status}).`);
    }

    buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 2_000_000) {
      throw new Error('Textura de skin no válida.');
    }

    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(file, buffer);
  }

  const value = `data:image/png;base64,${buffer.toString('base64')}`;
  memory.set(url, value);
  return value;
}

async function dataUrl(profileId) {
  const url = await resolveUrl(profileId);
  return url ? textureDataUrl(url) : null;
}

/** Busca la skin pública de un jugador de Minecraft (Java Edition) por nick. */
async function lookupByUsername(username) {
  const clean = String(username || '').trim();
  if (!USERNAME_RE.test(clean)) {
    throw new Error('Escribe un nombre válido de Minecraft (3–16 caracteres: letras, números o _).');
  }

  let response;
  try {
    response = await fetch(`${MOJANG_PROFILE_LOOKUP}/${encodeURIComponent(clean)}`, {
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('No se pudo conectar con Mojang. Comprueba tu conexión a internet.');
  }

  if (response.status === 404 || response.status === 204) {
    throw new Error('No se encontró ningún jugador de Minecraft con ese nombre.');
  }
  if (response.status === 429) {
    throw new Error('Mojang ha limitado las búsquedas. Espera un momento e inténtalo de nuevo.');
  }
  if (!response.ok) {
    throw new Error(`No se pudo consultar el jugador en Mojang (HTTP ${response.status}).`);
  }

  let profile;
  try {
    profile = await response.json();
  } catch {
    throw new Error('Mojang devolvió una respuesta inválida.');
  }

  if (!profile?.id) {
    throw new Error('No se encontró ningún jugador de Minecraft con ese nombre.');
  }

  const skin = await fetchSessionSkin(profile.id, { strict: true });
  if (!skin?.url) {
    throw new Error('Ese jugador no tiene una skin personalizada activa.');
  }

  const preview = await textureDataUrl(skin.url);
  if (!preview) {
    throw new Error('No se pudo cargar la textura de la skin.');
  }

  return {
    name: profile.name || clean,
    uuid: profile.id,
    url: skin.url,
    variant: skin.variant,
    dataUrl: preview,
  };
}

module.exports = { dataUrl, forget, lookupByUsername, normalizeTextureUrl };
