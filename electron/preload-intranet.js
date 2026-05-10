// preload-intranet.js — intranet build preload
// Exposes only the minimum surface: EMR helper + UI essentials.
// AI direct calls are intentionally absent — the server proxy handles them.
// File-storage (fs*) APIs are absent — data lives on the intranet server.
const { contextBridge, ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// Preload-level origin gate (defence-in-depth, main process gate is primary).
// Origin mismatch → expose empty object. No IPC surface at all.
// The will-navigate / setWindowOpenHandler in main.js prevents external pages
// from loading, so this is a belt-and-suspenders guard.
// ---------------------------------------------------------------------------
const DEFAULT_INTRANET_URL = 'https://wr.hospital.local';
const INTRANET_URL = (process.env.WR_INTRANET_URL || DEFAULT_INTRANET_URL).trim();
let allowedOrigin = null;
try { allowedOrigin = INTRANET_URL ? new URL(INTRANET_URL).origin : null; } catch { /* invalid URL */ }

const originAllowed = !!allowedOrigin && window.location.origin === allowedOrigin;

if (!originAllowed) {
  contextBridge.exposeInMainWorld('electron', {});
} else {
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
    injectEMR:           (data)      => ipcRenderer.invoke('emr-inject',              data),
    extractRecord:       (patientNo) => ipcRenderer.invoke('emr-extract-record',       patientNo),
    extractConsultation: ()          => ipcRenderer.invoke('emr-extract-consultation'),

    // Access token bridge — main process stores the token in memory for device audit signing.
    setAccessToken: (token) => ipcRenderer.send('set-access-token', token),

    // Version metadata
    version: {
      app:      ipcRenderer.sendSync('get-app-version'),
      electron: process.versions.electron,
      node:     process.versions.node,
      chrome:   process.versions.chrome,
    },
  });
}
