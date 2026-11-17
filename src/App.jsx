// @ts-nocheck
import { LandingScreen } from './core/components/LandingScreen';
import { IntakeWizard } from './core/components/IntakeWizard';
import { ModalHost } from './app/modals/ModalHost';
import { WorkspaceProvider } from './app/providers/WorkspaceContext';
import { StatisticsWorkbench } from './core/components/statistics/StatisticsWorkbench';
import { WorkspaceScreen } from './app/screens/WorkspaceScreen';
import { renderBootGate, withLocalEscape as withLocalEscapeFor } from './app/BootGate';
import { selectScreen } from './app/useScreenRouter';
import { useShellController } from './app/workspace/useShellController';
import { useEnvController } from './app/workspace/useEnvController';
import { useEditingController } from './app/workspace/useEditingController';
import { useNavController } from './app/workspace/useNavController';
import { useSyncController } from './app/workspace/useSyncController';
import { useDataController } from './app/workspace/useDataController';
import { useCommandsController } from './app/workspace/useCommandsController';
import { hasIntranetSession } from './platform/dataMode';

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
  const shell = useShellController();
  const {
    session, isAuthenticated, sessionVerified, logout, getWorkspaceOwner, getAuthEpoch, isAlive, alertAlive, confirmAlive,
    patients, setPatients, activeId, setActiveId, selectedIds, setSelectedIds, patientStore, patientScopeState,
    setPatientScope, setDashboardScope, effectivePatientScope, canUseDashboardScope, effectiveDashboardScope,
    patientSyncPaused, setPatientSyncPaused, modals, setterFor, setShowSaveModal, setShowLoadModal, errors, setErrors,
    setShowSidebar, patientFilters, setShowSettings, setShowBatchImport, activeScreen, setShowHome, openStatistics,
    closeStatistics, conflictPatientId, setConflictPatientId, dirtyAssessmentPatientId, blockedByUnsavedDraftAlert,
    blockIfDraftDirty,
  } = shell;
  // 컨트롤러 2 env(P2-44b) — 서버 설정·AI·연동 상태와 파생값, 활성·충돌 대상 환자, 활성 모듈: src/app/workspace/useEnvController.ts.
  const env = useEnvController({ session, settings, patients, activeId, conflictPatientId });
  const {
    serverConfig, configLoading, configError, refetchConfig, statsConfigRefreshing, statsConfigRefreshError, statsAvailable,
    isIntranetMode, activePatient, activeModules,
  } = env;

  // 컨트롤러 3 editing(P2-44c) — 편집 락·편집 가능 여부·프리셋·마이그레이션·운영 알림·내보내기·EMR:
  // src/app/workspace/useEditingController.ts.
  const editing = useEditingController({
    activeId, activePatient, activeModules, patients, selectedIds, session, settings, isAuthenticated, setPatients,
    modals, setterFor, dirtyAssessmentPatientId,
  });
  const {
    lockState, forceAcquire, canMutateActivePatient, presets, presetMeta, presetError,
  } = editing;

  // 컨트롤러 4 nav(P2-44c) — Electron 메뉴 ref·단계 목록·단계 이동·새 환자 위자드·공용 환자 선택 가드:
  // src/app/workspace/useNavController.ts.
  const nav = useNavController({
    settings, session, serverConfig, activeModules, activeId, setActiveId, setPatients, setShowSidebar, setShowHome,
    dirtyAssessmentPatientId, blockedByUnsavedDraftAlert, blockIfDraftDirty,
  });
  const {
    handleStartIntakeRef, handleResetPatientsRef, handleOpenStatisticsRef, steps, currentStepIndex, setCurrentStepIndex,
    switchPatient, intakeShared, setIntakeShared, handleStartIntake, handleIntakeComplete, guardedSelectPatient,
  } = nav;

  // 컨트롤러 5 sync(P2-44d) — 일시정지 해제 effect 2·환자 동기화·락 브리지·락 토큰 초기화·동기화 요약·강제 인수·의사 명부:
  // src/app/workspace/useSyncController.ts. 순서가 의미를 갖는 구간(계획 C2) — 안에서도 옛 순서 그대로.
  const sync = useSyncController({
    session, settings, patients, activeId, patientStore, effectivePatientScope, patientScopeState, lockState, forceAcquire,
    isIntranetMode, isAuthenticated, sessionVerified, configLoading, configError, patientSyncPaused, setPatientSyncPaused,
    intakeShared, confirmAlive,
  });
  const {
    syncState, syncNow, flushPatient, syncSummary, doctorRoster, isDashboardScopeLoading,
  } = sync;

  // 컨트롤러 6 data(P2-44d) — 작업 공간 저장/불러오기·자동저장·현재 단계·활성 모듈·환자 CRUD:
  // src/app/workspace/useDataController.ts(옛 App이 받기만 하던 setSavedItems는 받지 않는다).
  const data = useDataController({
    patients, setPatients, session, settings, serverConfig, activeId, setActiveId, selectedIds, setSelectedIds, setErrors,
    setCurrentStepIndex, setIntakeShared, setShowHome, setShowSaveModal, setShowLoadModal, isIntranetMode, configLoading,
    configError, steps, currentStepIndex, handleStartIntake, canMutateActivePatient, dirtyAssessmentPatientId,
    blockedByUnsavedDraftAlert,
  });
  const {
    openLoadModal, waitForAutosaveRestore, activeModuleId, activeModule, handleLoadTestData,
  } = data;

  // 컨트롤러 7 commands(P2-44e) — 환자 전환 게이팅·영상 분석 반영·평가일자·Electron 메뉴·목록·계산·로그인 직전 보존·
  // 핸들러·충돌 해결·가드된 로그아웃·통계 진입/이탈·통계 가용성 전파: src/app/workspace/useCommandsController.ts.
  const commands = useCommandsController({
    settings, handleSaveSettings, session, serverConfig, logout, getWorkspaceOwner, getAuthEpoch, isAlive, alertAlive, confirmAlive,
    patients, setPatients, activeId, setActiveId, setSelectedIds, activePatient, activeModules, activeModule, activeModuleId,
    isIntranetMode, isAuthenticated, statsAvailable, lockState, patientFilters, setPatientSyncPaused, setShowSettings,
    setShowSidebar, setShowHome, openStatistics, closeStatistics, setConflictPatientId, setCurrentStepIndex, setIntakeShared,
    switchPatient, handleResetPatientsRef, handleStartIntakeRef, handleOpenStatisticsRef, flushPatient, syncNow, syncSummary,
    waitForAutosaveRestore, dirtyAssessmentPatientId, blockedByUnsavedDraftAlert, blockIfDraftDirty,
  });
  const {
    onBeforeLogin, loginPending, setLoginPending, showPatientList, handleResetPatients, handleOpenStatistics,
    handleCloseStatistics,
  } = commands;

  // 작업 공간 Context 값(P2-45a) — 컨트롤러 반환 묶음 + 작업 공간 경계가 준 설정 props. 모달(ModalHost)이 useWorkspace()로 읽는다.
  // 매 렌더 새 객체(지금도 App 렌더마다 아래를 전부 다시 그린다 — 계획 C8), 값은 훅이 준 참조 그대로.
  const ws = { settings, handleSaveSettings, switchToLocalMode, ...shell, ...env, ...editing, ...nav, ...sync, ...data, ...commands };

  // 부팅 화면 아래 "로컬 모드로 전환" 탈출구 — 구현은 src/app/BootGate.tsx(P2-25).
  const withLocalEscape = (content) => withLocalEscapeFor(content, switchToLocalMode);

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
      <WorkspaceProvider value={ws}>
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
        <ModalHost />
      </div>
      </WorkspaceProvider>
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
  // 메인 작업 화면 — src/app/screens/WorkspaceScreen.jsx(P2-24), 값은 작업 공간 Context에서(P2-45b).
  return <WorkspaceProvider value={ws}><WorkspaceScreen /></WorkspaceProvider>;
}

export default App;
