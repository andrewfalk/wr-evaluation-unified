const { contextBridge, ipcRenderer } = require('electron');

// 메인이 보내는 이벤트를 페이지 콜백에 전달할 때 IpcRendererEvent를 빼고 payload만 넘긴다(HF3). 이벤트 객체의
// sender가 ipcRenderer라, contextBridge로 페이지에 그대로 건네면 페이지가 raw ipcRenderer를 얻는다.
// 반환하는 해제 함수는 같은 리스너를 정확히 제거한다. (샌드박스 preload는 로컬 모듈을 require할 수 없어 인라인.)
function subscribe(channel, callback) {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,

  // 메뉴 이벤트
  onMenuNew: (callback) => subscribe('menu-new', callback),
  onGotoModule: (callback) => subscribe('goto-module', callback),
  // PR2 §3 — 통계분석 워크벤치(인트라넷 전용 기능이라 standalone에서는 항상 false지만,
  // 채널 자체는 노출해 App.jsx가 빌드 종류를 분기하지 않게 한다).
  onOpenStatistics: (callback) => subscribe('open-statistics', callback),
  setStatsAvailable: (available) => ipcRenderer.send('set-stats-available', !!available),

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
  fsLoadCustomPresets: () => ipcRenderer.invoke('fs-load-custom-presets'),
  fsSaveCustomPresets: (presets) => ipcRenderer.invoke('fs-save-custom-presets', presets),
  fsMigrate: (data) => ipcRenderer.invoke('fs-migrate', data),

  // EMR 직접입력 (C# EmrHelper → IE DOM 주입, Windows 전용)
  injectEMR: (data) => ipcRenderer.invoke('emr-inject', data),

  // EMR 데이터 추출 (진료기록분석지 → 환자 데이터)
  extractRecord: (patientNo, injuryDate) => ipcRenderer.invoke('emr-extract-record', patientNo, injuryDate),

  // 다학제회신 추출 (진료메인 → 과별 회신)
  extractConsultation: () => ipcRenderer.invoke('emr-extract-consultation'),

  // 버전 정보 (app.getVersion()은 main process에서 IPC로 전달)
  version: {
    app: ipcRenderer.sendSync('get-app-version'),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }
});
