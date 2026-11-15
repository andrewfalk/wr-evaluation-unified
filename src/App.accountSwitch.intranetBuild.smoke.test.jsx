// @vitest-environment jsdom
//
// 계정 전환 스모크 — 인트라넷 기본 빌드(계정 전환 수정 AS-4, R9). 운영 인트라넷 빌드는 설정을 읽을 때 항상 인트라넷으로 덮는다
// (storage.js loadSettings, VITE_DEFAULT_INTEGRATION_MODE=intranet). 그래서 "로컬 모드로 전환"은 메모리의 설정 상태로만
// 유지된다 — 계정이 바뀌어 화면(App)을 다시 띄워도 로컬 화면이 유지돼야 한다(설정은 작업 공간 경계가 갖는다).
// 기본값은 모듈 로드 때 정해지므로 앱 모듈을 불러오기 전에 환경 변수를 건다.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

await vi.hoisted(async () => {
  vi.stubEnv('VITE_DEFAULT_INTEGRATION_MODE', 'intranet');
  (await import('./testing/fakeBroadcastChannel.js')).installFakeBroadcastChannel();
});

import { configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { renderApp, resetAppEnvironment } from './testing/renderApp';
import { createFetchRouter } from './testing/fetchRouter';
import { DEFAULT_SETTINGS } from './core/utils/data';
import goldenPatients from './core/fixtures/goldenPatients.json';

configure({ asyncUtilTimeout: 5000 });

const jobPresets = JSON.parse(readFileSync('public/job-presets.json', 'utf8'));
const SESSION_KEY = 'wrEvalUnifiedAuthSession';
const SETTINGS_KEY = 'wrEvalUnifiedSettings';
const DOCTOR = { id: 'u-doc-a', displayName: '김의사', role: 'doctor', organizationId: 'org-1' };
const [KIM, LEE] = goldenPatients;

const routers = [];
afterEach(() => {
  try {
    for (const router of routers) expect(router.unhandled, 'unregistered requests').toEqual([]);
  } finally {
    routers.length = 0;
    resetAppEnvironment();
  }
});
afterAll(() => { vi.unstubAllEnvs(); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function serverPatient(p) {
  const at = '2026-11-10T00:00:00.000Z';
  return {
    ...p, assignedDoctorUserId: DOCTOR.id, updatedAt: at, completionStatus: 'incomplete',
    serverObservedModulesCompleteAt: null, serverVerifiedModulesCompleteAt: null,
    sync: { serverId: p.id, revision: 1, syncStatus: 'synced', lastSyncedAt: at },
  };
}

function router() {
  const r = createFetchRouter({
    'GET /job-presets.json': jobPresets,
    'GET /api/config/public': { mode: 'intranet', aiEnabled: false, localFallbackAllowed: false, videoAnalysisEnabled: false, statsWorkbenchEnabled: false, statsWorkbenchAvailable: false, serverTime: '2026-11-14T00:00:00.000Z' },
    'GET /api/mock/status': () => ({ status: 404, body: { error: 'Not found' } }),
    'POST /api/auth/csrf': { accessToken: 'tok-1', accessExpiresAt: '2099-01-01T00:00:00.000Z', user: DOCTOR },
    'GET /api/auth/me': { user: DOCTOR, capabilities: [] },
    'GET /api/presets': { presets: [] },
    'GET /api/patients/doctor-counts': { doctors: [{ userId: DOCTOR.id, name: DOCTOR.displayName, count: 2 }], unassignedCount: 0 },
    'GET /api/workspaces': { items: [] },
    'POST /api/patients/:id/lock': { leaseToken: 'lease-1', expiresAt: '2099-01-01T00:00:00.000Z', ttlMs: 60000 },
    'DELETE /api/patients/:id/lock': () => ({ status: 204 }),
    'GET /api/patients': { items: [serverPatient(KIM), serverPatient(LEE)], total: 2 },
  });
  routers.push(r);
  return r;
}

describe('R9 — 인트라넷 기본 빌드에서 로컬 전환', () => {
  it('빌드 기본값이 인트라넷이다(전제)', () => {
    expect(DEFAULT_SETTINGS.integrationMode).toBe('intranet');
  });

  it('로그인 화면에서 로컬 전환 → 로컬 화면이 유지된다', async () => {
    renderApp({ router: router(), confirm: () => true });
    await screen.findByRole('heading', { name: '인트라넷 로그인' });
    fireEvent.click(screen.getByRole('button', { name: /로컬 모드로 전환/ }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: '인트라넷 로그인' })).toBeNull());
    await wait(300);
    expect(screen.queryByRole('heading', { name: '인트라넷 로그인' })).toBeNull();
    expect(screen.queryByText('서버에 연결 중입니다…')).toBeNull();
  }, 20000);

  it('강제 로그아웃(다른 탭의 로그아웃) → 로컬 전환: 화면을 새로 시작해도 로컬 화면이 유지되고 이전 목록은 없다', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ integrationMode: 'intranet', apiBaseUrl: '' }));
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      version: 1, mode: 'intranet', status: 'ready', apiBaseUrl: '',
      refreshedAt: '2026-11-13T00:00:00.000Z', user: { ...DOCTOR, authProvider: 'intranet' },
    }));
    renderApp({ router: router(), confirm: () => true });
    await waitFor(() => expect(screen.getByText(/^환자 목록 \(2\)$/)).toBeTruthy());
    const ch = new BroadcastChannel('wr-auth');
    ch.postMessage({ type: 'LOGOUT' });
    ch.close();
    await screen.findByRole('heading', { name: '인트라넷 로그인' });
    fireEvent.click(screen.getByRole('button', { name: /로컬 모드로 전환/ }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: '인트라넷 로그인' })).toBeNull());
    await wait(300);
    expect(screen.queryByRole('heading', { name: '인트라넷 로그인' })).toBeNull();
    expect(screen.queryByText(KIM.data.shared.name)).toBeNull();
    expect(screen.queryByText(LEE.data.shared.name)).toBeNull();
  }, 20000);
});
