'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const AdmZip = require('adm-zip');

const { MinecraftFolder, launch, createMinecraftProcessWatcher } = require('@xmcl/core');
const { getVersionList, installTask } = require('@xmcl/installer');

const { paths } = require('./paths');
const configStore = require('./config');
const javaManager = require('./java');
const authManager = require('./auth');
const { loadModpack, getChannel, filesForChannel } = require('./resources');
const { syncFiles, readState, writeState } = require('./mods');

const PHASES = {
  idle: 'Listo para jugar',
  java: 'Preparando Java',
  minecraft: 'Descargando Minecraft',
  forge: 'Instalando Forge',
  mods: 'Sincronizando mods',
  launching: 'Iniciando el juego',
  running: 'Jugando',
  error: 'Error',
};

const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));
const within = ([from, to], fraction) => from + (to - from) * clamp01(fraction);

function trackProgress(task, onFraction) {
  const timer = setInterval(() => {
    const total = task.total;
    if (total > 0) onFraction(clamp01(task.progress / total));
  }, 300);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Reintenta una operación (las descargas de Mojang fallan de vez en cuando). */
async function withRetries(operation, attempts = 3, onRetry = () => {}, isCancelled = () => false) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (isCancelled() || attempt === attempts - 1) break;
      onRetry(attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
    }
  }

  throw lastError;
}

async function ensureVanilla(folder, minecraftVersion, report, context = {}) {
  const isCancelled = context.isCancelled || (() => false);
  const list = await withRetries(() => getVersionList(), 3, () => {}, isCancelled);
  const meta = list.versions.find((version) => version.id === minecraftVersion);

  if (!meta) {
    throw new Error(`No se encontró Minecraft ${minecraftVersion} en el manifiesto de Mojang.`);
  }

  return withRetries(
    async () => {
      const task = installTask(meta, folder, {
        side: 'client',
        assetsDownloadConcurrency: 8,
        librariesDownloadConcurrency: 8,
      });
      context.onTask?.(task);
      const stop = trackProgress(task, report);

      try {
        await task.startAndWait();
      } finally {
        stop();
      }

      return task.get();
    },
    3,
    () => report(0),
    isCancelled,
  );
}

const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* archivo bloqueado o ya eliminado */
  }
}

function isForgeInstaller(file) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < 1_000_000) return false;
    const zip = new AdmZip(file);
    return Boolean(zip.getEntry('install_profile.json'));
  } catch {
    return false;
  }
}

async function fetchText(url, timeoutMs, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.text()).trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function downloadForgeInstaller(url, destination, signal) {
  let expected = null;
  try {
    const text = await fetchText(`${url}.sha1`, 15000, signal);
    const value = text.split(/\s+/)[0].toLowerCase();
    if (/^[a-f0-9]{40}$/.test(value)) expected = value;
  } catch {
    /* el .sha1 es opcional; el instalador se valida al abrirlo */
  }

  if (fs.existsSync(destination) && isForgeInstaller(destination)) {
    if (!expected) return;
    const local = await sha1File(destination);
    if (local === expected) return;
    removeFile(destination);
  } else {
    removeFile(destination);
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (signal?.aborted) throw new Error('Descarga cancelada.');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 90000);
    const temporary = `${destination}.part`;

    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const handle = fs.createWriteStream(temporary);
      const hash = crypto.createHash('sha1');
      let size = 0;

      try {
        for await (const chunk of response.body) {
          hash.update(chunk);
          size += chunk.length;
          if (!handle.write(chunk)) {
            await new Promise((resolve) => handle.once('drain', resolve));
          }
        }
      } finally {
        await new Promise((resolve) => handle.end(resolve));
      }

      const sha1 = hash.digest('hex');
      if (expected && sha1 !== expected) throw new Error('SHA-1 del instalador no coincide.');
      if (size < 1_000_000) throw new Error('El instalador llegó incompleto.');

      fs.renameSync(temporary, destination);
      return;
    } catch (error) {
      lastError = error;
      removeFile(temporary);
      if (signal?.aborted) throw new Error('Descarga cancelada.');
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  throw new Error(`No se pudo descargar el instalador de Forge: ${lastError?.message || lastError}`);
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

function runForgeInstaller({ installer, gameDir, signal, isCancelled, report, onTask }) {
  return new Promise((resolve, reject) => {
    const logPath = path.join(paths.logs, 'forge-install.log');
    fs.mkdirSync(paths.logs, { recursive: true });
    const log = fs.createWriteStream(logPath, { flags: 'w' });
    log.on('error', () => {});
    log.write(`[launcher] ${new Date().toISOString()} java -jar ${installer} --installClient ${gameDir}\n`);

    const child = spawn('java', ['-Djava.awt.headless=true', '-jar', installer, '--installClient', gameDir], {
      cwd: gameDir,
      windowsHide: true,
    });

    let tail = '';
    const onData = (chunk) => {
      log.write(chunk);
      tail = (tail + chunk.toString('utf8')).slice(-16000);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    let cancelled = false;
    let fake = 0.02;
    report(fake);

    const kill = () => {
      cancelled = true;
      killTree(child);
    };

    onTask?.({ cancel: async () => kill() });

    const cancellationTimer = setInterval(() => {
      if (isCancelled()) kill();
    }, 500);

    const progressTimer = setInterval(() => {
      fake = Math.min(0.92, fake + 0.012);
      report(fake);
    }, 1200);

    const cleanup = () => {
      clearInterval(cancellationTimer);
      clearInterval(progressTimer);
      log.end();
    };

    child.once('error', (error) => {
      cleanup();
      reject(error);
    });

    child.once('close', (code) => {
      cleanup();
      if (cancelled || isCancelled() || signal?.aborted) {
        reject(new Error('Instalación de Forge cancelada.'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`El instalador de Forge falló (código ${code}).\n${tail.slice(-3000)}`));
        return;
      }
      resolve();
    });
  });
}

function findForgeVersion(folder, minecraftVersion, forgeVersion) {
  const versions = path.join(folder.root, 'versions');
  const expected = `${minecraftVersion}-forge-${forgeVersion}`;
  const names = fs.existsSync(versions) ? fs.readdirSync(versions) : [];
  const candidates = [expected, ...names.filter((name) => name !== expected && name.includes(`forge-${forgeVersion}`))];

  for (const name of candidates) {
    const json = path.join(versions, name, `${name}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(json, 'utf8'));
      if (data?.id) return name;
    } catch {
      /* versión incompleta: se reinstala */
    }
  }
  return null;
}

async function ensureForge(folder, minecraftVersion, forgeVersion, report, context = {}) {
  const isCancelled = context.isCancelled || (() => false);
  const existing = findForgeVersion(folder, minecraftVersion, forgeVersion);
  if (existing) {
    report(1);
    return existing;
  }

  const installer = path.join(
    folder.root,
    'libraries',
    'net',
    'minecraftforge',
    'forge',
    `${minecraftVersion}-${forgeVersion}`,
    `forge-${minecraftVersion}-${forgeVersion}-installer.jar`,
  );

  const profiles = path.join(folder.root, 'launcher_profiles.json');
  let profileData = null;
  try {
    if (fs.existsSync(profiles)) profileData = JSON.parse(fs.readFileSync(profiles, 'utf8'));
  } catch {
    profileData = null;
  }

  if (!profileData || typeof profileData !== 'object' || Array.isArray(profileData)) {
    fs.writeFileSync(profiles, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2), 'utf8');
  }

  return withRetries(
    async () => {
      if (isCancelled()) throw new Error('Instalación cancelada.');

      await downloadForgeInstaller(
        `${FORGE_MAVEN}/${minecraftVersion}-${forgeVersion}/forge-${minecraftVersion}-${forgeVersion}-installer.jar`,
        installer,
        context.signal,
      );

      if (isCancelled()) throw new Error('Instalación cancelada.');

      await runForgeInstaller({
        installer,
        gameDir: folder.root,
        signal: context.signal,
        isCancelled,
        report,
        onTask: context.onTask,
      });

      const versionId = findForgeVersion(folder, minecraftVersion, forgeVersion);
      if (!versionId) throw new Error('Forge terminó pero no se encontró la versión instalada.');
      report(1);
      return versionId;
    },
    2,
    () => report(0),
    isCancelled,
  );
}

/** Instala (si hace falta) Minecraft + Forge y devuelve el id de versión lanzable. */
async function ensureInstance({ minecraftVersion, forgeVersion, report, context = {} }) {
  const folder = MinecraftFolder.from(paths.game);
  const state = readState();
  const marker = state.install;

  const markerValid =
    marker &&
    marker.minecraft === minecraftVersion &&
    marker.forge === forgeVersion &&
    marker.versionId &&
    fs.existsSync(folder.getVersionJson(marker.versionId));

  if (markerValid) {
    report(1);
    return marker.versionId;
  }

  fs.mkdirSync(folder.root, { recursive: true });

  await ensureVanilla(folder, minecraftVersion, (fraction) => report(within([0, 0.72], fraction)), context);

  const versionId = await ensureForge(
    folder,
    minecraftVersion,
    forgeVersion,
    (fraction) => report(within([0.72, 1], fraction)),
    context,
  );

  writeState({
    ...readState(),
    install: { minecraft: minecraftVersion, forge: forgeVersion, versionId, installedAt: Date.now() },
  });

  report(1);
  return versionId;
}

class LaunchManager extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.cancelled = false;
    this.child = null;
    this.watcher = null;
    this.currentTask = null;
    this.abortController = null;
    this.logs = [];
    this.progressFloor = 0;
  }

  status(text, phase = 'idle', percent = null) {
    const value = percent === null ? null : clamp01(percent);
    const shown = value === null || phase === 'idle' || phase === 'error'
      ? value
      : Math.max(this.progressFloor, value);
    this.emit('status', { text, phase, percent: shown });
  }

  progress(percent, detail) {
    // La barra nunca retrocede: las tareas internas de xmcl reinician su conteo.
    this.progressFloor = Math.max(this.progressFloor, clamp01(percent));
    this.emit('progress', { percent: this.progressFloor, detail: detail || null });
  }

  resetProgress() {
    this.progressFloor = 0;
    this.emit('progress', { percent: 0, detail: null });
  }

  log(line) {
    if (!line) return;
    this.logs.push(line);
    if (this.logs.length > 800) this.logs.shift();
    this.emit('log', { line });
  }

  appendLogFile(line) {
    try {
      fs.mkdirSync(paths.logs, { recursive: true });
      fs.appendFileSync(path.join(paths.logs, 'launcher.log'), `${line}\n`, 'utf8');
    } catch {
      /* logging best-effort */
    }
  }

  async start() {
    if (this.running) {
      throw new Error('El juego ya se está iniciando.');
    }

    this.running = true;
    this.cancelled = false;
    this.logs = [];
    this.currentTask = null;
    this.abortController = new AbortController();
    this.progressFloor = 0;

    const isCancelled = () => this.cancelled;

    try {
      const config = configStore.load();
      const modpack = loadModpack();
      const channel = getChannel(config.channel);
      const profile =
        config.profiles.find((item) => item.id === config.activeProfile) || config.profiles[0];

      if (!profile) {
        throw new Error('Elige una cuenta premium o no premium antes de jugar.');
      }

      // 0. Cuenta (renueva el token de Microsoft antes de descargar nada)
      if (profile.type === 'microsoft') {
        this.status('Comprobando cuenta Microsoft...', 'idle', 0);
        this.progress(0.005, 'Cuenta');
      }

      const auth = await authManager.sessionForProfile(profile);
      this.log(
        `[launcher] Cuenta ${profile.type === 'microsoft' ? 'Microsoft' : 'offline'}: ${auth.name} (${auth.id})`,
      );

      if (this.cancelled) return this.finishCancelled();

      // 1. Java
      this.status('Verificando Java 17...', 'java', 0);
      this.progress(0.01, 'Java');

      const java = await javaManager.ensure(config.javaPath, (fraction) => {
        this.status('Descargando Java 17...', 'java', within([0, 0.08], fraction));
        this.progress(within([0, 0.08], fraction), 'Java');
      }, this.abortController.signal);

      if (this.cancelled) return this.finishCancelled();
      javaManager.useInPath(java.path);
      this.log(`[launcher] Java ${java.raw} (${java.path})`);

      // 2. Minecraft + Forge
      const versionId = await ensureInstance({
        minecraftVersion: modpack.minecraft,
        forgeVersion: modpack.forge,
        report: (fraction) => {
          this.status('Instalando Minecraft y Forge...', 'minecraft', within([0.08, 0.8], fraction));
          this.progress(within([0.08, 0.8], fraction), 'Minecraft / Forge');
        },
        context: {
          onTask: (task) => {
            this.currentTask = task;
          },
          isCancelled,
          signal: this.abortController.signal,
        },
      });

      this.currentTask = null;

      this.log(`[launcher] Versión instalada: ${versionId}`);

      if (this.cancelled) return this.finishCancelled();

      // 3. Mods del canal elegido
      this.status('Sincronizando archivos del modpack...', 'mods', 0.82);
      this.progress(0.82, channel.label);

      const files = filesForChannel(channel.id);
      const sync = await syncFiles(paths.game, files, channel.id, ({ percent, file, completed, total }) => {
        const detail = total > 0 ? `${completed}/${total}` : channel.label;
        this.status(
          file ? `Descargando ${path.basename(file)} (${detail})` : 'Verificando archivos del modpack...',
          'mods',
          within([0.82, 0.95], percent),
        );
        this.progress(within([0.82, 0.95], percent), detail);
      }, this.abortController.signal);

      this.log(`[launcher] Modpack ${channel.id}: ${sync.files} archivos verificados, ${sync.downloaded} descargados.`);

      if (this.cancelled) return this.finishCancelled();

      // 4. Lanzar
      this.status('Iniciando el juego...', 'launching', 0.97);
      this.progress(0.97, 'Launch');

      const server = modpack.server || {};

      this.child = await launch({
        gamePath: paths.game,
        resourcePath: paths.game,
        javaPath: java.path,
        version: versionId,
        gameProfile: { name: auth.name, id: auth.id },
        accessToken: auth.accessToken,
        userType: auth.userType,
        launcherName: 'Chernobyl Z',
        launcherBrand: 'Chernobyl Z',
        versionType: 'Chernobyl Z',
        minMemory: Math.min(1024, Math.floor(config.memory / 2)),
        maxMemory: config.memory,
        resolution: {
          width: config.resolution.width,
          height: config.resolution.height,
          fullscreen: config.resolution.fullscreen,
        },
        server: server.host ? { ip: server.host, port: Number(server.port) || 25565 } : undefined,
        extraJVMArgs: [
          '-XX:+UseG1GC',
          '-XX:+ParallelRefProcEnabled',
          '-XX:MaxGCPauseMillis=200',
          '-XX:+UnlockExperimentalVMOptions',
          '-XX:+DisableExplicitGC',
          '-XX:G1NewSizePercent=20',
          '-XX:G1ReservePercent=20',
          '-XX:G1HeapRegionSize=32M',
          '-Dfile.encoding=UTF-8',
        ],
        ignoreInvalidMinecraftCertificates: true,
        ignorePatchDiscrepancies: true,
      });

      this.watcher = createMinecraftProcessWatcher(this.child);

      const pipe = (stream, prefix) => {
        stream?.on('data', (chunk) => {
          for (const line of chunk.toString('utf8').split(/\r?\n/)) {
            if (!line.trim()) continue;
            this.log(`${prefix}${line}`);
            this.appendLogFile(line);
          }
        });
      };

      pipe(this.child.stdout, '');
      pipe(this.child.stderr, '[err] ');

      this.watcher.on('minecraft-window-ready', () => {
        this.progress(1, 'Jugando');
        this.status('Jugando', 'running', 1);
        this.emit('ready', { pid: this.child?.pid });
      });

      this.watcher.on('minecraft-exit', ({ code, crashReport, crashReportLocation }) => {
        this.child = null;
        this.running = false;
        this.resetProgress();
        this.status('Listo para jugar', 'idle', 0);
        this.emit('exit', {
          code,
          crashed: code !== 0 && !this.cancelled,
          crashReport: crashReport || null,
          crashReportLocation: crashReportLocation || null,
        });
        if (crashReport) this.log(`[launcher] Crash report: ${crashReportLocation}`);
      });

      this.watcher.on('error', (error) => {
        this.running = false;
        this.resetProgress();
        this.status('Error al iniciar el juego', 'error', 0);
        this.emit('error', { message: String(error?.message || error) });
      });

      this.child.on('error', (error) => {
        this.running = false;
        this.resetProgress();
        this.status('Error al iniciar el juego', 'error', 0);
        this.emit('error', { message: error.message });
      });
    } catch (error) {
      this.running = false;
      this.resetProgress();

      if (this.cancelled) return this.finishCancelled();

      const message = error?.message || String(error);
      this.status(`Error: ${message}`, 'error', 0);
      this.log(`[launcher] ERROR: ${message}`);
      this.emit('error', { message });
      throw error;
    }
  }

  finishCancelled() {
    this.running = false;
    this.currentTask = null;
    this.resetProgress();
    this.status('Cancelado', 'idle', 0);
    this.emit('cancelled');
  }

  cancel() {
    if (!this.running) return false;
    this.cancelled = true;

    try {
      this.abortController?.abort();
    } catch {
      /* abort best-effort */
    }

    if (this.currentTask) {
      this.currentTask.cancel().catch(() => {});
      this.currentTask = null;
    }

    if (this.child?.pid) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        this.child.kill('SIGTERM');
      }
    }

    return true;
  }
}

module.exports = { LaunchManager, ensureInstance, PHASES };
