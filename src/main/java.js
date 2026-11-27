'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { open: openZip, readAllEntries, openEntryReadStream } = require('@xmcl/unzip');
const { paths } = require('./paths');

const execFileAsync = promisify(execFile);
const MIN_JAVA = 17;
const TARGET_JAVA = 17;
const STALL_TIMEOUT_MS = 45000;
const MAX_JRE_EXTRACT_BYTES = 512 * 1024 * 1024;

function javaExecutable(javaHome) {
  return path.join(javaHome, 'bin', os.platform() === 'win32' ? 'java.exe' : 'java');
}

function isValidJavaExecutablePath(candidate) {
  try {
    if (typeof candidate !== 'string') return false;
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.startsWith('\\\\') || trimmed.startsWith('//')) return false;
    if (!path.isAbsolute(trimmed)) return false;
    const expected = process.platform === 'win32' ? 'java.exe' : 'java';
    if (path.basename(trimmed).toLowerCase() !== expected) return false;
    return fs.statSync(trimmed).isFile();
  } catch {
    return false;
  }
}

async function readJavaVersion(javaPath) {
  try {
    const { stderr, stdout } = await execFileAsync(javaPath, ['-version'], {
      windowsHide: true,
      timeout: 15000,
    });
    const output = `${stderr}\n${stdout}`;
    const match = output.match(/version\s+"([^"]+)"/i);
    if (!match) return null;

    const raw = match[1];
    const major = raw.startsWith('1.') ? Number(raw.split('.')[1]) : Number(raw.split('.')[0]);
    return { path: javaPath, raw, major: Number.isFinite(major) ? major : 0 };
  } catch {
    return null;
  }
}

async function candidatesFromSystem() {
  const found = [];

  if (process.env.JAVA_HOME) {
    found.push(javaExecutable(process.env.JAVA_HOME));
  }

  try {
    const command = os.platform() === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(command, ['java'], { windowsHide: true });
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => found.push(line));
  } catch {
    /* java no está en el PATH */
  }

  const roots = [];
  if (os.platform() === 'win32') {
    roots.push(
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\Amazon Corretto',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Eclipse Adoptium'),
    );
  } else if (os.platform() === 'darwin') {
    roots.push('/Library/Java/JavaVirtualMachines');
  } else {
    roots.push('/usr/lib/jvm');
  }

  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const home = path.join(root, entry.name);
      const exe = javaExecutable(home.endsWith('.jdk') ? path.join(home, 'Contents', 'Home') : home);
      if (fs.existsSync(exe)) found.push(exe);
    }
  }

  // Instalaciones locales gestionadas por el launcher
  try {
    for (const entry of fs.readdirSync(paths.java, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const home = path.join(paths.java, entry.name);
      for (const nested of [home, ...safeDirectories(home)]) {
        const exe = javaExecutable(nested);
        if (fs.existsSync(exe)) found.push(exe);
      }
    }
  } catch {
    /* sin instalaciones locales */
  }

  return found;
}

function safeDirectories(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** Devuelve el Java 17 exacto disponible o null (evita Java 21+ que rompe Forge 1.20.1). */
async function detect(preferredPath) {
  const seen = new Set();
  const candidates = [];

  if (preferredPath && isValidJavaExecutablePath(preferredPath)) {
    candidates.push(preferredPath);
  }
  candidates.push(...(await candidatesFromSystem()));

  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (seen.has(normalized) || !fs.existsSync(normalized)) continue;
    seen.add(normalized);

    const version = await readJavaVersion(normalized);
    if (version && version.major === TARGET_JAVA) return version;
  }

  return null;
}

function isHttpsUrl(raw) {
  try {
    return new URL(String(raw)).protocol === 'https:';
  } catch {
    return false;
  }
}

async function resolveAdoptiumRelease(platform, arch, signal) {
  const metaUrl =
    `https://api.adoptium.net/v3/assets/latest/${MIN_JAVA}/hotspot` +
    `?architecture=${encodeURIComponent(arch)}&image_type=jre&os=${encodeURIComponent(platform)}&vendor=eclipse`;

  const timeout = AbortSignal.timeout(15000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const response = await fetch(metaUrl, {
    redirect: 'follow',
    signal: combined,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`No se pudieron obtener metadatos de Adoptium (HTTP ${response.status}).`);
  }
  if (!isHttpsUrl(response.url)) {
    throw new Error('Redirección no segura al consultar Adoptium.');
  }

  const assets = await response.json();
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error('Adoptium no devolvió ningún paquete de Java 17 disponible.');
  }

  const pkg = assets[0]?.binary?.package;
  const link = String(pkg?.link || '');
  const checksum = String(pkg?.checksum || '').trim().toLowerCase();

  if (!isHttpsUrl(link) || !/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error('Metadatos de descarga o SHA-256 de Adoptium inválidos.');
  }

  return { url: link, sha256: checksum };
}

async function downloadFile(url, destination, onProgress, signal, expectedSha256) {
  const temporary = `${destination}.part`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let stallTimer = null;
  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  };
  armStallTimer();

  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`No se pudo descargar Java (HTTP ${response.status}).`);
    }
    if (!isHttpsUrl(response.url)) {
      throw new Error('Redirección no segura al descargar Java (se requiere HTTPS).');
    }

    const total = Number(response.headers.get('content-length')) || 0;
    let received = 0;
    const hash = crypto.createHash('sha256');
    const source = Readable.fromWeb(response.body);
    const handle = fs.createWriteStream(temporary);
    const meter = new Transform({
      transform(chunk, _enc, callback) {
        armStallTimer();
        if (signal?.aborted) {
          callback(new Error('Descarga de Java cancelada.'));
          return;
        }
        hash.update(chunk);
        received += chunk.length;
        if (total && onProgress) onProgress(Math.min(1, received / total));
        callback(null, chunk);
      },
    });

    await pipeline(source, meter, handle, { signal: controller.signal });

    const actualSha256 = hash.digest('hex').toLowerCase();
    if (expectedSha256 && actualSha256 !== expectedSha256.toLowerCase()) {
      throw new Error('Checksum SHA-256 de Java 17 no coincide.');
    }

    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (signal?.aborted) throw new Error('Descarga de Java cancelada.');
    if (controller.signal.aborted) {
      throw new Error('La descarga de Java 17 se quedó sin datos.');
    }
    throw error;
  } finally {
    clearTimeout(stallTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function extractZipStream(archivePath, targetDir, signal) {
  fs.mkdirSync(targetDir, { recursive: true });
  const baseReal = fs.realpathSync(path.resolve(targetDir));
  const baseCmp = process.platform === 'win32' ? baseReal.toLowerCase() : baseReal;
  const zip = await openZip(archivePath, { lazyEntries: true, autoClose: false });

  try {
    const entries = await readAllEntries(zip);
    let writtenBytes = 0;

    for (const entry of entries) {
      if (signal?.aborted) throw new Error('Descarga de Java cancelada.');
      const rawName = String(entry.fileName || '').replace(/\\/g, '/');
      if (!rawName || rawName.includes('\0') || rawName.startsWith('/') || /^[a-z]:/i.test(rawName)) {
        throw new Error(`Entrada inválida en paquete de Java: ${entry.fileName}`);
      }
      if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
        throw new Error(`Enlace simbólico no permitido en paquete de Java: ${entry.fileName}`);
      }
      const trimmed = rawName.replace(/\/+$/, '');
      if (!trimmed) continue;
      if (trimmed.split('/').includes('..')) {
        throw new Error(`Ruta peligrosa en paquete de Java: ${entry.fileName}`);
      }

      const target = path.resolve(baseReal, trimmed);
      const targetCmp = process.platform === 'win32' ? target.toLowerCase() : target;
      if (targetCmp !== baseCmp && !targetCmp.startsWith(baseCmp + path.sep)) {
        throw new Error(`Ruta fuera de la carpeta de Java: ${entry.fileName}`);
      }

      if (rawName.endsWith('/')) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      const readStream = await openEntryReadStream(zip, entry);
      const writeStream = fs.createWriteStream(target);
      const limiter = new Transform({
        transform(chunk, _enc, callback) {
          writtenBytes += chunk.length;
          if (writtenBytes > MAX_JRE_EXTRACT_BYTES) {
            callback(new Error('El paquete de Java supera el tamaño máximo permitido al extraerse.'));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(readStream, limiter, writeStream, { signal });
    }
  } finally {
    zip.close();
  }
}

function findExecutableIn(directory) {
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    const exe = javaExecutable(current);
    if (fs.existsSync(exe)) return exe;
    stack.push(...safeDirectories(current));
  }
  return null;
}

const ADOPTIUM = {
  win32: 'windows',
  darwin: 'mac',
  linux: 'linux',
};

/**
 * Garantiza un Java 17+. Si no hay ninguno instalado descarga un JRE de
 * Eclipse Temurin dentro de userData validando su checksum SHA-256.
 */
async function ensure(preferredPath, onProgress = () => {}, signal) {
  const existing = await detect(preferredPath);
  if (existing) return { ...existing, downloaded: false };

  const platform = ADOPTIUM[os.platform()];
  if (!platform) throw new Error('Plataforma no soportada para instalar Java automáticamente.');

  const arch = os.arch() === 'arm64' ? 'aarch64' : 'x64';
  const release = await resolveAdoptiumRelease(platform, arch, signal);
  const archive = path.join(paths.cache, `jre-${MIN_JAVA}.zip`);

  onProgress(0);
  await downloadFile(release.url, archive, (fraction) => onProgress(fraction * 0.8), signal, release.sha256);
  if (signal?.aborted) throw new Error('Descarga de Java cancelada.');

  const target = path.join(paths.java, `temurin-${MIN_JAVA}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  try {
    await extractZipStream(archive, target, signal);
  } finally {
    fs.rmSync(archive, { force: true });
  }
  onProgress(0.95);

  const exe = findExecutableIn(target);
  if (!exe) throw new Error('La instalación de Java descargada está incompleta.');

  const version = await readJavaVersion(exe);
  if (!version || version.major !== TARGET_JAVA) {
    throw new Error('Java 17 se descargó pero no se pudo verificar.');
  }
  onProgress(1);

  return { ...version, downloaded: true };
}

/** Añade el Java elegido al inicio del PATH del proceso (Forge lo necesita para sus processors). */
function useInPath(javaPath) {
  const dir = path.dirname(path.resolve(javaPath));
  const target = process.platform === 'win32' ? dir.toLowerCase() : dir;
  const current = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => {
      const normalized = path.normalize(entry);
      return (process.platform === 'win32' ? normalized.toLowerCase() : normalized) !== target;
    });
  process.env.PATH = [dir, ...current].join(path.delimiter);
  process.env.JAVA_HOME = path.dirname(dir);
}

module.exports = { detect, ensure, useInPath, readJavaVersion, isValidJavaExecutablePath, MIN_JAVA };
