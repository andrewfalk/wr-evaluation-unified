import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { getModule, getAllModules } from './core/moduleRegistry';
import { LandingScreen } from './core/components/LandingScreen';
import { IntakeWizard } from './core/components/IntakeWizard';
import { PatientSidebar } from './core/components/PatientSidebar';
import { StepContent } from './core/components/StepContent';
import { MainHeader } from './core/components/MainHeader';
import { StepIndicator } from './core/components/StepIndicator';
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
import { suggestModules } from './core/utils/diagnosisMapping';
import { showAlert, showConfirm } from './core/utils/platform';
import { generateUnifiedReport } from './core/utils/reportGenerator';
import { buildSteps } from './core/utils/steps';
import { isRedactedPatientRecord } from './core/services/patientRecords';
import { canEditPatient } from './core/utils/patientOwnership';
import { getDefaultPatientScope, normalizePatientScopeForSession, getValidPatientScopes } from './core/utils/patientScope';
import { clearAutoSavedWorkspace } from './core/services/workspaceRepository';
import { fetchDoctorCounts } from './core/services/patientServerRepository';
import { clearAllLockTokens } from './core/services/lockTokenStore';
import { LoginModal } from './core/components/LoginModal';
import { ChangePasswordModal } from './core/components/ChangePasswordModal';
import { SwitchToLocalButton } from './core/components/SwitchToLocalButton';

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
  const [showHome, setShowHome] = useState(false);
  const [conflictPatientId, setConflictPatientId] = useState(null);
  const { serverConfig, configLoading, configError } = useServerConfig({ session, settings });
  const { aiAvailable } = useAIAvailable({ serverConfig, session });
  const isIntranetMode =
    session?.mode === 'intranet' || settings?.integrationMode === 'intranet';
  const canUseMinePatientScope = session?.mode !== 'intranet' || session?.user?.role === 'doctor';
  const effectivePatientScope = normalizePatientScopeForSession(session, patientScope);
  const canUseDashboardScope = session?.mode === 'intranet' && !!session?.user?.id;
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
  } = useExportHandlers({ activePatient, patients, selectedIds });

  const {
    extractProgress, setExtractProgress,
    handleInjectEMR, handleInjectConsultReply,
    handleEmrExtractBatch, handleExtractConsultation,
  } = useEMRIntegration({ activePatient, patients, selectedIds, session, setPatients });

  const handleStartIntakeRef = useRef(null);
  const handleResetPatientsRef = useRef(null);

  // 현재 환자의 스텝 목록
  const videoAnalysisEnabled = !!serverConfig?.videoAnalysisEnabled;
  const steps = useMemo(
    () => buildSteps(activeModules, { videoAnalysisEnabled }),
    [activeModules, videoAnalysisEnabled]
  );
  const { currentStepIndex, setCurrentStepIndex, goToStep, goNext, goPrev, switchPatient } = useStepNavigation({ steps, activeId, setActiveId, setShowSidebar });
  const { intakeShared, setIntakeShared, handleStartIntake, handleIntakeComplete } = useIntakeWizard({ settings, session, setPatients, setActiveId, setCurrentStepIndex, setShowHome, videoAnalysisEnabled });
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
    if (!canUseDashboardScope || !isAuthenticated || !sessionVerified) {
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
  }, [canUseDashboardScope, isAuthenticated, sessionVerified, session?.user?.id, session?.user?.organizationId, syncState.lastSyncedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // 사이드바(patientScope)·대시보드(dashboardScope) 공통 scope 유효성 가드.
  // 명부 갱신 후 선택된 의사 userId(또는 __unassigned__)가 더 이상 유효하지 않으면
  // (퇴사·전체 재배정 등) 기본 스코프로 되돌린다. 두 스코프를 한 곳에서 같은 정책으로
  // 검증해야 Dashboard 자체 가드(→'all' 복귀)와 정책이 어긋나지 않는다.
  // status==='loading'|'error'에서는 보류 — 로딩 중 오탐, 실패 시 마지막 유효 명부 기준 유지.
  useEffect(() => {
    if (session?.mode !== 'intranet') return;
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
    errors, setErrors,
    setActiveId, setCurrentStepIndex,
    setIntakeShared, setShowHome,
    handleStartIntake,
    canMutateActivePatient,
  });

  // 환자 전환 게이팅(§5-3): synced면 즉시 전환, conflict면 push 자체를 시도하지 않고 확인 후
  // 이동, dirty/local-only면 flushPatient로 기존 autosync 큐에 합류해 저장을 기다린 뒤 전환.
  const handleSwitchPatient = useCallback(async (patientId) => {
    if (patientId === activeId) { switchPatient(patientId); return; }

    const current = patients.find(p => p.id === activeId);
    const status = current?.sync?.syncStatus;

    if (!current || status === 'synced') {
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
  }, [activeId, patients, switchPatient, flushPatient, setPatients]);

  // 영상 분석 서버 적용 후 서버 동기화 환자를 목록에 반영(로컬 id 보존 → id로 교체).
  const onVideoServerApplied = useCallback((serverPatient) => {
    if (!serverPatient?.id) return;
    setPatients(prev => prev.map(p => (p.id === serverPatient.id ? serverPatient : p)));
  }, [setPatients]);

  // 평가 완료 시 evaluationDate 자동 설정
  useEvaluationDateSync({ activeId, patients, setPatients, session });

  // Electron 메뉴 이벤트
  useElectronMenuEvents({ handleResetPatientsRef, handleStartIntakeRef });

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

  const withLocalEscape = (content) => (
    <>
      {content}
      <div className="app-boot-escape-hatch">
        <SwitchToLocalButton onSwitch={switchToLocalMode} />
      </div>
    </>
  );

  const handleResetPatients = async () => {
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
  });

  // 공통 모달 props (AppModals)
  const modalsProps = {
    session, settings, integrationStatus, syncState, syncNow, logout,
    patients, activePatient, steps,
    setActiveId, setCurrentStepIndex, setShowHome,

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
  if (isIntranetMode && configLoading) {
    return withLocalEscape(
      <div className="app-boot-overlay">
        <div className="app-boot-box">
          <p>서버에 연결 중입니다…</p>
        </div>
      </div>
    );
  }

  if (isIntranetMode && configError) {
    const serverUrl = session?.apiBaseUrl || settings?.apiBaseUrl || '';
    return withLocalEscape(
      <div className="app-boot-overlay">
        <div className="app-boot-box app-boot-error">
          <h2>서버 연결 실패</h2>
          <p>{configError}</p>
          <p className="app-boot-hint">
            인트라넷 서버({serverUrl})에 연결할 수 없습니다.<br />
            서버 상태를 확인하거나 관리자에게 문의하세요.
          </p>
          <button
            className="btn btn-secondary"
            onClick={() => window.location.reload()}
          >
            다시 시도
          </button>
        </div>
      </div>
    );
  }

  // Boot-time session verification in progress (persisted intranet session, not yet confirmed).
  // session.mode==='intranet' && !sessionVerified means the /api/auth/csrf check is in flight.
  if (isIntranetMode && session?.mode === 'intranet' && !sessionVerified) {
    return withLocalEscape(
      <div className="app-boot-overlay">
        <div className="app-boot-box">
          <p>세션을 확인하는 중입니다…</p>
        </div>
      </div>
    );
  }

  // Login guard: intranet mode but not authenticated (no persisted session, or
  // verification failed and session was reset to local). Non-dismissable.
  if (isIntranetMode && !isAuthenticated) {
    return withLocalEscape(
      <LoginModal apiBaseUrl={session?.apiBaseUrl || settings?.apiBaseUrl || ''} />
    );
  }

  // Password change guard: server flagged must_change_password (e.g. seed admin first login).
  // Blocks all other UI until the password is changed. Non-dismissable.
  if (isIntranetMode && isAuthenticated && session?.user?.mustChangePassword) {
    return withLocalEscape(
      <ChangePasswordModal apiBaseUrl={session?.apiBaseUrl || settings?.apiBaseUrl || ''} />
    );
  }

  // ===========================================
  // 인트라넷 초기 부팅: pull 중이거나 서버에 환자가 존재하면 랜딩 억제
  // ===========================================
  // pull 중: 아직 응답 전 → 로딩 화면
  // pull 완료 후 mine=0이지만 serverPatientCount>0: 서버에 환자 있음(다른 의사 담당 등)
  //   → 환자 목록 껍데기를 보여줘서 scope 전환, 재마이그레이션 등 다음 행동 가능하게 함
  const isBootingFromServer =
    session?.mode === 'intranet'
    && patients.length === 0
    && !activeId
    && !intakeShared
    && !showHome;

  if (isBootingFromServer && syncState.status === 'syncing') {
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
  const hasAnyServerPatient =
    session?.mode === 'intranet' && (syncState.serverPatientCount ?? 0) > 0;
  const shouldAutoShowLanding =
    patients.length === 0 && !activeId && !intakeShared;

  if (showHome || (!hasAnyServerPatient && shouldAutoShowLanding)) {
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
          onGoBack={() => setShowHome(false)}
          onResetPatients={handleResetPatients}
          onSelectPatient={(id) => { setActiveId(id); setCurrentStepIndex(0); setShowHome(false); }}
          isIntranetMode={session?.mode === 'intranet'}
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
            session?.mode === 'intranet' &&
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
  if (intakeShared) {
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
  const shared = activePatient?.data?.shared || {};
  const diagnoses = shared.diagnoses || [];
  const allModules = getAllModules();
  const suggested = suggestModules(diagnoses);

  // 현재 스텝의 모듈에 대한 EvaluationComponent
  const EvaluationComponent = activeModule?.EvaluationComponent;


  // 헤더 타이틀
  const headerTitle = currentStep?.group === 'shared'
    ? currentStep.label
    : `${currentStep?.icon || ''} ${currentStep?.moduleName || ''} - ${currentStep?.label || ''}`;

  return (
    <div className="app-layout">
      <PatientSidebar
        showSidebar={showSidebar}
        onClose={() => setShowSidebar(false)}
        patients={patients}
        displayPatients={displayPatients}
        activeId={activeId}
        filters={patientFilters}
        setFilters={setPatientFilters}
        selectedIds={selectedIds}
        setSelectedIds={setSelectedIds}
        onAddPatient={addPatient}
        onShowBatchImport={() => setShowBatchImport(true)}
        onSwitchPatient={handleSwitchPatient}
        onRemovePatient={removePatient}
        onRemoveSelectedPatients={removeSelectedPatients}
        onResolveConflict={setConflictPatientId}
        scope={effectivePatientScope}
        onScopeChange={scope => {
          setPatientSyncPaused(false);
          // normalizePatientScopeForSession: admin의 'mine'만 'all'로 치환하고,
          // 의사 userId/'__unassigned__'/'all'은 그대로 통과시킨다(서버가 재검증).
          const next = normalizePatientScopeForSession(session, scope);
          setPatientScope(next);
          // 대시보드 스코프도 함께 맞춰 로드된 데이터와 통계 뷰가 어긋나지 않게 한다
          // (예: 대시보드에서 특정 의사를 보던 중 사이드바를 토글한 경우).
          setDashboardScope(next);
        }}
        doctorRoster={doctorRoster}
        session={session}
        serverUnassignedCount={syncState?.serverUnassignedCount ?? null}
      />

      {/* 메인 영역 */}
      <div className="main-area">
        {isIntranetMode && (syncSummary.conflictCount > 0 || syncSummary.lockLostCount > 0 || syncSummary.pendingCount > 0 || syncSummary.offline) && (
          <div className="sync-status-banner" role="status">
            {syncSummary.conflictCount > 0 && (
              <button
                type="button"
                className="sync-status-badge sync-status-badge--conflict"
                onClick={() => setShowSidebar(true)}
                title="사이드바에서 충돌 환자의 Resolve 버튼으로 해결하세요"
              >충돌 {syncSummary.conflictCount}건</button>
            )}
            {syncSummary.lockLostCount > 0 && (
              <button
                type="button"
                className="sync-status-badge sync-status-badge--lock"
                onClick={() => setShowSidebar(true)}
                title="다른 사용자가 편집 중이어서 저장되지 못한 환자가 있습니다"
              >락 상실 {syncSummary.lockLostCount}건</button>
            )}
            {syncSummary.pendingCount > 0 && (
              <span className="sync-status-badge sync-status-badge--pending">저장 대기 {syncSummary.pendingCount}건</span>
            )}
            {syncSummary.offline && (
              <span className="sync-status-badge sync-status-badge--offline">동기화 오류(오프라인 등) — 잠시 후 재시도됩니다</span>
            )}
          </div>
        )}
        <MainHeader
          title={headerTitle}
          lastAutoSave={lastAutoSave}
          integrationStatus={integrationStatus}
          session={session}
          onShowAdminConsole={() => setShowAdminConsole(true)}
          onLogout={logout}
          onChangePassword={() => setShowChangePassword(true)}
          onShowAccountProfile={() => setShowAccountProfile(true)}
          patients={patients}
          activePatient={activePatient}
          activeModules={activeModules}
          selectedIds={selectedIds}
          extractProgress={extractProgress}
          setExtractProgress={setExtractProgress}
          exportDropdown={exportDropdown}
          setExportDropdown={setExportDropdown}
          onShowHome={() => setShowHome(true)}
          onResetPatients={handleResetPatients}
          onToggleSidebar={() => setShowSidebar(v => !v)}
          onShowSaveModal={() => setShowSaveModal(true)}
          onOpenLoadModal={openLoadModal}
          onShowSettings={() => setShowSettings(true)}
          exportHandlers={{
            onExportSingle: handleExportSingle,
            onExportSelected: handleExportSelected,
            onExportBatch: handleExportBatch,
            onExportBatchFormatSingle: handleExportBatchFormatSingle,
            onExportBatchFormatSelected: handleExportBatchFormatSelected,
            onExportBatchFormatAll: handleExportBatchFormatAll,
            onExportBatchTemplate: handleExportBatchTemplate,
          }}
          emrHandlers={{
            onEmrExtractBatch: handleEmrExtractBatch,
            onExtractConsultation: handleExtractConsultation,
            onInjectEMR: handleInjectEMR,
            onInjectConsultReply: handleInjectConsultReply,
          }}
        />

        {showOpsBanner && (
          <button
            className="ops-alert-banner"
            type="button"
            onClick={() => setShowAdminConsole(true)}
          >
            {opsBannerMessage}
          </button>
        )}

        {false && showOpsBanner && (
          <button
            className="ops-alert-banner"
            type="button"
            onClick={() => setShowAdminConsole(true)}
          >
            백업 이상 감지 — 관리자 콘솔 &gt; 운영 상태 탭에서 확인하세요
          </button>
        )}

        {activePatient && (
          <>
            {/* 스텝 인디케이터 */}
            <StepIndicator steps={steps} currentStepIndex={currentStepIndex} goToStep={goToStep} />

            {/* 권한 없는 환자 안내 (스텝 탭 ↔ 콘텐츠 사이) */}
            {!canEditPatient(activePatient, session) && (
              <div className="read-only-banner" role="status">
                담당 의사가 아니므로 조회만 가능합니다.
              </div>
            )}

            {/* 편집 권한은 있지만 다른 사용자가 활발히 편집 중이거나(락 선점), 락을 상실한 경우 */}
            {canEditPatient(activePatient, session) && lockState.status === 'held-by-other' && (
              <div className="read-only-banner" role="status">
                {lockState.holder?.holderName ? `${lockState.holder.holderName}님이` : '다른 사용자가'} 편집 중입니다. 조회만 가능합니다.
                <button type="button" className="btn btn-secondary btn-xs" style={{ marginLeft: 8 }} onClick={handleForceTakeover}>
                  강제로 편집 권한 가져오기
                </button>
              </div>
            )}
            {canEditPatient(activePatient, session) && lockState.status === 'lost' && (
              <div className="read-only-banner" role="status">
                편집 권한을 상실했습니다(세션 만료 또는 담당의 변경). 새로고침 후 다시 시도하세요.
              </div>
            )}

            {/* 동기화 권한 거부 알림: 다른 디바이스에서 만든 dirty 환자가 더 이상 본인 담당이 아닐 때 */}
            {syncState?.lastPermissionDeniedCount > 0 && (
              <div className="read-only-banner" role="status" style={{ background: '#fde2e2', color: '#9b1c1c', borderColor: '#f5b5b5' }}>
                권한 없음으로 동기화되지 않은 환자: {syncState.lastPermissionDeniedCount}건. 담당 의사 변경 또는 관리자 문의가 필요합니다.
              </div>
            )}

            {/* 콘텐츠 */}
            <div className={`main-content ${currentStep.id === 'info' ? 'main-content-dual' : (currentStep.id === 'assessment' || currentStep.id === 'videoAnalysis') ? '' : 'main-content-single'}`}>
              <StepContent
                currentStep={currentStep}
                activePatient={activePatient}
                shared={shared}
                diagnoses={diagnoses}
                activeModules={activeModules}
                allModules={allModules}
                suggested={suggested}
                activeModuleId={activeModuleId}
                EvaluationComponent={EvaluationComponent}
                calc={calc}
                unifiedPreviewText={unifiedPreviewText}
                errors={errors}
                settings={settings}
                session={session}
                presets={presets}
                presetMeta={presetMeta}
                presetError={presetError}
                aiAvailable={aiAvailable}
                videoAnalysisFixtureMode={!!serverConfig?.videoAnalysisFixtureMode}
                serverConfig={serverConfig}
                updatePatient={updatePatient}
                onVideoServerApplied={onVideoServerApplied}
                updateShared={updateShared}
                updateModule={updateModule}
                updateModuleById={updateModuleById}
                updateDiagnoses={updateDiagnoses}
                updateActiveModules={updateActiveModules}
                handlePresetSelect={handlePresetSelect}
                setPresetModalJobId={setPresetModalJobId}
                setPresetBrowseJobId={setPresetBrowseJobId}
                canMutate={canMutateActivePatient}
              />
            </div>

            {/* 이전/다음 버튼 */}
            <div className="wizard-nav">
              <button className="btn btn-secondary" onClick={goPrev} disabled={currentStepIndex === 0}>
                &larr; 이전
              </button>
              <span className="wizard-nav-count">
                {currentStepIndex + 1} / {steps.length}
              </span>
              <button className="btn btn-primary" onClick={goNext} disabled={currentStepIndex >= steps.length - 1}>
                다음 &rarr;
              </button>
            </div>
          </>
        )}
      </div>

      {/* 모달들 */}
      <AppModals {...modalsProps} />
    </div>
  );
}

export default App;
