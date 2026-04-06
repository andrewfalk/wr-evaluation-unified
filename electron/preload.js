const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,

  // 메뉴 이벤트
  onMenuNew: (callback) => {
    ipcRenderer.on('menu-new', callback);
    return () => ipcRenderer.removeListener('menu-new', callback);
  },
  onGotoModule: (callback) => {
    ipcRenderer.on('goto-module', callback);
    return () => ipcRenderer.removeListener('goto-module', callback);
  },

  // native alert/confirm
  showAlert: (message) => ipcRenderer.invoke('show-alert', message),
  showConfirm: (message) => ipcRenderer.invoke('show-confirm', message),

  // AI 분석 (Electron 전용)
  analyzeAI: (data) => ipcRenderer.invoke('analyze-ai', data),

  // 구형 프로그램 데이터 임포트
  loadLegacyData: () => ipcRenderer.invoke('load-legacy-data'),

  // 파일 기반 저장소 API
  fsLoadAllPatients: () => ipcRenderer.invoke('fs-load-all-patients'),
  fsLoadPatient: (id) => ipcRenderer.invoke('fs-load-patient', id),
  fsSavePatient: (patient) => ipcRenderer.invoke('fs-save-patient', patient),
  fsDeletePatient: (id) => ipcRenderer.invoke('fs-delete-patient', id),
  fsSaveAllPatients: (patients) => ipcRenderer.invoke('fs-save-all-patients', patients),
  fsLoadItems: () => ipcRenderer.invoke('fs-load-items'),
  fsSaveItem: (item) => ipcRenderer.invoke('fs-save-item', item),
  fsDeleteItem: (id) => ipcRenderer.invoke('fs-delete-item', id),
  fsSaveAutoSave: (data) => ipcRenderer.invoke('fs-save-autosave', data),
  fsLoadAutoSave: () => ipcRenderer.invoke('fs-load-autosave'),
  fsClearAutoSave: () => ipcRenderer.invoke('fs-clear-autosave'),
  fsSaveSettings: (settings) => ipcRenderer.invoke('fs-save-settings', settings),
  fsLoadSettings: () => ipcRenderer.invoke('fs-load-settings'),
  fsMigrate: (data) => ipcRenderer.invoke('fs-migrate', data),

  // EMR 직접입력 (PowerShell → IE DOM 주입, Windows 전용)
  injectEMR: (data) => ipcRenderer.invoke('emr-inject', data),

  // 버전 정보 (app.getVersion()은 main process에서 IPC로 전달)
  version: {
    app: ipcRenderer.sendSync('get-app-version'),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }
});
