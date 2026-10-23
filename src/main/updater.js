'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { autoUpdater } = require('electron-updater');

/**
 * Auto-actualización con electron-updater + GitHub Releases.
 * Descarga en segundo plano el instalador diferencial y lo aplica al reiniciar;
 * los datos de userData (juego, mods, ajustes) se conservan.
 */
class UpdateService extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.started = false;
    this.disabled = process.argv.includes('--no-update') || !app.isPackaged;
    this.state = {
      status: this.disabled ? 'disabled' : 'idle',
      currentVersion: app.getVersion(),
      version: null,
      percent: 0,
      error: null,
    };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  start() {
    if (this.started || this.disabled) return;

    // Sin app-update.yml (builds --dir antiguos) no hay a quién preguntar.
    const configFile = path.join(process.resourcesPath || '', 'app-update.yml');
    if (!fs.existsSync(configFile)) {
      this.disabled = true;
      this.setState({ status: 'disabled' });
      return;
    }

    this.started = true;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableWebInstaller = false;

    autoUpdater.logger = {
      info: (message) => this.emit('log', `[update] ${message}`),
      warn: (message) => this.emit('log', `[update] ${message}`),
      error: (message) => this.emit('log', `[update] ${message}`),
      debug: () => {},
    };

    autoUpdater.on('checking-for-update', () => this.setState({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) =>
      this.setState({ status: 'available', version: info?.version || null, error: null }),
    );
    autoUpdater.on('update-not-available', () =>
      this.setState({ status: 'current', version: null, error: null }),
    );
    autoUpdater.on('download-progress', (progress) =>
      this.setState({ status: 'downloading', percent: Math.round(progress?.percent || 0) }),
    );
    autoUpdater.on('update-downloaded', (info) =>
      this.setState({ status: 'ready', version: info?.version || this.state.version, percent: 100 }),
    );
    autoUpdater.on('error', (error) =>
      this.setState({ status: 'error', error: String(error?.message || error) }),
    );

    setTimeout(() => this.check(), 8000).unref?.();
    this.timer = setInterval(() => this.check(), 30 * 60 * 1000);
    this.timer.unref?.();
  }

  check() {
    if (this.disabled || !this.started) return false;
    this.setState({ status: 'checking', error: null });
    autoUpdater.checkForUpdates().catch((error) => {
      this.setState({ status: 'error', error: String(error?.message || error) });
    });
    return true;
  }

  install() {
    if (this.state.status !== 'ready') return false;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  }

  getState() {
    return this.state;
  }
}

module.exports = { UpdateService };
