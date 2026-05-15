import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that trigger module evaluation
// ---------------------------------------------------------------------------
vi.mock('../../config', () => ({
  default: {
    env:  'test',
    cors: { origins: [] },
    auth: {
      accessTokenTtl:     900,
      accessTokenSecret:  'test-access-secret',
      refreshTokenSecret: 'test-refresh-secret',
    },
  },
}));

vi.mock('../../middleware/audit', () => ({ writeAuditLog: vi.fn() }));

// fs/promises is mocked per-test via vi.mocked().mockResolvedValue below.
// The mock is hoisted so every import of 'node:fs/promises' in the module
// under test sees the same stub object.
vi.mock('node:fs/promises', () => ({
  default: {
    readFile:  vi.fn(),
    readdir:   vi.fn(),
    writeFile: vi.fn(),
    rename:    vi.fn(),
  },
}));

import fs from 'node:fs/promises';
import { createOpsStatusRouter } from '../opsStatus';
import { generateAccessToken } from '../../auth/tokens';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CSRF_TOKEN = 'ok';
const CSRF_HASH  = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');

function makePool(): Pool {
  return {
    connect: vi.fn(),
    query:   vi.fn(),
  } as unknown as Pool;
}

function token(role: 'admin' | 'doctor' = 'admin'): string {
  return generateAccessToken({
    sub: 'admin-1', sessionId: 'sess-1', orgId: 'org-1',
    role, name: 'Admin User', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/ops', createOpsStatusRouter(pool));
  return app;
}

// Auth middleware expects pool.query to return { rows: [{ exists: 1 }] } for a valid session.
function wireAuth(pool: Pool): void {
  (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
}

// Canonical alert fixtures
const OPEN_REAL_ALERT = {
  type: 'backup_failed', severity: 'critical',
  runId: '20260513_020000', dryRun: false, purpose: null,
  reasonClass: 'gpg_encrypt_failed',
  createdAt: '2026-05-13T02:00:45Z',
  acknowledgedAt: null, acknowledgedBy: null,
  resolvedAt: null, resolvedBy: null,
};

const OPEN_DRY_ALERT = {
  ...OPEN_REAL_ALERT,
  runId: '20260514_020000', dryRun: true, purpose: 'step14_verification',
};

const MONITOR_REPORT = {
  checkedAt: '2026-05-13T03:00:00Z',
  isStale: false,
  staleThresholdHours: 36,
  lastSuccessAt: '2026-05-13T02:01:23Z',
  openAlerts: [OPEN_REAL_ALERT],
  summary: 'alert_open',
};

const BACKUP_STATUS = {
  status: 'success', runId: '20260513_020000',
  job: 'daily-backup', dryRun: false,
  lastStartedAt: '2026-05-13T02:00:00Z',
  lastFinishedAt: '2026-05-13T02:01:23Z',
  lastSuccessAt: '2026-05-13T02:01:23Z',
  lastFailureAt: null, reasonClass: null,
};

// ---------------------------------------------------------------------------
// GET /api/admin/ops/backup-status
// ---------------------------------------------------------------------------
describe('GET /api/admin/ops/backup-status', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
    const res = await request(makeApp(pool)).get('/api/admin/ops/backup-status');
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not admin', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .get('/api/admin/ops/backup-status')
      .set('Authorization', `Bearer ${token('doctor')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns 503 when neither status file exists', async () => {
    const pool = makePool();
    wireAuth(pool);
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(fs.readdir).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const res = await request(makeApp(pool))
      .get('/api/admin/ops/backup-status')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(503);
  });

  it('returns 200 with monitorReport and backupStatus', async () => {
    const pool = makePool();
    wireAuth(pool);
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(JSON.stringify(MONITOR_REPORT) as never) // monitor-report.json
      .mockResolvedValueOnce(JSON.stringify(BACKUP_STATUS) as never)  // backup-status.json
      .mockResolvedValueOnce(JSON.stringify(OPEN_REAL_ALERT) as never); // alert file
    vi.mocked(fs.readdir).mockResolvedValue(['FAILED_20260513_020000.json'] as never);

    const res = await request(makeApp(pool))
      .get('/api/admin/ops/backup-status')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.monitorReport.openAlerts).toHaveLength(1);
    expect(res.body.backupStatus.status).toBe('success');
  });

  it('live-reads openAlerts so resolved alerts are excluded immediately', async () => {
    const pool = makePool();
    wireAuth(pool);
    // monitor-report.json still says alert_open (stale data)
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(JSON.stringify(MONITOR_REPORT) as never)
      .mockResolvedValueOnce(JSON.stringify(BACKUP_STATUS) as never);
    // But _alerts/ directory is now empty (alert was resolved)
    vi.mocked(fs.readdir).mockResolvedValue([] as never);

    const res = await request(makeApp(pool))
      .get('/api/admin/ops/backup-status')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.monitorReport.openAlerts).toHaveLength(0);
    expect(res.body.monitorReport.summary).toBe('ok'); // recomputed live
  });

  it('recomputes summary=stale when isStale=true and no real alerts', async () => {
    const pool = makePool();
    wireAuth(pool);
    const staleReport = { ...MONITOR_REPORT, isStale: true, summary: 'stale_and_alert' };
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(JSON.stringify(staleReport) as never)
      .mockResolvedValueOnce(JSON.stringify(BACKUP_STATUS) as never)
      .mockResolvedValueOnce(JSON.stringify(OPEN_DRY_ALERT) as never); // only dry-run alert
    vi.mocked(fs.readdir).mockResolvedValue(['FAILED_20260514_020000.json'] as never);

    const res = await request(makeApp(pool))
      .get('/api/admin/ops/backup-status')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    // stale=true, realAlertCount=0, totalAlertCount=1 → should be 'stale' not 'stale_and_alert'
    expect(res.body.monitorReport.summary).toBe('stale');
  });

  it('dry_run_alert_open summary when all open alerts are dry-run', async () => {
    const pool = makePool();
    wireAuth(pool);
    const dryReport = { ...MONITOR_REPORT, isStale: false, summary: 'ok' };
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(JSON.stringify(dryReport) as never)
      .mockResolvedValueOnce(JSON.stringify(BACKUP_STATUS) as never)
      .mockResolvedValueOnce(JSON.stringify(OPEN_DRY_ALERT) as never);
    vi.mocked(fs.readdir).mockResolvedValue(['FAILED_20260514_020000.json'] as never);

    const res = await request(makeApp(pool))
      .get('/api/admin/ops/backup-status')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.monitorReport.summary).toBe('dry_run_alert_open');
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/ops/backup-alerts/:runId/ack
// ---------------------------------------------------------------------------
describe('POST /api/admin/ops/backup-alerts/:runId/ack', () => {
  const RUN_ID = '20260513_020000';

  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
    const res = await request(makeApp(pool))
      .post(`/api/admin/ops/backup-alerts/${RUN_ID}/ack`);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not admin', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .post(`/api/admin/ops/backup-alerts/${RUN_ID}/ack`)
      .set('Authorization', `Bearer ${token('doctor')}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 when CSRF token is missing', async () => {
    const pool = makePool();
    wireAuth(pool);
    const res = await request(makeApp(pool))
      .post(`/api/admin/ops/backup-alerts/${RUN_ID}/ack`)
      .set('Authorization', `Bearer ${token()}`);
    // no x-csrf-token header
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_INVALID');
  });

  it('returns 400 for invalid runId format', async () => {
    const pool = makePool();
    wireAuth(pool);
    // runId must match /^\d{8}_\d{6}$/ — anything else is rejected before file access
    const res = await request(makeApp(pool))
      .post('/api/admin/ops/backup-alerts/not-a-valid-id/ack')
      .set('Authorization', `Bearer ${token()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(400);
  });

  it('returns 404 when alert file does not exist', async () => {
    const pool = makePool();
    wireAuth(pool);
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const res = await request(makeApp(pool))
      .post(`/api/admin/ops/backup-alerts/${RUN_ID}/ack`)
      .set('Authorization', `Bearer ${token()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(404);
  });

  it('sets acknowledgedAt and acknowledgedBy on success', async () => {
    const pool = makePool();
    wireAuth(pool);
    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(OPEN_REAL_ALERT) as never);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined as never);
    vi.mocked(fs.rename).mockResolvedValue(undefined as never);

    const res = await request(makeApp(pool))
      .post(`/api/admin/ops/backup-alerts/${RUN_ID}/ack`)
      .set('Authorization', `Bearer ${token()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.alert.acknowledgedAt).toBeTruthy();
    expect(res.body.alert.acknowledgedBy).toBe('admin-1');
  });

  it('is idempotent — returns 200 when already acknowledged', async () => {
    const pool = makePool();
    wireAuth(pool);
    const alreadyAcked = { ...OPEN_REAL_ALERT, acknowledgedAt: '2026-05-13T04:00:00Z', acknowledgedBy: 'admin-1' };
    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(alreadyAcked) as never);

    const res = await request(makeApp(pool))
      .post(`/api/admin/ops/backup-alerts/${RUN_ID}/ack`)
      .set('Authorization', `Bearer ${token()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.alert.acknowledgedAt).toBe('2026-05-13T04:00:00Z');
    // writeFile should NOT be called — idempotent path skips write
    expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/ops/backup-alerts/:runId/resolve
// ---------------------------------------------------------------------------
describe('POST /api/admin/ops/backup-alerts/:runId/resolve', () => {
  const RUN_ID = '20260513_020000';

  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 403 when CSRF token is missing', async () => {
    const pool = makePool();
    wireAuth(pool);
    const res = await request(makeApp(pool))
      .post(`/api/admin/ops/backup-alerts/${RUN_ID}/resolve`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_INVALID');
  });

  it('sets resolvedAt and resolvedBy on success', async () => {
    const pool = makePool();
    wireAuth(pool);
    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(OPEN_REAL_ALERT) as never);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined as never);
    vi.mocked(fs.rename).mockResolvedValue(undefined as never);

    const res = await request(makeApp(pool))
      .post(`/api/admin/ops/backup-alerts/${RUN_ID}/resolve`)
      .set('Authorization', `Bearer ${token()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.alert.resolvedAt).toBeTruthy();
    expect(res.body.alert.resolvedBy).toBe('admin-1');
  });

  it('is idempotent — returns 200 when already resolved', async () => {
    const pool = makePool();
    wireAuth(pool);
    const alreadyResolved = { ...OPEN_REAL_ALERT, resolvedAt: '2026-05-13T05:00:00Z', resolvedBy: 'admin-1' };
    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(alreadyResolved) as never);

    const res = await request(makeApp(pool))
      .post(`/api/admin/ops/backup-alerts/${RUN_ID}/resolve`)
      .set('Authorization', `Bearer ${token()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.alert.resolvedAt).toBe('2026-05-13T05:00:00Z');
    expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
  });
});
