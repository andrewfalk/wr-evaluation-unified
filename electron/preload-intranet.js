// preload-intranet.js — intranet build preload
// Exposes only the minimum surface: EMR helper + UI essentials.
// AI direct calls are intentionally absent — the server proxy handles them.
// File-storage (fs*) APIs are absent — data lives on the intranet server.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,

  // Menu events
  onMenuNew: (callback) => {
    ipcRenderer.on('menu-new', callback);
    return () => ipcRenderer.removeListener('menu-new', callback);
  },
  onGotoModule: (callback) => {
    ipcRenderer.on('goto-module', callback);
    return () => ipcRenderer.removeListener('goto-module', callback);
  },

  // Native alert/confirm
  showAlert:   (message) => ipcRenderer.invoke('show-alert',   message),
  showConfirm: (message) => ipcRenderer.invoke('show-confirm', message),

  // EMR direct input (C# EmrHelper → IE DOM injection, Windows only)
  injectEMR:            (data)      => ipcRenderer.invoke('emr-inject',               data),
  extractRecord:        (patientNo) => ipcRenderer.invoke('emr-extract-record',        patientNo),
  extractConsultation:  ()          => ipcRenderer.invoke('emr-extract-consultation'),

  // Version metadata
  version: {
    app:      ipcRenderer.sendSync('get-app-version'),
    electron: process.versions.electron,
    node:     process.versions.node,
    chrome:   process.versions.chrome,
  },
});
