// @vitest-environment jsdom
//
// SEC-B L4: 서버는 형식이 맞는 신청이면 아이디 중복·기존 계정도 항상 202 ACCEPTED로 답한다. 모달은
// 같은 접수 안내만 보이고, 오류로는 형식 오류(400)·횟수 제한(429)·그 밖의 실패만 안내한다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignupRequestModal } from '../SignupRequestModal.jsx';

vi.mock('../../services/httpClient', () => ({
  requestJson: vi.fn(),
}));

import { requestJson } from '../../services/httpClient';

afterEach(() => { cleanup(); vi.mocked(requestJson).mockReset(); });

async function fillAndSubmit(container) {
  const user = userEvent.setup();
  const [loginId, name] = container.querySelectorAll('input[type="text"]');
  await user.type(loginId, 'new.doctor');
  await user.type(name, '김의사');
  await user.click(screen.getByRole('button', { name: '신청' }));
}

function rejectWith(status, data) {
  const err = new Error(typeof data?.error === 'string' ? data.error : `Request failed (${status})`);
  err.status = status;
  err.data = data;
  vi.mocked(requestJson).mockRejectedValueOnce(err);
}

describe('SignupRequestModal', () => {
  it('202 ACCEPTED shows the same "received" notice', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce({ code: 'ACCEPTED' });
    const { container } = render(<SignupRequestModal onClose={() => {}} />);
    await fillAndSubmit(container);
    expect(await screen.findByText(/요청이 접수되었습니다/)).toBeTruthy();
    expect(screen.getByText(/이미 신청했거나 사용 중인 아이디는 새로 접수되지 않습니다/)).toBeTruthy();
    expect(requestJson).toHaveBeenCalledWith('/api/auth/signup-requests', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({ loginId: 'new.doctor', name: '김의사', requestedRole: 'doctor' }),
    }));
  });

  it('429 shows a Korean "too many requests" message', async () => {
    rejectWith(429, { code: 'RATE_LIMITED', error: 'Too many signup requests, please try again later' });
    const { container } = render(<SignupRequestModal onClose={() => {}} />);
    await fillAndSubmit(container);
    expect(await screen.findByText('신청이 너무 많습니다. 잠시 후 다시 시도하세요.')).toBeTruthy();
  });

  it('400 asks to check the input', async () => {
    rejectWith(400, { code: 'INVALID_BODY', errors: { loginId: ['Invalid'] } });
    const { container } = render(<SignupRequestModal onClose={() => {}} />);
    await fillAndSubmit(container);
    expect(await screen.findByText('입력 내용을 확인하세요.')).toBeTruthy();
  });
});
