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
  writeAuditLog:    vi.fn(),
  auditMiddleware:  vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { createWorkspacesRouter } from '../workspaces';
import { generateAccessToken } from '../../auth/tokens';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePool(): Pool {
  const query = vi.fn();
  const client = { query, release: vi.fn() };
  return { connect: vi.fn().mockResolvedValue(client), query } as unknown as Pool;
}

const CSRF_TOKEN = 'ok';
const CSRF_HASH  = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');

/** Token for an org-scoped user. */
function orgToken(role: 'admin' | 'doctor' = 'doctor'): string {
  return generateAccessToken({
    sub: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    sessionId: 'sess-1', orgId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    role, name: 'Dr. Kim', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

/** Token for a superadmin (null org). */
function superToken(): string {
  return generateAccessToken({
    sub: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    sessionId: 'sess-2', orgId: null,
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
// Sample data — all IDs are valid UUIDs
// ---------------------------------------------------------------------------
const PAT_ID  = '11111111-1111-1111-1111-111111111111';
const PERSON_ID = '99999999-9999-9999-9999-999999999999';
const WS_ID   = '22222222-2222-2222-2222-222222222222';
const ORG_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const PATIENT_SNAPSHOT = {
  id:    PAT_ID,
  phase: 'evaluation',
  data:  {
    shared: {
      name: 'Kim', patientNo: 'P001', birthDate: '1980-01-01',
      injuryDate: '2024-01-01', evaluationDate: '2024-01-10', diagnoses: [{ code: 'M54.5' }],
      jobs: [{ jobName: '사무직' }],
    },
    modules: {},
    activeModules: ['knee'],
  },
};

const WS_ROW = {
  id:               WS_ID,
  name:             'Visit 2024',
  created_at:       new Date('2024-01-15T10:00:00Z'),
  patient_ids:      [PAT_ID],
  snapshot_payload: [PATIENT_SNAPSHOT],
};

const WS_ITEM = {
  id:       WS_ID,
  name:     'Visit 2024',
  count:    1,
  savedAt:  '2024-01-15T10:00:00.000Z',
  patients: [PATIENT_SNAPSHOT],
};

const VALID_BODY = { name: 'New Visit', patients: [PATIENT_SNAPSHOT] };

// ---------------------------------------------------------------------------
// GET /api/workspaces
// ---------------------------------------------------------------------------
describe('GET /api/workspaces', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
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
    // No second DB query — superadmin short-circuits before listing
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
    expect(res.body.items[0]).toMatchObject({ id: WS_ID, name: 'Visit 2024', count: 1 });
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

// ---------------------------------------------------------------------------
// GET /api/workspaces/:id
// ---------------------------------------------------------------------------
describe('GET /api/workspaces/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool)).get(`/api/workspaces/${WS_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .get(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when workspace not found', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [] });
    const res = await request(makeApp(pool))
      .get(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('returns 200 with snapshot payload (default)', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [WS_ROW] });
    const res = await request(makeApp(pool))
      .get(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(WS_ITEM);
    expect(res.body.view).toBeUndefined();
  });

  it('returns live patient payload for ?view=current', async () => {
    const pool = makePool();
    const live = { ...PATIENT_SNAPSHOT, data: { ...PATIENT_SNAPSHOT.data, shared: { ...PATIENT_SNAPSHOT.data.shared, name: 'Kim Updated' } } };
    wireQueries(
      pool,
      { rows: [WS_ROW] },
      { rows: [{ id: PAT_ID, deleted_at: null, payload: live }] }
    );
    const res = await request(makeApp(pool))
      .get(`/api/workspaces/${WS_ID}?view=current`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('current');
    expect(res.body.patients).toHaveLength(1);
    expect((res.body.patients[0] as typeof live).data.shared.name).toBe('Kim Updated');
  });

  it('returns redacted stub for patient not in patient_records', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [WS_ROW] }, { rows: [] });
    const res = await request(makeApp(pool))
      .get(`/api/workspaces/${WS_ID}?view=current`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.patients[0]).toEqual({ id: PAT_ID, redacted: true });
  });

  it('returns redacted stub for soft-deleted patient', async () => {
    const pool = makePool();
    wireQueries(
      pool,
      { rows: [WS_ROW] },
      { rows: [{ id: PAT_ID, deleted_at: new Date(), payload: {} }] }
    );
    const res = await request(makeApp(pool))
      .get(`/api/workspaces/${WS_ID}?view=current`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.patients[0]).toEqual({ id: PAT_ID, redacted: true });
  });
});

// ---------------------------------------------------------------------------
// POST /api/workspaces
// ---------------------------------------------------------------------------
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

  it('returns 400 for empty name', async () => {
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

  it('returns 400 for patients not array', async () => {
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
    const pool   = makePool();
    const newRow = { ...WS_ROW, id: '33333333-3333-3333-3333-333333333333', name: 'New Visit' };
    const mock   = pool.query as ReturnType<typeof vi.fn>;
    // Call order: auth -> BEGIN -> deleted check -> INSERT workspace -> COMMIT -> existing record lookup
    // -> person lookup/insert -> upsert patient_records -> list
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });   // auth
    mock.mockResolvedValueOnce({ rows: [] });                  // BEGIN
    mock.mockResolvedValueOnce({ rows: [] });                  // deleted patient check
    mock.mockResolvedValueOnce({ rows: [] });                  // INSERT workspace
    mock.mockResolvedValueOnce({ rows: [] });                  // COMMIT
    mock.mockResolvedValueOnce({ rows: [] });                  // SELECT existing patient_records
    mock.mockResolvedValueOnce({ rows: [] });                  // SELECT patient_persons
    mock.mockResolvedValueOnce({ rows: [{ id: PERSON_ID }] }); // INSERT patient_persons
    mock.mockResolvedValueOnce({ rows: [] });                  // upsert patient_records
    mock.mockResolvedValueOnce({ rows: [newRow, WS_ROW] });   // list query

    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].name).toBe('New Visit');
  });

  it('redacts soft-deleted patients before saving a new workspace snapshot', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mock.mockResolvedValueOnce({ rows: [{ id: PAT_ID, deleted_at: new Date('2024-02-01T00:00:00Z') }] });
    mock.mockResolvedValueOnce({ rows: [] }); // INSERT workspace
    mock.mockResolvedValueOnce({ rows: [] }); // COMMIT
    mock.mockResolvedValueOnce({
      rows: [{
        ...WS_ROW,
        snapshot_payload: [{ id: PAT_ID, redacted: true }],
      }],
    }); // list query

    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    const calls = mock.mock.calls as unknown[][];
    const insertWsCall = calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO workspaces')
    );
    expect(insertWsCall).toBeDefined();
    expect(JSON.parse((insertWsCall![1] as unknown[])[4] as string)).toEqual([
      { id: PAT_ID, redacted: true },
    ]);

    const upsertCall = calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_records')
    );
    expect(upsertCall).toBeUndefined();
  });

  it('upserts patient_records after workspace insert', async () => {
    const pool = makePool();
    const mock  = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({ rows: [{ exists: 1 }] });   // all queries succeed

    await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);

    // Transactional workspace insert is followed by best-effort patient_records upsert.
    const calls = (mock).mock.calls;
    const deletedCheckCall = calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('FROM patient_records') &&
      (c[0] as string).includes('FOR SHARE')
    );
    expect(deletedCheckCall).toBeDefined();

    const upsertCall = calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_records')
    );
    expect(upsertCall).toBeDefined();
    expect(upsertCall![1][0]).toBe(PAT_ID);   // id
    expect(upsertCall![1][1]).toBe(ORG_ID);   // organization_id
    expect(upsertCall![1][3]).toBe(USER_ID);  // owner_user_id
    expect(upsertCall![1][4]).toBe(USER_ID);  // assigned_doctor_user_id (resolved: role=doctor, no doctorName)
    expect(upsertCall![1][5]).toBe('Kim');    // name (shifted)
    expect(upsertCall![0]).not.toContain('deleted_at       = NULL');
    expect(upsertCall![0]).toContain('patient_records.deleted_at IS NULL');
  });

  it('reuses existing anonymous patient_person when patientNo is blank', async () => {
    const ANON_PERSON_ID = '55555555-5555-5555-5555-555555555555';
    const anonymousPatient = {
      ...PATIENT_SNAPSHOT,
      data: {
        ...PATIENT_SNAPSHOT.data,
        shared: {
          ...PATIENT_SNAPSHOT.data.shared,
          patientNo: '',
        },
      },
    };
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mock.mockResolvedValueOnce({ rows: [] }); // deleted patient check
    mock.mockResolvedValueOnce({ rows: [] }); // INSERT workspace
    mock.mockResolvedValueOnce({ rows: [] }); // COMMIT
    mock.mockResolvedValueOnce({ rows: [{ patient_person_id: ANON_PERSON_ID }] }); // existing record lookup
    mock.mockResolvedValueOnce({ rows: [] }); // UPDATE existing person
    mock.mockResolvedValueOnce({ rows: [] }); // upsert patient_records
    mock.mockResolvedValueOnce({ rows: [WS_ROW] }); // list query

    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'Anonymous Visit', patients: [anonymousPatient] });

    expect(res.status).toBe(201);
    const calls = mock.mock.calls as unknown[][];
    const insertPersonCall = calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_persons')
    );
    expect(insertPersonCall).toBeUndefined();

    const upsertCall = calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_records')
    );
    expect(upsertCall).toBeDefined();
    expect((upsertCall![1] as unknown[])[2]).toBe(ANON_PERSON_ID);
  });

  it('uses sync.serverId over patient.id when building patient_ids', async () => {
    const SERVER_ID = '44444444-4444-4444-4444-444444444444';
    const patientWithServerId = {
      ...PATIENT_SNAPSHOT,
      sync: { serverId: SERVER_ID, revision: 1, syncStatus: 'synced', lastSyncedAt: null },
    };
    const pool = makePool();
    const mock  = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({ rows: [{ exists: 1 }] });

    await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'Test', patients: [patientWithServerId] });

    const calls = (mock).mock.calls;
    const insertWsCall = calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO workspaces')
    );
    expect(insertWsCall).toBeDefined();
    const patientIds = insertWsCall![1][3]; // 4th param: patient_ids
    expect(patientIds).toContain(SERVER_ID);
    expect(patientIds).not.toContain(PAT_ID);

    // patient_records upsert should also use the server ID
    const upsertCall = calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_records')
    );
    expect(upsertCall![1][0]).toBe(SERVER_ID);
  });

  it('ignores patients with non-UUID or missing id', async () => {
    const pool = makePool();
    const mock  = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({ rows: [{ exists: 1 }] });

    await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ name: 'Test', patients: [{ id: 'local-123' }, { id: 'not-a-uuid' }] });

    const calls = (mock).mock.calls;
    const insertWsCall = calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO workspaces')
    );
    expect(insertWsCall![1][3]).toEqual([]); // patient_ids empty

    // No patient_records upsert (name is missing → meta returns null)
    const upsertCall = calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_records')
    );
    expect(upsertCall).toBeUndefined();
  });

  it('continues workspace save even if patient_records upsert fails', async () => {
    const pool = makePool();
    const mock  = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });  // auth
    mock.mockResolvedValueOnce({ rows: [] });                // BEGIN
    mock.mockResolvedValueOnce({ rows: [] });                // deleted patient check
    mock.mockResolvedValueOnce({ rows: [] });                // INSERT workspace
    mock.mockResolvedValueOnce({ rows: [] });                // COMMIT
    mock.mockResolvedValueOnce({ rows: [] });                // SELECT existing patient_records
    mock.mockResolvedValueOnce({ rows: [] });                // SELECT patient_persons
    mock.mockResolvedValueOnce({ rows: [{ id: PERSON_ID }] }); // INSERT patient_persons
    mock.mockRejectedValueOnce(new Error('DB error'));       // upsert fails
    mock.mockResolvedValueOnce({ rows: [WS_ROW] });         // list query

    const res = await request(makeApp(pool))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);

    // Workspace save must succeed despite patient_records failure
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/workspaces/:id
// ---------------------------------------------------------------------------
describe('PUT /api/workspaces/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool))
      .put(`/api/workspaces/${WS_ID}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 404 when workspace not found or not owned', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mock.mockResolvedValueOnce({ rows: [] }); // deleted patient check
    mock.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE workspace
    mock.mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const res = await request(makeApp(pool))
      .put(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('returns 200 with updated list on overwrite success', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    const updatedRow = { ...WS_ROW, name: 'New Visit' };
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mock.mockResolvedValueOnce({ rows: [] }); // deleted patient check
    mock.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE workspace
    mock.mockResolvedValueOnce({ rows: [] }); // COMMIT
    mock.mockResolvedValueOnce({ rows: [] }); // SELECT existing patient_records
    mock.mockResolvedValueOnce({ rows: [] }); // SELECT patient_persons
    mock.mockResolvedValueOnce({ rows: [{ id: PERSON_ID }] }); // INSERT patient_persons
    mock.mockResolvedValueOnce({ rows: [] }); // upsert patient_records
    mock.mockResolvedValueOnce({ rows: [updatedRow] }); // list query

    const res = await request(makeApp(pool))
      .put(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('New Visit');

    const calls = mock.mock.calls as unknown[][];
    const updateWsCall = calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('UPDATE workspaces')
    );
    expect(updateWsCall).toBeDefined();
    expect((updateWsCall![1] as unknown[])[0]).toBe(WS_ID);

    const insertWsCall = calls.find((c) =>
      typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO workspaces')
    );
    expect(insertWsCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:id
// ---------------------------------------------------------------------------
describe('DELETE /api/workspaces/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool))
      .delete(`/api/workspaces/${WS_ID}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(401);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .delete(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${superToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(403);
  });

  it('returns 404 when workspace not found or not owned', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [], rowCount: 0 });
    const res = await request(makeApp(pool))
      .delete(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('returns 200 with updated list on success', async () => {
    const pool = makePool();
    wireQueries(
      pool,
      { rows: [], rowCount: 1 },
      { rows: [] }
    );
    const res = await request(makeApp(pool))
      .delete(`/api/workspaces/${WS_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
