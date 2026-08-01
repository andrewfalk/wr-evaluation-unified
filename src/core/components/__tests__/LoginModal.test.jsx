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
