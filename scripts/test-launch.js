'use strict';

/**
 * Prueba de lanzamiento: arranca Minecraft con el version.json instalado,
 * sin conectarse a ningún servidor, y cierra el juego a los 15 s.
 *
 *   node_modules\electron\dist\electron.exe scripts\test-launch.js
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const testData = path.join(os.tmpdir(), 'cz-install-test');
fs.mkdirSync(testData, { recursive: true });
app.setPath('userData', testData);

const logs = [];
let finished = false;

function finish(code) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(testData, 'launch-test.log'), logs.join('\n'), 'utf8');
  app.exit(code);
}

app.whenReady().then(async () => {
  // Sin servidor: solo comprobamos que el juego arranca.
  const resources = require('../src/main/resources');
  const modpack = resources.loadModpack();
  resources.loadModpack = () => ({ ...modpack, server: { ...modpack.server, host: '' } });

  const { LaunchManager } = require('../src/main/game');
  const manager = new LaunchManager();

  manager.on('status', ({ phase, text }) => {
    logs.push(`[status:${phase}] ${text}`);
    console.log(`[status:${phase}] ${text}`);
  });

  manager.on('live-log', () => {});

  manager.on('ready', ({ pid }) => {
    logs.push(`[test] ventana del juego lista (pid ${pid})`);
    console.log(`[test] ventana del juego lista (pid ${pid})`);
    setTimeout(() => {
      console.log('[test] cerrando el juego');
      manager.cancel();
      setTimeout(() => finish(0), 4000);
    }, 15000);
  });

  manager.on('exit', ({ code, crashed, crashReport }) => {
    logs.push(`[test] el juego terminó: code=${code} crashed=${crashed}`);
    console.log(`[test] el juego terminó: code=${code} crashed=${crashed}`);
    if (crashReport) logs.push(crashReport.slice(0, 2000));
    finish(crashed ? 1 : 0);
  });

  manager.on('error', ({ message }) => {
    logs.push(`[test] error: ${message}`);
    console.error(`[test] error: ${message}`);
    finish(1);
  });

  manager.on('log', ({ line }) => logs.push(line));

  setTimeout(() => {
    console.error('[test] timeout: el juego no arrancó en 4 minutos');
    manager.cancel();
    finish(2);
  }, 240000).unref?.();

  try {
    await manager.start();
  } catch (error) {
    console.error('[test] fallo al lanzar:', error);
    finish(1);
  }
});
