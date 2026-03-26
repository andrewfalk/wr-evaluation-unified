const { contextBridge, ipcRenderer } = require('electron');

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

  // 구형 프로그램 데이터 임포트
  loadLegacyData: () => ipcRenderer.invoke('load-legacy-data'),

  // 버전 정보 (app.getVersion()은 main process에서 IPC로 전달)
  version: {
    app: ipcRenderer.sendSync('get-app-version'),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }
});
