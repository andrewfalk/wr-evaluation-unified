// @ts-nocheck
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { getModule } from './core/moduleRegistry';
import { LandingScreen } from './core/components/LandingScreen';
import { IntakeWizard } from './core/components/IntakeWizard';
import { AppModals } from './core/components/AppModals';
import { useAuth } from './core/auth/AuthContext';
import { useServerConfig } from './core/hooks/useServerConfig';
import { useAIAvailable } from './core/hooks/useAIAvailable';
import { useAuthSync } from './core/hooks/useAuthSync';
import { useAppSettings } from './core/hooks/useAppSettings';
import { useEvaluationDateSync } from './core/hooks/useEvaluationDateSync';
import { useElectronMenuEvents } from './core/hooks/useElectronMenuEvents';
import { useConflictResolution } from './core/hooks/useConflictResolution';
import { useIntegrationStatus } from './core/hooks/useIntegrationStatus';
import { usePatientList } from './core/hooks/usePatientList';
import { useExportHandlers } from './core/hooks/useExportHandlers';
import { usePresetManagement } from './core/hooks/usePresetManagement';
import { useEMRIntegration } from './core/hooks/useEMRIntegration';
import { useStepNavigation } from './core/hooks/useStepNavigation';
import { useIntakeWizard } from './core/hooks/useIntakeWizard';
import { useWorkspacePersistence } from './core/hooks/useWorkspacePersistence';
import { useMigration } from './core/hooks/useMigration';
import { useOpsStatus } from './core/hooks/useOpsStatus';
import { usePatientCrud } from './core/hooks/usePatientCrud';
import { usePatientSync } from './core/hooks/usePatientSync';
import { usePatientLock, requiresLock } from './core/hooks/usePatientLock';
import { useSyncStatusSummary } from './core/hooks/useSyncStatusSummary';
import { showAlert, showConfirm } from './core/utils/platform';
import { generateUnifiedReport } from './core/utils/reportGenerator';
import { buildSteps } from './core/utils/steps';
import { isRedactedPatientRecord } from './core/services/patientRecords';
import { canEditPatient } from './core/utils/patientOwnership';
import { getDefaultPatientScope, normalizePatientScopeForSession, getValidPatientScopes } from './core/utils/patientScope';
import { clearAutoSavedWorkspace } from './core/services/workspaceRepository';
import { fetchDoctorCounts } from './core/services/patientServerRepository';
import { clearAllLockTokens } from './core/services/lockTokenStore';
import { StatisticsWorkbench } from './core/components/statistics/StatisticsWorkbench';
import { WorkspaceScreen } from './app/screens/WorkspaceScreen';
import { renderBootGate, withLocalEscape as withLocalEscapeFor } from './app/BootGate';
import { selectScreen, useScreenRouter } from './app/useScreenRouter';
import { hasIntranetSession, isIntranetContext } from './platform/dataMode';
import { getLifecycleBridge } from './platform/bridge';
import { detectRuntime } from './platform/runtime';

const DEFAULT_PATIENT_FILTERS = {
  searchQuery: '',
  statusFilter: 'all',
  moduleFilter: 'all',
  jobFilter: '',
  registrationFrom: '',
  registrationTo: '',
  completionFrom: '',
  completionTo: '',
  sortKey: 'default',
  sortDirection: 'asc',
};

// 모듈 등록 (사이드이펙트 import)
import './modules/knee';
import './modules/spine';
import './modules/cervical';
import './modules/shoulder';
import './modules/elbow';
import './modules/wrist';

function App() {
  const { session, setSession, resetToLocalSession, getAuthEpoch, isAuthenticated, sessionVerified, logout } = useAuth();
  const [patients, setPatients] = useState([]);
  const [patientScope, setPatientScope] = useState(() => getDefaultPatientScope(session));
  const [dashboardScope, setDashboardScope] = useState(() => getDefaultPatientScope(session));
  const [patientSyncPaused, setPatientSyncPaused] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [errors, setErrors] = useState({});
  const [showSidebar, setShowSidebar] = useState(false);
  const [patientFilters, setPatientFilters] = useState(DEFAULT_PATIENT_FILTERS);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const { settings, handleSaveSettings, switchToLocalMode } = useAppSettings({ session, setSession, resetToLocalSession });
  useAuthSync({ session, setSession, resetToLocalSession, getAuthEpoch });
  const [showSettings, setShowSettings] = useState(false);
  const [showAdminConsole, setShowAdminConsole] = useState(false);
  const [showAccountProfile, setShowAccountProfile] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showMigrationReport, setShowMigrationReport] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  // 화면 상태(activeScreen)·showHome 호환 shim·통계 열기/닫기 — src/app/useScreenRouter.ts(P2-26). setShowHome은
  // 훅·컴포넌트 21곳이 그대로 쓰며, true/false 모두 통계 화면을 닫는다(PR2 §1의 단일 진실원 그대로).
  const { activeScreen, setShowHome, openStatistics, closeStatistics } = useScreenRouter();
  const [conflictPatientId, setConflictPatientId] = useState(null);

  // 종합소견 직접 편집 dirty 가드 — 불리언이 아니라 환자 ID를 담는다. 환자를 전환해도
  // dirty가 잘못 따라붙지 않게 하기 위함(AssessmentStep이 재마운트 없이 patient prop만
  // 바뀌는 구조라 patient.id를 직접 대조해야 한다).
  const [dirtyAssessmentPatientId, setDirtyAssessmentPatientId] = useState(null);
  const blockedByUnsavedDraftAlert = useCallback(() => {
    showAlert('저장하지 않은 종합소견 편집 내용이 있습니다.\n"편집 완료" 또는 "취소"로 마무리한 뒤 다시 시도하세요.');
  }, []);
  // AssessmentStep이 편집 모드 진입/종료를 알려올 때 호출한다. prev===patientId 가드는
  // 종료(false) 신호가 다른(이미 전환된) 환자의 낡은 신호로 잘못 도착해도 활성 dirty를
  // 지우지 않게 한다.
  const handleAssessmentEditingChange = useCallback((patientId, isEditing) => {
    setDirtyAssessmentPatientId(prev => {
      if (isEditing) return patientId;
      return prev === patientId ? null : prev;
    });
  }, []);
  // guardedSelectPatient()로 모으지 못한 직접 setActiveId 호출부(랜딩 화면의 "이어서 작업",
  // 충돌 모달의 "정정 화면으로 이동")가 개별적으로 재구현하지 않도록 공용 가드를 둔다.
  const guardedSelectPatient = useCallback((patientId, { stepIndex = 0 } = {}) => {
    // 이미 활성인 환자를 다시 선택했으면 스텝을 건드리지 않는다(useStepNavigation의
    // switchPatient와 동일한 이유 — dirty 여부와 무관하게 항상 no-op이어야 한다).
    if (patientId === activeId) { setShowHome(false); return true; }
    if (dirtyAssessmentPatientId) {
      blockedByUnsavedDraftAlert();
      return false;
    }
    setActiveId(patientId);
    setCurrentStepIndex(stepIndex);
    setShowHome(false);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyAssessmentPatientId, activeId, blockedByUnsavedDraftAlert]);
  const { serverConfig, configLoading, configError, refetchConfig, refreshing: statsConfigRefreshing, refreshError: statsConfigRefreshError } =
    useServerConfig({ session, settings });
  const { aiAvailable } = useAIAvailable({ serverConfig, session });
  // PR2 §4 — 통계 워크벤치 가용성. videoAnalysisEnabled(:190)와 같은 단순 boolean 패턴 —
  // 별도 훅 없이 statsWorkbenchAvailable 플래그 하나로 메뉴 노출을 결정한다.
  const statsAvailable = !!serverConfig?.statsWorkbenchAvailable;
  const isIntranetMode =
    isIntranetContext({ session, settings });
  const canUseMinePatientScope = !hasIntranetSession(session) || session?.user?.role === 'doctor';
  const effectivePatientScope = normalizePatientScopeForSession(session, patientScope);
  const canUseDashboardScope = hasIntranetSession(session) && !!session?.user?.id;
  const effectiveDashboardScope = canUseDashboardScope ? dashboardScope : 'all';
  const [doctorRoster, setDoctorRoster] = useState({ doctors: [], unassignedCount: 0 });
  // 'loading'/'ready'/'error' — 초기 로딩 전, 정상 조회(빈 명부 포함), 조회 실패를 구분해
  // scope 유효성 가드가 오판(예: 마지막 의사 재배정으로 인한 정상 빈 명부를 "로딩 중"으로 오인)하지 않게 한다.
  const [doctorRosterStatus, setDoctorRosterStatus] = useState('loading');
  const { status: integrationStatus } = useIntegrationStatus({ session, settings });
  const activePatient = patients.find(p => p.id === activeId);
  const conflictPatient = patients.find(
    p => p.id === conflictPatientId && p.sync?.syncStatus === 'conflict'
  );
  const activeModules = isRedactedPatientRecord(activePatient) ? [] : (activePatient?.data?.activeModules || []);

  // 환자를 여는 것 자체가 편집 세션의 시작 — 서버 측 TTL lease lock을 자동으로 acquire/renew한다.
  // usePatientSync/usePresetManagement는 이 lockState(또는 그로부터 합성한 canMutateActivePatient)를
  // 읽기 전용으로만 받는다(콜백을 주고받지 않음). 두 훅과의 연결(브리지)은 아래 별도 effect가
  // lockState 전이를 관찰해 담당한다.
  const { lockState, forceAcquire } = usePatientLock({ activeId, activePatient, session, settings });
  // 프리셋 모달은 StepContent의 read-only 이벤트 차단 바깥에서 열리므로(§리뷰), 담당의 권한만으로는
  // "모달이 열려있는 동안 락을 상실"하는 레이스를 못 막는다 — canEditPatient AND 락 보유를 합성해
  // usePatientCrud/usePresetManagement/StepContent 모두가 이 값 하나만 신뢰하게 한다.
  const canMutateActivePatient =
    canEditPatient(activePatient, session) &&
    (!requiresLock(activePatient, session) || lockState.status === 'held');

  const {
    presets, presetMeta, presetError,
    presetModalJobId, presetEditingPreset, presetBrowseJobId,
    setPresetModalJobId, setPresetEditingPreset, setPresetBrowseJobId,
    reloadPresets,
    handlePresetSelect, handleSaveCustomPreset, closePresetManageModal, handleDeleteCustomPreset,
  } = usePresetManagement({ activeId, activeModules, session, setPatients, canMutateActivePatient });

  const {
    status: migrationStatus,
    result: migrationResult,
    start:  startMigration,
    retry:  retryMigration,
    reset:  resetMigration,
  } = useMigration({ session, settings });

  const isAdmin = session?.user?.role === 'admin' && isAuthenticated;
  const { showBanner: showOpsBanner, bannerMessage: opsBannerMessage } = useOpsStatus({ session, enabled: isAdmin });

  const {
    exportDropdown, setExportDropdown,
    handleExportSingle, handleExportSelected, handleExportBatch,
    handleExportBatchFormatSingle, handleExportBatchFormatSelected, handleExportBatchFormatAll,
    handleExportBatchTemplate,
  } = useExportHandlers({ activePatient, patients, selectedIds, dirtyAssessmentPatientId });

  const {
    extractProgress, setExtractProgress,
    handleInjectEMR, handleInjectConsultReply,
    handleEmrExtractBatch, handleExtractConsultation,
  } = useEMRIntegration({ activePatient, patients, selectedIds, session, setPatients, dirtyAssessmentPatientId });

  const handleStartIntakeRef = useRef(null);
  const handleResetPatientsRef = useRef(null);
  const handleOpenStatisticsRef = useRef(null); // PR2 §3 — Electron 메뉴가 구독

  // 현재 환자의 스텝 목록
  const videoAnalysisEnabled = !!serverConfig?.videoAnalysisEnabled;
  const steps = useMemo(
    () => buildSteps(activeModules, { videoAnalysisEnabled }),
    [activeModules, videoAnalysisEnabled]
  );
  const { currentStepIndex, setCurrentStepIndex, goToStep, goNext, goPrev, switchPatient } = useStepNavigation({
    steps, activeId, setActiveId, setShowSidebar,
    hasUnsavedAssessmentDraft: !!dirtyAssessmentPatientId, onBlockedByUnsavedDraft: blockedByUnsavedDraftAlert,
  });
  const { intakeShared, setIntakeShared, handleStartIntake, handleIntakeComplete } = useIntakeWizard({
    settings, session, setPatients, setActiveId, setCurrentStepIndex, setShowHome, videoAnalysisEnabled,
    hasUnsavedAssessmentDraft: !!dirtyAssessmentPatientId, onBlockedByUnsavedDraft: blockedByUnsavedDraftAlert,
  });
  handleStartIntakeRef.current = handleStartIntake;

  useEffect(() => {
    setPatientScope(getDefaultPatientScope(session));
    setDashboardScope(getDefaultPatientScope(session));
    setPatientSyncPaused(false);
  }, [session?.mode, session?.user?.id, session?.user?.role]);

  useEffect(() => {
    if (patients.length > 0 || intakeShared) {
      setPatientSyncPaused(false);
    }
  }, [patients.length, intakeShared]);

  const { syncState, syncNow, flushPatient, notifyLockOutcome } = usePatientSync({
    patients,
    setPatients,
    activeId,
    setActiveId,
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

  const syncSummary = useSyncStatusSummary(patients, syncState);

  const handleForceTakeover = useCallback(async () => {
    const holderName = lockState.holder?.holderName || '다른 사용자';
    const ok = await showConfirm(`${holderName}이(가) 편집 중인 환자입니다. 강제로 편집 권한을 가져오시겠습니까?`);
    if (!ok) return;
    await forceAcquire();
  }, [lockState.holder, forceAcquire]);

  // 대시보드 스코프 드롭다운용 의사 명부(경량 집계, PHI 미포함) 로드.
  // 초기 + 매 동기화 완료(lastSyncedAt) 후 갱신 → 옵션·카운트 최신 유지.
  const rosterIdentityRef = useRef(null);
  useEffect(() => {
    // 임시 비밀번호 상태에서는 서버가 이 조회를 403으로 거절한다(HF2) — 변경 전에는 부르지 않고, 플래그가 풀리면
    // 아래 deps가 바뀌어 바로 조회한다.
    if (!canUseDashboardScope || !isAuthenticated || !sessionVerified || session?.user?.mustChangePassword) {
      setDoctorRoster({ doctors: [], unassignedCount: 0 });
      setDoctorRosterStatus('loading');
      rosterIdentityRef.current = null;
      return undefined;
    }
    // 세션/조직 경계가 바뀌면(로그아웃→다른 계정/조직) 이전 조직의 명부를 즉시 비운다.
    // 새 fetch가 지연·실패해도 이전 조직 의사 이름/카운트가 드롭다운에 남지 않도록 방지.
    // (routine 재조회 = lastSyncedAt만 변경 시엔 비우지 않아 깜빡임 없음)
    const identity = `${session?.user?.id ?? ''}:${session?.user?.organizationId ?? ''}`;
    if (rosterIdentityRef.current !== identity) {
      rosterIdentityRef.current = identity;
      setDoctorRoster({ doctors: [], unassignedCount: 0 });
      setDoctorRosterStatus('loading');
    }
    let cancelled = false;
    fetchDoctorCounts({ session, settings })
      .then(roster => { if (!cancelled) { setDoctorRoster(roster); setDoctorRosterStatus('ready'); } })
      .catch(() => { if (!cancelled) setDoctorRosterStatus('error'); /* 명부는 마지막 성공값 유지, 상태만 error로 표시 */ });
    return () => { cancelled = true; };
    // session/settings 객체는 deps에서 제외(식별자 변동으로 인한 재조회 루프 방지)
  }, [canUseDashboardScope, isAuthenticated, sessionVerified, session?.user?.id, session?.user?.organizationId, session?.user?.mustChangePassword, syncState.lastSyncedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // 사이드바(patientScope)·대시보드(dashboardScope) 공통 scope 유효성 가드.
  // 명부 갱신 후 선택된 의사 userId(또는 __unassigned__)가 더 이상 유효하지 않으면
  // (퇴사·전체 재배정 등) 기본 스코프로 되돌린다. 두 스코프를 한 곳에서 같은 정책으로
  // 검증해야 Dashboard 자체 가드(→'all' 복귀)와 정책이 어긋나지 않는다.
  // status==='loading'|'error'에서는 보류 — 로딩 중 오탐, 실패 시 마지막 유효 명부 기준 유지.
  useEffect(() => {
    if (!hasIntranetSession(session)) return;
    if (doctorRosterStatus !== 'ready') return;
    const validScopes = getValidPatientScopes(doctorRoster, { canUseMineScope: canUseMinePatientScope });
    const fallback = getDefaultPatientScope(session);
    if (!validScopes.has(effectivePatientScope)) setPatientScope(fallback);
    if (!validScopes.has(effectiveDashboardScope)) setDashboardScope(fallback);
    // session 객체 자체는 deps에서 제외(식별자 변동 방지) — mode/role만 실질적으로 영향
  }, [session?.mode, session?.user?.role, doctorRosterStatus, doctorRoster, canUseMinePatientScope, effectivePatientScope, effectiveDashboardScope]); // eslint-disable-line react-hooks/exhaustive-deps

  // 대시보드 스코프 변경 pull이 진행 중인지 판정.
  // status==='syncing' AND 조건을 반드시 유지 — loadedScope 단독 비교는 실패/오프라인 시 영구 로딩처럼 보임.
  const isDashboardScopeLoading =
    canUseDashboardScope &&
    syncState.status === 'syncing' &&
    syncState.loadedScope !== effectiveDashboardScope;

  const {
    savedItems, setSavedItems, saveName, setSaveName, lastAutoSave, legacyItems,
    handleSave, handleOverwriteSave, handleLoad, handleDelete, openLoadModal,
  } = useWorkspacePersistence({
    patients, setPatients,
    session, settings, serverConfig,
    setActiveId, setCurrentStepIndex, setIntakeShared, setShowHome,
    setShowSaveModal, setShowLoadModal,
    disabled: isIntranetMode && (configLoading || !!configError),
    dirtyAssessmentPatientId, onBlockedByUnsavedDraft: blockedByUnsavedDraftAlert,
  });
  const currentStep = steps[currentStepIndex] || steps[0];

  // 현재 스텝의 모듈 정보
  const activeModuleId = currentStep?.moduleId || null;
  const activeModule = activeModuleId ? getModule(activeModuleId) : null;

  const {
    updatePatient, updateShared, updateActiveModules,
    updateModule, updateModuleById, updateDiagnoses,
    addPatient, removePatient, removeSelectedPatients,
    handleBatchImport, handleLoadTestData,
  } = usePatientCrud({
    activeId, activeModuleId, session, settings,
    patients, setPatients,
    selectedIds, setSelectedIds,
    setErrors,
    setActiveId, setCurrentStepIndex,
    setIntakeShared, setShowHome,
    handleStartIntake,
    canMutateActivePatient,
    dirtyAssessmentPatientId, onBlockedByUnsavedDraft: blockedByUnsavedDraftAlert,
  });

  // 환자 전환 게이팅(§5-3): synced면 즉시 전환, conflict면 push 자체를 시도하지 않고 확인 후
  // 이동, dirty/local-only면 flushPatient로 기존 autosync 큐에 합류해 저장을 기다린 뒤 전환.
  const handleSwitchPatient = useCallback(async (patientId) => {
    if (patientId === activeId) { switchPatient(patientId); return; }
    // switchPatient(useStepNavigation)도 같은 조건으로 다시 막지만, 여기서 먼저 막아야
    // 아래 동기화 상태 확인 다이얼로그("저장되지 않은 변경사항이…")가 무관하게 뜨지 않는다.
    if (dirtyAssessmentPatientId) { blockedByUnsavedDraftAlert(); return; }

    const current = patients.find(p => p.id === activeId);
    const status = current?.sync?.syncStatus;

    if (!isIntranetMode || !current || status === 'synced') {
      switchPatient(patientId);
      return;
    }

    const proceedUnresolved = (message) => async () => {
      const ok = await showConfirm(message);
      if (!ok) return false;
      setPatients(prev => prev.map(p => (
        p.id === current.id ? { ...p, sync: { ...(p.sync || {}), syncPaused: true } } : p
      )));
      switchPatient(patientId);
      return true;
    };

    if (status === 'conflict') {
      await proceedUnresolved('현재 환자가 충돌 상태입니다. 해결하지 않고 이동하시겠습니까?')();
      return;
    }

    if (status === 'dirty' || status === 'local-only') {
      const ok = await showConfirm('저장되지 않은 변경사항이 있습니다. 저장 후 이동하시겠습니까?');
      if (!ok) return;

      let outcome = 'still-dirty';
      for (let attempt = 0; attempt < 3 && outcome === 'still-dirty'; attempt += 1) {
        outcome = await flushPatient(current.id);
      }

      if (outcome === 'synced') { switchPatient(patientId); return; }
      if (outcome === 'conflict') {
        await proceedUnresolved('저장 중 충돌이 발생했습니다. 해결하지 않고 이동하시겠습니까?')();
        return;
      }
      if (outcome === 'still-dirty') {
        await showAlert('아직 저장 중입니다. 잠시 후 다시 시도해 주세요.');
        return;
      }
      // lock-lost / permission / offline / error
      await proceedUnresolved('저장에 실패했습니다(권한 변경 또는 통신 오류). 저장하지 않고 이동하시겠습니까?')();
      return;
    }

    switchPatient(patientId);
  }, [activeId, patients, switchPatient, flushPatient, setPatients, dirtyAssessmentPatientId, blockedByUnsavedDraftAlert, isIntranetMode]);

  // 영상 분석 서버 적용 후 서버 동기화 환자를 목록에 반영(로컬 id 보존 → id로 교체).
  const onVideoServerApplied = useCallback((serverPatient) => {
    if (!serverPatient?.id) return;
    setPatients(prev => prev.map(p => (p.id === serverPatient.id ? serverPatient : p)));
  }, [setPatients]);

  // 평가 완료 시 evaluationDate 자동 설정
  useEvaluationDateSync({ activeId, patients, setPatients, session });

  // Electron 메뉴 이벤트
  useElectronMenuEvents({ handleResetPatientsRef, handleStartIntakeRef, handleOpenStatisticsRef });

  // 종합소견 편집 dirty 상태를 Electron main에 동기화한다 — 창 닫기(win.on('close'))와
  // 메뉴 새로고침(Ctrl+R)이 이 값을 보고 네이티브 confirm을 띄운다. PHI(환자 ID)는 절대
  // 넘기지 않고 boolean만 전달한다(main.js의 set-has-unsaved-draft 채널).
  // preload가 채널을 노출하지 않는 빌드(standalone/웹)에서는 optional chaining으로 조용히 no-op.
  useEffect(() => {
    getLifecycleBridge()?.setHasUnsavedDraft?.(!!dirtyAssessmentPatientId);
  }, [dirtyAssessmentPatientId]);

  // 웹 탭 닫기·새로고침 경고 — Electron 인트라넷 빌드는 setHasUnsavedDraft 채널이 있고
  // win.on('close')/Ctrl+R이 이미 main.js에서 네이티브 confirm으로 가드한다(A-1). 그 경우
  // 여기서도 beforeunload를 등록하면, 사용자가 그 네이티브 confirm에서 "계속"을 선택해
  // win.close()/reload()가 실행돼도 renderer에 남아있는 beforeunload가 다시 개입해
  // Electron이 페이지의 beforeunload를 존중하는 특성상 종료가 조용히 취소되거나 confirm이
  // 이중으로 뜰 수 있다. 그래서 그 채널이 없는 웹/standalone 빌드에서만 폴백으로 등록한다
  // (standalone은 close 가로채기가 없어 beforeunload가 유일한 안전망).
  useEffect(() => {
    // 셸이 창 닫기를 가로채면(인트라넷 셸 setHasUnsavedDraft — 구 셸 포함, 키로 판정) beforeunload를 두지 않는다.
    if (detectRuntime().hasNativeCloseGuard) return;
    const handleBeforeUnload = (e) => {
      if (!dirtyAssessmentPatientId) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirtyAssessmentPatientId]);

  const displayPatients = usePatientList(patients, patientFilters);

  // 계산 결과
  const calc = useMemo(() => {
    if (!activePatient || isRedactedPatientRecord(activePatient) || !activePatient.data || !activeModule?.computeCalc) return {};
    return activeModule.computeCalc({
      shared: activePatient.data.shared || {},
      module: activePatient.data.modules?.[activeModuleId] || {}
    });
  }, [activePatient, activeModule, activeModuleId]);

  // 통합 미리보기 텍스트
  const unifiedPreviewText = useMemo(() => {
    if (!activePatient || isRedactedPatientRecord(activePatient) || activeModules.length === 0) return '';
    return generateUnifiedReport(activePatient);
  }, [activePatient, activeModules]);

  // --- 핸들러 ---

  const handleSaveSettingsAndClose = (newSettings) => {
    handleSaveSettings(newSettings);
    setShowSettings(false);
  };

  const showPatientList = useCallback(() => {
    setShowHome(false);
    setShowSidebar(true);
  }, []);

  // 부팅 화면 아래 "로컬 모드로 전환" 탈출구 — 구현은 src/app/BootGate.tsx(P2-25).
  const withLocalEscape = (content) => withLocalEscapeFor(content, switchToLocalMode);

  const handleResetPatients = async () => {
    if (dirtyAssessmentPatientId) { blockedByUnsavedDraftAlert(); return; }
    const ok = await showConfirm('현재 작업 중인 환자 목록을 모두 삭제하시겠습니까?');
    if (!ok) return;
    setPatientSyncPaused(true);
    setPatients([]);
    setActiveId(null);
    setSelectedIds(new Set());
    setIntakeShared(null);
    setShowHome(true);
    clearAutoSavedWorkspace({ session, settings, serverConfig })
      .catch(error => {
        console.warn('[autosave-clear]', error);
      });
  };
  handleResetPatientsRef.current = handleResetPatients;

  const { markRemoteDeleteConflict, handleResolveConflict, handleCorrectServerIdentity } = useConflictResolution({
    setPatients, activeId, setActiveId, setCurrentStepIndex, session, settings, setConflictPatientId, syncNow,
    dirtyAssessmentPatientId, onBlockedByUnsavedDraft: blockedByUnsavedDraftAlert,
  });

  // 로그아웃은 렌더러 세션만 정리하는 게 아니라(Electron은 서버 세션까지 정리) 화면을
  // 완전히 떠나므로 dirty 편집 중이면 막는다.
  const handleLogout = () => {
    if (dirtyAssessmentPatientId) { blockedByUnsavedDraftAlert(); return; }
    logout();
  };

  const handleShowHome = () => {
    if (dirtyAssessmentPatientId) { blockedByUnsavedDraftAlert(); return; }
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
  handleOpenStatisticsRef.current = handleOpenStatistics;

  // 렌더러가 아는 가용성을 Electron main에 전파해 메뉴를 켜고 끈다(main은 서버 설정을 모름) —
  // set-has-unsaved-draft와 같은 renderer→main IPC 패턴.
  useEffect(() => {
    getLifecycleBridge()?.setStatsAvailable?.(statsAvailable);
  }, [statsAvailable]);

  // 공통 모달 props (AppModals)
  const modalsProps = {
    session, settings, integrationStatus, syncState, syncNow, logout: handleLogout,
    patients, activePatient, steps,
    setActiveId, setCurrentStepIndex, setShowHome,
    hasUnsavedAssessmentDraft: !!dirtyAssessmentPatientId, onBlockedByUnsavedDraft: blockedByUnsavedDraftAlert,

    showAdminConsole, setShowAdminConsole,
    showAccountProfile, setShowAccountProfile,
    showChangePassword, setShowChangePassword,
    showSettings, setShowSettings, handleSaveSettings: handleSaveSettingsAndClose,
    showMigrationReport, setShowMigrationReport,
    migrationStatus, migrationResult, startMigration, retryMigration, resetMigration,
    reloadPresets,

    showSaveModal, setShowSaveModal,
    saveName, setSaveName, savedItems, handleSave, handleOverwriteSave, handleDelete,
    showLoadModal, setShowLoadModal, legacyItems, handleLoad,

    showBatchImport, setShowBatchImport, handleBatchImport,

    conflictPatient, setConflictPatientId, handleResolveConflict, handleCorrectServerIdentity, markRemoteDeleteConflict,

    presetModalJobId, setPresetModalJobId, presetEditingPreset, setPresetEditingPreset,
    presetBrowseJobId, setPresetBrowseJobId,
    presets, handleSaveCustomPreset, closePresetManageModal, handleDeleteCustomPreset, handlePresetSelect,
  };

  // ===========================================
  // 인트라넷 모드 부팅 게이팅
  // ===========================================
  const bootScreen = renderBootGate({
    isIntranetMode, configLoading, configError, session, settings, sessionVerified, isAuthenticated,
    onSwitchToLocal: switchToLocalMode,
  });
  if (bootScreen) return bootScreen;

  // 부팅 게이트 뒤의 화면 — 분기 순서(통계 → 서버 환자 로딩 → 랜딩/대시보드 → 위자드 → 작업 화면)는
  // src/app/useScreenRouter.ts selectScreen(P2-26).
  const screen = selectScreen({
    activeScreen,
    intranetSession: hasIntranetSession(session),
    patientCount: patients.length,
    activeId,
    hasIntake: !!intakeShared,
    syncStatus: syncState.status,
    serverPatientCount: syncState.serverPatientCount,
  });

  // ===========================================
  // 통계분석 워크벤치 (PR2 §1) — 환자 동기화 로딩·자동 랜딩보다 먼저(이 화면은 환자 목록을 쓰지 않는다)
  // ===========================================
  if (screen === 'statistics') {
    return (
      <StatisticsWorkbench
        session={session}
        serverConfig={serverConfig}
        statsAvailable={statsAvailable}
        refetchConfig={refetchConfig}
        configRefreshing={statsConfigRefreshing}
        configRefreshError={statsConfigRefreshError}
        onClose={handleCloseStatistics}
      />
    );
  }

  // ===========================================
  // 인트라넷 초기 부팅: 서버 환자 목록 pull 중 → 로딩 화면(pull 뒤 mine=0이지만 서버에 환자가 있으면 자동 랜딩 억제 —
  // 환자 목록 껍데기에서 scope 전환·재마이그레이션 등 다음 행동을 하게 함)
  // ===========================================
  if (screen === 'serverPatientsLoading') {
    return withLocalEscape(
      <div className="app-boot-overlay">
        <div className="app-boot-box">
          <p>서버 환자 목록을 불러오는 중입니다…</p>
        </div>
      </div>
    );
  }

  // ===========================================
  // 랜딩 / 대시보드 화면
  // ===========================================
  // 자동 진입: 환자가 없을 때만 랜딩으로 보낸다.
  //   인트라넷에서 mine=0이지만 서버에 환자가 있으면 자동 랜딩을 억제 (목록 화면에서 scope 전환 등으로 해결 가능).
  // 사용자 진입: 헤더의 대시보드/홈 버튼(showHome)은 서버 상태와 무관하게 항상 허용.
  if (screen === 'landing') {
    return (
      <div className="app-layout landing-layout">
        <LandingScreen
          patients={patients}
          onStartIntake={handleStartIntake}
          onOpenLoadModal={openLoadModal}
          onShowSaveModal={() => setShowSaveModal(true)}
          onShowBatchImport={() => setShowBatchImport(true)}
          onLoadTestData={handleLoadTestData}
          onShowSettings={() => setShowSettings(true)}
          onShowStatistics={handleOpenStatistics}
          statsAvailable={statsAvailable}
          onGoBack={() => setShowHome(false)}
          onResetPatients={handleResetPatients}
          onSelectPatient={(id) => guardedSelectPatient(id)}
          hasIntranetSession={hasIntranetSession(session)}
          session={session}
          dashboardScope={effectiveDashboardScope}
          onDashboardScopeChange={(s) => {
            setDashboardScope(s);
            // 로드 스코프를 대시보드 선택과 일치시킨다. 특정 의사/미배정은 그 범위만,
            // 'all'은 조직 전체만 로드(정규화는 effectivePatientScope에서 처리).
            // usePatientSync가 scope 변경 시 해당 범위로 재pull → 전체 payload는 'all'일 때만.
            setPatientScope(s);
          }}
          canUseDashboardScope={canUseDashboardScope}
          doctorRoster={doctorRoster}
          isDashboardScopeLoading={isDashboardScopeLoading}
          onShowPatientList={showPatientList}
          canShowPatientList={
            hasIntranetSession(session) &&
            ((syncState.serverPatientCount ?? 0) > 0 || patients.length > 0)
          }
        />
        <AppModals {...modalsProps} />
      </div>
    );
  }

  // ===========================================
  // 신규 환자 위자드 (환자 생성 전)
  // ===========================================
  if (screen === 'intake') {
    return (
      <IntakeWizard
        shared={intakeShared}
        onSharedChange={setIntakeShared}
        hasExistingPatients={patients.length > 0}
        onCancel={() => { setIntakeShared(null); if (patients.length > 0) setActiveId(patients[0].id); }}
        onComplete={handleIntakeComplete}
        errors={errors}
        presets={presets}
        presetMeta={presetMeta}
        presetError={presetError}
        session={session}
      />
    );
  }

  // ===========================================
  // 메인 작업 화면 (위자드 전체 흐름)
  // ===========================================
  // 메인 작업 화면 — src/app/screens/WorkspaceScreen.jsx로 옮겼다(P2-24, 로직 변경 0). 그 화면이 쓰는 App 지역 값을 그대로 넘긴다.
  const workspaceProps = {
    activeId,
    activeModule,
    activeModuleId,
    activeModules,
    activePatient,
    addPatient,
    aiAvailable,
    calc,
    canMutateActivePatient,
    currentStep,
    currentStepIndex,
    displayPatients,
    doctorRoster,
    effectivePatientScope,
    errors,
    exportDropdown,
    extractProgress,
    goNext,
    goPrev,
    goToStep,
    handleAssessmentEditingChange,
    handleEmrExtractBatch,
    handleExportBatch,
    handleExportBatchFormatAll,
    handleExportBatchFormatSelected,
    handleExportBatchFormatSingle,
    handleExportBatchTemplate,
    handleExportSelected,
    handleExportSingle,
    handleExtractConsultation,
    handleForceTakeover,
    handleInjectConsultReply,
    handleInjectEMR,
    handleLogout,
    handleOpenStatistics,
    handlePresetSelect,
    handleResetPatients,
    handleShowHome,
    handleSwitchPatient,
    integrationStatus,
    isIntranetMode,
    lastAutoSave,
    lockState,
    modalsProps,
    onVideoServerApplied,
    openLoadModal,
    opsBannerMessage,
    patientFilters,
    patients,
    presetError,
    presetMeta,
    presets,
    removePatient,
    removeSelectedPatients,
    selectedIds,
    serverConfig,
    session,
    setConflictPatientId,
    setDashboardScope,
    setExportDropdown,
    setExtractProgress,
    setPatientFilters,
    setPatientScope,
    setPatientSyncPaused,
    setPresetBrowseJobId,
    setPresetModalJobId,
    setSelectedIds,
    setShowAccountProfile,
    setShowAdminConsole,
    setShowBatchImport,
    setShowChangePassword,
    setShowSaveModal,
    setShowSettings,
    setShowSidebar,
    settings,
    showOpsBanner,
    showSidebar,
    statsAvailable,
    steps,
    syncState,
    syncSummary,
    unifiedPreviewText,
    updateActiveModules,
    updateDiagnoses,
    updateModule,
    updateModuleById,
    updatePatient,
    updateShared,
  };
  return <WorkspaceScreen {...workspaceProps} />;
}

export default App;
