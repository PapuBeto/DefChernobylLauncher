'use strict';

/**
 * Genera las entradas `files` de resources/modpack.json a partir de una o varias
 * carpetas de pack (.minecraft).
 *
 * Forma simple (una carpeta, uno o varios canales):
 *
 *   node scripts/generate-manifest.js <carpeta> <urlBase> [canal...]
 *
 *   node scripts/generate-manifest.js "C:\packs\completa" "https://cdn.../completa" COMPLETA
 *
 * Forma por canal (recomendada cuando COMPLETA y LITE son carpetas distintas):
 *
 *   node scripts/generate-manifest.js ^
 *     --channel COMPLETA "C:\packs\completa" "https://cdn.../completa" ^
 *     --channel LITE "C:\packs\lite" "https://cdn.../lite" ^
 *     --write resources/modpack.json
 *
 * Opciones:
 *   --write <archivo>   Sustituye `files` en ese modpack.json.
 *   --output <archivo>  Guarda el array JSON en un archivo.
 *   --options           Incluye también options.txt (ver README).
 *   --exclude <glob>    Excluye rutas que coincidan (repetible).
 *
 * Carpetas incluidas: mods, config, defaultconfigs, kubejs, tacz, scripts,
 * resourcepacks y shaderpacks. Si la carpeta no tiene ninguna de ellas se trata
 * como una carpeta de mods (modo antiguo: solo .jar).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PACK_DIRS = [
  'mods',
  'config',
  'defaultconfigs',
  'kubejs',
  'tacz',
  'scripts',
  'resourcepacks',
  'shaderpacks',
];

const EXCLUDED_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  '__MACOSX',
  'saves',
  'logs',
  'crash-reports',
  'backups',
  'screenshots',
  '.cache',
  'cache',
]);

const EXCLUDED_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

const EXCLUDED_EXTENSIONS = new Set([
  '.log',
  '.tmp',
  '.part',
  '.bak',
  '.old',
  '.orig',
  '.rej',
  '.swp',
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const channels = [];
  let folder = null;
  let baseUrl = null;
  let positionalChannels = [];
  let writeFile = null;
  let outputFile = null;
  let includeOptions = false;
  const excludes = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--channel') {
      const name = argv[i + 1];
      const root = argv[i + 2];
      const base = argv[i + 3];
      if (!name || !root || !base) fail('--channel necesita <nombre> <carpeta> <urlBase>');
      channels.push({ name, root, base });
      i += 3;
    } else if (arg === '--write') {
      writeFile = argv[++i];
      if (!writeFile) fail('--write necesita un archivo');
    } else if (arg === '--output') {
      outputFile = argv[++i];
      if (!outputFile) fail('--output necesita un archivo');
    } else if (arg === '--options') {
      includeOptions = true;
    } else if (arg === '--exclude') {
      const pattern = argv[++i];
      if (!pattern) fail('--exclude necesita un patrón');
      excludes.push(pattern);
    } else if (arg.startsWith('--')) {
      fail(`Opción desconocida: ${arg}`);
    } else if (!folder) {
      folder = arg;
    } else if (!baseUrl) {
      baseUrl = arg;
    } else {
      positionalChannels.push(arg);
    }
  }

  if (channels.length === 0 && folder && baseUrl) {
    const names = positionalChannels.length ? positionalChannels : [null];
    for (const name of names) {
      channels.push({ name, root: folder, base: baseUrl });
    }
  }

  if (channels.length === 0) {
    fail('Uso: node scripts/generate-manifest.js <carpeta> <urlBase> [canal...]\n' +
      '  o: node scripts/generate-manifest.js --channel COMPLETA <carpeta> <urlBase> ...');
  }

  return { channels, writeFile, outputFile, includeOptions, excludes };
}

function normalizeChannel(value) {
  if (value == null) return null;
  const name = String(value).trim().toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(name)) fail(`Canal inválido: ${value}`);
  return name;
}

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<ALL>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<ALL>>>/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`, 'i');
}

function shouldSkipFile(name, relative, excludes) {
  if (EXCLUDED_FILES.has(name)) return true;
  if (EXCLUDED_EXTENSIONS.has(path.extname(name).toLowerCase())) return true;
  if (name.endsWith('~')) return true;
  return excludes.some((regex) => regex.test(relative));
}

function walkAll(directory, root, excludes, files = [], skippedLinks = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const relative = path.relative(root, full).split(path.sep).join('/');

    if (entry.isSymbolicLink()) {
      skippedLinks.push(relative);
      continue;
    }

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walkAll(full, root, excludes, files, skippedLinks);
      continue;
    }

    if (!entry.isFile()) continue;
    if (shouldSkipFile(entry.name, relative, excludes)) continue;
    files.push({ full, relative });
  }
  return files;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function encodePath(relative) {
  return relative.split('/').map(encodeURIComponent).join('/');
}

function joinUrl(baseUrl, relative) {
  return `${baseUrl.replace(/\/+$/, '')}/${encodePath(relative)}`;
}

function collectRoot(root, includeOptions, excludes) {
  const absolute = path.resolve(root);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    fail(`La carpeta no existe: ${absolute}`);
  }

  let base = absolute;
  let isPackRoot = PACK_DIRS.some((dir) => fs.existsSync(path.join(base, dir)));

  // Muchos packs vienen dentro de una carpeta .minecraft.
  const nested = path.join(absolute, '.minecraft');
  if (!isPackRoot && fs.existsSync(nested) && PACK_DIRS.some((dir) => fs.existsSync(path.join(nested, dir)))) {
    base = nested;
    isPackRoot = true;
  }

  const files = [];
  const skippedLinks = [];

  if (isPackRoot) {
    for (const dir of PACK_DIRS) {
      const full = path.join(base, dir);
      if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) continue;
      walkAll(full, base, excludes, files, skippedLinks);
    }

    if (includeOptions) {
      const options = path.join(base, 'options.txt');
      if (fs.existsSync(options) && fs.statSync(options).isFile()) {
        files.push({ full: options, relative: 'options.txt' });
      }
    }
  } else {
    // Modo antiguo: la carpeta contiene jars sueltos (con o sin subcarpetas).
    const found = walkAll(base, base, excludes, [], skippedLinks);
    for (const entry of found) {
      if (!entry.relative.toLowerCase().endsWith('.jar')) continue;
      files.push({ full: entry.full, relative: entry.relative, manifestPath: `mods/${entry.relative}` });
    }
  }

  return { files, skippedLinks, isPackRoot, base };
}

async function main() {
  const { channels, writeFile, outputFile, includeOptions, excludes } = parseArgs(process.argv.slice(2));
  const excludeRegexes = excludes.map(globToRegExp);
  const roots = [...new Set(channels.map((channel) => path.resolve(channel.root)))];
  const rootCache = new Map();

  for (const root of roots) {
    rootCache.set(root, collectRoot(root, includeOptions, excludeRegexes));
  }

  const byPathAndHash = new Map();
  const fileCache = new Map();
  let processed = 0;
  let totalFiles = 0;
  for (const root of roots) totalFiles += rootCache.get(root).files.length;

  for (const channel of channels) {
    const name = normalizeChannel(channel.name);
    const root = rootCache.get(path.resolve(channel.root));
    const origin = `${path.resolve(channel.root)}\0${channel.base.replace(/\/+$/, '')}`;

    for (const file of root.files) {
      let info = fileCache.get(file.full);
      if (!info) {
        info = { sha1: await hashFile(file.full), size: fs.statSync(file.full).size };
        fileCache.set(file.full, info);
      }

      const manifestPath = file.manifestPath || file.relative;
      const key = `${origin}\0${manifestPath}\0${info.sha1}`;
      let entry = byPathAndHash.get(key);

      if (!entry) {
        entry = {
          path: manifestPath,
          url: joinUrl(channel.base, file.relative),
          sha1: info.sha1,
          size: info.size,
          channels: new Set(),
        };
        byPathAndHash.set(key, entry);
      }

      if (name) entry.channels.add(name);
      processed += 1;
      if (processed % 100 === 0 || processed === totalFiles) {
        console.error(`\rProcesando ${processed}/${totalFiles} archivos...`);
      }
    }
  }

  if (totalFiles > 0) console.error('');

  const entries = [...byPathAndHash.values()]
    .map((entry) => {
      const output = {
        path: entry.path,
        url: entry.url,
        sha1: entry.sha1,
        size: entry.size,
      };
      if (entry.channels.size > 0) output.channels = [...entry.channels].sort();
      return output;
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.url.localeCompare(b.url));

  const json = JSON.stringify(entries, null, 2);

  if (outputFile) {
    const destination = path.resolve(outputFile);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${json}\n`, 'utf8');
    console.error(`Guardado: ${destination}`);
  }

  if (writeFile) {
    const destination = path.resolve(writeFile);
    let modpack;
    try {
      modpack = JSON.parse(fs.readFileSync(destination, 'utf8'));
    } catch (error) {
      fail(`No se pudo leer ${destination}: ${error.message}`);
    }
    modpack.files = entries;
    fs.writeFileSync(destination, `${JSON.stringify(modpack, null, 2)}\n`, 'utf8');
    console.error(`Actualizado: ${destination} (${entries.length} entradas)`);

    const paths = new Set(entries.map((entry) => entry.path));
    for (const mod of Array.isArray(modpack.mods) ? modpack.mods : []) {
      if (mod.file && !paths.has(mod.file)) {
        console.error(`Aviso: mods[] apunta a "${mod.file}", que no está en files.`);
      }
    }
  }

  if (!outputFile && !writeFile) {
    console.log(json);
  } else {
    console.log(JSON.stringify({ entries: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) }));
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  console.error(`${entries.length} entradas · ${(totalBytes / 1048576).toFixed(1)} MB`);

  if (roots.length === 1 && !rootCache.get(roots[0]).isPackRoot) {
    console.error('Modo antiguo: carpeta tratada como mods/ (solo .jar).');
  }

  for (const root of roots) {
    const links = rootCache.get(root).skippedLinks;
    if (links.length) console.error(`Aviso: ${links.length} enlaces simbólicos ignorados en ${root}.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
