'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { paths } = require('./paths');

const CONCURRENCY = 4;
const DOWNLOAD_ATTEMPTS = 3;
const STALL_TIMEOUT_MS = 45000;
const DISK_RESERVE_BYTES = 256 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(value / 1024 / 1024))} MB`;
}

function freeSpace(root) {
  try {
    const stats = fs.statfsSync(root);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

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

async function download(url, destination, onBytes, signal, options = {}) {
  const expectedSize = Number(options.expectedSize) || 0;
  const allowResume = Boolean(options.allowResume);
  const temporary = `${destination}.part`;

  fs.mkdirSync(path.dirname(destination), { recursive: true });

  // Solo reanudamos si el manifiesto trae hash y tamaño: así sabemos que el
  // archivo parcial pertenece a la misma versión que estamos descargando.
  let start = 0;
  if (allowResume && expectedSize > 0) {
    try {
      const stat = fs.statSync(temporary);
      if (stat.isFile() && stat.size > 0 && stat.size < expectedSize) {
        start = stat.size;
      } else if (stat.isFile()) {
        fs.rmSync(temporary, { force: true });
      }
    } catch {
      /* No hay descarga parcial que reanudar. */
    }
  } else {
    fs.rmSync(temporary, { force: true });
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  let stallTimer = null;
  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  };
  armStallTimer();

  try {
    const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal, headers });

    if (response.status === 416) {
      fs.rmSync(temporary, { force: true });
      throw new Error(`El servidor rechazó reanudar ${path.basename(destination)}.`);
    }
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} al descargar ${path.basename(destination)}`);
    }

    let append = start > 0 && response.status === 206;
    if (append) {
      const contentRange = (response.headers.get('content-range') || '').toLowerCase();
      if (!contentRange.startsWith(`bytes ${start}-`)) {
        throw new Error(`Rango inválido al reanudar ${path.basename(destination)}.`);
      }
    }
    if (!append) start = 0;

    if (append) onBytes(start, true);

    const handle = fs.createWriteStream(temporary, { flags: append ? 'a' : 'w' });
    let streamError = null;
    handle.on('error', (error) => {
      streamError = error;
    });

    try {
      for await (const chunk of response.body) {
        armStallTimer();
        if (signal?.aborted) throw new Error('Descarga cancelada.');
        if (streamError) throw streamError;
        onBytes(chunk.length);
        if (!handle.write(chunk)) {
          await new Promise((resolve, reject) => {
            const cleanup = () => {
              handle.off('drain', onDrain);
              handle.off('error', onError);
            };
            const onDrain = () => {
              cleanup();
              resolve();
            };
            const onError = (error) => {
              cleanup();
              reject(error);
            };
            handle.once('drain', onDrain);
            handle.once('error', onError);
          });
        }
      }
    } finally {
      await new Promise((resolve) => {
        const onError = () => resolve();
        handle.once('error', onError);
        handle.end(() => {
          handle.off('error', onError);
          resolve();
        });
      });
    }

    if (streamError) throw streamError;

    const size = fs.statSync(temporary).size;
    if (expectedSize > 0 && size !== expectedSize) {
      throw new Error(`Descarga incompleta de ${path.basename(destination)} (${size}/${expectedSize} bytes).`);
    }

    fs.renameSync(temporary, destination);
    return { resumedFrom: start };
  } catch (error) {
    if (!allowResume) fs.rmSync(temporary, { force: true });
    if (signal?.aborted) throw new Error('Descarga cancelada.');
    if (controller.signal.aborted) {
      throw new Error(`La descarga de ${path.basename(destination)} se quedó sin datos.`);
    }
    throw error;
  } finally {
    clearTimeout(stallTimer);
    signal?.removeEventListener('abort', abort);
  }
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
  const partialBytes = pending.reduce((total, item) => {
    const expected = Number(item.file.size) || 0;
    if (!expected) return total;
    try {
      const size = fs.statSync(`${item.destination}.part`).size;
      // Solo se reanuda un .part más pequeño que el archivo final; si ya es
      // igual o mayor, download() lo borra y vuelve a empezar.
      return total + (size > 0 && size < expected ? size : 0);
    } catch {
      return total;
    }
  }, 0);
  const neededBytes = Math.max(0, pendingBytes - partialBytes);
  const freeBytes = freeSpace(root);
  if (freeBytes !== null && neededBytes > 0 && neededBytes + DISK_RESERVE_BYTES > freeBytes) {
    throw new Error(
      `No hay espacio suficiente para el modpack: se necesitan ${formatSize(neededBytes + DISK_RESERVE_BYTES)} ` +
      `libres y solo quedan ${formatSize(freeBytes)} en el disco.`,
    );
  }

  const completed = new Map();
  const finished = new Set();
  const startedAt = Date.now();
  let downloadedBytes = 0;

  const transferredBytes = () => {
    let sum = 0;
    for (const value of completed.values()) sum += value;
    return sum;
  };

  const totalProgress = () => {
    if (pendingBytes > 0) return Math.min(1, transferredBytes() / pendingBytes);
    return pending.length === 0 ? 1 : finished.size / pending.length;
  };

  let lastEmit = 0;
  const emit = (file, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 100) return;
    lastEmit = now;
    const elapsed = Math.max(0.001, (now - startedAt) / 1000);
    report({
      percent: totalProgress(),
      file: file ? file.path : null,
      completed: finished.size,
      total: pending.length,
      bytes: pendingBytes,
      transferred: transferredBytes(),
      downloadedBytes,
      speed: downloadedBytes / elapsed,
    });
  };

  emit(null, true);

  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      if (signal?.aborted) throw new Error('Sincronización cancelada.');
      const item = pending[cursor++];
      const expected = Number(item.file.size) || 0;
      let lastError = null;

      for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
        if (signal?.aborted) throw new Error('Sincronización cancelada.');
        let received = 0;
        completed.set(item.destination, 0);

        try {
          await download(item.file.url, item.destination, (bytes, resumed) => {
            received += bytes;
            if (!resumed) downloadedBytes += bytes;
            // Si no conocemos el tamaño usamos una fracción provisional por archivo.
            completed.set(item.destination, expected > 0 ? Math.min(received, expected) : 0);
            emit(item.file);
          }, signal, { expectedSize: expected, allowResume: Boolean(item.file.sha1) });

          if (item.file.sha1) {
            const hash = await sha1File(item.destination);
            if (hash.toLowerCase() !== String(item.file.sha1).toLowerCase()) {
              fs.rmSync(item.destination, { force: true });
              fs.rmSync(`${item.destination}.part`, { force: true });
              throw new Error(`Checksum inválido en ${item.file.path}`);
            }
          }

          completed.set(item.destination, expected > 0 ? expected : 1);
          finished.add(item.destination);
          emit(item.file, true);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (signal?.aborted) throw error;
          if (attempt < DOWNLOAD_ATTEMPTS) await sleep(700 * attempt);
        }
      }

      if (lastError) throw lastError;
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
  const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
  report({
    percent: 1,
    completed: pending.length,
    total: pending.length,
    bytes: pendingBytes,
    transferred: transferredBytes(),
    downloadedBytes,
    speed: downloadedBytes / elapsed,
  });

  return { downloaded: pending.length, files: files.length };
}

module.exports = { syncFiles, readState, writeState, sha1File, safeJoin };
