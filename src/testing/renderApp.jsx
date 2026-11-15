// 계정 전환 스모크용 최소 렌더 헬퍼(테스트 전용, 계정 전환 수정 — main의 src/testing/renderApp.jsx를 이 브랜치에 맞게 옮김).
// main.jsx와 같은 트리(StrictMode > AuthProvider > WorkspaceBoundary > App)를 렌더한다.
//
//   const app = renderApp({ router, confirm: () => true });
//   app.dialogs.alerts / app.dialogs.confirms   // 웹 alert·confirm 기록
//
// afterEach에서 resetAppEnvironment()를 부른다(렌더 정리·window.electron 제거·fetch 복원·저장소 비우기).
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import App from '../App';
import { AuthProvider } from '../core/auth/AuthContext';
import { WorkspaceBoundary } from '../app/WorkspaceBoundary';

const originalFetch = globalThis.fetch;
const originalAlert = window.alert;
const originalConfirm = window.confirm;

function AppTree() {
  return (
    <React.StrictMode>
      <AuthProvider>
        <WorkspaceBoundary App={App} />
      </AuthProvider>
    </React.StrictMode>
  );
}

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
  const utils = render(<AppTree />);
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
