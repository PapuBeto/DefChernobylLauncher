'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');

const configStore = require('./config');
const { paths } = require('./paths');
const { loadModpack, loadNews, loadLinks } = require('./resources');
const { ping } = require('./server-status');
const javaManager = require('./java');
const authManager = require('./auth');
const skins = require('./skins');
const { UpdateService } = require('./updater');
const { LaunchManager } = require('./game');

const isDev = process.argv.includes('--dev');

// Permite arrancar con un userData limpio (pruebas y capturas).
const userDataArg = process.argv.indexOf('--user-data');
if (userDataArg > 0 && process.argv[userDataArg + 1]) {
  app.setPath('userData', path.resolve(process.argv[userDataArg + 1]));
}

let mainWindow = null;
let statusCache = { at: 0, value: null };

const launchManager = new LaunchManager();
const updateService = new UpdateService();

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

launchManager.on('status', (payload) => send('launch:status', payload));
launchManager.on('progress', (payload) => send('launch:progress', payload));
launchManager.on('log', (payload) => send('launch:log', payload));
launchManager.on('ready', (payload) => send('launch:ready', payload));
launchManager.on('exit', (payload) => send('launch:exit', payload));
launchManager.on('error', (payload) => send('launch:error', payload));
launchManager.on('cancelled', () => send('launch:cancelled', {}));

updateService.on('state', (state) => send('update:state', state));
updateService.on('log', (line) => {
  launchManager.log(line);
  console.log(line);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: '#0d0f10',
    title: 'Chernobyl Z',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (isDev || process.argv.includes('--screenshot')) {
    mainWindow.webContents.on('console-message', (_event, _level, message) => {
      console.log(`[renderer] ${message}`);
    });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

    if (process.argv.includes('--screenshot')) {
      const target = process.argv[process.argv.indexOf('--screenshot') + 1];
      const clickIndex = process.argv.indexOf('--shot-click');
      const clickIds =
        clickIndex > 0 && process.argv[clickIndex + 1]
          ? process.argv[clickIndex + 1].split(',').filter(Boolean)
          : [];
      const waitIndex = process.argv.indexOf('--shot-wait');
      const extraWait = waitIndex > 0 ? Number(process.argv[waitIndex + 1]) || 0 : 0;

      setTimeout(async () => {
        try {
          for (const id of clickIds) {
            await mainWindow.webContents.executeJavaScript(
              `document.getElementById(${JSON.stringify(id)})?.click()`,
            );
            await new Promise((resolve) => setTimeout(resolve, 900));
          }

          const moveIndex = process.argv.indexOf('--shot-move');
          if (moveIndex > 0 && process.argv[moveIndex + 1]) {
            const [x, y] = String(process.argv[moveIndex + 1]).split(',').map(Number);
            if (Number.isFinite(x) && Number.isFinite(y)) {
              await mainWindow.webContents.executeJavaScript(
                `window.dispatchEvent(new PointerEvent('pointermove', { clientX: ${x}, clientY: ${y} }))`,
              );
            }
          }

          const scrollIndex = process.argv.indexOf('--shot-scroll');
          if (scrollIndex > 0 && process.argv[scrollIndex + 1]) {
            const [selector, top] = String(process.argv[scrollIndex + 1]).split(',');
            await mainWindow.webContents.executeJavaScript(
              `document.querySelector(${JSON.stringify(selector)})?.scrollTo({ top: ${Number(top) || 0} })`,
            );
            await new Promise((resolve) => setTimeout(resolve, 300));
          }

          await new Promise((resolve) => setTimeout(resolve, 3000));
          const image = await mainWindow.webContents.capturePage();
          fs.writeFileSync(target, image.toPNG());
          console.log(`[screenshot] ${target}`);
        } catch (error) {
          console.error('[screenshot]', error);
        }
        app.quit();
      }, 3500 + extraWait);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('[renderer] proceso terminado:', details);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function serverStatus() {
  const modpack = loadModpack();
  const server = modpack.server || {};
  if (!server.host) {
    return { online: false, error: 'not-configured', players: { online: 0, max: 0 } };
  }

  const now = Date.now();
  if (statusCache.value && now - statusCache.at < 20000) {
    return statusCache.value;
  }

  const value = await ping(server.host, Number(server.port) || 25565);
  statusCache = { at: now, value };
  return value;
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', () => {
    const config = configStore.load();
    const modpack = loadModpack();

    return {
      launcherVersion: app.getVersion(),
      config,
      modpack: {
        name: modpack.name,
        minecraft: modpack.minecraft,
        forge: modpack.forge,
        server: modpack.server,
        channels: modpack.channels,
        fileCount: modpack.files.length,
      },
      news: loadNews(),
      links: loadLinks(),
      auth: authManager.status(config.profiles),
      update: updateService.getState(),
      system: {
        platform: process.platform,
        arch: process.arch,
        totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
        userData: paths.data,
        gameDir: paths.game,
      },
    };
  });

  ipcMain.handle('settings:save', (_event, patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('Ajustes inválidos.');
    const allowed = ['memory', 'javaPath', 'resolution', 'closeOnLaunch', 'channel', 'effects'];
    const safe = {};
    for (const key of allowed) {
      if (key in patch) safe[key] = patch[key];
    }
    return configStore.update(safe);
  });

  ipcMain.handle('profiles:add', (_event, name) => configStore.addProfile(name));
  ipcMain.handle('profiles:remove', (_event, id) => {
    authManager.signOut(id);
    const config = configStore.removeProfile(id);
    return { config, auth: authManager.status(config.profiles) };
  });
  ipcMain.handle('profiles:select', (_event, id) => configStore.selectProfile(id));

  let authFlow = null;

  ipcMain.handle('auth:sign-in', async () => {
    if (authFlow) throw new Error('Ya hay un inicio de sesión en curso.');

    const controller = new AbortController();
    authFlow = controller;

    try {
      const result = await authManager.signInMicrosoft({
        signal: controller.signal,
        onDeviceCode: (code) =>
          send('auth:device-code', {
            userCode: code.userCode,
            verificationUri: code.verificationUri,
            expiresIn: code.expiresIn,
          }),
      });

      const config = configStore.addMicrosoftProfile({
        name: result.profile.name,
        uuid: result.profile.id,
      });

      const payload = {
        profile: { id: result.id, name: result.profile.name, uuid: result.profile.id },
        config,
        auth: authManager.status(config.profiles),
      };

      send('auth:signed-in', payload);
      return payload;
    } catch (error) {
      send('auth:error', { message: error.message });
      throw error;
    } finally {
      authFlow = null;
    }
  });

  ipcMain.handle('auth:cancel', () => {
    authFlow?.abort();
    return true;
  });

  ipcMain.handle('auth:skin', async (_event, id) => {
    try {
      return await skins.dataUrl(id);
    } catch (error) {
      launchManager.log(`[skin] ${error.message}`);
      return null;
    }
  });

  ipcMain.handle('auth:sign-out', (_event, id) => {
    authManager.signOut(id);

    const config = configStore.load();
    const remaining = config.profiles.filter((profile) => profile.id !== id);

    const next = configStore.update({
      profiles: remaining,
      activeProfile:
        remaining.length === 0
          ? null
          : config.activeProfile === id
            ? remaining[0].id
            : config.activeProfile,
    });

    return { config: next, auth: authManager.status(next.profiles) };
  });

  ipcMain.handle('update:state', () => updateService.getState());
  ipcMain.handle('update:check', () => {
    updateService.check();
    return updateService.getState();
  });
  ipcMain.handle('update:install', () => updateService.install());

  ipcMain.handle('java:detect', async (_event, explicitPath) => {
    const config = configStore.load();
    return javaManager.detect(explicitPath || config.javaPath);
  });

  ipcMain.handle('server:status', () => serverStatus());

  ipcMain.handle('launch:start', async () => {
    if (launchManager.running) throw new Error('El juego ya se está iniciando.');
    // No esperamos a que termine: los eventos llegan por IPC.
    launchManager.start().catch(() => {
      /* el error ya se emitió por eventos */
    });
    return { started: true };
  });

  ipcMain.handle('launch:cancel', () => launchManager.cancel());

  ipcMain.handle('logs:get', () => launchManager.logs.slice(-400));

  ipcMain.handle('dialog:pick-java', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Selecciona el ejecutable de Java 17',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'Java', extensions: ['exe'] }]
        : [{ name: 'Todos los archivos', extensions: ['*'] }],
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    const selected = result.filePaths[0];
    const version = await javaManager.readJavaVersion(selected);
    return { path: selected, version };
  });

  ipcMain.handle('dialog:pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Selecciona una carpeta',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('shell:open', (_event, target) => {
    if (typeof target !== 'string') return false;
    if (target === 'game') return shell.openPath(paths.game).then(() => true);
    if (target === 'logs') return shell.openPath(paths.logs).then(() => true);
    if (target === 'data') return shell.openPath(paths.data).then(() => true);
    if (/^https?:\/\//i.test(target)) return shell.openExternal(target).then(() => true);
    return false;
  });

  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:hide', () => mainWindow?.hide());
  ipcMain.on('window:close', () => mainWindow?.close());
}

function ensureDirectories() {
  for (const dir of [paths.game, paths.java, paths.cache, paths.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    ensureDirectories();
    registerIpc();
    createWindow();
    updateService.start();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
