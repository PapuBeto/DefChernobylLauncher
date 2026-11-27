'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, ipcMain, shell, dialog, session } = require('electron');

const configStore = require('./config');
const { paths } = require('./paths');
const { loadModpack, refreshModpack, loadNews, refreshNews, loadLinks } = require('./resources');
const { ping } = require('./server-status');
const javaManager = require('./java');
const authManager = require('./auth');
const skins = require('./skins');
const skinService = require('./skin-service');
const modsInfo = require('./mods-info');
const { UpdateService } = require('./updater');
const { LaunchManager } = require('./game');

const isDev = !app.isPackaged && process.argv.includes('--dev');

// Permite arrancar con un userData limpio solo en desarrollo (pruebas y capturas).
if (!app.isPackaged) {
  const userDataArg = process.argv.indexOf('--user-data');
  if (userDataArg > 0 && process.argv[userDataArg + 1]) {
    app.setPath('userData', path.resolve(process.argv[userDataArg + 1]));
  }
}

const ALLOWED_EXTERNAL_HOSTS = new Set([
  'microsoft.com',
  'www.microsoft.com',
  'login.live.com',
  'github.com',
  'discord.gg',
  'discord.com',
  'chernobyl-z.tebex.store',
  'www.tiktok.com',
  'www.youtube.com',
  'www.instagram.com',
]);

function openSafeExternal(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    if (parsed.protocol !== 'https:') return Promise.resolve(false);
    if (!ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase())) return Promise.resolve(false);
    return shell.openExternal(parsed.toString()).then(() => true);
  } catch {
    return Promise.resolve(false);
  }
}

let mainWindow = null;
let hiddenByLaunch = false;
let pickedSkinPath = null;
let verifiedJavaPath = null;
let statusCache = { at: 0, value: null };

const launchManager = new LaunchManager();
const updateService = new UpdateService();

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

launchManager.on('status', (payload) => send('launch:status', payload));
launchManager.on('progress', (payload) => send('launch:progress', payload));
launchManager.on('log', (payload) => {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) {
    return;
  }
  send('launch:log', payload);
});
launchManager.on('ready', (payload) => send('launch:ready', payload));
launchManager.on('synced', (payload) => {
  statusCache = { at: 0, value: null };
  send('launch:synced', { ...payload, modpack: modpackSummary(loadModpack()) });
});
launchManager.on('exit', (payload) => {
  send('launch:exit', payload);
  if (!hiddenByLaunch) return;

  hiddenByLaunch = false;
  if (payload.code === 0) {
    app.quit();
  } else {
    showMainWindow();
  }
});
launchManager.on('error', (payload) => {
  send('launch:error', payload);
  if (hiddenByLaunch) {
    hiddenByLaunch = false;
    showMainWindow();
  }
});
launchManager.on('cancelled', () => {
  send('launch:cancelled', {});
  if (hiddenByLaunch) {
    hiddenByLaunch = false;
    showMainWindow();
  }
});

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
    icon: app.isPackaged
      ? paths.resource('icon.png')
      : path.join(__dirname, '..', '..', 'build', 'icon.png'),
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

  if (!app.isPackaged && !isDev && process.argv.includes('--screenshot')) {
    mainWindow.webContents.on('console-message', (_event, _level, message) => {
      console.log(`[renderer] ${message}`);
    });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

    if (!app.isPackaged && process.argv.includes('--screenshot')) {
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

  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openSafeExternal(url);
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

  mainWindow.on('minimize', () => send('window:visibility', { hidden: true }));
  mainWindow.on('hide', () => send('window:visibility', { hidden: true }));
  mainWindow.on('restore', () => send('window:visibility', { hidden: false }));

  mainWindow.on('show', () => {
    hiddenByLaunch = false;
    send('window:visibility', { hidden: false });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    hiddenByLaunch = false;
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

function modpackSummary(modpack) {
  const files = Array.isArray(modpack.files) ? modpack.files : [];
  const channelSizes = {};

  for (const id of Object.keys(modpack.channels || {})) {
    const upperId = id.toUpperCase();
    channelSizes[id] = files.reduce((total, file) => {
      if (
        Array.isArray(file.channels) &&
        file.channels.length > 0 &&
        !file.channels.some((channel) => String(channel).toUpperCase() === upperId)
      ) {
        return total;
      }
      return total + (Number(file.size) || 0);
    }, 0);
  }

  return {
    name: modpack.name,
    minecraft: modpack.minecraft,
    forge: modpack.forge,
    revision: modpack.revision || 1,
    source: modpack.source || 'bundled',
    manifestUrl: modpack.manifestUrl || '',
    server: modpack.server,
    channels: modpack.channels,
    fileCount: files.length,
    channelSizes,
  };
}

let lastNewsRefreshAt = 0;

function refreshNewsInBackground({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastNewsRefreshAt < 10000) return;
  lastNewsRefreshAt = now;

  refreshNews()
    .then((result) => {
      if (result?.updated && result.changed) {
        send('news:updated', result.items);
      }
    })
    .catch((error) => {
      console.warn('[news] Error inesperado:', error);
    });
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', () => {
    const config = configStore.load();
    const modpack = loadModpack();
    const effectiveGameDir = configStore.gameDir();
    refreshNewsInBackground();

    return {
      launcherVersion: app.getVersion(),
      config,
      modpack: modpackSummary(modpack),
      news: loadNews(),
      links: loadLinks(),
      auth: authManager.status(config.profiles),
      update: updateService.getState(),
      system: {
        platform: process.platform,
        arch: process.arch,
        totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
        gameDir: effectiveGameDir,
        defaultGameDir: paths.defaultGame,
        gameDirFallback: Boolean(config.gameDir && effectiveGameDir === paths.defaultGame),
      },
    };
  });

  ipcMain.handle('pack:check', async () => {
    // refreshModpack nunca lanza: siempre devuelve un resultado.
    const result = await refreshModpack('', { force: true });
    statusCache = { at: 0, value: null };
    return { ...result, modpack: modpackSummary(loadModpack()) };
  });

  ipcMain.handle('settings:save', (_event, patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('Ajustes inválidos.');
    const allowed = [
      'memory',
      'javaPath',
      'gameDir',
      'resolution',
      'closeOnLaunch',
      'channel',
      'effects',
      'music',
    ];
    const safe = {};
    for (const key of allowed) {
      if (key in patch) safe[key] = patch[key];
    }

    if ('javaPath' in safe) {
      const rawJava = safe.javaPath == null ? '' : String(safe.javaPath).trim();
      if (!rawJava) {
        safe.javaPath = null;
      } else {
        const candidate = path.resolve(rawJava);
        const currentJava = configStore.load().javaPath;
        const eq = (a, b) =>
          Boolean(a && b) &&
          (process.platform === 'win32'
            ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
            : path.resolve(a) === path.resolve(b));

        if (
          javaManager.isValidJavaExecutablePath(candidate) &&
          (eq(candidate, verifiedJavaPath) || eq(candidate, currentJava))
        ) {
          safe.javaPath = candidate;
        } else {
          safe.javaPath = currentJava || null;
        }
      }
    }

    if ('gameDir' in safe) {
      const rawDir = safe.gameDir == null ? '' : String(safe.gameDir).trim();
      if (!rawDir) {
        safe.gameDir = null;
      } else {
        const resolved = path.resolve(rawDir);
        if (!paths.isAccessibleDir(resolved)) {
          throw new Error('La carpeta seleccionada no existe o no tiene permisos de escritura.');
        }
        safe.gameDir = resolved;
      }
    }

    return configStore.update(safe);
  });

  function removeProfileAndSignOut(id) {
    authManager.signOut(id);
    const config = configStore.removeProfile(id);
    return { config, auth: authManager.status(config.profiles) };
  }

  ipcMain.handle('profiles:add', (_event, name) => configStore.addProfile(name));
  ipcMain.handle('profiles:remove', (_event, id) => removeProfileAndSignOut(id));
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

  ipcMain.handle('skin:info', async (_event, id) => {
    const profile = configStore.load().profiles.find((item) => item.id === id);
    if (!profile || profile.type !== 'microsoft') return { variant: null };

    let variant = authManager.skinVariant(id);

    // Las cuentas antiguas no guardaban el modelo: se resuelve al abrir el panel.
    if (!variant) {
      try {
        await authManager.sessionForProfile(profile);
        variant = authManager.skinVariant(id);
      } catch {
        // Sin sesión válida se mantiene el modelo clásico por defecto.
      }
    }

    return { variant };
  });

  ipcMain.handle('skin:pick', async () => {
    if (!mainWindow) throw new Error('La ventana no está lista.');

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Elegir skin',
      buttonLabel: 'Usar esta skin',
      properties: ['openFile'],
      filters: [{ name: 'Imagen PNG', extensions: ['png'] }],
    });

    if (result.canceled || !result.filePaths[0]) return null;

    const file = result.filePaths[0];
    const info = skinService.inspect(file);
    pickedSkinPath = file;

    return { name: path.basename(file), ...info };
  });

  ipcMain.handle('skin:lookup', async (_event, username) => {
    const active = configStore.activeProfile();
    if (!active || active.type !== 'microsoft') {
      throw new Error('Solo las cuentas premium (Microsoft) pueden cambiar de skin.');
    }
    return skins.lookupByUsername(username);
  });

  ipcMain.handle('skin:apply', async (_event, id, variant) => {
    if (!pickedSkinPath) throw new Error('Elige primero un archivo PNG.');

    const profile = configStore.load().profiles.find((item) => item.id === id);
    if (!profile) throw new Error('Cuenta no encontrada.');

    const result = await skinService.apply(profile, pickedSkinPath, variant);
    pickedSkinPath = null;
    return result;
  });

  ipcMain.handle('skin:apply-url', async (_event, id, url, variant) => {
    const profile = configStore.load().profiles.find((item) => item.id === id);
    if (!profile) throw new Error('Cuenta no encontrada.');

    const result = await skinService.applyFromUrl(profile, url, variant);
    pickedSkinPath = null;
    return result;
  });

  ipcMain.handle('skin:reset', async (_event, id) => {
    const profile = configStore.load().profiles.find((item) => item.id === id);
    if (!profile) throw new Error('Cuenta no encontrada.');
    return skinService.reset(profile);
  });

  ipcMain.handle(
    'mods:info',
    (_event, channel) => modsInfo.list(channel || configStore.load().channel),
  );

  ipcMain.handle('update:check', () => {
    updateService.check();
    return updateService.getState();
  });
  ipcMain.handle('update:install', () => updateService.install());

  ipcMain.handle('java:detect', async () => {
    const config = configStore.load();
    return javaManager.detect(config.javaPath);
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

  ipcMain.handle('mods:sync', async () => {
    if (launchManager.running) throw new Error('Ya hay una operación en curso.');
    // No esperamos: el resultado llega por eventos (launch:synced / launch:error).
    launchManager.syncNow().catch(() => {
      /* el error ya se emitió por eventos */
    });
    return { started: true };
  });

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
    const selected = path.resolve(result.filePaths[0]);
    if (!javaManager.isValidJavaExecutablePath(selected)) {
      return { path: null, version: null };
    }
    const version = await javaManager.readJavaVersion(selected);
    if (version && version.major === 17) {
      verifiedJavaPath = selected;
    }
    return { path: selected, version };
  });

  ipcMain.handle('dialog:pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Selecciona la carpeta del juego',
      defaultPath: configStore.gameDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('shell:open', (_event, target) => {
    if (typeof target !== 'string') return false;
    if (target === 'game') return shell.openPath(configStore.gameDir()).then(() => true);
    if (target === 'logs') return shell.openPath(paths.logs).then(() => true);
    if (target === 'data') return shell.openPath(paths.data).then(() => true);
    return openSafeExternal(target);
  });

  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:hide', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    hiddenByLaunch = true;
    mainWindow.hide();
    mainWindow.webContents.session.clearCache().catch(() => {});
  });
  ipcMain.on('window:close', () => mainWindow?.close());
}

function ensureDirectories() {
  for (const dir of [paths.defaultGame, paths.java, paths.cache, paths.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  configStore.gameDir();
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=192');
  app.commandLine.appendSwitch('disable-http-cache');
  app.commandLine.appendSwitch('media-cache-size', '1');
  if (process.platform === 'win32') {
    app.commandLine.appendSwitch('enable-features', 'UseEcoQoSForBackgroundProcess');
  }

  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    ensureDirectories();
    // Las noticias se descargan en segundo plano para no retrasar la apertura.
    refreshNewsInBackground({ force: true });
    // Si hay manifiesto remoto configurado, se intenta antes de pintar la UI.
    // refreshModpack nunca lanza: si falla, se usa el manifiesto incluido.
    await refreshModpack().catch((error) => {
      console.warn('[manifest] Error inesperado:', error);
    });
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
