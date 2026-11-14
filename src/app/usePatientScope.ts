// 환자 목록·대시보드 scope와 의사 명부 — REFACTORING_ROADMAP Phase 2 C3-A(P2-27). App.jsx에 흩어져 있던 상태·파생값·
// effect 3개를 옮겼다(동작 그대로). effect 순서도 그대로다: ① 세션이 바뀌면 scope 초기화(usePatientScope) →
// ② 명부 조회(useDoctorRoster) → ③ 명부 기준 scope 유효성 가드(useDoctorRoster). ①은 App에서 동기화보다 먼저 부르고,
// ②·③은 동기화 결과(lastSyncedAt·loadedScope)가 필요해 usePatientSync 뒤에서 부른다.
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  getDefaultPatientScope,
  getValidPatientScopes,
  normalizePatientScopeForSession,
} from '../core/utils/patientScope';
import { fetchDoctorCounts } from '../core/services/patientServerRepository';
import { hasIntranetSession } from '../platform/dataMode';

type SessionUser = { id?: string | null; role?: string | null; organizationId?: string | null; mustChangePassword?: boolean | null };
export type ScopeSession = { mode?: string | null; user?: SessionUser | null; apiBaseUrl?: string | null } | null | undefined;

export interface PatientScopeState {
  patientScope: string;
  setPatientScope: Dispatch<SetStateAction<string>>;
  dashboardScope: string;
  setDashboardScope: Dispatch<SetStateAction<string>>;
  /** 'mine'(내 담당)을 쓸 수 있나 — 로컬이거나 인트라넷 의사. */
  canUseMinePatientScope: boolean;
  /** 세션에 맞게 정규화한 목록 scope(admin의 'mine' → 'all'). 동기화(pull) 범위. */
  effectivePatientScope: string;
  /** 대시보드 scope 드롭다운을 쓸 수 있나 — 인증된 인트라넷 사용자. */
  canUseDashboardScope: boolean;
  effectiveDashboardScope: string;
}

/** ① scope 상태·파생값 + 세션(모드·사용자·역할)이 바뀌면 두 scope를 기본값으로. */
export function usePatientScope(session: ScopeSession): PatientScopeState {
  const [patientScope, setPatientScope] = useState<string>(() => getDefaultPatientScope(session));
  const [dashboardScope, setDashboardScope] = useState<string>(() => getDefaultPatientScope(session));

  useEffect(() => {
    setPatientScope(getDefaultPatientScope(session));
    setDashboardScope(getDefaultPatientScope(session));
  }, [session?.mode, session?.user?.id, session?.user?.role]); // eslint-disable-line react-hooks/exhaustive-deps

  const canUseMinePatientScope = !hasIntranetSession(session) || session?.user?.role === 'doctor';
  const effectivePatientScope = normalizePatientScopeForSession(session, patientScope);
  const canUseDashboardScope = hasIntranetSession(session) && !!session?.user?.id;
  const effectiveDashboardScope = canUseDashboardScope ? dashboardScope : 'all';

  return {
    patientScope, setPatientScope, dashboardScope, setDashboardScope,
    canUseMinePatientScope, effectivePatientScope, canUseDashboardScope, effectiveDashboardScope,
  };
}

export interface DoctorRoster {
  doctors: Array<{ userId: string; name?: string; count?: number }>;
  unassignedCount: number;
}

export type DoctorRosterStatus = 'loading' | 'ready' | 'error';

export interface DoctorRosterInput {
  session: ScopeSession;
  settings: unknown;
  isAuthenticated: boolean;
  sessionVerified: boolean;
  syncState: { status?: string | null; loadedScope?: string | null; lastSyncedAt?: unknown };
  scope: PatientScopeState;
}

const EMPTY_ROSTER: DoctorRoster = { doctors: [], unassignedCount: 0 };

/**
 * ② 대시보드 scope 드롭다운용 의사 명부(경량 집계, PHI 없음) — 처음 + 동기화가 끝날 때마다(lastSyncedAt) 다시 조회.
 * ③ 명부가 갱신되면 선택된 scope(의사 userId·미배정)가 아직 유효한지 보고 아니면 기본값으로(사이드바·대시보드 같은 정책).
 * 'loading'·'error'에서는 ③을 보류(로딩 중 오탐 방지, 실패면 마지막 유효 명부 유지).
 */
export function useDoctorRoster({ session, settings, isAuthenticated, sessionVerified, syncState, scope }: DoctorRosterInput) {
  const [doctorRoster, setDoctorRoster] = useState<DoctorRoster>(EMPTY_ROSTER);
  // 'loading'/'ready'/'error' — 초기 로딩 전, 정상 조회(빈 명부 포함), 조회 실패를 구분해 ③이 오판(예: 마지막 의사
  // 재배정으로 인한 정상 빈 명부를 "로딩 중"으로 오인)하지 않게 한다.
  const [doctorRosterStatus, setDoctorRosterStatus] = useState<DoctorRosterStatus>('loading');
  const rosterIdentityRef = useRef<string | null>(null);
  const { canUseDashboardScope, canUseMinePatientScope, effectivePatientScope, effectiveDashboardScope, setPatientScope, setDashboardScope } = scope;

  useEffect(() => {
    // 임시 비밀번호 상태에서는 서버가 이 조회를 403으로 거절한다(HF2) — 변경 전에는 부르지 않고, 플래그가 풀리면
    // deps가 바뀌어 바로 조회한다.
    if (!canUseDashboardScope || !isAuthenticated || !sessionVerified || session?.user?.mustChangePassword) {
      setDoctorRoster(EMPTY_ROSTER);
      setDoctorRosterStatus('loading');
      rosterIdentityRef.current = null;
      return undefined;
    }
    // 세션/조직 경계가 바뀌면(로그아웃 → 다른 계정/조직) 이전 조직의 명부를 즉시 비운다 — 새 조회가 지연·실패해도 이전
    // 조직 의사 이름/카운트가 드롭다운에 남지 않게. (routine 재조회 = lastSyncedAt만 바뀌면 비우지 않아 깜빡임 없음)
    const identity = `${session?.user?.id ?? ''}:${session?.user?.organizationId ?? ''}`;
    if (rosterIdentityRef.current !== identity) {
      rosterIdentityRef.current = identity;
      setDoctorRoster(EMPTY_ROSTER);
      setDoctorRosterStatus('loading');
    }
    let cancelled = false;
    fetchDoctorCounts({ session, settings })
      .then((roster: DoctorRoster) => { if (!cancelled) { setDoctorRoster(roster); setDoctorRosterStatus('ready'); } })
      .catch(() => { if (!cancelled) setDoctorRosterStatus('error'); /* 명부는 마지막 성공값 유지, 상태만 error */ });
    return () => { cancelled = true; };
    // session/settings 객체는 deps에서 제외(식별자 변동으로 인한 재조회 루프 방지)
  }, [canUseDashboardScope, isAuthenticated, sessionVerified, session?.user?.id, session?.user?.organizationId, session?.user?.mustChangePassword, syncState.lastSyncedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!hasIntranetSession(session)) return;
    if (doctorRosterStatus !== 'ready') return;
    const validScopes = getValidPatientScopes(doctorRoster, { canUseMineScope: canUseMinePatientScope });
    const fallback = getDefaultPatientScope(session);
    if (!validScopes.has(effectivePatientScope)) setPatientScope(fallback);
    if (!validScopes.has(effectiveDashboardScope)) setDashboardScope(fallback);
    // session 객체 자체는 deps에서 제외(식별자 변동 방지) — mode/role만 실질적으로 영향
  }, [session?.mode, session?.user?.role, doctorRosterStatus, doctorRoster, canUseMinePatientScope, effectivePatientScope, effectiveDashboardScope]); // eslint-disable-line react-hooks/exhaustive-deps

  // 대시보드 scope 변경 pull이 진행 중인가 — status==='syncing' AND 조건을 반드시 유지(loadedScope만 비교하면 실패·
  // 오프라인 때 영구 로딩처럼 보임).
  const isDashboardScopeLoading = canUseDashboardScope
    && syncState.status === 'syncing'
    && syncState.loadedScope !== effectiveDashboardScope;

  return { doctorRoster, doctorRosterStatus, isDashboardScopeLoading };
}
