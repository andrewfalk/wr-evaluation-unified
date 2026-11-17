// @vitest-environment jsdom
//
// G9r — 부팅 요청 순서 특성화(REFACTORING_ROADMAP Phase 2 P2-44a, C3-C 선행). C3-C는 App의 훅을 컨트롤러로 옮기되 effect
// 등록 순서를 바꾸지 않는다(scripts/appHookOrder.test.mjs) — 그 결과인 부팅 요청 순서를 화면 밖에서 한 번 더 고정한다.
// 단언은 엔드포인트(메서드 + 경로 패턴)별 **첫 등장 순서**다 — StrictMode 이중 effect가 만드는 반복 횟수와 무관하다.
// 리팩터링 PR에서 이 파일이 실패하면 동작이 바뀐 것이다 — 코드를 고친다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { renderApp, resetAppEnvironment } from './testing/renderApp';
import { createFetchRouter } from './testing/fetchRouter';
import goldenPatients from './core/fixtures/goldenPatients.json';

await vi.hoisted(async () => (await import('./testing/fakeBroadcastChannel.js')).installFakeBroadcastChannel());

configure({ asyncUtilTimeout: 5000 });

const jobPresets = JSON.parse(readFileSync('public/job-presets.json', 'utf8'));
const AUTO_SAVE_KEY = 'wrEvalUnifiedAutoSave';

afterEach(() => resetAppEnvironment());

const patientList = () => screen.getByText(/^환자 목록 \(\d+\)$/);
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/** 엔드포인트별 첫 등장 순서(같은 엔드포인트의 반복은 무시). */
function firstSeenOrder(router) {
  const seen = [];
  for (const c of router.calls) {
    const key = c.route ?? `${c.method} ${c.path}`;
    if (!seen.includes(key)) seen.push(key);
  }
  return seen;
}

const BASE = 'https://srv.test';
const SETTINGS_KEY = 'wrEvalUnifiedSettings';
const SESSION_KEY = 'wrEvalUnifiedAuthSession';
const DOCTOR = { id: 'u-doc-1', displayName: '김의사', role: 'doctor', organizationId: 'org-1' };
const PUBLIC_CONFIG = {
  mode: 'intranet', aiEnabled: false, localFallbackAllowed: false,
  videoAnalysisEnabled: false, statsWorkbenchEnabled: false, statsWorkbenchAvailable: false,
  serverTime: '2026-11-14T00:00:00.000Z',
};

function toServer(p) {
  const at = '2026-11-10T00:00:00.000Z';
  return {
    ...p, assignedDoctorUserId: DOCTOR.id, updatedAt: at, completionStatus: 'incomplete',
    serverObservedModulesCompleteAt: null, serverVerifiedModulesCompleteAt: null,
    sync: { serverId: p.id, revision: 1, syncStatus: 'synced', lastSyncedAt: at },
  };
}

function intranetRouter() {
  const items = goldenPatients.slice(0, 2).map(toServer);
  return createFetchRouter({
    'GET /job-presets.json': jobPresets,
    'GET /api/config/public': PUBLIC_CONFIG,
    'POST /api/auth/csrf': { accessToken: 'tok-1', accessExpiresAt: '2099-01-01T00:00:00.000Z', user: DOCTOR },
    'GET /api/mock/status': () => ({ status: 404, body: { error: 'Not found' } }),
    'GET /api/auth/me': { user: DOCTOR, capabilities: [] },
    'GET /api/presets': { presets: [] },
    'GET /api/patients/doctor-counts': { doctors: [{ userId: DOCTOR.id, name: DOCTOR.displayName, count: 2 }], unassignedCount: 0 },
    'GET /api/workspaces': { items: [] },
    'GET /api/patients': { items, total: items.length },
    'POST /api/patients/:id/lock': { leaseToken: 'lease-1', expiresAt: '2099-01-01T00:00:00.000Z', ttlMs: 60000 },
    'DELETE /api/patients/:id/lock': () => ({ status: 204 }),
  });
}

describe('G9r — 부팅 요청 첫 등장 순서', () => {
  it('G9r-1 웹 로컬(자동저장 복원): 내장 프리셋뿐', async () => {
    localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify({ savedAt: '2026-11-01T01:02:03.000Z', patients: goldenPatients.slice(0, 3) }));
    const router = createFetchRouter({ 'GET /job-presets.json': jobPresets });
    renderApp({ router, confirm: () => true });
    await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (3)'));
    await settle();
    expect(firstSeenOrder(router)).toEqual(['GET /job-presets.json']);
    expect(router.unhandled).toEqual([]);
  });

  it('G9r-2 인트라넷(저장된 세션): 설정 → 세션 확인 → 목록·프리셋·명부 → 편집 락', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ integrationMode: 'intranet', apiBaseUrl: BASE }));
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      version: 1, mode: 'intranet', status: 'ready', apiBaseUrl: BASE,
      refreshedAt: '2026-11-13T00:00:00.000Z', user: { ...DOCTOR, authProvider: 'intranet' },
    }));
    const router = intranetRouter();
    renderApp({ router, confirm: () => true });
    await waitFor(() => expect(patientList().textContent).toBe('환자 목록 (2)'));
    await waitFor(() => expect(router.count('POST /api/patients/:id/lock')).toBeGreaterThan(0));
    await settle();
    expect(firstSeenOrder(router)).toEqual([
      'GET /api/config/public',
      'GET /api/mock/status',
      'GET /job-presets.json',
      'POST /api/auth/csrf',
      'GET /api/presets',
      'GET /api/auth/me',
      'GET /api/workspaces',
      'GET /api/patients',
      'GET /api/patients/doctor-counts',
      'POST /api/patients/:id/lock',
    ]);
    expect(router.unhandled).toEqual([]);
  });
});
