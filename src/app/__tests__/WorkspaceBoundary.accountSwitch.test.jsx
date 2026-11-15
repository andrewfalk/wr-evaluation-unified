// @vitest-environment jsdom
//
// 작업 공간 경계(계정 전환 수정 AS-4) — 실제 AuthProvider + WorkspaceBoundary(useAppSettings·useAuthSync 호스팅) + LoginModal +
// 로그인 직전 로컬 보존(useLocalWorkBeforeLogin)에 최소 App을 끼워, 로그인 응답을 기다리는 사이 문맥이 바뀌는 경우를 고정한다(R18).
// 실제 화면에서는 로그인 요청 중 "로컬 모드로 전환" 버튼이 비활성이라(보조 장치) 여기서는 경계가 넘긴 switchToLocalMode를
// 직접 불러 본 방어(인증 문맥 세대·언마운트 가드)를 시험한다. StrictMode.
import { StrictMode, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

await vi.hoisted(async () => (await import('../../testing/fakeBroadcastChannel.js')).installFakeBroadcastChannel());

import { AuthProvider, useAuth } from '../../core/auth/AuthContext.jsx';
import { WorkspaceBoundary } from '../WorkspaceBoundary';
import { LoginModal } from '../../core/components/LoginModal.jsx';
import { useLocalWorkBeforeLogin } from '../useLocalWorkBeforeLogin';
import { isIntranetContext } from '../../platform/dataMode';
import { createFetchRouter } from '../../testing/fetchRouter';

const SRV = 'https://srv.test';
const SETTINGS_KEY = 'wrEvalUnifiedSettings';
const USERS = { a: { id: 'u-a', organizationId: 'org-1' }, b: { id: 'u-b', organizationId: 'org-1' } };

const harness = {};
let mounts = 0;

function TestApp({ settings, handleSaveSettings, switchToLocalMode }) {
  const { session, isAuthenticated, getWorkspaceOwner } = useAuth();
  const [patients, setPatients] = useState([]);
  const onBeforeLogin = useLocalWorkBeforeLogin({ patients, getWorkspaceOwner });
  useEffect(() => { Object.assign(harness, { settings, handleSaveSettings, switchToLocalMode, setPatients }); }, [settings, handleSaveSettings, switchToLocalMode]);
  useEffect(() => { mounts += 1; }, []); // 화면이 다시 띄워졌는지(마운트 수, StrictMode는 2씩)
  const intranet = isIntranetContext({ session, settings });
  return (
    <div>
      <ul>{patients.map((p) => <li key={p}>{p}</li>)}</ul>
      {intranet && !isAuthenticated
        ? <LoginModal apiBaseUrl={SRV} onBeforeLogin={onBeforeLogin} />
        : <p>{isAuthenticated ? `로그인됨:${session.user.id}` : '로컬 화면'}</p>}
    </div>
  );
}

function setup({ holdA = true } = {}) {
  const release = {};
  const router = createFetchRouter({
    'POST /api/auth/login': async (req) => {
      const key = req.body?.loginId;
      if (key === 'a' && holdA) await new Promise((r) => { release.a = r; });
      return { body: { user: USERS[key], accessToken: `tok-${key}`, accessExpiresAt: '2099-01-01T00:00:00.000Z' } };
    },
  });
  globalThis.fetch = router.fetch;
  window.confirm = () => true;
  mounts = 0;
  render(<StrictMode><AuthProvider><WorkspaceBoundary App={TestApp} /></AuthProvider></StrictMode>);
  return { router, release };
}

function submitLogin(key) {
  fireEvent.change(screen.getByLabelText('아이디'), { target: { value: key } });
  fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: '로그인' }));
}

const toIntranet = () => act(() => { harness.handleSaveSettings({ ...harness.settings, integrationMode: 'intranet', apiBaseUrl: SRV }); });

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('R18 — 로그인 응답을 기다리는 사이 문맥이 바뀌면 늦은 응답은 적용되지 않는다', () => {
  it('A 로그인 보류 → 로컬 전환 → 인트라넷으로 돌아와 B 로그인·편집 → A 응답 도착: B 세션·B 편집 유지', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ integrationMode: 'intranet', apiBaseUrl: SRV }));
    const { router, release } = setup();
    submitLogin('a');
    await waitFor(() => expect(router.count('POST /api/auth/login')).toBe(1));
    act(() => { harness.switchToLocalMode(); });
    await screen.findByText('로컬 화면');
    toIntranet();
    submitLogin('b');
    await screen.findByText('로그인됨:u-b');
    act(() => { harness.setPatients(['B의 편집']); });
    const mountsAfterB = mounts;

    await act(async () => { release.a(); await new Promise((r) => setTimeout(r, 20)); });

    expect(screen.getByText('로그인됨:u-b')).toBeTruthy();
    expect(screen.getByText('B의 편집')).toBeTruthy();
    expect(mounts).toBe(mountsAfterB); // 화면이 다시 시작되지 않았다
  });

  it('B 로그인 없이: 로컬 편집 → 로그인 보류 → 로컬 전환 → 추가 편집 → 응답 도착: 로컬 세션 유지, 편집이 남는다', async () => {
    const { router, release } = setup();
    await screen.findByText('로컬 화면');
    act(() => { harness.setPatients(['로컬 편집 1']); });
    toIntranet();
    submitLogin('a');
    await waitFor(() => expect(router.count('POST /api/auth/login')).toBe(1));
    act(() => { harness.switchToLocalMode(); });
    await screen.findByText('로컬 화면');
    act(() => { harness.setPatients((prev) => [...prev, '로컬 편집 2']); });
    const mountsBefore = mounts;

    await act(async () => { release.a(); await new Promise((r) => setTimeout(r, 20)); });

    expect(screen.getByText('로컬 화면')).toBeTruthy();
    expect(screen.getByText('로컬 편집 1')).toBeTruthy();
    expect(screen.getByText('로컬 편집 2')).toBeTruthy();
    expect(mounts).toBe(mountsBefore);
  });
});

describe('R19 — 로그인 제출 뒤 복원된 목록도 로그인 직전에 로컬 자동저장에 쓴다', () => {
  it('제출(환자 없음) → 응답을 기다리는 사이 목록이 채워짐 → 응답 도착: 그 목록을 쓴 뒤 로그인', async () => {
    const { router, release } = setup();
    await screen.findByText('로컬 화면');
    toIntranet();
    submitLogin('a');
    await waitFor(() => expect(router.count('POST /api/auth/login')).toBe(1));
    act(() => { harness.setPatients(['복원된 환자']); }); // 예: 자동저장 복원이 끝남

    await act(async () => { release.a(); await new Promise((r) => setTimeout(r, 20)); });

    await screen.findByText('로그인됨:u-a');
    expect(JSON.parse(localStorage.getItem('wrEvalUnifiedAutoSave')).patients).toEqual(['복원된 환자']);
    expect(screen.queryByText('복원된 환자')).toBeNull(); // 로컬 작업은 로그인한 화면으로 이어지지 않는다(J2)
  });
});
