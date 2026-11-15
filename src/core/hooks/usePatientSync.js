// @ts-nocheck
// 환자 동기화 훅 — 얇은 훅(REFACTORING_ROADMAP Phase 2 게이트 B P2-41d). 본체는 React 밖 엔진 src/core/sync/patientSyncEngine.ts,
// 이 훅은 입력(ref)과 트리거(effect)만 — 엔진은 스토어를 구독하지 않고 타이머·리스너도 없다(계획 B6). effect 순서·시점은 그대로.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPatientSyncEngine, hasPendingPatients } from '../sync/patientSyncEngine';
import { hasIntranetSession } from '../../platform/dataMode';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const PUSH_DEBOUNCE_MS = 1000;

// 테스트·호출부 import 경로 유지 — getPushEligibility는 엔진(P2-41d), reconcilePulledPatients는 repository(P2-39)에 있다.
export { getPushEligibility } from '../sync/patientSyncEngine';
export { reconcilePulledPatients } from '../services/patientServerRepository';

// 엔진이 호출 시점에 읽는 입력 — ref 묶음을 받아 그때의 값을 낸다(렌더 중에는 읽지 않는다).
function inputsGetter({ sessionRef, settingsRef, scopeRef, lockStateRef, enabledRef }) {
  return () => ({ session: sessionRef.current, settings: settingsRef.current, scope: scopeRef.current, lockState: lockStateRef.current, enabled: enabledRef.current });
}

export function usePatientSync({
  // patients·activeId는 effect 트리거용 렌더 값. 동기화 판정은 store(환자 상태 컨테이너, P2-40a)의 앞선 상태로(P2-41c).
  patients,
  activeId,
  store,
  session,
  settings,
  enabled = true,
  scope = 'mine',
  // usePatientLock의 lockState(읽기 전용) — 연결은 App.jsx의 별도 effect가 lockState 전이를 관찰해 담당.
  lockState = { status: 'none', holder: null, expiresAt: null },
} = {}) {
  const [syncState, setSyncState] = useState({
    status: 'idle',
    lastSyncedAt: null,
    lastError: null,
    serverUnassignedCount: null,
    serverPatientCount: null,
    // 지금 `patients`에 실린 데이터의 scope — 실제로 반영된 pull 뒤에만 갱신(대시보드 scope 변경 로딩 판정용), 첫 pull 전 null.
    loadedScope: null,
  });

  const canSync = useMemo(() => (
    enabled &&
    hasIntranetSession(session) &&
    !!session?.user?.id &&
    !!session?.accessToken
  ), [
    enabled,
    session?.mode,
    session?.user?.id,
    session?.accessToken,
  ]);

  // 엔진 입력 — 옮기기 전 ref들과 같은 시점에 갱신한다(계획 B8). 엔진은 호출 시점에 getInputs()로 읽는다.
  const sessionRef = useRef(session || null);
  const settingsRef = useRef(settings || null);
  const scopeRef = useRef(scope);
  const lockStateRef = useRef(lockState);
  const enabledRef = useRef(false);
  // 렌더 중 대입은 의도다(B8 — effect로 미루면 초기화 직후 도착한 pull이 빈 목록을 다시 채우는 창이 넓어진다). 옮기기 전과
  // 같은 줄(그때는 React Compiler 린트가 큰 컴포넌트 분석을 포기해 보고되지 않았다).
  // eslint-disable-next-line react-hooks/refs
  enabledRef.current = canSync;
  useEffect(() => { sessionRef.current = session || null; }, [session]);
  useEffect(() => { settingsRef.current = settings || null; }, [settings]);
  // 언마운트되면 동기화를 끈다 — 큐에 남은 다음 sync가 이전 화면의 목록·세션으로 저장 요청을 보내지 않게(계정 전환 수정
  // AS-2). canSync가 바뀔 때의 정리는 바로 뒤 setup이 새 값으로 맞춘다(StrictMode 시험 언마운트 뒤 재마운트도).
  useEffect(() => {
    enabledRef.current = canSync;
    return () => { enabledRef.current = false; };
  }, [canSync]);
  useEffect(() => { scopeRef.current = scope; }, [scope]);
  useEffect(() => { lockStateRef.current = lockState; }, [lockState]);

  // 엔진 인스턴스는 훅 인스턴스당 하나 — 메서드 참조 고정(계획 B9), in-flight·큐는 StrictMode 이중 effect를 건너 유지(B10).
  // ref 묶음을 넘길 뿐 렌더 중에 읽지 않는다 — 엔진이 sync를 돌릴 때(이벤트·effect 뒤) getInputs()로 읽는다.
  // eslint-disable-next-line react-hooks/refs
  const [engine] = useState(() => createPatientSyncEngine({
    store, getInputs: inputsGetter({ sessionRef, settingsRef, scopeRef, lockStateRef, enabledRef }), setSyncState,
  }));
  const { runSync } = engine;

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
    const timer = window.setInterval(() => { runSync({ push: true, pull: true, reason: 'interval' }); }, SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [canSync, runSync]);

  useEffect(() => {
    if (!canSync) return;
    const onFocus = () => { runSync({ pull: true, reason: 'focus' }); };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') runSync({ pull: true, reason: 'visible' });
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
    const timer = window.setTimeout(() => { runSync({ push: true, pull: true, reason: 'local-change' }); }, PUSH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [canSync, patients, runSync]);

  // "저장하지 않고 이동"의 syncPaused는 그 환자를 다시 열었을 때 (a) 락 대상이 아니거나 (b) 락을 다시 얻었으면 푼다. 재개는 이
  // effect 단계 뒤(마이크로태스크)에(계획 B7 — 같은 커밋의 App 락 브리지 flush가 재개 전 목록을 보고 즉시 'lock-lost', 1초
  // debounce가 push + pull 하던 순서 보존). 락 상태·세션은 effect 시점 값. 즉시 flush는 검토 후보.
  useEffect(() => {
    if (!activeId) return;
    const lockStatus = lockStateRef.current?.status;
    const sessionAtEffect = sessionRef.current;
    queueMicrotask(() => { engine.resumePatient(activeId, lockStatus, sessionAtEffect); });
  }, [activeId, lockState?.status, engine]);

  // 안전망: 렌더 값 patients에서 결론이 난(synced/conflict) waiter를 푼다 — 사이클 판정(dispatch 직후 동기) 뒤의 커밋에서
  // 돈다(스토어 구독이면 423이 'lock-lost'보다 먼저 'conflict'로 풀린다, 계획 B6).
  useEffect(() => { engine.settleWaiters(patients); }, [patients, engine]);

  // 진짜 종료(동기화 비활성화·언마운트)에서만 남은 waiter를 'error'로 일괄 정리해 무한 대기를 막는다.
  useEffect(() => () => { engine.disposeWaiters(); }, [canSync, engine]);

  return {
    syncState,
    syncNow: runSync,
    flushPatient: engine.flushPatient,
    notifyLockOutcome: engine.notifyLockOutcome,
  };
}
