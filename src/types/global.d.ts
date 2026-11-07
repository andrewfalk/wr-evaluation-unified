// 클라이언트 전역 선언 (REFACTORING_ROADMAP P0-6). tsconfig.client.json·tsconfig.client.js.json 둘 다 포함한다.
//
// window.electron — Electron preload(electron/preload-intranet.js·preload-standalone.js)가 contextBridge로 노출하는
// 브리지. 웹 빌드에서는 없으므로 통째로 optional이고, 두 preload가 서로 다른 키를 노출하므로 키마다 optional이다.
// 키 목록은 G10 골든(electron/__tests__/__goldens__/preload-surface.json)의 두 preload 합집합(34개)과 같아야 한다 —
// preload에 키를 더하거나 빼면 여기도 고친다. 인자·반환 타입은 Phase 3(E 트랙)에서 preload를 TS로 옮길 때 좁힌다.

type Unsubscribe = () => void;
type IpcInvoke = (...args: any[]) => Promise<any>;
type IpcSend = (...args: any[]) => void;
type IpcSubscribe = (listener: (...args: any[]) => void) => Unsubscribe;

interface ElectronBridge {
  // 공통(두 preload)
  platform?: string;
  version?: string;
  onMenuNew?: IpcSubscribe;
  onGotoModule?: IpcSubscribe;
  onOpenStatistics?: IpcSubscribe;
  setStatsAvailable?: IpcSend;
  showAlert?: IpcInvoke;
  showConfirm?: IpcInvoke;
  injectEMR?: IpcInvoke;
  extractRecord?: IpcInvoke;
  extractConsultation?: IpcInvoke;
  // 인트라넷 preload
  loadLocalMigrationData?: IpcInvoke;
  notifyQuitLogoutDone?: IpcSend;
  onQuitRequested?: IpcSubscribe;
  setAccessToken?: IpcSend;
  setHasUnsavedDraft?: IpcSend;
  // 독립형 preload
  analyzeAI?: IpcInvoke;
  loadLegacyData?: IpcInvoke;
  fsClearAutoSave?: IpcInvoke;
  fsDeleteItem?: IpcInvoke;
  fsDeletePatient?: IpcInvoke;
  fsLoadAllPatients?: IpcInvoke;
  fsLoadAutoSave?: IpcInvoke;
  fsLoadCustomPresets?: IpcInvoke;
  fsLoadItems?: IpcInvoke;
  fsLoadPatient?: IpcInvoke;
  fsLoadSettings?: IpcInvoke;
  fsMigrate?: IpcInvoke;
  fsSaveAllPatients?: IpcInvoke;
  fsSaveAutoSave?: IpcInvoke;
  fsSaveCustomPresets?: IpcInvoke;
  fsSaveItem?: IpcInvoke;
  fsSavePatient?: IpcInvoke;
  fsSaveSettings?: IpcInvoke;
}

interface Window {
  electron?: ElectronBridge;
}

/** vite.config.js `define` — 빌드 커밋(WR_GIT_COMMIT 또는 git rev-parse --short HEAD). */
declare const __APP_GIT_COMMIT__: string | undefined;
