import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../config', async () => ({
  default: (await import('../../testing/configMock.js')).testConfig(),
}));

vi.mock('../../middleware/audit', () => ({
  writeAuditLog:   vi.fn(),
  auditMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { createAutosaveRouter } from '../autosave';
import { createFakePool, authSessionHandler, sequenceHandler, type FakePool } from '../../testing/fakePool';
import { makeRouterApp } from '../../testing/app';
import { makeAccessToken, authHeaders, TEST_CSRF_TOKEN } from '../../testing/tokens';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// sub/orgId는 testing/tokens 기본 UUID(aaaa…/bbbb…), CSRF 원문 'ok' — 기존 로컬 도우미와 같은 클레임.
function userToken(): string {
  return makeAccessToken({ sessionId: 'sess-1', role: 'doctor', name: 'Dr. Kim' });
}

function autosaveApp(fake: FakePool) {
  return makeRouterApp(a => a.use('/api/autosave', createAutosaveRouter(fake.pool)));
}

// first call = auth middleware session check; subsequent = route queries (호출 순서대로).
function makeFake(...results: { rows: unknown[]; rowCount?: number }[]): FakePool {
  return createFakePool({ handlers: [authSessionHandler(), sequenceHandler(results)] });
}

// 세션 없음(인증 미들웨어가 401) — 원래 테스트는 모든 쿼리에 빈 결과를 줬다.
function makeNoSessionFake(): FakePool {
  return createFakePool({ handlers: [authSessionHandler({ revoked: true })] });
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
    const fake = makeNoSessionFake();
    const res = await request(autosaveApp(fake)).get(`/api/autosave?deviceId=${DEVICE_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 400 when deviceId is missing', async () => {
    const fake = makeFake();
    const res = await request(autosaveApp(fake))
      .get('/api/autosave')
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_ID');
  });

  it('returns 400 when deviceId is empty string', async () => {
    const fake = makeFake();
    const res = await request(autosaveApp(fake))
      .get('/api/autosave?deviceId=')
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_ID');
  });

  it('returns 400 when deviceId exceeds max length', async () => {
    const fake = makeFake();
    const longId = 'x'.repeat(257);
    const res = await request(autosaveApp(fake))
      .get(`/api/autosave?deviceId=${longId}`)
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_ID');
  });

  it('returns null when no autosave exists for device', async () => {
    const fake = makeFake({ rows: [] });
    const res = await request(autosaveApp(fake))
      .get(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('returns savedAt and patients when autosave exists', async () => {
    const fake = makeFake({ rows: [{ saved_at: SAVED_AT, payload: PATIENTS }] });
    const res = await request(autosaveApp(fake))
      .get(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.savedAt).toBe(SAVED_AT.toISOString());
    expect(res.body.patients).toEqual(PATIENTS);
  });

  it('returns empty patients array when payload is not an array', async () => {
    const fake = makeFake({ rows: [{ saved_at: SAVED_AT, payload: null }] });
    const res = await request(autosaveApp(fake))
      .get(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.patients).toEqual([]);
  });

  it('queries by user_id and device_id', async () => {
    const fake = makeFake({ rows: [] });
    await request(autosaveApp(fake))
      .get(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`);
    const select = fake.calls[1]!; // call[0] = auth, call[1] = SELECT
    expect(select.handler).toBe('sequence');
    expect(select.params[0]).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); // user_id
    expect(select.params[1]).toBe(DEVICE_ID);                               // device_id
  });
});

// ---------------------------------------------------------------------------
// PUT /api/autosave
// ---------------------------------------------------------------------------
describe('PUT /api/autosave', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const fake = makeNoSessionFake();
    const res = await request(autosaveApp(fake))
      .put(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('x-csrf-token', TEST_CSRF_TOKEN)
      .send({ patients: PATIENTS });
    expect(res.status).toBe(401);
  });

  it('returns 400 when deviceId is missing', async () => {
    const fake = makeFake();
    const res = await request(autosaveApp(fake))
      .put('/api/autosave')
      .set(authHeaders(userToken()))
      .send({ patients: PATIENTS });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_ID');
  });

  it('returns 400 for invalid body (patients not array)', async () => {
    const fake = makeFake();
    const res = await request(autosaveApp(fake))
      .put(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set(authHeaders(userToken()))
      .send({ patients: 'not-array' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 200 with ok and savedAt on success', async () => {
    const fake = makeFake({ rows: [{ saved_at: SAVED_AT }] });
    const res = await request(autosaveApp(fake))
      .put(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set(authHeaders(userToken()))
      .send({ patients: PATIENTS });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.savedAt).toBe(SAVED_AT.toISOString());
  });

  it('stores patients array as payload via upsert', async () => {
    const fake = makeFake({ rows: [{ saved_at: SAVED_AT }] });
    await request(autosaveApp(fake))
      .put(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set(authHeaders(userToken()))
      .send({ patients: PATIENTS });
    const upsert = fake.calls[1]!; // call[0] = auth, call[1] = UPSERT
    expect(typeof upsert.sql).toBe('string');
    expect(upsert.sql.toUpperCase()).toContain('ON CONFLICT');
    expect(upsert.params[0]).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); // user_id
    expect(upsert.params[1]).toBe(DEVICE_ID);                               // device_id
    expect(upsert.params[2]).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'); // org_id
  });

  it('returns 403 when CSRF token is missing', async () => {
    const fake = makeFake();
    const res = await request(autosaveApp(fake))
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
    const fake = makeNoSessionFake();
    const res = await request(autosaveApp(fake))
      .delete(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('x-csrf-token', TEST_CSRF_TOKEN);
    expect(res.status).toBe(401);
  });

  it('returns 400 when deviceId is missing', async () => {
    const fake = makeFake();
    const res = await request(autosaveApp(fake))
      .delete('/api/autosave')
      .set(authHeaders(userToken()));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DEVICE_ID');
  });

  it('returns 200 ok:true when row exists and is deleted', async () => {
    const fake = makeFake({ rows: [], rowCount: 1 });
    const res = await request(autosaveApp(fake))
      .delete(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set(authHeaders(userToken()));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 200 ok:true even when no row existed (idempotent)', async () => {
    const fake = makeFake({ rows: [], rowCount: 0 });
    const res = await request(autosaveApp(fake))
      .delete(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set(authHeaders(userToken()));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 403 when CSRF token is missing', async () => {
    const fake = makeFake();
    const res = await request(autosaveApp(fake))
      .delete(`/api/autosave?deviceId=${DEVICE_ID}`)
      .set('Authorization', `Bearer ${userToken()}`);
    expect(res.status).toBe(403);
  });
});
