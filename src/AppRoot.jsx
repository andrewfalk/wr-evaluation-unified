import React from 'react';
import App from './App';
import { AuthProvider } from './core/auth/AuthContext';

// 앱 트리의 루트(REFACTORING_ROADMAP Phase 2 P2-02). main.jsx와 G9 App 스모크 테스트(src/App.smoke.test.jsx)가
// 같은 트리를 렌더한다 — Provider 재배치(C3)는 이 파일만 바꾸고 테스트는 AppRoot만 안다.
export default function AppRoot() {
  return (
    <React.StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </React.StrictMode>
  );
}
