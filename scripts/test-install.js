'use strict';

/**
 * Diagnóstico paso a paso del instalador dentro de Electron.
 *   node_modules\electron\dist\electron.exe scripts\test-install.js
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const testData = path.join(os.tmpdir(), 'cz-install-test');
fs.mkdirSync(testData, { recursive: true });
app.setPath('userData', testData);

process.on('unhandledRejection', (error) => console.error('[test] unhandledRejection:', error));
process.on('uncaughtException', (error) => console.error('[test] uncaughtException:', error));
process.on('exit', (code) => console.log(`[test] proceso saliendo con código ${code}`));

app.whenReady().then(async () => {
  const { MinecraftFolder } = require('@xmcl/core');
  const { getVersionList, installTask } = require('@xmcl/installer');
  const java = require('../src/main/java');
  const { paths } = require('../src/main/paths');

  console.log('[test] whenReady');

  const detected = await java.ensure(null, () => {});
  java.useInPath(detected.path);
  console.log(`[test] Java: ${detected.raw}`);

  console.log('[test] getVersionList...');
  const list = await getVersionList();
  console.log(`[test] versiones: ${list.versions.length}`);

  const meta = list.versions.find((version) => version.id === '1.20.1');
  const folder = MinecraftFolder.from(paths.game);
  fs.mkdirSync(folder.root, { recursive: true });

  console.log(`[test] instalando vanilla en ${folder.root}`);
  const task = installTask(meta, folder, { side: 'client' });
  console.log(`[test] tarea creada: total=${task.total} progress=${task.progress}`);

  const timer = setInterval(() => {
    console.log(`[test] progreso ${task.progress}/${task.total}`);
  }, 5000);

  try {
    await task.startAndWait();
    console.log('[test] vanilla OK', task.get()?.id);
  } catch (error) {
    console.error('[test] vanilla FALLÓ:', error);
  } finally {
    clearInterval(timer);
  }

  app.exit(0);
});
