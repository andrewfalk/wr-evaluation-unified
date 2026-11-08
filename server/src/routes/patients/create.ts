// POST /api/patients — create or idempotent upsert (S7 service unit: upsert).
// Split out of routes/patients.ts (S5 P1-29); handler bodies unchanged.
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { PatientIdentityConflictError, PatientPersonVanishedError, resolvePatientPersonId, type QueryRunner } from '../../db/patientPersons';
import { nextCompletionColumns, DRAFT_COMPLETION_COLUMNS, verifyModulesComplete, logCompletionMismatchIfAny, nextVerificationColumns, DRAFT_VERIFICATION_COLUMNS } from '../../completionTracking';
import { resolveAssignedDoctor } from '../../db/resolveAssignedDoctor';
import { orgIdOf, sessionOf } from '../../http/authz';
import { CreateBody, PatientRow, SELECT_COLS } from './schemas';
import { strOrNull, isUniqueViolation, uniqueConflictResponse, identityConflictResponse, personVanishedResponse, extractMeta, normalizePatientDates, invalidBirthDateResponse, toResponse } from './shared';

// ---------------------------------------------------------------------------
// POST /api/patients
// Requires Idempotency-Key header.
//
// All DB work (slot reservation, patient INSERT, idempotency finalization) runs
// in a single transaction so a crash or error automatically rolls back the slot,
// letting the client retry with the same key. Expired slots are pruned inside
// the transaction so they never block a fresh retry.
// ---------------------------------------------------------------------------
export async function createPatient(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const orgId   = orgIdOf(req);

  const idempKey = typeof req.headers['idempotency-key'] === 'string'
    ? req.headers['idempotency-key'].trim() : null;

  if (!idempKey) {
    res.status(400).json({ code: 'IDEMPOTENCY_KEY_REQUIRED', error: 'Idempotency-Key header is required' });
    return;
  }

  // Validate body before touching the DB so a bad request never reserves a slot.
  const parse = CreateBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }

  const {
    id: clientId, phase, createdAt, data: rawData,
    modulesCompleteObserved, completionClientBuildVersion, completionClientSchemaVersion,
  } = parse.data;

  // DB를 건드리기 전에 검증 — 잘못된 날짜가 payload와 DATE 컬럼 어디에도 남지 않게.
  const dates = normalizePatientDates(rawData as Record<string, unknown>);
  if (!dates.ok) {
    res.status(400).json(invalidBirthDateResponse(dates.failures));
    return;
  }
  const data = dates.data;
  const meta = extractMeta(data);

  if (!meta.name) {
    res.status(400).json({ code: 'NAME_REQUIRED', error: 'Patient name (data.shared.name) is required' });
    return;
  }

  const patientId = clientId ?? randomUUID();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Prune any expired slot for this key so an expired key is always retryable.
    await client.query(
      `DELETE FROM idempotency_keys WHERE key = $1 AND user_id = $2 AND expires_at <= now()`,
      [idempKey, session.userId]
    );

    // Reserve the slot. ON CONFLICT DO NOTHING: only one concurrent request wins.
    const reserve = await client.query(
      `INSERT INTO idempotency_keys (key, user_id, org_id, status, body)
       VALUES ($1,$2,$3,0,'null'::jsonb)
       ON CONFLICT (key, user_id) DO NOTHING`,
      [idempKey, session.userId, orgId]
    );

    if ((reserve.rowCount ?? 0) === 0) {
      // A non-expired slot exists. Read it before rolling back the transaction.
      const { rows: existing } = await client.query<{ status: number; body: unknown }>(
        `SELECT status, body FROM idempotency_keys WHERE key = $1 AND user_id = $2`,
        [idempKey, session.userId]
      );
      await client.query('ROLLBACK');

      if (existing.length === 0 || existing[0].status === 0) {
        // Another in-flight transaction holds the slot (uncommitted, so invisible
        // to our SELECT) or just committed a status=0 row — both mean in-progress.
        res.status(409).json({ code: 'IDEMPOTENCY_IN_PROGRESS', error: 'A request with this Idempotency-Key is already in progress. Please retry shortly.' });
        return;
      }
      // Completed response — replay it.
      res.status(existing[0].status as number).json(existing[0].body);
      return;
    }

    // We own the slot. All remaining work is inside the same transaction so any
    // failure triggers a ROLLBACK that also removes the slot, keeping the key free.
    const doctorName = strOrNull(
      (data.shared as Record<string, unknown>)?.['doctorName']
    );
    const { assignedDoctorUserId, assignedDoctorName, assignmentWarnings } = await resolveAssignedDoctor(
      client as unknown as QueryRunner,
      { orgId, currentUser: { id: session.userId, role: session.role, name: session.name }, requestedDoctorName: doctorName }
    );

    // If the server resolved a doctor but the payload carried no doctorName,
    // fill it in so the stored payload matches the DB FK.
    let resolvedData = data as Record<string, unknown>;
    if (assignedDoctorName && !doctorName) {
      resolvedData = {
        ...resolvedData,
        shared: { ...(resolvedData['shared'] as Record<string, unknown>), doctorName: assignedDoctorName },
      };
    }
    const storedPayload = { id: patientId, phase, createdAt: createdAt ?? new Date().toISOString(), data: resolvedData };

    const { personId, warnings } = await resolvePatientPersonId(client as QueryRunner, orgId, meta);

    await client.query(
      `INSERT INTO patient_records
         (id, organization_id, patient_person_id, owner_user_id, assigned_doctor_user_id,
          name, patient_no, birth_date, injury_date, evaluation_date,
          active_modules, diagnoses_codes, jobs_names, revision, payload,
          completion_status, server_observed_modules_complete_at, completion_source,
          completion_client_build_version, completion_client_schema_version,
          server_verified_modules_complete_at, completion_verification_engine_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        patientId, orgId, personId, session.userId, assignedDoctorUserId,
        meta.name, meta.patientNo,
        meta.birthDate, meta.injuryDate, meta.evaluationDate,
        meta.activeModules, meta.diagnosesCodes, meta.jobsNames,
        JSON.stringify(storedPayload),
        ...(() => {
          // 신규 행이라 "보존할 이전 값"이 없다 — 초기값(전부 NULL/draft)에서 시작해 계산.
          const c = nextCompletionColumns(
            DRAFT_COMPLETION_COLUMNS,
            { modulesCompleteObserved, completionClientBuildVersion, completionClientSchemaVersion }
          );
          return [c.completion_status, c.server_observed_modules_complete_at, c.completion_source, c.completion_client_build_version, c.completion_client_schema_version];
        })(),
        ...(() => {
          // PR0-B2: 클라이언트 신고와 무관하게 서버가 독립적으로(analytics-core) 완료를
          // 재검증한다. 신규 행이라 "보존할 이전 값"이 없다 — DRAFT에서 시작.
          const verified = verifyModulesComplete({
            shared: (resolvedData['shared'] as Record<string, unknown>) ?? {},
            modules: (resolvedData['modules'] as Record<string, unknown>) ?? {},
            activeModules: (resolvedData['activeModules'] as string[]) ?? [],
          });
          logCompletionMismatchIfAny(patientId, modulesCompleteObserved, verified);
          const v = nextVerificationColumns(DRAFT_VERIFICATION_COLUMNS, verified.allComplete);
          return [v.server_verified_modules_complete_at, v.completion_verification_engine_version];
        })(),
      ]
    );

    const { rows: newRows } = await client.query<PatientRow>(
      `SELECT ${SELECT_COLS} FROM patient_records WHERE id = $1`,
      [patientId]
    );

    const body = toResponse(newRows[0], warnings, assignmentWarnings);

    await client.query(
      `UPDATE idempotency_keys SET status = $3, body = $4
       WHERE key = $1 AND user_id = $2`,
      [idempKey, session.userId, 201, JSON.stringify(body)]
    );

    await client.query('COMMIT');
    res.status(201).json(body);
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {});
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
