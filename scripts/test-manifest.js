'use strict';

/**
 * Prueba del manifiesto remoto: actualización por revisión, caché local y
 * rechazo de manifiestos inválidos. No descarga archivos del pack.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const testData = path.join(os.tmpdir(), 'chernobylz-manifest-test');
fs.rmSync(testData, { recursive: true, force: true });
fs.mkdirSync(testData, { recursive: true });
app.setPath('userData', testData);

const { loadModpack, refreshModpack } = require('../src/main/resources');
const { paths } = require('../src/main/paths');

const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'modpack.json'), 'utf8'));
const BASE = Number.isInteger(bundled.revision) ? bundled.revision : 1;

function manifest(revision, extra = {}) {
  return {
    revision,
    name: 'Chernobyl Z',
    minecraft: '1.20.1',
    forge: '47.4.28',
    channels: {
      COMPLETA: { label: 'COMPLETA' },
      LITE: { label: 'LITE' },
    },
    files: [{
      path: 'mods/test.jar',
      url: 'https://example.com/test.jar',
      sha1: '0123456789abcdef0123456789abcdef01234567',
      size: 123,
    }],
    mods: [{ name: 'Test', file: 'mods/test.jar' }],
    ...extra,
  };
}

async function main() {
  let current = manifest(BASE + 1);

  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(current));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/modpack.json`;

  try {
    const initial = loadModpack();
    const first = await refreshModpack(url, { force: true });
    const afterFirst = loadModpack();
    const cached = JSON.parse(fs.readFileSync(paths.remoteModpack, 'utf8'));

    current = manifest(BASE);
    const lower = await refreshModpack(url, { force: true });
    const afterLower = loadModpack();

    current = manifest(BASE + 1, { files: [{ path: '../evil.jar', url: 'https://example.com/evil.jar' }] });
    const invalid = await refreshModpack(url, { force: true });
    const afterInvalid = loadModpack();

    current = manifest(BASE + 2);
    const higher = await refreshModpack(url, { force: true });
    const afterHigher = loadModpack();

    const checks = {
      inicial: initial.revision === BASE,
      actualiza: first.updated === true && first.revision === BASE + 1,
      canales: Boolean(afterFirst.channels.LITE),
      archivos: afterFirst.files.length === 1,
      cache: cached.revision === BASE + 1,
      noDegrada: lower.updated === false && afterLower.revision === BASE + 1,
      rechazaInvalido: invalid.updated === false && afterInvalid.revision === BASE + 1,
      subeRevision: higher.updated === true && afterHigher.revision === BASE + 2,
      urlPreservada: afterHigher.manifestUrl === (bundled.manifestUrl || ''),
    };

    for (const [name, ok] of Object.entries(checks)) {
      console.log(`${ok ? 'OK ' : 'FALLO'} ${name}`);
    }

    const failed = Object.values(checks).filter((ok) => !ok).length;
    server.close();
    app.exit(failed === 0 ? 0 : 1);
  } catch (error) {
    console.error(error);
    server.close();
    app.exit(1);
  }
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});
