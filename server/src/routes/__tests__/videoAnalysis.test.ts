import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// 피처플래그를 테스트 중 토글하기 위해 hoisted 가변 상태 사용.
const flagState = vi.hoisted(() => ({ enabled: true, fixtureMode: false }));

vi.mock('../../config', () => ({
  default: {
    env: 'test',
    cors: { origins: [] },
    auth: {
      accessTokenTtl: 900,
      accessTokenSecret: 'test-access-secret',
      refreshTokenSecret: 'test-refresh-secret',
    },
    get videoAnalysisEnabled() { return flagState.enabled; },
    video: {
      get fixtureMode() { return flagState.fixtureMode; },
      fixtureDir: '/tmp/va-fixtures',
      scriptsDir: '/tmp/scripts',
      python: '/tmp/python',
    },
  },
}));

// fixture 경로 검증을 결정적으로: 'good.mp4'만 통과, 나머지(traversal 등)는 null.
vi.mock('../../workers/fixturePath', () => ({
  resolveFixtureClip: vi.fn((name: unknown) =>
    name === 'good.mp4' ? '/tmp/va-fixtures/good.mp4' : null),
}));

vi.mock('../../middleware/audit', () => ({
  writeAuditLog: vi.fn(),
  auditMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { createVideoAnalysisRouter } from '../videoAnalysis';
import { generateAccessToken } from '../../auth/tokens';
import { writeAuditLog } from '../../middleware/audit';
import type { Pool } from 'pg';

const CSRF_TOKEN = 'ok';
const CSRF_HASH = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');
const ORG_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_DOCTOR = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const PAT_ID = '11111111-1111-1111-1111-111111111111';
const CLIP_ID = '22222222-2222-2222-2222-222222222222';
const JOB_ID = '33333333-3333-3333-3333-333333333333';

function orgToken(role = 'doctor'): string {
  return generateAccessToken({
    sub: USER_ID, sessionId: 'sess-1', orgId: ORG_ID,
    role, name: 'Dr. Kim', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function makePool(): Pool {
  return { connect: vi.fn(), query: vi.fn() } as unknown as Pool;
}
function makeApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/video-analysis', createVideoAnalysisRouter(pool));
  return app;
}
const q = (pool: Pool) => pool.query as ReturnType<typeof vi.fn>;
const authOk = (pool: Pool) => q(pool).mockResolvedValueOnce({ rows: [{ exists: 1 }] });

const NOW = new Date('2024-06-01T10:00:00Z');

describe('video-analysis feature flag (fail-closed)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  it('returns 404 for every route when flag is off', async () => {
    flagState.enabled = false;
    const pool = makePool();
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/clips')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ patientId: PAT_ID });
    expect(res.status).toBe(404);
    // 플래그 가드는 auth 이전에 차단하므로 DB 조회도 없다.
    expect(q(pool)).not.toHaveBeenCalled();
  });
});

describe('POST /clips (body patientId access)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  it('creates a clip for the assigned doctor', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] }); // patient access
    q(pool).mockResolvedValueOnce({ rows: [{ id: CLIP_ID }] }); // insert clip
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/clips')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ patientId: PAT_ID });
    expect(res.status).toBe(201);
    expect(res.body.clipId).toBe(CLIP_ID);
  });

  it('returns 404 when the patient is not in the caller org / not found', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [] }); // patient not found
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/clips')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ patientId: PAT_ID });
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller is not the assigned doctor', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [{ id: PAT_ID, assigned_doctor_user_id: OTHER_DOCTOR }] });
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/clips')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ patientId: PAT_ID });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body', async () => {
    const pool = makePool();
    authOk(pool);
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/clips')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ patientId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });
});

describe('POST /jobs (denormalize org/patient from clip)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  it('creates a review_pending job, filling patient/org from the clip (ignores spoofed body)', async () => {
    const pool = makePool();
    authOk(pool);
    // clip access lookup → returns the authoritative patient/org
    q(pool).mockResolvedValueOnce({ rows: [{ id: CLIP_ID, patient_record_id: PAT_ID, organization_id: ORG_ID, assigned_doctor_user_id: USER_ID }] });
    // insert job
    q(pool).mockResolvedValueOnce({ rows: [{
      id: JOB_ID, clip_id: CLIP_ID, process_id: 'p1', status: 'review_pending',
      analysis_profile: 'posture-basic', requested_features: ['overheadHours'],
      applied_at: null, applied_revision: null,
    }] });
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/jobs')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ clipId: CLIP_ID, processId: 'p1', analysisProfile: 'posture-basic', requestedFeatures: ['overheadHours'] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('review_pending');
    expect(res.body.jobId).toBe(JOB_ID);
    // insert는 clip 조회로 얻은 patient/org를 사용한다(클라 body가 아님).
    const insertCall = q(pool).mock.calls.find((c) => String(c[0]).includes('INSERT INTO video_analysis_jobs'));
    expect(insertCall).toBeDefined();
    expect(insertCall?.[1]).toContain(ORG_ID);
    expect(insertCall?.[1]).toContain(PAT_ID);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'video_analysis_submit' }));
  });

  it('accepts processId:null (job-scope aggregate) — regression for nullable schema', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [{ id: CLIP_ID, patient_record_id: PAT_ID, organization_id: ORG_ID, assigned_doctor_user_id: USER_ID }] });
    q(pool).mockResolvedValueOnce({ rows: [{ id: JOB_ID, clip_id: CLIP_ID, process_id: null, status: 'review_pending', analysis_profile: 'posture-basic', requested_features: ['overheadHours'], applied_at: null, applied_revision: null }] });
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/jobs')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ clipId: CLIP_ID, processId: null, analysisProfile: 'posture-basic', requestedFeatures: ['overheadHours'] });
    expect(res.status).toBe(201);
    expect(res.body.jobId).toBe(JOB_ID);
  });
});

describe('POST /jobs fixture mode (dev-only worker job)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; flagState.fixtureMode = true; });
  afterEach(() => { flagState.fixtureMode = false; });

  const clipLookup = (pool: Pool) =>
    q(pool).mockResolvedValueOnce({ rows: [{ id: CLIP_ID, patient_record_id: PAT_ID, organization_id: ORG_ID, assigned_doctor_user_id: USER_ID }] });

  it('fixtureMode + valid fixtureClipName → queued job + records upload_path', async () => {
    const pool = makePool();
    authOk(pool);
    clipLookup(pool);
    q(pool).mockResolvedValueOnce({ rows: [] }); // UPDATE clips SET upload_path
    q(pool).mockResolvedValueOnce({ rows: [{ id: JOB_ID, clip_id: CLIP_ID, process_id: 'p1', status: 'queued', analysis_profile: 'posture-basic', requested_features: ['overheadHours'], applied_at: null, applied_revision: null }] });
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/jobs')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ clipId: CLIP_ID, processId: 'p1', analysisProfile: 'posture-basic', requestedFeatures: ['overheadHours'], fixtureClipName: 'good.mp4' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('queued');
    const updateClip = q(pool).mock.calls.find((c) => String(c[0]).includes('UPDATE video_analysis_clips SET upload_path'));
    expect(updateClip?.[1]).toContain('/tmp/va-fixtures/good.mp4');
    const insertCall = q(pool).mock.calls.find((c) => String(c[0]).includes('INSERT INTO video_analysis_jobs'));
    expect(insertCall?.[1]).toContain('queued');
  });

  it('fixtureMode + invalid fixtureClipName (traversal) → 400 INVALID_FIXTURE (no insert)', async () => {
    const pool = makePool();
    authOk(pool);
    clipLookup(pool);
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/jobs')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ clipId: CLIP_ID, fixtureClipName: '../../etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FIXTURE');
    expect(q(pool).mock.calls.find((c) => String(c[0]).includes('INSERT INTO video_analysis_jobs'))).toBeUndefined();
  });

  it('fixtureMode OFF + fixtureClipName → ignored, falls back to mock review_pending shell', async () => {
    flagState.fixtureMode = false;
    const pool = makePool();
    authOk(pool);
    clipLookup(pool);
    q(pool).mockResolvedValueOnce({ rows: [{ id: JOB_ID, clip_id: CLIP_ID, process_id: null, status: 'review_pending', analysis_profile: null, requested_features: [], applied_at: null, applied_revision: null }] });
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/jobs')
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ clipId: CLIP_ID, fixtureClipName: 'good.mp4' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('review_pending');
    // upload_path UPDATE는 일어나지 않는다(fixture 경로 미사용).
    expect(q(pool).mock.calls.find((c) => String(c[0]).includes('UPDATE video_analysis_clips SET upload_path'))).toBeUndefined();
  });
});

describe('POST /jobs/:jobId/apply', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  const jobRow = (over = {}) => ({
    id: JOB_ID, organization_id: ORG_ID, patient_record_id: PAT_ID, clip_id: CLIP_ID,
    process_id: 'p1', status: 'review_pending', analysis_profile: 'posture-basic',
    requested_features: [], result_features: null,
    applied_at: null, applied_revision: null, applied_inputs_hash: null,
    created_at: NOW, updated_at: NOW, assigned_doctor_user_id: USER_ID, ...over,
  });
  const patRow = (revision: number) => ({
    id: PAT_ID, revision, payload: { phase: 'evaluation', data: { shared: { name: 'Kim' }, modules: {}, activeModules: [] } },
    created_at: NOW, updated_at: NOW,
  });
  const body = { data: { shared: { name: 'Kim' }, modules: {}, activeModules: [] }, appliedInputsHash: 'h1', appliedInputsCount: 1 };

  function clientSetup(pool: Pool, ...clientResults: { rows: unknown[] }[]) {
    const clientMock = { query: vi.fn(), release: vi.fn() };
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(clientMock);
    authOk(pool); // auth middleware (pool.query)
    const cq = clientMock.query as ReturnType<typeof vi.fn>;
    for (const r of clientResults) cq.mockResolvedValueOnce(r);
    return cq;
  }

  it('400 when If-Match header is missing', async () => {
    const pool = makePool();
    authOk(pool);
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/jobs/${JOB_ID}/apply`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send(body);
    expect(res.status).toBe(400);
  });

  it('409 on revision mismatch (stale If-Match)', async () => {
    const pool = makePool();
    clientSetup(pool,
      { rows: [] },                 // BEGIN
      { rows: [jobRow()] },         // job FOR UPDATE
      { rows: [patRow(5)] },        // patient FOR UPDATE (revision 5 != If-Match 1)
      { rows: [] },                 // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/jobs/${JOB_ID}/apply`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('If-Match', '1')
      .send(body);
    expect(res.status).toBe(409);
    expect(res.body.currentRevision).toBe(5);
  });

  it('200 on success: persists payload, bumps revision, marks job done, audits', async () => {
    const pool = makePool();
    clientSetup(pool,
      { rows: [] },                         // BEGIN
      { rows: [jobRow()] },                 // job FOR UPDATE
      { rows: [patRow(1)] },                // patient FOR UPDATE
      { rows: [patRow(2)] },                // UPDATE patient RETURNING (revision 2)
      { rows: [] },                         // UPDATE job
      { rows: [] },                         // COMMIT
    );
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/jobs/${JOB_ID}/apply`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('If-Match', '1')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.patient.sync.revision).toBe(2);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'video_analysis_apply', targetType: 'patient', targetId: PAT_ID,
    }));
  });

  it('idempotent: already applied with same hash returns stored patient (no re-apply)', async () => {
    const pool = makePool();
    clientSetup(pool,
      { rows: [] },                                                   // BEGIN
      { rows: [jobRow({ status: 'done', applied_at: NOW, applied_inputs_hash: 'h1' })] }, // job FOR UPDATE
      { rows: [patRow(2)] },                                          // current patient
      { rows: [] },                                                   // COMMIT
    );
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/jobs/${JOB_ID}/apply`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('If-Match', '1')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
  });

  it('consumes sourceAnalysisJobIds: marks source analysis jobs done + records in audit', async () => {
    const SRC_JOB = '44444444-4444-4444-4444-444444444444';
    const pool = makePool();
    const cq = clientSetup(pool,
      { rows: [] },                 // BEGIN
      { rows: [jobRow()] },         // job FOR UPDATE
      { rows: [{ id: SRC_JOB }] },  // source job existence/ownership validation
      { rows: [patRow(1)] },        // patient FOR UPDATE
      { rows: [patRow(2)] },        // UPDATE patient RETURNING
      { rows: [] },                 // UPDATE shell job done
      { rows: [] },                 // UPDATE source analysis jobs done
      { rows: [] },                 // COMMIT
    );
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/jobs/${JOB_ID}/apply`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('If-Match', '1')
      .send({ ...body, sourceAnalysisJobIds: [SRC_JOB] });
    expect(res.status).toBe(200);
    // 검증 SELECT는 결과보유·per-process·셸 job 제외 가드를 포함한다.
    const validateCall = cq.mock.calls.find((c) =>
      String(c[0]).includes('result_features IS NOT NULL') && String(c[0]).includes('id <> $4'));
    expect(validateCall).toBeDefined();
    expect(validateCall?.[1]?.[3]).toBe(JOB_ID); // 현재 적용 셸 job 자신 제외
    const consumeCall = cq.mock.calls.find((c) =>
      String(c[0]).includes('WHERE id = ANY($1)') && String(c[0]).includes("status = 'review_pending'"));
    expect(consumeCall).toBeDefined();
    expect(consumeCall?.[1]?.[0]).toEqual([SRC_JOB]);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      extra: expect.objectContaining({ sourceAnalysisJobIds: [SRC_JOB] }),
    }));
  });

  it('400 INVALID_SOURCE_JOB when a sourceAnalysisJobId does not belong to this patient', async () => {
    const pool = makePool();
    clientSetup(pool,
      { rows: [] },              // BEGIN
      { rows: [jobRow()] },      // job FOR UPDATE
      { rows: [] },              // source validation: 0 found (forged/stale id)
      { rows: [] },              // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/jobs/${JOB_ID}/apply`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('If-Match', '1')
      .send({ ...body, sourceAnalysisJobIds: ['44444444-4444-4444-4444-444444444444'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SOURCE_JOB');
  });

  it('400 INVALID_SOURCE_JOB when the apply shell job id is sent as source (id<>$4 guard)', async () => {
    const pool = makePool();
    clientSetup(pool,
      { rows: [] },              // BEGIN
      { rows: [jobRow()] },      // job FOR UPDATE
      { rows: [] },              // source validation excludes shell job (id <> $4, no process_id/result) → 0 found
      { rows: [] },              // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/jobs/${JOB_ID}/apply`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('If-Match', '1')
      .send({ ...body, sourceAnalysisJobIds: [JOB_ID] }); // 셸 job 자신을 source로 → 거부
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SOURCE_JOB');
  });

  it('409 when job is not review_pending (e.g. expired)', async () => {
    const pool = makePool();
    clientSetup(pool,
      { rows: [] },                                       // BEGIN
      { rows: [jobRow({ status: 'expired' })] },          // job FOR UPDATE
      { rows: [] },                                       // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/jobs/${JOB_ID}/apply`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('If-Match', '1')
      .send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_NOT_APPLIABLE');
  });

  it('403 when caller is not the assigned doctor', async () => {
    const pool = makePool();
    clientSetup(pool,
      { rows: [] },                                                  // BEGIN
      { rows: [jobRow({ assigned_doctor_user_id: OTHER_DOCTOR })] }, // job FOR UPDATE
      { rows: [] },                                                  // ROLLBACK
    );
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/jobs/${JOB_ID}/apply`)
      .set('Authorization', `Bearer ${orgToken()}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .set('If-Match', '1')
      .send(body);
    expect(res.status).toBe(403);
  });
});
