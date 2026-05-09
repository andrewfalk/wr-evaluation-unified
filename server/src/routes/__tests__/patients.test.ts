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

import { createPatientsRouter } from '../patients';
import { generateAccessToken } from '../../auth/tokens';
import { writeAuditLog } from '../../middleware/audit';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePool(): Pool {
  return { connect: vi.fn(), query: vi.fn() } as unknown as Pool;
}

const CSRF_TOKEN = 'ok';
const CSRF_HASH  = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');

function orgToken(): string {
  return generateAccessToken({
    sub: USER_ID, sessionId: 'sess-1', orgId: ORG_ID,
    role: 'doctor', name: 'Dr. Kim', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function superToken(): string {
  return generateAccessToken({
    sub: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    sessionId: 'sess-2', orgId: null,
    role: 'admin', name: 'Superadmin', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function adminToken(): string {
  return generateAccessToken({
    sub: ADMIN_ID, sessionId: 'sess-3', orgId: ORG_ID,
    role: 'admin', name: 'Admin User', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/patients', createPatientsRouter(pool));
  return app;
}

// first call = auth middleware session check; rest = route queries
function wireQueries(pool: Pool, ...results: { rows: unknown[]; rowCount?: number }[]): void {
  const mock = pool.query as ReturnType<typeof vi.fn>;
  mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
  for (const r of results) {
    mock.mockResolvedValueOnce(r);
  }
}

// Routes that use pool.connect() + client.query() (POST, DELETE) need this helper.
// Auth middleware still goes through pool.query (first call); all subsequent
// queries go through the dedicated client returned by pool.connect().
function makeClientSetup(pool: Pool, ...clientResults: { rows: unknown[]; rowCount?: number }[]) {
  const clientMock = { query: vi.fn(), release: vi.fn() };
  (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(clientMock);
  (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
  const cq = clientMock.query as ReturnType<typeof vi.fn>;
  for (const r of clientResults) cq.mockResolvedValueOnce(r);
  return cq;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
const PAT_ID  = '11111111-1111-1111-1111-111111111111';
const PERSON_ID = '99999999-9999-9999-9999-999999999999';
const ORG_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const IDEMP_KEY = 'idem-key-0000-0000-0000-000000000001';

const NOW       = new Date('2024-06-01T10:00:00Z');
const LATER     = new Date('2024-06-01T11:00:00Z');

const SHARED = {
  name: 'Kim', patientNo: 'P001', birthDate: '1980-01-01',
  injuryDate: '2024-01-01', evaluationDate: '2024-06-01', diagnoses: [{ code: 'M54.5' }],
  jobs: [{ jobName: '사무직' }],
};

const VALID_DATA = {
  shared:        SHARED,
  modules:       {},
  activeModules: ['knee'],
};

const CREATE_BODY = { id: PAT_ID, phase: 'evaluation', data: VALID_DATA };

const DOCTOR_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const ADMIN_ID  = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const PAT_ROW: Record<string, unknown> = {
  id:              PAT_ID,
  organization_id: ORG_ID,
  patient_person_id: PERSON_ID,
  owner_user_id:   USER_ID,
  assigned_doctor_user_id: USER_ID,
  name:            'Kim',
  patient_no:      'P001',
  birth_date:      '1980-01-01',
  injury_date:     '2024-01-01',
  evaluation_date: '2024-06-01',
  active_modules:  ['knee'],
  diagnoses_codes: ['M54.5'],
  jobs_names:      ['사무직'],
  revision:        1,
  created_at:      NOW,
  updated_at:      NOW,
  payload:         { id: PAT_ID, phase: 'evaluation', createdAt: NOW.toISOString(), data: VALID_DATA },
};

// ---------------------------------------------------------------------------
// GET /api/patients
// ---------------------------------------------------------------------------
describe('GET /api/patients', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when not authenticated', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await request(makeApp(pool)).get('/api/patients');
    expect(res.status).toBe(401);
  });

  it('returns 403 for superadmin (null org)', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .get('/api/patients')
      .set('Authorization', `Bearer ${superToken()}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 with items and total', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    mock.mockResolvedValueOnce({ rows: [PAT_ROW] });        // items (Promise.all first)
    mock.mockResolvedValueOnce({ rows: [{ total: '1' }] }); // count (Promise.all second)
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // unassignedCount (Promise.all third)

    const res = await request(makeApp(pool))
      .get('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(PAT_ID);
    expect(res.body.items[0].sync.serverId).toBe(PAT_ID);
    expect(res.body.items[0].sync.syncStatus).toBe('synced');
  });

  it('returns 200 with empty result', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    mock.mockResolvedValueOnce({ rows: [] });
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // count
    mock.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // unassignedCount
    const res = await request(makeApp(pool))
      .get('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.total).toBe(0);
    expect(res.body.unassignedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/patients/:id
// ---------------------------------------------------------------------------
describe('GET /api/patients/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 404 when patient not found', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [] });
    const res = await request(makeApp(pool))
      .get(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
  });

  it('returns 200 with full patient response', async () => {
    const pool = makePool();
    wireQueries(pool, { rows: [PAT_ROW] });
    const res = await request(makeApp(pool))
      .get(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PAT_ID);
    expect(res.body.sync.revision).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/patients
// ---------------------------------------------------------------------------
describe('POST /api/patients', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 400 when Idempotency-Key is missing', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(CREATE_BODY);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('returns 400 when body is invalid', async () => {
    // Body validation happens before any DB call (idempotency slot not reserved)
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send({ phase: 'evaluation' }); // missing data
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 400 when patient name is missing', async () => {
    // Name check happens before any DB call (idempotency slot not reserved)
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // auth
    const noName = { ...CREATE_BODY, data: { ...VALID_DATA, shared: { ...SHARED, name: '' } } };
    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send(noName);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NAME_REQUIRED');
  });

  it('returns 201 on first call and commits idempotency slot', async () => {
    const pool = makePool();
    const cq = makeClientSetup(pool,
      { rows: [] },                           // BEGIN
      { rows: [] },                           // DELETE expired
      { rows: [], rowCount: 1 },              // INSERT slot (won)
      { rows: [] },                           // SELECT patient_persons by patient_no
      { rows: [{ id: PERSON_ID }] },          // INSERT patient_persons
      { rows: [] },                           // INSERT patient_records
      { rows: [PAT_ROW] },                    // SELECT after INSERT
      { rows: [] },                           // UPDATE slot to status=201
      { rows: [] },                           // COMMIT
    );

    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(PAT_ID);
    expect(res.body.sync.revision).toBe(1);

    // Verify slot was finalized via UPDATE (not a fresh INSERT)
    const updateCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE idempotency_keys')
    );
    expect(updateCall).toBeDefined();
    expect((updateCall![1] as unknown[])[0]).toBe(IDEMP_KEY);
    expect((updateCall![1] as unknown[])[1]).toBe(USER_ID);
    expect((updateCall![1] as unknown[])[2]).toBe(201);
  });

  it('allows same patient number for another injury/evaluation record', async () => {
    const pool = makePool();
    const cq = makeClientSetup(pool,
      { rows: [] },                           // BEGIN
      { rows: [] },                           // DELETE expired
      { rows: [], rowCount: 1 },              // INSERT slot (won)
      { rows: [{ id: PERSON_ID, birth_date: '1980-01-01' }] }, // existing person
      { rows: [] },                           // UPDATE existing person
      { rows: [] },                           // INSERT patient_records
      { rows: [PAT_ROW] },                    // SELECT after INSERT
      { rows: [] },                           // UPDATE slot to status=201
      { rows: [] },                           // COMMIT
    );

    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(PAT_ID);
    const insertRecordCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO patient_records')
    );
    expect(insertRecordCall).toBeDefined();
    expect((insertRecordCall![1] as unknown[])[2]).toBe(PERSON_ID);
  });

  it('returns a warning when patient number and birth date match but name differs', async () => {
    const pool = makePool();
    makeClientSetup(pool,
      { rows: [] },                           // BEGIN
      { rows: [] },                           // DELETE expired
      { rows: [], rowCount: 1 },              // INSERT slot (won)
      { rows: [{ id: PERSON_ID, name: 'Old Name', birth_date: '1980-01-01' }] }, // existing person
      { rows: [] },                           // UPDATE existing person
      { rows: [] },                           // INSERT patient_records
      { rows: [PAT_ROW] },                    // SELECT after INSERT
      { rows: [] },                           // UPDATE slot to status=201
      { rows: [] },                           // COMMIT
    );

    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.sync.warnings).toEqual([
      expect.objectContaining({
        code: 'PATIENT_NAME_MISMATCH',
        existingName: 'Old Name',
        incomingName: 'Kim',
      }),
    ]);
  });

  it('returns 409 when patient number matches a different birth date', async () => {
    const pool = makePool();
    const cq = makeClientSetup(pool,
      { rows: [] },                           // BEGIN
      { rows: [] },                           // DELETE expired
      { rows: [], rowCount: 1 },              // INSERT slot (won)
      { rows: [{ id: PERSON_ID, birth_date: '1970-01-01' }] }, // identity conflict
    );
    cq.mockResolvedValueOnce({ rows: [] });   // ROLLBACK (in catch)

    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send(CREATE_BODY);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PATIENT_IDENTITY_CONFLICT');

    // Verify ROLLBACK was called — this atomically releases the slot
    const rollbackCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).trim() === 'ROLLBACK'
    );
    expect(rollbackCall).toBeDefined();
  });

  it('returns cached response on replay (slot status > 0)', async () => {
    const cachedBody = { id: PAT_ID, sync: { serverId: PAT_ID, revision: 1, syncStatus: 'synced', lastSyncedAt: NOW.toISOString() } };
    const pool = makePool();
    const cq = makeClientSetup(pool,
      { rows: [] },                                                  // BEGIN
      { rows: [] },                                                  // DELETE expired
      { rows: [], rowCount: 0 },                                     // INSERT slot (lost — DO NOTHING)
      { rows: [{ status: 201, body: cachedBody }] },                 // SELECT existing (completed)
      { rows: [] },                                                  // ROLLBACK
    );

    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(PAT_ID);
    // pool.query: 1 (auth); client.query: 5 (BEGIN + DELETE + INSERT + SELECT + ROLLBACK)
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(cq.mock.calls.length).toBe(5);
  });

  it('returns 409 IDEMPOTENCY_IN_PROGRESS when concurrent request holds the slot', async () => {
    const pool = makePool();
    makeClientSetup(pool,
      { rows: [] },                                                  // BEGIN
      { rows: [] },                                                  // DELETE expired
      { rows: [], rowCount: 0 },                                     // INSERT slot (lost)
      { rows: [{ status: 0, body: null }] },                         // SELECT existing (pending)
      { rows: [] },                                                  // ROLLBACK
    );

    const res = await request(makeApp(pool))
      .post('/api/patients')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('idempotency-key', IDEMP_KEY)
      .send(CREATE_BODY);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/patients/:id
// ---------------------------------------------------------------------------
describe('PATCH /api/patients/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 400 when If-Match header is missing', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ phase: 'evaluation' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IF_MATCH_REQUIRED');
  });

  it('returns 400 when If-Match is not a positive integer', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', 'abc')
      .send({ phase: 'evaluation' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_IF_MATCH');
  });

  it('returns 404 when patient not found', async () => {
    const pool = makePool();
    makeClientSetup(pool,
      { rows: [] }, // BEGIN
      { rows: [] }, // SELECT returns nothing
      { rows: [] }, // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1')
      .send({ data: VALID_DATA });
    expect(res.status).toBe(404);
  });

  it('returns 409 when If-Match revision does not match current', async () => {
    const staleRow = { ...PAT_ROW, revision: 2 }; // server is at rev 2
    const pool = makePool();
    makeClientSetup(pool,
      { rows: [] },          // BEGIN
      { rows: [staleRow] },  // SELECT returns rev 2
      { rows: [] },          // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1') // client thinks rev 1
      .send({ data: VALID_DATA });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(res.body.currentRevision).toBe(2);
  });

  it('returns 409 on concurrent modification (UPDATE returns 0 rows)', async () => {
    const pool = makePool();
    makeClientSetup(pool,
      { rows: [] }, // BEGIN
      { rows: [PAT_ROW] }, // SELECT (rev 1 matches)
      { rows: [{ id: PERSON_ID, birth_date: '1980-01-01' }] }, // person lookup
      { rows: [] }, // person update
      { rows: [] }, // UPDATE RETURNING (race -> 0 rows)
      { rows: [] }, // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1')
      .send({ data: VALID_DATA });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('returns 200 with updated patient on success', async () => {
    const updatedRow = { ...PAT_ROW, revision: 2, updated_at: LATER };
    const pool = makePool();
    makeClientSetup(pool,
      { rows: [] }, // BEGIN
      { rows: [PAT_ROW] }, // SELECT (rev 1)
      { rows: [{ id: PERSON_ID, birth_date: '1980-01-01' }] }, // person lookup
      { rows: [] }, // person update
      { rows: [updatedRow] }, // UPDATE RETURNING
      { rows: [] }, // COMMIT
    );

    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1')
      .send({ data: VALID_DATA });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PAT_ID);
    expect(res.body.sync.revision).toBe(2);
    expect(res.body.sync.lastSyncedAt).toBe(LATER.toISOString());
  });

  it('returns a warning on patch when patient number and birth date match but name differs', async () => {
    const updatedRow = { ...PAT_ROW, revision: 2, updated_at: LATER };
    const pool = makePool();
    makeClientSetup(pool,
      { rows: [] }, // BEGIN
      { rows: [PAT_ROW] }, // SELECT (rev 1)
      { rows: [{ id: PERSON_ID, name: 'Old Name', birth_date: '1980-01-01' }] }, // person lookup
      { rows: [] }, // person update
      { rows: [updatedRow] }, // UPDATE RETURNING
      { rows: [] }, // COMMIT
    );

    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1')
      .send({ data: VALID_DATA });

    expect(res.status).toBe(200);
    expect(res.body.sync.warnings).toEqual([
      expect.objectContaining({
        code: 'PATIENT_NAME_MISMATCH',
        existingName: 'Old Name',
        incomingName: 'Kim',
      }),
    ]);
  });

  it('returns 409 when patch would link to a patient number with different birth date', async () => {
    const pool = makePool();
    makeClientSetup(pool,
      { rows: [] }, // BEGIN
      { rows: [PAT_ROW] }, // SELECT (rev 1)
      { rows: [{ id: PERSON_ID, birth_date: '1970-01-01' }] }, // identity conflict
      { rows: [] }, // ROLLBACK
    );

    const res = await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1')
      .send({ data: VALID_DATA });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PATIENT_IDENTITY_CONFLICT');
  });

  it('preserves existing payload when only phase is updated', async () => {
    const pool = makePool();
    const cq = makeClientSetup(pool,
      { rows: [] }, // BEGIN
      { rows: [PAT_ROW] },
      { rows: [{ id: PERSON_ID, birth_date: '1980-01-01' }] },
      { rows: [] },
      { rows: [{ ...PAT_ROW, revision: 2, updated_at: LATER }] },
      { rows: [] }, // COMMIT
    );

    await request(makeApp(pool))
      .patch(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('if-match', '1')
      .send({ phase: 'intake' });

    // Check the UPDATE query payload includes updated phase
    const updateCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('UPDATE patient_records')
    );
    expect(updateCall).toBeDefined();
    const payload = JSON.parse((updateCall![1] as unknown[])[11] as string) as Record<string, unknown>;
    expect(payload['phase']).toBe('intake');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/patients/:id
// ---------------------------------------------------------------------------
describe('DELETE /api/patients/:id', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 400 when revision query param is missing', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ exists: 1 }] });
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REVISION_REQUIRED');
  });

  // DELETE uses pool.connect() + client.query() for atomicity (soft-delete + snapshot redact).
  // Happy-path client queries: BEGIN → UPDATE patient → UPDATE workspaces → COMMIT
  // Error-path: BEGIN → UPDATE patient (rowCount=0) → SELECT → ROLLBACK

  it('returns 404 when patient does not exist', async () => {
    const pool = makePool();
    makeClientSetup(pool,
      { rows: [] },                           // BEGIN
      { rows: [], rowCount: 0 },              // UPDATE patient (no match)
      { rows: [] },                           // SELECT to distinguish 404 vs 409
      { rows: [] },                           // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}?revision=1`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
  });

  it('returns 409 when revision does not match', async () => {
    const pool = makePool();
    makeClientSetup(pool,
      { rows: [] },                                                    // BEGIN
      { rows: [], rowCount: 0 },                                       // UPDATE patient (no match)
      { rows: [{ revision: 3, deleted_at: null }] },                   // SELECT → rev 3
      { rows: [] },                                                    // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}?revision=1`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(res.body.currentRevision).toBe(3);
  });

  it('returns 204 and redacts snapshot on successful soft-delete', async () => {
    const pool = makePool();
    const cq = makeClientSetup(pool,
      { rows: [] },                           // BEGIN
      { rows: [], rowCount: 1 },              // UPDATE patient (soft-delete succeeds)
      { rows: [] },                           // UPDATE workspaces (snapshot redaction)
      { rows: [] },                           // COMMIT
    );

    const res = await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}?revision=1`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    // Verify the snapshot redaction UPDATE was issued.
    // The WHERE uses an EXISTS + jsonb_array_elements scan (not patient_ids @>)
    // so legacy/migration-incomplete workspaces are covered too.
    const redactCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE workspaces')
    );
    expect(redactCall).toBeDefined();
    const redactSql = redactCall![0] as string;
    expect(redactSql).toContain('EXISTS');
    expect(redactSql).not.toContain('patient_ids @>');
    expect((redactCall![1] as unknown[])[1]).toBe(PAT_ID); // $2 = patient id
  });

  it('issues soft-delete UPDATE with correct id, org, and revision', async () => {
    const pool = makePool();
    const cq = makeClientSetup(pool,
      { rows: [] },                           // BEGIN
      { rows: [], rowCount: 1 },              // UPDATE patient
      { rows: [] },                           // UPDATE workspaces
      { rows: [] },                           // COMMIT
    );

    await request(makeApp(pool))
      .delete(`/api/patients/${PAT_ID}?revision=2`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN);

    const updateCall = (cq.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('SET deleted_at')
    );
    expect(updateCall).toBeDefined();
    expect((updateCall![1] as unknown[])[0]).toBe(PAT_ID); // $1 = id
    expect((updateCall![1] as unknown[])[1]).toBe(ORG_ID); // $2 = org
    expect((updateCall![1] as unknown[])[2]).toBe(2);      // $3 = revision
  });
});

// ---------------------------------------------------------------------------
// POST /api/patients/:id/assignment
// ---------------------------------------------------------------------------
describe('POST /api/patients/:id/assignment', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 403 for non-admin users', async () => {
    const pool = makePool();
    wireQueries(pool); // auth only
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${orgToken()}`) // role: doctor
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: DOCTOR_ID });
    expect(res.status).toBe(403);
  });

  it('returns 400 when body is invalid', async () => {
    const pool = makePool();
    wireQueries(pool);
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('returns 404 when target user is not found in org', async () => {
    const pool = makePool();
    wireQueries(pool,
      { rows: [] }, // user lookup empty
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: DOCTOR_ID });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('returns 422 when target user exists but is not a doctor', async () => {
    const pool = makePool();
    wireQueries(pool,
      { rows: [{ id: DOCTOR_ID, role: 'nurse', name: 'Nurse Park' }] }, // user exists, wrong role
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: DOCTOR_ID });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TARGET_NOT_A_DOCTOR');
  });

  it('returns 404 when patient not found', async () => {
    const pool = makePool();
    wireQueries(pool,
      { rows: [{ id: DOCTOR_ID, role: 'doctor', name: 'Dr. Lee' }] }, // user ok
      { rows: [] },                                   // patient not found (old value read)
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: DOCTOR_ID });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
  });

  it('returns 200 and records previous/new doctor names in audit log', async () => {
    const pool = makePool();
    wireQueries(pool,
      { rows: [{ id: DOCTOR_ID, role: 'doctor', name: 'Dr. Lee' }] },
      { rows: [{ assigned_doctor_user_id: USER_ID, previous_doctor_name: 'Dr. Kim' }] },
      { rows: [{ id: PAT_ID, revision: 2 }] },
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: DOCTOR_ID });
    expect(res.status).toBe(200);
    expect(res.body.patientId).toBe(PAT_ID);
    expect(res.body.assignedUserId).toBe(DOCTOR_ID);
    expect(res.body.revision).toBe(2);
    expect(writeAuditLog).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        action: 'patient_assignment_change',
        extra:  {
          previousDoctorUserId: USER_ID,
          previousDoctorName:   'Dr. Kim',
          assignedUserId:       DOCTOR_ID,
          newDoctorName:        'Dr. Lee',
        },
      })
    );
  });

  it('accepts null assignedUserId to unassign a patient', async () => {
    const pool = makePool();
    wireQueries(pool,
      // no user lookup (assignedUserId is null, so user verification is skipped)
      { rows: [{ assigned_doctor_user_id: DOCTOR_ID, previous_doctor_name: 'Dr. Kim' }] }, // old row
      { rows: [{ id: PAT_ID, revision: 3 }] },                                             // update result
    );
    const res = await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: null });
    expect(res.status).toBe(200);
    expect(res.body.assignedUserId).toBeNull();
    expect(res.body.revision).toBe(3);
    expect(writeAuditLog).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        action: 'patient_assignment_change',
        extra:  expect.objectContaining({
          assignedUserId: null,
          newDoctorName:  null,
        }),
      })
    );
  });

  it('uses assigned_doctor_user_id (not owner_user_id) for the update', async () => {
    const pool = makePool();
    const mock = pool.query as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    mock.mockResolvedValueOnce({ rows: [{ id: DOCTOR_ID, role: 'doctor', name: 'Dr. Lee' }] });
    mock.mockResolvedValueOnce({ rows: [{ assigned_doctor_user_id: null, previous_doctor_name: null }] });
    mock.mockResolvedValueOnce({ rows: [{ id: PAT_ID, revision: 2 }] });

    await request(makeApp(pool))
      .post(`/api/patients/${PAT_ID}/assignment`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ assignedUserId: DOCTOR_ID });

    const updateCall = (mock.mock.calls as unknown[][]).find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE patient_records')
    );
    expect(updateCall).toBeDefined();
    expect((updateCall![0] as string)).toMatch(/assigned_doctor_user_id/);
    expect((updateCall![0] as string)).not.toMatch(/SET owner_user_id/);
    expect((updateCall![0] as string)).toMatch(/jsonb_set/);
  });
});
