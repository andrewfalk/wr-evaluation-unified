// @vitest-environment jsdom
//
// 관리자 콘솔 특성화 ①(P2-81a, Phase 2 C9 구간 C) — 감사 로그 · 디바이스 · 사용자 관리 · 가입 요청 · 프리셋 공유 탭을
// vi.mock 없이 그려 지금 화면을 얼린다. 서버 호출은 fetchRouter로 흉내 내므로 요청을 만드는 코드가 옮겨 가도(탭 파일 · 저장소
// 함수 · 다른 요청 클라이언트) 같은 기록이 나와야 한다. 탭마다 ① 열 때의 요청(주소·횟수) ② 목록 DOM ③ 동작마다 요청(메서드·
// 주소·본문·헤더)과 그 뒤 DOM ④ 실패 응답 때의 문구 ⑤ "불러오기 실패 → 행 동작(성공·실패)" 순서에서 오류 칸이 어떻게 보이는지.
// 뒤따르는 이동·분할 PR(P2-81c-ts · P2-82a·b · P2-83a)의 안전망이고, P2-83b(늦은 응답 버리기)에서도 요청 횟수·DOM이 그대로여야 한다.
//
// 픽스처는 합성 이름·ID만 쓴다(IP는 문서용 범위 192.0.2.x, 주소는 .test).
// 규칙(의도한 출력 변경에서만 갱신, 리팩터링에서는 갱신 금지): src/core/fixtures/goldenEnv.js
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { createFetchRouter } from '../../../testing/fetchRouter';
import {
  buttonByText, createStepRecorder, deferred, flush, goldenJson, inputByPlaceholder, rowContaining,
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
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const fail = (status: number, error: string): Reply => ({ status, body: { error } });

/** 경로마다 바꿔 끼울 수 있는 응답자 — 단계마다 `routes.set(key, responder)`로 다음 응답을 정한다. */
function setupRouter(initial: Record<string, Responder>) {
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
  globalThis.fetch = router.fetch as typeof fetch;
  return {
    router,
    set(key: string, responder: Responder) {
      if (!responders.has(key)) bind(key);
      responders.set(key, responder);
    },
  };
}

function renderModal(session: Fields = SESSION) {
  const onClose = vi.fn();
  const onPatientAssignmentChanged = vi.fn();
  const view = render(
    <AdminConsoleModal session={session} onClose={onClose} onPatientAssignmentChanged={onPatientAssignmentChanged} />,
  );
  const content = () => view.container.querySelector('.admin-tab-content');
  const tab = (label: string) => buttonByText(view.container, label);
  return { view, content, tab, onClose };
}

function contentOf(get: () => Element | null): HTMLElement {
  const el = get();
  if (!(el instanceof HTMLElement)) throw new Error('tab content not found');
  return el;
}

const EMPTY_AUDIT: Responder = () => ({ body: { total: 0, items: [] } });

// ── 감사 로그 ─────────────────────────────────────────────────────────────────

const AUDIT_PAGE_1 = [
  {
    id: 'audit-1', createdAt: '2026-11-24T01:00:00.000Z', actorUserId: 'user-synthetic-0001', action: 'emr_inject',
    outcome: 'success', targetType: 'emr', targetId: 'emr-target-0001', ip: '192.0.2.10',
    extra: { occurred_at: '2026-11-24T00:30:00.000Z', actor_source: 'session' },
  },
  {
    id: 'audit-2', createdAt: '2026-11-24T01:05:00.000Z', actorUserId: 'user-synthetic-0002', action: 'emr_extract_record',
    outcome: 'success', targetType: 'emr', targetId: 'emr-target-0002', ip: '192.0.2.11',
    extra: { legacy_shell: true, occurred_at_unknown: true, actor_uncertain: true, burst: true },
  },
  {
    id: 'audit-3', createdAt: '2026-11-24T01:10:00.000Z', actorUserId: null, action: 'patient_view',
    outcome: 'failure', targetType: 'patient', targetId: 'patient-synthetic-0003', ip: null, extra: { legacy_shell: true },
  },
  {
    id: 'audit-4', createdAt: null, actorUserId: 'user-synthetic-0004', action: 'login',
    outcome: 'success', targetType: null, targetId: null, ip: '192.0.2.12', extra: {},
  },
];
const AUDIT_PAGE_2 = [
  {
    id: 'audit-5', createdAt: '2026-11-23T09:00:00.000Z', actorUserId: 'user-synthetic-0005', action: 'patient_push',
    outcome: 'success', targetType: 'patient', targetId: 'patient-synthetic-0005', ip: '192.0.2.13', extra: {},
  },
];

describe('관리자 콘솔 특성화 ① — 감사 로그', () => {
  it('열기 · 개수 바꾸기(다시 부르지 않음) · 페이지 · 필터 · 실패 · 빈 목록', async () => {
    const gate = deferred();
    const routes = setupRouter({
      'GET /api/admin/audit': async () => { await gate.promise; return { body: { total: 30, items: AUDIT_PAGE_1 } }; },
    });
    const { view, content, tab } = renderModal();
    const rec = createStepRecorder(routes.router, () => view.container.querySelector('.admin-modal'));
    await flush();
    rec.snap('모달 열기 — 응답 전(기본 탭 = 감사 로그)');
    gate.release();
    await flush();
    rec.snap('모달 열기 — 응답 뒤(총 30건 · 50개씩 → 다음 없음)');

    // 기존 emrAudit 테스트의 단언(비고 열 · 발생 시각 · 서버 표시 · EMR이 아닌 기록에는 비고 없음)
    const table = within(contentOf(content)).getByRole('table');
    expect(within(table).getByRole('columnheader', { name: '비고' })).toBeTruthy();
    const [, first, second, third] = within(table).getAllByRole('row');
    expect(within(first).getByText(/^발생 /)).toBeTruthy();
    expect(within(first).queryByText('옛 설치본')).toBeNull();
    for (const label of ['옛 설치본', '행위자 불확실', '몰아서 전송']) expect(within(second).getByText(label)).toBeTruthy();
    expect(within(second).queryByText(/^발생 /)).toBeNull();
    expect(within(third).queryByText('옛 설치본')).toBeNull();

    const tabRoot = () => contentOf(content);
    const rec2 = createStepRecorder(routes.router, content);
    rec2.skip();

    fireEvent.change(tabRoot().querySelector('select') as HTMLSelectElement, { target: { value: '20' } });
    await flush();
    rec2.snap('개수 20개로 — 요청 없음, 다음 버튼만 생김');

    routes.set('GET /api/admin/audit', (req) => ({
      body: { total: 30, items: req.query.page === '2' ? AUDIT_PAGE_2 : AUDIT_PAGE_1 },
    }));
    fireEvent.click(buttonByText(tabRoot(), '다음'));
    await flush();
    rec2.snap('다음 → 2쪽(개수 20)');
    fireEvent.click(buttonByText(tabRoot(), '이전'));
    await flush();
    rec2.snap('이전 → 1쪽');

    const actionInput = inputByPlaceholder(tabRoot(), '액션 필터 (예: patient_push)');
    const targetInput = inputByPlaceholder(tabRoot(), '대상 유형 (예: patient)');
    fireEvent.change(actionInput, { target: { value: 'emr_inject' } });
    fireEvent.keyDown(actionInput, { key: 'a' });
    await flush();
    rec2.snap('액션 필터 입력(Enter 전 — 요청 없음)');
    fireEvent.keyDown(actionInput, { key: 'Enter' });
    await flush();
    rec2.snap('액션 필터 Enter');
    fireEvent.change(targetInput, { target: { value: 'emr' } });
    fireEvent.keyDown(targetInput, { key: 'Enter' });
    await flush();
    rec2.snap('대상 유형 필터 Enter(두 필터 함께)');

    routes.set('GET /api/admin/audit', () => fail(500, '감사 로그를 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '조회'));
    await flush();
    rec2.snap('조회 실패 — 오류 칸, 목록·쪽 그대로');

    routes.set('GET /api/admin/audit', EMPTY_AUDIT);
    fireEvent.click(buttonByText(tabRoot(), '조회'));
    await flush();
    rec2.snap('조회 성공(빈 목록) — 오류 칸 지워짐');

    expect(routes.router.count('GET /api/admin/audit')).toBe(7);
    expect(routes.router.unhandled).toEqual([]);
    expect(tab('감사 로그').className).toBe('admin-tab-btn admin-tab-btn--active');
    await expect(goldenJson({ open: rec.steps, steps: rec2.steps })).toMatchFileSnapshot('./__goldens__/admin-audit.json');
  });
});

// ── 디바이스 ──────────────────────────────────────────────────────────────────

const device = (over: Fields): Fields => ({
  id: 'device-x', userId: 'user-synthetic-0001', userName: '합성 의사 1', userLoginId: 'synthetic-doc1',
  organizationId: 'org-synthetic-1', buildTarget: 'intranet', status: 'active', registeredAt: '2026-11-01T00:00:00.000Z',
  lastSeenAt: '2026-11-20T03:00:00.000Z', registerIp: '192.0.2.21', suspicious: false, keyPrefix: 'a1b2c3d4', ...over,
});
const DEVICES = [
  device({ id: 'device-1' }),
  device({ id: 'device-2', status: 'pending', userName: '합성 간호사 1', userLoginId: 'synthetic-nurse1', lastSeenAt: null }),
  device({ id: 'device-3', status: 'revoked', userName: '합성 직원 1', userLoginId: 'synthetic-staff1', keyPrefix: 'ffff0000' }),
  device({
    id: 'device-4', status: 'pending', userName: '합성 의사 2', userLoginId: 'synthetic-doc2', buildTarget: 'standalone',
    suspicious: true, keyPrefix: null, registerIp: null, lastSeenAt: null,
  }),
];

describe('관리자 콘솔 특성화 ① — 디바이스', () => {
  it('열기 · 승인(처리 중·성공·해지된 PC 실패) · 불러오기 실패 뒤 취소(성공·실패) · 빈 목록', async () => {
    const gate = deferred();
    const routes = setupRouter({
      'GET /api/admin/audit': EMPTY_AUDIT,
      'GET /api/admin/devices': async () => { await gate.promise; return { body: { devices: DEVICES } }; },
    });
    const { content, tab } = renderModal();
    await flush();
    const rec = createStepRecorder(routes.router, content);
    expect(rec.skip().map(c => `${c.method} ${c.url}`)).toEqual(['GET https://admin.synthetic.test/api/admin/audit?page=1&limit=50']);
    const tabRoot = () => contentOf(content);

    fireEvent.click(tab('디바이스'));
    await flush();
    rec.snap('탭 열기 — 응답 전');
    gate.release();
    await flush();
    rec.snap('탭 열기 — 응답 뒤');

    // 기존 emrAudit 테스트의 단언(PC 열 · 같은 PC 행 수)
    const table = within(tabRoot()).getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'PC' })).toBeTruthy();
    expect(within(table).getAllByText('a1b2c3d4')).toHaveLength(2);
    expect(within(table).getAllByText('같은 PC 2행')).toHaveLength(2);
    expect(within(table).getByText('ffff0000')).toBeTruthy();

    const actGate = deferred();
    routes.set('POST /api/admin/devices/:id/:action', async () => { await actGate.promise; return { body: { ok: true } }; });
    routes.set('GET /api/admin/devices', () => ({ body: { devices: DEVICES } }));
    fireEvent.click(buttonByText(rowContaining(tabRoot(), '합성 간호사 1'), '승인'));
    await flush();
    rec.snap('승인 — 처리 중(그 행 버튼 잠김)');
    actGate.release();
    await flush();
    rec.snap('승인 성공 — 다시 불러옴');

    routes.set('POST /api/admin/devices/:id/:action', () => ({
      status: 409, body: { error: 'This PC has been revoked', code: 'DEVICE_PC_REVOKED' },
    }));
    fireEvent.click(buttonByText(rowContaining(tabRoot(), '합성 의사 2'), '승인'));
    await flush();
    rec.snap('승인 실패 — 해지된 PC 문구');
    // 기존 emrAudit 테스트의 단언(해지된 PC 승인 실패 문구)
    expect(within(tabRoot()).getByText(/해지되어 다시 승인할 수 없습니다/)).toBeTruthy();

    routes.set('GET /api/admin/devices', () => fail(500, '디바이스 목록을 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로고침'));
    await flush();
    rec.snap('새로고침 실패 — 오류 칸, 목록 그대로');
    routes.set('POST /api/admin/devices/:id/:action', () => ({ body: { ok: true } }));
    routes.set('GET /api/admin/devices', () => ({ body: { devices: DEVICES } }));
    fireEvent.click(buttonByText(rowContaining(tabRoot(), '합성 의사 1'), '취소'));
    await flush();
    rec.snap('불러오기 실패 뒤 취소 성공 — 다시 불러오며 오류 칸 지워짐');

    routes.set('GET /api/admin/devices', () => fail(500, '디바이스 목록을 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로고침'));
    await flush();
    routes.set('POST /api/admin/devices/:id/:action', () => fail(500, '디바이스 작업에 실패했습니다(합성).'));
    fireEvent.click(buttonByText(rowContaining(tabRoot(), '합성 의사 1'), '취소'));
    await flush();
    rec.snap('불러오기 실패 뒤 취소 실패 — 오류 칸을 덮어씀');

    routes.set('GET /api/admin/devices', () => ({ body: { devices: [] } }));
    fireEvent.click(buttonByText(tabRoot(), '새로고침'));
    await flush();
    rec.snap('빈 목록');

    expect(routes.router.unhandled).toEqual([]);
    await expect(goldenJson({ steps: rec.steps })).toMatchFileSnapshot('./__goldens__/admin-devices.json');
  });
});

// ── 사용자 관리 ───────────────────────────────────────────────────────────────

const user = (over: Fields): Fields => ({
  id: 'user-x', loginId: 'synthetic-x', name: '합성 사용자', role: 'doctor', disabled: false, mustChangePassword: false,
  createdAt: '2026-10-01T00:00:00.000Z', lastLoginAt: '2026-11-20T00:00:00.000Z', ...over,
});
const USERS = [
  user({ id: 'admin-0001', loginId: 'synthetic-admin', name: '합성 관리자', role: 'admin' }),
  user({ id: 'user-0002', loginId: 'synthetic-doc1', name: '합성 의사 1', mustChangePassword: true, lastLoginAt: null }),
  user({ id: 'user-0003', loginId: 'synthetic-nurse1', name: '합성 간호사 1', role: 'nurse', disabled: true }),
  user({ id: 'user-0004', loginId: 'synthetic-staff1', name: '합성 직원 1', role: 'staff' }),
  user({ id: 'user-0005', loginId: 'synthetic-aud1', name: '합성 감사자 1', role: 'auditor' }),
];
const VALID_PW = 'abab-abab-1'; // 규칙(10자+·문자·숫자·특수문자)을 맞춘 합성 값

describe('관리자 콘솔 특성화 ① — 사용자 관리', () => {
  it('열기 · 생성(검사·처리 중·성공·실패) · 활성 전환 · 비밀번호 초기화 · 불러오기 실패 뒤 전환(성공·실패)', async () => {
    const gate = deferred();
    const routes = setupRouter({
      'GET /api/admin/audit': EMPTY_AUDIT,
      'GET /api/admin/users': async () => { await gate.promise; return { body: { users: USERS } }; },
    });
    const { content, tab } = renderModal();
    await flush();
    const rec = createStepRecorder(routes.router, content);
    rec.skip();
    const tabRoot = () => contentOf(content);
    const ph = (text: string) => inputByPlaceholder(tabRoot(), text);

    fireEvent.click(tab('사용자 관리'));
    await flush();
    rec.snap('탭 열기 — 응답 전');
    gate.release();
    await flush();
    rec.snap('탭 열기 — 응답 뒤(자기 계정 비활성화 잠김)');
    routes.set('GET /api/admin/users', () => ({ body: { users: USERS } }));

    fireEvent.click(buttonByText(tabRoot(), '생성'));
    await flush();
    rec.snap('생성 — 빈 칸(요청 없음)');
    fireEvent.change(ph('로그인 아이디'), { target: { value: 'synthetic-new' } });
    fireEvent.change(ph('이름'), { target: { value: '합성 신규' } });
    fireEvent.change(tabRoot().querySelector('select') as HTMLSelectElement, { target: { value: 'nurse' } });
    const pw = () => ph('임시 비밀번호 (10자+, 숫자·특수문자 포함)');
    // 활성 전환(enable·disable)과 비밀번호 초기화는 같은 꼴의 경로라 응답자 하나가 action으로 가른다.
    let toggle: Responder = () => ({ body: { ok: true } });
    let reset: Responder = () => ({ body: { ok: true } });
    routes.set('POST /api/admin/users/:id/:action', (req) => (req.params.action === 'reset-password' ? reset(req) : toggle(req)));
    for (const [label, value] of [
      ['짧음', 'short-1'], ['문자 없음', '1234567890!'], ['숫자 없음', 'abcdefghij!'], ['특수문자 없음', 'abcdefghij1'],
    ]) {
      fireEvent.change(pw(), { target: { value } });
      fireEvent.click(buttonByText(tabRoot(), '생성'));
      await flush();
      rec.snap(`생성 — 비밀번호 검사(${label}, 요청 없음)`);
    }
    fireEvent.change(pw(), { target: { value: 'short-2' } });
    fireEvent.keyDown(pw(), { key: 'Enter' });
    await flush();
    rec.snap('비밀번호 칸 Enter — 생성과 같은 검사');

    const createGate = deferred();
    routes.set('POST /api/admin/users', async () => { await createGate.promise; return { status: 201, body: { id: 'user-0006' } }; });
    fireEvent.change(pw(), { target: { value: VALID_PW } });
    fireEvent.click(buttonByText(tabRoot(), '생성'));
    await flush();
    rec.snap('생성 — 처리 중');
    createGate.release();
    await flush();
    rec.snap('생성 성공 — 폼 비움·다시 불러옴');

    routes.set('POST /api/admin/users', () => fail(409, '이미 사용 중인 아이디입니다(합성).'));
    fireEvent.change(ph('로그인 아이디'), { target: { value: 'synthetic-doc1' } });
    fireEvent.change(ph('이름'), { target: { value: '합성 중복' } });
    fireEvent.change(pw(), { target: { value: VALID_PW } });
    fireEvent.click(buttonByText(tabRoot(), '생성'));
    await flush();
    rec.snap('생성 실패 — 폼 오류 칸, 폼 그대로');

    const toggleGate = deferred();
    toggle = async () => { await toggleGate.promise; return { body: { ok: true } }; };
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'synthetic-doc1'), '비활성화'));
    await flush();
    rec.snap('비활성화 — 처리 중');
    toggleGate.release();
    await flush();
    rec.snap('비활성화 성공 — 다시 불러옴');
    toggle = () => ({ body: { ok: true } });
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'synthetic-nurse1'), '활성화'));
    await flush();
    rec.snap('활성화 성공');

    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'synthetic-doc1'), '비밀번호 초기화'));
    await flush();
    rec.snap('비밀번호 초기화 — 창 열림');
    const resetInput = () => ph('새 임시 비밀번호 (10자+, 숫자·특수문자 포함)');
    fireEvent.change(resetInput(), { target: { value: 'short-3' } });
    fireEvent.click(buttonByText(tabRoot(), '초기화'));
    await flush();
    rec.snap('비밀번호 초기화 — 검사 실패(요청 없음)');
    reset = () => ({ body: { ok: true } });
    fireEvent.change(resetInput(), { target: { value: VALID_PW } });
    fireEvent.keyDown(resetInput(), { key: 'Enter' });
    await flush();
    rec.snap('비밀번호 초기화 성공(Enter) — 창 닫힘, 목록 다시 부르지 않음');

    reset = () => fail(500, '비밀번호를 초기화하지 못했습니다(합성).');
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'synthetic-staff1'), '비밀번호 초기화'));
    fireEvent.change(resetInput(), { target: { value: VALID_PW } });
    fireEvent.click(buttonByText(tabRoot(), '초기화'));
    await flush();
    rec.snap('비밀번호 초기화 실패 — 창 안 오류 칸');
    fireEvent.click(buttonByText(tabRoot(), '취소'));
    await flush();
    rec.snap('초기화 창 취소');
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'synthetic-staff1'), '비밀번호 초기화'));
    fireEvent.change(resetInput(), { target: { value: 'typed-then-backdrop' } });
    fireEvent.click(tabRoot().querySelector('.admin-inline-modal') as HTMLElement);
    await flush();
    rec.snap('초기화 창 안쪽 클릭 — 그대로');
    fireEvent.click(tabRoot().querySelector('.admin-inline-modal-backdrop') as HTMLElement);
    await flush();
    rec.snap('초기화 창 바깥 클릭 — 닫힘');

    routes.set('GET /api/admin/users', () => fail(500, '사용자 목록을 불러오지 못했습니다(합성).'));
    await reloadUsers();
    rec.snap('불러오기 실패(생성 뒤 다시 불러오기) — 오류 칸, 목록 그대로');
    routes.set('GET /api/admin/users', () => ({ body: { users: USERS } }));
    toggle = () => ({ body: { ok: true } });
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'synthetic-staff1'), '비활성화'));
    await flush();
    rec.snap('불러오기 실패 뒤 전환 성공 — 오류 칸 지워짐');

    routes.set('GET /api/admin/users', () => fail(500, '사용자 목록을 불러오지 못했습니다(합성).'));
    await reloadUsers();
    toggle = () => fail(500, '계정 상태를 바꾸지 못했습니다(합성).');
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'synthetic-staff1'), '비활성화'));
    await flush();
    rec.snap('불러오기 실패 뒤 전환 실패 — 오류 칸을 덮어씀');

    routes.set('GET /api/admin/users', () => ({ body: { users: [] } }));
    await reloadUsers();
    rec.snap('빈 목록');

    expect(routes.router.unhandled).toEqual([]);
    await expect(goldenJson({ steps: rec.steps })).toMatchFileSnapshot('./__goldens__/admin-users.json');

    // 사용자 탭에는 새로고침 버튼이 없다 — 생성 성공(→ load)으로 다시 불러온다.
    async function reloadUsers() {
      routes.set('POST /api/admin/users', () => ({ status: 201, body: { id: 'user-reload' } }));
      fireEvent.change(ph('로그인 아이디'), { target: { value: 'synthetic-reload' } });
      fireEvent.change(ph('이름'), { target: { value: '합성 다시' } });
      fireEvent.change(pw(), { target: { value: VALID_PW } });
      fireEvent.click(buttonByText(tabRoot(), '생성'));
      await flush();
    }
  });
});

// ── 가입 요청 ─────────────────────────────────────────────────────────────────

const signup = (over: Fields): Fields => ({
  id: 'req-x', loginId: 'synthetic-req', name: '합성 신청', requestedRole: 'doctor', note: '', createdAt: '2026-11-25T00:00:00.000Z',
  reviewerName: null, ...over,
});
const PENDING = [
  signup({ id: 'req-1', loginId: 'synthetic-req1', name: '합성 신청 1', note: '합성 메모' }),
  signup({ id: 'req-2', loginId: 'synthetic-req2', name: '합성 신청 2', requestedRole: 'nurse' }),
];
const APPROVED = [signup({ id: 'req-9', loginId: 'synthetic-req9', name: '합성 신청 9', reviewerName: '합성 관리자' })];

describe('관리자 콘솔 특성화 ① — 가입 요청', () => {
  it('열기 · 승인(결과·복사·닫기) · 거절(확인창 취소·확인) · 실패 · 필터 · 불러오기 실패 뒤 승인(성공·실패)', async () => {
    const dialogs: string[] = [];
    let confirmAnswer = false;
    vi.stubGlobal('confirm', (message: string) => { dialogs.push(message); return confirmAnswer; });
    const clipboard: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async (text: string) => { clipboard.push(text); } },
    });
    onTestFinished(() => { Reflect.deleteProperty(navigator, 'clipboard'); });
    const gate = deferred();
    const routes = setupRouter({
      'GET /api/admin/audit': EMPTY_AUDIT,
      'GET /api/admin/signup-requests': async () => { await gate.promise; return { body: { requests: PENDING } }; },
    });
    const { content, tab } = renderModal();
    await flush();
    const rec = createStepRecorder(routes.router, content);
    rec.skip();
    const tabRoot = () => contentOf(content);
    const snap = (step: string) => {
      rec.snap(step, { dialogs: dialogs.splice(0), clipboard: clipboard.splice(0) });
    };

    fireEvent.click(tab('가입 요청'));
    await flush();
    snap('탭 열기 — 응답 전(불러오는 중)');
    gate.release();
    await flush();
    snap('탭 열기 — 응답 뒤(대기 중 · 작업 열)');

    routes.set('POST /api/admin/signup-requests/:id/:action', () => ({
      body: { name: '합성 신청 1', loginId: 'synthetic-req1', tempPassword: 'tmp-tmp-01' },
    }));
    routes.set('GET /api/admin/signup-requests', () => ({ body: { requests: PENDING.slice(1) } }));
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'synthetic-req1'), '승인'));
    await flush();
    snap('승인 성공 — 결과 칸·다시 불러옴');
    fireEvent.click(buttonByText(tabRoot(), '복사'));
    await flush();
    snap('임시 비밀번호 복사');
    fireEvent.click(buttonByText(tabRoot(), '닫기'));
    await flush();
    snap('결과 칸 닫기');

    confirmAnswer = false;
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'synthetic-req2'), '거절'));
    await flush();
    snap('거절 — 확인창에서 취소(요청 없음)');
    confirmAnswer = true;
    routes.set('POST /api/admin/signup-requests/:id/:action', () => ({ body: { ok: true } }));
    routes.set('GET /api/admin/signup-requests', () => ({ body: { requests: [] } }));
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'synthetic-req2'), '거절'));
    await flush();
    snap('거절 — 확인창에서 확인, 다시 불러옴(빈 목록)');

    routes.set('GET /api/admin/signup-requests', () => ({ body: { requests: PENDING } }));
    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    routes.set('POST /api/admin/signup-requests/:id/:action', () => fail(409, '이미 처리된 신청입니다(합성).'));
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'synthetic-req1'), '승인'));
    await flush();
    snap('새로 고침 뒤 승인 실패 — 오류 칸');
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'synthetic-req2'), '거절'));
    await flush();
    snap('거절 실패 — 오류 칸');

    routes.set('GET /api/admin/signup-requests', (req) => ({
      body: { requests: req.query.status === 'approved' ? APPROVED : req.query.status === 'rejected' ? [] : PENDING },
    }));
    const filter = () => tabRoot().querySelector('select') as HTMLSelectElement;
    fireEvent.change(filter(), { target: { value: 'approved' } });
    await flush();
    snap('필터 승인됨 — 작업 열 없음, 오류 칸 지워짐');
    fireEvent.change(filter(), { target: { value: 'rejected' } });
    await flush();
    snap('필터 거절됨 — 빈 목록');
    routes.set('GET /api/admin/signup-requests', () => fail(500, '가입 요청을 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    snap('빈 목록일 때 새로 고침 실패 — 오류 칸·빈 목록 문구');
    routes.set('GET /api/admin/signup-requests', () => ({ body: { requests: PENDING } }));
    fireEvent.change(filter(), { target: { value: 'pending' } });
    await flush();
    snap('필터 대기 중 — 오류 칸 지워짐');

    routes.set('GET /api/admin/signup-requests', () => fail(500, '가입 요청을 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    snap('목록이 있을 때 새로 고침 실패 — 목록 그대로');
    routes.set('POST /api/admin/signup-requests/:id/:action', () => ({
      body: { name: '합성 신청 2', loginId: 'synthetic-req2', tempPassword: 'tmp-tmp-02' },
    }));
    routes.set('GET /api/admin/signup-requests', () => ({ body: { requests: PENDING.slice(0, 1) } }));
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'synthetic-req2'), '승인'));
    await flush();
    snap('불러오기 실패 뒤 승인 성공 — 다시 불러오며 오류 칸 지워짐');

    routes.set('GET /api/admin/signup-requests', () => fail(500, '가입 요청을 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    routes.set('POST /api/admin/signup-requests/:id/:action', () => fail(409, '이미 처리된 신청입니다(합성).'));
    fireEvent.click(buttonByText(rowContaining(tabRoot(), 'synthetic-req1'), '승인'));
    await flush();
    snap('불러오기 실패 뒤 승인 실패 — 오류 칸을 덮어씀');

    expect(routes.router.unhandled).toEqual([]);
    await expect(goldenJson({ steps: rec.steps })).toMatchFileSnapshot('./__goldens__/admin-requests.json');
  });
});

// ── 프리셋 공유 ───────────────────────────────────────────────────────────────

const preset = (over: Fields): Fields => ({
  id: 'preset-x', jobName: '합성 직종', category: '합성 분류', ownerName: '합성 의사 1', organizationId: 'org-synthetic-1',
  visibility: 'private', ...over,
});
const PRESETS = [
  preset({ id: 'preset-1', jobName: '합성 용접공', category: '제조', visibility: 'organization' }),
  preset({ id: 'preset-2', jobName: '합성 간호 직무', category: '보건', ownerName: null }),
  preset({ id: 'preset-3', jobName: '합성 사무직', category: '사무', organizationId: 'org-synthetic-2' }),
];

describe('관리자 콘솔 특성화 ① — 프리셋 공유', () => {
  it('열기 · 검색·공개 범위 필터(선택 비움) · 선택·전체 선택 · 전환(취소·처리 중·성공·실패) · 불러오기 실패 뒤 전환', async () => {
    const gate = deferred();
    const routes = setupRouter({
      'GET /api/admin/audit': EMPTY_AUDIT,
      'GET /api/admin/presets': async () => { await gate.promise; return { body: { presets: PRESETS } }; },
    });
    const { content, tab } = renderModal();
    await flush();
    const rec = createStepRecorder(routes.router, content);
    rec.skip();
    const tabRoot = () => contentOf(content);
    const check = (label: string) => within(tabRoot()).getByRole('checkbox', { name: label });

    fireEvent.click(tab('프리셋 공유'));
    await flush();
    rec.snap('탭 열기 — 응답 전');
    gate.release();
    await flush();
    rec.snap('탭 열기 — 응답 뒤(조직에 묶인 관리자 — 조직 열 없음)');
    routes.set('GET /api/admin/presets', () => ({ body: { presets: PRESETS } }));

    fireEvent.click(check('합성 용접공 선택'));
    await flush();
    rec.snap('하나 선택 — 전환 버튼 풀림');
    fireEvent.change(inputByPlaceholder(tabRoot(), '직종명 검색'), { target: { value: '간호' } });
    await flush();
    rec.snap('검색 "간호" — 선택 비움');
    fireEvent.change(inputByPlaceholder(tabRoot(), '직종명 검색'), { target: { value: '없는 직종' } });
    await flush();
    rec.snap('검색 결과 없음 — 전체 선택 잠김');
    fireEvent.change(inputByPlaceholder(tabRoot(), '직종명 검색'), { target: { value: '' } });
    fireEvent.change(tabRoot().querySelector('select') as HTMLSelectElement, { target: { value: 'private' } });
    await flush();
    rec.snap('공개 범위 비공개');
    fireEvent.click(check('전체 선택'));
    await flush();
    rec.snap('전체 선택(보이는 것만)');
    fireEvent.change(tabRoot().querySelector('select') as HTMLSelectElement, { target: { value: 'all' } });
    await flush();
    rec.snap('공개 범위 전체 — 선택 비움');
    fireEvent.click(check('전체 선택'));
    fireEvent.click(check('전체 선택'));
    await flush();
    rec.snap('전체 선택 두 번 — 모두 해제');

    fireEvent.click(check('합성 간호 직무 선택'));
    fireEvent.click(check('합성 사무직 선택'));
    fireEvent.click(buttonByText(tabRoot(), '선택 → 조직 공유'));
    await flush();
    rec.snap('조직 공유로 — 확인 줄');
    fireEvent.click(buttonByText(tabRoot(), '취소'));
    await flush();
    rec.snap('확인 줄 취소 — 선택 그대로');
    fireEvent.click(buttonByText(tabRoot(), '선택 → 비공개(소유자만)'));
    fireEvent.click(check('합성 사무직 선택'));
    await flush();
    rec.snap('확인 줄에서 선택을 바꾸면 확인 줄 닫힘');

    const convertGate = deferred();
    routes.set('POST /api/admin/presets/visibility', async () => {
      await convertGate.promise;
      return { body: { requested: 2, updated: 1 } };
    });
    fireEvent.click(check('합성 사무직 선택'));
    fireEvent.click(buttonByText(tabRoot(), '선택 → 조직 공유'));
    fireEvent.click(buttonByText(tabRoot(), '확인'));
    await flush();
    rec.snap('전환 — 처리 중');
    convertGate.release();
    await flush();
    rec.snap('전환 성공 — 상태 문구·다시 불러옴(선택 비움)');

    routes.set('POST /api/admin/presets/visibility', () => fail(500, '공개 범위를 바꾸지 못했습니다(합성).'));
    fireEvent.click(check('합성 용접공 선택'));
    fireEvent.click(buttonByText(tabRoot(), '선택 → 비공개(소유자만)'));
    await flush();
    rec.snap('비공개로 — 확인 줄(상태 문구 지워짐)');
    fireEvent.click(buttonByText(tabRoot(), '확인'));
    await flush();
    rec.snap('전환 실패 — 오류 칸, 선택·확인 줄 그대로');

    routes.set('GET /api/admin/presets', () => fail(500, '프리셋 목록을 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    rec.snap('새로 고침 실패 — 오류 칸, 목록 그대로(선택 비움)');
    routes.set('GET /api/admin/presets', () => ({ body: { presets: PRESETS } }));
    routes.set('POST /api/admin/presets/visibility', () => ({ body: { requested: 1, updated: 1 } }));
    fireEvent.click(check('합성 용접공 선택'));
    fireEvent.click(buttonByText(tabRoot(), '선택 → 비공개(소유자만)'));
    await flush();
    rec.snap('불러오기 실패 뒤 전환 준비 — 확인 줄을 열면 오류 칸 지워짐');
    fireEvent.click(buttonByText(tabRoot(), '확인'));
    await flush();
    rec.snap('불러오기 실패 뒤 전환 성공');

    routes.set('GET /api/admin/presets', () => fail(500, '프리셋 목록을 불러오지 못했습니다(합성).'));
    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    routes.set('POST /api/admin/presets/visibility', () => fail(500, '공개 범위를 바꾸지 못했습니다(합성).'));
    fireEvent.click(check('합성 용접공 선택'));
    fireEvent.click(buttonByText(tabRoot(), '선택 → 조직 공유'));
    fireEvent.click(buttonByText(tabRoot(), '확인'));
    await flush();
    rec.snap('불러오기 실패 뒤 전환 실패 — 오류 칸');

    routes.set('GET /api/admin/presets', () => ({ body: {} }));
    fireEvent.click(buttonByText(tabRoot(), '새로 고침'));
    await flush();
    rec.snap('presets 없는 응답 — 빈 목록');

    expect(routes.router.unhandled).toEqual([]);
    await expect(goldenJson({ steps: rec.steps })).toMatchFileSnapshot('./__goldens__/admin-presets.json');
  });

  it('조직에 묶이지 않은 관리자 — 조직 열', async () => {
    const routes = setupRouter({
      'GET /api/admin/audit': EMPTY_AUDIT,
      'GET /api/admin/presets': () => ({ body: { presets: PRESETS } }),
    });
    const { content, tab } = renderModal({ ...SESSION, user: { ...SESSION.user, organizationId: null } });
    await flush();
    const rec = createStepRecorder(routes.router, content);
    rec.skip();
    fireEvent.click(tab('프리셋 공유'));
    await flush();
    rec.snap('탭 열기 — 조직 열');
    routes.set('GET /api/admin/presets', () => ({ body: { presets: [] } }));
    fireEvent.click(buttonByText(contentOf(content), '새로 고침'));
    await flush();
    rec.snap('빈 목록 — 칸 6개');
    expect(routes.router.unhandled).toEqual([]);
    await expect(goldenJson({ steps: rec.steps })).toMatchFileSnapshot('./__goldens__/admin-presets-superadmin.json');
  });
});
