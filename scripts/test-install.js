'use strict';

/**
 * Prueba de humo: detecta Java, instala Minecraft 1.20.1 + Forge y sincroniza
 * los archivos del modpack en una carpeta temporal.
 *
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

function dumpError(error, depth = 0) {
  const pad = '  '.repeat(depth);
  console.error(`${pad}${error?.name || 'Error'}: ${error?.message || error}${error?.code ? ` [${error.code}]` : ''}`);
  for (const inner of error?.errors || []) dumpError(inner, depth + 1);
  if (error?.cause) dumpError(error.cause, depth + 1);
}

app.whenReady().then(async () => {
  const java = require('../src/main/java');
  const { ensureInstance } = require('../src/main/game');
  const { loadModpack, getChannel, filesForChannel } = require('../src/main/resources');
  const { syncFiles } = require('../src/main/mods');
  const { paths } = require('../src/main/paths');

  const modpack = loadModpack();
  console.log(`[test] game: ${paths.game}`);
  console.log(`[test] MC ${modpack.minecraft} / Forge ${modpack.forge}`);

  const detected = await java.ensure(null, () => {});
  java.useInPath(detected.path);
  console.log(`[test] Java: ${detected.raw}`);

  const started = Date.now();
  let last = -1;

  try {
    const versionId = await ensureInstance({
      minecraftVersion: modpack.minecraft,
      forgeVersion: modpack.forge,
      report: (fraction) => {
        const percent = Math.round(fraction * 100);
        if (percent >= last + 5) {
          last = percent;
          console.log(`[test] ${percent}%`);
        }
      },
    });

    console.log(`[test] instancia OK: ${versionId}`);

    const channel = getChannel('COMPLETA');
    const files = filesForChannel(channel.id);
    const sync = await syncFiles(paths.game, files, channel.id, () => {});
    console.log(`[test] modpack OK: ${sync.files} archivos, ${sync.downloaded} descargados`);

    const versionJson = path.join(paths.game, 'versions', versionId, `${versionId}.json`);
    console.log(`[test] version.json existe: ${fs.existsSync(versionJson)}`);
    console.log(`[test] TODO OK en ${((Date.now() - started) / 1000).toFixed(1)}s`);
    app.exit(0);
  } catch (error) {
    console.error('[test] FALLÓ');
    dumpError(error);
    app.exit(1);
  }
});
