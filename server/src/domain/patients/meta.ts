import { validatePastDate } from '@wr/contracts';

// Patient metadata the write services take (S7). PatientMeta (the workspace save's per-patient fields)
// moved here from routes/workspaces/normalize.ts so that domain/ does not import routes/.

// Metadata extracted from a patient object for patient_records upsert.
export interface PatientMeta {
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

// ---------------------------------------------------------------------------
// Moved from routes/patients/shared.ts (S7-3): the patient routes' metadata extraction and date
// normalisation, used by the route validation and the create/patch services.
// ---------------------------------------------------------------------------

export function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export interface ExtractedMeta {
  name:           string;
  patientNo:      string | null;
  birthDate:      string | null;
  injuryDate:     string | null;
  evaluationDate: string | null;
  activeModules:  string[];
  diagnosesCodes: string[];
  jobsNames:      string[];
}

export function extractMeta(data: Record<string, unknown>): ExtractedMeta {
  const shared = typeof data['shared'] === 'object' && data['shared'] !== null
    ? (data['shared'] as Record<string, unknown>) : {};
  const diags = Array.isArray(shared['diagnoses']) ? shared['diagnoses'] as unknown[] : [];
  const jobs  = Array.isArray(shared['jobs'])      ? shared['jobs']      as unknown[] : [];

  return {
    name:           strOrNull(shared['name']) ?? '',
    patientNo:      strOrNull(shared['patientNo']),
    birthDate:      strOrNull(shared['birthDate']),
    injuryDate:     strOrNull(shared['injuryDate']),
    evaluationDate: strOrNull(shared['evaluationDate']),
    activeModules:  Array.isArray(data['activeModules'])
      ? (data['activeModules'] as unknown[]).filter((m): m is string => typeof m === 'string')
      : [],
    diagnosesCodes: diags
      .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
      .map((d) => d['code'])
      .filter((c): c is string => typeof c === 'string'),
    jobsNames: jobs
      .filter((j): j is Record<string, unknown> => typeof j === 'object' && j !== null)
      .map((j) => j['jobName'])
      .filter((n): n is string => typeof n === 'string'),
  };
}

// ---------------------------------------------------------------------------
// 달력 날짜 검증 · canonical 정규화
//
// 클라이언트(BatchImportModal)에서 이미 걸러도 서버는 독립적으로 방어해야 한다 —
// CreateBody.data.shared가 z.record(z.unknown())이라 zod는 어떤 값이든 통과시킨다.
//
// 정규화 결과를 DB 컬럼과 payload JSON 양쪽에 써야 한다. `2020/01/02`를 유효로만
// 판정하고 원본을 payload에 남기면 DB DATE 컬럼(2020-01-02)과 payload(2020/01/02)가
// 갈려 dateOnly() 비교에서 다시 충돌한다.
// ---------------------------------------------------------------------------
const DATE_FIELDS = ['birthDate', 'injuryDate'] as const;

export interface DateFieldFailure {
  field:  string;
  reason: string;
}

export type NormalizeDatesResult =
  | { ok: true;  data: Record<string, unknown> }
  | { ok: false; failures: DateFieldFailure[] };

export function normalizePatientDates(data: Record<string, unknown>): NormalizeDatesResult {
  const shared = typeof data['shared'] === 'object' && data['shared'] !== null
    ? (data['shared'] as Record<string, unknown>) : null;
  if (!shared) return { ok: true, data };

  const failures: DateFieldFailure[] = [];
  const patched: Record<string, unknown> = {};

  for (const field of DATE_FIELDS) {
    const raw = shared[field];
    const result = validatePastDate(raw);
    if (!result.valid) {
      failures.push({ field, reason: result.reason ?? 'format' });
      continue;
    }
    // 빈 값은 ''로, 유효 값은 canonical YYYY-MM-DD로 통일한다.
    if (raw !== result.normalized) patched[field] = result.normalized;
  }

  if (failures.length > 0) return { ok: false, failures };
  if (Object.keys(patched).length === 0) return { ok: true, data };

  return { ok: true, data: { ...data, shared: { ...shared, ...patched } } };
}
