'use strict';

const fs = require('node:fs');
const accounts = require('./auth/accounts');
const authManager = require('./auth');
const microsoft = require('./auth/microsoft');
const skins = require('./skins');

const MAX_BYTES = 512 * 1024;
const PNG_SIGNATURE = '89504e470d0a1a0a';
const SKIN_API = 'https://api.minecraftservices.com/minecraft/profile/skins';

/** Lee la cabecera IHDR de un PNG y devuelve sus dimensiones. */
function readPng(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readSkinFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error('No se pudo leer el archivo elegido.');
  }

  if (!stat.isFile()) throw new Error('El archivo elegido no es válido.');
  if (stat.size > MAX_BYTES) {
    throw new Error('El PNG es demasiado grande (máximo 512 KB).');
  }

  const buffer = fs.readFileSync(filePath);
  const size = readPng(buffer);
  if (!size) throw new Error('El archivo no es un PNG válido.');

  const valid =
    (size.width === 64 && size.height === 64) || (size.width === 64 && size.height === 32);
  if (!valid) {
    throw new Error(
      `La skin debe medir 64×64 (o 64×32). Este PNG mide ${size.width}×${size.height}.`,
    );
  }

  return { buffer, width: size.width, height: size.height };
}

function dataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function apiError(status, payload) {
  const message = String(payload?.errorMessage || payload?.error || '').trim();

  if (status === 401) {
    return 'La sesión de Minecraft caducó. Vuelve a iniciar sesión con Microsoft.';
  }
  if (status === 429) {
    return 'Mojang ha limitado los intentos. Espera un momento y vuelve a probar.';
  }
  if (status === 403) {
    return 'Mojang bloqueó la subida. Inténtalo de nuevo más tarde.';
  }

  return message ? `Mojang rechazó la skin: ${message}` : `Mojang rechazó la skin (HTTP ${status}).`;
}

async function finalize(profile, accessToken) {
  const next = await microsoft.fetchProfile(accessToken);
  const account = accounts.get(profile.id);

  if (account) {
    accounts.save(profile.id, {
      ...account,
      name: next.name || account.name,
      uuid: next.id || account.uuid,
      skin: next.skin,
      skinVariant: next.variant,
    });
  }

  skins.forget(profile.id);
  const preview = await skins.dataUrl(profile.id).catch(() => null);

  return {
    name: next.name,
    variant: next.variant,
    skin: preview,
  };
}

async function sendSkinRequest(profile, init) {
  if (!profile || profile.type !== 'microsoft') {
    throw new Error('Solo las cuentas premium (Microsoft) pueden cambiar de skin.');
  }

  const session = await authManager.sessionForProfile(profile);

  let response;
  try {
    response = await fetch(init.endpoint || SKIN_API, {
      method: init.method,
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        ...(init.headers || {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    throw new Error('No se pudo conectar con Mojang. Comprueba tu conexión e inténtalo de nuevo.');
  }

  if (!response.ok && !(init.allowNoContent && response.status === 204)) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(apiError(response.status, payload));
  }

  return finalize(profile, session.accessToken);
}

/** Sube una skin PNG a la cuenta premium (clásica o slim). */
async function apply(profile, filePath, variant) {
  const { buffer } = readSkinFile(filePath);
  const model = variant === 'slim' ? 'slim' : 'classic';

  const form = new FormData();
  form.append('variant', model);
  form.append('file', new Blob([buffer], { type: 'image/png' }), 'skin.png');

  return sendSkinRequest(profile, { method: 'POST', body: form });
}

/** Aplica una skin desde una URL oficial de textura de Mojang. */
async function applyFromUrl(profile, url, variant) {
  const safeUrl = skins.normalizeTextureUrl(url);
  if (!safeUrl) {
    throw new Error('La URL de textura de Mojang no es válida.');
  }

  const model = variant === 'slim' ? 'slim' : 'classic';

  return sendSkinRequest(profile, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ variant: model, url: safeUrl }),
  });
}

/** Restaura la skin predeterminada de la cuenta. */
async function reset(profile) {
  return sendSkinRequest(profile, {
    endpoint: `${SKIN_API}/active`,
    method: 'DELETE',
    allowNoContent: true,
  });
}

/** Valida un PNG para la vista previa antes de subirlo. */
function inspect(filePath) {
  const { buffer, width, height } = readSkinFile(filePath);
  return { dataUrl: dataUrl(buffer), width, height, size: buffer.length };
}

module.exports = { apply, applyFromUrl, reset, inspect };
