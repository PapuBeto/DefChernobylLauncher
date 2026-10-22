'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { paths } = require('./paths');

const execFileAsync = promisify(execFile);
const MIN_JAVA = 17;

function javaExecutable(javaHome) {
  return path.join(javaHome, 'bin', os.platform() === 'win32' ? 'java.exe' : 'java');
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

/** Devuelve el mejor Java 17+ disponible o null. */
async function detect(preferredPath) {
  const seen = new Set();
  const candidates = [];

  if (preferredPath && fs.existsSync(preferredPath)) candidates.push(preferredPath);
  candidates.push(...(await candidatesFromSystem()));

  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (seen.has(normalized) || !fs.existsSync(normalized)) continue;
    seen.add(normalized);

    const version = await readJavaVersion(normalized);
    if (version && version.major >= MIN_JAVA) return version;
  }

  return null;
}

async function downloadFile(url, destination, onProgress, signal) {
  const response = await fetch(url, { redirect: 'follow', signal });
  if (!response.ok || !response.body) {
    throw new Error(`No se pudo descargar Java (HTTP ${response.status}).`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const handle = fs.createWriteStream(destination);

  try {
    for await (const chunk of response.body) {
      if (signal?.aborted) throw new Error('Descarga de Java cancelada.');
      received += chunk.length;
      if (!handle.write(chunk)) {
        await new Promise((resolve) => handle.once('drain', resolve));
      }
      if (total && onProgress) onProgress(received / total);
    }
  } catch (error) {
    await new Promise((resolve) => handle.end(resolve));
    fs.rmSync(destination, { force: true });
    throw error;
  }

  await new Promise((resolve) => handle.end(resolve));
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
 * Eclipse Temurin dentro de userData.
 */
async function ensure(preferredPath, onProgress = () => {}, signal) {
  const existing = await detect(preferredPath);
  if (existing) return { ...existing, downloaded: false };

  const platform = ADOPTIUM[os.platform()];
  if (!platform) throw new Error('Plataforma no soportada para instalar Java automáticamente.');

  const arch = os.arch() === 'arm64' ? 'aarch64' : 'x64';
  const url = `https://api.adoptium.net/v3/binary/latest/${MIN_JAVA}/ga/${platform}/${arch}/jre/hotspot/normal/eclipse`;
  const archive = path.join(paths.cache, `jre-${MIN_JAVA}.zip`);

  onProgress(0);
  await downloadFile(url, archive, (fraction) => onProgress(fraction * 0.8), signal);
  if (signal?.aborted) throw new Error('Descarga de Java cancelada.');

  const AdmZip = require('adm-zip');
  const target = path.join(paths.java, `temurin-${MIN_JAVA}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  new AdmZip(archive).extractAllTo(target, true);
  onProgress(0.95);

  const exe = findExecutableIn(target);
  if (!exe) throw new Error('La instalación de Java descargada está incompleta.');

  const version = await readJavaVersion(exe);
  if (!version) throw new Error('Java se descargó pero no se pudo ejecutar.');
  onProgress(1);

  return { ...version, downloaded: true };
}

/** Añade el Java elegido al PATH del proceso (Forge lo necesita para sus processors). */
function useInPath(javaPath) {
  const dir = path.dirname(javaPath);
  const current = process.env.PATH || '';
  if (!current.split(path.delimiter).includes(dir)) {
    process.env.PATH = `${dir}${path.delimiter}${current}`;
  }
  process.env.JAVA_HOME = path.dirname(dir);
}

module.exports = { detect, ensure, useInPath, readJavaVersion, MIN_JAVA };
