import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// ---------------------------------------------------------------------------
// Mocks
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

vi.mock('../../middleware/audit', () => ({ writeAuditLog: vi.fn(), auditMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()) }));

import { createWorkspacesRouter } from '../workspaces';
import { generateAccessToken } from '../../auth/tokens';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePool(): Pool {
  return { connect: vi.fn(), query: vi.fn() } as unknown as Pool;
}

const CSRF_TOKEN = 'ok';
const CSRF_HASH  = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');

/** Token for an org-scoped user (doctor). */
function orgToken(role: 'admin' | 'doctor' = 'doctor'): string {
  return generateAccessToken({
    sub: 'user-1', sessionId: 'sess-1', orgId: 'org-1',
    role, name: 'Dr. Kim', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

/** Token for a superadmin (null org). */
function superToken(): string {
  return generateAccessToken({
    sub: 'super-1', sessionId: 'sess-2', orgId: null,
    role: 'admin', name: 'Superadmin', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/workspaces', createWorkspacesRouter(pool));
  return app;
}

// Wire: first call is auth middleware session check, subsequent calls are route queries.
function wireQueries(pool: Pool, ...results: { rows: unknown[]; rowCount?: number }[]): void {
  const mock = pool.query as ReturnType<typeof vi.fn>;
  mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth middleware
  for (const r of results) {
    mock.mockResolvedValueOnce(r);
  }
}

// ---------------------------------------------------------------------------
// Sample workspace DB row
// ---------------------------------------------------------------------------
const WS_ROW = {
  id:               'ws-uuid-1',
  name:             'Visit 2024',
  created_at:       new Date('2024-01-15T10:00:00Z'),
  patient_ids:      ['pat-uuid-1'],
  snapshot_payload: [{ id: 'pat-uuid-1', phase: 'evaluation', data: { shared: { name: 'Kim' } } }],
};

const WS_ITEM = {
  id:       'ws-uuid-1',
  name:     'Visit 2024',
  count:    1,
  savedAt:  '2024-01-15T10:00:00.000Z',
  patients: WS_ROW.snapshot_payload,
};

const VALID_BODY = {
  name:     'New Visit',
  patients: [{ id: '00000000-0000-0000-0000-000000000001', phase: 'evaluation', data: {} }],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/workspaces', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] }); // no session
    const res = await request(makeApp(pool)).get('/api/workspaces');
    expect(res.status).toBe(401);
  });

  it('returns 200 with empty items for superadmin (null org)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    // No second query should be made
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('returns 200 with workspace list for org user', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [WS_ROW] });
    const res = await request(makeApp(pool))
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: 'ws-uuid-1', name: 'Visit 2024', count: 1 });
  });

  it('returns 200 with empty list when user has no workspaces', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [] });
    const res = await request(makeApp(pool))
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

describe('GET /api/workspaces/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool)).get('/api/workspaces/ws-uuid-1');
    expect(res.status).toBe(401);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .get('/api/workspaces/ws-uuid-1')
      .set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when workspace not found', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [] }); // not found
    const res = await request(makeApp(pool))
      .get('/api/workspaces/ws-uuid-1')
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('returns 200 with snapshot payload (default)', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [WS_ROW] });
    const res = await request(makeApp(pool))
      .get('/api/workspaces/ws-uuid-1')
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(WS_ITEM);
    expect(res.body.view).toBeUndefined(); // snapshot mode has no view field
  });

  it('returns 200 with current patient records for ?view=current', async () => {
    const pool = makePool();
    const livePayload = { id: 'pat-uuid-1', phase: 'evaluation', data: { shared: { name: 'Kim Updated' } } };
    wireQueries(
      pool,
      { rows: [WS_ROW] },                                        // workspace lookup
      { rows: [{ id: 'pat-uuid-1', deleted_at: null, payload: livePayload }] } // patient_records
    );
    const res = await request(makeApp(pool))
      .get('/api/workspaces/ws-uuid-1?view=current')
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('current');
    expect(res.body.patients).toHaveLength(1);
    expect((res.body.patients[0] as { data: { shared: { name: string } } }).data.shared.name).toBe('Kim Updated');
  });

  it('returns redacted stub for deleted patient in ?view=current', async () => {
    const pool = makePool();
    wireQueries(
      pool,
      { rows: [WS_ROW] },
      { rows: [] } // patient not in patient_records (deleted or not yet migrated)
    );
    const res = await request(makeApp(pool))
      .get('/api/workspaces/ws-uuid-1?view=current')
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('current');
    expect(res.body.patients[0]).toEqual({ id: 'pat-uuid-1', redacted: true });
  });

  it('returns redacted stub for soft-deleted patient in ?view=current', async () => {
    const pool = makePool();
    wireQueries(
      pool,
      { rows: [WS_ROW] },
      { rows: [{ id: 'pat-uuid-1', deleted_at: new Date(), payload: {} }] } // deleted_at set
    );
    const res = await request(makeApp(pool))
      .get('/api/workspaces/ws-uuid-1?view=current')
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.patients[0]).toEqual({ id: 'pat-uuid-1', redacted: true });
  });
});

describe('POST /api/workspaces', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${superToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid body (empty name)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: '', patients: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 for invalid body (patients not array)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'Test', patients: 'not-array' });
    expect(res.status).toBe(400);
  });

  it('returns 201 with updated list on success', async () => {
    const pool = makePool();
    const newRow = { ...WS_ROW, id: 'ws-uuid-2', name: 'New Visit' };
    wireQueries(
      pool,
      { rows: [] },          // INSERT (no return)
      { rows: [newRow, WS_ROW] } // refreshed list
    );
    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].name).toBe('New Visit');
  });

  it('extracts patient UUIDs for patient_ids column', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [] }, { rows: [] });
    await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);

    const mock = pool.query as ReturnType<typeof vi.fn>;
    // Second call is the INSERT (index 1, after auth at index 0)
    const insertCall = mock.mock.calls[1];
    const patientIds = insertCall[1][3]; // 4th param: patient_ids
    expect(patientIds).toContain('00000000-0000-0000-0000-000000000001');
  });

  it('ignores non-UUID patient ids in patient_ids', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [] }, { rows: [] });
    await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'Test', patients: [{ id: 'local-123' }, { id: 'not-a-uuid' }] });

    const mock = pool.query as ReturnType<typeof vi.fn>;
    const insertCall = mock.mock.calls[1];
    const patientIds = insertCall[1][3];
    expect(patientIds).toEqual([]);
  });
});

describe('DELETE /api/workspaces/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool))
      .delete('/api/workspaces/ws-uuid-1')
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(401);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .delete('/api/workspaces/ws-uuid-1')
      .set('Authorization', `Bearer ${superToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(403);
  });

  it('returns 404 when workspace not found or not owned', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [], rowCount: 0 }); // DELETE matched 0 rows
    const res = await request(makeApp(pool))
      .delete('/api/workspaces/ws-uuid-1')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('returns 200 with updated list on success', async () => {
    const pool = makePool();
    wireQueries(
      pool,
      { rows: [], rowCount: 1 }, // DELETE matched 1 row
      { rows: [] }               // refreshed list (now empty)
    );
    const res = await request(makeApp(pool))
      .delete('/api/workspaces/ws-uuid-1')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
