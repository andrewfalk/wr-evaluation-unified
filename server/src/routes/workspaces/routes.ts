// Workspace handlers: list, read, save, delete.
// Split out of routes/workspaces.ts (S5 P1-31); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { writeAuditLog } from '../../middleware/audit';
import type { QueryRunner } from '../../db/patientPersons';
import { orgIdOf, sessionOf } from '../../http/authz';
import { SaveBody, WorkspaceRow, extractPatientIds, loadDeletedPatientIds, redactDeletedPatients, PatientMeta, extractPatientMeta, normalizeWorkspacePatients } from './normalize';
import { upsertFromWorkspace, type SkipReason, type UpsertOutcome } from '../../domain/patients/patientRecordsService';
import { patientWriteContextOf } from '../../http/patientWriteContext';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function toItem(row: WorkspaceRow) {
  const patients = Array.isArray(row.snapshot_payload) ? row.snapshot_payload : [];
  return {
    id:      row.id,
    name:    row.name,
    count:   patients.length,
    savedAt: row.created_at.toISOString(),
    patients,
  };
}

async function listQuery(pool: Pool, orgId: string, userId: string): Promise<WorkspaceRow[]> {
  const { rows } = await pool.query<WorkspaceRow>(
    `SELECT id, name, created_at, patient_ids, snapshot_payload
     FROM workspaces
     WHERE organization_id = $1 AND owner_user_id = $2
     ORDER BY created_at DESC`,
    [orgId, userId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// GET /api/workspaces
// ---------------------------------------------------------------------------
export async function listWorkspaces(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const orgId   = session.organizationId;

  // Superadmin (null org) has no org-scoped workspace bucket. Not requireOrg(): a null org answers
  // 200 with an empty list, not 403.
  if (orgId === null) {
    res.status(200).json({ items: [] });
    return;
  }

  const rows = await listQuery(pool, orgId, session.userId);
  res.status(200).json({ items: rows.map(toItem) });
}

// ---------------------------------------------------------------------------
// GET /api/workspaces/:id
// Default: snapshot_payload (frozen at save time)
// ?view=current: re-fetch live patient records by patient_ids
// ---------------------------------------------------------------------------
export async function getWorkspace(pool: Pool, req: Request, res: Response): Promise<void> {
  const session   = sessionOf(req);
  const orgId     = orgIdOf(req);
  const { id }    = req.params;
  const isCurrent = req.query['view'] === 'current';

  const { rows } = await pool.query<WorkspaceRow>(
    `SELECT id, name, created_at, patient_ids, snapshot_payload
     FROM workspaces
     WHERE id = $1 AND organization_id = $2 AND owner_user_id = $3`,
    [id, orgId, session.userId]
  );

  if (rows.length === 0) {
    res.status(404).json({ code: 'WORKSPACE_NOT_FOUND', error: 'Workspace not found' });
    return;
  }

  const row = rows[0];

  if (!isCurrent) {
    res.status(200).json(toItem(row));
    return;
  }

  // ?view=current — load latest payloads from patient_records.
  // IDs not found in patient_records (deleted patients) are returned as
  // { id, redacted: true } stubs; the UI grays these out with a notice.
  const patientIds: string[] = row.patient_ids ?? [];
  let currentPatients: unknown[];

  if (patientIds.length === 0) {
    currentPatients = [];
  } else {
    interface PatientRecordRow { id: string; deleted_at: Date | null; payload: unknown; }
    const { rows: prRows } = await pool.query<PatientRecordRow>(
      `SELECT id, deleted_at, payload
       FROM patient_records
       WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
      [patientIds, orgId]
    );

    const found = new Map(prRows.map((r) => [r.id, r]));
    currentPatients = patientIds.map((pid) => {
      const rec = found.get(pid);
      // Deleted (soft-delete) or never-migrated patient → redacted stub
      if (!rec || rec.deleted_at !== null) return { id: pid, redacted: true };
      return rec.payload;
    });
  }

  res.status(200).json({
    id:       row.id,
    name:     row.name,
    count:    patientIds.length,
    savedAt:  row.created_at.toISOString(),
    patients: currentPatients,
    view:     'current',
  });
}

// ---------------------------------------------------------------------------
// POST /api/workspaces
// Body: { name, patients }
// Stores snapshot AND upserts patient_records so ?view=current works immediately.
// patient_records upserts are best-effort — failures are logged but do not block
// the workspace save; the snapshot remains the primary source of truth.
// ---------------------------------------------------------------------------
// 환자별 저장 결과 — 클라이언트(applyWorkspaceSaveAck)가 sync 메타·충돌 표시·알림에 쓴다.
interface WorkspaceSaveAck {
  saved:         Array<{ id: string; revision: number; assignedDoctorUserId: string | null }>;
  skipped:       Array<{ id: string; reason: SkipReason }>;
  conflicts:     Array<{ id: string; serverRevision: number }>;
  lockedByOther: Array<{ id: string; holder: unknown }>;
}

// 저장된 환자의 스냅샷 사본에 서버가 확정한 revision·담당의를 찍는다. 클라이언트가 이 저장 항목을 불러올 때
// "서버와 같은 상태(synced)"로 복원돼야, 이후 저장이 자기 저장과 충돌하지 않고 편집 권한도 유지된다.
//
// 요청 시작 때 들고 있던 스냅샷을 통째로 다시 쓰면 안 된다 — 그 사이 일어난 일을 덮어쓴다:
//  (a) 환자 삭제가 스냅샷의 해당 항목을 { id, redacted: true }로 가렸다면, 옛 사본을 다시 쓰면 이름 등 PHI가 되살아난다.
//  (b) 같은 저장 항목에 더 나중 저장이 끝났다면, 이름·patient_ids는 나중 것인데 payload만 이쪽 것이 되는 불일치가 생긴다.
// 그래서 한 문장 안에서 "현재 저장된 값"을 읽어 계산하고(UPDATE는 잠금 대기 후 최신 행으로 SET을 다시 평가한다),
//  - 가려진 항목(redacted)은 건드리지 않고, 저장된 환자 항목의 sync/담당의 필드만 덮어쓰며,
//  - created_at이 이 요청이 기록한 값($5)과 같을 때만, 즉 아직 내가 기록한 저장본일 때만 적용한다.
// $1: [{ id, revision, assigned }] — 저장된 환자의 서버 id·확정 revision·담당의
const STAMP_SAVED_SNAPSHOT_SQL = `
  UPDATE workspaces
  SET snapshot_payload = (
    SELECT COALESCE(jsonb_agg(
      CASE
        WHEN st.id IS NOT NULL AND NOT (e.elem ? 'redacted')
        THEN e.elem || jsonb_build_object(
               'assignedDoctorUserId', st.assigned,
               'sync', COALESCE(e.elem->'sync', '{}'::jsonb)
                       || jsonb_build_object('serverId', st.id, 'revision', st.revision, 'syncStatus', 'synced'))
        ELSE e.elem
      END ORDER BY e.ord), '[]'::jsonb)
    FROM jsonb_array_elements(snapshot_payload) WITH ORDINALITY AS e(elem, ord)
    LEFT JOIN LATERAL (
      SELECT s.id, s.revision, s.assigned
      FROM jsonb_to_recordset($1::jsonb) AS s(id text, revision int, assigned text)
      WHERE s.id = COALESCE(NULLIF(e.elem->'sync'->>'serverId', ''), e.elem->>'id')
      LIMIT 1
    ) st ON true
  )
  WHERE id = $2 AND organization_id = $3 AND owner_user_id = $4
    AND created_at = $5::timestamptz AND jsonb_typeof(snapshot_payload) = 'array'`;

export async function saveWorkspace(
  pool: Pool,
  req: Request,
  res: Response,
  options: { workspaceId?: string; statusCode?: 200 | 201 } = {},
): Promise<void> {
  const session = sessionOf(req);
  const orgId   = orgIdOf(req);
  const workspaceId = options.workspaceId ?? null;
  const statusCode = options.statusCode ?? 201;

  const parse = SaveBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  const { name, patients: rawPatients, lockTokens } = parse.data;

  // snapshot을 커밋하기 전에 검증·정규화한다 — 아래 patient upsert는 커밋 이후
  // best-effort로 돌면서 오류를 삼키므로, 거기서 던지면 API는 200을 반환하고 오염된 값은
  // 이미 snapshot_payload에 남는다.
  const dates = normalizeWorkspacePatients(rawPatients);
  if (!dates.ok) {
    res.status(400).json({
      code:  'INVALID_BIRTH_DATE',
      error: 'One or more patients have a date field that is not a valid calendar date within the allowed range',
      fields: dates.failures,
    });
    return;
  }
  // 이후 모든 경로(snapshot 저장 · patient_records upsert)는 정규화된 배열만 쓴다.
  const patients = dates.patients;

  const rawPatientIds = extractPatientIds(patients);
  let snapshotPatients: unknown[] = patients;
  let savedWorkspaceId: string | null = workspaceId;
  let savedVersion: string | null = null; // 이 요청이 기록한 저장본의 created_at(마이크로초 문자열) — 보정 UPDATE의 버전 조건

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deletedPatientIds = await loadDeletedPatientIds(client as QueryRunner, orgId, rawPatientIds);
    snapshotPatients = redactDeletedPatients(patients, deletedPatientIds);
    const patientIds = extractPatientIds(snapshotPatients);

    // Primary operation: insert or overwrite workspace snapshot.
    if (workspaceId) {
      const result = await client.query<{ version: string }>(
        `UPDATE workspaces
         SET name = $4,
             patient_ids = $5,
             snapshot_payload = $6,
             created_at = now()
         WHERE id = $1 AND organization_id = $2 AND owner_user_id = $3
         RETURNING created_at::text AS version`,
        [workspaceId, orgId, session.userId, name, patientIds, JSON.stringify(snapshotPatients)]
      );
      if ((result.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ code: 'WORKSPACE_NOT_FOUND', error: 'Workspace not found' });
        return;
      }
      savedVersion = result.rows[0]?.version ?? null;
    } else {
      const inserted = await client.query<{ id: string; version: string }>(
        `INSERT INTO workspaces (organization_id, owner_user_id, name, patient_ids, snapshot_payload)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at::text AS version`,
        [orgId, session.userId, name, patientIds, JSON.stringify(snapshotPatients)]
      );
      savedWorkspaceId = inserted.rows[0]?.id ?? null;
      savedVersion = inserted.rows[0]?.version ?? null;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Secondary (best-effort): decompose patients into patient_records so that
  // ?view=current returns live data immediately after the first workspace save.
  // Failures are logged per patient and do not roll back the workspace row.
  const metas = snapshotPatients.map(extractPatientMeta).filter((m): m is PatientMeta => m !== null);
  const results = await Promise.allSettled(
    metas.map((meta) => upsertFromWorkspace(
      pool,
      // 환자별 편집 락 lease token(요청 본문 lockTokens에서 로컬 id로 꺼냄). 없으면 null.
      patientWriteContextOf(req, (meta.localId && lockTokens?.[meta.localId]) || null),
      meta,
    ))
  );

  const ack: WorkspaceSaveAck = { saved: [], skipped: [], conflicts: [], lockedByOther: [] };
  results.forEach((r, i) => {
    const meta = metas[i];
    if (r.status === 'rejected') console.error('[workspaces] patient_records upsert failed', { patientId: meta.id, err: r.reason });
    const outcome: UpsertOutcome = r.status === 'fulfilled' ? r.value : { kind: 'skipped', reason: 'error' };
    if (outcome.kind === 'saved') {
      ack.saved.push({ id: meta.id, revision: outcome.revision, assignedDoctorUserId: outcome.assignedDoctorUserId });
      return;
    }
    if (outcome.kind === 'skipped') ack.skipped.push({ id: meta.id, reason: outcome.reason });
    else if (outcome.kind === 'conflict') ack.conflicts.push({ id: meta.id, serverRevision: outcome.serverRevision });
    else ack.lockedByOther.push({ id: meta.id, holder: outcome.holder });

    // 삭제된 환자는 흔한 정상 경로라 감사에서 뺀다. 나머지는 "누가 어떤 환자를 못 썼는지" 남긴다.
    // 담당의·락 거절은 denied, 낙관적 잠금 충돌과 서버 오류는 권한 문제가 아니라 failure.
    if (outcome.kind === 'skipped' && outcome.reason === 'deleted') return;
    const failed = outcome.kind === 'conflict' || (outcome.kind === 'skipped' && outcome.reason === 'error');
    void writeAuditLog(pool, {
      actorUserId: session.userId, actorOrgId: orgId, action: 'workspace_patient_write_rejected',
      targetType: 'patient', targetId: meta.id,
      outcome: failed ? 'failure' : 'denied',
      ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null,
      extra: {
        kind: outcome.kind,
        ...(outcome.kind === 'skipped' ? { reason: outcome.reason } : {}),
        ...(outcome.kind === 'conflict' ? { serverRevision: outcome.serverRevision } : {}),
        ...(outcome.kind === 'locked' ? { holderName: (outcome.holder as { holderName?: string } | null)?.holderName ?? null } : {}),
      },
    });
  });

  // 저장된 환자의 revision·담당의를 스냅샷에도 반영한다. 스냅샷에는 저장 전 revision이 남아 있어서, 안 하면
  // 이 저장 항목을 나중에 불러와 다시 저장할 때 다른 사용자의 수정이 없어도 "자기 저장과의 충돌"이 난다.
  // 환자 기록은 이미 저장됐으므로 실패해도 로그만 남긴다(best-effort). 안전 조건은 STAMP_SAVED_SNAPSHOT_SQL 주석 참고.
  if (savedWorkspaceId && savedVersion && ack.saved.length > 0) {
    await pool.query(STAMP_SAVED_SNAPSHOT_SQL, [
      JSON.stringify(ack.saved.map((s) => ({ id: s.id, revision: s.revision, assigned: s.assignedDoctorUserId }))),
      savedWorkspaceId, orgId, session.userId, savedVersion,
    ]).catch((err: unknown) => console.error('[workspaces] snapshot revision stamp failed', err));
  }

  const rows = await listQuery(pool, orgId, session.userId);
  res.status(statusCode).json({ items: rows.map(toItem), ...ack });
}

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:id
// Returns refreshed list after deletion.
// ---------------------------------------------------------------------------
export async function deleteWorkspace(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const orgId   = orgIdOf(req);
  const { id }  = req.params;

  const result = await pool.query(
    `DELETE FROM workspaces
     WHERE id = $1 AND organization_id = $2 AND owner_user_id = $3`,
    [id, orgId, session.userId]
  );

  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ code: 'WORKSPACE_NOT_FOUND', error: 'Workspace not found' });
    return;
  }

  const rows = await listQuery(pool, orgId, session.userId);
  res.status(200).json({ items: rows.map(toItem) });
}
