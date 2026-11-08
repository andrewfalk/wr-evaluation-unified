// PATCH /api/patients/:id (S7 service unit: patch).
// Split out of routes/patients.ts (S5 P1-29); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { PatientIdentityConflictError, PatientPersonVanishedError, resolvePatientPersonId, releasePersonIfOrphaned, type QueryRunner } from '../../db/patientPersons';
import { nextCompletionColumns, verifyModulesComplete, logCompletionMismatchIfAny, nextVerificationColumns } from '../../completionTracking';
import { assertAssignedOrAdmin, PatientLockForbiddenError } from '../../db/patientLocks';
import { lockOf } from '../../http/lockToken';
import { evaluateLockGate } from '../../http/lockGate';
import { orgIdOf, sessionOf } from '../../http/authz';
import { PatchBody, PatientRow, SELECT_COLS } from './schemas';
import { isUniqueViolation, uniqueConflictResponse, identityConflictResponse, personVanishedResponse, extractMeta, normalizePatientDates, invalidBirthDateResponse, toResponse } from './shared';

// ---------------------------------------------------------------------------
// PATCH /api/patients/:id
// Requires If-Match: <revision> header. Returns 409 on mismatch.
// ---------------------------------------------------------------------------
export async function patchPatient(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const orgId   = orgIdOf(req);
  const { id }  = req.params;

  const { ifMatch: expectedRevision } = lockOf(req); // requireLockToken() on the route (S4 / P1-18)

  const parse = PatchBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE — 이 트랜잭션 동안 patient_records 행을 앵커로 잡아, force-takeover 등
    // patient_locks에 대한 다른 트랜잭션의 변경이 이 트랜잭션이 끝날 때까지 끼어들 수 없게 한다.
    const { rows: current } = await client.query<PatientRow>(
      `SELECT ${SELECT_COLS}
       FROM patient_records
       WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [id, orgId]
    );

    if (current.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
      return;
    }

    // assignedDoctorOrAdmin 미들웨어는 이 트랜잭션 밖에서(그리고 FOR UPDATE 없이) 담당의를
    // 확인했다 — 그 확인과 지금 사이에 관리자가 다른 의사로 재배정했을 수 있으므로, 앵커를
    // 이미 쥔 이 시점에 최신 담당의로 다시 확인한다(최종 권한 방어선).
    assertAssignedOrAdmin({ id: current[0].id, assignedDoctorUserId: current[0].assigned_doctor_user_id }, session);

    if (current[0].revision !== expectedRevision) {
      await client.query('ROLLBACK');
      res.status(409).json({
        code:            'CONFLICT',
        error:           'Revision mismatch. Fetch the latest version before retrying.',
        currentRevision: current[0].revision,
      });
      return;
    }

    const lockBlock = await evaluateLockGate(pool, client as QueryRunner, req, id, orgId);
    if (lockBlock) {
      await client.query('ROLLBACK');
      res.status(lockBlock.status).json(lockBlock.body);
      return;
    }

    const { phase, data, modulesCompleteObserved, completionClientBuildVersion, completionClientSchemaVersion } = parse.data;

    const existingPayload = typeof current[0].payload === 'object' && current[0].payload !== null
      ? (current[0].payload as Record<string, unknown>) : {};

    const newPayload: Record<string, unknown> = {
      ...existingPayload,
      ...(phase !== undefined ? { phase }  : {}),
      ...(data  !== undefined ? { data }   : {}),
    };

    const rawMergedData = typeof newPayload['data'] === 'object' && newPayload['data'] !== null
      ? (newPayload['data'] as Record<string, unknown>) : {};

    // POST와 동일하게 서버가 독립적으로 검증·정규화한다. 정규화된 값은 아래에서
    // DB DATE 컬럼(meta)과 payload(newPayload['data']) 양쪽에 함께 반영된다.
    const dates = normalizePatientDates(rawMergedData);
    if (!dates.ok) {
      await client.query('ROLLBACK');
      res.status(400).json(invalidBirthDateResponse(dates.failures));
      return;
    }
    const mergedData = dates.data;
    newPayload['data'] = mergedData;
    const meta = extractMeta(mergedData);

    if (!meta.name) {
      await client.query('ROLLBACK');
      res.status(400).json({ code: 'NAME_REQUIRED', error: 'Patient name (data.shared.name) is required' });
      return;
    }

    const { personId, warnings } = await resolvePatientPersonId(client as QueryRunner, orgId, meta, current[0].patient_person_id);

    // PR0-A: 완료 필드는 이미 FOR UPDATE로 잠근 current[0]을 기준으로 계산해 같은
    // UPDATE 문장에 얹는다 — 별도 SQL 분기가 없으므로 revision 충돌 시 완료 보고도
    // 자동으로 함께 거부된다(아래 WHERE revision = $13이 0행이면 완료 필드도 반영 안 됨).
    const nextCompletion = nextCompletionColumns(current[0], {
      modulesCompleteObserved, completionClientBuildVersion, completionClientSchemaVersion,
    });

    // PR0-B2: 클라이언트 신고와 별개로 서버가 analytics-core로 직접 재검증한다 — 같은
    // revision 잠금 하에 같은 UPDATE 문장에 얹으므로 위와 동일한 동시성 보장을 받는다.
    const verified = verifyModulesComplete({
      shared: (mergedData['shared'] as Record<string, unknown>) ?? {},
      modules: (mergedData['modules'] as Record<string, unknown>) ?? {},
      activeModules: (mergedData['activeModules'] as string[]) ?? [],
    });
    logCompletionMismatchIfAny(id, modulesCompleteObserved, verified);
    const nextVerification = nextVerificationColumns(current[0], verified.allComplete);

    // WHERE clause includes revision to catch concurrent modification between read and write.
    const { rows: updated } = await client.query<PatientRow>(
      `UPDATE patient_records SET
         patient_person_id = $3,
         name              = $4,
         patient_no        = $5,
         birth_date        = $6,
         injury_date       = $7,
         evaluation_date   = $8,
         active_modules    = $9,
         diagnoses_codes   = $10,
         jobs_names        = $11,
         revision          = revision + 1,
         payload           = $12,
         completion_status                   = $14,
         server_observed_modules_complete_at = $15,
         completion_source                   = $16,
         completion_client_build_version     = $17,
         completion_client_schema_version    = $18,
         server_verified_modules_complete_at    = $19,
         completion_verification_engine_version = $20
       WHERE id = $1 AND organization_id = $2 AND revision = $13 AND deleted_at IS NULL
       RETURNING ${SELECT_COLS}`,
      [
        id, orgId, personId,
        meta.name, meta.patientNo,
        meta.birthDate, meta.injuryDate, meta.evaluationDate,
        meta.activeModules, meta.diagnosesCodes, meta.jobsNames,
        JSON.stringify(newPayload),
        expectedRevision,
        nextCompletion.completion_status,
        nextCompletion.server_observed_modules_complete_at,
        nextCompletion.completion_source,
        nextCompletion.completion_client_build_version,
        nextCompletion.completion_client_schema_version,
        nextVerification.server_verified_modules_complete_at,
        nextVerification.completion_verification_engine_version,
      ]
    );

    if (updated.length === 0) {
      await client.query('ROLLBACK');
      res.status(409).json({
        code:  'CONFLICT',
        error: 'Concurrent modification detected. Please retry.',
      });
      return;
    }

    // 등록번호를 바꾸면(OLD-001 → NEW-001, 또는 빈 값으로) 이 record는 새 person에 붙고
    // 옛 person은 참조가 사라진다. 해제하지 않으면 그 person이 계속 활성 상태로
    // (organization_id, patient_no)를 점유해 삭제 때와 똑같은 "유령 등록번호"가 된다.
    // 같은 트랜잭션 안에서 정리해야 부분 성공이 남지 않는다.
    const previousPersonId = current[0].patient_person_id;
    if (previousPersonId && previousPersonId !== personId) {
      await releasePersonIfOrphaned(client as QueryRunner, previousPersonId, orgId);
    }

    await client.query('COMMIT');
    res.status(200).json(toResponse(updated[0], warnings));
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof PatientLockForbiddenError) {
      res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
      return;
    }
    if (err instanceof PatientIdentityConflictError) {
      res.status(409).json(identityConflictResponse());
      return;
    }
    if (err instanceof PatientPersonVanishedError) {
      res.status(409).json(personVanishedResponse());
      return;
    }
    if (isUniqueViolation(err)) {
      res.status(409).json(uniqueConflictResponse(err));
      return;
    }
    throw err;
  } finally {
    client.release();
  }
}
