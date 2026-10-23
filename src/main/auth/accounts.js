'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');
const { paths } = require('../paths');

/**
 * Guarda los refresh tokens de Microsoft cifrados con DPAPI (Windows) mediante
 * `safeStorage`. El archivo vive en userData, nunca en el repositorio.
 */

function file() {
  return path.join(paths.data, 'accounts.json');
}

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!data || typeof data !== 'object' || !data.accounts) return { accounts: {} };
    return data;
  } catch {
    return { accounts: {} };
  }
}

function writeAll(data) {
  fs.mkdirSync(paths.data, { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file());
}

function encrypt(value) {
  if (safeStorage.isEncryptionAvailable()) {
    return { encrypted: true, value: safeStorage.encryptString(value).toString('base64') };
  }
  // Sin llavero disponible (raro en Windows): se guarda en claro para no perder la sesión.
  return { encrypted: false, value };
}

function decrypt(entry) {
  if (!entry || typeof entry.value !== 'string') return null;
  try {
    if (!entry.encrypted) return entry.value;
    return safeStorage.decryptString(Buffer.from(entry.value, 'base64'));
  } catch {
    return null;
  }
}

function save(id, account) {
  const data = readAll();
  const previous = data.accounts[id];

  data.accounts[id] = {
    name: account.name,
    uuid: account.uuid,
    token: encrypt(account.refreshToken),
    skin: account.skin || previous?.skin || null,
    variant: account.skinVariant || previous?.variant || null,
    updatedAt: Date.now(),
  };
  writeAll(data);
}

function get(id) {
  const raw = readAll().accounts[id];
  if (!raw) return null;
  const refreshToken = decrypt(raw.token);
  if (!refreshToken) return null;
  return {
    name: raw.name,
    uuid: raw.uuid,
    skin: raw.skin || null,
    skinVariant: raw.variant || null,
    refreshToken,
  };
}

/** URL de la skin activa (sin descifrar el token). */
function skinUrl(id) {
  const raw = readAll().accounts[id];
  return raw?.skin || null;
}

/** Modelo de la skin activa: 'classic' o 'slim'. */
function skinVariant(id) {
  const raw = readAll().accounts[id];
  return raw?.variant || null;
}

function has(id) {
  return Boolean(get(id));
}

function remove(id) {
  const data = readAll();
  if (!data.accounts[id]) return false;
  delete data.accounts[id];
  writeAll(data);
  return true;
}

/** Ids con sesión guardada (para marcar la UI). */
function list() {
  const data = readAll();
  return Object.keys(data.accounts).filter((id) => Boolean(get(id)));
}

module.exports = { save, get, has, remove, list, skinUrl, skinVariant };
