// POST /jobs/:jobId/apply — persist analysis results into the patient record (If-Match).
// Split out of routes/videoAnalysis.ts (S5 P1-30); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import config from '../../config';
import { writeAuditLog } from '../../middleware/audit';
import type { AnalysisRecipe } from '@wr/contracts';
import { validateAppliedRecipes } from '../../workers/recipeValidation';
import { isAssignedOrAdmin } from '../../db/patientLocks';
import { toQueryRunner } from '../../db/queryRunner';
import { selectAnyState, type PatientRow } from '../../db/patientRecordsRepo';
import { applyVideoAnalysisInTx } from '../../domain/patients/patientRecordsService';
import { lockOf } from '../../http/lockToken';
import { patientWriteContextOf } from '../../http/patientWriteContext';
import { lockHeldResponse } from '../../http/lockGate';
import { orgIdOf, sessionOf } from '../../http/authz';
import { ApplyBody } from './schemas';
import { VideoJobRow, parseStoredRecipe, readAppliedInputs } from './access';

// patient_records 행(부분) — apply에서 사용(db/patientRecordsRepo.ts).
type PatientRowLite = PatientRow;

function patientApplyResponse(row: PatientRowLite): Record<string, unknown> {
  const base = typeof row.payload === 'object' && row.payload !== null
    ? (row.payload as Record<string, unknown>) : {};
  return {
    ...base,
    id: row.id,
    updatedAt: row.updated_at.toISOString(),
    completionStatus: row.completion_status,
    serverObservedModulesCompleteAt: row.server_observed_modules_complete_at?.toISOString() ?? null,
    serverVerifiedModulesCompleteAt: row.server_verified_modules_complete_at?.toISOString() ?? null,
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
export async function applyJob(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const orgId = orgIdOf(req);

  const { ifMatch: expectedRevision } = lockOf(req); // requireLockToken() on the route (S4 / P1-18)

  const parse = ApplyBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  const {
    data, appliedInputsHash, appliedInputsCount, sourceAnalysisJobIds,
    modulesCompleteObserved, completionClientBuildVersion, completionClientSchemaVersion,
  } = parse.data;

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
      [req.params.jobId, orgId]
    );
    if (jobs.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ code: 'JOB_NOT_FOUND', error: 'Job not found' });
      return;
    }
    const job = jobs[0];
    if (!isAssignedOrAdmin(session, job.assigned_doctor_user_id)) {
      await client.query('ROLLBACK');
      res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
      return;
    }

    // ② 멱등: 이미 적용 + 동일 hash면 저장된(현재) 환자 상태를 그대로 반환.
    if (job.applied_at && job.applied_inputs_hash === appliedInputsHash) {
      const cur = await selectAnyState(toQueryRunner(client), job.patient_record_id, orgId);
      await client.query('COMMIT');
      if (!cur) { res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' }); return; }
      res.status(200).json({ idempotent: true, patient: patientApplyResponse(cur) });
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
    // 같은 SELECT에서 저장 recipe도 가져온다(추가 쿼리 없이 recipe 검증의 source of truth 확보).
    const sourceRecipes = new Map<string, AnalysisRecipe | null>();
    if (uniqueSourceIds.length > 0) {
      const { rows: srcRows } = await client.query<{ id: string; analysis_recipe: unknown }>(
        `SELECT id, analysis_recipe FROM video_analysis_jobs
         WHERE id = ANY($1) AND organization_id = $2 AND patient_record_id = $3
           AND result_features IS NOT NULL AND process_id IS NOT NULL
           AND status IN ('review_pending','done') AND id <> $4`,
        [uniqueSourceIds, orgId, job.patient_record_id, job.id]
      );
      if (srcRows.length !== uniqueSourceIds.length) {
        await client.query('ROLLBACK');
        res.status(400).json({ code: 'INVALID_SOURCE_JOB', error: 'sourceAnalysisJobIds must reference completed analysis jobs of this patient' });
        return;
      }
      for (const r of srcRows) sourceRecipes.set(r.id, parseStoredRecipe(r.analysis_recipe));
    }

    // ③④ patient FOR UPDATE → 담당의 재확인 → 락 게이트 → revision(If-Match) → recipe 검증 → UPDATE
    // (domain/patients/applyVideoAnalysis.ts, S7-2). 결과마다 이전과 같은 응답을 쓴다.
    const result = await applyVideoAnalysisInTx(toQueryRunner(client), pool, patientWriteContextOf(req), {
      patientId: job.patient_record_id,
      expectedRevision,
      data,
      report: { modulesCompleteObserved, completionClientBuildVersion, completionClientSchemaVersion },
      // recipe 검증 게이트(§8.11, 6.0-9) — payload 무수정, 대조만. 서버가 source of truth.
      // 새로 추가된 appliedInputs(suffix)만 검증: count·prefix 불변·exact-set·recipe field 대조·unverified fail-closed.
      validate: (existingPayload) => validateAppliedRecipes({
        oldAppliedInputs: readAppliedInputs((existingPayload as { data?: unknown }).data),
        newAppliedInputs: readAppliedInputs(data),
        appliedInputsCount,
        sourceAnalysisJobIds: uniqueSourceIds,
        sourceRecipes,
        allowUnverified: config.video.allowUnverifiedRecipe,
      }),
    });
    if (result.kind !== 'applied') {
      await client.query('ROLLBACK');
      switch (result.kind) {
        case 'patient_not_found':
          res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
          return;
        case 'forbidden':
          res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
          return;
        case 'lock_held':
          res.status(423).json(lockHeldResponse(result.heldBy));
          return;
        case 'revision_mismatch':
          res.status(409).json({ code: 'CONFLICT', error: 'Revision mismatch. Fetch the latest version before retrying.', currentRevision: result.currentRevision });
          return;
        case 'rejected':
          res.status(400).json(result.body);
          return;
        case 'concurrent_modification':
          res.status(409).json({ code: 'CONFLICT', error: 'Concurrent modification detected. Please retry.' });
          return;
      }
    }
    const newRevision = expectedRevision + 1;

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
        [uniqueSourceIds, orgId, job.patient_record_id, newRevision]
      );
    }

    await client.query('COMMIT');

    void writeAuditLog(pool, {
      actorUserId: session.userId, actorOrgId: orgId,
      action: 'video_analysis_apply', targetType: 'patient', targetId: job.patient_record_id,
      outcome: 'success', ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null,
      extra: {
        jobId: job.id, clipId: job.clip_id, appliedInputsCount: appliedInputsCount ?? null,
        appliedRevision: newRevision,
        sourceAnalysisJobIds, // 실제 추론 출처 추적(셸 jobId와 구분)
      },
    });
    res.status(200).json({ patient: patientApplyResponse(result.row) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
