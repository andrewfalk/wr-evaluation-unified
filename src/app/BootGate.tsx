// 인트라넷 부팅 게이트 — REFACTORING_ROADMAP Phase 2 C3-A(P2-25). App.jsx의 부팅 렌더 분기를 **조건 순서 그대로** 옮겼다
// (렌더만 — 상태·effect는 App에 그대로). 순서가 곧 의미다:
//   ① 서버 설정 불러오는 중 → ② 설정 실패 → ③ 저장된 세션 확인 중 → ④ 로그인 필요 → ⑤ 비밀번호 변경 필요.
// 모든 화면 아래에 "로컬 모드로 전환" 탈출구를 붙인다(withLocalEscape — 부팅 중 서버 목록 로딩 화면도 같이 쓴다).
// 동작 기준: G9b(src/App.smoke.test.jsx) — 연결 중 → 로그인 / 세션 확인 → 목록 / config 실패 / mustChangePassword.
import type { ReactNode } from 'react';
import { LoginModal } from '../core/components/LoginModal';
import { ChangePasswordModal } from '../core/components/ChangePasswordModal';
import { SwitchToLocalButton } from '../core/components/SwitchToLocalButton';
import { hasIntranetSession, resolveApiBaseUrl, type SessionLike, type SettingsLike } from '../platform/dataMode';

export function withLocalEscape(content: ReactNode, onSwitchToLocal: () => void): ReactNode {
  return (
    <>
      {content}
      <div className="app-boot-escape-hatch">
        <SwitchToLocalButton onSwitch={onSwitchToLocal} />
      </div>
    </>
  );
}

export interface BootGateInput {
  isIntranetMode: boolean;
  configLoading: boolean;
  configError: string | null | undefined;
  session: (SessionLike & { user?: { mustChangePassword?: boolean } | null }) | null | undefined;
  settings: SettingsLike | null | undefined;
  sessionVerified: boolean;
  isAuthenticated: boolean;
  onSwitchToLocal: () => void;
}

/** 부팅 게이트에 걸리면 그 화면, 아니면 null(앱 본문으로 진행). */
export function renderBootGate({
  isIntranetMode, configLoading, configError, session, settings, sessionVerified, isAuthenticated, onSwitchToLocal,
}: BootGateInput): ReactNode | null {
  if (!isIntranetMode) return null;

  if (configLoading) {
    return withLocalEscape(
      <div className="app-boot-overlay">
        <div className="app-boot-box">
          <p>서버에 연결 중입니다…</p>
        </div>
      </div>,
      onSwitchToLocal,
    );
  }

  if (configError) {
    const serverUrl = resolveApiBaseUrl({ session, settings });
    return withLocalEscape(
      <div className="app-boot-overlay">
        <div className="app-boot-box app-boot-error">
          <h2>서버 연결 실패</h2>
          <p>{configError}</p>
          <p className="app-boot-hint">
            인트라넷 서버({serverUrl})에 연결할 수 없습니다.<br />
            서버 상태를 확인하거나 관리자에게 문의하세요.
          </p>
          <button
            className="btn btn-secondary"
            onClick={() => window.location.reload()}
          >
            다시 시도
          </button>
        </div>
      </div>,
      onSwitchToLocal,
    );
  }

  // 저장된 인트라넷 세션을 부팅 시 확인하는 중(/api/auth/csrf 진행 중).
  if (hasIntranetSession(session) && !sessionVerified) {
    return withLocalEscape(
      <div className="app-boot-overlay">
        <div className="app-boot-box">
          <p>세션을 확인하는 중입니다…</p>
        </div>
      </div>,
      onSwitchToLocal,
    );
  }

  // 로그인 필요: 인트라넷 모드인데 인증 안 됨(저장된 세션 없음, 또는 확인 실패로 로컬로 되돌아감). 닫을 수 없음.
  if (!isAuthenticated) {
    return withLocalEscape(<LoginModal apiBaseUrl={resolveApiBaseUrl({ session, settings })} />, onSwitchToLocal);
  }

  // 비밀번호 변경 필요(서버가 must_change_password — 예: 시드 관리자 첫 로그인). 다른 화면을 모두 막음. 닫을 수 없음.
  if (session?.user?.mustChangePassword) {
    // onClose 없음 = 강제 변경 모드(닫기 버튼 없음) — 예전 App과 같다. (JS 컴포넌트라 타입상 필수로 추론돼 undefined를 명시)
    return withLocalEscape(<ChangePasswordModal apiBaseUrl={resolveApiBaseUrl({ session, settings })} onClose={undefined} />, onSwitchToLocal);
  }

  return null;
}
