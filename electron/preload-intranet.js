// preload-intranet.js — intranet build preload
// Exposes only the minimum surface: EMR helper + UI essentials.
// AI direct calls are intentionally absent — the server proxy handles them.
// File-storage (fs*) APIs are absent — data lives on the intranet server.
const { contextBridge, ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// Preload-level origin gate (defence-in-depth, main process gate is primary).
// EMR APIs are only bound when the renderer's origin matches WR_INTRANET_URL.
// Mismatched origin → stubs that immediately reject without touching IPC.
// ---------------------------------------------------------------------------
const INTRANET_URL = (process.env.WR_INTRANET_URL || '').trim();
let allowedOrigin = null;
try { allowedOrigin = INTRANET_URL ? new URL(INTRANET_URL).origin : null; } catch { /* invalid URL */ }

const originAllowed = !!allowedOrigin && window.location.origin === allowedOrigin;

const ORIGIN_DENIED = { success: false, error: 'EMR access denied: origin not in whitelist.' };

const emrApis = originAllowed
  ? {
      injectEMR:           (data)      => ipcRenderer.invoke('emr-inject',              data),
      extractRecord:       (patientNo) => ipcRenderer.invoke('emr-extract-record',       patientNo),
      extractConsultation: ()          => ipcRenderer.invoke('emr-extract-consultation'),
    }
  : {
      injectEMR:           ()          => Promise.resolve(ORIGIN_DENIED),
      extractRecord:       ()          => Promise.resolve(ORIGIN_DENIED),
      extractConsultation: ()          => Promise.resolve(ORIGIN_DENIED),
    };

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

  ...emrApis,

  // Version metadata
  version: {
    app:      ipcRenderer.sendSync('get-app-version'),
    electron: process.versions.electron,
    node:     process.versions.node,
    chrome:   process.versions.chrome,
  },
});
