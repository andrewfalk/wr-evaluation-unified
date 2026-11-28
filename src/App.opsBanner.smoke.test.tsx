// @vitest-environment jsdom
//
// 운영 경고 배너와 관리자 콘솔(P2-83e, Phase 2 C9 구간 C) — 앱 셸 배선.
//   ① 배너를 누르면 관리자 콘솔이 **운영 상태 탭**으로 열린다. 닫고 계정 메뉴로 다시 열면 지금처럼 감사 로그 탭.
//   ② 운영 상태 탭에서 알림을 처리(확인·해결 완료)하면 배너를 다음 폴링(5분)까지 기다리지 않고 바로 다시 판정한다.
// G9m(App.modals.smoke)과 같은 방식: AppRoot(StrictMode)를 그리고 서버는 fetchRouter, 단언은 역할·화면 텍스트로.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { renderApp, resetAppEnvironment } from './testing/renderApp';
import { createFetchRouter } from './testing/fetchRouter';

// G9와 같은 이유(P2-09): 다른 worker의 BroadcastChannel('wr-auth') 메시지가 닿지 않게 정적 import보다 먼저 설치.
await vi.hoisted(async () => (await import('./testing/fakeBroadcastChannel.js')).installFakeBroadcastChannel());

configure({ asyncUtilTimeout: 5000 });

type Fields = Record<string, unknown>;
interface Router { unhandled: string[]; count(key: string): number; set(key: string, value: unknown): void }

const jobPresets: unknown = JSON.parse(readFileSync('public/job-presets.json', 'utf8'));
const goldenPatients = JSON.parse(readFileSync('src/core/fixtures/goldenPatients.json', 'utf8')) as Array<Fields & { id: string }>;

const BASE = 'https://srv.test';
const ADMIN = { id: 'u-adm-1', displayName: '합성관리', role: 'admin', organizationId: 'org-1' };
const PUBLIC_CONFIG = {
  mode: 'intranet', aiEnabled: false, localFallbackAllowed: false,
  videoAnalysisEnabled: false, statsWorkbenchEnabled: false, statsWorkbenchAvailable: false,
  serverTime: '2026-11-14T00:00:00.000Z',
};
const ALERT_REPORT = {
  checkedAt: '2026-11-27T21:00:00.000Z', summary: 'alert_open', isStale: false, staleThresholdHours: 30,
  lastSuccessAt: '2026-11-25T18:00:00.000Z',
  openAlerts: [{ runId: 'run-synthetic-1', reasonClass: 'synthetic_failure', createdAt: '2026-11-26T18:00:00.000Z', dryRun: false }],
};
const OK_REPORT = { ...ALERT_REPORT, summary: 'ok', openAlerts: [] };
const BANNER = /백업 실패 알림이 미처리 상태입니다/;

const routers: Router[] = [];
afterEach(() => {
  try {
    for (const router of routers) expect(router.unhandled, 'unregistered requests').toEqual([]);
  } finally {
    routers.length = 0;
    resetAppEnvironment();
  }
});

function seedIntranet() {
  localStorage.setItem('wrEvalUnifiedSettings', JSON.stringify({ integrationMode: 'intranet', apiBaseUrl: BASE }));
  localStorage.setItem('wrEvalUnifiedAuthSession', JSON.stringify({
    version: 1, mode: 'intranet', status: 'ready', apiBaseUrl: BASE,
    refreshedAt: '2026-11-13T00:00:00.000Z', user: { ...ADMIN, authProvider: 'intranet' },
  }));
}

function adminRouter(backupStatus: () => Fields): Router {
  const at = '2026-11-10T00:00:00.000Z';
  const items = goldenPatients.slice(0, 2).map((p) => ({
    ...p, assignedDoctorUserId: ADMIN.id, updatedAt: at, completionStatus: 'incomplete',
    serverObservedModulesCompleteAt: null, serverVerifiedModulesCompleteAt: null,
    sync: { serverId: p.id, revision: 1, syncStatus: 'synced', lastSyncedAt: at },
  }));
  const router = createFetchRouter({
    'GET /job-presets.json': jobPresets,
    'GET /api/config/public': PUBLIC_CONFIG,
    'POST /api/auth/csrf': { accessToken: 'tok-1', accessExpiresAt: '2099-01-01T00:00:00.000Z', user: ADMIN },
    'GET /api/mock/status': () => ({ status: 404, body: { error: 'Not found' } }),
    'GET /api/auth/me': { user: ADMIN, capabilities: [] },
    'GET /api/presets': { presets: [] },
    'GET /api/patients/doctor-counts': { doctors: [], unassignedCount: 0 },
    'GET /api/workspaces': { items: [] },
    'GET /api/patients': { items, total: items.length },
    'POST /api/patients/:id/lock': { leaseToken: 'lease-1', expiresAt: '2099-01-01T00:00:00.000Z', ttlMs: 60000 },
    'DELETE /api/patients/:id/lock': () => ({ status: 204 }),
    'GET /api/admin/ops/backup-status': () => ({ body: backupStatus() }),
    'GET /api/admin/audit': { items: [], total: 0 },
  }) as unknown as Router;
  routers.push(router);
  return router;
}

async function boot(backupStatus: () => Fields) {
  seedIntranet();
  const router = adminRouter(backupStatus);
  renderApp({ router: router as unknown as { fetch: typeof fetch }, confirm: () => true });
  await waitFor(() => expect(screen.getByText(/^환자 목록 \(\d+\)$/).textContent).toBe('환자 목록 (2)'));
  return router;
}

async function openedAdminConsole() {
  let el: HTMLElement | null = await screen.findByRole('heading', { name: '관리자 콘솔' });
  while (el && !within(el).queryAllByRole('button', { name: '닫기' }).length) el = el.parentElement;
  if (!el) throw new Error('관리자 콘솔 상자를 찾지 못함');
  return el;
}

const closeAdminConsole = async (modal: HTMLElement) => {
  fireEvent.click(within(modal).getAllByRole('button', { name: '닫기' }).at(-1) as HTMLElement);
  await waitFor(() => expect(screen.queryByRole('heading', { name: '관리자 콘솔' })).toBeNull());
};

const openFromAccountMenu = () => {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(ADMIN.displayName) }));
  fireEvent.click(screen.getByRole('button', { name: '관리자 콘솔' }));
};

describe('운영 경고 배너 ↔ 관리자 콘솔', () => {
  it('① 배너를 누르면 운영 상태 탭으로 열리고, 닫은 뒤 계정 메뉴로 열면 감사 로그 탭', async () => {
    await boot(() => ({ monitorReport: ALERT_REPORT, backupStatus: null }));
    fireEvent.click(await screen.findByRole('button', { name: BANNER }));
    const modal = await openedAdminConsole();
    expect(await within(modal).findByText('백업 운영 상태')).toBeTruthy();
    expect(within(modal).queryByPlaceholderText('액션 필터 (예: patient_push)')).toBeNull();
    await closeAdminConsole(modal);

    openFromAccountMenu();
    const again = await openedAdminConsole();
    expect(within(again).getByPlaceholderText('액션 필터 (예: patient_push)')).toBeTruthy();
    expect(within(again).queryByText('백업 운영 상태')).toBeNull();
  }, 20000);

  it('② 운영 상태 탭에서 알림을 해결하면 배너가 바로 사라진다', async () => {
    let report: Fields = ALERT_REPORT;
    const router = await boot(() => ({ monitorReport: report, backupStatus: null }));
    router.set('POST /api/admin/ops/backup-alerts/:runId/:action', () => {
      report = OK_REPORT;
      return { body: { ok: true } };
    });
    expect(await screen.findByRole('button', { name: BANNER })).toBeTruthy();
    openFromAccountMenu();
    const modal = await openedAdminConsole();
    fireEvent.click(within(modal).getByRole('button', { name: '운영 상태' }));
    fireEvent.click(await within(modal).findByRole('button', { name: '해결 완료' }));
    await within(modal).findByText('미처리 알림 없음');
    await waitFor(() => expect(screen.queryByRole('button', { name: BANNER })).toBeNull());
    expect(router.count('POST /api/admin/ops/backup-alerts/:runId/:action')).toBe(1);
  }, 20000);
});
