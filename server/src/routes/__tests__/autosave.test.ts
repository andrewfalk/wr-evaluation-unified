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

vi.mock('../../middleware/audit', () => ({
  writeAuditLog:   vi.fn(),
  auditMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { createAutosaveRouter } from '../autosave';
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

function userToken(): string {
  return generateAccessToken({
    sub: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    sessionId: 'sess-1',
    orgId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    role: 'doctor', name: 'Dr. Kim', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/autosave', createAutosaveRouter(pool));
  return app;
}

// Wire: first call = auth middleware session check; subsequent = route queries.
function wireQueries(pool: Pool, ...results: { rows: unknown[]; rowCount?: number }[]): void {
  const mock = pool.query as ReturnType<typeof vi.fn>;
  mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
  for (const r of results) mock.mockResolvedValueOnce(r);
}

const DEVICE_ID = 'device-abc-123';
const PATIENTS  = [{ id: '11111111-1111-1111-1111-111111111111', phase: 'evaluation' }];
const SAVED_AT  = new Date('2024-06-01T09:00:00Z');

// ---------------------------------------------------------------------------
// GET /api/autosave
// ---------------------------------------------------------------------------
describe('GET /api/autosave', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool)).get(`/api/autosave?deviceId=${DEVICE_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 400 when deviceId is missing', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .get('/api/autosave')
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_ID');
  });

  it('returns 400 when deviceId is empty string', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .get('/api/autosave?deviceId=')
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_ID');
  });

  it('returns 400 when deviceId exceeds max length', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const longId = 'x'.repeat(257);
    const res = await request(makeApp(pool))
      .get(`/api/autosave?deviceId=${longId}`)
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_ID');
  });

  it('returns null when no autosave exists for device', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [] });
    const res = await request(makeApp(pool))
      .get(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('returns savedAt and patients when autosave exists', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [{ saved_at: SAVED_AT, payload: PATIENTS }] });
    const res = await request(makeApp(pool))
      .get(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.savedAt).toBe(SAVED_AT.toISOString());
    expect(res.body.patients).toEqual(PATIENTS);
  });

  it('returns empty patients array when payload is not an array', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [{ saved_at: SAVED_AT, payload: null }] });
    const res = await request(makeApp(pool))
      .get(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.patients).toEqual([]);
  });

  it('queries by user_id and device_id', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [] });
    await request(makeApp(pool))
      .get(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`);
    const mock   = pool.query as ReturnType<typeof vi.fn>;
    const select = mock.mock.calls[1]; // call[0] = auth, call[1] = SELECT
    expect(select[1][0]).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); // user_id
    expect(select[1][1]).toBe(DEVICE_ID);                               // device_id
  });
});

// ---------------------------------------------------------------------------
// PUT /api/autosave
// ---------------------------------------------------------------------------
describe('PUT /api/autosave', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool))
      .put(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ patients: PATIENTS });
    expect(res.status).toBe(401);
  });

  it('returns 400 when deviceId is missing', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .put('/api/autosave')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ patients: PATIENTS });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_ID');
  });

  it('returns 400 for invalid body (patients not array)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .put(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ patients: 'not-array' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 200 with ok and savedAt on success', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [{ saved_at: SAVED_AT }] });
    const res = await request(makeApp(pool))
      .put(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ patients: PATIENTS });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.savedAt).toBe(SAVED_AT.toISOString());
  });

  it('stores patients array as payload via upsert', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [{ saved_at: SAVED_AT }] });
    await request(makeApp(pool))
      .put(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ patients: PATIENTS });
    const mock   = pool.query as ReturnType<typeof vi.fn>;
    const upsert = mock.mock.calls[1]; // call[0] = auth, call[1] = UPSERT
    expect(typeof upsert[0]).toBe('string');
    expect((upsert[0] as string).toUpperCase()).toContain('ON CONFLICT');
    expect(upsert[1][0]).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); // user_id
    expect(upsert[1][1]).toBe(DEVICE_ID);                               // device_id
    expect(upsert[1][2]).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'); // org_id
  });

  it('returns 403 when CSRF token is missing', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .put(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`)
      // no x-csrf-token header
      .send({ patients: PATIENTS });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/autosave
// ---------------------------------------------------------------------------
describe('DELETE /api/autosave', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool))
      .delete(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(401);
  });

  it('returns 400 when deviceId is missing', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .delete('/api/autosave')
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_ID');
  });

  it('returns 200 ok:true when row exists and is deleted', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [], rowCount: 1 });
    const res = await request(makeApp(pool))
      .delete(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 200 ok:true even when no row existed (idempotent)', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [], rowCount: 0 });
    const res = await request(makeApp(pool))
      .delete(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 403 when CSRF token is missing', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .delete(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(403);
  });
});
