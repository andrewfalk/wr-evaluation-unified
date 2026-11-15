// 작업 공간 경계(계정 전환 수정 AS-4): StrictMode > AuthProvider > WorkspaceBoundary > <App key={workspaceEpoch} …/>.
//
// 계정이 바뀌면(다른 계정 로그인·로그아웃·주인이 있는 목록에서 로컬 전환이나 서버 주소 변경) AuthContext가 작업 공간 세대를
// 올리고, 이 경계가 화면(App)을 그 세대를 key로 다시 띄운다 — 이전 계정의 목록·선택·검색어·열린 창·훅 내부 상태가 통째로
// 사라진다. 설정(useAppSettings)과 인증 갱신 배선(useAuthSync)은 재마운트를 넘어 유지돼야 해서 여기서 호스팅한다:
//  - 운영 인트라넷 빌드는 설정을 읽을 때 항상 인트라넷으로 덮으므로(storage.js loadSettings) "로컬 모드로 전환"은 메모리
//    상태로만 유지된다 — App 안에 두면 재마운트로 되돌아간다.
//  - 401 refresh 처리기가 재마운트 중에도 같은 세션 상태를 본다.
import type { ComponentType } from 'react';
import { useAuth } from '../core/auth/AuthContext';
import { useAuthSync } from '../core/hooks/useAuthSync';
import { useAppSettings } from '../core/hooks/useAppSettings';

type AppSettings = Record<string, unknown>;

export interface WorkspaceAppProps {
  settings: AppSettings;
  handleSaveSettings: (next: AppSettings) => void;
  switchToLocalMode: () => void;
}

// AuthContext.jsx는 아직 JS(컨텍스트 값의 타입 추론이 없다) — 경계가 쓰는 만큼만 계약으로 둔다.
interface AuthForBoundary {
  session: unknown;
  setSession: (next: unknown) => unknown;
  resetToLocalSession: () => unknown;
  getAuthEpoch: () => number;
  getSession: () => unknown;
  invalidateAuthContext: () => void;
  discardWorkspace: () => void;
  workspaceEpoch: number;
}

interface AppSettingsApi {
  settings: AppSettings;
  handleSaveSettings: (next: AppSettings) => void;
  switchToLocalMode: () => void;
}

export function WorkspaceBoundary({ App }: { App: ComponentType<WorkspaceAppProps> }) {
  const auth = useAuth() as unknown as AuthForBoundary;
  const { session, setSession, resetToLocalSession, getAuthEpoch, getSession, invalidateAuthContext, discardWorkspace } = auth;
  const { settings, handleSaveSettings, switchToLocalMode } = (useAppSettings as unknown as (args: object) => AppSettingsApi)({
    session, setSession, resetToLocalSession, invalidateAuthContext, discardWorkspace,
  });
  (useAuthSync as unknown as (args: object) => void)({ session, setSession, resetToLocalSession, getAuthEpoch, getSession });
  return (
    <App
      key={auth.workspaceEpoch}
      settings={settings}
      handleSaveSettings={handleSaveSettings}
      switchToLocalMode={switchToLocalMode}
    />
  );
}
