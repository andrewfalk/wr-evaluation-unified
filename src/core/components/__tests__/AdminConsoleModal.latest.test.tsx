// @vitest-environment jsdom
//
// 관리자 콘솔 — 늦게 온 목록 응답 버리기(P2-83b, Phase 2 C9 구간 C). 불러오기를 연달아 시작해 응답이 뒤바뀌어 와도 마지막
// 불러오기의 결과가 남고, 탭을 떠난 뒤 온 응답은 화면을 바꾸지 않는다. 서버 호출은 fetchRouter로 흉내 낸다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createFetchRouter } from '../../../testing/fetchRouter';
import { buttonByText, deferred, flush, inputByPlaceholder } from '../../../testing/adminConsoleHarness';
import { AdminConsoleModal } from '../AdminConsoleModal';

interface Req { query: Record<string, string> }

const SESSION = {
  mode: 'intranet',
  apiBaseUrl: 'https://admin.synthetic.test',
  user: { id: 'admin-0001', name: '합성 관리자', role: 'admin', organizationId: 'org-synthetic-1' },
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const signup = (id: string, name: string) => ({
  id, loginId: `synthetic-${id}`, name, requestedRole: 'doctor', note: '', createdAt: '2026-11-25T00:00:00.000Z', reviewerName: null,
});

function renderModal() {
  const view = render(<AdminConsoleModal session={SESSION} onClose={() => {}} onPatientAssignmentChanged={() => {}} />);
  const content = () => view.container.querySelector('.admin-tab-content') as HTMLElement;
  return { view, content };
}

describe('관리자 콘솔 — 늦게 온 목록 응답', () => {
  it('가입 요청 필터를 연달아 바꿔 응답이 뒤바뀌어 와도 마지막 필터의 목록이 남는다', async () => {
    const slowApproved = deferred();
    const router = createFetchRouter({
      'GET /api/admin/audit': { total: 0, items: [] },
      'GET /api/admin/signup-requests': async (req: Req) => {
        if (req.query.status === 'approved') {
          await slowApproved.promise;
          return { body: { requests: [signup('req-a', '합성 승인됨')] } };
        }
        if (req.query.status === 'rejected') return { body: { requests: [signup('req-r', '합성 거절됨')] } };
        return { body: { requests: [signup('req-p', '합성 대기')] } };
      },
    });
    globalThis.fetch = router.fetch as typeof fetch;
    const { view, content } = renderModal();
    await flush();
    fireEvent.click(buttonByText(view.container, '가입 요청'));
    await flush();
    const filter = () => content().querySelector('select') as HTMLSelectElement;
    fireEvent.change(filter(), { target: { value: 'approved' } }); // 느린 응답
    await flush();
    fireEvent.change(filter(), { target: { value: 'rejected' } }); // 빠른 응답 — 먼저 온다
    await flush();
    expect(content().textContent).toContain('합성 거절됨');
    slowApproved.release();                                        // 앞 필터의 응답이 늦게 온다
    await flush();
    expect(filter().value).toBe('rejected');
    expect(content().textContent).toContain('합성 거절됨');
    expect(content().textContent).not.toContain('합성 승인됨');
    expect(router.unhandled).toEqual([]);
  });

  it('감사 로그 조회를 연달아 눌러 앞 응답이 늦게 와도 마지막 조회의 목록·쪽이 남는다', async () => {
    const slowFirst = deferred();
    const item = (id: string, action: string) => ({
      id, createdAt: '2026-11-24T01:00:00.000Z', actorUserId: 'user-synthetic-0001', action, outcome: 'success',
      targetType: null, targetId: null, ip: null, extra: {},
    });
    let call = 0;
    const router = createFetchRouter({
      'GET /api/admin/audit': async (req: Req) => {
        call += 1;
        if (call === 2) {
          await slowFirst.promise;
          return { body: { total: 1, items: [item('a-old', 'old_action')] } };
        }
        return { body: { total: 1, items: [item(`a-${req.query.action || 'none'}`, req.query.action || 'first')] } };
      },
    });
    globalThis.fetch = router.fetch as typeof fetch;
    const { content } = renderModal();
    await flush();
    fireEvent.click(buttonByText(content(), '조회'));                // 2번째 요청 — 느림
    await flush();
    fireEvent.change(inputByPlaceholder(content(), '액션 필터 (예: patient_push)'), { target: { value: 'new_action' } });
    fireEvent.keyDown(inputByPlaceholder(content(), '액션 필터 (예: patient_push)'), { key: 'Enter' }); // 3번째 — 빠름
    await flush();
    expect(content().textContent).toContain('new_action');
    slowFirst.release();
    await flush();
    expect(content().textContent).toContain('new_action');
    expect(content().textContent).not.toContain('old_action');
    expect(router.count('GET /api/admin/audit')).toBe(3);
  });

  it('가입 승인을 처리하는 동안 필터를 바꾸면, 승인 뒤 다시 불러오기는 지금 필터로 하고 그 목록이 남는다', async () => {
    const approveGate = deferred();
    const firstRejected = deferred();
    let rejectedCalls = 0;
    const router = createFetchRouter({
      'GET /api/admin/audit': { total: 0, items: [] },
      'GET /api/admin/signup-requests': async (req: Req) => {
        if (req.query.status === 'rejected') {
          rejectedCalls += 1;
          if (rejectedCalls === 1) await firstRejected.promise; // 필터를 바꿀 때의 요청 — 가장 늦게 온다
          return { body: { requests: [signup('req-r', '합성 거절됨')] } };
        }
        return { body: { requests: [signup('req-p', '합성 대기')] } };
      },
      'POST /api/admin/signup-requests/:id/approve': async () => {
        await approveGate.promise;
        return { body: { name: '합성 대기', loginId: 'synthetic-req-p', tempPassword: 'tmp-tmp-01' } };
      },
    });
    globalThis.fetch = router.fetch as typeof fetch;
    const { view, content } = renderModal();
    await flush();
    fireEvent.click(buttonByText(view.container, '가입 요청'));
    await flush();
    fireEvent.click(buttonByText(content(), '승인'));                                   // 승인 응답 대기
    await flush();
    fireEvent.change(content().querySelector('select') as HTMLSelectElement, { target: { value: 'rejected' } });
    await flush();
    approveGate.release();                                                             // 승인 완료 → 다시 불러오기
    await flush();
    firstRejected.release();                                                           // 필터 바꿀 때의 응답이 마지막에
    await flush();
    expect((content().querySelector('select') as HTMLSelectElement).value).toBe('rejected');
    expect(content().textContent).toContain('합성 거절됨');
    expect(content().textContent).not.toContain('synthetic-req-p합성 대기');
    expect(router.calls.filter((c: { url: string }) => c.url.includes('signup-requests?')).map((c: { url: string }) => c.url.split('?')[1]))
      .toEqual(['status=pending', 'status=rejected', 'status=rejected']);
    expect(router.unhandled).toEqual([]);
  });
});
