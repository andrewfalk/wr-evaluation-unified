import { describe, it, expect, vi } from 'vitest';
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

import { createPresetsRouter } from '../presets';
import { createFakePool, authSessionHandler, sequenceHandler, pgError, type FakePool, type FakeQueryReply } from '../../testing/fakePool';
import { makeRouterApp } from '../../testing/app';
import { makeAccessToken, authHeaders } from '../../testing/tokens';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const USER_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_ID   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PRESET_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// CSRF 원문은 testing/tokens 기본값('ok') — authHeaders()가 같은 값을 X-CSRF-Token으로 싣는다.
function orgToken(): string {
  return makeAccessToken({ userId: USER_ID, sessionId: 'sess-1', orgId: ORG_ID, role: 'doctor', name: 'Dr. Kim' });
}

function presetsApp(fake: FakePool) {
  return makeRouterApp(a => a.use('/api/presets', createPresetsRouter(fake.pool)));
}

// First call = auth middleware session check; rest = route queries (호출 순서대로, 오류 응답 포함).
function makeFake(...results: (FakeQueryReply | Error)[]): FakePool {
  return createFakePool({ handlers: [authSessionHandler(), sequenceHandler(results)] });
}

const NOW = new Date('2025-01-01T00:00:00.000Z');

function presetRow(overrides = {}) {
  return {
    id:              PRESET_ID,
    organization_id: ORG_ID,
    owner_user_id:   USER_ID,
    job_name:        '건설 근로자',
    category:        '건설업',
    description:     '',
    visibility:      'private',
    revision:        1,
    modules:         { knee: { weight: 20 } },
    created_at:      NOW,
    updated_at:      NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/presets', () => {
  it('returns presets for authenticated user', async () => {
    const fake = makeFake({ rows: [presetRow()] });

    const res = await request(presetsApp(fake))
      .get('/api/presets')
      .set('Authorization', `Bearer ${orgToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.presets).toHaveLength(1);
    expect(res.body.presets[0].jobName).toBe('건설 근로자');
    expect(res.body.presets[0].source).toBe('custom');
    expect(res.body.presets[0].revision).toBe(1);
  });

  it('exposes owner display name from the joined users table', async () => {
    const fake = makeFake({ rows: [presetRow({ owner_user_id: 'other-user-id', visibility: 'organization', owner_name: '홍길동' })] });

    const res = await request(presetsApp(fake))
      .get('/api/presets')
      .set('Authorization', `Bearer ${orgToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.presets[0].ownerName).toBe('홍길동');
    expect(res.body.presets[0].ownerUserId).toBe('other-user-id');
  });

  it('returns 401 without token', async () => {
    const fake = createFakePool();
    const res = await request(presetsApp(fake)).get('/api/presets');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/presets', () => {
  const body = {
    jobName: '건설 근로자',
    category: '건설업',
    description: '',
    modules: { knee: { weight: 20 } },
  };

  it('creates a new preset', async () => {
    // auth check, idempotency check (not found), insert
    const fake = makeFake({ rows: [] }, { rows: [presetRow()] });

    const res = await request(presetsApp(fake))
      .post('/api/presets')
      .set(authHeaders(orgToken()))
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.preset.jobName).toBe('건설 근로자');
  });

  it('creates a new owner-scoped row even when another user shares the same identity', async () => {
    // The idempotency SELECT is scoped to owner_user_id = current user, so a
    // colleague's org-shared preset with the same identity is NOT returned →
    // INSERT proceeds and the preset is owned by the current user.
    const fake = makeFake({ rows: [] }, { rows: [presetRow()] });

    const res = await request(presetsApp(fake))
      .post('/api/presets')
      .set(authHeaders(orgToken()))
      .send({ ...body, visibility: 'organization' });

    expect(res.status).toBe(201);
    expect(res.body.preset.ownerUserId).toBe(USER_ID);
  });

  it('returns 200 (idempotent) when preset already exists', async () => {
    // auth check, idempotency check (found)
    const fake = makeFake({ rows: [presetRow()] });

    const res = await request(presetsApp(fake))
      .post('/api/presets')
      .set(authHeaders(orgToken()))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.preset.id).toBe(PRESET_ID);
  });

  it('returns 400 for missing jobName', async () => {
    const fake = makeFake();

    const res = await request(presetsApp(fake))
      .post('/api/presets')
      .set(authHeaders(orgToken()))
      .send({ ...body, jobName: '' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 200 (idempotent) on concurrent create (23505 unique violation)', async () => {
    // auth check, idempotency SELECT (empty), INSERT → 23505, recovery SELECT
    const uniqueErr = pgError('23505', 'unique violation');
    const fake = makeFake({ rows: [] }, uniqueErr, { rows: [presetRow()] });

    const res = await request(presetsApp(fake))
      .post('/api/presets')
      .set(authHeaders(orgToken()))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.preset.id).toBe(PRESET_ID);
  });

  it('returns 403 for missing CSRF token', async () => {
    const fake = makeFake();

    const res = await request(presetsApp(fake))
      .post('/api/presets')
      .set('Authorization', `Bearer ${orgToken()}`)
      .send(body);

    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/presets/:id', () => {
  it('updates preset with valid If-Match', async () => {
    // auth, fetch existing, update
    const fake = makeFake({ rows: [presetRow()] }, { rows: [presetRow({ revision: 2 })] });

    const res = await request(presetsApp(fake))
      .patch(`/api/presets/${PRESET_ID}`)
      .set(authHeaders(orgToken()))
      .set('If-Match', '1')
      .send({ jobName: '수정된 직종' });

    expect(res.status).toBe(200);
  });

  it('returns 428 when If-Match is missing', async () => {
    const fake = makeFake();

    const res = await request(presetsApp(fake))
      .patch(`/api/presets/${PRESET_ID}`)
      .set(authHeaders(orgToken()))
      .send({ jobName: '수정된 직종' });

    expect(res.status).toBe(428);
    expect(res.body.code).toBe('PRECONDITION_REQUIRED');
  });

  it('returns 409 on revision mismatch', async () => {
    // auth, SELECT (revision=2), atomic UPDATE returns 0 rows (If-Match:1 ≠ 2)
    const fake = makeFake({ rows: [presetRow({ revision: 2 })] }, { rows: [] });

    const res = await request(presetsApp(fake))
      .patch(`/api/presets/${PRESET_ID}`)
      .set(authHeaders(orgToken()))
      .set('If-Match', '1')   // client thinks revision=1, server has 2
      .send({ jobName: '수정된 직종' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REVISION_CONFLICT');
    // serverRevision not returned by the atomic UPDATE path — client retries with GET
  });

  it('returns 404 for unknown preset', async () => {
    const fake = makeFake({ rows: [] });

    const res = await request(presetsApp(fake))
      .patch(`/api/presets/${PRESET_ID}`)
      .set(authHeaders(orgToken()))
      .set('If-Match', '1')
      .send({ jobName: '수정된 직종' });

    expect(res.status).toBe(404);
  });

  it('returns 403 when preset belongs to a different org', async () => {
    const fake = makeFake({ rows: [presetRow({ organization_id: 'other-org-id' })] });

    const res = await request(presetsApp(fake))
      .patch(`/api/presets/${PRESET_ID}`)
      .set(authHeaders(orgToken()))
      .set('If-Match', '1')
      .send({ jobName: '수정된 직종' });

    expect(res.status).toBe(403);
  });

  it('returns 409 DUPLICATE_PRESET when identity collides with another preset', async () => {
    // auth, SELECT existing, UPDATE → 23505 unique violation
    const uniqueErr = pgError('23505', 'unique violation');
    const fake = makeFake({ rows: [presetRow()] }, uniqueErr);

    const res = await request(presetsApp(fake))
      .patch(`/api/presets/${PRESET_ID}`)
      .set(authHeaders(orgToken()))
      .set('If-Match', '1')
      .send({ jobName: '다른 프리셋과 동일한 직종' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_PRESET');
  });
});

describe('DELETE /api/presets/:id', () => {
  it('soft-deletes own preset', async () => {
    // auth, fetch existing, atomic soft-delete (returns id)
    const fake = makeFake({ rows: [presetRow()] }, { rows: [{ id: PRESET_ID }] });

    const res = await request(presetsApp(fake))
      .delete(`/api/presets/${PRESET_ID}`)
      .query({ revision: '1' })
      .set(authHeaders(orgToken()));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 428 when revision param is missing', async () => {
    const fake = makeFake();

    const res = await request(presetsApp(fake))
      .delete(`/api/presets/${PRESET_ID}`)
      .set(authHeaders(orgToken()));

    expect(res.status).toBe(428);
    expect(res.body.code).toBe('PRECONDITION_REQUIRED');
  });

  it('returns 409 on revision mismatch (stale delete)', async () => {
    // auth, SELECT (current revision=2), atomic UPDATE returns 0 rows (client sent revision=1)
    const fake = makeFake({ rows: [presetRow({ revision: 2 })] }, { rows: [] });

    const res = await request(presetsApp(fake))
      .delete(`/api/presets/${PRESET_ID}`)
      .query({ revision: '1' })
      .set(authHeaders(orgToken()));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REVISION_CONFLICT');
  });

  it('returns 403 when deleting another user\'s preset', async () => {
    const fake = makeFake({ rows: [presetRow({ owner_user_id: 'other-user-id' })] });

    const res = await request(presetsApp(fake))
      .delete(`/api/presets/${PRESET_ID}`)
      .query({ revision: '1' })
      .set(authHeaders(orgToken()));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns 404 for unknown preset', async () => {
    const fake = makeFake({ rows: [] });

    const res = await request(presetsApp(fake))
      .delete(`/api/presets/${PRESET_ID}`)
      .query({ revision: '1' })
      .set(authHeaders(orgToken()));

    expect(res.status).toBe(404);
  });

  it('returns 403 for missing CSRF token', async () => {
    const fake = makeFake();

    const res = await request(presetsApp(fake))
      .delete(`/api/presets/${PRESET_ID}`)
      .query({ revision: '1' })
      .set('Authorization', `Bearer ${orgToken()}`);

    expect(res.status).toBe(403);
  });
});
