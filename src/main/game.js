'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const { MinecraftFolder, launch, createMinecraftProcessWatcher } = require('@xmcl/core');
const { getVersionList, installTask, installForgeTask } = require('@xmcl/installer');

const { paths } = require('./paths');
const configStore = require('./config');
const javaManager = require('./java');
const { offlineProfile } = require('./auth');
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

async function ensureVanilla(folder, minecraftVersion, report) {
  const list = await getVersionList();
  const meta = list.versions.find((version) => version.id === minecraftVersion);

  if (!meta) {
    throw new Error(`No se encontró Minecraft ${minecraftVersion} en el manifiesto de Mojang.`);
  }

  const task = installTask(meta, folder, { side: 'client' });
  const stop = trackProgress(task, report);

  try {
    await task.startAndWait();
  } finally {
    stop();
  }

  return task.get();
}

async function ensureForge(folder, minecraftVersion, forgeVersion, report) {
  const task = installForgeTask(
    { mcversion: minecraftVersion, version: forgeVersion },
    folder,
    { side: 'client' },
  );

  const stop = trackProgress(task, report);

  try {
    await task.startAndWait();
  } finally {
    stop();
  }

  return task.get();
}

/** Instala (si hace falta) Minecraft + Forge y devuelve el id de versión lanzable. */
async function ensureInstance({ minecraftVersion, forgeVersion, report }) {
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

  await ensureVanilla(folder, minecraftVersion, (fraction) => report(within([0, 0.72], fraction)));

  const versionId = await ensureForge(folder, minecraftVersion, forgeVersion, (fraction) =>
    report(within([0.72, 1], fraction)),
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
    this.logs = [];
  }

  status(text, phase = 'idle', percent = null) {
    this.emit('status', { text, phase, percent });
  }

  progress(percent, detail) {
    this.emit('progress', { percent: clamp01(percent), detail: detail || null });
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

    try {
      const config = configStore.load();
      const modpack = loadModpack();
      const channel = getChannel(config.channel);
      const profile =
        config.profiles.find((item) => item.id === config.activeProfile) || config.profiles[0];

      // 1. Java
      this.status('Verificando Java 17...', 'java', 0);
      this.progress(0.01, 'Java');

      const java = await javaManager.ensure(config.javaPath, (fraction) => {
        this.status('Descargando Java 17...', 'java', within([0, 0.08], fraction));
        this.progress(within([0, 0.08], fraction), 'Java');
      });

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
      });

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
      });

      this.log(`[launcher] Modpack ${channel.id}: ${sync.files} archivos verificados, ${sync.downloaded} descargados.`);

      if (this.cancelled) return this.finishCancelled();

      // 4. Lanzar
      this.status('Iniciando el juego...', 'launching', 0.97);
      this.progress(0.97, 'Launch');

      const auth = offlineProfile(profile.name);
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
        this.progress(0, null);
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
        this.status('Error al iniciar el juego', 'error', 0);
        this.emit('error', { message: String(error?.message || error) });
      });

      this.child.on('error', (error) => {
        this.running = false;
        this.status('Error al iniciar el juego', 'error', 0);
        this.emit('error', { message: error.message });
      });
    } catch (error) {
      this.running = false;
      this.progress(0, null);

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
    this.progress(0, null);
    this.status('Cancelado', 'idle', 0);
    this.emit('cancelled');
  }

  cancel() {
    if (!this.running) return false;
    this.cancelled = true;

    if (this.child?.pid) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        this.child.kill('SIGTERM');
      }
    } else {
      this.finishCancelled();
    }

    return true;
  }
}

module.exports = { LaunchManager, ensureInstance, PHASES };
