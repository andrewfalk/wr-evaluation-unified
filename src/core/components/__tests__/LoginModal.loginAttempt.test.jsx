// @vitest-environment jsdom
//
// 로그인 화면의 로그인 시도(계정 전환 수정 AS-3) — 제출할 때 시도를 받아 그 signal로 요청을 보내고, 요청을 기다리는 사이
// 인증 문맥이 바뀌면(다른 로그인·로컬 전환·되돌림) 응답이 와도 로그인을 적용하지 않는다. 취소된 시도는 오류로 안내하지 않는다.
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

await vi.hoisted(async () => (await import('../../../testing/fakeBroadcastChannel.js')).installFakeBroadcastChannel());

vi.mock('../../services/httpClient', () => ({
  requestJson: vi.fn(),
  configureHttpClient: vi.fn(),
}));

import { AuthProvider, useAuth } from '../../auth/AuthContext.jsx';
import { LoginModal } from '../LoginModal.jsx';
import { requestJson } from '../../services/httpClient';

const responseOf = (id) => ({ user: { id, organizationId: 'org-1' }, accessToken: `tok-${id}`, accessExpiresAt: '2099-01-01T00:00:00.000Z' });

function renderModal() {
  const authRef = { current: null };
  function Capture() { authRef.current = useAuth(); return null; }
  render(<StrictMode><AuthProvider><Capture /><LoginModal apiBaseUrl="https://srv" /></AuthProvider></StrictMode>);
  return authRef;
}

function submit() {
  fireEvent.change(screen.getByLabelText('아이디'), { target: { value: 'doc1' } });
  fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: '로그인' }));
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.mocked(requestJson).mockReset();
});

describe('LoginModal — 로그인 시도', () => {
  it('요청에 시도의 signal을 싣고, 응답이 오면 로그인한다', async () => {
    requestJson.mockResolvedValue(responseOf('a'));
    const auth = renderModal();
    submit();
    await waitFor(() => expect(auth.current.session.mode).toBe('intranet'));
    expect(requestJson.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('요청을 기다리는 사이 인증 문맥이 바뀌면 시도가 취소되고 응답이 와도 로그인하지 않는다(오류 안내 없음)', async () => {
    let resolveLogin;
    requestJson.mockImplementation(() => new Promise((r) => { resolveLogin = r; }));
    const auth = renderModal();
    submit();
    await waitFor(() => expect(requestJson).toHaveBeenCalledTimes(1));
    const { signal } = requestJson.mock.calls[0][1];
    act(() => { auth.current.invalidateAuthContext(); }); // 예: 로컬 모드로 전환
    expect(signal.aborted).toBe(true);
    await act(async () => { resolveLogin(responseOf('a')); });
    expect(auth.current.session.mode).toBe('local');
    expect(auth.current.workspaceEpoch).toBe(0);
    expect(document.querySelector('.login-modal-error')).toBeNull();
  });

  it('취소되어 요청이 AbortError로 끝나도 오류 안내를 띄우지 않는다', async () => {
    requestJson.mockImplementation((path, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const auth = renderModal();
    submit();
    await waitFor(() => expect(requestJson).toHaveBeenCalledTimes(1));
    await act(async () => { auth.current.invalidateAuthContext(); });
    expect(document.querySelector('.login-modal-error')).toBeNull();
    expect(screen.getByRole('button', { name: '로그인' })).toBeTruthy();
  });

  it('잘못된 비밀번호 같은 실패는 지금처럼 안내한다', async () => {
    requestJson.mockRejectedValue(Object.assign(new Error('아이디 또는 비밀번호가 올바르지 않습니다.'), { status: 401 }));
    renderModal();
    submit();
    expect(await screen.findByText('아이디 또는 비밀번호가 올바르지 않습니다.')).toBeTruthy();
  });
});
