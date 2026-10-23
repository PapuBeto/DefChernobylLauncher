'use strict';

const fs = require('node:fs');
const { paths } = require('./paths');

const FALLBACK_MODPACK = {
  name: 'Chernobyl Z',
  minecraft: '1.20.1',
  forge: '47.3.0',
  server: { name: 'Chernobyl Z', host: '', port: 25565 },
  channels: {
    COMPLETA: { label: 'COMPLETA', description: 'Todos los mods', memory: { min: 2048, max: 6144 } },
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

function loadModpack() {
  if (!modpackCache) {
    const raw = readJson(paths.resource('modpack.json'), null) || FALLBACK_MODPACK;
    modpackCache = {
      ...FALLBACK_MODPACK,
      ...raw,
      channels: { ...FALLBACK_MODPACK.channels, ...(raw.channels || {}) },
      files: Array.isArray(raw.files) ? raw.files : [],
    };
  }
  return modpackCache;
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

module.exports = { loadModpack, getChannel, filesForChannel, loadNews, loadLinks, loadAuth };
