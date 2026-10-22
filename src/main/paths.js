'use strict';

const path = require('node:path');
const { app } = require('electron');

/**
 * Rutas de la aplicación. Todo lo que se descarga vive en userData para no
 * ensuciar la carpeta de instalación (que suele ser de solo lectura).
 */
const paths = {
  get data() {
    return app.getPath('userData');
  },
  get game() {
    return path.join(this.data, 'game');
  },
  get java() {
    return path.join(this.data, 'java');
  },
  get cache() {
    return path.join(this.data, 'cache');
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
};

module.exports = { paths };
