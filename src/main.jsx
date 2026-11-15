import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthProvider } from './core/auth/AuthContext';
import { WorkspaceBoundary } from './app/WorkspaceBoundary';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      {/* 작업 공간 경계 — 계정이 바뀌면 App을 다시 띄운다(계정 전환 수정) */}
      <WorkspaceBoundary App={App} />
    </AuthProvider>
  </React.StrictMode>
);
