// @vitest-environment jsdom
//
// 관리자 콘솔 특성화 ②(P2-81b, Phase 2 C9 구간 C) — 환자 배정 · 추론 디바이스 · 통계 권한 · 운영 상태 탭과 탭 전환.
// ①(AdminConsoleModal.characterization.test.tsx)과 같은 방식(fetchRouter, 단계마다 요청과 탭 화면)이고, 요청 클라이언트를
// **끊김을 따르는 래퍼**(src/testing/abortableFetch.ts)로 감싼다 — fetchRouter 그대로는 끊긴 요청도 정상 응답으로 돌아와
// "새 검색이 앞 요청을 끊는" 화면이 운영과 다르게 얼려진다. 그래서 모든 요청 기록에 signal 상태(none·live·aborted)가 붙는다.
// 환자 배정 탭의 검색 디바운스(400ms)는 가짜 타이머로 넘긴다.
//
// 픽스처는 합성 이름·ID만 쓴다.
// 규칙(의도한 출력 변경에서만 갱신, 리팩터링에서는 갱신 금지): src/core/fixtures/goldenEnv.js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { createFetchRouter } from '../../../testing/fetchRouter';
import { createAbortableFetch } from '../../../testing/abortableFetch';
import type { AbortableFetch } from '../../../testing/abortableFetch';
import {
  buttonByText, createStepRecorder, deferred, goldenJson, inputByPlaceholder, rowContaining,
} from '../../../testing/adminConsoleHarness';
import { AdminConsoleModal } from '../AdminConsoleModal';

type Fields = Record<string, unknown>;
type Reply = { status?: number; body?: unknown };
interface Req { method: string; path: string; query: Record<string, string>; body: unknown; params: Record<string, string> }
type Responder = (req: Req) => Reply | Promise<Reply>;

const SESSION = {
  mode: 'intranet',
  apiBaseUrl: 'https://admin.synthetic.test',
  user: { id: 'admin-0001', name: '합성 관리자', role: 'admin', organizationId: 'org-synthetic-1' },
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  useGoldenEnvironment();
  // 디바운스(setTimeout 400ms)를 직접 넘기려고 setTimeout도 가짜로 — 이미 켜진 가짜 타이머(Date)는 대상을 바꾸지 않으므로 다시 켠다.
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 응답 처리가 끝날 때까지 양보한다 — 가짜 setTimeout을 건드리지 않게 setImmediate로. */
async function flush(rounds = 6): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await new Promise<void>(resolve => { setImmediate(resolve); });
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await flush();
}

const fail = (status: number, error: string): Reply => ({ status, body: { error } });

function setupRouter(initial: Record<string, Responder>): { wrapped: AbortableFetch; set(key: string, responder: Responder): void; unhandled: string[] } {
  const router = createFetchRouter();
  const responders = new Map<string, Responder>(Object.entries(initial));
  const bind = (key: string) => {
    router.set(key, (req: Req) => {
      const responder = responders.get(key);
      if (!responder) throw new Error(`no responder for ${key}`);
      return responder(req);
    });
  };
  Object.keys(initial).forEach(bind);
  const wrapped = createAbortableFetch(router.fetch as typeof fetch);
  globalThis.fetch = wrapped.fetch as typeof fetch;
  return {
    wrapped,
    unhandled: router.unhandled,
    set(key, responder) {
      if (!responders.has(key)) bind(key);
      responders.set(key, responder);
    },
  };
}

function renderModal() {
  const events: string[] = [];
  const view = render(
    <AdminConsoleModal
      session={SESSION}
      onClose={() => { events.push('onClose'); }}
      onPatientAssignmentChanged={() => { events.push('onPatientAssignmentChanged'); }}
    />,
  );
  const content = () => view.container.querySelector('.admin-tab-content');
  const tab = (label: string) => buttonByText(view.container, label);
  return { view, content, tab, events };
}

function contentOf(get: () => Element | null): HTMLElement {
  const el = get();
  if (!(el instanceof HTMLElement)) throw new Error('tab content not found');
  return el;
}

const EMPTY_AUDIT: Responder = () => ({ body: { total: 0, items: [] } });

const user = (over: Fields): Fields => ({
  id: 'user-x', loginId: 'synthetic-x', name: '합성 사용자', role: 'doctor', disabled: false, mustChangePassword: false,
  createdAt: '2026-10-01T00:00:00.000Z', lastLoginAt: null, ...over,
});
const USERS = [
  user({ id: 'admin-0001', loginId: 'synthetic-admin', name: '합성 관리자', role: 'admin' }),
  user({ id: 'user-0002', loginId: 'synthetic-doc1', name: '합성 의사 1' }),
  user({ id: 'user-0003', loginId: 'synthetic-doc2', name: '합성 의사 2' }),
  user({ id: 'user-0004', loginId: 'synthetic-doc3', name: '합성 의사 3(비활성)', disabled: true }),
  user({ id: 'user-0005', loginId: 'synthetic-nurse1', name: '합성 간호사 1', role: 'nurse' }),
];

// ── 환자 배정 ─────────────────────────────────────────────────────────────────

const patient = (n: number, over: Fields = {}): Fields => ({
  id: `patient-${String(n).padStart(4, '0')}`,
  assignedDoctorUserId: null,
  data: { shared: { name: `합성 환자 ${n}`, patientNo: `SYN-${String(n).padStart(4, '0')}`, doctorName: '' } },
  ...over,
});
// 쪽 반복(offset 100)을 얼린다 — 첫 쪽은 3명만 돌려주고 total 4로 둘째 쪽(offset 100)을 한 번 더 부르게 한다(모은 수가 total에 닿으면 멈춤).
const PAGE_1 = [
  patient(1, { assignedDoctorUserId: 'user-0002', data: { shared: { name: '합성 환자 1', patientNo: 'SYN-0001', doctorName: '합성 의사 1' } } }),
  patient(2),
  { id: 'patient-0003', assignedDoctorUserId: 'user-0003', data: null },
];
const PAGE_2 = [patient(4)];

describe('관리자 콘솔 특성화 ② — 환자 배정', () => {
  it('열기(의사 목록·쪽 반복) · 배정(성공 뒤 처리 중 표시 남음·해제·실패) · 검색(디바운스·끊기·쪽 반복·빈 결과) · 불러오기 실패 뒤 배정', async () => {
    const gate = deferred();
    const routes = setupRouter({
      'GET /api/admin/audit': EMPTY_AUDIT,
      'GET /api/admin/users': () => ({ body: { users: USERS } }),
      'GET /api/patients': async (req) => {
        await gate.promise;
        return { body: { items: req.query.offset === '0' ? PAGE_1 : PAGE_2, total: 4 } };
      },
    });
    const { content, tab, events } = renderModal();
    await flush();
    const rec = createStepRecorder(routes.wrapped, content);
    rec.skip();
    const tabRoot = () => contentOf(content);
    const snap = (step: string) => { rec.snap(step, { events: events.splice(0) }); };
    const searchInput = () => inputByPlaceholder(tabRoot(), '환자명 또는 등록번호 검색 (서버 검색)');
    const selectOf = (text: string) => rowContaining(tabRoot(), text).querySelector('select') as HTMLSelectElement;

    fireEvent.click(tab('환자 배정'));
    await flush();
    snap('탭 열기 — 응답 전(의사 목록과 첫 쪽을 함께 부름)');
    gate.release();
    await flush();
    snap('탭 열기 — 응답 뒤(쪽 반복 offset 100, 활성 의사만 선택지)');

    fireEvent.change(selectOf('합성 환자 2'), { target: { value: 'user-0002' } });
    await flush();
    snap('배정 바꾸기 선택 — 변경 버튼 풀림');
    const assignGate = deferred();
    routes.set('POST /api/patients/:id/assignment', async () => { await assignGate.promise; return { body: { ok: true } }; });
    routes.set('GET /api/patients', (req) => ({ body: { items: req.query.offset === '0' ? PAGE_1 : PAGE_2, total: 4 } }));
    fireEvent.click(buttonByText(rowContaining(tabRoot(), '합성 환자 2'), '변경'));
    await flush();
    snap('배정 — 처리 중');
    assignGate.release();
    await flush();
    snap('배정 성공 — 알림·다시 불러옴(선택 비움, 그 행 변경 버튼은 계속 잠김)');
    fireEvent.change(selectOf('합성 환자 2'), { target: { value: 'user-0003' } });
    await flush();
    snap('같은 환자를 다시 바꾸려 함 — 변경 버튼 잠긴 채');

    routes.set('POST /api/patients/:id/assignment', () => ({ body: { ok: true } }));
    fireEvent.change(selectOf('합성 환자 1'), { target: { value: '' } });
    fireEvent.click(buttonByText(rowContaining(tabRoot(), '합성 환자 1'), '변경'));
    await flush();
    snap('다른 환자 배정 해제(미배정) — 본문 null, 처리 중 표시는 이 환자로 옮겨 감');

    routes.set('POST /api/patients/:id/assignment', () => fail(409, '배정을 바꾸지 못했습니다(합성).'));
    fireEvent.change(selectOf('SYN-0004'), { target: { value: 'user-0003' } });
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'SYN-0004'), '변경'));
    await flush();
    snap('배정 실패 — 오류 칸, 처리 중 풀림, 선택 그대로');

    // 검색: 입력마다 400ms 디바운스, 새 입력이 앞 타이머를 지운다.
    const searchGate = deferred();
    routes.set('GET /api/patients', async (req) => {
      if (req.query.q === '합성') await searchGate.promise;
      return { body: { items: req.query.q === '합성 환자 4' ? PAGE_2 : PAGE_1.slice(0, 2), total: req.query.q === '합성 환자 4' ? 1 : 2 } };
    });
    fireEvent.change(searchInput(), { target: { value: '합' } });
    await advance(300);
    fireEvent.change(searchInput(), { target: { value: '합성' } });
    await advance(399);
    snap('검색 입력 — 디바운스 중(요청 없음, 앞 타이머 지움)');
    await advance(1);
    snap('검색 "합성" — 400ms 뒤 요청(응답 전)');
    const firstSearch = routes.wrapped.calls[routes.wrapped.calls.length - 1];
    fireEvent.change(searchInput(), { target: { value: '합성 환자 4' } });
    await flush();
    rec.snap('응답 전에 새 입력 — 앞 요청 끊김, 오류 칸 없음, 불러오는 중 그대로', {
      events: [...events.splice(0), `앞 요청 signal=${firstSearch.signal}`],
    });
    expect(firstSearch.signal).toBe('aborted');
    await advance(400);
    snap('새 검색 응답');
    searchGate.release();
    await flush();
    snap('끊긴 앞 요청이 늦게 풀려도 화면 그대로');

    routes.set('GET /api/patients', (req) => ({
      body: { items: req.query.offset === '0' ? [patient(5)] : [patient(6)], total: 2 },
    }));
    fireEvent.change(searchInput(), { target: { value: ' 합성 ' } });
    await advance(400);
    snap('검색어 앞뒤 공백은 잘라 보냄 · 검색에서도 쪽 반복');

    routes.set('GET /api/patients', () => ({ body: { items: [], total: 0 } }));
    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    snap('새로 고침(검색 중) — 검색 결과 없음 문구');
    fireEvent.change(searchInput(), { target: { value: '' } });
    await flush();
    snap('검색어 지움 — 디바운스 없이 바로 전체 불러옴(환자 없음 문구)');

    routes.set('GET /api/patients', () => fail(500, '환자 목록을 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    snap('새로 고침 실패(빈 목록) — 오류 칸');

    routes.set('GET /api/patients', (req) => ({ body: { items: req.query.offset === '0' ? PAGE_1 : PAGE_2, total: 4 } }));
    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    routes.set('GET /api/patients', () => fail(500, '환자 목록을 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    snap('목록이 있을 때 새로 고침 실패 — 목록 그대로');
    routes.set('POST /api/patients/:id/assignment', () => ({ body: { ok: true } }));
    routes.set('GET /api/patients', (req) => ({ body: { items: req.query.offset === '0' ? PAGE_1 : PAGE_2, total: 4 } }));
    fireEvent.change(selectOf('SYN-0004'), { target: { value: 'user-0002' } });
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'SYN-0004'), '변경'));
    await flush();
    snap('불러오기 실패 뒤 배정 성공 — 다시 불러오며 오류 칸 지워짐');

    routes.set('GET /api/patients', () => fail(500, '환자 목록을 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    routes.set('POST /api/patients/:id/assignment', () => fail(409, '배정을 바꾸지 못했습니다(합성).'));
    fireEvent.change(selectOf('합성 환자 2'), { target: { value: 'user-0003' } });
    fireEvent.click(buttonByText(rowContaining(tabRoot(), '합성 환자 2'), '변경'));
    await flush();
    snap('불러오기 실패 뒤 배정 실패 — 오류 칸을 덮어씀');

    expect(routes.unhandled).toEqual([]);
    await expect(goldenJson({ steps: rec.steps })).toMatchFileSnapshot('./__goldens__/admin-assignment.json');
  });

  it('의사 목록 실패 · 불러오는 중 탭을 떠나면 요청을 끊는다', async () => {
    const gate = deferred();
    const routes = setupRouter({
      'GET /api/admin/audit': EMPTY_AUDIT,
      'GET /api/admin/users': () => fail(500, '사용자 목록을 불러오지 못했습니다(합성).'),
      'GET /api/patients': async () => { await gate.promise; return { body: { items: [patient(1)], total: 1 } }; },
    });
    const { content, tab } = renderModal();
    await flush();
    const rec = createStepRecorder(routes.wrapped, content);
    rec.skip();
    fireEvent.click(tab('환자 배정'));
    await flush();
    rec.snap('의사 목록 실패 — 오류 칸(환자 목록은 아직 불러오는 중)');
    const patientsCall = routes.wrapped.calls[routes.wrapped.calls.length - 1];
    routes.set('GET /api/admin/ops/backup-status', () => ({ body: null }));
    fireEvent.click(tab('운영 상태'));
    await flush();
    rec.snap('탭을 떠남 — 환자 요청 끊김(운영 상태 탭이 부름)', { events: [`환자 요청 signal=${patientsCall.signal}`] });
    expect(patientsCall.signal).toBe('aborted');
    gate.release();
    await flush();
    rec.snap('끊긴 요청이 늦게 풀려도 화면 그대로');
    expect(routes.unhandled).toEqual([]);
    await expect(goldenJson({ steps: rec.steps })).toMatchFileSnapshot('./__goldens__/admin-assignment-leave.json');
  });
});

// ── 추론 디바이스 ─────────────────────────────────────────────────────────────

describe('관리자 콘솔 특성화 ② — 추론 디바이스', () => {
  it('열기 · 고르기 · 저장(처리 중·성공·실패) · 새로고침이 편집을 되돌림 · GPU 표시 · 불러오기 실패 뒤 저장', async () => {
    const gate = deferred();
    const settings = (inferenceDevice: string, gpu?: Fields | null): Reply => ({
      body: { inferenceDevice, ...(gpu !== undefined ? { gpu } : {}) },
    });
    const routes = setupRouter({
      'GET /api/admin/audit': EMPTY_AUDIT,
      'GET /api/admin/org-settings': async () => {
        await gate.promise;
        return settings('auto', { cudaAvailable: false, providers: ['CPUExecutionProvider'], error: 'GPU 확인 실패(합성)' });
      },
    });
    const { content, tab } = renderModal();
    await flush();
    const rec = createStepRecorder(routes.wrapped, content);
    rec.skip();
    const tabRoot = () => contentOf(content);
    const radio = (value: string) => tabRoot().querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement;

    fireEvent.click(tab('추론 디바이스'));
    await flush();
    rec.snap('탭 열기 — 응답 전(GPU 확인 중, 칸 잠김)');
    gate.release();
    await flush();
    rec.snap('탭 열기 — 응답 뒤(자동, CUDA 미감지 안내, 저장 잠김)');

    fireEvent.click(radio('cpu'));
    await flush();
    rec.snap('CPU 고름 — 저장 풀림');
    const saveGate = deferred();
    routes.set('PATCH /api/admin/org-settings', async () => { await saveGate.promise; return settings('cpu'); });
    fireEvent.click(buttonByText(tabRoot(), '저장'));
    await flush();
    rec.snap('저장 — 처리 중(칸 잠김)');
    saveGate.release();
    await flush();
    rec.snap('저장 성공 — 문구, 저장 잠김');
    fireEvent.click(radio('cuda'));
    await flush();
    rec.snap('다시 고르면 저장 문구 지워짐');

    routes.set('PATCH /api/admin/org-settings', () => fail(500, '설정을 저장하지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '저장'));
    await flush();
    rec.snap('저장 실패 — 오류 칸, 고른 값 그대로');

    routes.set('GET /api/admin/org-settings', () => settings('cpu', { cudaAvailable: true, providers: ['CUDAExecutionProvider'] }));
    fireEvent.click(buttonByText(tabRoot(), '새로고침'));
    await flush();
    rec.snap('새로고침 — 편집 되돌림·오류 칸 지워짐, CUDA 사용 가능');
    routes.set('GET /api/admin/org-settings', () => settings('cuda'));
    fireEvent.click(buttonByText(tabRoot(), '새로고침'));
    await flush();
    rec.snap('gpu 없는 응답 — GPU 확인 중으로 돌아감');

    routes.set('GET /api/admin/org-settings', () => fail(500, '설정을 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로고침'));
    await flush();
    rec.snap('새로고침 실패 — 오류 칸, 값 그대로');
    routes.set('PATCH /api/admin/org-settings', () => settings('auto'));
    fireEvent.click(radio('auto'));
    fireEvent.click(buttonByText(tabRoot(), '저장'));
    await flush();
    rec.snap('불러오기 실패 뒤 저장 성공 — 오류 칸 지워짐');
    fireEvent.click(buttonByText(tabRoot(), '새로고침'));
    await flush();
    routes.set('PATCH /api/admin/org-settings', () => fail(500, '설정을 저장하지 못했습니다(합성).'));
    fireEvent.click(radio('cpu'));
    fireEvent.click(buttonByText(tabRoot(), '저장'));
    await flush();
    rec.snap('불러오기 실패 뒤 저장 실패 — 오류 칸을 덮어씀');

    expect(routes.unhandled).toEqual([]);
    await expect(goldenJson({ steps: rec.steps })).toMatchFileSnapshot('./__goldens__/admin-inference.json');
  });
});

// ── 통계 권한 ─────────────────────────────────────────────────────────────────

const CATALOG = [
  { key: 'stats.workbench', label: '통계 작업대(합성)', defaultAllRoles: false },
  { key: 'stats.export', label: '자료 내보내기(합성)', defaultAllRoles: true },
];
const grant = (over: Fields): Fields => ({
  id: 'grant-x', userId: 'user-0002', userName: '합성 의사 1', capability: 'stats.workbench', status: 'active',
  grantedByName: '합성 관리자', reason: '합성 사유', expiresAt: '2026-12-31T00:00:00.000Z', ...over,
});
const GRANTS = [
  grant({ id: 'grant-1' }),
  grant({ id: 'grant-2', status: 'expired', userName: '합성 의사 2', grantedByName: null, expiresAt: null }),
  grant({ id: 'grant-3', status: 'revoked', capability: 'stats.unknown' }),
  grant({ id: 'grant-4', status: 'suspended', capability: 'stats.export', userName: '합성 간호사 1' }),
];

describe('관리자 콘솔 특성화 ② — 통계 권한', () => {
  it('열기(세 목록 함께) · 부여(검사·처리 중·만료일 유무·실패) · 회수(처리 중·실패) · 불러오기 실패 뒤 회수·부여', async () => {
    const gate = deferred();
    const routes = setupRouter({
      'GET /api/admin/audit': EMPTY_AUDIT,
      'GET /api/capabilities/catalog': async () => { await gate.promise; return { body: { capabilities: CATALOG } }; },
      'GET /api/capabilities/grants': () => ({ body: { grants: GRANTS } }),
      'GET /api/admin/users': () => ({ body: { users: USERS } }),
    });
    const { content, tab } = renderModal();
    await flush();
    const rec = createStepRecorder(routes.wrapped, content);
    rec.skip();
    const tabRoot = () => contentOf(content);
    const selects = () => tabRoot().querySelectorAll('select');
    const fillForm = (userId: string, capability: string, reason: string, expiresAt = '') => {
      fireEvent.change(selects()[0] as HTMLSelectElement, { target: { value: userId } });
      fireEvent.change(selects()[1] as HTMLSelectElement, { target: { value: capability } });
      fireEvent.change(inputByPlaceholder(tabRoot(), '부여 사유(필수)'), { target: { value: reason } });
      fireEvent.change(tabRoot().querySelector('input[type="date"]') as HTMLInputElement, { target: { value: expiresAt } });
    };

    fireEvent.click(tab('통계 권한'));
    await flush();
    rec.snap('탭 열기 — 응답 전(세 요청 함께)');
    gate.release();
    await flush();
    rec.snap('탭 열기 — 응답 뒤(모르는 권한은 키 그대로, 모르는 상태는 값 그대로)');
    routes.set('GET /api/capabilities/catalog', () => ({ body: { capabilities: CATALOG } }));

    fireEvent.click(buttonByText(tabRoot(), '부여'));
    await flush();
    rec.snap('부여 — 빈 칸(요청 없음)');
    fillForm('user-0003', 'stats.workbench', '   ');
    fireEvent.click(buttonByText(tabRoot(), '부여'));
    await flush();
    rec.snap('부여 — 사유가 공백뿐(요청 없음)');

    const createGate = deferred();
    routes.set('POST /api/capabilities/grants', async () => { await createGate.promise; return { status: 201, body: { id: 'grant-5' } }; });
    fillForm('user-0003', 'stats.workbench', '  합성 연구 목적  ', '2026-12-31');
    fireEvent.click(buttonByText(tabRoot(), '부여'));
    await flush();
    rec.snap('부여 — 처리 중(사유 앞뒤 공백 자름, 만료일은 ISO)');
    createGate.release();
    await flush();
    rec.snap('부여 성공 — 폼 비움·문구·다시 불러옴');

    routes.set('POST /api/capabilities/grants', () => ({ status: 201, body: { id: 'grant-6' } }));
    fillForm('user-0005', 'stats.export', '합성 사유 2');
    fireEvent.click(buttonByText(tabRoot(), '부여'));
    await flush();
    rec.snap('만료일 없이 부여 — 본문에 expiresAt 없음');

    routes.set('POST /api/capabilities/grants', () => fail(409, '이미 부여된 권한입니다(합성).'));
    fillForm('user-0002', 'stats.workbench', '합성 중복');
    fireEvent.click(buttonByText(tabRoot(), '부여'));
    await flush();
    rec.snap('부여 실패 — 폼 오류 칸(앞 문구 지워짐), 폼 그대로');

    const revokeGate = deferred();
    routes.set('POST /api/capabilities/grants/:id/revoke', async () => { await revokeGate.promise; return { body: { ok: true } }; });
    fireEvent.click(buttonByText(rowContaining(tabRoot(), '합성 의사 1'), '회수'));
    await flush();
    rec.snap('회수 — 처리 중');
    revokeGate.release();
    await flush();
    rec.snap('회수 성공 — 다시 불러옴');
    routes.set('POST /api/capabilities/grants/:id/revoke', () => fail(500, '권한을 회수하지 못했습니다(합성).'));
    fireEvent.click(buttonByText(rowContaining(tabRoot(), '합성 의사 1'), '회수'));
    await flush();
    rec.snap('회수 실패 — 오류 칸');

    routes.set('GET /api/capabilities/grants', () => fail(500, '권한 목록을 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    rec.snap('새로 고침 실패(세 요청 중 하나) — 오류 칸, 세 목록 모두 그대로');
    routes.set('GET /api/capabilities/grants', () => ({ body: { grants: GRANTS } }));
    routes.set('POST /api/capabilities/grants/:id/revoke', () => ({ body: { ok: true } }));
    fireEvent.click(buttonByText(rowContaining(tabRoot(), '합성 의사 1'), '회수'));
    await flush();
    rec.snap('불러오기 실패 뒤 회수 성공 — 오류 칸 지워짐');

    routes.set('GET /api/capabilities/grants', () => fail(500, '권한 목록을 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    routes.set('POST /api/capabilities/grants/:id/revoke', () => fail(500, '권한을 회수하지 못했습니다(합성).'));
    fireEvent.click(buttonByText(rowContaining(tabRoot(), '합성 의사 1'), '회수'));
    await flush();
    rec.snap('불러오기 실패 뒤 회수 실패 — 오류 칸을 덮어씀');

    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    routes.set('GET /api/capabilities/grants', () => ({ body: {} }));
    routes.set('POST /api/capabilities/grants', () => ({ status: 201, body: { id: 'grant-7' } }));
    fillForm('user-0002', 'stats.export', '합성 사유 3');
    fireEvent.click(buttonByText(tabRoot(), '부여'));
    await flush();
    rec.snap('불러오기 실패 뒤 부여 — 오류 칸은 다시 불러오며 지워짐(grants 없는 응답 → 빈 목록)');

    expect(routes.unhandled).toEqual([]);
    await expect(goldenJson({ steps: rec.steps })).toMatchFileSnapshot('./__goldens__/admin-capabilities.json');
  });
});

// ── 운영 상태 ─────────────────────────────────────────────────────────────────

const REPORT = {
  checkedAt: '2026-11-27T21:00:00.000Z', summary: 'stale_and_alert', isStale: true, staleThresholdHours: 30,
  lastSuccessAt: '2026-11-25T18:00:00.000Z',
  openAlerts: [
    { runId: 'run-synthetic-1', reasonClass: 'synthetic_failure', createdAt: '2026-11-26T18:00:00.000Z', dryRun: false },
    { runId: 'run-synthetic-2', reasonClass: 'synthetic_dry_run', createdAt: '2026-11-26T19:00:00.000Z', dryRun: true },
  ],
};
const BACKUP = { status: 'failed', runId: 'run-synthetic-1', lastFailureAt: '2026-11-26T18:00:00.000Z', reasonClass: 'synthetic_failure' };

describe('관리자 콘솔 특성화 ② — 운영 상태', () => {
  it('열기 · 요약 문구 · 알림 확인·해결(처리 중·성공·실패) · 빈 응답 · 불러오기 실패 뒤 확인', async () => {
    const gate = deferred();
    const routes = setupRouter({
      'GET /api/admin/audit': EMPTY_AUDIT,
      'GET /api/admin/ops/backup-status': async () => { await gate.promise; return { body: { monitorReport: REPORT, backupStatus: BACKUP } }; },
    });
    const { content, tab } = renderModal();
    await flush();
    const rec = createStepRecorder(routes.wrapped, content);
    rec.skip();
    const tabRoot = () => contentOf(content);
    const alertCard = (runId: string) => {
      const card = Array.from(tabRoot().querySelectorAll('.admin-card')).find(c => (c.textContent || '').includes(runId));
      if (!card) throw new Error(`alert not found: ${runId}`);
      return card;
    };

    fireEvent.click(tab('운영 상태'));
    await flush();
    rec.snap('탭 열기 — 응답 전');
    gate.release();
    await flush();
    rec.snap('탭 열기 — 응답 뒤(지연 + 미처리 알림 2건)');

    const ackGate = deferred();
    routes.set('POST /api/admin/ops/backup-alerts/:runId/:action', async () => { await ackGate.promise; return { body: { ok: true } }; });
    routes.set('GET /api/admin/ops/backup-status', () => ({
      body: { monitorReport: { ...REPORT, summary: 'alert_open', isStale: false, openAlerts: REPORT.openAlerts.slice(1) }, backupStatus: BACKUP },
    }));
    fireEvent.click(buttonByText(alertCard('run-synthetic-1'), '확인'));
    await flush();
    rec.snap('알림 확인 — 처리 중(그 알림 버튼 둘 잠김)');
    ackGate.release();
    await flush();
    rec.snap('알림 확인 성공 — 다시 불러옴');

    routes.set('POST /api/admin/ops/backup-alerts/:runId/:action', () => ({ body: { ok: true } }));
    routes.set('GET /api/admin/ops/backup-status', () => ({
      body: { monitorReport: { ...REPORT, summary: 'dry_run_alert_open', isStale: false, openAlerts: [] }, backupStatus: null },
    }));
    fireEvent.click(buttonByText(alertCard('run-synthetic-2'), '해결 완료'));
    await flush();
    rec.snap('해결 완료 — 다시 불러옴(알림 없음, 최근 실행 표 없음)');

    routes.set('GET /api/admin/ops/backup-status', () => ({
      body: { monitorReport: { ...REPORT, summary: 'unknown_summary' }, backupStatus: { status: 'ok', runId: null, lastFailureAt: null, reasonClass: null } },
    }));
    fireEvent.click(buttonByText(tabRoot(), '새로고침'));
    await flush();
    rec.snap('모르는 요약 값은 그대로 · 빈 값은 -');
    routes.set('POST /api/admin/ops/backup-alerts/:runId/:action', () => fail(500, '알림을 처리하지 못했습니다(합성).'));
    fireEvent.click(buttonByText(alertCard('run-synthetic-1'), '확인'));
    await flush();
    rec.snap('확인 실패 — 오류 칸');
    fireEvent.click(buttonByText(alertCard('run-synthetic-1'), '해결 완료'));
    await flush();
    rec.snap('해결 실패 — 오류 칸');

    routes.set('GET /api/admin/ops/backup-status', () => fail(500, '운영 상태를 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로고침'));
    await flush();
    rec.snap('새로고침 실패 — 오류 칸, 앞 내용 그대로');
    routes.set('POST /api/admin/ops/backup-alerts/:runId/:action', () => ({ body: { ok: true } }));
    routes.set('GET /api/admin/ops/backup-status', () => ({ body: { monitorReport: REPORT, backupStatus: BACKUP } }));
    fireEvent.click(buttonByText(alertCard('run-synthetic-1'), '확인'));
    await flush();
    rec.snap('불러오기 실패 뒤 확인 성공 — 다시 불러오며 오류 칸 지워짐');
    routes.set('GET /api/admin/ops/backup-status', () => fail(500, '운영 상태를 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로고침'));
    await flush();
    routes.set('POST /api/admin/ops/backup-alerts/:runId/:action', () => fail(500, '알림을 처리하지 못했습니다(합성).'));
    fireEvent.click(buttonByText(alertCard('run-synthetic-1'), '해결 완료'));
    await flush();
    rec.snap('불러오기 실패 뒤 해결 실패 — 오류 칸을 덮어씀');

    routes.set('GET /api/admin/ops/backup-status', () => ({ body: null }));
    fireEvent.click(buttonByText(tabRoot(), '새로고침'));
    await flush();
    rec.snap('빈 응답 — 아직 불러오지 못했다는 문구');

    expect(routes.unhandled).toEqual([]);
    await expect(goldenJson({ steps: rec.steps })).toMatchFileSnapshot('./__goldens__/admin-ops.json');
  });
});

// ── 탭 전환 · 닫기 ────────────────────────────────────────────────────────────

describe('관리자 콘솔 특성화 ② — 탭 전환', () => {
  it('탭 9개 순서·활성 표시 · 탭마다 열 때 요청 · 바꿨다 돌아오면 다시 불러옴(상태 사라짐) · 닫기', async () => {
    const routes = setupRouter({
      'GET /api/admin/audit': EMPTY_AUDIT,
      'GET /api/admin/devices': () => ({ body: { devices: [] } }),
      'GET /api/admin/users': () => ({ body: { users: USERS } }),
      'GET /api/admin/signup-requests': () => ({ body: { requests: [] } }),
      'GET /api/admin/presets': () => ({ body: { presets: [] } }),
      'GET /api/patients': () => ({ body: { items: [], total: 0 } }),
      'GET /api/admin/org-settings': () => ({ body: { inferenceDevice: 'auto', gpu: null } }),
      'GET /api/capabilities/catalog': () => ({ body: { capabilities: CATALOG } }),
      'GET /api/capabilities/grants': () => ({ body: { grants: [] } }),
      'GET /api/admin/ops/backup-status': () => ({ body: null }),
    });
    const { view, tab, events } = renderModal();
    const modal = () => view.container.querySelector('.admin-modal');
    const rec = createStepRecorder(routes.wrapped, modal);
    await flush();
    rec.snap('모달 열기 — 머리·탭 9개·감사 로그', { events: events.splice(0) });
    const opened: Array<{ tab: string; requests: string[] }> = [];
    for (const label of ['디바이스', '사용자 관리', '가입 요청', '프리셋 공유', '환자 배정', '추론 디바이스', '통계 권한', '운영 상태']) {
      fireEvent.click(tab(label));
      await flush();
      opened.push({ tab: label, requests: rec.skip().map(c => `${c.method} ${c.url} signal=${c.signal}`) });
    }

    fireEvent.click(tab('감사 로그'));
    await flush();
    fireEvent.change(inputByPlaceholder(contentOf(() => view.container.querySelector('.admin-tab-content')), '액션 필터 (예: patient_push)'), {
      target: { value: 'login' },
    });
    rec.skip();
    fireEvent.click(tab('디바이스'));
    await flush();
    fireEvent.click(tab('감사 로그'));
    await flush();
    rec.snap('다른 탭에 갔다 돌아옴 — 다시 불러오고 입력한 필터는 사라짐', { events: events.splice(0) });
    fireEvent.click(tab('감사 로그'));
    await flush();
    rec.snap('지금 탭을 다시 누름 — 요청 없음', { events: events.splice(0) });

    fireEvent.click(modal() as HTMLElement);
    await flush();
    rec.snap('모달 안쪽 클릭 — 닫지 않음', { events: events.splice(0) });
    fireEvent.click(buttonByText(view.container, '닫기'));
    fireEvent.click(view.container.querySelector('.modal-overlay') as HTMLElement);
    await flush();
    rec.snap('닫기 버튼·바깥 클릭 — onClose 두 번', { events: events.splice(0) });

    expect(within(view.container).getAllByRole('button').slice(0, 9).map(b => b.textContent)).toEqual([
      '감사 로그', '디바이스', '사용자 관리', '가입 요청', '프리셋 공유', '환자 배정', '추론 디바이스', '통계 권한', '운영 상태',
    ]);
    expect(routes.unhandled).toEqual([]);
    await expect(goldenJson({ opened, steps: rec.steps })).toMatchFileSnapshot('./__goldens__/admin-tab-switch.json');
  });
});
