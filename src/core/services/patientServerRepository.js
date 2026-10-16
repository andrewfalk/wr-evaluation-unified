import { requestJson } from './httpClient';
import { isRedactedPatientRecord } from './patientRecords';
import { requireSyncedServerId } from './videoAnalysisClient';
import { getLockToken } from './lockTokenStore';
import { completionReportFields } from '../utils/patientCompletion';

function getBaseUrl(session, settings) {
  return session?.apiBaseUrl || settings?.apiBaseUrl || '';
}

// leaseToken이 있으면 X-Lock-Token 헤더로 실어보낸다. 없어도(opt-in) 정상 동작 —
// 서버 쪽에 그 환자의 활성 락이 없으면 그대로 통과한다.
function lockTokenHeaders(leaseToken) {
  return leaseToken ? { 'X-Lock-Token': leaseToken } : {};
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

// The server's toResponse() spreads the stored payload and overlays id + sync.
// When we POST a new patient, we send our local UUID as the body id so the server
// stores it as its own id — meaning serverPatient.id === localPatient.id after a push.
// On pull (records created on another device), localId may differ; callers pass null.
function applyServerSync(serverPatient, localId = null, localMeta = undefined) {
  const mapped = {
    ...serverPatient,
    id: localId ?? serverPatient.id,
  };
  if (mapped.meta === undefined && localMeta !== undefined) {
    mapped.meta = localMeta;
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// Pull — GET /api/patients
// Returns { items: Patient[], total: number }
// Accepted params: q, diagnosesCode, jobName, module, limit, offset
// ---------------------------------------------------------------------------
export async function pullPatients({ session, settings, params = {} } = {}) {
  const qs = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)])
  );
  const path = `/api/patients${qs.toString() ? `?${qs}` : ''}`;
  const data = await requestJson(path, {
    baseUrl: getBaseUrl(session, settings),
    session,
  });
  return {
    items: (data.items ?? []).map(p => applyServerSync(p)),
    total: data.total ?? data.items?.length ?? 0,
    unassignedCount: typeof data.unassignedCount === 'number' ? data.unassignedCount : undefined,
    orgPatientCount: typeof data.orgPatientCount === 'number' ? data.orgPatientCount : undefined,
  };
}

// Lightweight per-doctor patient-count roster for the dashboard scope dropdown.
// Returns { doctors: [{ userId, name, count }], unassignedCount } — no PHI / payloads.
export async function fetchDoctorCounts({ session, settings } = {}) {
  const data = await requestJson('/api/patients/doctor-counts', {
    baseUrl: getBaseUrl(session, settings),
    session,
  });
  return {
    doctors: Array.isArray(data.doctors) ? data.doctors : [],
    unassignedCount: typeof data.unassignedCount === 'number' ? data.unassignedCount : 0,
  };
}

export async function fetchPatient(serverId, { session, settings } = {}) {
  const data = await requestJson(`/api/patients/${serverId}`, {
    baseUrl: getBaseUrl(session, settings),
    session,
  });
  return applyServerSync(data);
}

// ---------------------------------------------------------------------------
// Push — POST /api/patients (local-only) or PATCH /api/patients/:id (dirty)
// Returns the updated patient with server sync fields applied.
// Throws with error.status === 409 on revision conflict or identity conflict.
// ---------------------------------------------------------------------------
export async function pushPatient(patient, { session, settings, leaseToken } = {}) {
  if (isRedactedPatientRecord(patient)) {
    throw new Error('Cannot push a redacted patient snapshot stub.');
  }
  const base = getBaseUrl(session, settings);
  const serverId = patient.sync?.serverId ?? null;
  const revision = patient.sync?.revision;

  if (!serverId) {
    if (!patient.id) {
      const err = new Error('POST /api/patients requires patient.id for Idempotency-Key.');
      err.status = 400;
      throw err;
    }
    const data = await requestJson('/api/patients', {
      baseUrl: base,
      method:  'POST',
      session,
      headers: { 'Idempotency-Key': patient.id },
      body: {
        id:        patient.id,
        phase:     patient.phase,
        createdAt: patient.createdAt,
        data:      patient.data,
        ...completionReportFields(patient),
      },
    });
    return applyServerSync(data, patient.id, patient.meta);
  }

  if (!Number.isInteger(revision) || revision < 1) {
    const err = new Error(`PATCH /api/patients/:id requires a positive integer revision for If-Match (got ${revision}).`);
    err.status = 400;
    throw err;
  }
  const data = await requestJson(`/api/patients/${serverId}`, {
    baseUrl: base,
    method:  'PATCH',
    session,
    headers: { 'If-Match': String(revision), ...lockTokenHeaders(leaseToken) },
    body: {
      phase: patient.phase,
      data:  patient.data,
      ...completionReportFields(patient),
    },
  });
  return applyServerSync(data, patient.id, patient.meta);
}

// ---------------------------------------------------------------------------
// 생년월일 정정 — POST /api/patients/:id/identity-correction
//
// 서버에 잘못 저장된 person 생년월일을 사용자 확인을 거쳐 덮어쓴다.
// PATCH의 일반 저장 경로로는 불가능하다 — 서버가 assertCompatibleBirthDate로 409를
// 던지기 때문이며, 그 안전장치는 등록번호 오타로 남의 기록을 오염시키는 것을 막으므로
// 그대로 둔다. 이 엔드포인트만 담당의/관리자 확인 + 감사 기록을 조건으로 우회한다.
//
// serverId가 있는 환자에만 호출할 것(최초 POST 충돌에는 정정 대상 서버 기록이 없다).
// 응답: { ...patient, affectedPatientIds } — 복수 case 정정 시 revision이 오른 전체 목록.
// ---------------------------------------------------------------------------
export async function correctPatientIdentity(
  patient, { birthDate, reasonCode, session, settings, leaseToken } = {}
) {
  const serverId = patient?.sync?.serverId;
  if (!serverId) {
    const err = new Error('identity-correction requires a server-backed patient (sync.serverId).');
    err.status = 400;
    throw err;
  }
  const revision = patient?.sync?.revision;
  if (!Number.isInteger(revision) || revision < 1) {
    const err = new Error(`identity-correction requires a positive integer revision for If-Match (got ${revision}).`);
    err.status = 400;
    throw err;
  }

  const data = await requestJson(`/api/patients/${serverId}/identity-correction`, {
    baseUrl: getBaseUrl(session, settings),
    method:  'POST',
    session,
    headers: { 'If-Match': String(revision), ...lockTokenHeaders(leaseToken) },
    body:    { birthDate, reasonCode },
  });

  const affectedPatientIds = Array.isArray(data?.affectedPatientIds) ? data.affectedPatientIds : [];
  return { patient: applyServerSync(data, patient.id, patient.meta), affectedPatientIds };
}

// ---------------------------------------------------------------------------
// Apply video-analysis job — POST /api/video-analysis/jobs/:jobId/apply
// 클라가 applyFeatureToModule로 계산한 환자 data를 If-Match(현재 revision)와 함께 보내
// 서버가 단일 트랜잭션으로 영속화한다. 서버 응답(갱신 patient)을 로컬 sync에 반영해
// 다음 저장이 stale revision으로 409 나는 것을 막는다(§8.12).
// 동기화된 환자(serverId + revision)만 호출해야 한다 — synced 판정은 호출부 책임.
// ---------------------------------------------------------------------------
export async function applyVideoAnalysisJob(
  jobId, patient, computedData,
  { appliedInputsHash, appliedInputsCount, sourceAnalysisJobIds = [], session, settings, leaseToken } = {}
) {
  // synced 강제(serverId + syncStatus==='synced') — dirty/conflict/local-only 차단.
  requireSyncedServerId(patient);
  const revision = patient?.sync?.revision;
  if (!Number.isInteger(revision) || revision < 1) {
    const err = new Error(`apply requires a positive integer revision for If-Match (got ${revision}).`);
    err.status = 400;
    throw err;
  }
  const res = await requestJson(`/api/video-analysis/jobs/${jobId}/apply`, {
    baseUrl: getBaseUrl(session, settings),
    method: 'POST',
    session,
    headers: { 'If-Match': String(revision), ...lockTokenHeaders(leaseToken) },
    body: {
      data: computedData, appliedInputsHash, appliedInputsCount, sourceAnalysisJobIds,
      // computedData는 이 apply가 만드는 새 data — 완료 여부도 그 기준으로 판단한다.
      ...completionReportFields({ data: computedData }),
    },
  });
  // res = { patient } | { idempotent: true, patient }
  return applyServerSync(res.patient, patient.id, patient.meta);
}

// ---------------------------------------------------------------------------
// Delete — DELETE /api/patients/:id?revision=N (soft-delete on server)
// Only call this when the patient has a serverId. For local-only patients,
// just remove from local state without calling the server.
// Throws with status 409 on revision mismatch.
// ---------------------------------------------------------------------------
export async function deletePatientOnServer(serverId, revision, { session, settings, leaseToken } = {}) {
  if (!serverId) {
    const err = new Error('DELETE /api/patients requires a serverId.');
    err.status = 400;
    throw err;
  }
  if (!Number.isInteger(revision) || revision < 1) {
    const err = new Error(`DELETE /api/patients/:id requires a positive integer revision (?revision=N, got ${revision}).`);
    err.status = 400;
    throw err;
  }
  await requestJson(`/api/patients/${serverId}?revision=${revision}`, {
    baseUrl: getBaseUrl(session, settings),
    method:  'DELETE',
    session,
    headers: lockTokenHeaders(leaseToken),
  });
}

// ---------------------------------------------------------------------------
// 환자 단위 편집 락 — POST/DELETE/GET /api/patients/:id/lock
// acquire(토큰 미제출)/renew(X-Lock-Token 제출)/force(force=true)는 서버가 요청 형태로
// 구분하므로 클라이언트 함수도 그 형태를 그대로 반영한다. 실패(423)는 requestJson이 그대로
// throw하며 err.status===423, err.data가 {code, holder?}를 담는다 — 호출부(usePatientLock)가
// 판정한다.
// ---------------------------------------------------------------------------
export async function acquirePatientLock(serverId, clientInstanceId, { session, settings } = {}) {
  return requestJson(`/api/patients/${serverId}/lock`, {
    baseUrl: getBaseUrl(session, settings),
    method:  'POST',
    session,
    body:    { clientInstanceId },
  });
}

// 토큰을 절대 회전시키지 않는다 — 응답에는 leaseToken이 없다({expiresAt, ttlMs}만).
export async function renewPatientLock(serverId, leaseToken, { session, settings } = {}) {
  return requestJson(`/api/patients/${serverId}/lock`, {
    baseUrl: getBaseUrl(session, settings),
    method:  'POST',
    session,
    headers: { 'X-Lock-Token': leaseToken },
    body:    {},
  });
}

// 무조건 선점 — 다른 사람이 보유 중이어도 항상 성공(사용자가 명시적으로 동의한 뒤에만 호출).
export async function forcePatientLock(serverId, clientInstanceId, { session, settings } = {}) {
  return requestJson(`/api/patients/${serverId}/lock?force=true`, {
    baseUrl: getBaseUrl(session, settings),
    method:  'POST',
    session,
    body:    { clientInstanceId },
  });
}

// 조회 전용, 부작용 없음. null | { holderName, acquiredAt, expiresAt }.
export async function peekPatientLock(serverId, { session, settings } = {}) {
  const data = await requestJson(`/api/patients/${serverId}/lock`, {
    baseUrl: getBaseUrl(session, settings),
    session,
  });
  return data?.lock ?? null;
}

// 토큰 불일치/락 없음도 서버가 204 no-op으로 처리 — 여기서도 에러를 던지지 않는다.
export async function releasePatientLock(serverId, leaseToken, { session, settings } = {}) {
  if (!leaseToken) return;
  await requestJson(`/api/patients/${serverId}/lock`, {
    baseUrl: getBaseUrl(session, settings),
    method:  'DELETE',
    session,
    headers: { 'X-Lock-Token': leaseToken },
  });
}

// 423(락 충돌: 획득 실패/renew 상실 모두 이 상태 코드를 씀 — 구분은 호출 맥락으로 한다).
export function isLockError(error) {
  return error?.status === 423;
}

// ---------------------------------------------------------------------------
// Batch push — send all 'local-only' and 'dirty' patients to the server.
// 'conflict' patients are skipped — they must be resolved via ConflictResolveModal first.
// 'synced' patients are skipped — no changes to push.
// Returns { synced: Patient[], failed: { patient, error }[] }
// ---------------------------------------------------------------------------
export async function pushPendingPatients(patients, { session, settings } = {}) {
  const pending = patients.filter(p => {
    if (isRedactedPatientRecord(p)) return false;
    // usePatientSync가 호출 전에 이미 syncPaused 환자를 걸러내지만("저장하지 않고 이동"),
    // 이 함수 자체가 그 불변조건을 스스로 지키도록 방어적으로 다시 확인한다 — 호출부가
    // 실수로 필터링 없이 넘겨도 paused 환자가 조용히 push되는 일이 없어야 한다.
    if (p.sync?.syncPaused) return false;
    const s = p.sync?.syncStatus;
    return s === 'local-only' || s === 'dirty';
  });

  const results = await Promise.allSettled(
    pending.map(p => pushPatient(p, { session, settings, leaseToken: getLockToken(p.id) }))
  );

  const synced = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      synced.push({ patient: pending[i], serverPatient: r.value });
    } else {
      failed.push({
        patient: pending[i],
        error:   r.reason,
        kind:    classifyPushFailureKind(r.reason),
      });
    }
  });

  return { synced, failed };
}

export function isConflictError(error) {
  return error?.status === 409;
}

// 권한 거부: 서버가 PATCH /:id에서 담당의/admin 아닌 호출자에게 403 반환.
// 일반 네트워크 에러와 구분해 사용자에게 "권한 없음" 메시지 표시용.
export function isPermissionDeniedError(error) {
  return error?.status === 403;
}

// 네트워크 자체 실패(오프라인 등): 브라우저 fetch()는 응답을 아예 받지 못하면 TypeError로
// reject한다(status 없음). TypeError로 좁혀 검사하는 이유: requestJson이 던지는 모든 HTTP
// 에러는 항상 error.status를 명시적으로 채우므로, status가 없는 "일반 Error"까지 전부
// offline으로 재분류하면 진짜 미분류 오류(kind: 'error')와 구분이 안 된다.
export function isNetworkError(error) {
  return error instanceof TypeError && typeof error.status !== 'number';
}

function classifyPushFailureKind(error) {
  if (isConflictError(error)) return 'conflict';
  if (isPermissionDeniedError(error)) return 'permission';
  if (isLockError(error)) return 'lock';
  if (isNetworkError(error)) return 'offline';
  return 'error';
}

// pushPendingPatients/flushPatient의 실패 kind → 환자 전환 판정에 쓰는 outcome 이름으로 매핑.
// (§7의 kind 분류를 여기서 재사용 — 새 분류 체계를 만들지 않는다.)
function classifyFailureKind(kind) {
  switch (kind) {
    case 'conflict':   return 'conflict';
    case 'permission': return 'permission';
    case 'lock':        return 'lock-lost';
    case 'offline':     return 'offline';
    default:            return 'error';
  }
}

// push 사이클이 커밋된 뒤(setPatients 반영 후)에만 호출해야 한다 — 커밋된 patient는
// mergePushedPatientAck가 서버 ACK로 이미 교체했으므로, 여기서 다시 "달라졌는지" 비교하지
// 않고 그 결과(syncStatus)를 그대로 읽기만 한다. 재비교하면 정상 저장까지 "다르다"고
// 오판한다(참조도, updatedAt도 항상 다르므로).
export function computeCommittedFlushOutcomes(committedPatients, { synced = [], failed = [] } = {}) {
  const outcomes = new Map();
  for (const { patient: pushedPatient } of synced) {
    const committed = committedPatients.find(p => p.id === pushedPatient.id);
    const status = committed?.sync?.syncStatus;
    outcomes.set(
      pushedPatient.id,
      status === 'synced' ? 'synced'
        : (status === 'dirty' || status === 'local-only') ? 'still-dirty'
        : status === 'conflict' ? 'conflict'
        : 'error'
    );
  }
  for (const f of failed) {
    if (!f.patient?.id) continue;
    outcomes.set(f.patient.id, classifyFailureKind(f.kind));
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Merge helpers — apply a server patient back into the local array.
//
// Match priority:
//   1. patient.id === serverPatient.id  (typical after push — same UUID)
//   2. patient.sync.serverId === serverPatient.sync.serverId  (pull path)
// If no match is found the server patient is appended (created on another device).
// The local patient's own id is always preserved on match.
// ---------------------------------------------------------------------------
export function mergeServerPatient(localPatients, serverPatient) {
  const serverId = serverPatient.sync?.serverId ?? serverPatient.id;
  const idx = localPatients.findIndex(
    p => p.id === serverPatient.id || (p.sync?.serverId && p.sync.serverId === serverId)
  );

  if (idx === -1) {
    return [...localPatients, serverPatient];
  }

  const local = localPatients[idx];
  const localStatus = local.sync?.syncStatus;
  const localRevision = local.sync?.revision ?? 0;
  const serverRevision = serverPatient.sync?.revision ?? 0;

  if (localStatus === 'dirty') {
    const merged = serverRevision > localRevision
      ? markPullConflict(local, serverPatient)
      : local;
    return localPatients.map((p, i) => (i === idx ? merged : p));
  }

  if (localStatus === 'conflict') {
    const merged = markPullConflict(local, serverPatient);
    return localPatients.map((p, i) => (i === idx ? merged : p));
  }

  const merged = applyServerSync(serverPatient, local.id, local.meta);
  return localPatients.map((p, i) => (i === idx ? merged : p));
}

// Decide whether the local patient was untouched while a push was in flight.
// If untouched, the ack is safe to apply as the authoritative server state.
// `pushedPatient` is the snapshot captured at push-call time. Reference equality
// is the strongest signal (setPatients always produces a new object on edit).
// updatedAt equality is a secondary signal that survives unrelated setPatients
// calls that re-create the array without touching this patient. When pushedPatient
// is missing (legacy callers), default to the conservative "still dirty" path.
function unchangedSincePush(local, pushedPatient) {
  if (!pushedPatient) return false;
  if (local === pushedPatient) return true;
  if (pushedPatient.updatedAt && local.updatedAt === pushedPatient.updatedAt) return true;
  return false;
}

// 충돌이 보고한 서버 revision이, 이쪽 쓰기(PATCH 성공·워크스페이스 저장)로 이미 도달한 revision 이하인가?
// 그렇다면 그 충돌은 같은 환자에 겹쳐 나간 이쪽의 다른 쓰기가 만든 것이다. 서버 revision은 단조 증가하므로
// 더 큰 revision을 보고한 충돌만 "그 뒤에 다른 사람이 썼다"는 진짜 충돌이다. 자동 PATCH와 워크스페이스 저장
// 응답이 어떤 순서로 도착해도 같은 상태로 수렴시키는 데 쓴다.
//
// 자동 해제는 "저장끼리의 충돌"(PATCH 409·워크스페이스 저장 충돌: kind 'push' + code 'CONFLICT')로만 제한한다.
// 삭제 충돌('delete')·원격 삭제·락('lock')·pull·신원 충돌 등은 같은 revision 숫자가 보고돼도 사용자가 직접
// 해결해야 하는 별개의 상태다 — 저장이 성공했다고 삭제 요청이 해결된 것은 아니므로(환자는 서버에 그대로 있다)
// 보존한다. 삭제 충돌도 code가 'CONFLICT'라서 code만으로는 구분되지 않고 kind로 가려야 한다.
function isConflictSupersededBy(conflict, writtenRevision) {
  return conflict?.kind === 'push'
    && conflict?.code === 'CONFLICT'
    && typeof conflict.serverRevision === 'number'
    && typeof writtenRevision === 'number'
    && conflict.serverRevision <= writtenRevision;
}

export function mergePushedPatientAck(localPatients, serverPatient, pushedPatient) {
  const serverId = serverPatient.sync?.serverId ?? serverPatient.id;
  const idx = localPatients.findIndex(
    p => p.id === serverPatient.id || (p.sync?.serverId && p.sync.serverId === serverId)
  );

  if (idx === -1) {
    return [...localPatients, serverPatient];
  }

  const local = localPatients[idx];
  // 워크스페이스 저장이 이 PATCH의 성공 응답보다 먼저 충돌 응답을 돌려줬더라도(서버는 이 PATCH를 먼저 처리했다),
  // 이 PATCH가 만든 revision이 그 충돌이 보고한 서버 revision 이상이면 충돌의 원인은 이 PATCH 자신이다 —
  // 충돌을 풀고 정상 적용한다. 보고된 revision이 더 크면 그 뒤에 다른 사람이 쓴 것이므로 충돌로 남긴다.
  const supersedesConflict = local.sync?.syncStatus === 'conflict'
    && isConflictSupersededBy(local.sync.conflict, serverPatient.sync?.revision);
  const localStatus = supersedesConflict ? 'dirty' : local.sync?.syncStatus;

  if (localStatus === 'dirty') {
    if (unchangedSincePush(local, pushedPatient)) {
      // No edits since push started — converge to synced using the server echo
      // so doctorName/warnings/normalized payload all land in local state.
      const merged = applyServerSync(serverPatient, local.id, local.meta);
      return localPatients.map((p, i) => (i === idx ? merged : p));
    }

    // Edits arrived during push — preserve local data, bump revision/serverId
    // so the next push uses the latest If-Match.
    const serverWarnings = Array.isArray(serverPatient.sync?.warnings)
      ? serverPatient.sync.warnings
      : [];
    const { warnings: _warnings, conflict: _conflict, ...localSyncWithoutWarnings } = local.sync || {};
    const merged = {
      ...local,
      sync: {
        ...localSyncWithoutWarnings,
        serverId,
        revision: serverPatient.sync?.revision ?? local.sync?.revision ?? 0,
        syncStatus: 'dirty',
        lastSyncedAt: serverPatient.sync?.lastSyncedAt ?? local.sync?.lastSyncedAt ?? null,
        ...(serverWarnings.length > 0 ? { warnings: serverWarnings } : {}),
      },
    };
    return localPatients.map((p, i) => (i === idx ? merged : p));
  }

  if (localStatus === 'conflict') {
    return localPatients;
  }

  const merged = applyServerSync(serverPatient, local.id, local.meta);
  return localPatients.map((p, i) => (i === idx ? merged : p));
}

// ---------------------------------------------------------------------------
// 충돌 표시 + 워크스페이스 저장 응답 반영 (HF1)
// ---------------------------------------------------------------------------

// PATCH 충돌(409)/락(423) 실패를 로컬 환자의 sync.conflict로 바꾸는 순수 함수 두 개 — usePatientSync가
// 쓰던 것을 그대로 옮겼다(동작 변경 없음). 워크스페이스 저장 결과도 같은 모양으로 걸어 기존 충돌 해결
// UI(ConflictResolveModal)를 재사용한다.
function buildPushConflict(failure) {
  const data = failure?.error?.data || {};
  return {
    kind: failure.kind === 'lock' ? 'lock' : 'push',
    code: data.code || null,
    message: failure?.error?.message || data.error || null,
    serverRevision: data.currentRevision ?? null,
    holder: data.holder ?? null,
  };
}

// 'lock'(423 — 다른 사람이 활발히 편집 중이라 이번 저장이 거절됨)도 'conflict'와 같은 방식으로
// syncStatus를 표시한다 — 둘 다 "지금은 저장할 수 없다"는 점에서 동일한 사용자 대응(Resolve/재확인)이
// 필요하기 때문. 무한 재시도로 조용히 반복 실패하는 것을 막는다.
export function applyPushFailures(localPatients, failures) {
  const localById = new Map(localPatients.map(p => [p.id, p]));
  const conflictById = new Map(
    failures
      .filter(f => (f.kind === 'conflict' || f.kind === 'lock') && f.patient?.id)
      // 이 실패보다 먼저 도착한 다른 응답(워크스페이스 저장 성공 등)으로 환자가 이미 그 서버 revision 이상에
      // 도달했다면 실패 응답은 오래된 것이다 — 충돌로 표시하지 않고 dirty로 둬서 새 revision으로 다음 저장이 재시도한다.
      .filter(f => f.kind !== 'conflict'
        || !isConflictSupersededBy(buildPushConflict(f), localById.get(f.patient.id)?.sync?.revision))
      .map(f => [f.patient.id, buildPushConflict(f)])
  );

  if (conflictById.size === 0) return localPatients;

  return localPatients.map(patient => {
    const conflict = conflictById.get(patient.id);
    if (!conflict) return patient;
    // 사용자가 요청한 삭제의 충돌은 저장 실패 응답으로 덮어쓰지 않는다 — 삭제 재시도라는 해결 경로가 사라진다.
    if (patient.sync?.conflict?.kind === 'delete') return patient;
    return {
      ...patient,
      sync: {
        ...(patient.sync || {}),
        syncStatus: 'conflict',
        conflict,
      },
    };
  });
}

function findLocalIndexByServerId(localPatients, serverId) {
  return localPatients.findIndex(p => p.id === serverId || (p.sync?.serverId && p.sync.serverId === serverId));
}

// 워크스페이스 저장 응답(ack)을 로컬 환자 상태에 반영한다.
//  - saved: 서버가 확정한 revision을 sync에 싣는다. 저장 도중 편집됐다면(unchangedSincePush 아님) 로컬 데이터는
//    그대로 두고 dirty로 남긴다 — 다음 자동 저장이 새 revision으로 PATCH한다(serverId가 생겼으므로 POST가 아니다).
//    mergePushedPatientAck는 local-only 환자를 편집 검사 없이 서버 에코로 교체하므로 여기서는 쓰지 않는다.
//  - conflicts / lockedByOther: PATCH 충돌(409/423)과 같은 모양으로 sync.conflict를 건다.
//  - skipped: 환자 상태는 건드리지 않는다(알림만 — buildSaveAckMessage).
//  - saved의 assignedDoctorUserId도 환자에 싣는다. canEditPatient는 담당의 정보가 없으면 local-only에서만 임시
//    편집을 허용하므로, synced로 바꾸면서 이 값을 안 채우면 방금 저장한 본인 환자가 다음 pull까지 읽기 전용이 된다.
//  - 요청을 보낸 뒤 이 환자의 서버 revision이 움직였다면(자동 PATCH 성공·pull 병합) 응답은 오래된 것이라 무시한다 —
//    그대로 적용하면 revision이 거꾸로 가거나 이미 해결된 환자가 다시 충돌로 표시된다.
// sentPatients는 저장 호출에 넘긴 배열(편집 여부 비교용 스냅샷)이다.
export function applyWorkspaceSaveAck(localPatients, sentPatients, ack) {
  if (!ack) return localPatients;
  let next = localPatients;

  // 서버 id로 현재 로컬 환자를 찾되, 요청 시점과 revision이 달라졌으면(오래된 응답) 없는 것으로 취급한다.
  const freshLocal = serverId => {
    const local = next[findLocalIndexByServerId(next, serverId)];
    if (!local) return undefined;
    const sent = sentPatients.find(p => p.id === local.id);
    return sent && (local.sync?.revision ?? 0) !== (sent.sync?.revision ?? 0) ? undefined : local;
  };

  for (const { id, revision, assignedDoctorUserId } of ack.saved || []) {
    const local = freshLocal(id);
    if (!local) continue;
    // 해결 전 충돌은 건드리지 않는다 — 단, 충돌이 보고한 서버 revision이 이 저장이 만든 revision 이하이면 그 충돌은
    // 이 저장이 만든 것이다(자동 PATCH의 실패 응답이 먼저 도착한 경우). 풀고 정상 적용한다.
    if (local.sync?.syncStatus === 'conflict' && !isConflictSupersededBy(local.sync.conflict, revision)) continue;
    const pushed = sentPatients.find(p => p.id === local.id) || null;
    const syncStatus = unchangedSincePush(local, pushed) ? 'synced' : 'dirty';
    const { conflict: _conflict, ...syncWithoutConflict } = local.sync || {};
    const updated = {
      ...local,
      ...(assignedDoctorUserId !== undefined ? { assignedDoctorUserId } : {}),
      sync: { ...syncWithoutConflict, serverId: id, revision, syncStatus, lastSyncedAt: new Date().toISOString() },
    };
    next = next.map(p => (p.id === local.id ? updated : p));
  }

  const failures = [
    ...(ack.conflicts || []).map(({ id, serverRevision }) => ({
      kind: 'conflict', patient: { id: freshLocal(id)?.id }, error: { data: { code: 'CONFLICT', currentRevision: serverRevision } },
    })),
    ...(ack.lockedByOther || []).map(({ id, holder }) => ({
      kind: 'lock', patient: { id: freshLocal(id)?.id }, error: { data: { code: 'LOCK_HELD', holder } },
    })),
  ];
  return applyPushFailures(next, failures);
}

function markPullConflict(localPatient, serverPatient) {
  const existingConflict = localPatient.sync?.conflict || {};
  return {
    ...localPatient,
    sync: {
      ...(localPatient.sync || {}),
      syncStatus: 'conflict',
      conflict: {
        ...existingConflict,
        kind: existingConflict.kind || 'pull',
        serverPatient,
        serverRevision: serverPatient.sync?.revision ?? null,
      },
    },
  };
}

export function mergePulledPatients(localPatients, pulledItems) {
  let result = localPatients;
  for (const serverPatient of pulledItems) {
    result = mergeServerPatient(result, serverPatient);
  }
  return result;
}
