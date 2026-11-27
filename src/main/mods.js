'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { open: openZip, readAllEntries, openEntryReadStream } = require('@xmcl/unzip');
const { paths } = require('./paths');
const { isAllowedUrl } = require('./resources');

const CONCURRENCY = 4;
const DOWNLOAD_ATTEMPTS = 3;
const STALL_TIMEOUT_MS = 45000;
const DISK_RESERVE_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACT_BYTES = 4 * 1024 * 1024 * 1024;
const BUNDLE_MARKER_FILE = '.chernobylz-bundles.json';
const PROTECTED_DIRS = new Set([
  'saves',
  'screenshots',
  'logs',
  'crash-reports',
  'backups',
  'xaero',
  'xaerowaypoints',
  'xaeroworldmap',
]);
const PRESERVED_PLAYER_FILES = new Set([
  'options.txt',
  'config/embeddium-options.json',
  'config/sodium-extra-options.json',
  'config/sodium-extra.properties',
]);

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function isPreservedPlayerFile(relativePath, explicitPreserve = false) {
  if (explicitPreserve) return true;
  const norm = normalizeRelativePath(relativePath).toLowerCase();
  if (PRESERVED_PLAYER_FILES.has(norm)) return true;
  if (
    norm === 'xaero' ||
    norm.startsWith('xaero/') ||
    norm.startsWith('xaerowaypoints/') ||
    norm.startsWith('xaeroworldmap/')
  ) {
    return true;
  }
  if (norm.startsWith('config/xaero') || /^config\/xaero(minimap|worldmap).*\.txt$/.test(norm)) {
    return true;
  }
  return false;
}

function hasExistingPlayerFile(filePath, relativePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    return normalizeRelativePath(relativePath).toLowerCase().endsWith('.properties') || stat.size > 0;
  } catch {
    return false;
  }
}

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
  const temporary = `${paths.state}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temporary, paths.state);
}

function readBundleMarkers(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, BUNDLE_MARKER_FILE), 'utf8'));
    if (raw && typeof raw === 'object' && raw.bundles && typeof raw.bundles === 'object') {
      return raw;
    }
  } catch {
    /* sin marcador previo */
  }
  return { bundles: {} };
}

function writeBundleMarkers(root, markers) {
  const file = path.join(root, BUNDLE_MARKER_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(markers, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function sanitizeZipEntryPath(rawName) {
  const normalized = String(rawName || '').replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    throw new Error(`Entrada inválida en paquete zip: ${rawName}`);
  }
  const trimmed = normalized.replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.split('/').includes('..')) {
    throw new Error(`Ruta peligrosa en paquete zip: ${rawName}`);
  }
  return trimmed;
}

function normalizeCasePath(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function assertWithinRealBase(baseReal, targetPath, label) {
  const baseCmp = normalizeCasePath(baseReal);
  let probe = targetPath;
  while (probe && !fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (probe && fs.existsSync(probe)) {
    if (probe === targetPath) {
      try {
        if (fs.lstatSync(targetPath).isSymbolicLink()) {
          throw new Error(`Enlace simbólico no permitido en destino: ${label}`);
        }
      } catch (error) {
        if (error?.message?.includes('Enlace simbólico')) throw error;
      }
    }
    const resolvedReal = fs.realpathSync(probe);
    const resolvedCmp = normalizeCasePath(resolvedReal);
    if (resolvedCmp !== baseCmp && !resolvedCmp.startsWith(baseCmp + path.sep)) {
      throw new Error(`Ruta fuera de la carpeta del juego: ${label}`);
    }
  }
}

async function extractBundle(zipPath, root, signal) {
  if (signal?.aborted) throw new Error('Descarga cancelada.');
  const base = path.resolve(root);
  fs.mkdirSync(base, { recursive: true });
  const baseReal = fs.realpathSync(base);
  const baseCmp = normalizeCasePath(baseReal);

  const zip = await openZip(zipPath, { lazyEntries: true, autoClose: false });

  try {
    const entries = await readAllEntries(zip);
    const safeEntries = [];
    let totalUncompressed = 0;

    for (const entry of entries) {
      const rawName = String(entry.fileName || '');
      if (!rawName || rawName.startsWith('__MACOSX/')) continue;

      // Rechaza enlaces simbólicos Unix dentro del archivo comprimido.
      if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
        throw new Error(`Enlace simbólico no permitido en paquete zip: ${rawName}`);
      }

      const relative = sanitizeZipEntryPath(rawName);
      if (!relative) continue;

      const topDir = relative.split('/')[0].toLowerCase();
      if (PROTECTED_DIRS.has(topDir)) {
        throw new Error(`El paquete intenta escribir en una carpeta protegida: ${relative}`);
      }

      const target = safeJoin(baseReal, relative);
      const targetCmp = normalizeCasePath(target);
      if (targetCmp === baseCmp || !targetCmp.startsWith(baseCmp + path.sep)) {
        throw new Error(`Ruta fuera de la carpeta del juego: ${relative}`);
      }

      const isDirectory = rawName.endsWith('/') || rawName.endsWith('\\');
      if (!isDirectory) {
        totalUncompressed += Number(entry.uncompressedSize) || 0;
        if (totalUncompressed > MAX_EXTRACT_BYTES) {
          throw new Error('El paquete comprimido supera el límite máximo permitido al extraerse.');
        }
      }

      safeEntries.push({ entry, relative, target, isDirectory });
    }

    const extractedFiles = [];
    let writtenBytes = 0;

    for (const item of safeEntries) {
      if (signal?.aborted) throw new Error('Descarga cancelada.');

      assertWithinRealBase(baseReal, item.target, item.relative);

      if (item.isDirectory) {
        fs.mkdirSync(item.target, { recursive: true });
        continue;
      }

      if (isPreservedPlayerFile(item.relative) && hasExistingPlayerFile(item.target, item.relative)) {
        extractedFiles.push(item.relative);
        continue;
      }

      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      assertWithinRealBase(baseReal, path.dirname(item.target), item.relative);

      const tmpTarget = `${item.target}.tmp`;
      const readStream = await openEntryReadStream(zip, item.entry);
      const writeStream = fs.createWriteStream(tmpTarget);
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          if (signal?.aborted) {
            callback(new Error('Descarga cancelada.'));
            return;
          }
          writtenBytes += chunk.length;
          if (writtenBytes > MAX_EXTRACT_BYTES) {
            callback(new Error('El paquete comprimido supera el límite máximo permitido al extraerse.'));
            return;
          }
          callback(null, chunk);
        },
      });

      try {
        await pipeline(readStream, limiter, writeStream, { signal });
        fs.renameSync(tmpTarget, item.target);
      } catch (error) {
        fs.rmSync(tmpTarget, { force: true });
        throw error;
      }

      extractedFiles.push(item.relative);
    }

    return extractedFiles;
  } finally {
    zip.close();
  }
}

function isBundleExtracted(marker, root, file) {
  if (!marker || !file.sha1 || !marker.sha1) return false;
  if (String(marker.sha1).toLowerCase() !== String(file.sha1).toLowerCase()) return false;
  if (!Array.isArray(marker.files) || marker.files.length === 0) return false;

  try {
    for (const relative of marker.files) {
      const target = safeJoin(root, relative);
      if (!fs.existsSync(target)) return false;
    }
    return true;
  } catch {
    return false;
  }
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
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  const baseCmp = normalizeCasePath(base);
  const targetCmp = normalizeCasePath(target);
  if (targetCmp !== baseCmp && !targetCmp.startsWith(baseCmp + path.sep)) {
    throw new Error(`Ruta de archivo inválida: ${relative}`);
  }
  if (fs.existsSync(base)) {
    assertWithinRealBase(fs.realpathSync(base), target, relative);
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

function waitClose(stream) {
  if (!stream || stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('close', resolve);
    stream.once('error', resolve);
  });
}

function hashStreamPrefix(file, bytes, hash, signal) {
  return new Promise((resolve, reject) => {
    if (bytes <= 0) {
      resolve();
      return;
    }

    const reader = fs.createReadStream(file, { start: 0, end: bytes - 1 });
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };

    const onAbort = () => {
      reader.destroy();
      finish(new Error('Descarga cancelada.'));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    reader.on('data', (chunk) => hash.update(chunk));
    reader.on('error', finish);
    reader.on('end', () => finish());
  });
}

function pruneEmptyParents(root, removedFiles) {
  const base = path.resolve(root);
  const dirs = new Set();

  for (const file of removedFiles) {
    let dir = path.dirname(file);
    while (dir !== base && dir.startsWith(base + path.sep)) {
      const top = path.relative(base, dir).split(path.sep)[0];
      if (PROTECTED_DIRS.has(top.toLowerCase())) break;
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }

  // Elimina de la ruta más profunda hacia arriba para limpiar subárboles vacíos.
  const ordered = [...dirs].sort((a, b) => b.length - a.length);
  for (const dir of ordered) {
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {
      /* carpeta ya eliminada o con archivos */
    }
  }
}

async function download(url, destination, onBytes, signal, options = {}) {
  const expectedSize = Number(options.expectedSize) || 0;
  const expectedSha1 = options.expectedSha1 ? String(options.expectedSha1).toLowerCase() : null;
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

    if (!isAllowedUrl(response.url)) {
      throw new Error(`Redirección no permitida al descargar ${path.basename(destination)}`);
    }
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

    const hash = expectedSha1 ? crypto.createHash('sha1') : null;
    if (hash && append && start > 0) {
      await hashStreamPrefix(temporary, start, hash, controller.signal);
    }

    const source = Readable.fromWeb(response.body);
    const handle = fs.createWriteStream(temporary, { flags: append ? 'a' : 'w' });
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        armStallTimer();
        if (signal?.aborted) {
          callback(new Error('Descarga cancelada.'));
          return;
        }
        if (hash) hash.update(chunk);
        onBytes(chunk.length);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(source, meter, handle, { signal: controller.signal });
    } finally {
      if (!source.destroyed) source.destroy();
      if (!meter.destroyed) meter.destroy();
      if (!handle.writableFinished && !handle.destroyed) handle.destroy();
      await waitClose(handle);
    }

    const size = fs.statSync(temporary).size;
    if (expectedSize > 0 && size !== expectedSize) {
      throw new Error(`Descarga incompleta de ${path.basename(destination)} (${size}/${expectedSize} bytes).`);
    }

    if (hash) {
      const actualSha1 = hash.digest('hex').toLowerCase();
      if (actualSha1 !== expectedSha1) {
        fs.rmSync(temporary, { force: true });
        throw new Error(`Checksum inválido en ${path.basename(destination)}`);
      }
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
  const channelChanged = Boolean(state.channel && state.channel !== channel);
  const nextManaged = new Set();
  const bundleMarkers = readBundleMarkers(root);
  const bundlesDir = path.join(paths.cache, 'bundles');
  const activeBundleKeys = new Set();
  const extractedFromBundles = [];

  const pending = [];

  for (const file of files) {
    if (!file || !file.path || !file.url) continue;

    if (file.extract) {
      const markerKey = file.path;
      activeBundleKeys.add(markerKey);
      const marker = bundleMarkers.bundles[markerKey];

      if (isBundleExtracted(marker, root, file)) {
        for (const rel of marker.files) nextManaged.add(rel);
        continue;
      }

      const safeChannel = String(channel || 'pack').replace(/[^a-zA-Z0-9._-]+/g, '_');
      const shortSha = String(file.sha1 || 'nohash').slice(0, 12);
      const cacheName = `${safeChannel}-${shortSha}-${path.basename(file.path)}`;
      const destination = path.join(bundlesDir, cacheName);

      if (channelChanged) {
        fs.rmSync(`${destination}.part`, { force: true });
      }

      pending.push({ file, destination, isArchive: true, markerKey });
      continue;
    }

    const destination = safeJoin(root, file.path);
    const preserveExisting = isPreservedPlayerFile(file.path, Boolean(file.preserve));
    if (!preserveExisting) {
      nextManaged.add(file.path);
    }

    if (channelChanged) {
      fs.rmSync(`${destination}.part`, { force: true });
    }

    if (preserveExisting && hasExistingPlayerFile(destination, file.path)) continue;
    if (await isValid(destination, file)) continue;
    pending.push({ file, destination, isArchive: false });
  }

  for (const key of Object.keys(bundleMarkers.bundles)) {
    if (!activeBundleKeys.has(key)) {
      delete bundleMarkers.bundles[key];
    }
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
          }, signal, {
            expectedSize: expected,
            expectedSha1: item.file.sha1 || null,
            allowResume: Boolean(item.file.sha1),
          });

          if (item.isArchive) {
            try {
              const extracted = await extractBundle(item.destination, root, signal);
              extractedFromBundles.push(...extracted);
              bundleMarkers.bundles[item.markerKey] = {
                sha1: item.file.sha1 || null,
                channel,
                files: extracted,
              };
              writeBundleMarkers(root, bundleMarkers);
            } finally {
              fs.rmSync(item.destination, { force: true });
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

  for (const rel of extractedFromBundles) {
    if (!isPreservedPlayerFile(rel)) nextManaged.add(rel);
  }
  if (Object.keys(bundleMarkers.bundles).length > 0 || fs.existsSync(path.join(root, BUNDLE_MARKER_FILE))) {
    writeBundleMarkers(root, bundleMarkers);
  }

  // Elimina archivos gestionados que ya no forman parte del canal actual.
  const removedFiles = [];
  for (const relative of managed) {
    if (nextManaged.has(relative) || isPreservedPlayerFile(relative)) continue;
    try {
      const target = safeJoin(root, relative);
      fs.rmSync(target, { force: true });
      removedFiles.push(target);
    } catch {
      /* archivo ya eliminado o ruta no válida */
    }
  }
  if (removedFiles.length > 0) {
    pruneEmptyParents(root, removedFiles);
  }

  // Limpia .part/.tmp huérfanos en mods/ y cachés obsoletas en cache/bundles/ tras sincronizar.
  try {
    const modsDir = path.join(root, 'mods');
    if (fs.existsSync(modsDir)) {
      for (const entry of fs.readdirSync(modsDir, { withFileTypes: true })) {
        if (entry.isFile() && /\.(part|tmp)$/i.test(entry.name)) {
          fs.rmSync(path.join(modsDir, entry.name), { force: true });
        }
      }
    }
  } catch {
    /* limpieza best-effort */
  }
  try {
    if (fs.existsSync(bundlesDir)) {
      for (const entry of fs.readdirSync(bundlesDir, { withFileTypes: true })) {
        if (entry.isFile()) {
          fs.rmSync(path.join(bundlesDir, entry.name), { force: true });
        }
      }
    }
  } catch {
    /* limpieza best-effort */
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
