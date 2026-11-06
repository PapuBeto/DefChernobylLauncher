'use strict';

/**
 * Prueba de reanudación y velocidad de descarga.
 *
 * El servidor local corta la primera petición a propósito. El segundo intento
 * debe usar Range y completar el archivo sin volver a descargar lo que ya
 * estaba en el .part.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');

const testData = path.join(os.tmpdir(), 'chernobylz-download-test');
fs.rmSync(testData, { recursive: true, force: true });
fs.mkdirSync(testData, { recursive: true });
app.setPath('userData', testData);

const { syncFiles, readState } = require('../src/main/mods');

const BODY = crypto.randomBytes(8 * 1024 * 1024);
const SHA1 = crypto.createHash('sha1').update(BODY).digest('hex');
const FIRST_CHUNK = 256 * 1024;

function serve(request, response) {
  const range = request.headers.range || '';
  const match = /^bytes=(\d+)-$/.exec(range);
  const start = match ? Number(match[1]) : 0;

  response.writeHead(match ? 206 : 200, {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    'Content-Length': BODY.length - start,
    ...(match ? { 'Content-Range': `bytes ${start}-${BODY.length - 1}/${BODY.length}` } : {}),
  });

  if (!match) {
    // Primera petición: manda solo un trozo y corta la conexión.
    response.write(BODY.subarray(0, FIRST_CHUNK), () => {
      setTimeout(() => response.destroy(), 30);
    });
    return;
  }

  response.end(BODY.subarray(start));
}

async function main() {
  let sawRange = false;
  let requests = 0;

  const server = http.createServer((request, response) => {
    requests += 1;
    if (request.headers.range) sawRange = true;
    serve(request, response);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const root = path.join(testData, 'game');
  const destination = path.join(root, 'mods', 'test.bin');

  try {
    const reports = [];
    const result = await syncFiles(root, [{
      path: 'mods/test.bin',
      url: `http://127.0.0.1:${port}/test.bin`,
      sha1: SHA1,
      size: BODY.length,
    }], 'COMPLETA', (report) => reports.push(report));

    const data = fs.readFileSync(destination);
    const state = readState();

    const checks = {
      archivo: data.equals(BODY),
      tamano: data.length === BODY.length,
      reanudacion: sawRange && requests >= 2,
      velocidad: reports.some((report) => report.speed > 0),
      progreso: reports.some((report) => report.completed === 1 && report.total === 1),
      estado: state.managedFiles?.includes('mods/test.bin') === true,
      descargados: result.downloaded === 1,
      parteliminado: !fs.existsSync(`${destination}.part`),
    };

    // La segunda sincronización no debe descargar nada.
    const before = requests;
    const second = await syncFiles(root, [{
      path: 'mods/test.bin',
      url: `http://127.0.0.1:${port}/test.bin`,
      sha1: SHA1,
      size: BODY.length,
    }], 'COMPLETA', () => {});
    checks.sinredescarga = second.downloaded === 0 && requests === before;

    // Con el disco casi lleno, debe fallar antes de descargar.
    const realStatfs = fs.statfsSync;
    let diskError = '';
    try {
      fs.statfsSync = () => ({ bavail: 1, bsize: 4096 });
      await syncFiles(root, [{
        path: 'mods/test2.bin',
        url: `http://127.0.0.1:${port}/test.bin`,
        sha1: SHA1,
        size: BODY.length,
      }], 'COMPLETA', () => {});
    } catch (error) {
      diskError = error.message;
    } finally {
      fs.statfsSync = realStatfs;
    }
    checks.espacio = /espacio suficiente/.test(diskError);

    const failed = Object.entries(checks).filter(([, ok]) => !ok);
    for (const [name, ok] of Object.entries(checks)) {
      console.log(`${ok ? 'OK ' : 'FALLO'} ${name}`);
    }
    console.log(`Peticiones: ${requests}; Range: ${sawRange ? 'sí' : 'no'}`);

    server.close();
    app.exit(failed.length === 0 ? 0 : 1);
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
