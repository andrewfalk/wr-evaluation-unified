// @ts-nocheck
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { LandingScreen } from './core/components/LandingScreen';
import { IntakeWizard } from './core/components/IntakeWizard';
import { AppModals } from './core/components/AppModals';
import { useEvaluationDateSync } from './core/state/patientStore/useEvaluationDateSync';
import { useElectronMenuEvents } from './core/hooks/useElectronMenuEvents';
import { useConflictResolution } from './core/hooks/useConflictResolution';
import { usePatientList } from './core/hooks/usePatientList';
import { showAlert } from './core/utils/platform';
import { generateUnifiedReport } from './core/utils/reportGenerator';
import { isRedactedPatientRecord } from './core/services/patientRecords';
import { clearAutoSavedWorkspace } from './core/services/workspaceRepository';
import { StatisticsWorkbench } from './core/components/statistics/StatisticsWorkbench';
import { WorkspaceScreen } from './app/screens/WorkspaceScreen';
import { renderBootGate, withLocalEscape as withLocalEscapeFor } from './app/BootGate';
import { useLocalWorkBeforeLogin } from './app/useLocalWorkBeforeLogin';
import { selectScreen } from './app/useScreenRouter';
import { useShellController } from './app/workspace/useShellController';
import { useEnvController } from './app/workspace/useEnvController';
import { useEditingController } from './app/workspace/useEditingController';
import { useNavController } from './app/workspace/useNavController';
import { useSyncController } from './app/workspace/useSyncController';
import { useDataController } from './app/workspace/useDataController';
import { patientTx } from './core/state/patientStore/transitions';
import { hasIntranetSession } from './platform/dataMode';
import { getLifecycleBridge } from './platform/bridge';

// 모듈 등록 (사이드이펙트 import)
import './modules/knee';
import './modules/spine';
import './modules/cervical';
import './modules/shoulder';
import './modules/elbow';
import './modules/wrist';

// 설정(settings·handleSaveSettings·switchToLocalMode)은 작업 공간 경계(src/app/WorkspaceBoundary)가 넘긴다 — 계정이 바뀌어
// App이 다시 띄워져도 설정(특히 운영 인트라넷 빌드의 "로컬 모드로 전환")이 유지되도록(계정 전환 수정 AS-4).
function App({ settings, handleSaveSettings, switchToLocalMode }) {
  // 컨트롤러 1 shell(P2-44b) — 인증·화면 수명 가드·환자 상태 컨테이너·scope·동기화 일시정지·모달 열림 상태·UI 상태·
  // 화면 라우터·충돌 대상·종합소견 초안 가드: src/app/workspace/useShellController.ts. 이름은 옛 지역 변수 그대로.
  const {
    session, isAuthenticated, sessionVerified, logout, getWorkspaceOwner, getAuthEpoch,
    isAlive, alertAlive, confirmAlive,
    patients, setPatients, activeId, setActiveId, selectedIds, setSelectedIds, patientStore,
    patientScopeState, setPatientScope, setDashboardScope, effectivePatientScope, canUseDashboardScope, effectiveDashboardScope,
    patientSyncPaused, setPatientSyncPaused,
    modals, setterFor,
    showSaveModal, setShowSaveModal, showLoadModal, setShowLoadModal,
    errors, setErrors, showSidebar, setShowSidebar, patientFilters, setPatientFilters,
    showSettings, setShowSettings, showAdminConsole, setShowAdminConsole, showAccountProfile, setShowAccountProfile,
    showChangePassword, setShowChangePassword, showMigrationReport, setShowMigrationReport, showBatchImport, setShowBatchImport,
    activeScreen, setShowHome, openStatistics, closeStatistics,
    conflictPatientId, setConflictPatientId,
    dirtyAssessmentPatientId, blockedByUnsavedDraftAlert, handleAssessmentEditingChange, blockIfDraftDirty,
  } = useShellController();
  // 컨트롤러 2 env(P2-44b) — 서버 설정·AI·연동 상태와 파생값, 활성·충돌 대상 환자, 활성 모듈: src/app/workspace/useEnvController.ts.
  const {
    serverConfig, configLoading, configError, refetchConfig, statsConfigRefreshing, statsConfigRefreshError,
    aiAvailable, statsAvailable, isIntranetMode, integrationStatus,
    activePatient, conflictPatient, activeModules,
  } = useEnvController({ session, settings, patients, activeId, conflictPatientId });

  // 컨트롤러 3 editing(P2-44c) — 편집 락·편집 가능 여부·프리셋·마이그레이션·운영 알림·내보내기·EMR:
  // src/app/workspace/useEditingController.ts.
  const {
    lockState, forceAcquire, canMutateActivePatient,
    presets, presetMeta, presetError,
    presetModalJobId, presetEditingPreset, presetBrowseJobId,
    setPresetModalJobId, setPresetEditingPreset, setPresetBrowseJobId,
    reloadPresets,
    handlePresetSelect, handleSaveCustomPreset, closePresetManageModal, handleDeleteCustomPreset,
    migrationStatus, migrationResult, startMigration, retryMigration, resetMigration,
    showOpsBanner, opsBannerMessage,
    exportDropdown, setExportDropdown,
    handleExportSingle, handleExportSelected, handleExportBatch,
    handleExportBatchFormatSingle, handleExportBatchFormatSelected, handleExportBatchFormatAll,
    handleExportBatchTemplate,
    extractProgress, setExtractProgress,
    handleInjectEMR, handleInjectConsultReply,
    handleEmrExtractBatch, handleExtractConsultation,
  } = useEditingController({
    activeId, activePatient, activeModules, patients, selectedIds, session, settings, isAuthenticated, setPatients,
    modals, setterFor, dirtyAssessmentPatientId,
  });

  // 컨트롤러 4 nav(P2-44c) — Electron 메뉴 ref·단계 목록·단계 이동·새 환자 위자드·공용 환자 선택 가드:
  // src/app/workspace/useNavController.ts.
  const {
    handleStartIntakeRef, handleResetPatientsRef, handleOpenStatisticsRef,
    steps,
    currentStepIndex, setCurrentStepIndex, goToStep, goNext, goPrev, switchPatient,
    intakeShared, setIntakeShared, handleStartIntake, handleIntakeComplete,
    guardedSelectPatient,
  } = useNavController({
    settings, session, serverConfig, activeModules, activeId, setActiveId, setPatients, setShowSidebar, setShowHome,
    dirtyAssessmentPatientId, blockedByUnsavedDraftAlert, blockIfDraftDirty,
  });

  // 컨트롤러 5 sync(P2-44d) — 일시정지 해제 effect 2·환자 동기화·락 브리지·락 토큰 초기화·동기화 요약·강제 인수·의사 명부:
  // src/app/workspace/useSyncController.ts. 순서가 의미를 갖는 구간(계획 C2) — 안에서도 옛 순서 그대로.
  const {
    syncState, syncNow, flushPatient,
    syncSummary, handleForceTakeover, doctorRoster, isDashboardScopeLoading,
  } = useSyncController({
    session, settings, patients, activeId, patientStore, effectivePatientScope, patientScopeState, lockState, forceAcquire,
    isIntranetMode, isAuthenticated, sessionVerified, configLoading, configError, patientSyncPaused, setPatientSyncPaused,
    intakeShared, confirmAlive,
  });

  // 컨트롤러 6 data(P2-44d) — 작업 공간 저장/불러오기·자동저장·현재 단계·활성 모듈·환자 CRUD:
  // src/app/workspace/useDataController.ts(옛 App이 받기만 하던 setSavedItems는 받지 않는다).
  const {
    savedItems, saveName, setSaveName, lastAutoSave, legacyItems,
    handleSave, handleOverwriteSave, handleLoad, handleDelete, openLoadModal, waitForAutosaveRestore,
    currentStep, activeModuleId, activeModule,
    updatePatient, updateShared, updateActiveModules,
    updateModule, updateModuleById, updateDiagnoses,
    addPatient, removePatient, removeSelectedPatients,
    handleBatchImport, handleLoadTestData,
  } = useDataController({
    patients, setPatients, session, settings, serverConfig, activeId, setActiveId, selectedIds, setSelectedIds, setErrors,
    setCurrentStepIndex, setIntakeShared, setShowHome, setShowSaveModal, setShowLoadModal, isIntranetMode, configLoading,
    configError, steps, currentStepIndex, handleStartIntake, canMutateActivePatient, dirtyAssessmentPatientId,
    blockedByUnsavedDraftAlert,
  });

  // 환자 전환 게이팅(§5-3): synced면 즉시 전환, conflict면 push 자체를 시도하지 않고 확인 후
  // 이동, dirty/local-only면 flushPatient로 기존 autosync 큐에 합류해 저장을 기다린 뒤 전환.
  const handleSwitchPatient = useCallback(async (patientId) => {
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

    const proceedUnresolved = (message) => async () => {
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

      let outcome = 'still-dirty';
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
  const onVideoServerApplied = useCallback((serverPatient) => {
    if (!serverPatient?.id) return;
    setPatients(patientTx.replacedFromServer({ id: serverPatient.id, serverPatient, keepLocalMeta: false }));
  }, [setPatients]);

  // 평가 완료 시 evaluationDate 자동 설정
  // 편집 권한·현재 환자의 락이 있을 때만 쓴다(P2-39c) — lockState를 넘겨 락을 얻은 뒤 다시 판정.
  // 로그인 화면이 떠 있는 동안(인트라넷 모드인데 인증 안 됨)은 쓰지 않는다 — 로컬 세션은 편집 권한을 항상 참으로 본다(AS-5).
  useEvaluationDateSync({ activeId, patients, setPatients, session, lockState, suspended: isIntranetMode && !isAuthenticated });

  // Electron 메뉴 이벤트
  useElectronMenuEvents({ handleResetPatientsRef, handleStartIntakeRef, handleOpenStatisticsRef });

  // (셸 초안 신호·beforeunload는 useUnsavedDraftGuard — P2-29)

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

  // 로그인 직전 로컬 작업 보존(J2, src/app/useLocalWorkBeforeLogin) + 로그인 요청 중 표시(로컬 전환 버튼을 막는다) — AS-4.
  const onBeforeLogin = useLocalWorkBeforeLogin({ patients, getWorkspaceOwner, waitForPendingRestore: waitForAutosaveRestore });
  const [loginPending, setLoginPending] = useState(false);

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
  handleResetPatientsRef.current = handleResetPatients;

  const { markRemoteDeleteConflict, handleResolveConflict, handleCorrectServerIdentity } = useConflictResolution({
    setPatients, activeId, setActiveId, setCurrentStepIndex, session, settings, setConflictPatientId, syncNow,
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
    onBeforeLogin, loginPending, onLoginPendingChange: setLoginPending,
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
