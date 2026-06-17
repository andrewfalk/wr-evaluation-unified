import { Router, type Request, type Response, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import config from '../config';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { writeAuditLog } from '../middleware/audit';
import path from 'path';
import { SampleDetectResultSchema } from '@wr/contracts';
import { resolveFixtureClip } from '../workers/fixturePath';
import { runSampleDetect } from '../workers/sampleDetect';

// ---------------------------------------------------------------------------
// 작업 영상 인간공학 분석 — clip/job 라이프사이클 + apply(영속화) API (6.0-4, mock).
//
// M1(mock) 범위: 서버는 clip/job 상태머신·권한·audit·apply 멱등 영속화를 담당한다.
// feature 계산 자체는 클라이언트(generateMockFeatures)에서 수행하며, 적용 시 클라가
// 계산한 환자 data를 apply 엔드포인트로 보내 If-Match 동시성으로 저장한다.
// 실제 추론(서버측 feature 계산)은 M2(6.0-5/6.0-6)에서 이 셸에 끼워 넣는다.
// ---------------------------------------------------------------------------

const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

const CreateClipBody = z.object({
  patientId: z.string().uuid(),
  // job-scope 집계는 특정 공정이 없어 null을 보낸다(컬럼도 nullable). null/undefined 모두 허용.
  processId: z.string().nullable().optional(),
  // dev-only fixture 입력(fixtureMode일 때만). 여기서 resolve→upload_path 저장(sample-detect가 그 전 단계, PR D2b).
  fixtureClipName: z.string().optional(),
});
const SelectTargetBody = z.object({ targetPersonId: z.string().min(1) });
const CreateJobBody = z.object({
  clipId: z.string().uuid(),
  // job-scope 집계 제안은 process_id 없이 null로 들어온다(여러 공정 집계, 추적은 appliedInputs.processIds).
  processId: z.string().nullable().optional(),
  analysisProfile: z.string().nullable().optional(),
  requestedFeatures: z.array(z.string()).optional(),
  // fixtureClipName은 createClip으로 이관(PR D2b) — 큐 결정은 clip.upload_path로 일원화.
});
// apply: 클라가 applyFeatureToModule로 계산한 환자 data + 멱등 해시.
const ApplyBody = z.object({
  data: z.object({}).passthrough(),
  appliedInputsHash: z.string().min(1),
  appliedInputsCount: z.number().int().nonnegative().optional(),
  // 이 적용이 소비한 원본 분석 job id(추론 출처 추적·consumed 전이). 셸 적용 job과 구분(PR D1).
  sourceAnalysisJobIds: z.array(z.string().uuid()).default([]),
});

interface SessionInfo {
  userId: string;
  organizationId: string | null;
  role: string;
  name?: string;
}

// 담당의/admin 확인(공통). orgId null(superadmin context)이거나 미존재면 거부.
function canAccess(session: SessionInfo, assignedDoctorUserId: string | null): boolean {
  return session.role === 'admin' || assignedDoctorUserId === session.userId;
}

// patientId(서버 patient_records.id) 기반 접근 확인. 미존재/타org → 404(존재 누설 방지).
async function loadAccessiblePatient(
  pool: Pool, session: SessionInfo, patientId: string, res: Response
): Promise<{ id: string } | null> {
  if (session.organizationId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return null;
  }
  const { rows } = await pool.query<{ id: string; assigned_doctor_user_id: string | null }>(
    `SELECT id, assigned_doctor_user_id FROM patient_records
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [patientId, session.organizationId]
  );
  if (rows.length === 0) {
    res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
    return null;
  }
  if (!canAccess(session, rows[0].assigned_doctor_user_id)) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
    return null;
  }
  return { id: rows[0].id };
}

interface ClipCtx {
  clipId: string; patientRecordId: string; organizationId: string;
  uploadPath: string | null; sampleDetectResult: unknown; targetPersonId: string | null;
}
// clipId → clip + 소속 환자 권한 확인. job-scoped guard의 clip 버전.
async function loadAccessibleClip(
  pool: Pool, session: SessionInfo, clipId: string, res: Response
): Promise<ClipCtx | null> {
  if (session.organizationId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return null;
  }
  const { rows } = await pool.query<{
    id: string; patient_record_id: string; organization_id: string; assigned_doctor_user_id: string | null;
    upload_path: string | null; sample_detect_result: unknown; target_person_id: string | null;
  }>(
    `SELECT c.id, c.patient_record_id, c.organization_id, p.assigned_doctor_user_id,
            c.upload_path, c.sample_detect_result, c.target_person_id
     FROM video_analysis_clips c
     JOIN patient_records p ON p.id = c.patient_record_id AND p.deleted_at IS NULL
     WHERE c.id = $1 AND c.organization_id = $2`,
    [clipId, session.organizationId]
  );
  if (rows.length === 0) {
    res.status(404).json({ code: 'CLIP_NOT_FOUND', error: 'Clip not found' });
    return null;
  }
  if (!canAccess(session, rows[0].assigned_doctor_user_id)) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
    return null;
  }
  return {
    clipId: rows[0].id, patientRecordId: rows[0].patient_record_id, organizationId: rows[0].organization_id,
    uploadPath: rows[0].upload_path, sampleDetectResult: rows[0].sample_detect_result, targetPersonId: rows[0].target_person_id,
  };
}

// jobId → job + 소속 환자 권한 확인. (FOR UPDATE 없는 일반 조회용.)
async function loadAccessibleJob(
  pool: Pool, session: SessionInfo, jobId: string, res: Response
): Promise<{ row: VideoJobRow } | null> {
  if (session.organizationId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return null;
  }
  const { rows } = await pool.query<VideoJobRow & { assigned_doctor_user_id: string | null }>(
    `SELECT j.*, p.assigned_doctor_user_id
     FROM video_analysis_jobs j
     JOIN patient_records p ON p.id = j.patient_record_id AND p.deleted_at IS NULL
     WHERE j.id = $1 AND j.organization_id = $2`,
    [jobId, session.organizationId]
  );
  if (rows.length === 0) {
    res.status(404).json({ code: 'JOB_NOT_FOUND', error: 'Job not found' });
    return null;
  }
  if (!canAccess(session, rows[0].assigned_doctor_user_id)) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
    return null;
  }
  return { row: rows[0] };
}

interface VideoJobRow {
  id: string;
  organization_id: string;
  patient_record_id: string;
  clip_id: string;
  process_id: string | null;
  status: string;
  analysis_profile: string | null;
  requested_features: unknown;
  result_features: unknown;
  error_code: string | null;
  applied_at: Date | null;
  applied_revision: number | null;
  applied_inputs_hash: string | null;
  created_at: Date;
  updated_at: Date;
}

function jobResponse(row: VideoJobRow): Record<string, unknown> {
  return {
    jobId: row.id,
    clipId: row.clip_id,
    processId: row.process_id,
    status: row.status,
    analysisProfile: row.analysis_profile,
    requestedFeatures: row.requested_features ?? [],
    // 워커가 ClipFeatureSetSchema 검증 후 저장한 intrinsic clipFeatures(있으면). per-day 환산은 클라.
    resultFeatures: row.result_features ?? null,
    errorCode: row.error_code ?? null,
    appliedAt: row.applied_at ? row.applied_at.toISOString() : null,
    appliedRevision: row.applied_revision,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function createClip(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  const parse = CreateClipBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  const patient = await loadAccessiblePatient(pool, session, parse.data.patientId, res);
  if (!patient) return;

  // dev fixture: 여기서 경로를 resolve해 upload_path에 저장(sample-detect/job이 그 경로를 재검증해 사용).
  let uploadPath: string | null = null;
  if (parse.data.fixtureClipName) {
    if (!config.video.fixtureMode) {
      res.status(400).json({ code: 'FIXTURE_MODE_OFF', error: 'fixtureClipName requires fixture mode' });
      return;
    }
    uploadPath = resolveFixtureClip(parse.data.fixtureClipName, config.video.fixtureDir);
    if (!uploadPath) {
      res.status(400).json({ code: 'INVALID_FIXTURE', error: 'fixtureClipName is not an allowlisted fixture clip' });
      return;
    }
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO video_analysis_clips (organization_id, patient_record_id, process_id, upload_path)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [session.organizationId, patient.id, parse.data.processId ?? null, uploadPath]
  );
  res.status(201).json({ clipId: rows[0].id });
}

// sample-detect = dev fixture 전용(§8.7, PR D2b). 대표 프레임 person box 후보를 실제 탐지.
async function sampleDetect(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  const clip = await loadAccessibleClip(pool, session, req.params.clipId, res);
  if (!clip) return;

  // fixture 없는 clip(=실제 업로드는 M3)에선 미지원 — 명시 거부(기존 mock 제거).
  if (!config.video.fixtureMode || !clip.uploadPath) {
    res.status(409).json({ code: 'SAMPLE_DETECT_UNAVAILABLE', error: 'sample-detect requires a fixture clip (dev only)' });
    return;
  }
  // DB upload_path는 신뢰 경계 밖 → basename을 allowlist 안에서 재검증(심층방어).
  const clipPath = resolveFixtureClip(path.basename(clip.uploadPath), config.video.fixtureDir);
  if (!clipPath) {
    res.status(409).json({ code: 'SAMPLE_DETECT_UNAVAILABLE', error: 'clip source is no longer an allowlisted fixture' });
    return;
  }

  const result = await runSampleDetect(clipPath); // SampleDetectResultSchema 검증 완료
  await pool.query(
    `UPDATE video_analysis_clips SET sample_detect_result = $2 WHERE id = $1`,
    [clip.clipId, JSON.stringify(result)]
  );
  res.status(200).json(result);
}

async function selectTarget(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  const parse = SelectTargetBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  const clip = await loadAccessibleClip(pool, session, req.params.clipId, res);
  if (!clip) return;

  // sample-detect 선행 필수.
  if (clip.sampleDetectResult == null) {
    res.status(409).json({ code: 'NO_SAMPLE_DETECT', error: 'run sample-detect before selecting a target' });
    return;
  }
  // DB JSONB는 신뢰 경계 밖 → 계약 검증 후 후보 id 존재 확인(위조 거부).
  const detect = SampleDetectResultSchema.safeParse(clip.sampleDetectResult);
  if (!detect.success) {
    res.status(500).json({ code: 'INVALID_SAMPLE_DETECT', error: 'stored sample-detect result is invalid' });
    return;
  }
  if (!detect.data.persons.some((p) => p.id === parse.data.targetPersonId)) {
    res.status(400).json({ code: 'INVALID_TARGET', error: 'targetPersonId is not among sample-detect candidates' });
    return;
  }

  await pool.query(
    `UPDATE video_analysis_clips SET target_person_id = $2 WHERE id = $1`,
    [clip.clipId, parse.data.targetPersonId]
  );
  res.status(200).json({ ok: true, clipId: clip.clipId, targetPersonId: parse.data.targetPersonId });
}

async function createJob(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  const parse = CreateJobBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  // patient_record_id/organization_id는 클라 body가 아니라 clip 조회로 채운다(denormalize 무결성).
  const clip = await loadAccessibleClip(pool, session, parse.data.clipId, res);
  if (!clip) return;

  // 큐 결정은 clip.upload_path로 일원화(fixture는 createClip에서 resolve·저장, PR D2b).
  //  - fixtureMode && clip.upload_path → 'queued'(워커가 실추론). 워커는 fixtureMode일 때만 등록 → 정체 방지.
  //  - 그 외 → 'review_pending' 셸(추론 없음, 적용 경로).
  const initialStatus = (config.video.fixtureMode && clip.uploadPath) ? 'queued' : 'review_pending';

  const { rows } = await pool.query<VideoJobRow>(
    `INSERT INTO video_analysis_jobs
       (organization_id, patient_record_id, clip_id, process_id, status, analysis_profile, requested_features)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      clip.organizationId, clip.patientRecordId, clip.clipId,
      parse.data.processId ?? null,
      initialStatus,
      parse.data.analysisProfile ?? null,
      JSON.stringify(parse.data.requestedFeatures ?? []),
    ]
  );
  void writeAuditLog(pool, {
    actorUserId: session.userId, actorOrgId: session.organizationId,
    action: 'video_analysis_submit', targetType: 'patient', targetId: clip.patientRecordId,
    outcome: 'success', ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null,
    extra: { jobId: rows[0].id, clipId: clip.clipId },
  });
  res.status(201).json(jobResponse(rows[0]));
}

async function getJob(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  const job = await loadAccessibleJob(pool, session, req.params.jobId, res);
  if (!job) return;
  res.status(200).json(jobResponse(job.row));
}

// patient_records 행(부분) — apply에서 사용.
interface PatientRowLite { id: string; revision: number; payload: unknown; created_at: Date; updated_at: Date; }

function patientApplyResponse(row: PatientRowLite): Record<string, unknown> {
  const base = typeof row.payload === 'object' && row.payload !== null
    ? (row.payload as Record<string, unknown>) : {};
  return {
    ...base,
    id: row.id,
    updatedAt: row.updated_at.toISOString(),
    sync: {
      serverId: row.id,
      revision: row.revision,
      syncStatus: 'synced',
      lastSyncedAt: row.updated_at.toISOString(),
    },
  };
}

// POST /jobs/:jobId/apply — If-Match 필수. 트랜잭션 순서(§8.12, Codex):
// ① job+patient FOR UPDATE → ② applied_at+동일 hash면 idempotent 반환
// → ③ If-Match revision 검사 → ④ payload 갱신·revision+1·job done·audit.
async function applyJob(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo as unknown as SessionInfo;
  if (session.organizationId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const ifMatch = req.headers['if-match'];
  const expectedRevision = typeof ifMatch === 'string' && /^\d+$/.test(ifMatch) ? Number(ifMatch) : null;
  if (!ifMatch) {
    res.status(400).json({ code: 'IF_MATCH_REQUIRED', error: 'If-Match header with current revision is required' });
    return;
  }
  if (expectedRevision === null || expectedRevision < 1) {
    res.status(400).json({ code: 'INVALID_IF_MATCH', error: 'If-Match must be a positive integer revision' });
    return;
  }

  const parse = ApplyBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  const { data, appliedInputsHash, appliedInputsCount, sourceAnalysisJobIds } = parse.data;

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    // ① job FOR UPDATE + 권한
    const { rows: jobs } = await client.query<VideoJobRow & { assigned_doctor_user_id: string | null }>(
      `SELECT j.*, p.assigned_doctor_user_id
       FROM video_analysis_jobs j
       JOIN patient_records p ON p.id = j.patient_record_id AND p.deleted_at IS NULL
       WHERE j.id = $1 AND j.organization_id = $2
       FOR UPDATE OF j`,
      [req.params.jobId, session.organizationId]
    );
    if (jobs.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ code: 'JOB_NOT_FOUND', error: 'Job not found' });
      return;
    }
    const job = jobs[0];
    if (!canAccess(session, job.assigned_doctor_user_id)) {
      await client.query('ROLLBACK');
      res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
      return;
    }

    // ② 멱등: 이미 적용 + 동일 hash면 저장된(현재) 환자 상태를 그대로 반환.
    if (job.applied_at && job.applied_inputs_hash === appliedInputsHash) {
      const { rows: cur } = await client.query<PatientRowLite>(
        `SELECT id, revision, payload, created_at, updated_at FROM patient_records
         WHERE id = $1 AND organization_id = $2`,
        [job.patient_record_id, session.organizationId]
      );
      await client.query('COMMIT');
      if (cur.length === 0) { res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' }); return; }
      res.status(200).json({ idempotent: true, patient: patientApplyResponse(cur[0]) });
      return;
    }

    // 상태 조건: review_pending에서만 적용 가능(error/expired/cancelled/done 거부).
    if (job.status !== 'review_pending') {
      await client.query('ROLLBACK');
      res.status(409).json({ code: 'JOB_NOT_APPLIABLE', error: `Job is '${job.status}', expected 'review_pending'`, status: job.status });
      return;
    }

    // sourceAnalysisJobIds 검증: 위조/타org/stale id + 적용 셸 job·실패/만료·결과없는 job 차단.
    // "실제 결과를 낸 per-process 분석 job"만 provenance/audit에 들어가게 한다 — result_features 보유 +
    // process_id 보유(셸 job 제외) + status review_pending|done(같은 직업 다중 feature는 done 가능) +
    // 현재 적용 셸 job(job.id) 자신은 제외. 상태는 review_pending/done만 허용(consume은 review_pending만 전이).
    const uniqueSourceIds = [...new Set(sourceAnalysisJobIds)];
    if (uniqueSourceIds.length > 0) {
      const { rows: srcRows } = await client.query<{ id: string }>(
        `SELECT id FROM video_analysis_jobs
         WHERE id = ANY($1) AND organization_id = $2 AND patient_record_id = $3
           AND result_features IS NOT NULL AND process_id IS NOT NULL
           AND status IN ('review_pending','done') AND id <> $4`,
        [uniqueSourceIds, session.organizationId, job.patient_record_id, job.id]
      );
      if (srcRows.length !== uniqueSourceIds.length) {
        await client.query('ROLLBACK');
        res.status(400).json({ code: 'INVALID_SOURCE_JOB', error: 'sourceAnalysisJobIds must reference completed analysis jobs of this patient' });
        return;
      }
    }

    // ③ patient FOR UPDATE + revision(If-Match)
    const { rows: pats } = await client.query<PatientRowLite>(
      `SELECT id, revision, payload, created_at, updated_at FROM patient_records
       WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [job.patient_record_id, session.organizationId]
    );
    if (pats.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
      return;
    }
    if (pats[0].revision !== expectedRevision) {
      await client.query('ROLLBACK');
      res.status(409).json({ code: 'CONFLICT', error: 'Revision mismatch. Fetch the latest version before retrying.', currentRevision: pats[0].revision });
      return;
    }

    // ④ payload 갱신(클라가 계산한 data 영속화 — 영상 apply는 meta 컬럼 불변).
    const existingPayload = typeof pats[0].payload === 'object' && pats[0].payload !== null
      ? (pats[0].payload as Record<string, unknown>) : {};
    const newPayload = { ...existingPayload, data };
    const newRevision = expectedRevision + 1;

    const { rows: updated } = await client.query<PatientRowLite>(
      `UPDATE patient_records SET payload = $3, revision = revision + 1
       WHERE id = $1 AND organization_id = $2 AND revision = $4 AND deleted_at IS NULL
       RETURNING id, revision, payload, created_at, updated_at`,
      [job.patient_record_id, session.organizationId, JSON.stringify(newPayload), expectedRevision]
    );
    if (updated.length === 0) {
      await client.query('ROLLBACK');
      res.status(409).json({ code: 'CONFLICT', error: 'Concurrent modification detected. Please retry.' });
      return;
    }

    await client.query(
      `UPDATE video_analysis_jobs
       SET status = 'done', applied_at = now(), applied_revision = $2, applied_inputs_hash = $3
       WHERE id = $1`,
      [job.id, newRevision, appliedInputsHash]
    );

    // 적용에 소비된 원본 분석 job(review_pending)을 done(consumed)으로 전이 — payload "적용함" ↔ DB 상태 정합.
    // 동일 org·동일 환자의 review_pending만 대상(권한·교차참조 방지). TTL sweep은 review_pending 미대상.
    if (uniqueSourceIds.length > 0) {
      await client.query(
        `UPDATE video_analysis_jobs
         SET status = 'done', applied_at = now(), applied_revision = $4
         WHERE id = ANY($1) AND organization_id = $2 AND patient_record_id = $3 AND status = 'review_pending'`,
        [uniqueSourceIds, session.organizationId, job.patient_record_id, newRevision]
      );
    }

    await client.query('COMMIT');

    void writeAuditLog(pool, {
      actorUserId: session.userId, actorOrgId: session.organizationId,
      action: 'video_analysis_apply', targetType: 'patient', targetId: job.patient_record_id,
      outcome: 'success', ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null,
      extra: {
        jobId: job.id, clipId: job.clip_id, appliedInputsCount: appliedInputsCount ?? null,
        appliedRevision: newRevision,
        sourceAnalysisJobIds, // 실제 추론 출처 추적(셸 jobId와 구분)
      },
    });
    res.status(200).json({ patient: patientApplyResponse(updated[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
export function createVideoAnalysisRouter(pool: Pool): Router {
  const router = Router();
  const auth = createAuthMiddleware(pool);

  // 피처플래그 fail-closed: 비활성 시 전 라우트 404(존재 누설 방지, PATIENT_NOT_FOUND 관례 일치).
  const flagGuard: RequestHandler = (_req, res, next) => {
    if (!config.videoAnalysisEnabled) {
      res.status(404).json({ code: 'NOT_FOUND', error: 'Not found' });
      return;
    }
    next();
  };

  const wrap = (fn: (p: Pool, req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response) => fn(pool, req, res).catch(() => res.status(500).json(internalError()));

  router.use(flagGuard);

  router.post('/clips', auth, csrfMiddleware, wrap(createClip));
  router.post('/clips/:clipId/sample-detect', auth, csrfMiddleware, wrap(sampleDetect));
  router.post('/clips/:clipId/select-target', auth, csrfMiddleware, wrap(selectTarget));
  router.post('/jobs', auth, csrfMiddleware, wrap(createJob));
  router.get('/jobs/:jobId', auth, wrap(getJob));
  router.post('/jobs/:jobId/apply', auth, csrfMiddleware, wrap(applyJob));

  return router;
}
