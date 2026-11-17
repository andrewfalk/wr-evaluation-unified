import React from 'react';
import App from './app/App';
import { AuthProvider } from './core/auth/AuthContext';
import { WorkspaceBoundary } from './app/WorkspaceBoundary';

// 앱 트리의 루트(REFACTORING_ROADMAP Phase 2 P2-02). main.jsx와 G9 App 스모크 테스트(src/App.smoke.test.jsx)가
// 같은 트리를 렌더한다 — Provider 재배치(C3)는 이 파일만 바꾸고 테스트는 AppRoot만 안다.
// 작업 공간 경계(src/app/WorkspaceBoundary)가 계정이 바뀌면 App을 다시 띄운다(계정 전환 수정 AS-4).
export default function AppRoot() {
  return (
    <React.StrictMode>
      <AuthProvider>
        <WorkspaceBoundary App={App} />
      </AuthProvider>
    </React.StrictMode>
  );
}
