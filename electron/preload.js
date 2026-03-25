const { contextBridge, ipcRenderer } = require('electron');
const pkg = require('../package.json');

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,

  // 메뉴 이벤트
  onMenuNew: (callback) => ipcRenderer.on('menu-new', callback),
  onGotoModule: (callback) => ipcRenderer.on('goto-module', callback),

  // native alert/confirm
  showAlert: (message) => ipcRenderer.invoke('show-alert', message),
  showConfirm: (message) => ipcRenderer.invoke('show-confirm', message),

  // AI 분석 (Electron 전용)
  analyzeAI: (data) => ipcRenderer.invoke('analyze-ai', data),

  // 버전 정보
  version: {
    app: pkg.version,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }
});
