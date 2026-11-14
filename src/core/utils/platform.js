// 호환 shim(REFACTORING_ROADMAP Phase 2 C1, P2-10) — 구현은 src/platform/(dialogs.ts·bridge.ts)로 옮겼다.
// 기존 import(showAlert 55곳·showConfirm 24곳·isElectron 2곳)를 깨지 않기 위해 남겨 두며 P2-100에서 삭제한다.
// 새 코드는 '../../platform/dialogs'·'../../platform/bridge'를 직접 import한다.
export { showAlert, showConfirm } from '../../platform/dialogs';
export { hasBridge as isElectron } from '../../platform/bridge';
