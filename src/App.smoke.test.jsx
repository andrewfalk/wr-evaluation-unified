// @vitest-environment jsdom
//
// G9 — App 스모크 골든(REFACTORING_ROADMAP Phase 2 P2-03·P2-04, 한 PR). AppRoot(main.jsx와 같은 트리, StrictMode)를
// 실제 6개 모듈과 함께 렌더해 부팅·랜딩·환자 전환 같은 큰 흐름이 C1~C4 리팩터링 내내 그대로인지 지킨다.
// 리팩터링 PR에서 이 파일의 단언이 실패하면 동작이 바뀐 것이다 — 코드를 고친다(의도 갱신은 계획의 flagged PR만).
//
// 규칙: 단언은 역할·화면 텍스트로만(getByRole·findByText). 클래스명·DOM 스냅샷·내부 훅 mock 금지.
// 네트워크는 createFetchRouter(등록 안 된 요청은 실패·기록), 저장소는 jsdom localStorage, 셸은 makeBridgeStub.
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { renderApp, resetAppEnvironment } from './testing/renderApp';
import { createFetchRouter } from './testing/fetchRouter';
import { makeBridgeStub } from './testing/bridgeStub';
import goldenPatients from './core/fixtures/goldenPatients.json';

const jobPresets = JSON.parse(readFileSync('public/job-presets.json', 'utf8'));
const AUTO_SAVE_KEY = 'wrEvalUnifiedAutoSave';

afterEach(() => resetAppEnvironment());

function webLocalRouter() {
  // 웹 로컬 모드가 부팅 중에 내는 요청은 내장 직종 프리셋 1종뿐이다(StrictMode라 2회).
  return createFetchRouter({ 'GET /job-presets.json': jobPresets });
}

function seedAutoSave(patients) {
  localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify({ savedAt: '2026-11-01T01:02:03.000Z', patients }));
}

const patientList = () => screen.getByText(/^환자 목록 \(\d+\)$/);

describe('G9a — 웹 로컬', () => {
  it('G9a-1 랜딩: 버튼 6종(통계분석 없음), 부팅 요청은 내장 프리셋뿐', async () => {
    const router = webLocalRouter();
    renderApp({ router });
    await screen.findByRole('button', { name: '+ 새환자' });
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      '+ 새환자', '불러오기', '저장', '엑셀 일괄입력', '테스트', '설정',
    ]);
    expect(screen.queryByRole('button', { name: '통계분석' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('근골격계 질환 업무관련성 평가 및 특별진찰 소견서 작성 도우미');
    await waitFor(() => expect(router.count('GET /job-presets.json')).toBeGreaterThan(0));
    expect(router.unhandled).toEqual([]);
  });

  it('G9a-2 자동저장 복원: 확인창 문구 → 사이드바에 환자 전원', async () => {
    seedAutoSave(goldenPatients.slice(0, 3));
    const router = webLocalRouter();
    const app = renderApp({ router, confirm: () => true });
    await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (3)'));
    expect(app.dialogs.confirms).toEqual([
      '이전 자동 저장 데이터가 있습니다 (2026. 11. 1. 오전 10:02:03).\n이어서 작업하시겠습니까?',
    ]);
    for (const p of goldenPatients.slice(0, 3)) {
      expect(screen.getByText(p.data.shared.name)).toBeTruthy();
      expect(screen.getByText(`#${p.data.shared.patientNo}`)).toBeTruthy();
    }
    // 첫 환자가 활성 — 기본정보 스텝에 등록번호가 채워져 있다.
    expect(screen.getByDisplayValue(goldenPatients[0].data.shared.patientNo)).toBeTruthy();
    expect(router.unhandled).toEqual([]);
  });

  it('G9a-2b 자동저장 복원 거절: 랜딩에 머물고 자동저장은 지워진다', async () => {
    seedAutoSave(goldenPatients.slice(0, 3));
    const app = renderApp({ router: webLocalRouter(), confirm: () => false });
    await waitFor(() => expect(app.dialogs.confirms).toHaveLength(1));
    await waitFor(() => expect(localStorage.getItem(AUTO_SAVE_KEY)).toBeNull());
    expect(screen.getByRole('button', { name: '+ 새환자' })).toBeTruthy();
    expect(screen.queryByText(/^환자 목록 \(\d+\)$/)).toBeNull();
  });

  it('G9a-3 둘째 환자로 전환: 등록번호와 모듈 스텝이 바뀐다', async () => {
    seedAutoSave(goldenPatients.slice(0, 3));
    renderApp({ router: webLocalRouter(), confirm: () => true });
    await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (3)'));
    const second = goldenPatients[1]; // knee + spine
    // 단계 표시의 모듈 묶음 이름(아이콘 + 이름): 첫 환자는 무릎만.
    expect(screen.getByText(KNEE_GROUP)).toBeTruthy();
    expect(screen.queryByText(SPINE_GROUP)).toBeNull();
    fireEvent.click(screen.getByText(second.data.shared.name));
    await screen.findByDisplayValue(second.data.shared.patientNo);
    expect(screen.queryByDisplayValue(goldenPatients[0].data.shared.patientNo)).toBeNull();
    expect(screen.getByText(KNEE_GROUP)).toBeTruthy();
    expect(screen.getByText(SPINE_GROUP)).toBeTruthy();
  });

  it('G9a-4 테스트 데이터: 인원수·완료 문구', async () => {
    const app = renderApp({ router: webLocalRouter() });
    fireEvent.click(await screen.findByRole('button', { name: '테스트' }));
    await waitFor(() => expect(app.dialogs.alerts).toHaveLength(1));
    const [alert] = app.dialogs.alerts;
    expect(alert).toBe('테스트 데이터 로드 완료: 27명');
    await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (27)'));
  });

  it('G9a-5 새환자 위자드: 열기 → 취소하면 랜딩으로', async () => {
    renderApp({ router: webLocalRouter() });
    fireEvent.click(await screen.findByRole('button', { name: '+ 새환자' }));
    const title = await screen.findByRole('heading', { name: '새 환자 평가' });
    expect(title).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    await screen.findByRole('button', { name: '엑셀 일괄입력' });
    expect(screen.queryByRole('heading', { name: '새 환자 평가' })).toBeNull();
  });
});

const KNEE_GROUP = '🏃 무릎 (슬관절)';
const SPINE_GROUP = '⚕️ 요추(허리)';

// ---------------------------------------------------------------------------
// G9b — 인트라넷(웹)
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

function seedIntranetSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ integrationMode: 'intranet', apiBaseUrl: BASE }));
}

function seedStoredSession(user = DOCTOR) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    version: 1, mode: 'intranet', status: 'ready', apiBaseUrl: BASE,
    refreshedAt: '2026-11-13T00:00:00.000Z', user: { ...user, authProvider: 'intranet' },
  }));
}

function serverPatient(p, revision = 1) {
  const at = '2026-11-10T00:00:00.000Z';
  return {
    ...p, assignedDoctorUserId: DOCTOR.id, updatedAt: at, completionStatus: 'incomplete',
    serverObservedModulesCompleteAt: null, serverVerifiedModulesCompleteAt: null,
    sync: { serverId: p.id, revision, syncStatus: 'synced', lastSyncedAt: at },
  };
}

function intranetRouter(extra = {}) {
  return createFetchRouter({
    'GET /job-presets.json': jobPresets,
    'GET /api/config/public': PUBLIC_CONFIG,
    'POST /api/auth/csrf': { accessToken: 'tok-1', accessExpiresAt: '2099-01-01T00:00:00.000Z', user: DOCTOR },
    // 실서버에는 없는 경로(목 서버 판별용) — 실서버처럼 404.
    'GET /api/mock/status': () => ({ status: 404, body: { error: 'Not found' } }),
    'GET /api/auth/me': { user: DOCTOR, capabilities: [] },
    'GET /api/presets': { presets: [] },
    'GET /api/patients/doctor-counts': { doctors: [{ userId: DOCTOR.id, name: DOCTOR.displayName, count: 2 }], unassignedCount: 0 },
    'GET /api/workspaces': { items: [] },
    'POST /api/patients/:id/lock': { leaseToken: 'lease-1', expiresAt: '2099-01-01T00:00:00.000Z', ttlMs: 60000 },
    'DELETE /api/patients/:id/lock': () => ({ status: 204 }),
    ...extra,
  });
}

// 부팅 무한루프 감지 상한: StrictMode 이중 effect로 2회가 정상(세션 확인 1 + 재마운트 1).
const BOOT_CSRF_LIMIT = 2;

/** settle: 화면이 안정된 뒤(지정 텍스트가 보인 뒤) 남은 비동기 요청이 끝나도록 한 틱 더 기다린다. */
async function settle() {
  await new Promise((r) => setTimeout(r, 50));
}

describe('G9b — 인트라넷(웹)', () => {
  it('G9b-1 저장된 세션 없음: "서버에 연결 중" → 로그인 화면', async () => {
    seedIntranetSettings();
    let releaseConfig;
    const configGate = new Promise((r) => { releaseConfig = r; });
    const router = intranetRouter({
      'GET /api/config/public': async () => { await configGate; return { body: PUBLIC_CONFIG }; },
    });
    renderApp({ router });
    expect(await screen.findByText('서버에 연결 중입니다…')).toBeTruthy();
    releaseConfig();
    expect(await screen.findByRole('heading', { name: '인트라넷 로그인' })).toBeTruthy();
    expect(screen.queryByText('서버에 연결 중입니다…')).toBeNull();
    await settle();
    // 로그인 전에는 세션 확인·환자 요청을 보내지 않는다.
    expect(router.count('POST /api/auth/csrf')).toBe(0);
    expect(router.count('GET /api/patients')).toBe(0);
    expect(router.unhandled).toEqual([]);
  });

  it('G9b-2 저장된 세션: 세션 확인 → pull → 목록(csrf 호출 수 상한)', async () => {
    seedIntranetSettings();
    seedStoredSession();
    const items = goldenPatients.slice(0, 2).map((p) => serverPatient(p));
    let releaseCsrf;
    const csrfGate = new Promise((r) => { releaseCsrf = r; });
    const router = intranetRouter({
      'POST /api/auth/csrf': async () => {
        await csrfGate;
        return { body: { accessToken: 'tok-1', accessExpiresAt: '2099-01-01T00:00:00.000Z', user: DOCTOR } };
      },
      'GET /api/patients': { items, total: items.length },
    });
    renderApp({ router });
    expect(await screen.findByText('세션을 확인하는 중입니다…')).toBeTruthy();
    releaseCsrf();
    await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (2)'));
    for (const p of goldenPatients.slice(0, 2)) expect(screen.getByText(p.data.shared.name)).toBeTruthy();
    expect(screen.getByRole('button', { name: /김의사/ })).toBeTruthy();
    await settle();
    expect(router.count('POST /api/auth/csrf')).toBeLessThanOrEqual(BOOT_CSRF_LIMIT);
    expect(router.count('GET /api/patients')).toBe(1);
    expect(router.calls.find((c) => c.path === '/api/patients').query).toEqual({ limit: '100', offset: '0', scope: 'mine' });
    expect(router.unhandled).toEqual([]);
  });

  it('G9b-2b 세션 확인 실패(401): 로그인 화면으로', async () => {
    seedIntranetSettings();
    seedStoredSession();
    const router = intranetRouter({ 'POST /api/auth/csrf': () => ({ status: 401, body: { error: 'Unauthorized' } }) });
    renderApp({ router });
    expect(await screen.findByRole('heading', { name: '인트라넷 로그인' })).toBeTruthy();
    await settle();
    expect(router.count('POST /api/auth/csrf')).toBeLessThanOrEqual(BOOT_CSRF_LIMIT);
    expect(router.count('GET /api/patients')).toBe(0);
    expect(localStorage.getItem(SESSION_KEY)).toContain('"mode":"local"');
  });

  it('G9b-3a config 실패: "서버 연결 실패"와 로컬 전환 버튼', async () => {
    seedIntranetSettings();
    const router = intranetRouter({ 'GET /api/config/public': () => ({ status: 503, body: { error: 'down' } }) });
    renderApp({ router });
    expect(await screen.findByRole('heading', { name: '서버 연결 실패' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /로컬 모드로 전환/ })).toBeTruthy();
    expect(screen.getByText(/인트라넷 서버\(https:\/\/srv\.test\)에 연결할 수 없습니다/)).toBeTruthy();
  });

  it('G9b-3b mustChangePassword: 비밀번호 변경 화면이 다른 화면을 막는다', async () => {
    seedIntranetSettings();
    seedStoredSession();
    const router = intranetRouter({
      'POST /api/auth/csrf': { accessToken: 'tok-1', accessExpiresAt: '2099-01-01T00:00:00.000Z', user: { ...DOCTOR, mustChangePassword: true } },
      'GET /api/patients': { items: [], total: 0 },
    });
    renderApp({ router });
    expect(await screen.findByRole('heading', { name: '비밀번호 변경 필요' })).toBeTruthy();
    expect(screen.queryByText(/^환자 목록 \(\d+\)$/)).toBeNull();
    expect(screen.queryByRole('button', { name: '+ 새환자' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// G9c — Electron 셸(window.electron 스텁: 구 셸 표면 = 현장 설치본)
// ---------------------------------------------------------------------------
function recordBeforeUnloadRegistrations() {
  const registered = [];
  const original = window.addEventListener;
  window.addEventListener = function patched(type, ...rest) {
    if (type === 'beforeunload') registered.push(type);
    return original.call(this, type, ...rest);
  };
  return { registered, restore: () => { window.addEventListener = original; } };
}

describe('G9c — Electron 셸', () => {
  it('G9c-1 독립형 셸: fsLoadSettings·fsLoadAutoSave → 셸 확인창으로 복원 → 목록', async () => {
    const confirms = [];
    const bridge = makeBridgeStub('standalone', {
      overrides: {
        fsLoadSettings: async () => ({ theme: 'light', integrationMode: 'local' }),
        fsLoadAutoSave: async () => ({ savedAt: '2026-11-01T01:02:03.000Z', patients: goldenPatients.slice(0, 3) }),
        showConfirm: async (msg) => { confirms.push(msg); return true; },
      },
    });
    const beforeUnload = recordBeforeUnloadRegistrations();
    try {
      const app = renderApp({ bridge, router: webLocalRouter() });
      await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (3)'));
      expect(confirms).toEqual(['이전 자동 저장 데이터가 있습니다 (2026. 11. 1. 오전 10:02:03).\n이어서 작업하시겠습니까?']);
      expect(app.dialogs.confirms).toEqual([]); // 웹 confirm은 쓰지 않는다
      expect(bridge.__callsOf('fsLoadSettings').length).toBeGreaterThan(0);
      expect(bridge.__callsOf('fsLoadAutoSave').length).toBeGreaterThan(0);
      for (const p of goldenPatients.slice(0, 3)) expect(screen.getByText(p.data.shared.name)).toBeTruthy();
      // 독립형은 창 닫기 가로채기가 없어 beforeunload가 유일한 안전망 — 등록된다.
      expect(beforeUnload.registered.length).toBeGreaterThan(0);
      // 메뉴 이벤트 구독(새로 만들기·모듈 이동·통계)
      expect(bridge.__listenerCount('onMenuNew')).toBe(1);
    } finally {
      beforeUnload.restore();
    }
  });

  it('G9c-2 구 인트라넷 셸(buildTarget 없음): 로그인 뒤 setAccessToken·setHasUnsavedDraft(false)·setStatsAvailable, beforeunload 미등록', async () => {
    // 인트라넷 셸은 서버가 내준 화면을 loadURL로 띄운다 — 같은 origin이라 apiBaseUrl ''.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ integrationMode: 'intranet', apiBaseUrl: '' }));
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      version: 1, mode: 'intranet', status: 'ready', apiBaseUrl: '',
      refreshedAt: '2026-11-13T00:00:00.000Z', user: { ...DOCTOR, authProvider: 'intranet' },
    }));
    const bridge = makeBridgeStub('intranet');
    expect('buildTarget' in bridge).toBe(false);
    const items = goldenPatients.slice(0, 2).map((p) => serverPatient(p));
    const router = intranetRouter({ 'GET /api/patients': { items, total: items.length } });
    const beforeUnload = recordBeforeUnloadRegistrations();
    try {
      renderApp({ bridge, router });
      await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (2)'));
      await settle();
      expect(bridge.__callsOf('setAccessToken')).toContainEqual(['tok-1']);
      expect(bridge.__callsOf('setHasUnsavedDraft')).toContainEqual([false]);
      expect(bridge.__callsOf('setHasUnsavedDraft').every(([v]) => v === false)).toBe(true);
      expect(bridge.__callsOf('setStatsAvailable').length).toBeGreaterThan(0);
      expect(beforeUnload.registered).toEqual([]);
      expect(bridge.__listenerCount('onQuitRequested')).toBe(1);
      expect(router.count('POST /api/auth/csrf')).toBeLessThanOrEqual(BOOT_CSRF_LIMIT);
      expect(router.unhandled).toEqual([]);
    } finally {
      beforeUnload.restore();
    }
  });
});
