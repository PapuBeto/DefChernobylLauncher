'use strict';

/**
 * Genera entradas `files` para resources/modpack.json a partir de una carpeta.
 *
 *   node scripts/generate-manifest.js <carpeta> <urlBase> [canal...]
 *
 * Ejemplo:
 *   node scripts/generate-manifest.js ./mods https://cdn.mi-server.com/mods COMPLETA LITE
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [folder, baseUrl, ...channels] = process.argv.slice(2);

if (!folder || !baseUrl) {
  console.error('Uso: node scripts/generate-manifest.js <carpeta> <urlBase> [canal...]');
  process.exit(1);
}

const root = path.resolve(folder);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`La carpeta no existe: ${root}`);
  process.exit(1);
}

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

const entries = walk(root)
  .filter((file) => file.endsWith('.jar'))
  .map((file) => {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const data = fs.readFileSync(file);
    const entry = {
      path: `mods/${relative}`,
      url: `${baseUrl.replace(/\/$/, '')}/${encodeURI(relative)}`,
      sha1: crypto.createHash('sha1').update(data).digest('hex'),
      size: data.length,
    };
    if (channels.length) entry.channels = channels.map((channel) => channel.toUpperCase());
    return entry;
  });

console.log(JSON.stringify(entries, null, 2));
console.error(`\n${entries.length} archivos · ${(entries.reduce((total, entry) => total + entry.size, 0) / 1048576).toFixed(1)} MB`);
