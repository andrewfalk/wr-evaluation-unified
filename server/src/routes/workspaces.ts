import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { auditMiddleware, writeAuditLog } from '../middleware/audit';
import { resolvePatientPersonId, releasePersonIfOrphaned, type QueryRunner } from '../db/patientPersons';
import { assertAssignedOrAdmin, PatientLockForbiddenError } from '../db/patientLocks';
import { withDeadlockRetry, evaluateLockGate } from './patients';
import { resolveAssignedDoctor } from '../db/resolveAssignedDoctor';
import { validatePastDate } from '@wr/contracts';
import {
  nextCompletionColumns, DRAFT_COMPLETION_COLUMNS, type CompletionColumns,
  verifyModulesComplete, logCompletionMismatchIfAny, nextVerificationColumns, DRAFT_VERIFICATION_COLUMNS, type VerificationColumns,
} from '../completionTracking';

// ---------------------------------------------------------------------------
// POST /api/workspaces body schema
// Mirrors SaveWorkspaceRequestSchema from shared/contracts/workspace.ts.
// Defined locally to avoid a runtime dependency on the built contracts package.
// patients is z.unknown() — snapshot semantics: we store whatever the client
// sends without re-validating every patient field on the server side.
// ---------------------------------------------------------------------------
const SaveBody = z.object({
  name:     z.string().min(1, 'Workspace name is required'),
  patients: z.array(z.unknown()),
  // 환자별 편집 락 lease token(키 = 클라이언트 로컬 환자 id). X-Lock-Token 헤더는 환자 1명용이라
  // 환자 N명을 싣는 워크스페이스 저장에는 쓸 수 없다. snapshot_payload에는 저장되지 않는다.
  lockTokens: z.record(z.string().min(1).max(128), z.string().min(1).max(256)).optional(),
});

interface WorkspaceRow {
  id:               string;
  name:             string;
  created_at:       Date;
  patient_ids:      string[];
  snapshot_payload: unknown;
}

// ---------------------------------------------------------------------------
// Patient metadata extraction helpers
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// Resolve the authoritative server-side UUID for a patient.
// Phase 3 (patient 1급 API) assigns sync.serverId. Until then, patient.id
// is used as the row ID. This function ensures patient_ids[] and
// patient_records.id are consistent across both phases.
function resolvePatientId(p: unknown): string | null {
  if (typeof p !== 'object' || p === null) return null;
  const raw = p as Record<string, unknown>;
  const sync = raw['sync'];
  if (typeof sync === 'object' && sync !== null) {
    const serverId = (sync as Record<string, unknown>)['serverId'];
    if (isUuid(serverId)) return serverId;
  }
  return isUuid(raw['id']) ? (raw['id'] as string) : null;
}

// Extracts UUIDs for the workspaces.patient_ids column.
// Prefers sync.serverId (server-assigned) over patient.id (local UUID).
function extractPatientIds(patients: unknown[]): string[] {
  const ids: string[] = [];
  for (const p of patients) {
    const id = resolvePatientId(p);
    if (id) ids.push(id);
  }
  return ids;
}

async function loadDeletedPatientIds(db: QueryRunner, orgId: string, patientIds: string[]): Promise<Set<string>> {
  if (patientIds.length === 0) return new Set();

  const { rows } = await db.query<{ id: string; deleted_at: Date | null }>(
    `SELECT id, deleted_at
     FROM patient_records
     WHERE organization_id = $1 AND id = ANY($2::uuid[])
     FOR SHARE`,
    [orgId, patientIds]
  );

  return new Set(
    rows
      .filter((row) => row.deleted_at != null)
      .map((row) => row.id)
  );
}

function redactDeletedPatients(patients: unknown[], deletedPatientIds: Set<string>): unknown[] {
  if (deletedPatientIds.size === 0) return patients;

  return patients.map((patient) => {
    const id = resolvePatientId(patient);
    if (!id || !deletedPatientIds.has(id)) return patient;
    return { id, redacted: true };
  });
}

// Metadata extracted from a patient object for patient_records upsert.
interface PatientMeta {
  id:              string;
  name:            string;
  doctorName:      string | null;
  patientNo:       string | null;
  birthDate:       string | null;
  injuryDate:      string | null;
  evaluationDate:  string | null;
  activeModules:   string[];
  diagnosesCodes:  string[];
  jobsNames:       string[];
  payload:         unknown;
  // HF1: 클라이언트 로컬 환자 id(lockTokens 조회 키)와, 클라이언트가 마지막으로 본 서버 revision
  // (sync.revision, 없으면 0). 기존 행의 revision과 다르면 덮어쓰지 않고 충돌로 보고한다.
  localId:          string | null;
  expectedRevision: number;
  // PR0-B2: 서버 완료 재검증(verifyModulesComplete)에 필요한 원본 data(shared/modules/
  // activeModules). shared/jobs 등 개별 필드만 뽑아둔 위 필드들과 달리 이건 통째로 필요하다.
  data:            Record<string, unknown> | null;
  // PR0-A: 클라이언트가 워크스페이스 저장 시점에 계산해 각 환자 객체에 실어보내는 완료
  // 보고. patientServerRepository.js가 PATCH/POST에 붙이는 것과 동일한 필드를 여기서는
  // patient 객체 최상위(payload 밖)에서 읽는다 — patients는 z.unknown()이라 스키마로
  // 강제할 수 없어 방어적으로 타입 검사한다.
  modulesCompleteObserved?:       boolean;
  completionClientBuildVersion?:  string;
  completionClientSchemaVersion?: number;
}

// Safely pull metadata fields out of an unknown patient object.
// Returns null if the patient cannot be identified or has no name (NOT NULL in DB).
function extractPatientMeta(p: unknown): PatientMeta | null {
  const id = resolvePatientId(p);
  if (!id) return null;

  if (typeof p !== 'object' || p === null) return null;
  const raw    = p as Record<string, unknown>;
  const data   = typeof raw['data'] === 'object' && raw['data'] !== null
    ? raw['data'] as Record<string, unknown>
    : null;
  const shared = data && typeof data['shared'] === 'object' && data['shared'] !== null
    ? data['shared'] as Record<string, unknown>
    : null;

  const name = typeof shared?.['name'] === 'string' ? (shared['name'] as string).trim() : '';
  if (!name) return null; // name is NOT NULL in DB

  const diagnoses = Array.isArray(shared?.['diagnoses']) ? shared!['diagnoses'] as unknown[] : [];
  const jobs      = Array.isArray(shared?.['jobs'])      ? shared!['jobs']      as unknown[] : [];
  const mods      = Array.isArray(data?.['activeModules']) ? data!['activeModules'] as unknown[] : [];

  const completionClientBuildVersion = typeof raw['completionClientBuildVersion'] === 'string'
    ? raw['completionClientBuildVersion'] as string : undefined;
  const completionClientSchemaVersion = typeof raw['completionClientSchemaVersion'] === 'number'
    ? raw['completionClientSchemaVersion'] as number : undefined;
  // true인데 버전이 없으면 손상된 보고로 보고 "보고 없음"으로 낮춘다(zod가 없는 경로라
  // patients.ts의 requireCompletionVersions 같은 400 거부가 불가능 — 이 파일 전체가
  // "환자 1명 실패는 나머지를 막지 않는다"는 best-effort 철학이라 조용히 무시가 맞다).
  const modulesCompleteObservedRaw = typeof raw['modulesCompleteObserved'] === 'boolean'
    ? raw['modulesCompleteObserved'] as boolean : undefined;
  const modulesCompleteObserved =
    modulesCompleteObservedRaw === true &&
    (completionClientBuildVersion === undefined || completionClientSchemaVersion === undefined)
      ? undefined
      : modulesCompleteObservedRaw;

  const syncRaw = typeof raw['sync'] === 'object' && raw['sync'] !== null
    ? raw['sync'] as Record<string, unknown> : null;
  const revisionRaw = syncRaw?.['revision'];
  const expectedRevision = typeof revisionRaw === 'number' && Number.isInteger(revisionRaw) && revisionRaw >= 0
    ? revisionRaw : 0;

  return {
    id,
    name,
    doctorName:     strOrNull(shared?.['doctorName']),
    patientNo:      strOrNull(shared?.['patientNo']),
    birthDate:      strOrNull(shared?.['birthDate']),
    injuryDate:     strOrNull(shared?.['injuryDate']),
    evaluationDate: strOrNull(shared?.['evaluationDate']),
    activeModules:  mods.filter((m): m is string => typeof m === 'string'),
    diagnosesCodes: diagnoses
      .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
      .map((d) => d['code'])
      .filter((c): c is string => typeof c === 'string'),
    jobsNames: jobs
      .filter((j): j is Record<string, unknown> => typeof j === 'object' && j !== null)
      .map((j) => j['jobName'])
      .filter((n): n is string => typeof n === 'string'),
    payload: p,
    data,
    modulesCompleteObserved,
    completionClientBuildVersion,
    completionClientSchemaVersion,
    localId: typeof raw['id'] === 'string' ? raw['id'] : null,
    expectedRevision,
  };
}

// ---------------------------------------------------------------------------
// 날짜 사전검증 — snapshot을 커밋하기 전에 수행해야 한다.
//
// saveWorkspace는 snapshot을 먼저 COMMIT한 뒤 patient upsert를 best-effort로 돌리고
// 실패를 삼킨다. 따라서 upsertPatientRecord 안에서만 검증하면 API는 200을 반환하고
// 오염된 생년월일은 이미 snapshot_payload에 저장된 뒤다. 유일하게 400을 돌려줄 수 있는
// 지점은 SaveBody 파싱 직후 · client.connect() 이전이다.
//
// SaveBody.patients가 z.array(z.unknown())이라 zod는 아무것도 걸러주지 않는다.
// ---------------------------------------------------------------------------
export interface WorkspaceDateFailure {
  patientId: string | null;
  field:     string;
  reason:    string;
}

export type NormalizeWorkspaceResult =
  | { ok: true;  patients: unknown[] }
  | { ok: false; failures: WorkspaceDateFailure[] };

/**
 * 날짜를 검증하고 **canonical 형식으로 정규화한 환자 배열**을 돌려준다.
 *
 * 검증만 하고 원본을 그대로 저장하면 안 된다: `2020/01/02`가 유효 판정을 받아도
 * DB DATE 컬럼에는 2020-01-02로, snapshot/payload에는 2020/01/02로 저장돼
 * dateOnly() 비교(앞은 '2020-01-02', 뒤는 slice로 '2020/01/02')에서 어긋나
 * 존재하지도 않는 생년월일 충돌이 발생한다.
 * 반환된 배열을 snapshot과 patient_records upsert 양쪽에 써야 한다.
 */
export function normalizeWorkspacePatients(patients: unknown[]): NormalizeWorkspaceResult {
  const failures: WorkspaceDateFailure[] = [];
  const normalized: unknown[] = [];

  for (const p of patients) {
    if (typeof p !== 'object' || p === null) { normalized.push(p); continue; }
    const raw    = p as Record<string, unknown>;
    const data   = typeof raw['data'] === 'object' && raw['data'] !== null
      ? raw['data'] as Record<string, unknown> : null;
    const shared = data && typeof data['shared'] === 'object' && data['shared'] !== null
      ? data['shared'] as Record<string, unknown> : null;
    if (!shared) { normalized.push(p); continue; }

    const patched: Record<string, unknown> = {};
    for (const field of ['birthDate', 'injuryDate'] as const) {
      const result = validatePastDate(shared[field]);
      if (!result.valid) {
        failures.push({
          patientId: resolvePatientId(p),
          field,
          // 사유 코드만 — 날짜 값 자체는 PHI이므로 응답에 되싣지 않는다.
          reason: result.reason ?? 'format',
        });
        continue;
      }
      if (shared[field] !== result.normalized) patched[field] = result.normalized;
    }

    normalized.push(Object.keys(patched).length === 0
      ? p
      : { ...raw, data: { ...data, shared: { ...shared, ...patched } } });
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, patients: normalized };
}

// HF1(H1): patient_records 쓰기는 PATCH와 같은 규칙을 따라야 한다. 기존 행이면
//   ① 담당의 또는 admin  ② 클라이언트가 마지막으로 본 revision이 서버와 같음  ③ 편집 락 게이트 통과
// 하나라도 어긋나면 덮어쓰지 않고 결과(UpsertOutcome)로 알린다. 예전의 단일
// `INSERT … ON CONFLICT DO UPDATE`는 (a) 같은 id를 동시에 처음 저장하는 두 요청 중 비담당 쪽이
// 담당 환자를 덮어쓸 수 있었고 (b) revision을 올리며 payload를 무조건 덮어써 더 새로운 진료
// 데이터도 날렸다.
//
// 한 환자의 거절/실패가 워크스페이스 저장 전체를 막지 않는 best-effort 철학은 그대로다 —
// 호출부(saveWorkspace)가 결과를 saved/skipped/conflicts/lockedByOther로 집계해 응답한다.
export type SkipReason = 'not_assigned' | 'deleted' | 'error';

export type UpsertOutcome =
  // assignedDoctorUserId: 쓰기 후 행의 실제 담당의 — 클라이언트 편집 권한 판정(canEditPatient)이 이 값을 쓴다.
  | { kind: 'saved'; revision: number; assignedDoctorUserId: string | null }
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'conflict'; serverRevision: number }
  | { kind: 'locked'; holder: unknown };

interface UpsertContext {
  pool: Pool;
  req: Request;
  /** 이 환자의 편집 락 lease token(요청 본문 lockTokens에서 환자별로 꺼냄). 없으면 null. */
  leaseToken: string | null;
}

// 트랜잭션 단위는 "환자 1명" — 호출부가 Promise.allSettled로 병렬 실행하므로 하나의
// client를 공유하면 여러 BEGIN/COMMIT이 한 연결에 인터리브돼 트랜잭션 경계가 깨진다.
// 각 호출이 전용 client를 잡고 BEGIN → 검사·쓰기 → COMMIT 한다.
//
// 트랜잭션이 필요한 이유: resolvePatientPersonId가 person 행을 FOR UPDATE로 잡는데,
// pool.query로 실행하면 statement가 끝나는 즉시 잠금이 풀려 잠금 규약이 무효가 된다.
async function upsertPatientRecord(
  pool: Pool,
  orgId: string,
  user: { id: string; role: string },
  meta: PatientMeta,
  ctx: UpsertContext,
): Promise<UpsertOutcome> {
  // 병렬 upsert끼리도 person 잠금 순서가 엇갈릴 수 있다(등록번호 교환 등).
  // deadlock은 PostgreSQL이 한쪽만 중단시키므로 제한 횟수만큼 재시도하면 해소된다.
  return withDeadlockRetry(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const outcome = await upsertPatientRecordInTx(client as unknown as QueryRunner, orgId, user, meta, ctx);
      // 저장하지 않은 경로(skipped/conflict/locked)는 되돌린다 — 쓴 것이 없고, 있다면 person뿐이다.
      await client.query(outcome.kind === 'saved' ? 'COMMIT' : 'ROLLBACK');
      return outcome;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

async function upsertPatientRecordInTx(
  db: QueryRunner,
  orgId: string,
  user: { id: string; role: string },
  meta: PatientMeta,
  ctx: UpsertContext,
): Promise<UpsertOutcome> {
  // 같은 id를 동시에 처음 저장하는 요청들을 직렬화한다. 아직 없는 행은 FOR UPDATE로 잠글 수
  // 없어서, 이게 없으면 두 요청이 모두 "기존 행 없음"을 보고 둘 다 쓰기 경로로 들어간다.
  // 트랜잭션 범위 advisory lock이라 COMMIT/ROLLBACK 때 자동으로 풀린다(statsRunAdmission.ts와 같은 형태).
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [meta.id]);

  // FOR UPDATE 필수: 이 조회와 아래 쓰기 사이에 DELETE가 끼어들면 삭제된 환자에 쓰게 된다.
  // 행을 잡아두면 DELETE/PATCH가 우리 커밋까지 대기한다.
  const existing = await db.query<
    { patient_person_id: string | null; deleted_at: Date | null; revision: number; assigned_doctor_user_id: string | null }
      & CompletionColumns & VerificationColumns
  >(
    `SELECT patient_person_id, deleted_at, revision, assigned_doctor_user_id,
            completion_status, server_observed_modules_complete_at, completion_source,
            completion_client_build_version, completion_client_schema_version,
            server_verified_modules_complete_at, completion_verification_engine_version
     FROM patient_records
     WHERE id = $1 AND organization_id = $2
     FOR UPDATE`,
    [meta.id, orgId]
  );
  const existingRow = existing.rows[0];
  if (existingRow?.deleted_at !== null && existingRow?.deleted_at !== undefined) {
    return { kind: 'skipped', reason: 'deleted' };
  }

  // 새 환자는 누구나 만들 수 있다(현행 동작). 기존 환자에 대한 쓰기만 검사한다.
  // 검사는 resolvePatientPersonId(person 행을 만들거나 고치는 부작용) "보다 앞"에서 한다.
  if (existingRow) {
    try {
      // PATCH와 같은 규칙·같은 함수. 위 FOR UPDATE가 곧 앵커 잠금이다.
      assertAssignedOrAdmin(
        { id: meta.id, assignedDoctorUserId: existingRow.assigned_doctor_user_id },
        { role: user.role, userId: user.id },
      );
    } catch (err) {
      if (err instanceof PatientLockForbiddenError) return { kind: 'skipped', reason: 'not_assigned' };
      throw err;
    }
    if (existingRow.revision !== meta.expectedRevision) {
      return { kind: 'conflict', serverRevision: existingRow.revision };
    }
    const gate = await evaluateLockGate(ctx.pool, db, ctx.req, meta.id, orgId, ctx.leaseToken);
    if (gate) return { kind: 'locked', holder: gate.body['holder'] };
  }

  const existingPersonId = existingRow?.patient_person_id ?? null;
  const { personId } = await resolvePatientPersonId(db, orgId, meta, existingPersonId);

  // PR0-A: PATCH/POST와 동일한 3상태 규칙(§5.5) — workspace 수동 저장도 patient_records를
  // 직접 갱신하므로 여기서 빠지면 이 경로로만 저장된 환자는 완료돼도 'draft'로 남는다.
  const nextCompletion = nextCompletionColumns(
    existingRow ? existingRow : DRAFT_COMPLETION_COLUMNS,
    {
      modulesCompleteObserved: meta.modulesCompleteObserved,
      completionClientBuildVersion: meta.completionClientBuildVersion,
      completionClientSchemaVersion: meta.completionClientSchemaVersion,
    }
  );

  // PR0-B2: 클라이언트 신고와 별개로 서버가 analytics-core로 직접 재검증한다 — 위와
  // 동일한 FOR UPDATE 잠금 하에서 계산해 같은 쓰기 문장에 얹는다.
  const verified = verifyModulesComplete({
    shared: (meta.data?.['shared'] as Record<string, unknown>) ?? {},
    modules: (meta.data?.['modules'] as Record<string, unknown>) ?? {},
    activeModules: (meta.data?.['activeModules'] as string[]) ?? meta.activeModules,
  });
  logCompletionMismatchIfAny(meta.id, meta.modulesCompleteObserved, verified);
  const nextVerification = nextVerificationColumns(
    existingRow ? existingRow : DRAFT_VERIFICATION_COLUMNS,
    verified.allComplete,
  );

  const { assignedDoctorUserId, assignmentWarnings } = await resolveAssignedDoctor(
    db,
    { orgId, currentUser: user, requestedDoctorName: meta.doctorName }
  );
  if (assignmentWarnings.length > 0) {
    console.warn('[upsertPatientRecord] assignment warnings for patient %s:', meta.id,
      assignmentWarnings.map(w => `${w.code}: ${w.message}`).join('; '));
  }

  // 두 문장이 공유하는 값. 완료 provenance 컬럼(관측 시각·출처·빌드/스키마 버전·서버 검증 시각·
  // 엔진 버전)은 UPDATE에서 COALESCE로 "최초 한 번 찍히면 불변"을 지킨다. completion_status만
  // "현재 상태"라 그대로 덮어쓴다(모듈이 다시 불완전해지면 draft로 돌아가야 한다, §5.5).
  const birthDate      = meta.birthDate      ? meta.birthDate      : null;
  const injuryDate     = meta.injuryDate     ? meta.injuryDate     : null;
  const evaluationDate = meta.evaluationDate ? meta.evaluationDate : null;
  const payloadJson    = JSON.stringify(meta.payload);
  const completionTail = [
    nextCompletion.completion_status,
    nextCompletion.server_observed_modules_complete_at,
    nextCompletion.completion_source,
    nextCompletion.completion_client_build_version,
    nextCompletion.completion_client_schema_version,
    nextVerification.server_verified_modules_complete_at,
    nextVerification.completion_verification_engine_version,
  ];

  let written: { revision: number; assigned_doctor_user_id: string | null };
  if (existingRow) {
    // revision 조건은 위 검사와 같은 값이라 FOR UPDATE 아래에선 항상 맞지만, 어긋나면 0행으로
    // 드러나게 하는 마지막 안전장치다. owner_user_id는 바꾸지 않는다.
    const updated = await db.query<{ revision: number; assigned_doctor_user_id: string | null }>(
      `UPDATE patient_records SET
         patient_person_id       = $3,
         name                    = $4,
         patient_no              = $5,
         birth_date              = $6,
         injury_date             = $7,
         evaluation_date         = $8,
         active_modules          = $9,
         diagnoses_codes         = $10,
         jobs_names              = $11,
         assigned_doctor_user_id = COALESCE(assigned_doctor_user_id, $12),
         revision                = revision + 1,
         payload                 = $13,
         completion_status                   = $14,
         server_observed_modules_complete_at = COALESCE(server_observed_modules_complete_at, $15),
         completion_source                   = COALESCE(completion_source, $16),
         completion_client_build_version     = COALESCE(completion_client_build_version, $17),
         completion_client_schema_version    = COALESCE(completion_client_schema_version, $18),
         server_verified_modules_complete_at    = COALESCE(server_verified_modules_complete_at, $19),
         completion_verification_engine_version = COALESCE(completion_verification_engine_version, $20)
       WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL AND revision = $21
       RETURNING revision, assigned_doctor_user_id`,
      [
        meta.id, orgId, personId, meta.name, meta.patientNo, birthDate, injuryDate, evaluationDate,
        meta.activeModules, meta.diagnosesCodes, meta.jobsNames, assignedDoctorUserId, payloadJson,
        ...completionTail, existingRow.revision,
      ]
    );
    if (updated.rows.length === 0) return { kind: 'conflict', serverRevision: existingRow.revision };
    written = updated.rows[0];
  } else {
    // ON CONFLICT 없음: 같은 id가 이 사이에 다른 경로(POST /patients)로 생기면 23505로 실패해
    // 호출부가 skipped(error)로 보고한다 — 인가 검사 없이 덮어쓰는 길을 열어두지 않는다.
    const inserted = await db.query<{ revision: number; assigned_doctor_user_id: string | null }>(
      `INSERT INTO patient_records
         (id, organization_id, patient_person_id, owner_user_id, assigned_doctor_user_id,
          name, patient_no, birth_date, injury_date, evaluation_date,
          active_modules, diagnoses_codes, jobs_names, revision, payload,
          completion_status, server_observed_modules_complete_at, completion_source,
          completion_client_build_version, completion_client_schema_version,
          server_verified_modules_complete_at, completion_verification_engine_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING revision, assigned_doctor_user_id`,
      [
        meta.id, orgId, personId, user.id, assignedDoctorUserId, meta.name, meta.patientNo,
        birthDate, injuryDate, evaluationDate,
        meta.activeModules, meta.diagnosesCodes, meta.jobsNames, payloadJson,
        ...completionTail,
      ]
    );
    written = inserted.rows[0];
  }

  // 등록번호가 바뀌어 다른 person으로 옮겨 붙은 경우, 옛 person이 고아로 남지 않게 해제한다
  // (patchPatient와 동일한 이유 — 안 하면 옛 등록번호가 계속 점유된다).
  if (existingPersonId && existingPersonId !== personId) {
    await releasePersonIfOrphaned(db, existingPersonId, orgId);
  }
  return { kind: 'saved', revision: written.revision, assignedDoctorUserId: written.assigned_doctor_user_id ?? null };
}

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
async function listWorkspaces(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const orgId   = session.organizationId;

  // Superadmin (null org) has no org-scoped workspace bucket.
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
async function getWorkspace(pool: Pool, req: Request, res: Response): Promise<void> {
  const session   = req.sessionInfo!;
  const orgId     = session.organizationId;
  const { id }    = req.params;
  const isCurrent = req.query['view'] === 'current';

  if (orgId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

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

async function saveWorkspace(
  pool: Pool,
  req: Request,
  res: Response,
  options: { workspaceId?: string; statusCode?: 200 | 201 } = {},
): Promise<void> {
  const session = req.sessionInfo!;
  const orgId   = session.organizationId;
  const workspaceId = options.workspaceId ?? null;
  const statusCode = options.statusCode ?? 201;

  if (orgId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

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
    metas.map((meta) => upsertPatientRecord(pool, orgId, { id: session.userId, role: session.role }, meta, {
      pool,
      req,
      leaseToken: (meta.localId && lockTokens?.[meta.localId]) || null,
    }))
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
async function deleteWorkspace(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const orgId   = session.organizationId;
  const { id }  = req.params;

  if (orgId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

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

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

export function createWorkspacesRouter(pool: Pool): Router {
  const router = Router();
  const auth   = createAuthMiddleware(pool);
  const audit  = (action: string) =>
    auditMiddleware(pool, action, 'workspace', (req) => req.params.id ?? null);

  router.get(
    '/',
    auth, audit('workspace_list'),
    (req, res) => listWorkspaces(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.get(
    '/:id',
    auth, audit('workspace_load'),
    (req, res) => getWorkspace(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.post(
    '/',
    auth, csrfMiddleware, audit('workspace_save'),
    (req, res) => saveWorkspace(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.put(
    '/:id',
    auth, csrfMiddleware, audit('workspace_overwrite'),
    (req, res) => saveWorkspace(pool, req, res, {
      workspaceId: req.params.id,
      statusCode: 200,
    }).catch(() => res.status(500).json(internalError()))
  );

  router.delete(
    '/:id',
    auth, csrfMiddleware, audit('workspace_delete'),
    (req, res) => deleteWorkspace(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  return router;
}
