'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('launcher', {
  // Datos iniciales
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),

  // Ajustes y perfiles
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  addProfile: (name) => ipcRenderer.invoke('profiles:add', name),
  removeProfile: (id) => ipcRenderer.invoke('profiles:remove', id),
  selectProfile: (id) => ipcRenderer.invoke('profiles:select', id),

  // Entorno
  detectJava: (explicitPath) => ipcRenderer.invoke('java:detect', explicitPath),
  serverStatus: () => ipcRenderer.invoke('server:status'),
  pickJava: () => ipcRenderer.invoke('dialog:pick-java'),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),

  // Juego
  launch: () => ipcRenderer.invoke('launch:start'),
  cancel: () => ipcRenderer.invoke('launch:cancel'),
  logs: () => ipcRenderer.invoke('logs:get'),

  // Sistema
  open: (target) => ipcRenderer.invoke('shell:open', target),
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  hideWindow: () => ipcRenderer.send('window:hide'),
  closeWindow: () => ipcRenderer.send('window:close'),

  // Eventos
  onStatus: (callback) => subscribe('launch:status', callback),
  onProgress: (callback) => subscribe('launch:progress', callback),
  onLog: (callback) => subscribe('launch:log', callback),
  onReady: (callback) => subscribe('launch:ready', callback),
  onExit: (callback) => subscribe('launch:exit', callback),
  onError: (callback) => subscribe('launch:error', callback),
  onCancelled: (callback) => subscribe('launch:cancelled', callback),
});
