// Workspace body schema, row shape, patient id/metadata helpers and date normalisation.
// Split out of routes/workspaces.ts (S5 P1-31); handler bodies unchanged.
import { z } from 'zod';
import type { QueryRunner } from '../../db/patientPersons';
import { validatePastDate } from '@wr/contracts';

// ---------------------------------------------------------------------------
// POST /api/workspaces body schema
// Mirrors SaveWorkspaceRequestSchema from shared/contracts/workspace.ts.
// Defined locally to avoid a runtime dependency on the built contracts package.
// patients is z.unknown() — snapshot semantics: we store whatever the client
// sends without re-validating every patient field on the server side.
// ---------------------------------------------------------------------------
export const SaveBody = z.object({
  name:     z.string().min(1, 'Workspace name is required'),
  patients: z.array(z.unknown()),
  // 환자별 편집 락 lease token(키 = 클라이언트 로컬 환자 id). X-Lock-Token 헤더는 환자 1명용이라
  // 환자 N명을 싣는 워크스페이스 저장에는 쓸 수 없다. snapshot_payload에는 저장되지 않는다.
  lockTokens: z.record(z.string().min(1).max(128), z.string().min(1).max(256)).optional(),
});

export interface WorkspaceRow {
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
export function extractPatientIds(patients: unknown[]): string[] {
  const ids: string[] = [];
  for (const p of patients) {
    const id = resolvePatientId(p);
    if (id) ids.push(id);
  }
  return ids;
}

export async function loadDeletedPatientIds(db: QueryRunner, orgId: string, patientIds: string[]): Promise<Set<string>> {
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

export function redactDeletedPatients(patients: unknown[], deletedPatientIds: Set<string>): unknown[] {
  if (deletedPatientIds.size === 0) return patients;

  return patients.map((patient) => {
    const id = resolvePatientId(patient);
    if (!id || !deletedPatientIds.has(id)) return patient;
    return { id, redacted: true };
  });
}

// Moved to domain/patients/meta.ts (S7-1); re-exported for existing imports.
import type { PatientMeta } from '../../domain/patients/meta';
export type { PatientMeta } from '../../domain/patients/meta';

// Safely pull metadata fields out of an unknown patient object.
// Returns null if the patient cannot be identified or has no name (NOT NULL in DB).
export function extractPatientMeta(p: unknown): PatientMeta | null {
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
