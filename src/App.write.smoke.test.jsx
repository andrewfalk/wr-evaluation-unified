// @vitest-environment jsdom
//
// G9w — App 쓰기 경로 스모크(REFACTORING_ROADMAP Phase 2 P2-31b, 게이트 A 계획 A7). G9(App.smoke.test.jsx)는 값 교체·pull
// 병합·환자 전환만 지난다 — C4(환자 상태 컨테이너, P2-32~39)가 바꾸는 쓰기 경로(필드 편집·추가·삭제·다중 선택·
// 초기화·push)를 컨테이너 교체 전에 먼저 고정한다. 리팩터링 PR에서 이 파일의 단언이 실패하면 동작이 바뀐 것이다.
//
// 규칙(G9와 같음): 단언은 역할·화면 텍스트로만. 클래스명·DOM 스냅샷·내부 훅 mock 금지. 네트워크는 createFetchRouter
// (등록 안 된 요청은 실패·기록 — 테스트 끝에 0), 저장소는 jsdom localStorage.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { renderApp, resetAppEnvironment } from './testing/renderApp';
import { createFetchRouter } from './testing/fetchRouter';
import goldenPatients from './core/fixtures/goldenPatients.json';

// G9와 같은 이유(P2-09): 다른 worker의 BroadcastChannel('wr-auth') 메시지가 닿지 않게 정적 import보다 먼저 설치.
await vi.hoisted(async () => (await import('./testing/fakeBroadcastChannel.js')).installFakeBroadcastChannel());

configure({ asyncUtilTimeout: 5000 });

const jobPresets = JSON.parse(readFileSync('public/job-presets.json', 'utf8'));
const AUTO_SAVE_KEY = 'wrEvalUnifiedAutoSave';
const [KIM, LEE, PARK] = goldenPatients; // 김철수 WR240001(무릎) · 이영미 WR240002(무릎+요추) · 박준호 WR240003(요추)

const routers = [];
function trackRouter(router) {
  routers.push(router);
  return router;
}

afterEach(() => {
  try {
    for (const router of routers) expect(router.unhandled, 'unregistered requests').toEqual([]);
  } finally {
    routers.length = 0;
    resetAppEnvironment();
  }
});

const patientList = () => screen.getByText(/^환자 목록 \(\d+\)$/);
const nameOf = (p) => p.data.shared.name;
const patientNoOf = (p) => p.data.shared.patientNo;

/** text를 가진 요소에서 위로 올라가며 role(+name) 요소를 처음 품는 조상을 찾는다 — 사이드바의 그 환자 행·선택 줄. */
function containerOf(text, role, options) {
  let el = screen.getByText(text);
  while (el && !within(el).queryByRole(role, options)) el = el.parentElement;
  if (!el) throw new Error(`containerOf: ${text} 둘레에 ${role}이 없음`);
  return el;
}
const rowOf = (name) => containerOf(name, 'checkbox');

// ---------------------------------------------------------------------------
// G9w-a — 웹 로컬
// ---------------------------------------------------------------------------
function webLocalRouter() {
  return trackRouter(createFetchRouter({ 'GET /job-presets.json': jobPresets }));
}

async function bootWithThree() {
  localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify({ savedAt: '2026-11-01T01:02:03.000Z', patients: goldenPatients.slice(0, 3) }));
  const app = renderApp({ router: webLocalRouter(), confirm: () => true });
  await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (3)'));
  await screen.findByDisplayValue(patientNoOf(KIM));
  return app;
}

describe('G9w-a — 웹 로컬 쓰기', () => {
  it('G9w-a1 활성 환자 이름 편집이 사이드바에 반영된다', async () => {
    await bootWithThree();
    fireEvent.change(screen.getByDisplayValue(nameOf(KIM)), { target: { value: '김철수수정' } });
    expect(await within(rowOf('김철수수정')).findByText(`#${patientNoOf(KIM)}`)).toBeTruthy();
    expect(screen.queryByText(nameOf(KIM))).toBeNull();
    // 다른 환자는 그대로
    expect(screen.getByText(nameOf(LEE))).toBeTruthy();
    expect(screen.getByText(nameOf(PARK))).toBeTruthy();
  });

  it('G9w-a2 위자드 완료로 1명 추가되고 그 환자가 활성이 된다', async () => {
    await bootWithThree();
    fireEvent.click(screen.getByRole('button', { name: '+ 추가' }));
    await screen.findByRole('heading', { name: '새 환자 평가' });
    fireEvent.change(screen.getByPlaceholderText('등록번호'), { target: { value: 'WR-NEW-1' } });
    fireEvent.click(screen.getByRole('button', { name: /다음: 상병 입력/ }));
    fireEvent.click(await screen.findByRole('button', { name: /다음: 모듈 선택/ }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /어깨/ }));
    fireEvent.click(screen.getByRole('button', { name: '평가 시작 (1개 모듈)' }));

    await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (4)'));
    expect(screen.queryByRole('heading', { name: '새 환자 평가' })).toBeNull();
    // 새 환자(이름 없음 → "환자 #4")가 목록 끝에, 단계 표시는 그 환자의 모듈(어깨)
    expect(within(rowOf('환자 #4')).getByText('#WR-NEW-1')).toBeTruthy();
    expect(screen.getByText('🙆 어깨')).toBeTruthy();
    expect(screen.queryByText('🏃 무릎 (슬관절)')).toBeNull();
  });

  it('G9w-a3 활성 환자 1명 삭제 → 확인창 → 남은 첫 환자가 활성', async () => {
    const app = await bootWithThree();
    fireEvent.click(within(rowOf(nameOf(KIM))).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (2)'));
    expect(app.dialogs.confirms).toContain('이 환자를 삭제하시겠습니까?');
    expect(screen.queryByText(nameOf(KIM))).toBeNull();
    expect(await screen.findByDisplayValue(patientNoOf(LEE))).toBeTruthy();
  });

  it('G9w-a4 비활성 환자 다중 선택 삭제 → 선택 해제, 활성 환자 유지', async () => {
    const app = await bootWithThree();
    fireEvent.click(within(rowOf(nameOf(LEE))).getByRole('checkbox'));
    fireEvent.click(within(rowOf(nameOf(PARK))).getByRole('checkbox'));
    expect(screen.getByText('전체선택 (2)')).toBeTruthy();
    fireEvent.click(within(containerOf('전체선택 (2)', 'button', { name: '삭제' })).getByRole('button', { name: '삭제' }));

    await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (1)'));
    expect(app.dialogs.confirms).toContain('선택된 2명의 환자를 삭제하시겠습니까?');
    expect(screen.getByText('전체선택')).toBeTruthy();
    expect(screen.getByText(nameOf(KIM))).toBeTruthy();
    expect(screen.getByDisplayValue(patientNoOf(KIM))).toBeTruthy();
  });

  it('G9w-a5 전체 선택 삭제는 "최소 1명 유지" 안내로 막힌다', async () => {
    const app = await bootWithThree();
    fireEvent.click(within(containerOf('전체선택', 'checkbox')).getByRole('checkbox'));
    expect(screen.getByText('전체선택 (3)')).toBeTruthy();
    fireEvent.click(within(containerOf('전체선택 (3)', 'button', { name: '삭제' })).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(app.dialogs.alerts).toContain('최소 1명의 환자는 유지해야 합니다'));
    expect(patientList().textContent).toBe('환자 목록 (3)');
  });

  it('G9w-a6 초기화 → 확인창 → 랜딩, 목록 없음', async () => {
    const app = await bootWithThree();
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));
    await screen.findByRole('button', { name: '+ 새환자' });
    expect(app.dialogs.confirms).toContain('현재 작업 중인 환자 목록을 모두 삭제하시겠습니까?');
    expect(screen.queryByText(/^환자 목록 \(\d+\)$/)).toBeNull();
    expect(screen.queryByRole('button', { name: /작업 목록 돌아가기/ })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// G9w-b — 인트라넷(웹): push·pull·삭제 요청
// ---------------------------------------------------------------------------
const BASE = 'https://srv.test';
const SETTINGS_KEY = 'wrEvalUnifiedSettings';
const SESSION_KEY = 'wrEvalUnifiedAuthSession';
const DOCTOR = { id: 'u-doc-1', displayName: '김의사', role: 'doctor', organizationId: 'org-1' };
const PUBLIC_CONFIG = {
  mode: 'intranet', aiEnabled: false, localFallbackAllowed: false,
  videoAnalysisEnabled: false, statsWorkbenchEnabled: false, statsWorkbenchAvailable: false,
  serverTime: '2026-11-14T00:00:00.000Z',
};
const BOOT_CSRF_LIMIT = 2;

function seedIntranet() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ integrationMode: 'intranet', apiBaseUrl: BASE }));
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    version: 1, mode: 'intranet', status: 'ready', apiBaseUrl: BASE,
    refreshedAt: '2026-11-13T00:00:00.000Z', user: { ...DOCTOR, authProvider: 'intranet' },
  }));
}

function toServer(p, revision = 1) {
  const at = '2026-11-10T00:00:00.000Z';
  return {
    ...p, assignedDoctorUserId: DOCTOR.id, updatedAt: at, completionStatus: 'incomplete',
    serverObservedModulesCompleteAt: null, serverVerifiedModulesCompleteAt: null,
    sync: { serverId: p.id, revision, syncStatus: 'synced', lastSyncedAt: at },
  };
}

/** 서버 상태를 들고 있는 라우터 — PATCH가 revision을 올리고, 이후 pull은 최신 상태를 돌려준다. */
function intranetServer(initial) {
  const server = new Map(initial.map((p) => [p.id, toServer(p)]));
  const router = trackRouter(createFetchRouter({
    'GET /job-presets.json': jobPresets,
    'GET /api/config/public': PUBLIC_CONFIG,
    'POST /api/auth/csrf': { accessToken: 'tok-1', accessExpiresAt: '2099-01-01T00:00:00.000Z', user: DOCTOR },
    'GET /api/mock/status': () => ({ status: 404, body: { error: 'Not found' } }),
    'GET /api/auth/me': { user: DOCTOR, capabilities: [] },
    'GET /api/presets': { presets: [] },
    'GET /api/patients/doctor-counts': () => ({ body: { doctors: [{ userId: DOCTOR.id, name: DOCTOR.displayName, count: server.size }], unassignedCount: 0 } }),
    'GET /api/workspaces': { items: [] },
    'POST /api/patients/:id/lock': { leaseToken: 'lease-1', expiresAt: '2099-01-01T00:00:00.000Z', ttlMs: 60000 },
    'DELETE /api/patients/:id/lock': () => ({ status: 204 }),
    'GET /api/patients': () => {
      const items = [...server.values()];
      return { body: { items, total: items.length } };
    },
    'PATCH /api/patients/:id': (req) => {
      const current = server.get(req.params.id);
      const next = {
        ...current, data: req.body.data, updatedAt: '2026-11-14T00:00:01.000Z',
        sync: { ...current.sync, revision: current.sync.revision + 1, lastSyncedAt: '2026-11-14T00:00:01.000Z' },
      };
      server.set(req.params.id, next);
      return { body: next };
    },
    'DELETE /api/patients/:id': (req) => {
      server.delete(req.params.id);
      return { status: 204 };
    },
  }));
  return { router, server };
}

async function bootIntranet(initial) {
  seedIntranet();
  const { router, server } = intranetServer(initial);
  const app = renderApp({ router, confirm: () => true });
  await waitFor(() => expect(patientList().textContent).toBe(`환자 목록 (${initial.length})`));
  await screen.findByDisplayValue(patientNoOf(initial[0]));
  // 활성 환자의 편집 락을 얻은 뒤에야 입력이 막히지 않는다.
  await waitFor(() => expect(router.count('POST /api/patients/:id/lock')).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 100));
  return { app, router, server };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('G9w-b — 인트라넷 쓰기', () => {
  it('G9w-b1 편집 → 1초 debounce 뒤 PATCH 1회(If-Match·락 토큰) → ack 뒤 재전송 없음', async () => {
    const { router } = await bootIntranet([KIM, LEE]);
    expect(router.count('PATCH /api/patients/:id')).toBe(0);

    fireEvent.change(screen.getByDisplayValue(nameOf(KIM)), { target: { value: '김철수수정' } });
    await wait(500);
    expect(router.count('PATCH /api/patients/:id')).toBe(0);
    await waitFor(() => expect(router.count('PATCH /api/patients/:id')).toBe(1), { timeout: 3000 });

    const patch = router.calls.find((c) => c.method === 'PATCH');
    expect(patch.path).toBe(`/api/patients/${KIM.id}`);
    expect(patch.headers['If-Match']).toBe('1');
    expect(patch.headers['X-Lock-Token']).toBe('lease-1');
    expect(patch.body.data.shared.name).toBe('김철수수정');

    // ack(revision 2) 반영 뒤에는 다시 보내지 않는다 — debounce 창을 두 번 넘겨도 1회.
    await wait(2500);
    expect(router.count('PATCH /api/patients/:id')).toBe(1);
    expect(screen.getByText('김철수수정')).toBeTruthy();
    expect(router.count('POST /api/auth/csrf')).toBeLessThanOrEqual(BOOT_CSRF_LIMIT);
  }, 20000);

  it('G9w-b2 pull에서 활성 환자가 사라지면(서버에서 빠짐) 남은 첫 환자로 바뀐다', async () => {
    const { router, server } = await bootIntranet([KIM, LEE]);
    server.delete(KIM.id);
    const pullsBefore = router.count('GET /api/patients');
    fireEvent.focus(window);
    await waitFor(() => expect(router.count('GET /api/patients')).toBeGreaterThan(pullsBefore));
    await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (1)'));
    expect(screen.queryByText(nameOf(KIM))).toBeNull();
    expect(await screen.findByDisplayValue(patientNoOf(LEE))).toBeTruthy();
  }, 20000);

  it('G9w-b3 활성 환자 삭제 → DELETE(revision·락 토큰) → 목록에서 빠지고 남은 환자가 활성', async () => {
    const { app, router } = await bootIntranet([KIM, LEE]);
    fireEvent.click(within(rowOf(nameOf(KIM))).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (1)'));
    expect(app.dialogs.confirms).toContain('이 환자를 삭제하시겠습니까?');

    const deletes = router.calls.filter((c) => c.method === 'DELETE' && c.route === 'DELETE /api/patients/:id');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].path).toBe(`/api/patients/${KIM.id}`);
    expect(deletes[0].query).toEqual({ revision: '1' });
    expect(deletes[0].headers['X-Lock-Token']).toBe('lease-1');
    expect(await screen.findByDisplayValue(patientNoOf(LEE))).toBeTruthy();
  }, 20000);
});
