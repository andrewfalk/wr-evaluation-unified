// preload-intranet.js — intranet build preload
// Exposes only the minimum surface: EMR helper + UI essentials.
// AI direct calls are intentionally absent — the server proxy handles them.
// File-storage (fs*) APIs are absent — data lives on the intranet server.
const { contextBridge, ipcRenderer } = require('electron');

// 메인이 보내는 이벤트를 페이지 콜백에 전달할 때 IpcRendererEvent를 빼고 payload만 넘긴다(HF3). 이벤트 객체의
// sender가 ipcRenderer라, contextBridge로 페이지에 그대로 건네면 페이지가 raw ipcRenderer를 얻는다.
// 반환하는 해제 함수는 같은 리스너를 정확히 제거한다. (샌드박스 preload는 로컬 모듈을 require할 수 없어 인라인.)
function subscribe(channel, callback) {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// ---------------------------------------------------------------------------
// Preload-level origin gate (defence-in-depth, main process gate is primary).
// Origin mismatch → expose empty object. No IPC surface at all.
// The will-navigate / setWindowOpenHandler in main.js prevents external pages
// from loading, so this is a belt-and-suspenders guard.
// ---------------------------------------------------------------------------
const DEFAULT_INTRANET_URL = 'https://wr.hospital.local:8443';
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
    onMenuNew: (callback) => subscribe('menu-new', callback),
    onGotoModule: (callback) => subscribe('goto-module', callback),
    onQuitRequested: (callback) => subscribe('app-quit-requested', callback),
    notifyQuitLogoutDone: () => ipcRenderer.send('quit-logout-done'),

    // PR2 §3 — 통계분석 워크벤치 메뉴 클릭 + 가용성 전파(renderer는 서버 설정을 알고,
    // main은 그걸 모르므로 바뀔 때마다 알려줘야 메뉴를 켜고 끌 수 있다).
    onOpenStatistics: (callback) => subscribe('open-statistics', callback),
    setStatsAvailable: (available) => ipcRenderer.send('set-stats-available', !!available),

    // 미저장 종합소견 편집 draft 여부 — main의 창 닫기/새로고침 가드가 참조한다.
    // PHI 없이 boolean만 전달(환자 ID는 렌더러에만 유지).
    setHasUnsavedDraft: (hasUnsavedDraft) => ipcRenderer.send('set-has-unsaved-draft', hasUnsavedDraft),

    // Native alert/confirm
    showAlert:   (message) => ipcRenderer.invoke('show-alert',   message),
    showConfirm: (message) => ipcRenderer.invoke('show-confirm', message),

    // EMR direct input (C# EmrHelper → IE DOM injection, Windows only)
    injectEMR:           (data)      => ipcRenderer.invoke('emr-inject',              data),
    extractRecord:       (patientNo, injuryDate) => ipcRenderer.invoke('emr-extract-record',       patientNo, injuryDate),
    extractConsultation: ()          => ipcRenderer.invoke('emr-extract-consultation'),

    // Access token bridge — main process stores the token in memory for device audit signing.
    setAccessToken: (token) => ipcRenderer.send('set-access-token', token),

    // Read-only local-data snapshot for one-shot server migration.
    // Main-process gates: build target + origin + access token + native confirm dialog.
    loadLocalMigrationData: () => ipcRenderer.invoke('migration-load-local-data'),

    // Version metadata
    version: {
      app:      ipcRenderer.sendSync('get-app-version'),
      electron: process.versions.electron,
      node:     process.versions.node,
      chrome:   process.versions.chrome,
    },
  });
}
