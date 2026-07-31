import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  mergePulledPatients,
  mergePushedPatientAck,
  pullPatients,
  pushPendingPatients,
  computeCommittedFlushOutcomes,
} from '../services/patientServerRepository';
import { isRedactedPatientRecord } from '../services/patientRecords';
import { getLockToken } from '../services/lockTokenStore';
import { requiresLock } from './usePatientLock';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const PUSH_DEBOUNCE_MS = 1000;
const PULL_PAGE_SIZE = 100;

function hasPendingPatients(patients = []) {
  return patients.some(p => {
    if (isRedactedPatientRecord(p)) return false;
    if (p?.sync?.syncPaused) return false; // "저장하지 않고 이동" — 자동저장 대상에서 제외
    const status = p?.sync?.syncStatus;
    return status === 'local-only' || status === 'dirty';
  });
}

function applySyncedPatients(localPatients, syncedPairs) {
  return syncedPairs.reduce(
    (next, { patient: pushedPatient, serverPatient }) =>
      mergePushedPatientAck(next, serverPatient, pushedPatient),
    localPatients
  );
}

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
function applyPushFailures(localPatients, failures) {
  const conflictById = new Map(
    failures
      .filter(f => (f.kind === 'conflict' || f.kind === 'lock') && f.patient?.id)
      .map(f => [f.patient.id, buildPushConflict(f)])
  );

  if (conflictById.size === 0) return localPatients;

  return localPatients.map(patient => {
    const conflict = conflictById.get(patient.id);
    if (!conflict) return patient;
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

// 활성 환자에 한해서만 락 상태를 근거로 push 허용 여부를 판정한다(비활성 dirty 환자는 항상
// allowed:true — opt-in 호환. 토큰이 없어도 서버가 그 환자에 활성 락이 없으면 통과시킨다).
//
// syncPaused는 activeId 여부와 무관하게 최우선으로 확인한다 — "저장하지 않고 이동"은 정확히
// 그 환자가 활성 상태가 아니게 된 시점에 거는 플래그라서, activeId 분기보다 뒤에 두면 비활성
// 환자에게는 이 게이트가 아예 적용되지 않는 버그가 된다.
//
// lockState.status === 'none'은 usePatientLock이 "이 환자는 애초에 락 대상이 아니다"라고
// 이미 판정한 결과(로컬 전용이거나 비인트라넷 세션)이므로, 여기서 다시 session/serverId를
// 확인하지 않고 그대로 신뢰한다.
export function getPushEligibility(patientId, { activeId, lockState, patient } = {}) {
  if (patient?.sync?.syncPaused) return { allowed: false, reason: 'sync-paused' };
  if (patientId !== activeId) return { allowed: true };
  const status = lockState?.status;
  if (status === 'none') return { allowed: true };
  if (status === 'held') {
    // 'held'인데 레지스트리에 토큰이 아직 없는(레이스로 setLockToken 전인) 순간을 방어적으로
    // 걸러 토큰 없는 PATCH가 나가는 걸 막는다.
    return getLockToken(patientId) != null
      ? { allowed: true }
      : { allowed: false, reason: 'bootstrap-pending' };
  }
  if (status === 'held-by-other') return { allowed: false, reason: 'lock-held-by-other' };
  if (status === 'lost') return { allowed: false, reason: 'lock-lost' };
  return { allowed: false, reason: 'bootstrap-pending' }; // 'acquiring' 등 아직 결론 안 남
}

export function reconcilePulledPatients(localPatients, pulledItems, { authoritativeDeletes = true } = {}) {
  const pulledServerIds = new Set(
    pulledItems
      .map(patient => patient?.sync?.serverId || patient?.id)
      .filter(Boolean)
  );

  const merged = mergePulledPatients(localPatients, pulledItems);

  return merged
    .map(patient => {
      if (!authoritativeDeletes) return patient;
      const serverId = patient?.sync?.serverId;
      if (!serverId || pulledServerIds.has(serverId)) return patient;

      if (patient.sync?.syncStatus === 'dirty') {
        return {
          ...patient,
          sync: {
            ...(patient.sync || {}),
            syncStatus: 'conflict',
            conflict: {
              ...(patient.sync?.conflict || {}),
              kind: 'remote-delete',
              serverRevision: null,
            },
          },
        };
      }

      return patient;
    })
    .filter(patient => {
      const serverId = patient?.sync?.serverId;
      if (!serverId || pulledServerIds.has(serverId)) return true;
      if (!authoritativeDeletes) {
        // scope=mine: remove synced (out-of-scope), keep dirty/conflict (not a real delete)
        const status = patient.sync?.syncStatus;
        return status === 'dirty' || status === 'conflict';
      }
      return patient.sync?.syncStatus !== 'synced';
    });
}

async function pullAllPatients({ session, settings, scope = 'mine' }) {
  const all = [];
  let offset = 0;
  let total = null;
  let unassignedCount;
  let orgPatientCount;

  do {
    const result = await pullPatients({
      session,
      settings,
      params: { limit: PULL_PAGE_SIZE, offset, scope },
    });
    const items = result.items || [];
    all.push(...items);
    total = typeof result.total === 'number' ? result.total : all.length;
    if (typeof result.unassignedCount === 'number') unassignedCount = result.unassignedCount;
    if (typeof result.orgPatientCount === 'number') orgPatientCount = result.orgPatientCount;
    offset += items.length;
    if (items.length === 0) break;
  } while (all.length < total);

  return { items: all, unassignedCount, orgPatientCount };
}

export function usePatientSync({
  patients,
  setPatients,
  activeId,
  setActiveId,
  session,
  settings,
  enabled = true,
  scope = 'mine',
  // usePatientLock의 lockState를 읽기 전용으로만 받는다 — 이 훅은 usePatientLock을 호출하지
  // 않고, 콜백도 주고받지 않는다. 연결은 App.jsx의 별도 effect가 lockState 전이를 관찰해 담당.
  lockState = { status: 'none', holder: null, expiresAt: null },
} = {}) {
  const [syncState, setSyncState] = useState({
    status: 'idle',
    lastSyncedAt: null,
    lastError: null,
    serverUnassignedCount: null,
    serverPatientCount: null,
    // Scope of the patient data currently loaded into `patients`. Updated only after a
    // successful pull swaps the data — used to detect an in-flight dashboard scope change
    // (see Dashboard loading state). null until the first successful pull.
    loadedScope: null,
  });

  const patientsRef = useRef(patients || []);
  const activeIdRef = useRef(activeId || null);
  const sessionRef = useRef(session || null);
  const settingsRef = useRef(settings || null);
  const enabledRef = useRef(false);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(null);
  const lockStateRef = useRef(lockState);

  // flushPatient/커밋 배리어 상태 — 모두 ref/effect로만 다뤄서 리렌더를 유발하지 않는다
  // (outcomeTick만 예외: post-commit effect를 확실히 재실행시키기 위한 트리거).
  const cycleCounterRef = useRef(0);
  const flushWaitersRef = useRef(new Map()); // patientId -> [{ resolve, targetCycleId }]
  const pendingPushResultsRef = useRef([]); // [{ cycleId, synced, failed }]
  const pendingCommitRef = useRef(null); // null | (() => void) — 현재 대기 중인 커밋 배리어의 resolve
  const [outcomeTick, setOutcomeTick] = useState(0);

  const canSync = useMemo(() => (
    enabled &&
    session?.mode === 'intranet' &&
    !!session?.user?.id &&
    !!session?.accessToken
  ), [
    enabled,
    session?.mode,
    session?.user?.id,
    session?.accessToken,
  ]);

  const scopeRef = useRef(scope);

  enabledRef.current = canSync;
  useEffect(() => { patientsRef.current = patients || []; }, [patients]);
  useEffect(() => { activeIdRef.current = activeId || null; }, [activeId]);
  useEffect(() => { sessionRef.current = session || null; }, [session]);
  useEffect(() => { settingsRef.current = settings || null; }, [settings]);
  useEffect(() => { enabledRef.current = canSync; }, [canSync]);
  useEffect(() => { scopeRef.current = scope; }, [scope]);
  useEffect(() => { lockStateRef.current = lockState; }, [lockState]);

  const ensureActivePatient = useCallback((before, after) => {
    if (activeIdRef.current || before.length > 0 || after.length === 0 || !setActiveId) {
      return;
    }
    queueMicrotask(() => {
      if (!activeIdRef.current) setActiveId(after[0].id);
    });
  }, [setActiveId]);

  const runSync = useCallback(async ({
    push = false,
    pull = false,
    reason = 'manual',
  } = {}) => {
    if (!enabledRef.current) return null;

    if (inFlightRef.current) {
      queuedRef.current = {
        push: Boolean(queuedRef.current?.push || push),
        pull: Boolean(queuedRef.current?.pull || pull),
        reason,
      };
      return null;
    }

    inFlightRef.current = true;
    setSyncState(prev => ({ ...prev, status: 'syncing', lastError: null }));

    // 이번 sync에서 발생한 permission failure 수. push가 실제 발생하지 않으면 0 유지.
    // 종료부에서 lastSyncedAt setState와 함께 한 번에 반영해 push-only/pull-only/both 모두 일관 처리.
    let permissionDeniedCount = 0;

    try {
      if (push) {
        const snapshot = patientsRef.current;
        if (hasPendingPatients(snapshot)) {
          // 환자마다 개별 판정한다 — 활성 환자는 락 상태로, 비활성 환자는 opt-in 그대로
          // 허용하되 syncPaused("저장하지 않고 이동")만은 활성 여부와 무관하게 제외한다.
          const pushTargets = snapshot.filter(p => getPushEligibility(p.id, {
            activeId: activeIdRef.current,
            lockState: lockStateRef.current,
            patient: p,
          }).allowed);

          // 보낼 게 아예 없으면(예: 유일한 dirty 환자가 게이트로 제외됨) 네트워크 호출 자체를
          // 생략한다(사이클 번호도 소모하지 않음).
          if (pushTargets.length > 0) {
            const myCycleId = ++cycleCounterRef.current;
            const { synced, failed } = await pushPendingPatients(pushTargets, {
              session: sessionRef.current,
              settings: settingsRef.current,
            });

            if (!enabledRef.current) {
              setSyncState(prev => ({ ...prev, status: 'idle' }));
              return null;
            }

            if (synced.length > 0 || failed.length > 0) {
              if (synced.length > 0 || failed.some(f => f.kind === 'conflict' || f.kind === 'lock')) {
                setPatients(prev => {
                  const withSynced = applySyncedPatients(prev, synced);
                  return applyPushFailures(withSynced, failed);
                });
              }
              // flushPatient 호출자에게 이번 사이클의 결과를 알리기 위한 예약 — 실제 판정은
              // patients 커밋 이후에만 실행이 보장되는 post-commit effect에서 처리한다
              // (updater 함수 자체는 순수 병합만 하고 부수효과를 갖지 않아야 하므로).
              pendingPushResultsRef.current.push({ cycleId: myCycleId, synced, failed });
              setOutcomeTick(t => t + 1);
              // 이 사이클은 자신이 만든 커밋(또는 결과)이 post-commit effect에서 실제로 처리될
              // 때까지 기다린다 — 그래야 finally에서 큐잉된 다음 사이클을 시작해도
              // patientsRef가 이미 최신이라, 방금 성공한 걸 stale revision으로 재전송해
              // 가짜 409를 만드는 일이 없다.
              await new Promise(resolve => { pendingCommitRef.current = resolve; });
            }

            permissionDeniedCount = failed.filter(f => f.kind === 'permission').length;
            if (permissionDeniedCount > 0) {
              console.warn(`[sync] ${permissionDeniedCount}건의 환자가 권한 없음으로 동기화되지 않았습니다.`);
            }

            // conflict/permission/lock 외 진짜 에러만 throw → 일반 실패 알림 흐름.
            // lock은 conflict와 동일하게 patient.sync에 이미 반영했으므로(위) 별도로 던지지 않는다.
            const realFailure = failed.find(f => !['conflict', 'permission', 'lock'].includes(f.kind));
            if (realFailure) throw realFailure.error;
          }
        }
      }

      let serverUnassignedCount;
      let serverPatientCount;
      let appliedScope; // pull 결과가 실제로 `patients`에 반영된 스코프 (stale이면 미반영)
      if (pull) {
        const pulledScope = scopeRef.current;
        const { items: pulledItems, unassignedCount, orgPatientCount } = await pullAllPatients({
          session:  sessionRef.current,
          settings: settingsRef.current,
          scope:    pulledScope,
        });
        if (typeof unassignedCount === 'number') serverUnassignedCount = unassignedCount;
        if (typeof orgPatientCount === 'number') serverPatientCount = orgPatientCount;
        if (!enabledRef.current) {
          setSyncState(prev => ({ ...prev, status: 'idle' }));
          return null;
        }
        // Stale-pull 가드: pull 진행 중 스코프가 바뀌었으면(A→B) A 결과를 B 기준으로
        // 적용하지 않는다. 특히 좁은 pull(mine/doctor-id)이 all 화면의 synced 환자를
        // out-of-scope로 축출하는 사고를 막는다. 스코프 변경 시 queued sync가
        // 현재 스코프로 재-pull하므로 skip해도 안전하다.
        // authoritativeDeletes도 live scopeRef가 아니라 pulledScope로 판정(방어).
        if (pulledScope === scopeRef.current) {
          appliedScope = pulledScope;
          setPatients(prev => {
            const next = reconcilePulledPatients(prev, pulledItems, { authoritativeDeletes: pulledScope === 'all' });
            ensureActivePatient(prev, next);
            if (activeIdRef.current && !next.some(p => p.id === activeIdRef.current)) {
              queueMicrotask(() => {
                if (activeIdRef.current && !next.some(p => p.id === activeIdRef.current)) {
                  setActiveId?.(next[0]?.id || null);
                }
              });
            }
            return next;
          });
        }
      }

      const lastSyncedAt = new Date().toISOString();
      // 권한 거부 배너 통합 처리: push/pull 어느 쪽이든 성공 종료 시 stale 정리.
      // - permission failure 있었음 → count/timestamp 갱신
      // - 없거나 push가 안 일어남 → 이전에 남아있던 카운트를 0으로 clear (pull-only sync 포함)
      setSyncState(prev => ({
        ...prev,
        status: 'idle',
        lastSyncedAt,
        lastError: null,
        ...(typeof serverUnassignedCount === 'number' ? { serverUnassignedCount } : {}),
        ...(typeof serverPatientCount    === 'number' ? { serverPatientCount }    : {}),
        // 실제로 반영된 pull에 대해서만 loadedScope 갱신 (stale pull은 제외).
        ...(appliedScope !== undefined ? { loadedScope: appliedScope } : {}),
        ...(permissionDeniedCount > 0
          ? { lastPermissionDeniedCount: permissionDeniedCount, lastPermissionDeniedAt: lastSyncedAt }
          : (prev.lastPermissionDeniedCount
              ? { lastPermissionDeniedCount: 0, lastPermissionDeniedAt: null }
              : {})),
      }));
      return { ok: true, reason, lastSyncedAt };
    } catch (error) {
      console.warn('[patient-sync]', reason, error);
      setSyncState(prev => ({
        ...prev,
        status: 'error',
        lastError: error?.message || 'Patient sync failed',
      }));
      return { ok: false, reason, error };
    } finally {
      inFlightRef.current = false;
      const queued = queuedRef.current;
      queuedRef.current = null;
      if (queued && enabledRef.current) {
        queueMicrotask(() => { runSync(queued); });
      }
    }
  }, [ensureActivePatient, setActiveId, setPatients]);

  useEffect(() => {
    if (!canSync) return;
    runSync({ push: true, pull: true, reason: 'startup' });
  }, [canSync, runSync]);

  // Re-pull when scope changes (mine ↔ all).
  const prevScopeRef = useRef(scope);
  useEffect(() => {
    if (prevScopeRef.current === scope) return;
    prevScopeRef.current = scope;
    if (!canSync) return;
    runSync({ pull: true, reason: 'scope-change' });
  }, [scope, canSync, runSync]);

  useEffect(() => {
    if (!canSync) return;
    const timer = window.setInterval(() => {
      runSync({ push: true, pull: true, reason: 'interval' });
    }, SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [canSync, runSync]);

  useEffect(() => {
    if (!canSync) return;

    const onFocus = () => {
      runSync({ pull: true, reason: 'focus' });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runSync({ pull: true, reason: 'visible' });
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [canSync, runSync]);

  useEffect(() => {
    if (!canSync || !hasPendingPatients(patients || [])) return;
    const timer = window.setTimeout(() => {
      runSync({ push: true, pull: true, reason: 'local-change' });
    }, PUSH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [canSync, patients, runSync]);

  // "저장하지 않고 이동"으로 걸어둔 syncPaused는, 그 환자를 다시 열었을 때(activeId가 그
  // 환자가 됨) 다음 중 하나면 해제해야 한다 — 그렇지 않으면 재진입 후에도 영구히 자동저장
  // 대상에서 빠진 채로 남는다(특히 local-only 환자: requiresLock이 애초에 false라
  // lockState가 절대 'held'로 전이하지 않으므로, 'held' 전이만 기다리는 방식으로는 이
  // 경우를 절대 처리할 수 없다):
  //   (a) 이 환자가 애초에 락 대상이 아님(local-only/비인트라넷) — requiresLock() === false
  //   (b) 락 대상이지만 재획득에 성공함 — lockState.status === 'held'
  // patients/activeId를 deps에 직접 두지 않고 updater 안에서 최신 prev를 읽는다 — 아무 것도
  // 안 바뀌면 prev를 그대로 반환해(참조 동일) React가 리렌더 자체를 건너뛰게 한다.
  useEffect(() => {
    if (!activeId) return;
    const lockStatus = lockStateRef.current?.status;
    setPatients(prev => {
      const current = prev.find(p => p.id === activeId);
      if (!current?.sync?.syncPaused) return prev;
      const stillBlocked = requiresLock(current, sessionRef.current) && lockStatus !== 'held';
      if (stillBlocked) return prev;
      return prev.map(p => (
        p.id === activeId ? { ...p, sync: { ...p.sync, syncPaused: false } } : p
      ));
    });
  }, [activeId, lockState?.status, setPatients]);

  // post-commit: 이번 렌더의 patients(=committed state)를 근거로 대기 중인 flushPatient
  // 호출들을 확정 판정한다. runSync의 setPatients updater 내부에서 직접 resolve하지 않는
  // 이유: React updater는 순수해야 하고, 커밋된 patient는 mergePushedPatientAck가 서버
  // ACK로 이미 교체했으므로 여기서 다시 비교하면 정상 저장까지 "다르다"고 오판한다 —
  // computeCommittedFlushOutcomes가 이미 끝난 판정을 그대로 읽기만 한다.
  useEffect(() => {
    if (pendingPushResultsRef.current.length === 0) return;
    const results = pendingPushResultsRef.current.splice(0);

    // patientId -> 가장 최근(가장 큰 cycleId) outcome. 여러 사이클의 결과가 한 effect
    // 실행에 몰려 있을 수 있으므로(예: 빠른 연속 push) 항상 최신 것으로 덮어쓴다.
    const latestByPatient = new Map();
    for (const r of results) {
      const outcomes = computeCommittedFlushOutcomes(patients, r);
      for (const [id, outcome] of outcomes) {
        const prevEntry = latestByPatient.get(id);
        if (!prevEntry || r.cycleId > prevEntry.cycleId) latestByPatient.set(id, { cycleId: r.cycleId, outcome });
      }
    }

    for (const [patientId, waiters] of flushWaitersRef.current) {
      const entry = latestByPatient.get(patientId);
      if (!entry) continue;
      const remaining = waiters.filter(w => {
        if (entry.cycleId < w.targetCycleId) return true; // 아직 내 목표 cycle 전 — 계속 대기
        w.resolve(entry.outcome);
        return false;
      });
      if (remaining.length > 0) flushWaitersRef.current.set(patientId, remaining);
      else flushWaitersRef.current.delete(patientId);
    }

    // 배리어를 풀기 직전에 patientsRef도 이 effect가 직접 갱신한다 — 다른 effect(:206)의
    // 등록 순서에 기대지 않기 위한 방어적 조치.
    patientsRef.current = patients;
    if (pendingCommitRef.current) {
      pendingCommitRef.current();
      pendingCommitRef.current = null;
    }
  }, [outcomeTick, patients]);

  // 두 번째 안전망: push 사이클과 무관하게, patients가 바뀔 때마다 이미 결론이 난
  // (synced/conflict) 상태로 대기 중인 waiter를 정리한다 — pull 등 다른 경로로 상태가
  // 정리된 경우까지 포괄. cycleId 비교가 필요 없다 — "확정적으로 끝났다"고 읽을 수 있는
  // 상태만 다루므로, 아직 dirty인 채로는 무엇도 resolve하지 않는다.
  useEffect(() => {
    if (flushWaitersRef.current.size === 0) return;
    for (const [patientId, waiters] of flushWaitersRef.current) {
      const p = patients.find(x => x.id === patientId);
      const status = p?.sync?.syncStatus;
      if (status === 'synced') {
        waiters.forEach(w => w.resolve('synced'));
        flushWaitersRef.current.delete(patientId);
      } else if (status === 'conflict') {
        waiters.forEach(w => w.resolve('conflict'));
        flushWaitersRef.current.delete(patientId);
      }
    }
  }, [patients]);

  // 진짜 종료 사유(동기화 비활성화, 언마운트)에서만 남은 waiter를 일괄 정리해 무한 대기를
  // 막는다. 일반 사이클 종료(finally)에서는 정리하지 않는다 — 위 두 effect가 결국 모든
  // 정상 경로를 처리한다. canSync가 true↔false 어느 방향으로 바뀌든, 또는 언마운트 시
  // 항상 같은 정리를 실행한다(비어있으면 no-op이라 안전).
  useEffect(() => {
    return () => {
      // ref.current를 cleanup 시점에 읽는 것이 의도다(effect 등록 시점 값을 캡처하는 DOM
      // ref 패턴과 다름) — exhaustive-deps의 "복사해서 써라" 권고는 이 경우 적용되지 않는다.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const waiters of flushWaitersRef.current.values()) waiters.forEach(w => w.resolve('error'));
      flushWaitersRef.current.clear();
      if (pendingCommitRef.current) {
        pendingCommitRef.current();
        pendingCommitRef.current = null;
      }
    };
  }, [canSync]);

  // 환자 전환 등에서 "저장이 끝날 때까지 기다렸다가 진행" 하기 위한 예약 함수 — 새 PATCH를
  // 독자적으로 실행하지 않고 기존 autosync 큐(runSync)에 합류한다. 그렇지 않으면 마침 같은
  // 순간 실행 중인 autosync와 같은 revision으로 동시에 PATCH해 가짜 충돌(409)이 생긴다.
  const flushPatient = useCallback((patientId) => {
    const current = patientsRef.current.find(p => p.id === patientId);
    if (!current) return Promise.resolve('error');
    if (current.sync?.syncStatus === 'conflict') return Promise.resolve('conflict');

    const eligibility = getPushEligibility(patientId, {
      activeId: activeIdRef.current,
      lockState: lockStateRef.current,
      patient: current,
    });
    // held-by-other/lost/sync-paused는 push를 시도할 이유 자체가 없으므로 즉시 확정.
    // bootstrap-pending(peeking/acquiring)만은 예외 — waiter를 등록해 대기한다.
    if (!eligibility.allowed && eligibility.reason !== 'bootstrap-pending') {
      return Promise.resolve('lock-lost');
    }
    if (current.sync?.syncStatus !== 'dirty' && current.sync?.syncStatus !== 'local-only') {
      return Promise.resolve('synced');
    }
    // 동기화 자체가 꺼져 있으면 push 사이클이 영원히 오지 않는다 — waiter를 등록해 무한
    // 대기시키지 않고 즉시 실패로 확정한다.
    if (!enabledRef.current) return Promise.resolve('error');

    return new Promise(resolve => {
      const targetCycleId = cycleCounterRef.current + 1; // "지금부터 새로 시작되는 사이클"만 나를 만족시킴
      const waiters = flushWaitersRef.current.get(patientId) || [];
      flushWaitersRef.current.set(patientId, [...waiters, { resolve, targetCycleId }]);
      runSync({ push: true, reason: 'flush' }); // in-flight면 기존 queuedRef 병합 동작 그대로
    });
  }, [runSync]);

  // usePatientLock이 활성 환자에 대해 held-by-other/lost/403/acquire 네트워크 실패로
  // "확정"되면(§4-4의 재-flush 트리거가 절대 오지 않는 종결 상태) App.jsx가 이 함수를 호출해
  // bootstrap-pending으로 대기 중이던 waiter를 직접 정리한다 — 그렇지 않으면 push 사이클이
  // 영원히 안 올 waiter가 비활성화/언마운트까지 남는다.
  const notifyLockOutcome = useCallback((patientId, outcome) => {
    const waiters = flushWaitersRef.current.get(patientId);
    if (!waiters) return;
    waiters.forEach(w => w.resolve(outcome));
    flushWaitersRef.current.delete(patientId);
  }, []);

  return {
    syncState,
    syncNow: runSync,
    flushPatient,
    notifyLockOutcome,
  };
}
