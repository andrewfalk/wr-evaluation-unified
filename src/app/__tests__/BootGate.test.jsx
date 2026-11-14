// @vitest-environment jsdom
// renderBootGate(REFACTORING_ROADMAP Phase 2 P2-25) — 조건 순서가 곧 의미다(앞 조건이 뒤 조건보다 먼저 이긴다).
// 화면 전체 흐름은 G9b가 덮고, 여기서는 순서·조건 조합을 표로 본다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AuthProvider } from '../../core/auth/AuthContext';
import { renderBootGate } from '../BootGate';

afterEach(() => { cleanup(); localStorage.clear(); });

const base = {
  isIntranetMode: true,
  configLoading: false,
  configError: null,
  session: { mode: 'intranet', apiBaseUrl: 'https://srv/', user: { id: 'u1' } },
  settings: { integrationMode: 'intranet' },
  sessionVerified: true,
  isAuthenticated: true,
  onSwitchToLocal: vi.fn(),
};
const show = (input) => {
  const out = renderBootGate({ ...base, ...input });
  if (out) render(<AuthProvider>{out}</AuthProvider>); // LoginModal·ChangePasswordModal은 useAuth를 쓴다
  return out;
};

describe('renderBootGate', () => {
  it('인트라넷 모드가 아니면 언제나 null', () => {
    expect(renderBootGate({ ...base, isIntranetMode: false, configLoading: true, configError: 'x', isAuthenticated: false })).toBeNull();
  });

  it('통과 조건(설정 완료·세션 확인·인증·비밀번호 정상)이면 null', () => {
    expect(renderBootGate(base)).toBeNull();
  });

  it('① 설정 불러오는 중이 다른 모든 조건보다 먼저', () => {
    show({ configLoading: true, configError: 'down', sessionVerified: false, isAuthenticated: false });
    expect(screen.getByText('서버에 연결 중입니다…')).toBeTruthy();
    expect(screen.getByRole('button', { name: /로컬 모드로 전환/ })).toBeTruthy();
  });

  it('② 설정 실패: 문구·정규화한 서버 URL·다시 시도·로컬 전환(세션 확인 중이어도 이것이 먼저)', () => {
    show({ configError: '서버 응답 없음', sessionVerified: false, isAuthenticated: false });
    expect(screen.getByRole('heading', { name: '서버 연결 실패' })).toBeTruthy();
    expect(screen.getByText('서버 응답 없음')).toBeTruthy();
    expect(screen.getByText(/인트라넷 서버\(https:\/\/srv\)에 연결할 수 없습니다/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
  });

  it('③ 저장된 인트라넷 세션 확인 중(인증 전이어도 이것이 먼저)', () => {
    show({ sessionVerified: false, isAuthenticated: false });
    expect(screen.getByText('세션을 확인하는 중입니다…')).toBeTruthy();
  });

  it('③은 세션이 인트라넷일 때만 — 로컬 세션이면 ④ 로그인', () => {
    show({ session: { mode: 'local' }, sessionVerified: false, isAuthenticated: false });
    expect(screen.getByRole('heading', { name: '인트라넷 로그인' })).toBeTruthy();
  });

  it('④ 로그인이 ⑤ 비밀번호 변경보다 먼저 — 인증 안 됐으면 mustChangePassword여도 로그인 화면(#305 Codex 권고)', () => {
    show({ isAuthenticated: false, session: { ...base.session, user: { id: 'u1', mustChangePassword: true } } });
    expect(screen.getByRole('heading', { name: '인트라넷 로그인' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '비밀번호 변경 필요' })).toBeNull();
  });

  it('⑤ 비밀번호 변경 필요(인증된 뒤에만)', () => {
    show({ session: { ...base.session, user: { id: 'u1', mustChangePassword: true } } });
    expect(screen.getByRole('heading', { name: '비밀번호 변경 필요' })).toBeTruthy();
  });

  it('로컬 전환 버튼은 넘긴 처리기를 부른다', () => {
    const onSwitchToLocal = vi.fn();
    show({ configLoading: true, onSwitchToLocal });
    fireEvent.click(screen.getByRole('button', { name: /로컬 모드로 전환/ }));
    expect(onSwitchToLocal).toHaveBeenCalledTimes(1);
  });
});
