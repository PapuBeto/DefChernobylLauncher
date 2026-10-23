'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { paths } = require('./paths');
const { loadModpack, filesForChannel, getChannel } = require('./resources');
const { readState } = require('./mods');

function prettyName(file) {
  return path
    .basename(String(file).replace(/\\/g, '/'))
    .replace(/\.jar$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function normalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '');
}

/**
 * Lista los mods del canal activo. La información «bonita» sale de `mods` en
 * modpack.json; si aún no existe, se derivan los .jar de `files`.
 */
function list(channelId) {
  const channel = getChannel(channelId);
  const modpack = loadModpack();
  const files = filesForChannel(channel.id);
  const byPath = new Map(
    files
      .filter((file) => file && file.path)
      .map((file) => [normalizePath(file.path), file]),
  );
  const state = readState();
  const managed = new Set(
    (Array.isArray(state.managedFiles) ? state.managedFiles : []).map(normalizePath),
  );

  const declared = Array.isArray(modpack.mods) ? modpack.mods : [];
  const forChannel = declared.filter((mod) => {
    if (!Array.isArray(mod.channels) || mod.channels.length === 0) return true;
    return mod.channels.map((item) => String(item).toUpperCase()).includes(channel.id);
  });

  let mods = forChannel;

  if (declared.length === 0) {
    mods = files
      .filter((file) => /\.jar$/i.test(file.path || ''))
      .map((file) => ({ id: file.path, name: prettyName(file.path), file: file.path }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  const items = mods.map((mod) => {
    const key = normalizePath(mod.file);
    const file = key ? byPath.get(key) : null;
    const onDisk =
      Boolean(key) && fs.existsSync(path.join(paths.game, key));
    const installed = Boolean(key) && onDisk && managed.has(key);

    return {
      id: String(mod.id || mod.file || mod.name),
      name: String(mod.name || prettyName(mod.file || '')),
      version: String(mod.version || ''),
      author: String(mod.author || ''),
      description: String(mod.description || ''),
      file: mod.file || null,
      size: Number(file?.size) || 0,
      installed,
      pending: Boolean(mod.file) && !installed,
    };
  });

  return {
    channel: channel.id,
    channelLabel: channel.label || channel.id,
    count: items.length,
    size: items.reduce((total, mod) => total + mod.size, 0),
    mods: items,
  };
}

module.exports = { list };
