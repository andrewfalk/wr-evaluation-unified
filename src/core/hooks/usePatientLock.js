import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acquirePatientLock,
  renewPatientLock,
  forcePatientLock,
  releasePatientLock,
  isLockError,
} from '../services/patientServerRepository';
import { setLockToken, getLockToken, clearLockToken } from '../services/lockTokenStore';

const CLIENT_INSTANCE_STORAGE_KEY = 'wrEvalUnified.lockClientInstanceId';
const DEFAULT_TTL_MS = 100_000;
const RENEW_DIVISOR = 4; // heartbeat = ttlMs / 4 (서버 TTL의 여유 4배와 대응)
const MIN_RENEW_DELAY_MS = 1000;

// 같은 환자에 대해 acquire가 이미 진행 중이면 새 HTTP 요청을 또 쏘지 않고 그 Promise를
// 그대로 재사용한다. React.StrictMode(개발 모드)는 effect를 "설정→정리→재설정" 순서로 한
// 번 더 실행하는데, 이 재실행이 cleanup을 기다리지 않고 곧바로 일어나므로 dedupe 없이는
// 실제 acquire 요청이 두 번 나간다(세대번호 덕분에 최종 저장되는 토큰은 항상 하나로
// 수렴하지만, 불필요한 토큰 회전과 감사 로그 중복이 남는다). 완료되면 맵에서 제거해 다음
// 번 "진짜" acquire까지 막지 않는다.
export function acquireOnce(inFlightMap, patientId, serverId, clientInstanceId, session, settings) {
  const existing = inFlightMap.get(patientId);
  if (existing) return existing;
  const promise = acquirePatientLock(serverId, clientInstanceId, { session, settings }).finally(() => {
    if (inFlightMap.get(patientId) === promise) inFlightMap.delete(patientId);
  });
  inFlightMap.set(patientId, promise);
  return promise;
}

function generateClientInstanceId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // crypto.randomUUID 미지원 환경(구형 브라우저) 폴백 — 소유권 증명이 아니라 탭 식별용이라
  // 암호학적 강도는 필요 없다.
  return `ci-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// 탭당 1회 생성해 sessionStorage에 저장 — 같은 탭 새로고침(F5)엔 유지되고 새 탭엔 남지 않는다.
// (서버의 acquireLock 자기매칭 조건: client_instance_id + user_id + organization_id 모두 일치)
function getOrCreateClientInstanceId() {
  try {
    let id = window.sessionStorage.getItem(CLIENT_INSTANCE_STORAGE_KEY);
    if (!id) {
      id = generateClientInstanceId();
      window.sessionStorage.setItem(CLIENT_INSTANCE_STORAGE_KEY, id);
    }
    return id;
  } catch {
    // sessionStorage 접근 불가(사생활 보호 모드 등) — 탭 수명 동안만 유효한 메모리 폴백.
    return generateClientInstanceId();
  }
}

// 이 환자가 서버 측 락 게이팅 대상인지. 로컬 전용(아직 서버에 push 안 된) 환자는 서버에
// 그 id로 된 patient_records 행이 없으므로 잠글 대상 자체가 없다 — 첫 push(POST) 이후에야
// serverId가 생기고 그때부터 잠글 수 있다.
export function requiresLock(patient, session) {
  return session?.mode === 'intranet' && !!patient?.sync?.serverId;
}

const NONE_STATE = { status: 'none', holder: null, expiresAt: null };

// 환자를 여는 것 자체를 편집 세션의 시작으로 보고, 서버 측 TTL lease lock을 자동으로
// acquire/renew한다. 이 훅은 usePatientSync를 전혀 모른다 — lockState만 정확히 관리·노출하고,
// sync 쪽과의 연결(flushPatient/notifyLockOutcome 호출)은 App.jsx의 별도 effect가
// lockState 전이를 관찰해 수행한다.
export function usePatientLock({ activeId, activePatient, session, settings }) {
  const [lockState, setLockState] = useState(NONE_STATE);
  const clientInstanceIdRef = useRef(null);
  if (!clientInstanceIdRef.current) clientInstanceIdRef.current = getOrCreateClientInstanceId();

  // 빠른 A→B→C 전환에서 늦게 도착한 응답이 최신 상태를 덮지 않도록 하는 세대번호.
  const generationRef = useRef(0);
  const renewTimerRef = useRef(null);
  const inFlightAcquireRef = useRef(new Map()); // patientId -> in-flight acquire Promise

  const serverId = requiresLock(activePatient, session) ? activePatient.sync.serverId : null;

  const clearRenewTimer = useCallback(() => {
    if (renewTimerRef.current) {
      window.clearTimeout(renewTimerRef.current);
      renewTimerRef.current = null;
    }
  }, []);

  // 특정 세대에 속한 renew 하트비트 루프를 (재)시작한다. 최초 acquire 성공 직후와
  // force-takeover 성공 직후 모두 이 함수를 공유한다 — 두 곳에 각자 구현하면 갱신 주기
  // 계산이나 실패 처리가 어긋날 위험이 있다.
  const startRenewLoop = useCallback((myGeneration, ttlMs) => {
    clearRenewTimer();
    const delay = Math.max(MIN_RENEW_DELAY_MS, Math.floor((ttlMs || DEFAULT_TTL_MS) / RENEW_DIVISOR));
    renewTimerRef.current = window.setTimeout(async function tick() {
      if (generationRef.current !== myGeneration) return;
      const token = getLockToken(activeId);
      if (!token) return; // 토큰이 이미 없으면(예: 강제 release) 조용히 종료 — 재시도 없음.
      try {
        const result = await renewPatientLock(serverId, token, { session, settings });
        if (generationRef.current !== myGeneration) return;
        setLockToken(activeId, token, result.expiresAt);
        setLockState({ status: 'held', holder: null, expiresAt: result.expiresAt });
        const nextDelay = Math.max(MIN_RENEW_DELAY_MS, Math.floor((result.ttlMs || DEFAULT_TTL_MS) / RENEW_DIVISOR));
        renewTimerRef.current = window.setTimeout(tick, nextDelay);
      } catch {
        // 423(LOCK_LOST) 또는 403(재배정으로 인한 권한 변경) 모두 "이 클라이언트는 더 이상
        // 이 락을 유지할 수 없다"는 뜻 — 원인과 무관하게 lost로 통일 처리한다. 로컬 편집
        // 내용(patients 배열)은 여기서 절대 건드리지 않는다.
        if (generationRef.current !== myGeneration) return;
        clearLockToken(activeId);
        setLockState({ status: 'lost', holder: null, expiresAt: null });
      }
    }, delay);
  }, [activeId, serverId, session, settings, clearRenewTimer]);

  useEffect(() => {
    const myGeneration = ++generationRef.current;
    let cancelled = false;
    clearRenewTimer();

    if (!serverId) {
      setLockState(NONE_STATE);
      return undefined;
    }

    const isStale = () => cancelled || generationRef.current !== myGeneration;

    (async () => {
      setLockState({ status: 'acquiring', holder: null, expiresAt: null });
      try {
        const result = await acquireOnce(
          inFlightAcquireRef.current, activeId, serverId, clientInstanceIdRef.current, session, settings
        );
        if (isStale()) return;
        setLockToken(activeId, result.leaseToken, result.expiresAt);
        setLockState({ status: 'held', holder: null, expiresAt: result.expiresAt });
        startRenewLoop(myGeneration, result.ttlMs);
      } catch (err) {
        if (isStale()) return;
        if (isLockError(err)) {
          setLockState({ status: 'held-by-other', holder: err.data?.holder || null, expiresAt: null });
        } else {
          // 네트워크 오류 등 acquire 자체가 실패한 경우 — 낙관적으로 'held'를 가정하지 않는다.
          setLockState({ status: 'lost', holder: null, expiresAt: null });
        }
      }
    })();

    return () => {
      cancelled = true;
      clearRenewTimer();
      // best-effort 해제 — 응답을 기다리지 않는다(사용자 조작을 막을 이유가 없음).
      // 서버는 opt-in(락 없음=통과)이라 해제 실패해도 TTL 만료로 자연 정리된다.
      const token = getLockToken(activeId);
      if (token) {
        releasePatientLock(serverId, token, { session, settings }).catch(() => {});
        clearLockToken(activeId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, serverId, session?.apiBaseUrl, session?.accessToken, settings, clearRenewTimer, startRenewLoop]);

  // 사용자가 명시적으로 동의한 뒤에만 호출 — 다른 사람이 보유한 락을 무조건 선점한다.
  const forceAcquire = useCallback(async () => {
    if (!serverId) return { ok: false };
    const myGeneration = generationRef.current;
    setLockState(prev => ({ ...prev, status: 'acquiring' }));
    try {
      const result = await forcePatientLock(serverId, clientInstanceIdRef.current, { session, settings });
      if (generationRef.current !== myGeneration) return { ok: false };
      setLockToken(activeId, result.leaseToken, result.expiresAt);
      setLockState({ status: 'held', holder: null, expiresAt: result.expiresAt });
      startRenewLoop(myGeneration, result.ttlMs);
      return { ok: true };
    } catch (err) {
      if (generationRef.current !== myGeneration) return { ok: false };
      setLockState({ status: 'held-by-other', holder: err?.data?.holder || null, expiresAt: null });
      return { ok: false, error: err };
    }
  }, [activeId, serverId, session, settings, startRenewLoop]);

  return { lockState, forceAcquire, clientInstanceId: clientInstanceIdRef.current };
}
