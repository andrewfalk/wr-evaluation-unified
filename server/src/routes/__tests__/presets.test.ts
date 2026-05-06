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

import { createPresetsRouter } from '../presets';
import { generateAccessToken } from '../../auth/tokens';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const USER_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_ID   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PRESET_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CSRF_TOKEN = 'ok';
const CSRF_HASH  = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePool(): Pool {
  return { connect: vi.fn(), query: vi.fn() } as unknown as Pool;
}

function orgToken(): string {
  return generateAccessToken({
    sub: USER_ID, sessionId: 'sess-1', orgId: ORG_ID,
    role: 'doctor', name: 'Dr. Kim', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/presets', createPresetsRouter(pool));
  return app;
}

// First call = auth middleware session check; rest = route queries.
function wireQueries(pool: Pool, ...results: { rows: unknown[]; rowCount?: number }[]): void {
  const mock = pool.query as ReturnType<typeof vi.fn>;
  mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
  for (const r of results) {
    mock.mockResolvedValueOnce(r);
  }
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
    const pool = makePool();
    wireQueries(pool, { rows: [presetRow()] });

    const res = await request(makeApp(pool))
      .get('/api/presets')
      .set('Authorization', `Bearer ${orgToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.presets).toHaveLength(1);
    expect(res.body.presets[0].jobName).toBe('건설 근로자');
    expect(res.body.presets[0].source).toBe('custom');
    expect(res.body.presets[0].revision).toBe(1);
  });

  it('returns 401 without token', async () => {
    const pool = makePool();
    const res = await request(makeApp(pool)).get('/api/presets');
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
    const pool = makePool();
    // auth check, idempotency check (not found), insert
    wireQueries(pool, { rows: [] }, { rows: [presetRow()] });

    const res = await request(makeApp(pool))
      .post('/api/presets')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.preset.jobName).toBe('건설 근로자');
  });

  it('returns 200 (idempotent) when preset already exists', async () => {
    const pool = makePool();
    // auth check, idempotency check (found)
    wireQueries(pool, { rows: [presetRow()] });

    const res = await request(makeApp(pool))
      .post('/api/presets')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.preset.id).toBe(PRESET_ID);
  });

  it('returns 400 for missing jobName', async () => {
    const pool = makePool();
    wireQueries(pool);

    const res = await request(makeApp(pool))
      .post('/api/presets')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({ ...body, jobName: '' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 403 for missing CSRF token', async () => {
    const pool = makePool();
    wireQueries(pool);

    const res = await request(makeApp(pool))
      .post('/api/presets')
      .set('Authorization', `Bearer ${orgToken()}`)
      .send(body);

    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/presets/:id', () => {
  it('updates preset with valid If-Match', async () => {
    const pool = makePool();
    // auth, fetch existing, update
    wireQueries(pool, { rows: [presetRow()] }, { rows: [presetRow({ revision: 2 })] });

    const res = await request(makeApp(pool))
      .patch(`/api/presets/${PRESET_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .set('If-Match', '1')
      .send({ jobName: '수정된 직종' });

    expect(res.status).toBe(200);
  });

  it('returns 428 when If-Match is missing', async () => {
    const pool = makePool();
    wireQueries(pool);

    const res = await request(makeApp(pool))
      .patch(`/api/presets/${PRESET_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({ jobName: '수정된 직종' });

    expect(res.status).toBe(428);
    expect(res.body.code).toBe('PRECONDITION_REQUIRED');
  });

  it('returns 409 on revision mismatch', async () => {
    const pool = makePool();
    // auth, SELECT (revision=2), atomic UPDATE returns 0 rows (If-Match:1 ≠ 2)
    wireQueries(pool, { rows: [presetRow({ revision: 2 })] }, { rows: [] });

    const res = await request(makeApp(pool))
      .patch(`/api/presets/${PRESET_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .set('If-Match', '1')   // client thinks revision=1, server has 2
      .send({ jobName: '수정된 직종' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REVISION_CONFLICT');
    // serverRevision not returned by the atomic UPDATE path — client retries with GET
  });

  it('returns 404 for unknown preset', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [] });

    const res = await request(makeApp(pool))
      .patch(`/api/presets/${PRESET_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .set('If-Match', '1')
      .send({ jobName: '수정된 직종' });

    expect(res.status).toBe(404);
  });

  it('returns 403 when preset belongs to a different org', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [presetRow({ organization_id: 'other-org-id' })] });

    const res = await request(makeApp(pool))
      .patch(`/api/presets/${PRESET_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .set('If-Match', '1')
      .send({ jobName: '수정된 직종' });

    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/presets/:id', () => {
  it('soft-deletes own preset', async () => {
    const pool = makePool();
    // auth, fetch existing, soft delete
    wireQueries(pool, { rows: [presetRow()] }, { rows: [] });

    const res = await request(makeApp(pool))
      .delete(`/api/presets/${PRESET_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 403 when deleting another user\'s preset', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [presetRow({ owner_user_id: 'other-user-id' })] });

    const res = await request(makeApp(pool))
      .delete(`/api/presets/${PRESET_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns 404 for unknown preset', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [] });

    const res = await request(makeApp(pool))
      .delete(`/api/presets/${PRESET_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('X-CSRF-Token', CSRF_TOKEN);

    expect(res.status).toBe(404);
  });

  it('returns 403 for missing CSRF token', async () => {
    const pool = makePool();
    wireQueries(pool);

    const res = await request(makeApp(pool))
      .delete(`/api/presets/${PRESET_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`);

    expect(res.status).toBe(403);
  });
});
