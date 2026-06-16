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
import { suggestModules } from './core/utils/diagnosisMapping';
import { showConfirm } from './core/utils/platform';
import { generateUnifiedReport } from './core/utils/reportGenerator';
import { buildSteps } from './core/utils/steps';
import { isRedactedPatientRecord } from './core/services/patientRecords';
import { canEditPatient } from './core/utils/patientOwnership';
import { clearAutoSavedWorkspace } from './core/services/workspaceRepository';
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

function getDefaultPatientScope(session) {
  return session?.mode === 'intranet' && session?.user?.role !== 'doctor'
    ? 'all'
    : 'mine';
}

// 모듈 등록 (사이드이펙트 import)
import './modules/knee';
import './modules/spine';
import './modules/cervical';
import './modules/shoulder';
import './modules/elbow';
import './modules/wrist';

function App() {
  const { session, setSession, resetToLocalSession, isAuthenticated, sessionVerified, logout } = useAuth();
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
  useAuthSync({ session, setSession, resetToLocalSession });
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
  const effectivePatientScope = canUseMinePatientScope ? patientScope : 'all';
  const canUseDashboardScope = session?.mode === 'intranet' && !!session?.user?.id;
  const effectiveDashboardScope = canUseDashboardScope ? dashboardScope : 'all';
  const { status: integrationStatus } = useIntegrationStatus({ session, settings });
  const activePatient = patients.find(p => p.id === activeId);
  const conflictPatient = patients.find(
    p => p.id === conflictPatientId && p.sync?.syncStatus === 'conflict'
  );
  const activeModules = isRedactedPatientRecord(activePatient) ? [] : (activePatient?.data?.activeModules || []);

  const {
    presets, presetMeta, presetError,
    presetModalJobId, presetEditingPreset, presetBrowseJobId,
    setPresetModalJobId, setPresetEditingPreset, setPresetBrowseJobId,
    reloadPresets,
    handlePresetSelect, handleSaveCustomPreset, closePresetManageModal, handleDeleteCustomPreset,
  } = usePresetManagement({ activeId, activeModules, session, setPatients });

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

  const { syncState, syncNow } = usePatientSync({
    patients,
    setPatients,
    activeId,
    setActiveId,
    session,
    settings,
    scope: effectivePatientScope,
    enabled:
      isIntranetMode &&
      isAuthenticated &&
      sessionVerified &&
      !session?.user?.mustChangePassword &&
      !configLoading &&
      !configError &&
      !patientSyncPaused,
  });

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
  });

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

  const { markRemoteDeleteConflict, handleResolveConflict } = useConflictResolution({
    setPatients, activeId, setActiveId, setCurrentStepIndex, session, settings, setConflictPatientId,
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

    conflictPatient, setConflictPatientId, handleResolveConflict, markRemoteDeleteConflict,

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
          onDashboardScopeChange={setDashboardScope}
          canUseDashboardScope={canUseDashboardScope}
          patientListScope={effectivePatientScope}
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
        onSwitchPatient={switchPatient}
        onRemovePatient={removePatient}
        onRemoveSelectedPatients={removeSelectedPatients}
        onResolveConflict={setConflictPatientId}
        scope={effectivePatientScope}
        onScopeChange={scope => {
          setPatientSyncPaused(false);
          setPatientScope(canUseMinePatientScope ? scope : 'all');
        }}
        session={session}
        serverUnassignedCount={syncState?.serverUnassignedCount ?? null}
      />

      {/* 메인 영역 */}
      <div className="main-area">
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

            {/* 동기화 권한 거부 알림: 다른 디바이스에서 만든 dirty 환자가 더 이상 본인 담당이 아닐 때 */}
            {syncState?.lastPermissionDeniedCount > 0 && (
              <div className="read-only-banner" role="status" style={{ background: '#fde2e2', color: '#9b1c1c', borderColor: '#f5b5b5' }}>
                권한 없음으로 동기화되지 않은 환자: {syncState.lastPermissionDeniedCount}건. 담당 의사 변경 또는 관리자 문의가 필요합니다.
              </div>
            )}

            {/* 콘텐츠 */}
            <div className={`main-content ${currentStep.id === 'info' ? 'main-content-dual' : currentStep.id === 'assessment' ? '' : 'main-content-single'}`}>
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
