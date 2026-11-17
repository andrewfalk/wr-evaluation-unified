// App 컨트롤러 7 — commands(REFACTORING_ROADMAP Phase 2 C3-C, P2-44e). 옛 `src/App.jsx` 313-489줄을 순서 그대로 옮겼다:
// 환자 전환 게이팅 → 영상 분석 서버 적용 → 평가일자 자동 기록 → Electron 메뉴 → 목록 필터·계산·미리보기 → 로그인 직전 보존·
// 로그인 요청 중 표시 → 핸들러(설정 저장 뒤 닫기·목록 보기·초기화) → 충돌 해결 → 가드된 로그아웃 → 대시보드·통계 진입/이탈 →
// 통계 가용성을 Electron main에 전파.
// Electron 메뉴 ref 2개(handleResetPatientsRef·handleOpenStatisticsRef)는 **렌더 중 대입을 유지**한다(effect로 바꾸면 effect가
// 늘고 대입이 커밋 뒤로 밀린다 — 계획). 메모하지 않던 핸들러는 메모하지 않은 그대로, deps는 글자 그대로.
// 규칙은 useShellController.ts 머리 주석과 같다.
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useEvaluationDateSync } from '../../core/state/patientStore/useEvaluationDateSync';
import { useElectronMenuEvents } from '../../core/hooks/useElectronMenuEvents';
import { useConflictResolution } from '../../core/hooks/useConflictResolution';
import { usePatientList } from '../../core/hooks/usePatientList';
import { showAlert } from '../../core/utils/platform';
import { generateUnifiedReport } from '../../core/utils/reportGenerator';
import { isRedactedPatientRecord } from '../../core/services/patientRecords';
import { clearAutoSavedWorkspace } from '../../core/services/workspaceRepository';
import { patientTx } from '../../core/state/patientStore/transitions';
import type { PatientRecord } from '../../core/types/patient';
import type { SetActiveId, SetPatients, SetSelectedIds } from '../../core/state/patientStore/usePatientsContainer';
import { hasIntranetSession } from '../../platform/dataMode';
import { getLifecycleBridge } from '../../platform/bridge';
import { useLocalWorkBeforeLogin } from '../useLocalWorkBeforeLogin';
import type { ScreenRouter } from '../useScreenRouter';
import type { SlotSetter } from '../useModalState';
import type { PatientFilters } from './useShellController';
import type {
  AppModule, AppSession, AppSettings, AuthForApp, ConflictResolutionApi, LockState, MenuHandlerRef, PatientSyncApi,
  ServerConfig, SyncStatusSummary, UseConflictResolution, UseElectronMenuEvents, UsePatientList,
} from './contracts';

export interface CommandsControllerInput {
  settings: AppSettings;
  handleSaveSettings: (next: AppSettings) => void;
  session: AppSession;
  serverConfig: ServerConfig;
  logout: AuthForApp['logout'];
  getWorkspaceOwner: AuthForApp['getWorkspaceOwner'];
  getAuthEpoch: AuthForApp['getAuthEpoch'];
  isAlive: () => boolean;
  alertAlive: (message: string) => Promise<void>;
  confirmAlive: (message: string) => Promise<boolean>;
  patients: PatientRecord[];
  setPatients: SetPatients;
  activeId: string | null;
  setActiveId: SetActiveId;
  setSelectedIds: SetSelectedIds;
  activePatient: PatientRecord | undefined;
  activeModules: string[];
  activeModule: AppModule | null | undefined;
  activeModuleId: string | null;
  isIntranetMode: boolean;
  isAuthenticated: boolean;
  statsAvailable: boolean;
  lockState: LockState;
  patientFilters: PatientFilters;
  setPatientSyncPaused: Dispatch<SetStateAction<boolean>>;
  setShowSettings: SlotSetter<'settings'>;
  setShowSidebar: Dispatch<SetStateAction<boolean>>;
  setShowHome: (value: boolean) => void;
  openStatistics: ScreenRouter['openStatistics'];
  closeStatistics: ScreenRouter['closeStatistics'];
  setConflictPatientId: Dispatch<SetStateAction<string | null>>;
  setCurrentStepIndex: Dispatch<SetStateAction<number>>;
  setIntakeShared: Dispatch<SetStateAction<unknown>>;
  switchPatient: (patientId: string) => void;
  handleResetPatientsRef: MenuHandlerRef;
  handleStartIntakeRef: MenuHandlerRef;
  handleOpenStatisticsRef: MenuHandlerRef;
  flushPatient: PatientSyncApi['flushPatient'];
  syncNow: PatientSyncApi['syncNow'];
  syncSummary: SyncStatusSummary;
  waitForAutosaveRestore: () => Promise<void>;
  dirtyAssessmentPatientId: string | null;
  blockedByUnsavedDraftAlert: () => void;
  blockIfDraftDirty: () => boolean;
}

export interface CommandsController extends ConflictResolutionApi {
  handleSwitchPatient: (patientId: string) => Promise<void>;
  onVideoServerApplied: (serverPatient: PatientRecord | null | undefined) => void;
  displayPatients: PatientRecord[];
  calc: unknown;
  unifiedPreviewText: string;
  onBeforeLogin: () => Promise<void>;
  loginPending: boolean;
  setLoginPending: Dispatch<SetStateAction<boolean>>;
  handleSaveSettingsAndClose: (newSettings: AppSettings) => void;
  showPatientList: () => void;
  handleResetPatients: () => Promise<void>;
  handleLogout: () => Promise<boolean>;
  handleShowHome: () => void;
  handleOpenStatistics: () => void;
  handleCloseStatistics: () => void;
}

export function useCommandsController({
  settings, handleSaveSettings, session, serverConfig, logout, getWorkspaceOwner, getAuthEpoch, isAlive, alertAlive, confirmAlive,
  patients, setPatients, activeId, setActiveId, setSelectedIds, activePatient, activeModules, activeModule, activeModuleId,
  isIntranetMode, isAuthenticated, statsAvailable, lockState, patientFilters, setPatientSyncPaused, setShowSettings,
  setShowSidebar, setShowHome, openStatistics, closeStatistics, setConflictPatientId, setCurrentStepIndex, setIntakeShared,
  switchPatient, handleResetPatientsRef, handleStartIntakeRef, handleOpenStatisticsRef, flushPatient, syncNow, syncSummary,
  waitForAutosaveRestore, dirtyAssessmentPatientId, blockedByUnsavedDraftAlert, blockIfDraftDirty,
}: CommandsControllerInput): CommandsController {
  // 환자 전환 게이팅(§5-3): synced면 즉시 전환, conflict면 push 자체를 시도하지 않고 확인 후
  // 이동, dirty/local-only면 flushPatient로 기존 autosync 큐에 합류해 저장을 기다린 뒤 전환.
  const handleSwitchPatient = useCallback(async (patientId: string) => {
    if (patientId === activeId) { switchPatient(patientId); return; }
    // switchPatient(useStepNavigation)도 같은 조건으로 다시 막지만, 여기서 먼저 막아야
    // 아래 동기화 상태 확인 다이얼로그("저장되지 않은 변경사항이…")가 무관하게 뜨지 않는다.
    if (blockIfDraftDirty()) return;

    const current = patients.find(p => p.id === activeId);
    const status = current?.sync?.syncStatus;

    if (!isIntranetMode || !current || status === 'synced') {
      switchPatient(patientId);
      return;
    }

    const proceedUnresolved = (message: string) => async () => {
      const ok = await confirmAlive(message);
      if (!ok) return false;
      setPatients(patientTx.patientPaused({ id: current.id }));
      switchPatient(patientId);
      return true;
    };

    if (status === 'conflict') {
      await proceedUnresolved('현재 환자가 충돌 상태입니다. 해결하지 않고 이동하시겠습니까?')();
      return;
    }

    if (status === 'dirty' || status === 'local-only') {
      const ok = await confirmAlive('저장되지 않은 변경사항이 있습니다. 저장 후 이동하시겠습니까?');
      if (!ok) return;

      let outcome: string = 'still-dirty';
      for (let attempt = 0; attempt < 3 && outcome === 'still-dirty'; attempt += 1) {
        // 화면이 내려갔으면(계정 전환) 이전 화면의 저장을 더 기다리지도, 다시 요청하지도 않는다.
        if (!isAlive()) return;
        outcome = await flushPatient(current.id);
      }
      if (!isAlive()) return;

      if (outcome === 'synced') { switchPatient(patientId); return; }
      if (outcome === 'conflict') {
        await proceedUnresolved('저장 중 충돌이 발생했습니다. 해결하지 않고 이동하시겠습니까?')();
        return;
      }
      if (outcome === 'still-dirty') {
        await alertAlive('아직 저장 중입니다. 잠시 후 다시 시도해 주세요.');
        return;
      }
      // lock-lost / permission / offline / error
      await proceedUnresolved('저장에 실패했습니다(권한 변경 또는 통신 오류). 저장하지 않고 이동하시겠습니까?')();
      return;
    }

    switchPatient(patientId);
  }, [activeId, patients, switchPatient, flushPatient, setPatients, blockIfDraftDirty, isIntranetMode, isAlive, alertAlive, confirmAlive]);

  // 영상 분석 서버 적용 후 서버 동기화 환자를 목록에 반영(로컬 id 보존 → id로 교체).
  const onVideoServerApplied = useCallback((serverPatient: PatientRecord | null | undefined) => {
    if (!serverPatient?.id) return;
    setPatients(patientTx.replacedFromServer({ id: serverPatient.id, serverPatient, keepLocalMeta: false }));
  }, [setPatients]);

  // 평가 완료 시 evaluationDate 자동 설정
  // 편집 권한·현재 환자의 락이 있을 때만 쓴다(P2-39c) — lockState를 넘겨 락을 얻은 뒤 다시 판정.
  // 로그인 화면이 떠 있는 동안(인트라넷 모드인데 인증 안 됨)은 쓰지 않는다 — 로컬 세션은 편집 권한을 항상 참으로 본다(AS-5).
  useEvaluationDateSync({ activeId, patients, setPatients, session, lockState, suspended: isIntranetMode && !isAuthenticated });

  // Electron 메뉴 이벤트
  (useElectronMenuEvents as unknown as UseElectronMenuEvents)({ handleResetPatientsRef, handleStartIntakeRef, handleOpenStatisticsRef });

  // (셸 초안 신호·beforeunload는 useUnsavedDraftGuard — P2-29)

  const displayPatients = (usePatientList as unknown as UsePatientList)(patients, patientFilters);

  // 계산 결과
  const calc = useMemo(() => {
    if (!activePatient || isRedactedPatientRecord(activePatient) || !activePatient.data || !activeModule?.computeCalc) return {};
    return activeModule.computeCalc({
      shared: activePatient.data.shared || {},
      module: (activePatient.data.modules as Record<string, unknown> | undefined)?.[activeModuleId as string] || {}
    });
  }, [activePatient, activeModule, activeModuleId]);

  // 통합 미리보기 텍스트
  const unifiedPreviewText = useMemo(() => {
    if (!activePatient || isRedactedPatientRecord(activePatient) || activeModules.length === 0) return '';
    return generateUnifiedReport(activePatient);
  }, [activePatient, activeModules]);

  // 로그인 직전 로컬 작업 보존(J2, src/app/useLocalWorkBeforeLogin) + 로그인 요청 중 표시(로컬 전환 버튼을 막는다) — AS-4.
  const onBeforeLogin = useLocalWorkBeforeLogin({ patients, getWorkspaceOwner, waitForPendingRestore: waitForAutosaveRestore });
  const [loginPending, setLoginPending] = useState(false);

  // --- 핸들러 ---

  const handleSaveSettingsAndClose = (newSettings: AppSettings) => {
    handleSaveSettings(newSettings);
    setShowSettings(false);
  };

  const showPatientList = useCallback(() => {
    setShowHome(false);
    setShowSidebar(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps는 옛 App.jsx 글자 그대로(setter는 참조 고정)
  }, []);

  const handleResetPatients = async () => {
    if (blockIfDraftDirty()) return;
    const ok = await confirmAlive('현재 작업 중인 환자 목록을 모두 삭제하시겠습니까?');
    if (!ok) return; // 묻는 동안 화면이 내려갔으면 false — 다음 화면의 자동저장을 지우지 않는다
    setPatientSyncPaused(true);
    setPatients(patientTx.replacedAll({ patients: [] }));
    setActiveId(null);
    setSelectedIds(new Set());
    setIntakeShared(null);
    setShowHome(true);
    clearAutoSavedWorkspace({ session, settings, serverConfig })
      .catch(error => {
        console.warn('[autosave-clear]', error);
      });
  };
  // eslint-disable-next-line react-hooks/refs -- 렌더 중 대입 유지(Electron 메뉴가 ref로 최신 핸들러를 부른다, 옛 App.jsx와 같은 시점)
  handleResetPatientsRef.current = handleResetPatients;

  // (옛 App이 넘기던 setActiveId는 훅이 받지 않는 인자라 넘기지 않는다 — 계획)
  const { markRemoteDeleteConflict, handleResolveConflict, handleCorrectServerIdentity } = (useConflictResolution as unknown as UseConflictResolution)({
    setPatients, activeId, setCurrentStepIndex, session, settings, setConflictPatientId, syncNow,
    dirtyAssessmentPatientId, onBlockedByUnsavedDraft: blockedByUnsavedDraftAlert,
  });

  // 로그아웃은 렌더러 세션만 정리하는 게 아니라(Electron은 서버 세션까지 정리) 화면을
  // 완전히 떠나므로 dirty 편집 중이면 막는다.
  // 로그아웃하면 화면의 목록이 비워진다(계정 전환 수정 AS-5) — 인트라넷 세션에서 저장되지 않은 환자(저장 대기·충돌·락 상실)가
  // 있으면 먼저 묻고, 취소하면 아무 요청도 보내지 않는다. 진행 중에는 다시 누를 수 없다. 로그아웃을 시작했으면 true.
  const logoutInFlightRef = useRef(false);
  const handleLogout = async () => {
    if (blockIfDraftDirty()) return false;
    if (logoutInFlightRef.current) return false;
    logoutInFlightRef.current = true;
    try {
      // 확인창을 열기 전의 인증 문맥 세대 — 확인을 기다리는 동안 바뀌었으면(다른 탭의 로그인 방송으로 되돌려짐 등) 로그아웃하지 않는다.
      const gen = getAuthEpoch();
      const unsaved = hasIntranetSession(session)
        ? syncSummary.pendingCount + syncSummary.conflictCount + syncSummary.lockLostCount
        : 0;
      if (unsaved > 0) {
        const ok = await confirmAlive(`저장되지 않은 환자가 ${unsaved}명 있습니다. 로그아웃하면 이 내용은 사라집니다. 로그아웃할까요?`);
        if (!ok) return false;
      }
      return await logout({ expectedGen: gen });
    } finally {
      logoutInFlightRef.current = false;
    }
  };

  const handleShowHome = () => {
    if (blockIfDraftDirty()) return;
    setShowHome(true);
  };

  // PR2 §1 — 통계 워크벤치 진입/이탈(헤더·랜딩 버튼·Electron 메뉴가 모두 이것). 가드 순서와 복귀 화면은 useScreenRouter.
  const handleOpenStatistics = useCallback(() => openStatistics({
    draftDirty: !!dirtyAssessmentPatientId,
    onDraftBlocked: blockedByUnsavedDraftAlert,
    statsAvailable,
    onUnavailable: () => { showAlert('통계분석 워크벤치를 사용할 수 없습니다.'); },
  }), [openStatistics, dirtyAssessmentPatientId, blockedByUnsavedDraftAlert, statsAvailable]);
  const handleCloseStatistics = closeStatistics;
  // eslint-disable-next-line react-hooks/refs -- 렌더 중 대입 유지(위와 같은 이유)
  handleOpenStatisticsRef.current = handleOpenStatistics;

  // 렌더러가 아는 가용성을 Electron main에 전파해 메뉴를 켜고 끈다(main은 서버 설정을 모름) —
  // set-has-unsaved-draft와 같은 renderer→main IPC 패턴.
  useEffect(() => {
    getLifecycleBridge()?.setStatsAvailable?.(statsAvailable);
  }, [statsAvailable]);

  return {
    handleSwitchPatient, onVideoServerApplied, displayPatients, calc, unifiedPreviewText, onBeforeLogin, loginPending, setLoginPending,
    handleSaveSettingsAndClose, showPatientList, handleResetPatients,
    markRemoteDeleteConflict, handleResolveConflict, handleCorrectServerIdentity,
    handleLogout, handleShowHome, handleOpenStatistics, handleCloseStatistics,
  };
}
