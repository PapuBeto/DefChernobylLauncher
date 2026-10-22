'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { paths } = require('./paths');

const CONCURRENCY = 4;

function readState() {
  try {
    return JSON.parse(fs.readFileSync(paths.state, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(paths.state), { recursive: true });
  fs.writeFileSync(paths.state, JSON.stringify(state, null, 2), 'utf8');
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function safeJoin(root, relative) {
  const target = path.resolve(root, relative);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Ruta de archivo inválida: ${relative}`);
  }
  return target;
}

async function isValid(destination, file) {
  try {
    const stat = fs.statSync(destination);
    if (!stat.isFile()) return false;
    if (file.size && stat.size !== file.size) return false;
    if (file.sha1) {
      const hash = await sha1File(destination);
      if (hash.toLowerCase() !== String(file.sha1).toLowerCase()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination, onBytes, signal) {
  const response = await fetch(url, { redirect: 'follow', signal });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} al descargar ${path.basename(destination)}`);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  const handle = fs.createWriteStream(temporary);

  try {
    for await (const chunk of response.body) {
      if (signal?.aborted) throw new Error('Descarga cancelada.');
      onBytes(chunk.length);
      if (!handle.write(chunk)) {
        await new Promise((resolve) => handle.once('drain', resolve));
      }
    }
  } catch (error) {
    await new Promise((resolve) => handle.end(resolve));
    fs.rmSync(temporary, { force: true });
    throw error;
  }

  await new Promise((resolve) => handle.end(resolve));
  fs.renameSync(temporary, destination);
}

/**
 * Sincroniza los archivos del modpack (mods, configs, resourcepacks...).
 * Descarga lo que falta o está corrupto y elimina lo que ya no pertenece al canal.
 */
async function syncFiles(root, files, channel, report = () => {}, signal) {
  const state = readState();
  const managed = new Set(Array.isArray(state.managedFiles) ? state.managedFiles : []);
  const nextManaged = new Set();

  const pending = [];

  for (const file of files) {
    if (!file || !file.path || !file.url) continue;

    const destination = safeJoin(root, file.path);
    nextManaged.add(file.path);

    if (await isValid(destination, file)) continue;
    pending.push({ file, destination });
  }

  const pendingBytes = pending.reduce((total, item) => total + (Number(item.file.size) || 0), 0);
  const completed = new Map();

  const totalProgress = () => {
    if (pendingBytes > 0) {
      let sum = 0;
      for (const value of completed.values()) sum += value;
      return Math.min(1, sum / pendingBytes);
    }
    return pending.length === 0 ? 1 : completed.size / pending.length;
  };

  const emit = (file) => {
    report({
      percent: totalProgress(),
      file: file ? file.path : null,
      completed: completed.size,
      total: pending.length,
      bytes: pendingBytes,
    });
  };

  emit(null);

  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      if (signal?.aborted) throw new Error('Sincronización cancelada.');
      const item = pending[cursor++];
      const expected = Number(item.file.size) || 0;
      let received = 0;

      await download(item.file.url, item.destination, (bytes) => {
        received += bytes;
        // Si no conocemos el tamaño usamos una fracción provisional por archivo.
        completed.set(item.destination, expected > 0 ? Math.min(received, expected) : 0);
        emit(item.file);
      }, signal);

      if (item.file.sha1) {
        const hash = await sha1File(item.destination);
        if (hash.toLowerCase() !== String(item.file.sha1).toLowerCase()) {
          fs.rmSync(item.destination, { force: true });
          throw new Error(`Checksum inválido en ${item.file.path}`);
        }
      }

      completed.set(item.destination, expected > 0 ? expected : 1);
      emit(item.file);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

  if (signal?.aborted) throw new Error('Sincronización cancelada.');

  // Elimina archivos gestionados que ya no forman parte del canal actual.
  for (const relative of managed) {
    if (nextManaged.has(relative)) continue;
    try {
      fs.rmSync(safeJoin(root, relative), { force: true });
    } catch {
      /* archivo ya eliminado o ruta no válida */
    }
  }

  writeState({ ...state, managedFiles: [...nextManaged], channel, syncedAt: Date.now() });
  report({ percent: 1, completed: pending.length, total: pending.length, bytes: pendingBytes });

  return { downloaded: pending.length, files: files.length };
}

module.exports = { syncFiles, readState, writeState, sha1File, safeJoin };
