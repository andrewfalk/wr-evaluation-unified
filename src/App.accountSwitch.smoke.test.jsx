// @vitest-environment jsdom
//
// 계정 전환 스모크(계정 전환 수정 AS-4) — AppRoot(main.jsx와 같은 트리, StrictMode)를 G9 하니스로 렌더해, 계정이 바뀌면
// 작업 화면이 새로 시작되고 이전 계정의 목록·요청이 새 계정에 닿지 않는지 확인한다. 골든 파일 없음.
//
// 규칙(G9와 같음): 단언은 역할·화면 텍스트로만. 네트워크는 createFetchRouter(등록 안 된 요청은 실패·기록 — 테스트 끝에 0),
// 저장소는 jsdom localStorage. 서버는 계정 둘(A·B)을 흉내 낸다: 로그인 쿠키 주인(cookie)과 발급 토큰의 주인을 따로 기록한다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { renderApp, resetAppEnvironment } from './testing/renderApp';
import { createFetchRouter } from './testing/fetchRouter';
import { FakeBroadcastChannel } from './testing/fakeBroadcastChannel.js';
import goldenPatients from './core/fixtures/goldenPatients.json';

// G9와 같은 이유(P2-09): 다른 worker의 BroadcastChannel('wr-auth') 메시지가 닿지 않게 정적 import보다 먼저 설치.
await vi.hoisted(async () => (await import('./testing/fakeBroadcastChannel.js')).installFakeBroadcastChannel());

configure({ asyncUtilTimeout: 5000 });

const jobPresets = JSON.parse(readFileSync('public/job-presets.json', 'utf8'));
const BASE = 'https://srv.test';
const SETTINGS_KEY = 'wrEvalUnifiedSettings';
const SESSION_KEY = 'wrEvalUnifiedAuthSession';
const AUTO_SAVE_KEY = 'wrEvalUnifiedAutoSave';
const [KIM, LEE, PARK] = goldenPatients;
const nameOf = (p) => p.data.shared.name;
const patientNoOf = (p) => p.data.shared.patientNo;

const USERS = {
  a: { id: 'u-doc-a', displayName: '김의사', role: 'doctor', organizationId: 'org-1' },
  b: { id: 'u-doc-b', displayName: '이의사', role: 'doctor', organizationId: 'org-1' },
};
const PUBLIC_CONFIG = {
  mode: 'intranet', aiEnabled: false, localFallbackAllowed: false,
  videoAnalysisEnabled: false, statsWorkbenchEnabled: false, statsWorkbenchAvailable: false,
  serverTime: '2026-11-14T00:00:00.000Z',
};

const routers = [];
afterEach(() => {
  try {
    for (const router of routers) expect(router.unhandled, 'unregistered requests').toEqual([]);
  } finally {
    routers.length = 0;
    resetAppEnvironment();
  }
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const patientListText = () => screen.queryByText(/^환자 목록 \(\d+\)$/)?.textContent ?? null;

function toServer(p, ownerKey, revision = 1, syncStatus = 'synced') {
  const at = '2026-11-10T00:00:00.000Z';
  return {
    ...p, assignedDoctorUserId: USERS[ownerKey].id, updatedAt: at, completionStatus: 'incomplete',
    serverObservedModulesCompleteAt: null, serverVerifiedModulesCompleteAt: null,
    sync: { serverId: p.id, revision, syncStatus, lastSyncedAt: at },
  };
}

/**
 * 계정 둘을 가진 서버. cookie = 지금 브라우저 로그인 쿠키의 주인('a'|'b'|null). 토큰마다 주인을 기록해,
 * 요청이 어느 계정의 토큰으로 나갔는지 판정한다. hold.login[key]/hold.patch를 함수로 두면 그 응답을 보류한다.
 */
function accountServer({ cookie = null, patients = { a: [KIM, LEE], b: [PARK] } } = {}) {
  const state = { cookie, seq: 0 };
  const tokenOwner = new Map();
  const store = {
    a: new Map(patients.a.map((p) => [p.id, toServer(p, 'a')])),
    b: new Map(patients.b.map((p) => [p.id, toServer(p, 'b')])),
  };
  const hold = { login: {}, patch: null };
  const issue = (key) => {
    state.seq += 1;
    const accessToken = `tok-${key}-${state.seq}`;
    tokenOwner.set(accessToken, key);
    return { accessToken, accessExpiresAt: '2099-01-01T00:00:00.000Z', user: USERS[key] };
  };
  const bearer = (req) => String(req.headers?.Authorization || '').replace(/^Bearer /, '');
  const ownerOf = (req) => tokenOwner.get(bearer(req)) ?? null;
  const unauthorized = () => ({ status: 401, body: { code: 'UNAUTHORIZED', error: 'Unauthorized' } });

  const router = createFetchRouter({
    'GET /job-presets.json': jobPresets,
    'GET /api/config/public': PUBLIC_CONFIG,
    'GET /api/mock/status': () => ({ status: 404, body: { error: 'Not found' } }),
    'POST /api/auth/csrf': () => (state.cookie ? { body: issue(state.cookie) } : unauthorized()),
    'POST /api/auth/refresh': () => (state.cookie ? { body: issue(state.cookie) } : unauthorized()),
    'POST /api/auth/login': async (req) => {
      const key = req.body?.loginId;
      if (!USERS[key]) return { status: 401, body: { error: '아이디 또는 비밀번호가 올바르지 않습니다.' } };
      if (hold.login[key]) await hold.login[key]();
      state.cookie = key;
      return { body: issue(key) };
    },
    'POST /api/auth/logout': () => { state.cookie = null; return { body: { ok: true } }; },
    'GET /api/auth/me': (req) => (ownerOf(req) ? { body: { user: USERS[ownerOf(req)], capabilities: [] } } : unauthorized()),
    'GET /api/presets': { presets: [] },
    'GET /api/patients/doctor-counts': (req) => {
      const key = ownerOf(req);
      if (!key) return unauthorized();
      return { body: { doctors: [{ userId: USERS[key].id, name: USERS[key].displayName, count: store[key].size }], unassignedCount: 0 } };
    },
    'GET /api/workspaces': { items: [] },
    'POST /api/patients/:id/lock': { leaseToken: 'lease-1', expiresAt: '2099-01-01T00:00:00.000Z', ttlMs: 60000 },
    'DELETE /api/patients/:id/lock': () => ({ status: 204 }),
    'GET /api/patients': (req) => {
      const key = ownerOf(req);
      if (!key) return unauthorized();
      const items = [...store[key].values()];
      return { body: { items, total: items.length } };
    },
    'PATCH /api/patients/:id': async (req) => {
      if (hold.patch) {
        const result = await hold.patch(req);
        if (result) return result;
      }
      const key = ownerOf(req);
      const current = key ? store[key].get(req.params.id) : null;
      if (!current) return { status: 403, body: { code: 'FORBIDDEN' } };
      const next = { ...current, data: req.body.data, sync: { ...current.sync, revision: current.sync.revision + 1 } };
      store[key].set(req.params.id, next);
      return { body: next };
    },
    'POST /api/patients': (req) => {
      const key = ownerOf(req);
      if (!key) return unauthorized();
      const created = toServer({ ...req.body, id: req.body?.id || `srv-${state.seq}` }, key);
      store[key].set(created.id, created);
      return { status: 201, body: created };
    },
  });
  routers.push(router);
  const writes = () => router.calls.filter((c) => (c.method === 'POST' && c.path === '/api/patients') || c.route === 'PATCH /api/patients/:id');
  const writesBy = (key) => writes().filter((c) => tokenOwner.get(bearer(c)) === key);
  return { router, state, hold, store, writes, writesBy, tokenOwner, bearer };
}

function seedSettings(extra = {}) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ integrationMode: 'intranet', apiBaseUrl: BASE, autoSaveInterval: 1, ...extra }));
}

function seedStoredSession(key) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    version: 1, mode: 'intranet', status: 'ready', apiBaseUrl: BASE,
    refreshedAt: '2026-11-13T00:00:00.000Z', user: { ...USERS[key], authProvider: 'intranet' },
  }));
}

async function bootAsA({ confirm = () => true } = {}) {
  seedSettings();
  seedStoredSession('a');
  const srv = accountServer({ cookie: 'a' });
  const app = renderApp({ router: srv.router, confirm });
  await waitFor(() => expect(patientListText()).toBe('환자 목록 (2)'));
  await screen.findByDisplayValue(patientNoOf(KIM));
  await waitFor(() => expect(srv.router.count('POST /api/patients/:id/lock')).toBeGreaterThan(0));
  await wait(100);
  return { app, srv };
}

async function loginAs(key) {
  await screen.findByRole('heading', { name: '인트라넷 로그인' });
  fireEvent.change(screen.getByLabelText('아이디'), { target: { value: key } });
  fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: '로그인' }));
}

async function logoutViaMenu(displayName) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(displayName) }));
  fireEvent.click(await screen.findByRole('button', { name: '로그아웃' }));
}

// 다른 탭 — 이 앱의 authChannel이 받는다.
function otherTabPost(msg) {
  const ch = new BroadcastChannel('wr-auth');
  ch.postMessage(msg);
  ch.close();
}

describe('계정 전환 — 로그아웃 뒤 다른 계정', () => {
  it('R6 A 편집 → 로그아웃 → B 로그인: 화면에 A의 환자가 없고 B 토큰의 저장 요청은 0건', async () => {
    const { srv } = await bootAsA();
    fireEvent.change(screen.getByDisplayValue(nameOf(KIM)), { target: { value: '김철수수정' } });
    await logoutViaMenu('김의사');
    await loginAs('b');
    await waitFor(() => expect(screen.getByRole('button', { name: /이의사/ })).toBeTruthy());
    await waitFor(() => expect(patientListText()).toBe('환자 목록 (1)'));
    await wait(2500); // 저장 debounce(1초)를 넘겨도
    expect(screen.queryByText('김철수수정')).toBeNull();
    expect(screen.queryByText(nameOf(LEE))).toBeNull();
    expect(screen.getByText(nameOf(PARK))).toBeTruthy();
    expect(srv.writesBy('b')).toEqual([]);
  }, 20000);

  it('R7 A의 저장 요청이 보류된 채 로그아웃 → B 로그인 → 보류 응답 401: B 토큰으로 다시 보내지 않고 B 세션 유지', async () => {
    const { srv } = await bootAsA();
    let releasePatch;
    srv.hold.patch = () => new Promise((r) => { releasePatch = () => r({ status: 401, body: { code: 'UNAUTHORIZED' } }); });
    fireEvent.change(screen.getByDisplayValue(nameOf(KIM)), { target: { value: '김철수수정' } });
    await waitFor(() => expect(srv.router.count('PATCH /api/patients/:id')).toBe(1), { timeout: 3000 });
    await logoutViaMenu('김의사');
    await loginAs('b');
    await waitFor(() => expect(screen.getByRole('button', { name: /이의사/ })).toBeTruthy());
    const refreshesBefore = srv.router.count('POST /api/auth/refresh');
    srv.hold.patch = null;
    await act(async () => { releasePatch(); await wait(50); });
    await wait(2500);
    expect(srv.writesBy('b')).toEqual([]);
    expect(srv.router.count('POST /api/auth/refresh')).toBe(refreshesBefore);
    expect(screen.getByRole('button', { name: /이의사/ })).toBeTruthy();
    expect(screen.queryByText('김철수수정')).toBeNull();
  }, 20000);
});

describe('계정 전환 — 로그아웃 뒤 로컬 모드', () => {
  it('R8a 로그아웃 → 로컬 전환: 이전 계정의 목록 없음, 로컬 자동저장 키에 기록 없음', async () => {
    await bootAsA();
    fireEvent.change(screen.getByDisplayValue(nameOf(KIM)), { target: { value: '김철수수정' } });
    await logoutViaMenu('김의사');
    await screen.findByRole('heading', { name: '인트라넷 로그인' });
    fireEvent.click(screen.getByRole('button', { name: /로컬 모드로 전환/ }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: '인트라넷 로그인' })).toBeNull());
    await wait(1500); // 자동저장 간격(1초)을 넘겨도
    expect(screen.queryByText('김철수수정')).toBeNull();
    expect(screen.queryByText(nameOf(LEE))).toBeNull();
    expect(patientListText()).toBeNull();
    expect(localStorage.getItem(AUTO_SAVE_KEY)).toBeNull();
  }, 20000);

  it('R8b 강제 로그아웃(다른 탭의 로그아웃) → 로컬 전환: 이전 계정의 목록 없음, 로컬 자동저장 키에 기록 없음', async () => {
    await bootAsA();
    otherTabPost({ type: 'LOGOUT' });
    await screen.findByRole('heading', { name: '인트라넷 로그인' });
    fireEvent.click(screen.getByRole('button', { name: /로컬 모드로 전환/ }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: '인트라넷 로그인' })).toBeNull());
    await wait(1500);
    expect(screen.queryByText(nameOf(KIM))).toBeNull();
    expect(screen.queryByText(nameOf(LEE))).toBeNull();
    expect(patientListText()).toBeNull();
    expect(localStorage.getItem(AUTO_SAVE_KEY)).toBeNull();
  }, 20000);
});

describe('계정 전환 — 같은 계정 재로그인은 이어 간다', () => {
  it('R10 강제 로그아웃 → 같은 A 재로그인: 목록·편집이 남고 새 토큰으로 저장한다', async () => {
    const { srv } = await bootAsA();
    fireEvent.change(screen.getByDisplayValue(nameOf(KIM)), { target: { value: '김철수수정' } });
    otherTabPost({ type: 'LOGOUT' });
    await loginAs('a');
    await waitFor(() => expect(patientListText()).toBe('환자 목록 (2)'));
    expect(screen.getByDisplayValue('김철수수정')).toBeTruthy();
    await waitFor(() => expect(srv.writesBy('a').some((c) => c.body?.data?.shared?.name === '김철수수정')).toBe(true), { timeout: 4000 });
    const lastA = srv.writesBy('a').at(-1);
    expect(srv.bearer(lastA)).not.toBe('tok-a-1'); // 재로그인으로 받은 새 토큰
    expect(srv.writesBy('b')).toEqual([]);
  }, 20000);
});

describe('계정 전환 — 다른 탭에서 다른 계정 로그인', () => {
  it('R16 다른 탭이 같은 서버에 B로 로그인: 이 탭은 로그인 화면으로, 이어서 B로 로그인해도 A의 환자가 보이지 않고 B 토큰의 저장 요청 0건', async () => {
    const { srv } = await bootAsA();
    fireEvent.change(screen.getByDisplayValue(nameOf(KIM)), { target: { value: '김철수수정' } });
    srv.state.cookie = 'b'; // 다른 탭의 로그인으로 쿠키가 B 것이 됨
    otherTabPost({ type: 'LOGIN', server: BASE, identity: `${USERS.b.id}|org-1` });
    await screen.findByRole('heading', { name: '인트라넷 로그인' });
    expect(screen.queryByText('김철수수정')).toBeNull();
    await loginAs('b');
    await waitFor(() => expect(screen.getByRole('button', { name: /이의사/ })).toBeTruthy());
    await waitFor(() => expect(patientListText()).toBe('환자 목록 (1)'));
    await wait(2500);
    expect(screen.queryByText('김철수수정')).toBeNull();
    expect(screen.queryByText(nameOf(LEE))).toBeNull();
    expect(srv.writesBy('b')).toEqual([]);
  }, 20000);
});

describe('계정 전환 — 로컬 자동저장과 로그인(J2)', () => {
  // 로그인 화면 → 로컬 전환 → 자동저장 복원 → 설정에서 인트라넷으로 되돌림 → 로그인 화면.
  async function restoreThenBackToIntranet(autosavePatients) {
    seedSettings();
    localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify({ savedAt: '2026-11-01T01:02:03.000Z', patients: autosavePatients }));
    const srv = accountServer({ cookie: null });
    const app = renderApp({ router: srv.router, confirm: () => true });
    await screen.findByRole('heading', { name: '인트라넷 로그인' });
    fireEvent.click(screen.getByRole('button', { name: /로컬 모드로 전환/ }));
    await waitFor(() => expect(patientListText()).toBe(`환자 목록 (${autosavePatients.length})`));
    fireEvent.click(screen.getAllByRole('button', { name: '설정' })[0]);
    fireEvent.change(screen.getByDisplayValue('로컬 저장'), { target: { value: 'intranet' } });
    fireEvent.click(screen.getAllByRole('button', { name: '저장' }).at(-1)); // 설정 창(마지막에 렌더)의 저장
    await screen.findByRole('heading', { name: '인트라넷 로그인' });
    return { app, srv };
  }

  const otherAccountServerPatient = toServer(KIM, 'a', 3, 'dirty');
  const localOnly = { ...LEE, sync: { syncStatus: 'local-only' } };

  it('R12 로컬 자동저장에 다른 계정의 서버 환자 → 복원 → B 로그인: 그 환자의 저장 요청 0건, 화면에도 없음', async () => {
    const { srv } = await restoreThenBackToIntranet([otherAccountServerPatient, localOnly]);
    await loginAs('b');
    await waitFor(() => expect(screen.getByRole('button', { name: /이의사/ })).toBeTruthy());
    await waitFor(() => expect(patientListText()).toBe('환자 목록 (1)'));
    await wait(2500);
    expect(srv.writes()).toEqual([]);
    expect(screen.queryByText(nameOf(KIM))).toBeNull();
    expect(screen.queryByText(nameOf(LEE))).toBeNull();
  }, 20000);

  it('R13 로컬 작업을 두고 로그인하면 로그인 전에 로컬 자동저장에 다시 써 둔다(다음 로컬 모드에서 복원 안내)', async () => {
    await restoreThenBackToIntranet([localOnly]);
    expect(localStorage.getItem(AUTO_SAVE_KEY)).toBeNull(); // 복원하면서 저장본은 지워졌다
    await loginAs('b');
    await waitFor(() => expect(screen.getByRole('button', { name: /이의사/ })).toBeTruthy());
    const saved = JSON.parse(localStorage.getItem(AUTO_SAVE_KEY));
    expect(saved.patients.map((p) => p.data.shared.patientNo)).toEqual([patientNoOf(LEE)]);
  }, 20000);

  it('R13 이전 인트라넷 계정의 목록(주인 있음)은 로그인 전에 로컬 저장소에 쓰지 않는다', async () => {
    await bootAsA();
    otherTabPost({ type: 'LOGOUT' });
    await loginAs('b');
    await waitFor(() => expect(screen.getByRole('button', { name: /이의사/ })).toBeTruthy());
    expect(localStorage.getItem(AUTO_SAVE_KEY)).toBeNull();
  }, 20000);

  it('R13 로컬 작업 저장에 실패하면 로그인하지 않고 알린다', async () => {
    await restoreThenBackToIntranet([localOnly]);
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key, value) {
      if (key === AUTO_SAVE_KEY) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      return original.call(this, key, value);
    };
    try {
      await loginAs('b');
      expect(await screen.findByText('로컬 작업을 저장하지 못했습니다. 다시 시도하세요.')).toBeTruthy();
      expect(screen.getByRole('heading', { name: '인트라넷 로그인' })).toBeTruthy();
    } finally {
      Storage.prototype.setItem = original;
    }
  }, 20000);
});

describe('로그인 요청 중에는 로컬 전환 버튼을 쓸 수 없다', () => {
  it('로그인 응답을 기다리는 동안 "로컬 모드로 전환"이 비활성', async () => {
    seedSettings();
    const srv = accountServer({ cookie: null });
    let release;
    srv.hold.login.a = () => new Promise((r) => { release = r; });
    renderApp({ router: srv.router, confirm: () => true });
    await loginAs('a');
    await waitFor(() => expect(screen.getByRole('button', { name: /로컬 모드로 전환/ }).disabled).toBe(true));
    await act(async () => { release(); await wait(20); });
    await waitFor(() => expect(screen.getByRole('button', { name: /김의사/ })).toBeTruthy());
  }, 20000);
});

describe('로그아웃 확인(AS-5)', () => {
  const UNSAVED_MESSAGE = '저장되지 않은 환자가 1명 있습니다. 로그아웃하면 이 내용은 사라집니다. 로그아웃할까요?';

  it('R11 저장되지 않은 환자가 있으면 묻고, 취소하면 로그아웃 요청을 보내지 않는다', async () => {
    const { app, srv } = await bootAsA({ confirm: (msg) => msg !== UNSAVED_MESSAGE });
    srv.hold.patch = () => new Promise(() => {}); // 저장이 끝나지 않아 저장 대기로 남는다
    fireEvent.change(screen.getByDisplayValue(nameOf(KIM)), { target: { value: '김철수수정' } });
    await logoutViaMenu('김의사');
    await wait(200);
    expect(app.dialogs.confirms).toContain(UNSAVED_MESSAGE);
    expect(srv.router.count('POST /api/auth/logout')).toBe(0);
    expect(screen.getByRole('button', { name: /김의사/ })).toBeTruthy();
    expect(screen.getByDisplayValue('김철수수정')).toBeTruthy();
  }, 20000);

  it('R11 확인하면 로그아웃하고 화면을 비운다', async () => {
    const { app, srv } = await bootAsA({ confirm: () => true });
    srv.hold.patch = () => new Promise(() => {});
    fireEvent.change(screen.getByDisplayValue(nameOf(KIM)), { target: { value: '김철수수정' } });
    await logoutViaMenu('김의사');
    await screen.findByRole('heading', { name: '인트라넷 로그인' });
    expect(app.dialogs.confirms).toContain(UNSAVED_MESSAGE);
    expect(srv.router.count('POST /api/auth/logout')).toBe(1);
  }, 20000);

  it('R11 저장되지 않은 환자가 없으면 묻지 않고 로그아웃한다', async () => {
    const { app, srv } = await bootAsA({ confirm: () => true });
    await logoutViaMenu('김의사');
    await screen.findByRole('heading', { name: '인트라넷 로그인' });
    expect(app.dialogs.confirms.filter((m) => m.includes('저장되지 않은 환자'))).toEqual([]);
    expect(srv.router.count('POST /api/auth/logout')).toBe(1);
  }, 20000);

  it('설정 창의 로그아웃에서 확인창을 취소하면 설정 창이 닫히지 않는다', async () => {
    const { srv } = await bootAsA({ confirm: (msg) => msg !== UNSAVED_MESSAGE });
    srv.hold.patch = () => new Promise(() => {});
    fireEvent.change(screen.getByDisplayValue(nameOf(KIM)), { target: { value: '김철수수정' } });
    fireEvent.click(screen.getAllByRole('button', { name: '설정' })[0]);
    await screen.findByText('데이터 저장 방식');
    fireEvent.click(screen.getAllByRole('button', { name: '로그아웃' }).at(-1));
    await wait(200);
    expect(screen.getByText('데이터 저장 방식')).toBeTruthy();
    expect(srv.router.count('POST /api/auth/logout')).toBe(0);
  }, 20000);
});

describe('로그아웃과 편집 락·다른 탭의 로그인(계정 전환 수정 후속)', () => {
  const UNSAVED_MESSAGE = '저장되지 않은 환자가 1명 있습니다. 로그아웃하면 이 내용은 사라집니다. 로그아웃할까요?';

  it('편집 락을 잡은 채 로그아웃하면 그 락을 해제한다', async () => {
    const { srv } = await bootAsA();
    await logoutViaMenu('김의사');
    await screen.findByRole('heading', { name: '인트라넷 로그인' });
    await waitFor(() => expect(srv.router.count('DELETE /api/patients/:id/lock')).toBeGreaterThan(0));
  }, 20000);

  it('로그아웃 확인창이 떠 있는 동안 다른 탭이 다른 계정으로 로그인하면, 확인해도 로그아웃 방송·요청을 보내지 않는다', async () => {
    const heard = [];
    const otherTab = new BroadcastChannel('wr-auth'); // 방금 B로 로그인한 다른 탭
    otherTab.onmessage = (e) => { heard.push(e.data); };
    // 셸의 확인창은 비동기라 떠 있는 동안 다른 탭의 방송이 처리된다 — 여기서는 확인창 안에서 바로 전달해 그 순서를 만든다.
    const deliverNow = (msg) => {
      for (const peer of FakeBroadcastChannel.registry.get('wr-auth') ?? []) {
        if (peer !== otherTab && !peer.closed) peer.dispatch(structuredClone(msg));
      }
    };
    try {
      const { app, srv } = await bootAsA({
        confirm: (msg) => {
          if (msg === UNSAVED_MESSAGE) {
            srv.state.cookie = 'b';
            deliverNow({ type: 'LOGIN', server: BASE, identity: `${USERS.b.id}|org-1` });
          }
          return true;
        },
      });
      srv.hold.patch = () => new Promise(() => {}); // 저장 대기로 남겨 확인창이 뜨게
      fireEvent.change(screen.getByDisplayValue(nameOf(KIM)), { target: { value: '김철수수정' } });
      await logoutViaMenu('김의사');
      await screen.findByRole('heading', { name: '인트라넷 로그인' });
      await wait(200);
      expect(app.dialogs.confirms).toContain(UNSAVED_MESSAGE);
      expect(heard.filter((m) => m?.type === 'LOGOUT')).toEqual([]);
      expect(srv.router.count('POST /api/auth/logout')).toBe(0);
    } finally {
      otherTab.close();
    }
  }, 20000);
});
