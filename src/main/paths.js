'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

let gameDirProvider = null;

function isAccessibleDir(dir) {
  try {
    if (!dir || typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rutas de la aplicación. Todo lo que se descarga vive en userData por defecto
 * para no ensuciar la carpeta de instalación (que suele ser de solo lectura).
 */
const paths = {
  get data() {
    return app.getPath('userData');
  },
  get defaultGame() {
    return path.join(this.data, 'game');
  },
  get game() {
    const custom = gameDirProvider ? gameDirProvider() : null;
    if (custom && isAccessibleDir(custom)) return path.resolve(custom);
    return this.defaultGame;
  },
  get java() {
    return path.join(this.data, 'java');
  },
  get cache() {
    return path.join(this.data, 'cache');
  },
  get remoteModpack() {
    return path.join(this.cache, 'modpack.json');
  },
  get remoteModpackMeta() {
    return path.join(this.cache, 'modpack-fetch.json');
  },
  get logs() {
    return path.join(this.data, 'logs');
  },
  get config() {
    return path.join(this.data, 'config.json');
  },
  get state() {
    return path.join(this.data, 'state.json');
  },
  get resources() {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'app-resources')
      : path.join(__dirname, '..', '..', 'resources');
  },
  resource(name) {
    return path.join(this.resources, name);
  },
  setGameDirProvider(provider) {
    gameDirProvider = typeof provider === 'function' ? provider : null;
  },
  isAccessibleDir,
};

module.exports = { paths };
