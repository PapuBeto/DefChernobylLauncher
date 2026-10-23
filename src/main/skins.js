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

  const uuid = match[1].replace(/-/g, '');
  const response = await fetch(
    `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`,
    { signal: AbortSignal.timeout(15000) },
  );

  if (!response.ok) return null;

  const profile = await response.json();
  const encoded = profile?.properties?.find((item) => item.name === 'textures')?.value;
  if (!encoded) return null;

  const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const url = normalizeTextureUrl(decoded?.textures?.SKIN?.url);
  if (!url) return null;

  urls[profileId] = url;
  writeUrls(urls);
  return url;
}

async function dataUrl(profileId) {
  const url = await resolveUrl(profileId);
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
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
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

module.exports = { dataUrl };
