// @vitest-environment jsdom
//
// 관리자 콘솔 고치기 ①(P2-83c, Phase 2 C9 구간 C) — 탭 안에서 끝나는 동작 세 가지.
//   ① 가입 거절 확인창은 플랫폼 확인창(src/platform/dialogs의 showConfirm — 셸에서는 셸 대화상자, 웹에서는 브라우저 확인창)
//   ② 환자 배정이 성공하면 처리 중 표시를 되돌려, 같은 환자를 곧바로 다시 바꿀 수 있다
//   ③ 가입 승인·거절·비밀번호 초기화는 처리하는 동안 같은 동작이 다시 나가지 않는다
// 서버 호출은 fetchRouter로 흉내 낸다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createFetchRouter } from '../../../testing/fetchRouter';
import { buttonByText, deferred, flush, inputByPlaceholder, rowContaining } from '../../../testing/adminConsoleHarness';
import { AdminConsoleModal } from '../AdminConsoleModal';

const SESSION = {
  mode: 'intranet',
  apiBaseUrl: 'https://admin.synthetic.test',
  user: { id: 'admin-0001', name: '합성 관리자', role: 'admin', organizationId: 'org-synthetic-1' },
};
const VALID_PW = 'abab-abab-1'; // 규칙(10자+·문자·숫자·특수문자)을 맞춘 합성 값

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  delete window.electron;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const signup = (id: string, name: string) => ({
  id, loginId: `synthetic-${id}`, name, requestedRole: 'doctor', note: '', createdAt: '2026-11-25T00:00:00.000Z', reviewerName: null,
});
const REQUESTS = [signup('req-1', '합성 신청 1'), signup('req-2', '합성 신청 2')];

function renderModal() {
  const view = render(<AdminConsoleModal session={SESSION} onClose={() => {}} onPatientAssignmentChanged={() => {}} />);
  const content = () => view.container.querySelector('.admin-tab-content') as HTMLElement;
  return { view, content };
}

async function openTab(view: ReturnType<typeof render>, label: string) {
  await flush();
  fireEvent.click(buttonByText(view.container, label));
  await flush();
}

describe('관리자 콘솔 고치기 ①', () => {
  it('① 가입 거절 확인창은 플랫폼 확인창으로 묻는다(셸이면 셸 대화상자, 전역 confirm은 부르지 않음)', async () => {
    const shellAsked: string[] = [];
    window.electron = { showConfirm: async (message: string) => { shellAsked.push(message); return true; } } as unknown as Window['electron'];
    const globalConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', globalConfirm);
    const router = createFetchRouter({
      'GET /api/admin/audit': { total: 0, items: [] },
      'GET /api/admin/signup-requests': { requests: REQUESTS },
      'POST /api/admin/signup-requests/:id/reject': { ok: true },
    });
    globalThis.fetch = router.fetch as typeof fetch;
    const { view, content } = renderModal();
    await openTab(view, '가입 요청');
    fireEvent.click(buttonByText(rowContaining(content(), 'synthetic-req-2'), '거절'));
    await flush();
    expect(shellAsked).toEqual(['이 신청을 거절하시겠습니까?']);
    expect(globalConfirm).not.toHaveBeenCalled();
    expect(router.count('POST /api/admin/signup-requests/:id/reject')).toBe(1);
  });

  it('① 셸 확인창에서 취소하면 거절 요청을 보내지 않는다', async () => {
    window.electron = { showConfirm: async () => false } as unknown as Window['electron'];
    vi.stubGlobal('confirm', () => true); // 셸 확인창을 묻지 않으면(지금 코드) 전역 확인창이 '확인'으로 요청을 보낸다
    const router = createFetchRouter({
      'GET /api/admin/audit': { total: 0, items: [] },
      'GET /api/admin/signup-requests': { requests: REQUESTS },
    });
    globalThis.fetch = router.fetch as typeof fetch;
    const { view, content } = renderModal();
    await openTab(view, '가입 요청');
    fireEvent.click(buttonByText(rowContaining(content(), 'synthetic-req-2'), '거절'));
    await flush();
    expect(router.unhandled).toEqual([]);
  });

  it('② 환자 배정이 성공하면 같은 환자를 곧바로 다시 바꿀 수 있다', async () => {
    const patient = { id: 'patient-0001', assignedDoctorUserId: null, data: { shared: { name: '합성 환자 1', patientNo: 'SYN-0001' } } };
    const router = createFetchRouter({
      'GET /api/admin/audit': { total: 0, items: [] },
      'GET /api/admin/users': {
        users: [
          { id: 'user-0002', loginId: 'synthetic-doc1', name: '합성 의사 1', role: 'doctor', disabled: false },
          { id: 'user-0003', loginId: 'synthetic-doc2', name: '합성 의사 2', role: 'doctor', disabled: false },
        ],
      },
      'GET /api/patients': { items: [patient], total: 1 },
      'POST /api/patients/:id/assignment': { ok: true },
    });
    globalThis.fetch = router.fetch as typeof fetch;
    const { view, content } = renderModal();
    await openTab(view, '환자 배정');
    const select = () => rowContaining(content(), '합성 환자 1').querySelector('select') as HTMLSelectElement;
    const changeButton = () => buttonByText(rowContaining(content(), '합성 환자 1'), '변경');
    fireEvent.change(select(), { target: { value: 'user-0002' } });
    fireEvent.click(changeButton());
    await flush();
    expect(router.count('POST /api/patients/:id/assignment')).toBe(1);
    fireEvent.change(select(), { target: { value: 'user-0003' } });
    expect(changeButton().disabled).toBe(false);
    fireEvent.click(changeButton());
    await flush();
    expect(router.count('POST /api/patients/:id/assignment')).toBe(2);
  });

  it('③ 가입 승인을 처리하는 동안 다시 눌러도 요청은 한 번', async () => {
    const gate = deferred();
    const router = createFetchRouter({
      'GET /api/admin/audit': { total: 0, items: [] },
      'GET /api/admin/signup-requests': { requests: REQUESTS },
      'POST /api/admin/signup-requests/:id/approve': async () => {
        await gate.promise;
        return { body: { name: '합성 신청 1', loginId: 'synthetic-req-1', tempPassword: 'tmp-tmp-01' } };
      },
    });
    globalThis.fetch = router.fetch as typeof fetch;
    const { view, content } = renderModal();
    await openTab(view, '가입 요청');
    const approve = () => buttonByText(rowContaining(content(), 'synthetic-req-1'), '승인');
    fireEvent.click(approve());
    await flush();
    fireEvent.click(approve());
    await flush();
    expect(router.count('POST /api/admin/signup-requests/:id/approve')).toBe(1);
    gate.release();
    await flush();
    expect(approve().disabled).toBe(false);
  });

  it('③ 가입 거절을 처리하는 동안 다시 눌러도 확인창·요청은 한 번', async () => {
    const gate = deferred();
    const asked = vi.fn(() => true);
    vi.stubGlobal('confirm', asked);
    const router = createFetchRouter({
      'GET /api/admin/audit': { total: 0, items: [] },
      'GET /api/admin/signup-requests': { requests: REQUESTS },
      'POST /api/admin/signup-requests/:id/reject': async () => { await gate.promise; return { body: { ok: true } }; },
    });
    globalThis.fetch = router.fetch as typeof fetch;
    const { view, content } = renderModal();
    await openTab(view, '가입 요청');
    const reject = () => buttonByText(rowContaining(content(), 'synthetic-req-2'), '거절');
    fireEvent.click(reject());
    await flush();
    fireEvent.click(reject());
    await flush();
    expect(router.count('POST /api/admin/signup-requests/:id/reject')).toBe(1);
    expect(asked).toHaveBeenCalledTimes(1);
    gate.release();
    await flush();
  });

  it('③ 비밀번호 초기화를 처리하는 동안 다시 눌러도(버튼·Enter) 요청은 한 번', async () => {
    const gate = deferred();
    const router = createFetchRouter({
      'GET /api/admin/audit': { total: 0, items: [] },
      'GET /api/admin/users': {
        users: [{ id: 'user-0002', loginId: 'synthetic-doc1', name: '합성 의사 1', role: 'doctor', disabled: false }],
      },
      'POST /api/admin/users/:id/reset-password': async () => { await gate.promise; return { body: { ok: true } }; },
    });
    globalThis.fetch = router.fetch as typeof fetch;
    const { view, content } = renderModal();
    await openTab(view, '사용자 관리');
    fireEvent.click(buttonByText(rowContaining(content(), 'synthetic-doc1'), '비밀번호 초기화'));
    const input = () => inputByPlaceholder(content(), '새 임시 비밀번호 (10자+, 숫자·특수문자 포함)');
    fireEvent.change(input(), { target: { value: VALID_PW } });
    fireEvent.click(buttonByText(content(), '초기화'));
    await flush();
    fireEvent.click(buttonByText(content(), '초기화'));
    fireEvent.keyDown(input(), { key: 'Enter' });
    await flush();
    expect(router.count('POST /api/admin/users/:id/reset-password')).toBe(1);
    gate.release();
    await flush();
    expect(content().querySelector('.admin-inline-modal')).toBeNull();
  });
});
