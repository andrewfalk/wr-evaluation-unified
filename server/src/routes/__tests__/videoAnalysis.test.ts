// Video analysis routes on the shared test harness (src/testing/) — migrated in S7-2b with the same it titles
// and assertions. The apply's patient write is covered against real PostgreSQL in
// videoApply.integration.test.ts (S7-2).
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import request from 'supertest';

// Video analysis routes on the shared test harness (src/testing/) — migrated from videoAnalysis.test.ts
// with the same it titles and assertions. Query replies are chosen by SQL (videoFake), not by call order.
// The apply → patient_records write itself is covered against real PostgreSQL in
// videoApply.integration.test.ts (S7-2).

// 피처플래그를 테스트 중 토글하기 위해 hoisted 가변 상태 사용.
const flagState = vi.hoisted(() => ({ enabled: true, fixtureMode: false, targetThumbnail: false, overlayFrames: false, allowUnverifiedRecipe: false }));
const lockFlagState = vi.hoisted(() => ({ mode: 'off' as 'off' | 'observe' | 'enforce' }));
// 업로드 테스트용 실제 temp uploadDir(buildUploadMiddleware가 tmp 하위를 mkdir). 경로는 beforeAll에서 채운다.
const uploadEnv = vi.hoisted(() => ({ dir: '', maxBytes: 50 * 1024 * 1024 }));
beforeAll(() => { uploadEnv.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-upload-')); });

// 공통 모양(testConfig) + 고정 video 값. 테스트 중 바뀌는 값은 getter로 둔다(lockGate.test.ts와 같은 방식) —
// 라우터·워커가 매 요청(또는 앱 생성) 시점에 읽으므로 hoisted 상태 변경이 그대로 보인다.
vi.mock('../../config', async () => {
  const cfg = (await import('../../testing/configMock.js')).testConfig({
    video: {
      fixtureDir: '/tmp/va-fixtures',
      scriptsDir: '/tmp/scripts',
      python: '/tmp/python',
      allowedExtensions: ['mp4', 'mov', 'webm', 'avi'],
      allowedMimeTypes: ['video/mp4', 'video/webm', 'video/x-msvideo'],
      clipTtlHours: 24,
      retentionPolicy: 'privacy_first',
    },
  });
  Object.defineProperties(cfg, {
    videoAnalysisEnabled: { get: () => flagState.enabled, enumerable: true },
    // 'off'가 기본값 — 이 파일의 apply 테스트는 락 게이트 쿼리를 준비하지 않는다.
    // 락 게이팅 자체를 검증하는 테스트는 lockFlagState.mode를 별도로 override한다.
    lockEnforcementMode: { get: () => lockFlagState.mode, enumerable: true },
  });
  Object.defineProperties(cfg.video as Record<string, unknown>, {
    fixtureMode:           { get: () => flagState.fixtureMode, enumerable: true },
    uploadDir:             { get: () => uploadEnv.dir, enumerable: true },
    maxUploadBytes:        { get: () => uploadEnv.maxBytes, enumerable: true },
    targetThumbnail:       { get: () => flagState.targetThumbnail, enumerable: true },
    overlayFrames:         { get: () => flagState.overlayFrames, enumerable: true },
    allowUnverifiedRecipe: { get: () => flagState.allowUnverifiedRecipe, enumerable: true },
  });
  return { default: cfg };
});

// fixture 경로 검증을 결정적으로: 'good.mp4'만 통과, 나머지(traversal 등)는 null.
vi.mock('../../workers/fixturePath', () => ({
  resolveFixtureClip: vi.fn((name: unknown) =>
    name === 'good.mp4' ? '/tmp/va-fixtures/good.mp4' : null),
  // 업로드 경로는 truthy 문자열이면 통과(실 검증은 fixturePath 단위테스트가 담당).
  resolveUploadedClipPath: vi.fn((p: unknown) => (typeof p === 'string' && p ? p : null)),
  // 썸네일 경로: .thumb.jpg 이고 실제 존재하면 통과(실 패턴검증은 fixturePath 단위테스트).
  resolveSampleFramePath: vi.fn((p: unknown) =>
    (typeof p === 'string' && p.endsWith('.thumb.jpg') && fs.existsSync(p) ? p : null)),
  // keypoints artifact 경로: .keypoints.json 이고 실제 존재하면 통과(실 패턴검증은 fixturePath 단위테스트).
  resolveKeypointsArtifactPath: vi.fn((p: unknown) =>
    (typeof p === 'string' && p.endsWith('.keypoints.json') && fs.existsSync(p) ? p : null)),
  // overlay 프레임 디렉터리/파일: .frames 디렉터리이고 실제 존재하면 통과(실 패턴검증은 fixturePath 단위테스트).
  resolveOverlayFramesDir: vi.fn((p: unknown) =>
    (typeof p === 'string' && p.endsWith('.frames') && fs.existsSync(p) ? p : null)),
  resolveOverlayFramePath: vi.fn((p: unknown, _jobId: unknown, idx: unknown) => {
    if (typeof p !== 'string' || !p.endsWith('.frames') || !fs.existsSync(p)) return null;
    if (typeof idx !== 'string' || !/^\d+$/.test(idx)) return null;
    const fp = path.join(p, `${idx}.jpg`);
    return fs.existsSync(fp) ? fp : null;
  }),
}));

// sample-detect Python 러너 mock. thumbnailPath 주어지면(게이트 on) 더미 JPEG 생성(라우트 existsSync 통과).
vi.mock('../../workers/sampleDetect', () => ({
  runSampleDetect: vi.fn(async (_clipPath: string, opts?: { thumbnailPath?: string }) => {
    if (opts?.thumbnailPath) {
      fs.mkdirSync(path.dirname(opts.thumbnailPath), { recursive: true });
      fs.writeFileSync(opts.thumbnailPath, 'jpg');
    }
    return {
      schemaVersion: 1, frameIndex: 100, timestampMs: 8000, frameWidth: 640, frameHeight: 480,
      persons: [{ id: 'p1', bbox: [10, 20, 100, 200], score: 1 }, { id: 'p2', bbox: [300, 50, 80, 180], score: 1 }],
    };
  }),
}));

vi.mock('../../middleware/audit', () => ({
  writeAuditLog: vi.fn(),
  auditMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { createVideoAnalysisRouter } from '../videoAnalysis';
import { requestIdMiddleware } from '../../http/requestId';
import { writeAuditLog } from '../../middleware/audit';
import { runSampleDetect } from '../../workers/sampleDetect';
import { createFakePool, authSessionHandler, type FakePool, type FakeQueryReply, type QueryHandler } from '../../testing/fakePool';
import { makeRouterApp } from '../../testing/app';
import { makeAccessToken, authHeaders, TEST_ORG_ID, TEST_USER_ID } from '../../testing/tokens';

// testing/tokens 기본 UUID가 원래 로컬 상수와 같은 값이다.
const ORG_ID = TEST_ORG_ID;
const USER_ID = TEST_USER_ID;
const OTHER_DOCTOR = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const PAT_ID = '11111111-1111-1111-1111-111111111111';
const CLIP_ID = '22222222-2222-2222-2222-222222222222';
const JOB_ID = '33333333-3333-3333-3333-333333333333';

// 원래 로컬 도우미와 같은 클레임(sessionId 'sess-1', CSRF 원문 'ok' = tokens 기본값).
function orgToken(role = 'doctor'): string {
  return makeAccessToken({ sessionId: 'sess-1', role, name: 'Dr. Kim' });
}

// 원래 makeApp과 같은 구성: json → cookieParser → 요청 ID(createApp과 같이, S1) → 라우터 → 중앙 에러 처리기.
// makeRouterApp은 요청 ID 미들웨어를 붙이지 않으므로 mount 안에서 라우터 앞에 붙인다 —
// apply 500 테스트가 X-Request-Id를 오류 본문의 requestId로 돌려받는다.
function videoApp(fake: FakePool) {
  return makeRouterApp((a) => {
    a.use(requestIdMiddleware());
    a.use('/api/video-analysis', createVideoAnalysisRouter(fake.pool));
  });
}

// ---- 라우트 쿼리 handler (SQL로 고른다) ----
// 원래 테스트가 큐에 넣던 응답만 handler로 둔다 — 넣지 않은 쿼리는 미매치 오류(fake.unmatched)로 드러난다.
interface VideoDb {
  /** loadAccessiblePatient(SELECT id, assigned_doctor_user_id FROM patient_records …) 결과 행. */
  patient?: unknown[];
  /** loadAccessibleClip(video_analysis_clips c JOIN patient_records) 결과 행. */
  clip?: unknown[];
  /** loadAccessibleJob(video_analysis_jobs j JOIN patient_records, pool) 결과 행. */
  job?: unknown[];
  clipInsert?: FakeQueryReply;
  jobInsert?: FakeQueryReply;
  /** sample-detect 결과 저장 UPDATE. */
  sampleDetectUpdate?: FakeQueryReply;
  /** select-target UPDATE. */
  selectTargetUpdate?: FakeQueryReply;
  /** 업로드 완료(file_state = 'present') UPDATE. */
  uploadUpdate?: FakeQueryReply | Error;
  /** close-review artifact 회수 UPDATE … RETURNING. */
  closeReviewUpdate?: FakeQueryReply;
  /** apply 트랜잭션 안의 job FOR UPDATE(client). */
  applyJobForUpdate?: FakeQueryReply | Error;
}

function videoFake(db: VideoDb = {}): FakePool {
  const handlers: QueryHandler[] = [authSessionHandler()];
  if (db.patient) handlers.push({ name: 'patients.access', match: /SELECT id, assigned_doctor_user_id FROM patient_records\s+WHERE id = \$1 AND organization_id = \$2 AND deleted_at IS NULL/, reply: { rows: db.patient } });
  if (db.clip) handlers.push({ name: 'clips.access', match: /FROM video_analysis_clips c\s+JOIN patient_records p/, reply: { rows: db.clip } });
  if (db.job) handlers.push({ name: 'jobs.access', via: 'pool', match: /FROM video_analysis_jobs j\s+JOIN patient_records p/, reply: { rows: db.job } });
  if (db.clipInsert) handlers.push({ name: 'clips.insert', match: /INSERT INTO video_analysis_clips/, reply: db.clipInsert });
  if (db.jobInsert) handlers.push({ name: 'jobs.insert', match: /INSERT INTO video_analysis_jobs/, reply: db.jobInsert });
  if (db.sampleDetectUpdate) handlers.push({ name: 'clips.sampleDetectUpdate', match: /UPDATE video_analysis_clips SET sample_detect_result/, reply: db.sampleDetectUpdate });
  if (db.selectTargetUpdate) handlers.push({ name: 'clips.selectTargetUpdate', match: /UPDATE video_analysis_clips SET target_person_id/, reply: db.selectTargetUpdate });
  if (db.uploadUpdate) handlers.push({ name: 'clips.uploadUpdate', match: /UPDATE video_analysis_clips\s+SET upload_path = \$2[\s\S]*file_state = 'present'/, reply: db.uploadUpdate });
  if (db.closeReviewUpdate) handlers.push({ name: 'jobs.closeReviewUpdate', match: /UPDATE video_analysis_jobs SET keypoints_path = NULL/, reply: db.closeReviewUpdate });
  if (db.applyJobForUpdate) handlers.push({ name: 'apply.jobForUpdate', via: 'client', match: /FROM video_analysis_jobs j[\s\S]*FOR UPDATE OF j/, reply: db.applyJobForUpdate });
  return createFakePool({ handlers });
}

/** 기록된 쿼리 중 SQL에 fragment가 들어간 첫 쿼리(미매치 포함) — 원래 `q(pool).mock.calls.find(...)`. */
const callWith = (fake: FakePool, fragment: string) => fake.calls.find((c) => c.sql.includes(fragment));

const NOW = new Date('2024-06-01T10:00:00Z');

describe('video-analysis feature flag (fail-closed)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  it('returns 404 for every route when flag is off', async () => {
    flagState.enabled = false;
    const fake = createFakePool();
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/clips')
      .set(authHeaders(orgToken()))
      .send({ patientId: PAT_ID, purpose: 'apply_shell' });
    expect(res.status).toBe(404);
    // 플래그 가드는 auth 이전에 차단하므로 DB 조회도 없다.
    expect(fake.calls).toEqual([]);
  });
});

describe('POST /clips (body patientId access)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  it('creates a clip for the assigned doctor', async () => {
    const fake = videoFake({
      patient: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }], // patient access
      clipInsert: { rows: [{ id: CLIP_ID }] },                      // insert clip
    });
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/clips')
      .set(authHeaders(orgToken()))
      .send({ patientId: PAT_ID, purpose: 'apply_shell' });
    expect(res.status).toBe(201);
    expect(res.body.clipId).toBe(CLIP_ID);
  });

  it('returns 404 when the patient is not in the caller org / not found', async () => {
    const fake = videoFake({ patient: [] }); // patient not found
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/clips')
      .set(authHeaders(orgToken()))
      .send({ patientId: PAT_ID, purpose: 'apply_shell' });
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller is not the assigned doctor', async () => {
    const fake = videoFake({ patient: [{ id: PAT_ID, assigned_doctor_user_id: OTHER_DOCTOR }] });
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/clips')
      .set(authHeaders(orgToken()))
      .send({ patientId: PAT_ID, purpose: 'apply_shell' });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body', async () => {
    const fake = videoFake();
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/clips')
      .set(authHeaders(orgToken()))
      .send({ patientId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });
});

describe('POST /jobs (denormalize org/patient from clip)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  it('creates a review_pending job, filling patient/org from the clip (ignores spoofed body)', async () => {
    const fake = videoFake({
      // clip access lookup → returns the authoritative patient/org. apply_shell → review_pending.
      clip: [{ id: CLIP_ID, patient_record_id: PAT_ID, organization_id: ORG_ID, assigned_doctor_user_id: USER_ID, process_id: null, upload_path: null, source_type: 'apply_shell', file_state: 'none' }],
      // insert job
      jobInsert: { rows: [{
        id: JOB_ID, clip_id: CLIP_ID, process_id: 'p1', status: 'review_pending',
        analysis_profile: 'posture-basic', requested_features: ['overheadHours'],
        applied_at: null, applied_revision: null,
      }] },
    });
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/jobs')
      .set(authHeaders(orgToken()))
      .send({ clipId: CLIP_ID, processId: 'p1', analysisProfile: 'posture-basic', requestedFeatures: ['overheadHours'] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('review_pending');
    expect(res.body.jobId).toBe(JOB_ID);
    // insert는 clip 조회로 얻은 patient/org를 사용한다(클라 body가 아님).
    const insertCall = callWith(fake, 'INSERT INTO video_analysis_jobs');
    expect(insertCall).toBeDefined();
    expect(insertCall?.params).toContain(ORG_ID);
    expect(insertCall?.params).toContain(PAT_ID);
    expect(writeAuditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'video_analysis_submit' }));
  });

  it('accepts processId:null (job-scope aggregate) — regression for nullable schema', async () => {
    const fake = videoFake({
      clip: [{ id: CLIP_ID, patient_record_id: PAT_ID, organization_id: ORG_ID, assigned_doctor_user_id: USER_ID, process_id: null, upload_path: null, source_type: 'apply_shell', file_state: 'none' }],
      jobInsert: { rows: [{ id: JOB_ID, clip_id: CLIP_ID, process_id: null, status: 'review_pending', analysis_profile: 'posture-basic', requested_features: ['overheadHours'], applied_at: null, applied_revision: null }] },
    });
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/jobs')
      .set(authHeaders(orgToken()))
      .send({ clipId: CLIP_ID, processId: null, analysisProfile: 'posture-basic', requestedFeatures: ['overheadHours'] });
    expect(res.status).toBe(201);
    expect(res.body.jobId).toBe(JOB_ID);
  });
});

// loadAccessibleClip이 읽는 clip 행(추가 컬럼 포함). 기본은 추론 없는 적용 셸(apply_shell/none).
const clipRow = (over: Record<string, unknown> = {}) => ({
  id: CLIP_ID, patient_record_id: PAT_ID, organization_id: ORG_ID, assigned_doctor_user_id: USER_ID,
  process_id: null, upload_path: null, sample_detect_result: null, target_person_id: null,
  source_type: 'apply_shell', file_state: 'none', sample_frame_path: null, ...over,
});

describe('POST /jobs process_id 무결성 (clip이 source of truth, PR D3b)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  it('body.processId ≠ clip.process_id → 400 PROCESS_MISMATCH (p1 분석이 p2 provenance로 새는 것 차단)', async () => {
    const fake = videoFake({ clip: [clipRow({ process_id: 'p1' })] });
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/jobs')
      .set(authHeaders(orgToken()))
      .send({ clipId: CLIP_ID, processId: 'p2', analysisProfile: 'posture-basic', requestedFeatures: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROCESS_MISMATCH');
  });

  it('clip.process_id를 source of truth로 저장(body 일치 시 통과)', async () => {
    const fake = videoFake({
      clip: [clipRow({ process_id: 'p1' })],
      jobInsert: { rows: [{ id: JOB_ID, clip_id: CLIP_ID, process_id: 'p1', status: 'review_pending', analysis_profile: 'posture-basic', requested_features: [], applied_at: null, applied_revision: null }] },
    });
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/jobs')
      .set(authHeaders(orgToken()))
      .send({ clipId: CLIP_ID, processId: 'p1', analysisProfile: 'posture-basic', requestedFeatures: [] });
    expect(res.status).toBe(201);
    const insertCall = callWith(fake, 'INSERT INTO video_analysis_jobs');
    expect(insertCall?.params).toContain('p1'); // body가 아니라 clip의 process_id
  });
});

describe('POST /clips fixture 이관 (createClip resolves upload_path, PR D2b)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; flagState.fixtureMode = true; });
  afterEach(() => { flagState.fixtureMode = false; });

  it('fixtureMode + valid fixtureClipName → upload_path stored on insert', async () => {
    const fake = videoFake({
      patient: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }], // patient lookup
      clipInsert: { rows: [{ id: CLIP_ID }] },                      // insert clip
    });
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/clips')
      .set(authHeaders(orgToken()))
      .send({ patientId: PAT_ID, processId: 'p1', purpose: 'fixture', fixtureClipName: 'good.mp4' });
    expect(res.status).toBe(201);
    const insert = callWith(fake, 'INSERT INTO video_analysis_clips');
    expect(insert?.params).toContain('/tmp/va-fixtures/good.mp4'); // upload_path
    expect(insert?.params).toContain('fixture'); // source_type
  });

  it('fixtureMode OFF + purpose=fixture → 409 FIXTURE_MODE_OFF', async () => {
    flagState.fixtureMode = false;
    const fake = videoFake({ patient: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] });
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/clips')
      .set(authHeaders(orgToken()))
      .send({ patientId: PAT_ID, purpose: 'fixture', fixtureClipName: 'good.mp4' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FIXTURE_MODE_OFF');
  });

  it('fixtureMode + traversal fixtureClipName → 400 INVALID_FIXTURE (no clip insert)', async () => {
    const fake = videoFake({ patient: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }] });
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/clips')
      .set(authHeaders(orgToken()))
      .send({ patientId: PAT_ID, purpose: 'fixture', fixtureClipName: '../../etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FIXTURE');
    // fake.calls는 미매치 쿼리도 기록한다 — insert 시도 자체가 없어야 한다.
    expect(callWith(fake, 'INSERT INTO video_analysis_clips')).toBeUndefined();
  });
});

describe('POST /jobs 큐 결정 (clip.upload_path 일원화, PR D2b)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; flagState.fixtureMode = true; });
  afterEach(() => { flagState.fixtureMode = false; });

  const submit = (fake: FakePool) => request(videoApp(fake))
    .post('/api/video-analysis/jobs')
    .set(authHeaders(orgToken()))
    .send({ clipId: CLIP_ID, processId: 'p1', analysisProfile: 'posture-basic', requestedFeatures: ['overheadHours'] });
  const queuedJob: FakeQueryReply = { rows: [{ id: JOB_ID, clip_id: CLIP_ID, process_id: 'p1', status: 'queued', analysis_profile: 'posture-basic', requested_features: [], applied_at: null, applied_revision: null }] };

  it('fixture clip(present) + fixtureMode → queued', async () => {
    const fake = videoFake({
      clip: [clipRow({ source_type: 'fixture', file_state: 'present', upload_path: '/tmp/va-fixtures/good.mp4' })],
      jobInsert: queuedJob,
    });
    const res = await submit(fake);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('queued');
    const insert = callWith(fake, 'INSERT INTO video_analysis_jobs');
    expect(insert?.params).toContain('queued');
  });

  it('upload clip(present) → queued (fixtureMode 무관)', async () => {
    flagState.fixtureMode = false;
    const fake = videoFake({
      clip: [clipRow({ source_type: 'upload', file_state: 'present', upload_path: '/uploads/x.bin' })],
      jobInsert: queuedJob,
    });
    const res = await submit(fake);
    expect(res.status).toBe(201);
    const insert = callWith(fake, 'INSERT INTO video_analysis_jobs');
    expect(insert?.params).toContain('queued');
  });

  it('fixture clip + fixtureMode OFF → 409 FIXTURE_MODE_OFF', async () => {
    flagState.fixtureMode = false;
    const fake = videoFake({ clip: [clipRow({ source_type: 'fixture', file_state: 'present', upload_path: '/tmp/va-fixtures/good.mp4' })] });
    const res = await submit(fake);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FIXTURE_MODE_OFF');
  });

  it('upload clip + file_state none → 409 NO_UPLOAD', async () => {
    const fake = videoFake({ clip: [clipRow({ source_type: 'upload', file_state: 'none', upload_path: null })] });
    const res = await submit(fake);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_UPLOAD');
  });

  it('upload clip + file_state deleted → 409 SOURCE_DELETED_REUPLOAD_REQUIRED', async () => {
    const fake = videoFake({ clip: [clipRow({ source_type: 'upload', file_state: 'deleted', upload_path: null })] });
    const res = await submit(fake);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SOURCE_DELETED_REUPLOAD_REQUIRED');
  });
});

describe('POST /clips/:id/sample-detect (fixture 전용, PR D2b)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; flagState.fixtureMode = true; });
  afterEach(() => { flagState.fixtureMode = false; });

  it('fixtureMode + upload_path → runs sample_detect, stores result', async () => {
    const fake = videoFake({
      clip: [clipRow({ source_type: 'fixture', file_state: 'present', upload_path: '/tmp/va-fixtures/good.mp4' })],
      sampleDetectUpdate: { rows: [] }, // UPDATE sample_detect_result
    });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/sample-detect`)
      .set(authHeaders(orgToken())).send({});
    expect(res.status).toBe(200);
    expect(res.body.persons.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2']);
    const upd = callWith(fake, 'SET sample_detect_result');
    expect(upd).toBeDefined();
  });

  it('fixtureMode OFF (or no upload_path) → 409 SAMPLE_DETECT_UNAVAILABLE', async () => {
    flagState.fixtureMode = false;
    const fake = videoFake({ clip: [clipRow()] });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/sample-detect`)
      .set(authHeaders(orgToken())).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SAMPLE_DETECT_UNAVAILABLE');
  });

  it('깨진 sample-detect 출력 → 502 INVALID_SAMPLE_DETECT (일반 500 아님)', async () => {
    vi.mocked(runSampleDetect).mockRejectedValueOnce(
      Object.assign(new Error('sample-detect produced an invalid result'), { code: 'INVALID_SAMPLE_DETECT' }),
    );
    const fake = videoFake({ clip: [clipRow({ source_type: 'fixture', file_state: 'present', upload_path: '/tmp/va-fixtures/good.mp4' })] });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/sample-detect`)
      .set(authHeaders(orgToken())).send({});
    // 오류의 원인이 runSampleDetect여야 한다 — 미매치 쿼리 오류가 끼어든 것이 아님
    fake.assertNoUnmatched();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('INVALID_SAMPLE_DETECT');
  });
});

describe('POST /clips/:id/select-target (PR D2b)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  const sdr = { schemaVersion: 1, frameIndex: 100, timestampMs: 8000, frameWidth: 640, frameHeight: 480, persons: [{ id: 'p1', bbox: [10, 20, 100, 200], score: 1 }] };

  it('valid candidate id → stores target_person_id', async () => {
    const fake = videoFake({
      clip: [clipRow({ sample_detect_result: sdr })],
      selectTargetUpdate: { rows: [] }, // UPDATE target_person_id
    });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/select-target`)
      .set(authHeaders(orgToken()))
      .send({ targetPersonId: 'p1' });
    expect(res.status).toBe(200);
    expect(res.body.targetPersonId).toBe('p1');
  });

  it('no prior sample-detect → 409 NO_SAMPLE_DETECT', async () => {
    const fake = videoFake({ clip: [clipRow()] });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/select-target`)
      .set(authHeaders(orgToken()))
      .send({ targetPersonId: 'p1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_SAMPLE_DETECT');
  });

  it('spoofed candidate id (not in result) → 400 INVALID_TARGET', async () => {
    const fake = videoFake({ clip: [clipRow({ sample_detect_result: sdr })] });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/select-target`)
      .set(authHeaders(orgToken()))
      .send({ targetPersonId: 'p999' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TARGET');
  });
});

describe('POST /jobs/:jobId/apply', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; flagState.allowUnverifiedRecipe = false; });

  const appliedEntry = (over: Record<string, unknown> = {}) => ({
    moduleId: 'shoulder', targetPath: 'modules.shoulder.jobExtras[sharedJobId=j1].overheadHours',
    suggestedValue: 1.8, appliedValue: 1.8, previousValue: null, unit: 'hours_per_day',
    source: 'video', processIds: [], clipIds: [], analysisJobIds: [], confidence: 0.8,
    analysisBundleVersion: 'b', appliedAt: '', appliedBy: 'u', ...over,
  });
  // 데이터에 1건 새 appliedInput을 포함(provenance 없음 → recipe 검증 skip). count·suffix 정합.
  const dataWith = (entries: unknown[]) => ({ shared: { name: 'Kim', videoAnalysis: { appliedInputs: entries } }, modules: {}, activeModules: [] });
  const body = { data: dataWith([appliedEntry()]), appliedInputsHash: 'h1', appliedInputsCount: 1 };

  it('a DB failure inside the apply transaction → ROLLBACK + 500 envelope with the request id (S1)', async () => {
    // BEGIN·ROLLBACK은 fakePool 기본 트랜잭션 처리(빈 결과)가 답한다. job FOR UPDATE만 실패시킨다.
    const fake = videoFake({ applyJobForUpdate: new Error('connection terminated') });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/jobs/${JOB_ID}/apply`)
      .set(authHeaders(orgToken()))
      .set('If-Match', '1')
      .set('X-Request-Id', 'req-p1-08')
      .send(body);
    // 500의 원인이 job FOR UPDATE handler의 오류여야 한다 — 미매치 오류로 우연히 500이 된 것이 아님
    fake.assertNoUnmatched();
    fake.assertAllReleased();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 'INTERNAL_ERROR', error: 'Internal server error', requestId: 'req-p1-08' });
    expect(fake.calls.some((c) => c.via === 'client' && c.sql === 'ROLLBACK')).toBe(true);
  });

});

describe('POST /clips purpose 검증 (M3-7a)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  it('purpose 누락 → 400 MISSING_PURPOSE', async () => {
    const fake = videoFake();
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/clips')
      .set(authHeaders(orgToken()))
      .send({ patientId: PAT_ID });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_PURPOSE');
  });

  it('purpose=analysis_upload + fixtureClipName → 400 (잘못된 조합)', async () => {
    const fake = videoFake();
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/clips')
      .set(authHeaders(orgToken()))
      .send({ patientId: PAT_ID, purpose: 'analysis_upload', fixtureClipName: 'good.mp4' });
    expect(res.status).toBe(400);
  });

  it('purpose=fixture + fixtureClipName 없음 → 400 (잘못된 조합)', async () => {
    const fake = videoFake();
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/clips')
      .set(authHeaders(orgToken()))
      .send({ patientId: PAT_ID, purpose: 'fixture' });
    expect(res.status).toBe(400);
  });

  it('purpose=analysis_upload → source_type=upload, file_state=none INSERT', async () => {
    const fake = videoFake({
      patient: [{ id: PAT_ID, assigned_doctor_user_id: USER_ID }],
      clipInsert: { rows: [{ id: CLIP_ID }] },
    });
    const res = await request(videoApp(fake))
      .post('/api/video-analysis/clips')
      .set(authHeaders(orgToken()))
      .send({ patientId: PAT_ID, purpose: 'analysis_upload' });
    expect(res.status).toBe(201);
    const insert = callWith(fake, 'INSERT INTO video_analysis_clips');
    expect(insert?.params).toContain('upload');
    expect(insert?.params).toContain('none');
  });
});

describe('POST /clips/:id/upload (M3-7a)', () => {
  // 'ftyp'(offset 4) 시그니처를 가진 최소 mp4 버퍼.
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(20)]);
  const NOT_VIDEO = Buffer.from('this is definitely not a video!!');
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  const uploadRow = (over = {}) => clipRow({ source_type: 'upload', file_state: 'none', upload_path: null, ...over });

  it('정상 업로드 → 200 + file_state=present UPDATE + audit', async () => {
    const fake = videoFake({
      clip: [uploadRow()],                        // loadAccessibleClip
      uploadUpdate: { rows: [], rowCount: 1 },    // UPDATE present
    });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set(authHeaders(orgToken()))
      .attach('file', MP4, { filename: 'clip.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(200);
    expect(res.body.clipId).toBe(CLIP_ID);
    expect(res.body.sha256).toBeTruthy();
    const upd = callWith(fake, "file_state = 'present'");
    expect(upd).toBeDefined();
    expect(writeAuditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'video_analysis_upload' }));
  });

  it('허용되지 않은 확장자 → 400 INVALID_MEDIA_TYPE (수신 후 sniff 전 차단)', async () => {
    const fake = videoFake({ clip: [uploadRow()] });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set(authHeaders(orgToken()))
      .attach('file', MP4, { filename: 'clip.txt', contentType: 'video/mp4' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MEDIA_TYPE');
  });

  it('MIME 위조(비영상) → 400 INVALID_MEDIA_TYPE', async () => {
    const fake = videoFake({ clip: [uploadRow()] });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set(authHeaders(orgToken()))
      .attach('file', NOT_VIDEO, { filename: 'fake.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MEDIA_TYPE');
  });

  it('업로드 대상 아님(apply_shell) → 400 CLIP_NOT_UPLOAD_TARGET', async () => {
    const fake = videoFake({ clip: [clipRow({ source_type: 'apply_shell', file_state: 'none' })] });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set(authHeaders(orgToken()))
      .attach('file', MP4, { filename: 'clip.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CLIP_NOT_UPLOAD_TARGET');
  });

  it('이미 업로드됨(file_state=present) → 409 CLIP_ALREADY_UPLOADED', async () => {
    const fake = videoFake({ clip: [uploadRow({ file_state: 'present', upload_path: '/uploads/x.bin' })] });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set(authHeaders(orgToken()))
      .attach('file', MP4, { filename: 'clip.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CLIP_ALREADY_UPLOADED');
  });

  it('경쟁 업로드(UPDATE 0행) → 409 CLIP_ALREADY_UPLOADED', async () => {
    const fake = videoFake({
      clip: [uploadRow()],
      uploadUpdate: { rows: [], rowCount: 0 }, // 경쟁자가 먼저 성공
    });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set(authHeaders(orgToken()))
      .attach('file', MP4, { filename: 'clip.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CLIP_ALREADY_UPLOADED');
  });

  it('DB UPDATE 예외 → 500 + 최종 파일 orphan 미잔존', async () => {
    const countBin = () => fs.readdirSync(uploadEnv.dir).filter((f: string) => f.endsWith('.bin')).length;
    const before = countBin();
    const fake = videoFake({
      clip: [uploadRow()],
      uploadUpdate: new Error('db down'), // UPDATE 장애
    });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set(authHeaders(orgToken()))
      .attach('file', MP4, { filename: 'clip.mp4', contentType: 'video/mp4' });
    // 500의 원인이 UPDATE handler의 오류여야 한다 — 미매치 오류로 우연히 500이 된 것이 아님
    fake.assertNoUnmatched();
    expect(res.status).toBe(500);
    expect(countBin()).toBe(before); // rename된 최종 파일이 finally에서 정리됨(orphan 없음).
  });

  it('잘못된 필드명(multer LIMIT_UNEXPECTED_FILE) → 400 INVALID_UPLOAD', async () => {
    const fake = videoFake({ clip: [uploadRow()] }); // 사전검사 통과 후 multer가 거부
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set(authHeaders(orgToken()))
      .attach('wrongfield', MP4, { filename: 'clip.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_UPLOAD');
  });

  // multer가 거부한 요청이 tmp에 반쯤 쓴 파일을 남기지 않는지(디스크 누수) — 버전 업그레이드 시 깨지기 쉬운 동작.
  const tmpFiles = () => {
    const dir = path.join(uploadEnv.dir, 'tmp');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  it('파일 뒤에 텍스트 필드가 오면(fields: 0 → LIMIT_FIELD_COUNT) → 400 INVALID_UPLOAD + tmp 잔여 없음', async () => {
    const before = tmpFiles().length;
    const fake = videoFake({ clip: [uploadRow()] });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set(authHeaders(orgToken()))
      .attach('file', MP4, { filename: 'clip.mp4', contentType: 'video/mp4' })
      .field('note', 'x'); // 클라이언트는 file 외 필드를 보내지 않는다 — 파일이 이미 tmp에 쓰인 뒤에 필드가 도착하는 경우
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_UPLOAD');
    expect(tmpFiles()).toHaveLength(before);
  });

  it('종결 경계 없이 끊긴 본문 → 오류 응답 + 반쯤 쓴 tmp 파일 잔여 없음 (multer 1.x는 남겼다)', async () => {
    const before = tmpFiles().length;
    const fake = videoFake({ clip: [uploadRow()] });
    const truncated = '--XB\r\nContent-Disposition: form-data; name="file"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\nftyp-partial-data';
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set(authHeaders(orgToken()))
      .set('Content-Type', 'multipart/form-data; boundary=XB')
      .send(Buffer.from(truncated));
    // 오류 응답의 원인이 끊긴 본문이어야 한다 — 미매치 쿼리 오류(500)가 끼어든 것이 아님
    fake.assertNoUnmatched();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(tmpFiles()).toHaveLength(before);
  });

  it('크기 한도 초과 → 413 FILE_TOO_LARGE + tmp 잔여 없음', async () => {
    const before = tmpFiles().length;
    const fake = videoFake({ clip: [uploadRow()] });
    uploadEnv.maxBytes = 1024; // buildUploadMiddleware가 앱 생성(videoApp) 시점에 읽는다
    try {
      const res = await request(videoApp(fake))
        .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
        .set(authHeaders(orgToken()))
        .attach('file', Buffer.concat([MP4, Buffer.alloc(8192)]), { filename: 'clip.mp4', contentType: 'video/mp4' });
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('FILE_TOO_LARGE');
      expect(tmpFiles()).toHaveLength(before);
    } finally {
      uploadEnv.maxBytes = 50 * 1024 * 1024;
    }
  });
});

describe('POST /clips/:id/sample-detect 실 업로드 guard (M3-7a)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  it('upload + present → sample-detect 실행', async () => {
    const fake = videoFake({
      clip: [clipRow({ source_type: 'upload', file_state: 'present', upload_path: `${uploadEnv.dir}/x.bin` })],
      sampleDetectUpdate: { rows: [] }, // UPDATE
    });
    // resolveUploadedClipPath는 실제 파일 검증 → 파일 생성.
    fs.writeFileSync(`${uploadEnv.dir}/x.bin`, 'x');
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/sample-detect`)
      .set(authHeaders(orgToken())).send({});
    expect(res.status).toBe(200);
    expect(res.body.persons.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2']);
  });

  it('upload + file_state none → 409 NO_UPLOAD', async () => {
    const fake = videoFake({ clip: [clipRow({ source_type: 'upload', file_state: 'none', upload_path: null })] });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/sample-detect`)
      .set(authHeaders(orgToken())).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_UPLOAD');
  });
});

describe('대상자 선택 썸네일 (정책 예외)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; flagState.targetThumbnail = false; });
  afterEach(() => { flagState.targetThumbnail = false; });

  const uploadClipRow = (over = {}) =>
    clipRow({ source_type: 'upload', file_state: 'present', upload_path: `${uploadEnv.dir}/x.bin`, ...over });
  // 실제 존재하는 더미 썸네일 파일 생성(resolveSampleFramePath mock = .thumb.jpg + 존재).
  const makeFrameFile = () => {
    const dir = path.join(uploadEnv.dir, 'artifacts');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${CLIP_ID}.${crypto.randomUUID()}.thumb.jpg`);
    fs.writeFileSync(p, 'jpg');
    return p;
  };

  it('게이트 on → sample-detect가 sample_frame_path(버전명) 저장', async () => {
    flagState.targetThumbnail = true;
    const fake = videoFake({ clip: [uploadClipRow()], sampleDetectUpdate: { rows: [] } }); // UPDATE
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/sample-detect`)
      .set(authHeaders(orgToken())).send({});
    expect(res.status).toBe(200);
    const upd = callWith(fake, 'sample_frame_path = $3');
    expect(String(upd?.params?.[2])).toMatch(new RegExp(`${CLIP_ID}\\.[0-9a-f-]{36}\\.thumb\\.jpg$`));
  });

  it('게이트 off → sample_frame_path null', async () => {
    const fake = videoFake({ clip: [uploadClipRow()], sampleDetectUpdate: { rows: [] } });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/sample-detect`)
      .set(authHeaders(orgToken())).send({});
    expect(res.status).toBe(200);
    const upd = callWith(fake, 'sample_frame_path = $3');
    expect(upd?.params?.[2]).toBeNull();
  });

  it('GET /sample-frame → 200 image/jpeg + no-store', async () => {
    flagState.targetThumbnail = true; // 게이트 on이어야 노출
    const framePath = makeFrameFile();
    const fake = videoFake({ clip: [uploadClipRow({ sample_frame_path: framePath })] });
    const res = await request(videoApp(fake))
      .get(`/api/video-analysis/clips/${CLIP_ID}/sample-frame`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('GET /sample-frame → 404 (sample_frame_path 없음)', async () => {
    const fake = videoFake({ clip: [uploadClipRow({ sample_frame_path: null })] });
    const res = await request(videoApp(fake))
      .get(`/api/video-analysis/clips/${CLIP_ID}/sample-frame`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(404);
  });

  it('GET /sample-frame → 404 (게이트 off인데 과거 경로 잔존: opt-in 불변식)', async () => {
    const framePath = makeFrameFile(); // 실제 파일 있어도
    flagState.targetThumbnail = false;  // 게이트 off
    const fake = videoFake({ clip: [uploadClipRow({ sample_frame_path: framePath })] });
    const res = await request(videoApp(fake))
      .get(`/api/video-analysis/clips/${CLIP_ID}/sample-frame`)
      .set('Authorization', `Bearer ${orgToken()}`);
    expect(res.status).toBe(404); // 노출 금지
  });

  it('select-target 성공 → sample_frame_path NULL 회수', async () => {
    const framePath = makeFrameFile();
    const sdr = { schemaVersion: 1, frameIndex: 1, timestampMs: 1, frameWidth: 640, frameHeight: 480, persons: [{ id: 'p1', bbox: [1, 2, 3, 4], score: 1 }] };
    const fake = videoFake({
      clip: [uploadClipRow({ sample_detect_result: sdr, sample_frame_path: framePath })],
      selectTargetUpdate: { rows: [] }, // UPDATE
    });
    const res = await request(videoApp(fake))
      .post(`/api/video-analysis/clips/${CLIP_ID}/select-target`)
      .set(authHeaders(orgToken()))
      .send({ targetPersonId: 'p1' });
    expect(res.status).toBe(200);
    const upd = callWith(fake, 'sample_frame_path = NULL');
    expect(upd).toBeDefined();
    expect(fs.existsSync(framePath)).toBe(false); // 파일도 회수
  });
});

// ── 6.0-8: GET /jobs/:jobId/overlay + POST /jobs/:jobId/close-review ──
describe('GET /jobs/:jobId/overlay (검수 골격, 6.0-8)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; flagState.overlayFrames = false; });
  afterEach(() => { flagState.overlayFrames = false; });

  // coco17 17점 유효 PoseKeypoints 산출(검증 통과용).
  const kpDoc = () => ({
    schemaVersion: 1, keypointConvention: 'coco17', coordinateSpace: 'pixel',
    frameWidth: 640, frameHeight: 480, requestedFps: 2, sampledFps: 2,
    source: { clipRef: 'clip', originalFps: 30, totalFrames: 60 },
    model: { detector: 'd', pose: 'p', inputSize: [192, 256], modelName: 'm', modelVersion: '1', detectorSha256: null, poseSha256: null, weightsComplete: false, preprocessConfigHash: 'h' },
    frames: [{ frameIndex: 0, timestampMs: 0, persons: [{
      trackId: 'trk-1', bbox: [10, 20, 100, 200], score: 0.9,
      keypoints: Array.from({ length: 17 }, (_, i) => [i * 5, i * 4, 0.8]),
    }] }],
  });
  // 임시 artifact 파일 작성 + sha256 반환. 본문은 route가 읽는 그대로(바이트 일치).
  const writeArtifact = (doc: unknown) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-kp-'));
    const p = path.join(dir, `${JOB_ID}.keypoints.json`);
    const body = JSON.stringify(doc);
    fs.writeFileSync(p, body);
    return { path: p, sha: crypto.createHash('sha256').update(Buffer.from(body)).digest('hex') };
  };
  const jobRowKp = (over = {}) => ({
    id: JOB_ID, organization_id: ORG_ID, patient_record_id: PAT_ID, clip_id: CLIP_ID,
    process_id: 'p1', status: 'review_pending', analysis_profile: null,
    requested_features: [], result_features: { tracking: { targetTrackId: 'trk-1' } },
    error_code: null, applied_at: null, applied_revision: null, applied_inputs_hash: null,
    keypoints_path: null, keypoints_sha256: null, frames_path: null,
    created_at: NOW, updated_at: NOW, assigned_doctor_user_id: USER_ID, ...over,
  });
  const getOverlay = (fake: FakePool, role = 'doctor') => request(videoApp(fake))
    .get(`/api/video-analysis/jobs/${JOB_ID}/overlay`).set('Authorization', `Bearer ${orgToken(role)}`);

  it('200: sha256+schema 통과 → {jobId, clipId, targetTrackId, keypoints}', async () => {
    const { path: kpPath, sha } = writeArtifact(kpDoc());
    const fake = videoFake({ job: [jobRowKp({ keypoints_path: kpPath, keypoints_sha256: sha })] });
    const res = await getOverlay(fake);
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(JOB_ID);
    expect(res.body.clipId).toBe(CLIP_ID);
    expect(res.body.targetTrackId).toBe('trk-1');
    expect(res.body.keypoints.frames).toHaveLength(1);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('404 OVERLAY_NOT_AVAILABLE: keypoints_path 없음(검수 종료/미산출)', async () => {
    const fake = videoFake({ job: [jobRowKp({ keypoints_path: null })] });
    const res = await getOverlay(fake);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OVERLAY_NOT_AVAILABLE');
  });

  it('403: 담당의 아님', async () => {
    const { path: kpPath, sha } = writeArtifact(kpDoc());
    const fake = videoFake({ job: [jobRowKp({ keypoints_path: kpPath, keypoints_sha256: sha, assigned_doctor_user_id: OTHER_DOCTOR })] });
    const res = await getOverlay(fake);
    expect(res.status).toBe(403);
  });

  it('404: 플래그 off → 라우트 미존재', async () => {
    flagState.enabled = false;
    const fake = createFakePool();
    const res = await getOverlay(fake);
    expect(res.status).toBe(404);
    expect(fake.calls).toEqual([]);
  });

  it('502 INVALID_KEYPOINTS_ARTIFACT: sha256 불일치(변조)', async () => {
    const { path: kpPath } = writeArtifact(kpDoc());
    const fake = videoFake({ job: [jobRowKp({ keypoints_path: kpPath, keypoints_sha256: 'deadbeef' })] });
    const res = await getOverlay(fake);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('INVALID_KEYPOINTS_ARTIFACT');
  });

  it('502: sha256 null인데 path 존재(비정상)', async () => {
    const { path: kpPath } = writeArtifact(kpDoc());
    const fake = videoFake({ job: [jobRowKp({ keypoints_path: kpPath, keypoints_sha256: null })] });
    const res = await getOverlay(fake);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('INVALID_KEYPOINTS_ARTIFACT');
  });

  it('502: 계약 위반(깨진 구조)', async () => {
    const { path: kpPath, sha } = writeArtifact({ schemaVersion: 1, foo: 'bar' });
    const fake = videoFake({ job: [jobRowKp({ keypoints_path: kpPath, keypoints_sha256: sha })] });
    const res = await getOverlay(fake);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('INVALID_KEYPOINTS_ARTIFACT');
  });

  it('framesAvailable: 게이트 on + frames_path + resolver 통과 → true, off → false', async () => {
    const { path: kpPath, sha } = writeArtifact(kpDoc());
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'va-fr-'));
    const fdir = path.join(parent, `${JOB_ID}.frames`);
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, '0.jpg'), 'jpg');

    flagState.overlayFrames = true;
    const fake = videoFake({ job: [jobRowKp({ keypoints_path: kpPath, keypoints_sha256: sha, frames_path: fdir })] });
    let res = await getOverlay(fake);
    expect(res.status).toBe(200);
    expect(res.body.framesAvailable).toBe(true);

    flagState.overlayFrames = false; // 게이트 off → false (경로 잔존해도)
    const fake2 = videoFake({ job: [jobRowKp({ keypoints_path: kpPath, keypoints_sha256: sha, frames_path: fdir })] });
    res = await getOverlay(fake2);
    expect(res.body.framesAvailable).toBe(false);
  });
});

describe('GET /jobs/:jobId/overlay-frame/:frameIndex (실 프레임, privacy 게이트 예외)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; flagState.overlayFrames = false; });
  afterEach(() => { flagState.overlayFrames = false; });

  const mkFrames = () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'va-ofr-'));
    const fdir = path.join(parent, `${JOB_ID}.frames`);
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, '6.jpg'), 'jpgdata');
    return fdir;
  };
  const row = (over = {}) => ({
    id: JOB_ID, organization_id: ORG_ID, patient_record_id: PAT_ID, clip_id: CLIP_ID,
    process_id: 'p1', status: 'review_pending', analysis_profile: null,
    requested_features: [], result_features: null, error_code: null,
    applied_at: null, applied_revision: null, applied_inputs_hash: null,
    keypoints_path: null, keypoints_sha256: null, frames_path: null,
    created_at: NOW, updated_at: NOW, assigned_doctor_user_id: USER_ID, ...over,
  });
  const get = (fake: FakePool, idx = '6') => request(videoApp(fake))
    .get(`/api/video-analysis/jobs/${JOB_ID}/overlay-frame/${idx}`).set('Authorization', `Bearer ${orgToken()}`);

  it('게이트 off → 404 (frames_path 있어도)', async () => {
    const fdir = mkFrames();
    const fake = videoFake({ job: [row({ frames_path: fdir })] });
    const res = await get(fake);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OVERLAY_FRAME_NOT_FOUND');
  });

  it('게이트 on + frames_path NULL → 404 (DB source of truth)', async () => {
    flagState.overlayFrames = true;
    const fake = videoFake({ job: [row({ frames_path: null })] });
    expect((await get(fake)).status).toBe(404);
  });

  it('게이트 on + frames_path + 파일 → 200 image/jpeg no-store', async () => {
    const fdir = mkFrames();
    flagState.overlayFrames = true;
    const fake = videoFake({ job: [row({ frames_path: fdir })] });
    const res = await get(fake, '6');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('잘못된 frameIndex(비정수) → 404', async () => {
    const fdir = mkFrames();
    flagState.overlayFrames = true;
    const fake = videoFake({ job: [row({ frames_path: fdir })] });
    expect((await get(fake, 'abc')).status).toBe(404);
  });

  it('플래그 off → 라우트 미존재(404)', async () => {
    flagState.enabled = false;
    expect((await get(createFakePool())).status).toBe(404);
  });
});

describe('POST /jobs/:jobId/close-review (검수 종료, 6.0-8)', () => {
  beforeEach(() => { vi.clearAllMocks(); flagState.enabled = true; });

  const jobRowCr = (over = {}) => ({
    id: JOB_ID, organization_id: ORG_ID, patient_record_id: PAT_ID, clip_id: CLIP_ID,
    process_id: 'p1', status: 'review_pending', analysis_profile: null,
    requested_features: [], result_features: null, error_code: null,
    applied_at: null, applied_revision: null, applied_inputs_hash: null,
    keypoints_path: null, keypoints_sha256: null, frames_path: null,
    created_at: NOW, updated_at: NOW, assigned_doctor_user_id: USER_ID, ...over,
  });
  const post = (fake: FakePool) => request(videoApp(fake))
    .post(`/api/video-analysis/jobs/${JOB_ID}/close-review`)
    .set(authHeaders(orgToken()));

  it('200 cleared: artifact 회수 + 파일 unlink + audit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-cr-'));
    const kpPath = path.join(dir, `${JOB_ID}.keypoints.json`);
    fs.writeFileSync(kpPath, '{}');
    const fake = videoFake({
      job: [jobRowCr({ keypoints_path: kpPath, keypoints_sha256: 'x' })], // loadAccessibleJob
      closeReviewUpdate: { rows: [{ keypoints_path: kpPath }] },         // UPDATE RETURNING
    });
    const res = await post(fake);
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
    expect(fs.existsSync(kpPath)).toBe(false); // 파일 회수
    expect(writeAuditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'video_analysis_close_review', targetType: 'patient', targetId: PAT_ID,
    }));
  });

  it('200: overlay 프레임 디렉터리도 독립 회수(keypoints 없고 frames만 잔존)', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'va-crf-'));
    const fdir = path.join(parent, `${JOB_ID}.frames`);
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, '0.jpg'), 'jpg');
    const fake = videoFake({
      job: [jobRowCr({ keypoints_path: null, frames_path: fdir })],              // loadAccessibleJob
      closeReviewUpdate: { rows: [{ keypoints_path: null, frames_path: fdir }] }, // UPDATE RETURNING
    });
    const res = await post(fake);
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
    expect(fs.existsSync(fdir)).toBe(false); // 프레임 디렉터리 재귀삭제
  });

  it('409 JOB_NOT_READY: processing 중이면 차단(worker 경합)', async () => {
    const fake = videoFake({ job: [jobRowCr({ status: 'processing', keypoints_path: 'x' })] });
    const res = await post(fake);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_NOT_READY');
    // UPDATE는 호출되지 않음(auth + loadAccessibleJob 2회뿐).
    expect(fake.calls.filter((c) => c.via === 'pool')).toHaveLength(2);
  });

  it('200 멱등: artifact 없으면 cleared:false', async () => {
    const fake = videoFake({
      job: [jobRowCr({ keypoints_path: null })],
      closeReviewUpdate: { rows: [] }, // UPDATE 0행
    });
    const res = await post(fake);
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(false);
  });

  it('403: 담당의 아님', async () => {
    const fake = videoFake({ job: [jobRowCr({ assigned_doctor_user_id: OTHER_DOCTOR })] });
    const res = await post(fake);
    expect(res.status).toBe(403);
  });
});
