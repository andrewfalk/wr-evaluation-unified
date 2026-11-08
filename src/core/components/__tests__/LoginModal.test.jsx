// @vitest-environment jsdom
//
// Electron 앱은 재시작 시 재로그인을 강제하기 위해 리프레시 쿠키를 세션 쿠키로 받아야 한다
// (rememberMe: false). 웹은 기존처럼 영구 로그인 유지가 기본값이어야 한다(rememberMe: true).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginModal } from '../LoginModal.jsx';

vi.mock('../../services/httpClient', () => ({
  requestJson: vi.fn().mockResolvedValue({
    user: { id: 'user-1', name: 'Dr. Kim', role: 'doctor' },
    accessToken: 'tok',
    accessExpiresAt: new Date().toISOString(),
  }),
}));

vi.mock('../../utils/platform', () => ({
  isElectron: vi.fn(() => false),
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn() }),
}));

import { requestJson } from '../../services/httpClient';
import { isElectron } from '../../utils/platform';

afterEach(cleanup);

async function submitLoginForm() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('아이디'), 'doc1');
  await user.type(screen.getByLabelText('비밀번호'), 'pass123');
  await user.click(screen.getByRole('button', { name: '로그인' }));
}

describe('LoginModal rememberMe', () => {
  it('sends rememberMe: false when running inside Electron', async () => {
    vi.mocked(isElectron).mockReturnValue(true);
    render(<LoginModal />);

    await submitLoginForm();

    expect(requestJson).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      body: expect.objectContaining({ rememberMe: false }),
    }));
  });

  it('sends rememberMe: true on the web (non-Electron)', async () => {
    vi.mocked(isElectron).mockReturnValue(false);
    render(<LoginModal />);

    await submitLoginForm();

    expect(requestJson).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      body: expect.objectContaining({ rememberMe: true }),
    }));
  });
});

// SEC-B M2: 429는 서버 영어 문구 대신 한국어 안내를 보여 준다.
describe('LoginModal 429 messages', () => {
  function rejectWith(status, data) {
    const err = new Error(typeof data?.error === 'string' ? data.error : `Request failed (${status})`);
    err.status = status;
    err.data = data;
    vi.mocked(requestJson).mockRejectedValueOnce(err);
  }

  it('LOGIN_LOCKED under a minute shows the seconds to wait', async () => {
    rejectWith(429, { code: 'LOGIN_LOCKED', error: 'Too many failed login attempts', retryAfterSec: 42 });
    render(<LoginModal />);
    await submitLoginForm();
    expect(await screen.findByText('로그인에 여러 번 실패해 이 아이디가 잠시 잠겼습니다. 42초 후 다시 시도하세요.')).toBeTruthy();
  });

  it('LOGIN_LOCKED of a minute or more shows rounded-up minutes', async () => {
    rejectWith(429, { code: 'LOGIN_LOCKED', error: 'Too many failed login attempts', retryAfterSec: 125 });
    render(<LoginModal />);
    await submitLoginForm();
    expect(await screen.findByText('로그인에 여러 번 실패해 이 아이디가 잠시 잠겼습니다. 약 3분 후 다시 시도하세요.')).toBeTruthy();
  });

  it('the IP limiter (RATE_LIMITED) gets its own message', async () => {
    rejectWith(429, { code: 'RATE_LIMITED', error: 'Too many login attempts, please try again later' });
    render(<LoginModal />);
    await submitLoginForm();
    expect(await screen.findByText('로그인 시도가 너무 많습니다. 1분 뒤 다시 시도하세요.')).toBeTruthy();
  });

  it('other errors keep the server message', async () => {
    rejectWith(401, { code: 'INVALID_CREDENTIALS', error: 'Invalid login ID or password' });
    render(<LoginModal />);
    await submitLoginForm();
    expect(await screen.findByText('Invalid login ID or password')).toBeTruthy();
  });
});
