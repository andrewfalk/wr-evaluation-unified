import { requestJson } from './httpClient';
import { isRedactedPatientRecord } from './patientRecords';
import { requireSyncedServerId } from './videoAnalysisClient';
import { getLockToken } from './lockTokenStore';

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
    },
  });
  return applyServerSync(data, patient.id, patient.meta);
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
    body: { data: computedData, appliedInputsHash, appliedInputsCount, sourceAnalysisJobIds },
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

export function mergePushedPatientAck(localPatients, serverPatient, pushedPatient) {
  const serverId = serverPatient.sync?.serverId ?? serverPatient.id;
  const idx = localPatients.findIndex(
    p => p.id === serverPatient.id || (p.sync?.serverId && p.sync.serverId === serverId)
  );

  if (idx === -1) {
    return [...localPatients, serverPatient];
  }

  const local = localPatients[idx];
  const localStatus = local.sync?.syncStatus;

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
    const { warnings: _warnings, ...localSyncWithoutWarnings } = local.sync || {};
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
