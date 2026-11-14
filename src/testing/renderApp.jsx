// G9 App 스모크용 렌더 헬퍼(REFACTORING_ROADMAP Phase 2 P2-02).
//
//   const app = renderApp({ bridge: makeBridgeStub('standalone'), router, confirm: () => true });
//   await app.findByText('…');
//   app.dialogs.alerts / app.dialogs.confirms   // 웹 alert·confirm 기록(셸이면 bridge.__callsOf('showAlert'))
//
// afterEach에서 resetAppEnvironment()를 부른다(렌더 정리·window.electron 제거·fetch 복원·저장소 비우기).
// 단언은 역할·화면 텍스트로만 한다(클래스명·DOM 스냅샷·내부 훅 mock 금지 — G9 규칙).
import { cleanup, render } from '@testing-library/react';
import AppRoot from '../AppRoot';

const originalFetch = globalThis.fetch;
const originalAlert = window.alert;
const originalConfirm = window.confirm;

/**
 * @param {{ bridge?: object, router?: { fetch: typeof fetch }, confirm?: (msg: string) => boolean }} [options]
 */
export function renderApp({ bridge, router, confirm = () => false } = {}) {
  const dialogs = { alerts: [], confirms: [] };
  if (bridge) window.electron = bridge;
  else delete window.electron;
  globalThis.fetch = router ? router.fetch : () => Promise.reject(new TypeError('renderApp: no fetch router'));
  window.alert = (msg) => { dialogs.alerts.push(String(msg)); };
  window.confirm = (msg) => {
    dialogs.confirms.push(String(msg));
    return confirm(String(msg));
  };
  const utils = render(<AppRoot />);
  return { ...utils, dialogs, bridge, router };
}

export function resetAppEnvironment() {
  cleanup();
  delete window.electron;
  globalThis.fetch = originalFetch;
  window.alert = originalAlert;
  window.confirm = originalConfirm;
  localStorage.clear();
  sessionStorage.clear();
}
