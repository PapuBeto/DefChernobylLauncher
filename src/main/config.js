'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { paths } = require('./paths');

const DEFAULT_CONFIG = {
  activeProfile: null,
  profiles: [],
  channel: 'COMPLETA',
  memory: 4096,
  javaPath: null,
  resolution: { width: 1280, height: 720, fullscreen: false },
  closeOnLaunch: false,
  showSnapshots: false,
};

let cache = null;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function sanitizeProfileName(name) {
  return String(name || '')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 16);
}

function normalize(config) {
  const merged = { ...DEFAULT_CONFIG, ...(config || {}) };

  if (!Array.isArray(merged.profiles)) merged.profiles = [];

  merged.profiles = merged.profiles
    .filter((profile) => profile && sanitizeProfileName(profile.name))
    .map((profile) => {
      const microsoft = profile.type === 'microsoft' && profile.uuid;
      return {
        id: String(profile.id || crypto.randomUUID()),
        type: microsoft ? 'microsoft' : 'offline',
        name: sanitizeProfileName(profile.name),
        ...(microsoft ? { uuid: String(profile.uuid) } : {}),
      };
    });

  if (merged.profiles.length === 0) {
    merged.activeProfile = null;
  } else if (!merged.profiles.some((profile) => profile.id === merged.activeProfile)) {
    merged.activeProfile = merged.profiles[0].id;
  }

  merged.memory = Math.min(16384, Math.max(1024, Number(merged.memory) || 4096));
  merged.channel = String(merged.channel || 'COMPLETA').toUpperCase();

  if (!merged.resolution || typeof merged.resolution !== 'object') {
    merged.resolution = { ...DEFAULT_CONFIG.resolution };
  }

  merged.resolution.width = Math.max(640, Number(merged.resolution.width) || 1280);
  merged.resolution.height = Math.max(480, Number(merged.resolution.height) || 720);
  merged.resolution.fullscreen = Boolean(merged.resolution.fullscreen);

  return merged;
}

function load() {
  if (!cache) {
    cache = normalize(readJson(paths.config, null));
  }
  return cache;
}

/** Guarda un parche parcial y devuelve la configuración completa ya normalizada. */
function update(patch = {}) {
  const current = load();
  const next = { ...current, ...patch };
  cache = normalize(next);
  writeJson(paths.config, cache);
  return cache;
}

function activeProfile() {
  const config = load();
  return (
    config.profiles.find((profile) => profile.id === config.activeProfile) ||
    config.profiles[0]
  );
}

function addProfile(name) {
  const config = load();
  const clean = sanitizeProfileName(name);

  if (!clean) {
    throw new Error('El nombre solo puede tener letras, números y guion bajo (máx. 16).');
  }

  if (config.profiles.some((profile) => profile.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error('Ya existe un perfil con ese nombre.');
  }

  const profile = { id: crypto.randomUUID(), type: 'offline', name: clean };
  config.profiles.push(profile);
  config.activeProfile = profile.id;
  return update({ profiles: config.profiles, activeProfile: profile.id });
}

/** Crea (o actualiza) el perfil de una cuenta Microsoft y lo activa. */
function addMicrosoftProfile({ name, uuid }) {
  const config = load();
  const clean = sanitizeProfileName(name) || 'Jugador';
  const id = `ms:${uuid}`;
  const existing = config.profiles.find((profile) => profile.id === id);

  const profiles = existing
    ? config.profiles.map((profile) =>
        profile.id === id ? { ...profile, type: 'microsoft', name: clean, uuid: String(uuid) } : profile,
      )
    : [
        ...config.profiles.filter(
          (profile) => !(profile.type === 'microsoft' && profile.uuid === String(uuid)),
        ),
        { id, type: 'microsoft', name: clean, uuid: String(uuid) },
      ];

  return update({ profiles, activeProfile: id });
}

function removeProfile(id) {
  const config = load();
  const profiles = config.profiles.filter((profile) => profile.id !== id);
  const activeProfile =
    profiles.length === 0 ? null : id === config.activeProfile ? profiles[0].id : config.activeProfile;
  return update({ profiles, activeProfile });
}

function selectProfile(id) {
  const config = load();
  if (!config.profiles.some((profile) => profile.id === id)) {
    throw new Error('Perfil no encontrado.');
  }
  return update({ activeProfile: id });
}

module.exports = {
  load,
  update,
  addProfile,
  addMicrosoftProfile,
  removeProfile,
  selectProfile,
  activeProfile,
  sanitizeProfileName,
};
