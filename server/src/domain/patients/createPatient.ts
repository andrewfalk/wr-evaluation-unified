// POST /api/patients — create, idempotent on the Idempotency-Key (S7-3). Moved from
// routes/patients/create.ts; statements, their order and the outcomes are unchanged.
//
// All DB work (slot reservation, patient INSERT, idempotency finalization) runs in a single transaction
// so a crash or error automatically rolls back the slot, letting the client retry with the same key.
// Expired slots are pruned inside the transaction so they never block a fresh retry.
//
// The response body is stored in the slot inside the transaction, so the route passes its response
// builder in as `buildBody` (domain/ does not import routes/).
import type { Pool } from 'pg';
import { PatientIdentityConflictError, PatientPersonVanishedError, resolvePatientPersonId, type PatientPersonWarning } from '../../db/patientPersons';
import { isUniqueViolation, type PgErrorLike } from '../../db/pgErrors';
import { toQueryRunner } from '../../db/queryRunner';
import { withDecidedTransaction } from '../../db/withWriteTransaction';
import { insertFromCreate, selectById, type PatientRow } from '../../db/patientRecordsRepo';
import { resolveAssignedDoctor, type AssignmentWarning } from '../../db/resolveAssignedDoctor';
import { nextCompletionColumns, DRAFT_COMPLETION_COLUMNS, verifyModulesComplete, logCompletionMismatchIfAny, nextVerificationColumns, DRAFT_VERIFICATION_COLUMNS } from '../../completionTracking';
import type { PatientWriteContext } from './context';
import { strOrNull, type ExtractedMeta } from './meta';

export type CreatePatientResult =
  | { kind: 'created'; body: Record<string, unknown> }
  /** The key's earlier completed response, answered again as is. */
  | { kind: 'replayed'; status: number; body: unknown }
  | { kind: 'idempotency_in_progress' }
  | { kind: 'identity_conflict' }
  | { kind: 'person_vanished' }
  /** 23505: the id or (for a new person) the patient number exists. */
  | { kind: 'unique_conflict'; error: PgErrorLike };

export interface CreatePatientParams {
  idempotencyKey: string;
  patientId: string;
  phase: unknown;
  createdAt: string | undefined;
  /** Dates already normalised (normalizePatientDates). */
  data: Record<string, unknown>;
  meta: ExtractedMeta;
  report: { modulesCompleteObserved?: boolean; completionClientBuildVersion?: string; completionClientSchemaVersion?: number };
  buildBody: (row: PatientRow, warnings: PatientPersonWarning[], assignmentWarnings: AssignmentWarning[]) => Record<string, unknown>;
}

export async function createPatient(pool: Pool, ctx: PatientWriteContext, params: CreatePatientParams): Promise<CreatePatientResult> {
  const { idempotencyKey: idempKey, patientId, phase, createdAt, data, meta, report } = params;
  const orgId = ctx.orgId;
  const userId = ctx.actor.userId;
  try {
    return await withDecidedTransaction<CreatePatientResult>(pool, async (client) => {
      const db = toQueryRunner(client);

      // Prune any expired slot for this key so an expired key is always retryable.
      await db.query(
        `DELETE FROM idempotency_keys WHERE key = $1 AND user_id = $2 AND expires_at <= now()`,
        [idempKey, userId]
      );

      // Reserve the slot. ON CONFLICT DO NOTHING: only one concurrent request wins.
      const reserve = await db.query(
        `INSERT INTO idempotency_keys (key, user_id, org_id, status, body)
         VALUES ($1,$2,$3,0,'null'::jsonb)
         ON CONFLICT (key, user_id) DO NOTHING`,
        [idempKey, userId, orgId]
      );

      if ((reserve.rowCount ?? 0) === 0) {
        // A non-expired slot exists. Read it before rolling back the transaction.
        const { rows: existing } = await db.query<{ status: number; body: unknown }>(
          `SELECT status, body FROM idempotency_keys WHERE key = $1 AND user_id = $2`,
          [idempKey, userId]
        );
        if (existing.length === 0 || existing[0].status === 0) {
          // Another in-flight transaction holds the slot (uncommitted, so invisible
          // to our SELECT) or just committed a status=0 row — both mean in-progress.
          return { commit: false, value: { kind: 'idempotency_in_progress' } };
        }
        // Completed response — replay it.
        return { commit: false, value: { kind: 'replayed', status: existing[0].status as number, body: existing[0].body } };
      }

      // We own the slot. All remaining work is inside the same transaction so any
      // failure triggers a ROLLBACK that also removes the slot, keeping the key free.
      const doctorName = strOrNull(
        (data.shared as Record<string, unknown>)?.['doctorName']
      );
      const { assignedDoctorUserId, assignedDoctorName, assignmentWarnings } = await resolveAssignedDoctor(
        db,
        { orgId, currentUser: { id: userId, role: ctx.actor.role, name: ctx.actor.name }, requestedDoctorName: doctorName }
      );

      // If the server resolved a doctor but the payload carried no doctorName,
      // fill it in so the stored payload matches the DB FK.
      let resolvedData = data;
      if (assignedDoctorName && !doctorName) {
        resolvedData = {
          ...resolvedData,
          shared: { ...(resolvedData['shared'] as Record<string, unknown>), doctorName: assignedDoctorName },
        };
      }
      const storedPayload = { id: patientId, phase, createdAt: createdAt ?? new Date().toISOString(), data: resolvedData };

      const { personId, warnings } = await resolvePatientPersonId(db, orgId, meta);

      // 신규 행이라 "보존할 이전 값"이 없다 — 초기값(전부 NULL/draft)에서 시작해 계산.
      const completion = nextCompletionColumns(DRAFT_COMPLETION_COLUMNS, report);
      // PR0-B2: 클라이언트 신고와 무관하게 서버가 독립적으로(analytics-core) 완료를
      // 재검증한다. 신규 행이라 "보존할 이전 값"이 없다 — DRAFT에서 시작.
      const verified = verifyModulesComplete({
        shared: (resolvedData['shared'] as Record<string, unknown>) ?? {},
        modules: (resolvedData['modules'] as Record<string, unknown>) ?? {},
        activeModules: (resolvedData['activeModules'] as string[]) ?? [],
      });
      logCompletionMismatchIfAny(patientId, report.modulesCompleteObserved, verified);
      const verification = nextVerificationColumns(DRAFT_VERIFICATION_COLUMNS, verified.allComplete);

      await insertFromCreate(db, {
        id: patientId, orgId, personId, ownerUserId: userId, assignedDoctorUserId, meta,
        payloadJson: JSON.stringify(storedPayload), completion, verification,
      });

      const row = await selectById(db, patientId);
      const body = params.buildBody(row!, warnings, assignmentWarnings);

      await db.query(
        `UPDATE idempotency_keys SET status = $3, body = $4
         WHERE key = $1 AND user_id = $2`,
        [idempKey, userId, 201, JSON.stringify(body)]
      );

      return { commit: true, value: { kind: 'created', body } };
    });
  } catch (err: unknown) {
    if (err instanceof PatientIdentityConflictError) return { kind: 'identity_conflict' };
    if (err instanceof PatientPersonVanishedError) return { kind: 'person_vanished' };
    if (isUniqueViolation(err)) return { kind: 'unique_conflict', error: err };
    throw err;
  }
}
