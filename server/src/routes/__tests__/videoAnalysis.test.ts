import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// 피처플래그를 테스트 중 토글하기 위해 hoisted 가변 상태 사용.
const flagState = vi.hoisted(() => ({ enabled: true, fixtureMode: false }));
// 업로드 테스트용 실제 temp uploadDir(buildUploadMiddleware가 tmp 하위를 mkdir). 경로는 beforeAll에서 채운다.
const uploadEnv = vi.hoisted(() => ({ dir: '' }));
beforeAll(() => { uploadEnv.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-upload-')); });

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
      get uploadDir() { return uploadEnv.dir; },
      maxUploadBytes: 50 * 1024 * 1024,
      allowedExtensions: ['mp4', 'mov', 'webm', 'avi'],
      allowedMimeTypes: ['video/mp4', 'video/webm', 'video/x-msvideo'],
      clipTtlHours: 24,
      retentionPolicy: 'privacy_first',
    },
  },
}));

// fixture 경로 검증을 결정적으로: 'good.mp4'만 통과, 나머지(traversal 등)는 null.
vi.mock('../../workers/fixturePath', () => ({
  resolveFixtureClip: vi.fn((name: unknown) =>
    name === 'good.mp4' ? '/tmp/va-fixtures/good.mp4' : null),
  // 업로드 경로는 truthy 문자열이면 통과(실 검증은 fixturePath 단위테스트가 담당).
  resolveUploadedClipPath: vi.fn((p: unknown) => (typeof p === 'string' && p ? p : null)),
}));

// sample-detect Python 러너 mock(계약 형태 결과 반환).
vi.mock('../../workers/sampleDetect', () => ({
  runSampleDetect: vi.fn(async () => ({
    schemaVersion: 1, frameIndex: 100, timestampMs: 8000, frameWidth: 640, frameHeight: 480,
    persons: [{ id: 'p1', bbox: [10, 20, 100, 200], score: 1 }, { id: 'p2', bbox: [300, 50, 80, 180], score: 1 }],
  })),
}));

vi.mock('../../middleware/audit', () => ({
  writeAuditLog: vi.fn(),
  auditMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { createVideoAnalysisRouter } from '../videoAnalysis';
import { generateAccessToken } from '../../auth/tokens';
import { writeAuditLog } from '../../middleware/audit';
import { runSampleDetect } from '../../workers/sampleDetect';
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
      .send({ patientId: PAT_ID, purpose: 'apply_shell' });
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
      .send({ patientId: PAT_ID, purpose: 'apply_shell' });
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
      .send({ patientId: PAT_ID, purpose: 'apply_shell' });
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
      .send({ patientId: PAT_ID, purpose: 'apply_shell' });
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
    // clip access lookup → returns the authoritative patient/org. apply_shell → review_pending.
    q(pool).mockResolvedValueOnce({ rows: [{ id: CLIP_ID, patient_record_id: PAT_ID, organization_id: ORG_ID, assigned_doctor_user_id: USER_ID, process_id: null, upload_path: null, source_type: 'apply_shell', file_state: 'none' }] });
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
    q(pool).mockResolvedValueOnce({ rows: [{ id: CLIP_ID, patient_record_id: PAT_ID, organization_id: ORG_ID, assigned_doctor_user_id: USER_ID, process_id: null, upload_path: null, source_type: 'apply_shell', file_state: 'none' }] });
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

// loadAccessibleClip이 읽는 clip 행(추가 컬럼 포함). 기본은 추론 없는 적용 셸(apply_shell/none).
const clipRow = (over: Record<string, unknown> = {}) => ({
  id: CLIP_ID, patient_record_id: PAT_ID, organization_id: ORG_ID, assigned_doctor_user_id: USER_ID,
  process_id: null, upload_path: null, sample_detect_result: null, target_person_id: null,
  source_type: 'apply_shell', file_state: 'none', ...over,
});

describe('POST /jobs process_id 무결성 (clip이 source of truth, PR D3b)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  it('body.processId ≠ clip.process_id → 400 PROCESS_MISMATCH (p1 분석이 p2 provenance로 새는 것 차단)', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow({ process_id: 'p1' })] });
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/jobs')
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .send({ clipId: CLIP_ID, processId: 'p2', analysisProfile: 'posture-basic', requestedFeatures: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROCESS_MISMATCH');
  });

  it('clip.process_id를 source of truth로 저장(body 일치 시 통과)', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow({ process_id: 'p1' })] });
    q(pool).mockResolvedValueOnce({ rows: [{ id: JOB_ID, clip_id: CLIP_ID, process_id: 'p1', status: 'review_pending', analysis_profile: 'posture-basic', requested_features: [], applied_at: null, applied_revision: null }] });
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/jobs')
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .send({ clipId: CLIP_ID, processId: 'p1', analysisProfile: 'posture-basic', requestedFeatures: [] });
    expect(res.status).toBe(201);
    const insertCall = q(pool).mock.calls.find((c) => String(c[0]).includes('INSERT INTO video_analysis_jobs'));
    expect(insertCall?.[1]).toContain('p1'); // body가 아니라 clip의 process_id
  });
});

describe('POST /clips fixture 이관 (createClip resolves upload_path, PR D2b)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; flagState.fixtureMode = true; });
  afterEach(() => { flagState.fixtureMode = false; });

  it('fixtureMode + valid fixtureClipName → upload_path stored on insert', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] }); // patient lookup
    q(pool).mockResolvedValueOnce({ rows: [{ id: CLIP_ID }] }); // insert clip
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/clips')
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .send({ patientId: PAT_ID, processId: 'p1', purpose: 'fixture', fixtureClipName: 'good.mp4' });
    expect(res.status).toBe(201);
    const insert = q(pool).mock.calls.find((c) => String(c[0]).includes('INSERT INTO video_analysis_clips'));
    expect(insert?.[1]).toContain('/tmp/va-fixtures/good.mp4'); // upload_path
    expect(insert?.[1]).toContain('fixture'); // source_type
  });

  it('fixtureMode OFF + purpose=fixture → 409 FIXTURE_MODE_OFF', async () => {
    flagState.fixtureMode = false;
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] });
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/clips')
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .send({ patientId: PAT_ID, purpose: 'fixture', fixtureClipName: 'good.mp4' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FIXTURE_MODE_OFF');
  });

  it('fixtureMode + traversal fixtureClipName → 400 INVALID_FIXTURE (no clip insert)', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] });
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/clips')
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .send({ patientId: PAT_ID, purpose: 'fixture', fixtureClipName: '../../etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FIXTURE');
    expect(q(pool).mock.calls.find((c) => String(c[0]).includes('INSERT INTO video_analysis_clips'))).toBeUndefined();
  });
});

describe('POST /jobs 큐 결정 (clip.upload_path 일원화, PR D2b)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; flagState.fixtureMode = true; });
  afterEach(() => { flagState.fixtureMode = false; });

  const submit = (pool: Pool) => request(makeApp(pool))
    .post('/api/video-analysis/jobs')
    .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
    .send({ clipId: CLIP_ID, processId: 'p1', analysisProfile: 'posture-basic', requestedFeatures: ['overheadHours'] });

  it('fixture clip(present) + fixtureMode → queued', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow({ source_type: 'fixture', file_state: 'present', upload_path: '/tmp/va-fixtures/good.mp4' })] });
    q(pool).mockResolvedValueOnce({ rows: [{ id: JOB_ID, clip_id: CLIP_ID, process_id: 'p1', status: 'queued', analysis_profile: 'posture-basic', requested_features: [], applied_at: null, applied_revision: null }] });
    const res = await submit(pool);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('queued');
    const insert = q(pool).mock.calls.find((c) => String(c[0]).includes('INSERT INTO video_analysis_jobs'));
    expect(insert?.[1]).toContain('queued');
  });

  it('upload clip(present) → queued (fixtureMode 무관)', async () => {
    flagState.fixtureMode = false;
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow({ source_type: 'upload', file_state: 'present', upload_path: '/uploads/x.bin' })] });
    q(pool).mockResolvedValueOnce({ rows: [{ id: JOB_ID, clip_id: CLIP_ID, process_id: 'p1', status: 'queued', analysis_profile: 'posture-basic', requested_features: [], applied_at: null, applied_revision: null }] });
    const res = await submit(pool);
    expect(res.status).toBe(201);
    const insert = q(pool).mock.calls.find((c) => String(c[0]).includes('INSERT INTO video_analysis_jobs'));
    expect(insert?.[1]).toContain('queued');
  });

  it('fixture clip + fixtureMode OFF → 409 FIXTURE_MODE_OFF', async () => {
    flagState.fixtureMode = false;
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow({ source_type: 'fixture', file_state: 'present', upload_path: '/tmp/va-fixtures/good.mp4' })] });
    const res = await submit(pool);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FIXTURE_MODE_OFF');
  });

  it('upload clip + file_state none → 409 NO_UPLOAD', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow({ source_type: 'upload', file_state: 'none', upload_path: null })] });
    const res = await submit(pool);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_UPLOAD');
  });

  it('upload clip + file_state deleted → 409 SOURCE_DELETED_REUPLOAD_REQUIRED', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow({ source_type: 'upload', file_state: 'deleted', upload_path: null })] });
    const res = await submit(pool);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SOURCE_DELETED_REUPLOAD_REQUIRED');
  });
});

describe('POST /clips/:id/sample-detect (fixture 전용, PR D2b)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; flagState.fixtureMode = true; });
  afterEach(() => { flagState.fixtureMode = false; });

  it('fixtureMode + upload_path → runs sample_detect, stores result', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow({ source_type: 'fixture', file_state: 'present', upload_path: '/tmp/va-fixtures/good.mp4' })] });
    q(pool).mockResolvedValueOnce({ rows: [] }); // UPDATE sample_detect_result
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/sample-detect`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN).send({});
    expect(res.status).toBe(200);
    expect(res.body.persons.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2']);
    const upd = q(pool).mock.calls.find((c) => String(c[0]).includes('SET sample_detect_result'));
    expect(upd).toBeDefined();
  });

  it('fixtureMode OFF (or no upload_path) → 409 SAMPLE_DETECT_UNAVAILABLE', async () => {
    flagState.fixtureMode = false;
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow()] });
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/sample-detect`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SAMPLE_DETECT_UNAVAILABLE');
  });

  it('깨진 sample-detect 출력 → 502 INVALID_SAMPLE_DETECT (일반 500 아님)', async () => {
    vi.mocked(runSampleDetect).mockRejectedValueOnce(
      Object.assign(new Error('sample-detect produced an invalid result'), { code: 'INVALID_SAMPLE_DETECT' }),
    );
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow({ source_type: 'fixture', file_state: 'present', upload_path: '/tmp/va-fixtures/good.mp4' })] });
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/sample-detect`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN).send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('INVALID_SAMPLE_DETECT');
  });
});

describe('POST /clips/:id/select-target (PR D2b)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  const sdr = { schemaVersion: 1, frameIndex: 100, timestampMs: 8000, frameWidth: 640, frameHeight: 480, persons: [{ id: 'p1', bbox: [10, 20, 100, 200], score: 1 }] };

  it('valid candidate id → stores target_person_id', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow({ sample_detect_result: sdr })] });
    q(pool).mockResolvedValueOnce({ rows: [] }); // UPDATE target_person_id
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/select-target`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .send({ targetPersonId: 'p1' });
    expect(res.status).toBe(200);
    expect(res.body.targetPersonId).toBe('p1');
  });

  it('no prior sample-detect → 409 NO_SAMPLE_DETECT', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow()] });
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/select-target`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .send({ targetPersonId: 'p1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_SAMPLE_DETECT');
  });

  it('spoofed candidate id (not in result) → 400 INVALID_TARGET', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow({ sample_detect_result: sdr })] });
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/select-target`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .send({ targetPersonId: 'p999' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TARGET');
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

describe('POST /clips purpose 검증 (M3-7a)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  it('purpose 누락 → 400 MISSING_PURPOSE', async () => {
    const pool = makePool();
    authOk(pool);
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/clips')
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .send({ patientId: PAT_ID });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_PURPOSE');
  });

  it('purpose=analysis_upload + fixtureClipName → 400 (잘못된 조합)', async () => {
    const pool = makePool();
    authOk(pool);
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/clips')
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .send({ patientId: PAT_ID, purpose: 'analysis_upload', fixtureClipName: 'good.mp4' });
    expect(res.status).toBe(400);
  });

  it('purpose=fixture + fixtureClipName 없음 → 400 (잘못된 조합)', async () => {
    const pool = makePool();
    authOk(pool);
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/clips')
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .send({ patientId: PAT_ID, purpose: 'fixture' });
    expect(res.status).toBe(400);
  });

  it('purpose=analysis_upload → source_type=upload, file_state=none INSERT', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] });
    q(pool).mockResolvedValueOnce({ rows: [{ id: CLIP_ID }] });
    const res = await request(makeApp(pool))
      .post('/api/video-analysis/clips')
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .send({ patientId: PAT_ID, purpose: 'analysis_upload' });
    expect(res.status).toBe(201);
    const insert = q(pool).mock.calls.find((c) => String(c[0]).includes('INSERT INTO video_analysis_clips'));
    expect(insert?.[1]).toContain('upload');
    expect(insert?.[1]).toContain('none');
  });
});

describe('POST /clips/:id/upload (M3-7a)', () => {
  // 'ftyp'(offset 4) 시그니처를 가진 최소 mp4 버퍼.
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(20)]);
  const NOT_VIDEO = Buffer.from('this is definitely not a video!!');
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  const uploadRow = (over = {}) => clipRow({ source_type: 'upload', file_state: 'none', upload_path: null, ...over });

  it('정상 업로드 → 200 + file_state=present UPDATE + audit', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [uploadRow()] });          // loadAccessibleClip
    q(pool).mockResolvedValueOnce({ rows: [], rowCount: 1 });        // UPDATE present
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .attach('file', MP4, { filename: 'clip.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(200);
    expect(res.body.clipId).toBe(CLIP_ID);
    expect(res.body.sha256).toBeTruthy();
    const upd = q(pool).mock.calls.find((c) => String(c[0]).includes("file_state = 'present'"));
    expect(upd).toBeDefined();
    expect(writeAuditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'video_analysis_upload' }));
  });

  it('허용되지 않은 확장자 → 400 INVALID_MEDIA_TYPE (수신 후 sniff 전 차단)', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [uploadRow()] });
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .attach('file', MP4, { filename: 'clip.txt', contentType: 'video/mp4' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MEDIA_TYPE');
  });

  it('MIME 위조(비영상) → 400 INVALID_MEDIA_TYPE', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [uploadRow()] });
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .attach('file', NOT_VIDEO, { filename: 'fake.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MEDIA_TYPE');
  });

  it('업로드 대상 아님(apply_shell) → 400 CLIP_NOT_UPLOAD_TARGET', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow({ source_type: 'apply_shell', file_state: 'none' })] });
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .attach('file', MP4, { filename: 'clip.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CLIP_NOT_UPLOAD_TARGET');
  });

  it('이미 업로드됨(file_state=present) → 409 CLIP_ALREADY_UPLOADED', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [uploadRow({ file_state: 'present', upload_path: '/uploads/x.bin' })] });
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .attach('file', MP4, { filename: 'clip.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CLIP_ALREADY_UPLOADED');
  });

  it('경쟁 업로드(UPDATE 0행) → 409 CLIP_ALREADY_UPLOADED', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [uploadRow()] });
    q(pool).mockResolvedValueOnce({ rows: [], rowCount: 0 }); // 경쟁자가 먼저 성공
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .attach('file', MP4, { filename: 'clip.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CLIP_ALREADY_UPLOADED');
  });

  it('DB UPDATE 예외 → 500 + 최종 파일 orphan 미잔존', async () => {
    const countBin = () => fs.readdirSync(uploadEnv.dir).filter((f: string) => f.endsWith('.bin')).length;
    const before = countBin();
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [uploadRow()] });
    q(pool).mockRejectedValueOnce(new Error('db down')); // UPDATE 장애
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .attach('file', MP4, { filename: 'clip.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(500);
    expect(countBin()).toBe(before); // rename된 최종 파일이 finally에서 정리됨(orphan 없음).
  });

  it('잘못된 필드명(multer LIMIT_UNEXPECTED_FILE) → 400 INVALID_UPLOAD', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [uploadRow()] }); // 사전검사 통과 후 multer가 거부
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN)
      .attach('wrongfield', MP4, { filename: 'clip.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_UPLOAD');
  });
});

describe('POST /clips/:id/sample-detect 실 업로드 guard (M3-7a)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  it('upload + present → sample-detect 실행', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow({ source_type: 'upload', file_state: 'present', upload_path: `${uploadEnv.dir}/x.bin` })] });
    q(pool).mockResolvedValueOnce({ rows: [] }); // UPDATE
    // resolveUploadedClipPath는 실제 파일 검증 → 파일 생성.
    fs.writeFileSync(`${uploadEnv.dir}/x.bin`, 'x');
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/sample-detect`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN).send({});
    expect(res.status).toBe(200);
    expect(res.body.persons.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2']);
  });

  it('upload + file_state none → 409 NO_UPLOAD', async () => {
    const pool = makePool();
    authOk(pool);
    q(pool).mockResolvedValueOnce({ rows: [clipRow({ source_type: 'upload', file_state: 'none', upload_path: null })] });
    const res = await request(makeApp(pool))
      .post(`/api/video-analysis/clips/${CLIP_ID}/sample-detect`)
      .set('Authorization', `Bearer ${orgToken()}`).set('x-csrf-token', CSRF_TOKEN).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_UPLOAD');
  });
});
