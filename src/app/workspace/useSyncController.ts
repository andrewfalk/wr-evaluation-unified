// App 컨트롤러 5 — sync(REFACTORING_ROADMAP Phase 2 C3-C, P2-44d). 옛 `src/App.jsx` 208-277줄을 순서 그대로 옮겼다:
// 동기화 일시정지 해제 effect 2개 → 환자 동기화(usePatientSync) → 락 브리지 effect → 세션 identity가 바뀌면 락 토큰 초기화
// effect → 동기화 요약 → 강제 인수 → 의사 명부. **순서가 의미를 갖는 구간**(계획 C2): 락 브리지는 usePatientSync 뒤(엔진이
// 호출 시점의 lockState를 ref로 읽는다), scope 초기화(usePatientScope, shell 컨트롤러)는 일시정지 해제보다 앞.
// 규칙은 useShellController.ts 머리 주석과 같다.
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { usePatientSync } from '../../core/hooks/usePatientSync';
import { useSyncStatusSummary } from '../../core/hooks/useSyncStatusSummary';
import { clearAllLockTokens } from '../../core/services/lockTokenStore';
import type { PatientStore } from '../../core/state/patientStore/store';
import type { PatientRecord } from '../../core/types/patient';
import { useDoctorRoster, type PatientScopeState } from '../usePatientScope';
import type {
  AppSession, AppSettings, LockState, PatientSyncApi, SyncStatusSummary, UsePatientSync, UseSyncStatusSummary,
} from './contracts';

export interface SyncControllerInput {
  session: AppSession;
  settings: AppSettings;
  patients: PatientRecord[];
  activeId: string | null;
  patientStore: PatientStore;
  effectivePatientScope: string;
  patientScopeState: PatientScopeState;
  lockState: LockState;
  forceAcquire: () => Promise<unknown>;
  isIntranetMode: boolean;
  isAuthenticated: boolean;
  sessionVerified: boolean;
  configLoading: boolean;
  configError: unknown;
  patientSyncPaused: boolean;
  setPatientSyncPaused: Dispatch<SetStateAction<boolean>>;
  intakeShared: unknown;
  confirmAlive: (message: string) => Promise<boolean>;
}

export interface SyncController extends PatientSyncApi {
  syncSummary: SyncStatusSummary;
  handleForceTakeover: () => Promise<void>;
  doctorRoster: ReturnType<typeof useDoctorRoster>['doctorRoster'];
  isDashboardScopeLoading: boolean;
}

export function useSyncController({
  session, settings, patients, activeId, patientStore, effectivePatientScope, patientScopeState, lockState, forceAcquire,
  isIntranetMode, isAuthenticated, sessionVerified, configLoading, configError, patientSyncPaused, setPatientSyncPaused,
  intakeShared, confirmAlive,
}: SyncControllerInput): SyncController {
  // 세션이 바뀌면 동기화 일시정지도 푼다(scope 초기화는 usePatientScope가 같은 deps로 먼저 한다).
  useEffect(() => {
    setPatientSyncPaused(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps는 옛 App.jsx 글자 그대로(setter는 참조 고정)
  }, [session?.mode, session?.user?.id, session?.user?.role]);

  useEffect(() => {
    if (patients.length > 0 || intakeShared) {
      setPatientSyncPaused(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps는 옛 App.jsx 글자 그대로(setter는 참조 고정)
  }, [patients.length, intakeShared]);

  const { syncState, syncNow, flushPatient, notifyLockOutcome } = (usePatientSync as unknown as UsePatientSync)({
    patients,
    activeId,
    store: patientStore,
    session,
    settings,
    scope: effectivePatientScope,
    lockState,
    enabled:
      isIntranetMode &&
      isAuthenticated &&
      sessionVerified &&
      !session?.user?.mustChangePassword &&
      !configLoading &&
      !configError &&
      !patientSyncPaused,
  });

  // lockState 전이를 관찰해 필요한 시점에만 usePatientSync 쪽 함수를 호출한다 — 두 훅은
  // 서로를 모른다(usePatientLock은 sync 콜백을 아예 받지 않음).
  const prevLockStatusRef = useRef(lockState.status);
  useEffect(() => {
    if (prevLockStatusRef.current === lockState.status) return;
    prevLockStatusRef.current = lockState.status;
    if (lockState.status === 'held') {
      // "저장하지 않고 이동"으로 걸어둔 일시정지(syncPaused) 해제는 usePatientSync 내부의
      // 전용 effect가 담당한다(activeId/lockState.status 변화를 직접 관찰) — local-only
      // 환자처럼 lockState가 절대 'held'가 되지 않는 경우까지 한 곳에서 처리하기 위함.
      flushPatient(activeId);
    } else if (lockState.status === 'held-by-other' || lockState.status === 'lost') {
      notifyLockOutcome(activeId, 'lock-lost');
    }
  }, [lockState.status, activeId, flushPatient, notifyLockOutcome]);

  // 세션 identity(로그인/로그아웃/서버 URL/계정/조직 변경)가 바뀌면 이전 계정의 leaseToken이
  // 다음 계정으로 넘어가지 않도록 일괄 초기화한다. accessToken/refreshedAt은 순수 토큰
  // refresh(회전)만으로는 안 바뀌는 값이라 여기 포함하지 않는다 — 어떤 함수가 그 변화를
  // 일으켰는지와 무관하게 identity 자체의 변화만 포착한다.
  const lockIdentity = `${session?.mode ?? ''}|${session?.apiBaseUrl || ''}|${session?.user?.id || ''}|${session?.user?.organizationId || ''}`;
  const prevLockIdentityRef = useRef(lockIdentity);
  useEffect(() => {
    if (prevLockIdentityRef.current === lockIdentity) return;
    prevLockIdentityRef.current = lockIdentity;
    clearAllLockTokens();
  }, [lockIdentity]);

  const syncSummary = (useSyncStatusSummary as unknown as UseSyncStatusSummary)(patients, syncState);

  const handleForceTakeover = useCallback(async () => {
    const holderName = lockState.holder?.holderName || '다른 사용자';
    const ok = await confirmAlive(`${holderName}이(가) 편집 중인 환자입니다. 강제로 편집 권한을 가져오시겠습니까?`);
    if (!ok) return;
    await forceAcquire();
  }, [lockState.holder, forceAcquire, confirmAlive]);

  // 의사 명부 조회 + 명부 기준 scope 유효성 가드 + 대시보드 scope 로딩 판정 — src/app/usePatientScope.ts(P2-27).
  const { doctorRoster, isDashboardScopeLoading } = useDoctorRoster({
    session, settings, isAuthenticated, sessionVerified, syncState, scope: patientScopeState,
  });

  return {
    syncState, syncNow, flushPatient, notifyLockOutcome,
    syncSummary, handleForceTakeover, doctorRoster, isDashboardScopeLoading,
  };
}
