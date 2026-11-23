'use strict';

/**
 * Genera las entradas `files` de resources/modpack.json a partir de una o varias
 * carpetas de pack (.minecraft).
 *
 * Forma recomendada para dos canales independientes:
 *
 *   node scripts/generate-manifest.js --completa ./pack-sources/COMPLETA --lite ./pack-sources/LITE --base-url https://cdn.ejemplo.com --write resources/modpack.json
 *
 * También puedes usar:
 *
 *   npm run manifest:packs -- --base-url https://cdn.ejemplo.com
 *
 * o forma explícita por canal:
 *
 *   node scripts/generate-manifest.js ^
 *     --channel COMPLETA "C:\packs\completa" "https://cdn.../COMPLETA" ^
 *     --channel LITE "C:\packs\lite" "https://cdn.../LITE" ^
 *     --write resources/modpack.json
 *
 * Opciones:
 *   --completa <carpeta> [url]  Carpeta fuente del canal COMPLETA.
 *   --lite <carpeta> [url]      Carpeta fuente del canal LITE.
 *   --pruebas <carpeta> [url]   Carpeta fuente del canal PRUEBAS.
 *   --base-url <url>            URL base para construir <url>/<CANAL>.
 *   --completa-url <url>        URL base específica para COMPLETA.
 *   --lite-url <url>            URL base específica para LITE.
 *   --pruebas-url <url>         URL base específica para PRUEBAS.
 *   --skip-missing              Omite carpetas de canal que aún no existan en disco.
 *   --release-url <url>         URL base plana de GitHub Release (ej. .../releases/download/modpack-assets).
 *   --release-dir <carpeta>     Carpeta local con assets renombrados (por defecto: ./pack-sources/release-upload).
 *   --write <archivo>           Sustituye `files` en ese modpack.json.
 *   --revision <n>              Ajusta `revision` al escribir (súbelo en cada cambio remoto).
 *   --output <archivo>          Guarda el array JSON en un archivo.
 *   --options / --no-options    Incluye o excluye options.txt (incluido por defecto en modo dual).
 *   --exclude <glob>            Excluye rutas que coincidan (repetible).
 *
 * Carpetas incluidas: mods, config, defaultconfigs, kubejs, tacz, scripts,
 * resourcepacks y shaderpacks (además de options.txt en la raíz si aplica).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const INDIVIDUAL_DIRS = [
  'mods',
  'resourcepacks',
  'shaderpacks',
];

const BUNDLE_DIRS = [
  'config',
  'defaultconfigs',
  'kubejs',
  'tacz',
  'scripts',
];

const PACK_DIRS = [
  ...INDIVIDUAL_DIRS,
  ...BUNDLE_DIRS,
];

const DETERMINISTIC_ZIP_TIME = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

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

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function readModpackDefaults(writeFile) {
  const candidates = [];
  if (writeFile) candidates.push(path.resolve(writeFile));
  candidates.push(path.resolve('resources', 'modpack.json'));

  for (const file of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object') return data;
    } catch {
      /* archivo inexistente o inválido */
    }
  }
  return null;
}

function resolveChannelBaseUrl(channelName, explicitUrl, sharedBaseUrl, modpackDefaults) {
  if (explicitUrl) return explicitUrl.replace(/\/+$/, '');

  const channelSuffix = channelName || 'PACK';

  if (sharedBaseUrl) {
    return `${sharedBaseUrl.replace(/\/+$/, '')}/${channelSuffix}`;
  }

  const channelConfigUrl = modpackDefaults?.channels?.[channelSuffix]?.baseUrl;
  if (isHttpUrl(channelConfigUrl)) return channelConfigUrl.replace(/\/+$/, '');

  if (isHttpUrl(modpackDefaults?.baseUrl)) {
    return `${modpackDefaults.baseUrl.replace(/\/+$/, '')}/${channelSuffix}`;
  }

  if (isHttpUrl(modpackDefaults?.manifestUrl)) {
    try {
      const dirUrl = new URL('.', modpackDefaults.manifestUrl).toString().replace(/\/+$/, '');
      return `${dirUrl}/${channelSuffix}`;
    } catch {
      /* manifestUrl inválida */
    }
  }

  if (isHttpUrl(process.env.MODPACK_BASE_URL)) {
    return `${process.env.MODPACK_BASE_URL.replace(/\/+$/, '')}/${channelSuffix}`;
  }

  return null;
}

const CHANNEL_ARG_MAP = {
  '--completa': 'COMPLETA',
  '--lite': 'LITE',
  '--pruebas': 'PRUEBAS',
};

const CHANNEL_URL_ARG_MAP = {
  '--completa-url': 'COMPLETA',
  '--lite-url': 'LITE',
  '--pruebas-url': 'PRUEBAS',
};

const AUTO_CHANNELS = ['COMPLETA', 'LITE', 'PRUEBAS'];

function parseArgs(argv) {
  let channels = [];
  let folder = null;
  let baseUrl = null;
  let sharedBaseUrl = null;
  let releaseUrl = null;
  let releaseDir = null;
  const channelUrls = {};
  let positionalChannels = [];
  let writeFile = null;
  let outputFile = null;
  let revision = null;
  let includeOptions = null;
  let dualMode = false;
  let skipMissing = false;
  let explicitChannelArg = false;
  const excludes = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--channel') {
      const name = argv[i + 1];
      const root = argv[i + 2];
      const base = argv[i + 3];
      if (!name || !root || !base) fail('--channel necesita <nombre> <carpeta> <urlBase>');
      channels.push({ name, root, base });
      explicitChannelArg = true;
      i += 3;
    } else if (arg in CHANNEL_ARG_MAP) {
      const name = CHANNEL_ARG_MAP[arg];
      const root = argv[++i];
      if (!root) fail(`${arg} necesita <carpeta>`);
      let explicitBase = null;
      if (isHttpUrl(argv[i + 1])) {
        explicitBase = argv[++i];
      }
      channels.push({ name, root, base: explicitBase });
      dualMode = true;
      explicitChannelArg = true;
    } else if (arg === '--base-url') {
      sharedBaseUrl = argv[++i];
      if (!isHttpUrl(sharedBaseUrl)) fail('--base-url necesita una URL http(s) válida');
    } else if (arg in CHANNEL_URL_ARG_MAP) {
      const channelName = CHANNEL_URL_ARG_MAP[arg];
      channelUrls[channelName] = argv[++i];
      if (!isHttpUrl(channelUrls[channelName])) fail(`${arg} necesita una URL http(s) válida`);
    } else if (arg === '--skip-missing') {
      skipMissing = true;
    } else if (arg === '--release-url') {
      releaseUrl = argv[++i];
      if (!isHttpUrl(releaseUrl)) fail('--release-url necesita una URL http(s) válida');
    } else if (arg === '--release-dir') {
      releaseDir = argv[++i];
      if (!releaseDir) fail('--release-dir necesita una carpeta');
    } else if (arg === '--write') {
      writeFile = argv[++i];
      if (!writeFile) fail('--write necesita un archivo');
    } else if (arg === '--revision') {
      revision = Number(argv[++i]);
      if (!Number.isInteger(revision) || revision < 1) fail('--revision necesita un entero positivo');
    } else if (arg === '--output') {
      outputFile = argv[++i];
      if (!outputFile) fail('--output necesita un archivo');
    } else if (arg === '--options') {
      includeOptions = true;
    } else if (arg === '--no-options') {
      includeOptions = false;
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

  if (channels.length === 0 && !folder && !baseUrl) {
    for (const name of AUTO_CHANNELS) {
      const candidate = path.resolve('pack-sources', name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        channels.push({ name, root: candidate, base: null });
        dualMode = true;
      }
    }
  }

  if (skipMissing && channels.length > 0) {
    channels = channels.filter((channel) => {
      const resolved = path.resolve(channel.root);
      const exists = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
      if (!exists) {
        console.error(`Aviso: carpeta omitida para ${normalizeChannel(channel.name) || channel.root} (no existe: ${resolved}).`);
      }
      return exists;
    });
  }

  if (channels.length === 0 && !(skipMissing && (explicitChannelArg || releaseUrl || writeFile))) {
    fail(
      'Uso: node scripts/generate-manifest.js --completa <carpeta> --lite <carpeta> [--pruebas <carpeta>] [--base-url <url> | --release-url <url>] [--write resources/modpack.json]\n' +
      '  o: node scripts/generate-manifest.js <carpeta> <urlBase> [canal...]\n' +
      '  o: node scripts/generate-manifest.js --channel COMPLETA <carpeta> <urlBase> ...',
    );
  }

  if (revision !== null && !writeFile) {
    fail('--revision solo tiene sentido junto con --write');
  }

  if (releaseDir && !releaseUrl) {
    fail('--release-dir solo puede usarse junto con --release-url');
  }

  const normalizedReleaseUrl = releaseUrl ? releaseUrl.replace(/\/+$/, '') : null;
  const resolvedReleaseDir = normalizedReleaseUrl
    ? path.resolve(releaseDir || path.join('pack-sources', 'release-upload'))
    : null;

  const modpackDefaults = readModpackDefaults(writeFile);
  const placeholderChannels = [];

  if (normalizedReleaseUrl) {
    for (const channel of channels) {
      channel.base = normalizedReleaseUrl;
    }
  } else {
    for (const channel of channels) {
      const normalizedName = normalizeChannel(channel.name);
      const explicit = channel.base || (normalizedName ? channelUrls[normalizedName] : null);
      const resolved = resolveChannelBaseUrl(normalizedName, explicit, sharedBaseUrl, modpackDefaults);
      if (resolved) {
        channel.base = resolved;
      } else {
        const label = normalizedName || 'PACK';
        channel.base = `https://cdn.local/${label}`;
        placeholderChannels.push(label);
      }
    }

    if (placeholderChannels.length > 0) {
      console.error(
        `Aviso: sin --base-url ni URL base en modpack.json; usando URL provisional https://cdn.local/<CANAL> para ${placeholderChannels.join(', ')}.`,
      );
    }
  }

  return {
    channels,
    releaseUrl: normalizedReleaseUrl,
    releaseDir: resolvedReleaseDir,
    writeFile,
    outputFile,
    revision,
    includeOptions: includeOptions ?? dualMode,
    excludes,
  };
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

function hasPackStructure(dir, includeOptions) {
  if (PACK_DIRS.some((sub) => fs.existsSync(path.join(dir, sub)))) return true;
  return Boolean(includeOptions && fs.existsSync(path.join(dir, 'options.txt')));
}

function collectRoot(root, includeOptions, excludes) {
  const absolute = path.resolve(root);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    fail(`La carpeta no existe: ${absolute}`);
  }

  let base = absolute;
  let isPackRoot = hasPackStructure(base, includeOptions);

  // Muchos packs vienen dentro de una carpeta .minecraft.
  const nested = path.join(absolute, '.minecraft');
  if (!isPackRoot && fs.existsSync(nested) && hasPackStructure(nested, includeOptions)) {
    base = nested;
    isPackRoot = true;
  }

  const files = [];
  const bundleFiles = [];
  const skippedLinks = [];

  if (isPackRoot) {
    for (const dir of INDIVIDUAL_DIRS) {
      const full = path.join(base, dir);
      if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) continue;
      walkAll(full, base, excludes, files, skippedLinks);
    }

    for (const dir of BUNDLE_DIRS) {
      const full = path.join(base, dir);
      if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) continue;
      walkAll(full, base, excludes, bundleFiles, skippedLinks);
    }

    if (includeOptions) {
      const options = path.join(base, 'options.txt');
      if (fs.existsSync(options) && fs.statSync(options).isFile()) {
        files.push({ full: options, relative: 'options.txt', preserve: true });
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

  return { files, bundleFiles, skippedLinks, isPackRoot, base };
}

function buildDeterministicBundle(bundleFiles, destZipPath) {
  const sorted = [...bundleFiles].sort((a, b) => (
    a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0
  ));
  const zip = new AdmZip();

  for (const file of sorted) {
    const entryPath = file.relative.replace(/\\/g, '/');
    zip.addFile(entryPath, fs.readFileSync(file.full));
  }

  for (const entry of zip.getEntries()) {
    entry.header.time = DETERMINISTIC_ZIP_TIME;
  }

  fs.mkdirSync(path.dirname(destZipPath), { recursive: true });
  zip.writeZip(destZipPath);
}

function channelPrefix(channels) {
  if (Array.isArray(channels) && channels.length === 1) {
    const clean = String(channels[0]).toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
    return `${clean || 'pack'}__`;
  }
  return 'shared__';
}

function toFlatAssetName(prefix, relativePath, sha1, usedNames) {
  const safePath = String(relativePath)
    .replace(/[\\/]+/g, '__')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '') || 'file';

  const baseName = `${prefix}${safePath}`;
  let candidate = baseName;

  if (candidate.toLowerCase() === 'modpack.json' || usedNames.has(candidate.toLowerCase())) {
    const ext = path.posix.extname(baseName);
    const stem = ext ? baseName.slice(0, -ext.length) : baseName;
    const shortHash = String(sha1 || '').slice(0, 8) || '00000000';
    candidate = `${stem}_${shortHash}${ext}`;
    let suffix = 2;
    while (candidate.toLowerCase() === 'modpack.json' || usedNames.has(candidate.toLowerCase())) {
      candidate = `${stem}_${shortHash}_${suffix}${ext}`;
      suffix += 1;
    }
  }

  usedNames.add(candidate.toLowerCase());
  return candidate;
}

async function main() {
  const { channels, releaseUrl, releaseDir, writeFile, outputFile, revision, includeOptions, excludes } = parseArgs(process.argv.slice(2));
  const excludeRegexes = excludes.map(globToRegExp);
  const roots = [...new Set(channels.map((channel) => path.resolve(channel.root)))];
  const rootCache = new Map();

  if (releaseDir) {
    if (releaseDir === path.resolve('.') || releaseDir === path.parse(releaseDir).root) {
      fail(`--release-dir apunta a una carpeta protegida: ${releaseDir}`);
    }
    if (roots.some((root) => releaseDir === root || releaseDir.startsWith(`${root}${path.sep}`))) {
      fail(`--release-dir no puede estar dentro de una carpeta fuente (${releaseDir})`);
    }
  }

  const tempBundlesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chernobyl-bundles-'));

  try {
    let bundleIdx = 0;
    for (const root of roots) {
      const collected = collectRoot(root, includeOptions, excludeRegexes);
      if (collected.bundleFiles.length > 0) {
        bundleIdx += 1;
        const bundleZip = path.join(tempBundlesDir, `bundle-${bundleIdx}.zip`);
        console.error(`Empaquetando datos/configs de ${path.basename(root)} (${collected.bundleFiles.length} archivos)...`);
        buildDeterministicBundle(collected.bundleFiles, bundleZip);
        collected.files.push({
          full: bundleZip,
          relative: 'bundle.zip',
          manifestPath: 'bundle.zip',
          extract: true,
        });
      }
      rootCache.set(root, collected);
    }

    const byPathAndHash = new Map();
    const fileCache = new Map();
    let processed = 0;
    let totalFiles = 0;
    for (const root of roots) totalFiles += rootCache.get(root).files.length;

    for (const channel of channels) {
      const name = normalizeChannel(channel.name);
      const root = rootCache.get(path.resolve(channel.root));
      const origin = releaseUrl
        ? releaseUrl
        : `${path.resolve(channel.root)}\0${channel.base.replace(/\/+$/, '')}`;

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
            url: releaseUrl ? '' : joinUrl(channel.base, file.relative),
            sha1: info.sha1,
            size: info.size,
            extract: Boolean(file.extract),
            preserve: Boolean(file.preserve),
            channels: new Set(),
            sourceFile: file.full,
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

    const sourceByEntry = new WeakMap();
    const entries = [...byPathAndHash.values()]
      .map((entry) => {
        const output = {
          path: entry.path,
          url: entry.url,
          sha1: entry.sha1,
          size: entry.size,
        };
        if (entry.extract) output.extract = true;
        if (entry.preserve) output.preserve = true;
        if (entry.channels.size > 0) output.channels = [...entry.channels].sort();
        sourceByEntry.set(output, entry.sourceFile);
        return output;
      })
      .sort((a, b) => (
        a.path.localeCompare(b.path)
        || (a.channels?.join(',') || '').localeCompare(b.channels?.join(',') || '')
        || a.url.localeCompare(b.url)
      ));

    const duplicateErrors = [];
    const duplicateWarnings = [];
    const grouped = new Map();

    for (const entry of entries) {
      const group = grouped.get(entry.path) || [];
      group.push(entry);
      grouped.set(entry.path, group);
    }

    for (const [relative, group] of grouped) {
      if (group.length < 2) continue;

      const overlaps = [];
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const a = group[i];
          const b = group[j];
          const aAll = !Array.isArray(a.channels) || a.channels.length === 0;
          const bAll = !Array.isArray(b.channels) || b.channels.length === 0;
          const shared = aAll || bAll
            || (Array.isArray(a.channels) && Array.isArray(b.channels) && a.channels.some((channel) => b.channels.includes(channel)));
          if (shared) overlaps.push({ a, b });
        }
      }

      if (overlaps.length === 0) continue;

      const uniqueHashes = new Set(group.map((entry) => entry.sha1)).size;
      const labels = group
        .map((entry) => `(${entry.channels?.length ? entry.channels.join('+') : 'todos los canales'})`)
        .join(' vs ');

      if (uniqueHashes > 1) {
        duplicateErrors.push(`${relative}: contenido distinto para ${labels}. Los dos se descargarían con la misma ruta; separa los canales.`);
      } else {
        duplicateWarnings.push(`${relative}: ${overlaps.length > 1 ? 'varias entradas' : 'dos entradas'} idénticas para ${labels}; elimina la duplicada.`);
      }
    }

    for (const warning of duplicateWarnings) console.error(`Aviso: ${warning}`);
    for (const message of duplicateErrors) console.error(`ERROR: ${message}`);
    if (duplicateErrors.length > 0) {
      fail('Manifiesto no generado: hay rutas duplicadas con contenido distinto para canales solapados.');
    }

    const assetByEntry = new Map();
    if (releaseUrl) {
      const usedNames = new Set();
      for (const entry of entries) {
        const prefix = channelPrefix(entry.channels || []);
        const assetName = toFlatAssetName(prefix, entry.path, entry.sha1, usedNames);
        entry.url = `${releaseUrl}/${assetName}`;
        assetByEntry.set(entry, assetName);
      }
    }

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
      if (revision !== null) modpack.revision = revision;
      modpack.files = entries;
      fs.writeFileSync(destination, `${JSON.stringify(modpack, null, 2)}\n`, 'utf8');
      console.error(`Actualizado: ${destination} (${entries.length} entradas)`);
      if (Number.isInteger(modpack.revision)) {
        console.error(`Revisión del manifiesto: ${modpack.revision}`);
      } else {
        console.error('Aviso: el manifiesto no tiene "revision"; usa --revision <n> para el manifiesto remoto.');
      }

      const paths = new Set(entries.map((entry) => entry.path));
      for (const mod of Array.isArray(modpack.mods) ? modpack.mods : []) {
        if (mod.file && !paths.has(mod.file)) {
          console.error(`Aviso: mods[] apunta a "${mod.file}", que no está en files.`);
        }
      }
    }

    if (releaseDir) {
      fs.rmSync(releaseDir, { recursive: true, force: true });
      fs.mkdirSync(releaseDir, { recursive: true });
      for (const entry of entries) {
        const assetName = assetByEntry.get(entry);
        const sourceFile = sourceByEntry.get(entry);
        fs.copyFileSync(sourceFile, path.join(releaseDir, assetName));
      }
      if (writeFile) {
        fs.copyFileSync(path.resolve(writeFile), path.join(releaseDir, 'modpack.json'));
      }
      const totalAssets = entries.length + (writeFile ? 1 : 0);
      const rawRelative = (path.relative(process.cwd(), releaseDir) || releaseDir).replace(/\\/g, '/');
      const displayDir = rawRelative.startsWith('.') ? rawRelative : `./${rawRelative}`;
      console.error(`Carpeta de release preparada: ${releaseDir} (${totalAssets} archivos)`);
      console.error(`Súbelos con: gh release upload modpack-assets ${displayDir}/* --clobber`);
    }

    if (!outputFile && !writeFile) {
      console.log(json);
    } else {
      console.log(JSON.stringify({ entries: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) }));
    }

    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    console.error(`${entries.length} entradas · ${(totalBytes / 1048576).toFixed(2)} MB`);
    const channelNames = [...new Set(channels.map((channel) => normalizeChannel(channel.name)).filter(Boolean))];
    printChannelSummary(entries, channelNames);

    if (roots.length === 1 && rootCache.get(roots[0]).files.length > 0 && !rootCache.get(roots[0]).isPackRoot) {
      console.error('Modo antiguo: carpeta tratada como mods/ (solo .jar).');
    }

    for (const root of roots) {
      const links = rootCache.get(root).skippedLinks;
      if (links.length) console.error(`Aviso: ${links.length} enlaces simbólicos ignorados en ${root}.`);
    }
  } finally {
    fs.rmSync(tempBundlesDir, { recursive: true, force: true });
  }
}

function formatMb(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function printChannelSummary(entries, channelNames) {
  const names = channelNames.length ? channelNames : ['TODOS'];
  console.error('Resumen por canal:');
  for (const name of names) {
    const channelEntries = name === 'TODOS'
      ? entries
      : entries.filter((entry) => !Array.isArray(entry.channels) || entry.channels.includes(name));

    let modsCount = 0;
    let modsBytes = 0;
    let otherCount = 0;
    let otherBytes = 0;

    for (const entry of channelEntries) {
      const size = Number(entry.size) || 0;
      if (String(entry.path).startsWith('mods/')) {
        modsCount += 1;
        modsBytes += size;
      } else {
        otherCount += 1;
        otherBytes += size;
      }
    }

    const totalCount = modsCount + otherCount;
    const totalBytes = modsBytes + otherBytes;
    console.error(
      `  ${name}: ${totalCount} archivos · ${formatMb(totalBytes)} ` +
      `(mods: ${modsCount} · ${formatMb(modsBytes)} | config/otros: ${otherCount} · ${formatMb(otherBytes)})`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
