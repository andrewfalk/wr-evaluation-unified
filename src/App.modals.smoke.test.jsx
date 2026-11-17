// @vitest-environment jsdom
//
// G9m — 모달 열기/닫기 스모크(REFACTORING_ROADMAP Phase 2 P2-44a, C3-C 선행 특성화). C3-C는 App이 AppModals에 넘기던
// props 62개를 ModalHost(Context 소비)로 옮긴다 — 모달마다 "여는 버튼 → 모달 → 닫는 버튼"과 이름만 같은 별칭
// (`handleSaveSettings` = 저장 뒤 창 닫기, `logout` = 가드된 로그아웃)을 옮기기 전에 고정한다.
// 리팩터링 PR에서 이 파일의 단언이 실패하면 동작이 바뀐 것이다 — 코드를 고친다.
//
// 규칙(G9와 같음): 단언은 역할·화면 텍스트로만. 클래스명·DOM 스냅샷·내부 훅 mock 금지. 네트워크는 createFetchRouter
// (등록 안 된 요청은 실패·기록 — 테스트 끝에 0), 저장소는 jsdom localStorage. 렌더는 AppRoot(StrictMode).
// 충돌 모달 2종(PatientIdentityConflictModal·ConflictResolveModal)은 G9w에 충돌 사례가 없어 여기서 다루지 않는다 —
// P2-45a가 옛 AppModals와 새 ModalHost에 같은 값을 주고 같은 DOM인지 대조한다(계획 P2-44a ①).
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
const [KIM] = goldenPatients;

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
const heading = (name) => screen.queryByRole('heading', { name });
/** 모달 제목(heading)이 보일 때까지 기다려 그 모달 상자(제목을 품은 가장 가까운 조상 중 닫기 버튼이 있는 것)를 돌려준다. */
async function openedModal(name, closeLabel) {
  let el = await screen.findByRole('heading', { name });
  while (el && !within(el).queryByRole('button', { name: closeLabel })) el = el.parentElement;
  if (!el) throw new Error(`openedModal: ${name} 둘레에 ${closeLabel} 버튼이 없음`);
  return el;
}

// ---------------------------------------------------------------------------
// G9m-a — 웹 로컬(랜딩·작업 화면 두 렌더 위치)
// ---------------------------------------------------------------------------
function webLocalRouter() {
  return trackRouter(createFetchRouter({ 'GET /job-presets.json': jobPresets }));
}

async function bootWithThree() {
  localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify({ savedAt: '2026-11-01T01:02:03.000Z', patients: goldenPatients.slice(0, 3) }));
  const app = renderApp({ router: webLocalRouter(), confirm: () => true });
  await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (3)'));
  await screen.findByDisplayValue(KIM.data.shared.patientNo);
  return app;
}

describe('G9m-a — 웹 로컬', () => {
  it('G9m-a1 랜딩에서 설정 → 취소: 창이 닫히고 랜딩에 남는다', async () => {
    renderApp({ router: webLocalRouter() });
    fireEvent.click(await screen.findByRole('button', { name: '설정' }));
    const modal = await openedModal('설정', '취소');
    fireEvent.click(within(modal).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(heading('설정')).toBeNull());
    expect(screen.getByRole('button', { name: '+ 새환자' })).toBeTruthy();
  });

  it('G9m-a2 설정 저장 → 창이 닫히고 저장한 값이 다시 열 때 남아 있다', async () => {
    await bootWithThree();
    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    const modal = await openedModal('설정', '취소');
    const hospital = within(within(modal).getByText('병원명').parentElement).getByRole('textbox');
    fireEvent.change(hospital, { target: { value: '스모크병원' } });
    fireEvent.click(within(modal).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(heading('설정')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    const reopened = await openedModal('설정', '취소');
    expect(within(reopened).getByDisplayValue('스모크병원')).toBeTruthy();
  });

  it('G9m-a3 저장 창: 열기 → 취소', async () => {
    await bootWithThree();
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    const modal = await openedModal('저장', '취소');
    expect(within(modal).getByRole('heading', { name: '새 저장' })).toBeTruthy();
    fireEvent.click(within(modal).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(heading('저장')).toBeNull());
  });

  it('G9m-a4 불러오기 창: 열기 → 닫기', async () => {
    await bootWithThree();
    fireEvent.click(screen.getByRole('button', { name: '불러오기' }));
    const modal = await openedModal('불러오기', '닫기');
    fireEvent.click(within(modal).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(heading('불러오기')).toBeNull());
  });

  it('G9m-a5 일괄 가져오기(지연 로드): 사이드바 "일괄" → 열기 → 취소', async () => {
    await bootWithThree();
    fireEvent.click(screen.getByRole('button', { name: '일괄' }));
    const modal = await openedModal('일괄 Import', '취소');
    fireEvent.click(within(modal).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(heading('일괄 Import')).toBeNull());
  });

  it('G9m-a6 프리셋 저장 창: 직업의 "프리셋 저장" → 열기 → 취소', async () => {
    await bootWithThree();
    fireEvent.click(screen.getAllByRole('button', { name: '프리셋 저장' })[0]);
    const modal = await openedModal('프리셋 저장', '취소');
    fireEvent.click(within(modal).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(heading('프리셋 저장')).toBeNull());
  });

  it('G9m-a7 프리셋 조회 창: 직업의 "프리셋 조회" → 열기 → 취소', async () => {
    await bootWithThree();
    fireEvent.click(screen.getAllByRole('button', { name: '프리셋 조회' })[0]);
    const modal = await openedModal('프리셋 조회', '취소');
    fireEvent.click(within(modal).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(heading('프리셋 조회')).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// G9m-b — 인트라넷(웹): 계정 메뉴·관리자 콘솔·마이그레이션 보고
// ---------------------------------------------------------------------------
const BASE = 'https://srv.test';
const SETTINGS_KEY = 'wrEvalUnifiedSettings';
const SESSION_KEY = 'wrEvalUnifiedAuthSession';
const DOCTOR = { id: 'u-doc-1', displayName: '김의사', role: 'doctor', organizationId: 'org-1' };
const ADMIN = { id: 'u-adm-1', displayName: '박관리', role: 'admin', organizationId: 'org-1' };
const PUBLIC_CONFIG = {
  mode: 'intranet', aiEnabled: false, localFallbackAllowed: false,
  videoAnalysisEnabled: false, statsWorkbenchEnabled: false, statsWorkbenchAvailable: false,
  serverTime: '2026-11-14T00:00:00.000Z',
};

function seedIntranet(user) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ integrationMode: 'intranet', apiBaseUrl: BASE }));
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    version: 1, mode: 'intranet', status: 'ready', apiBaseUrl: BASE,
    refreshedAt: '2026-11-13T00:00:00.000Z', user: { ...user, authProvider: 'intranet' },
  }));
}

function toServer(p, user) {
  const at = '2026-11-10T00:00:00.000Z';
  return {
    ...p, assignedDoctorUserId: user.id, updatedAt: at, completionStatus: 'incomplete',
    serverObservedModulesCompleteAt: null, serverVerifiedModulesCompleteAt: null,
    sync: { serverId: p.id, revision: 1, syncStatus: 'synced', lastSyncedAt: at },
  };
}

function intranetRouter(user, extra = {}) {
  const items = goldenPatients.slice(0, 2).map((p) => toServer(p, user));
  return trackRouter(createFetchRouter({
    'GET /job-presets.json': jobPresets,
    'GET /api/config/public': PUBLIC_CONFIG,
    'POST /api/auth/csrf': { accessToken: 'tok-1', accessExpiresAt: '2099-01-01T00:00:00.000Z', user },
    'GET /api/mock/status': () => ({ status: 404, body: { error: 'Not found' } }),
    'GET /api/auth/me': { user, capabilities: [] },
    'GET /api/presets': { presets: [] },
    'GET /api/patients/doctor-counts': { doctors: [{ userId: DOCTOR.id, name: DOCTOR.displayName, count: 2 }], unassignedCount: 0 },
    'GET /api/workspaces': { items: [] },
    'GET /api/patients': { items, total: items.length },
    'POST /api/patients/:id/lock': { leaseToken: 'lease-1', expiresAt: '2099-01-01T00:00:00.000Z', ttlMs: 60000 },
    'DELETE /api/patients/:id/lock': () => ({ status: 204 }),
    ...extra,
  }));
}

async function bootIntranet(user, extra) {
  seedIntranet(user);
  const router = intranetRouter(user, extra);
  const app = renderApp({ router, confirm: () => true });
  await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (2)'));
  await screen.findByDisplayValue(KIM.data.shared.patientNo);
  return { app, router };
}

function openAccountMenu(user) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(user.displayName) }));
}

describe('G9m-b — 인트라넷(웹)', () => {
  it('G9m-b1 내 계정 → "비밀번호 변경": 계정 창이 닫히고 비밀번호 변경 창이 열린다 → 취소', async () => {
    await bootIntranet(DOCTOR);
    openAccountMenu(DOCTOR);
    fireEvent.click(screen.getByRole('button', { name: '내 계정' }));
    await openedModal('내 계정', '✕');
    // 계정 메뉴(드롭다운)는 항목을 누르면 닫힌다 — 화면의 "비밀번호 변경"은 계정 창의 것 하나뿐.
    fireEvent.click(screen.getByRole('button', { name: '비밀번호 변경' }));
    const password = await openedModal('비밀번호 변경', '취소');
    expect(heading('내 계정')).toBeNull();
    fireEvent.click(within(password).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(heading('비밀번호 변경')).toBeNull());
  });

  it('G9m-b2 계정 메뉴의 비밀번호 변경: 열기 → 취소', async () => {
    await bootIntranet(DOCTOR);
    openAccountMenu(DOCTOR);
    fireEvent.click(screen.getByRole('button', { name: '비밀번호 변경' }));
    const modal = await openedModal('비밀번호 변경', '취소');
    fireEvent.click(within(modal).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(heading('비밀번호 변경')).toBeNull());
  });

  it('G9m-b3 내 계정 창 ✕로 닫기', async () => {
    await bootIntranet(DOCTOR);
    openAccountMenu(DOCTOR);
    fireEvent.click(screen.getByRole('button', { name: '내 계정' }));
    const profile = await openedModal('내 계정', '✕');
    fireEvent.click(within(profile).getByRole('button', { name: '✕' }));
    await waitFor(() => expect(heading('내 계정')).toBeNull());
  });

  it('G9m-b4 설정 → "서버로 이전": 설정 창이 닫히고 마이그레이션 창이 열린다 → 취소', async () => {
    await bootIntranet(DOCTOR);
    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    const settings = await openedModal('설정', '취소');
    fireEvent.click(within(settings).getByRole('button', { name: '이 PC의 로컬 환자 데이터를 서버로 이전' }));
    const migration = await openedModal('로컬 데이터 서버 마이그레이션', '취소');
    expect(heading('설정')).toBeNull();
    fireEvent.click(within(migration).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(heading('로컬 데이터 서버 마이그레이션')).toBeNull());
  });

  // C6 — 모달의 `logout`은 가드된 로그아웃(저장되지 않은 환자 확인)이다. 설정 창 경로는 App.accountSwitch.smoke의 R11이 지킨다.
  it('G9m-b6 내 계정 창의 로그아웃: 저장되지 않은 환자가 있으면 묻고, 취소하면 로그아웃 요청을 보내지 않는다', async () => {
    const UNSAVED = '저장되지 않은 환자가 1명 있습니다. 로그아웃하면 이 내용은 사라집니다. 로그아웃할까요?';
    seedIntranet(DOCTOR);
    const router = intranetRouter(DOCTOR, {
      'PATCH /api/patients/:id': () => new Promise(() => {}), // 저장이 끝나지 않아 저장 대기로 남는다
      'POST /api/auth/logout': () => ({ status: 204 }),
    });
    const app = renderApp({ router, confirm: (msg) => msg !== UNSAVED });
    await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (2)'));
    await screen.findByDisplayValue(KIM.data.shared.patientNo);
    await waitFor(() => expect(router.count('POST /api/patients/:id/lock')).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 100));
    fireEvent.change(screen.getByDisplayValue(KIM.data.shared.name), { target: { value: '김철수수정' } });
    openAccountMenu(DOCTOR);
    fireEvent.click(screen.getByRole('button', { name: '내 계정' }));
    await openedModal('내 계정', '✕');
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    await waitFor(() => expect(app.dialogs.confirms).toContain(UNSAVED));
    await new Promise((r) => setTimeout(r, 200));
    expect(router.count('POST /api/auth/logout')).toBe(0);
    expect(screen.getByDisplayValue('김철수수정')).toBeTruthy();
  }, 20000);

  it('G9m-b5 관리자: 계정 메뉴의 관리자 콘솔 → 열기 → 닫기', async () => {
    await bootIntranet(ADMIN, {
      'GET /api/admin/ops/backup-status': { monitorReport: null },
      'GET /api/admin/audit': { items: [], total: 0 },
      'GET /api/admin/devices': { devices: [] },
      'GET /api/admin/users': { users: [] },
      'GET /api/admin/org-settings': { settings: {} },
      'GET /api/admin/presets': { presets: [] },
      'GET /api/capabilities/catalog': { capabilities: [] },
      'GET /api/capabilities/grants': { grants: [] },
    });
    openAccountMenu(ADMIN);
    fireEvent.click(screen.getByRole('button', { name: '관리자 콘솔' }));
    const modal = await openedModal('관리자 콘솔', '닫기');
    fireEvent.click(within(modal).getAllByRole('button', { name: '닫기' }).at(-1));
    await waitFor(() => expect(heading('관리자 콘솔')).toBeNull());
  });
});
