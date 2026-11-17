// 화면 분기(REFACTORING_ROADMAP Phase 2 C3-C, P2-45c) — 옛 `src/App.jsx`의 부팅 게이트 뒤 렌더 분기(통계 → 랜딩/대시보드 → 위자드 →
// 작업 화면)를 **글자 그대로** 옮겼다. 분기 순서·판정은 src/app/useScreenRouter.ts selectScreen(P2-26)이 정하고, App이 그 결과를
// 넘긴다. 부팅 게이트와 서버 환자 목록 로딩 화면은 App에 남는다(둘 다 App 루트의 같은 자리라 "세션 확인 중 → 서버 목록 로딩"에서
// DOM 노드가 유지된다 — 계획). 값은 작업 공간 Context에서.
import { LandingScreen } from '../../core/components/LandingScreen';
import { IntakeWizard } from '../../core/components/IntakeWizard';
import { StatisticsWorkbench } from '../../core/components/statistics/StatisticsWorkbench';
import { hasIntranetSession } from '../../platform/dataMode';
import { ModalHost } from '../modals/ModalHost';
import { useWorkspace } from '../providers/WorkspaceContext';
import { WorkspaceScreen } from '../screens/WorkspaceScreen';
import type { ScreenId } from '../useScreenRouter';

export type RoutedScreen = Exclude<ScreenId, 'serverPatientsLoading'>;

export function ScreenRouter({ screen }: { screen: RoutedScreen }) {
  const {
    session, serverConfig, statsAvailable, refetchConfig, statsConfigRefreshing, statsConfigRefreshError, handleCloseStatistics,
    patients, handleStartIntake, openLoadModal, setShowSaveModal, setShowBatchImport, handleLoadTestData, setShowSettings,
    handleOpenStatistics, setShowHome, handleResetPatients, guardedSelectPatient, effectiveDashboardScope, setDashboardScope,
    setPatientScope, canUseDashboardScope, doctorRoster, isDashboardScopeLoading, showPatientList, syncState,
    intakeShared, setIntakeShared, setActiveId, handleIntakeComplete, errors, presets, presetMeta, presetError,
  } = useWorkspace();

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
          onSelectPatient={(id: string) => guardedSelectPatient(id)}
          hasIntranetSession={hasIntranetSession(session)}
          session={session}
          dashboardScope={effectiveDashboardScope}
          onDashboardScopeChange={(s: string) => {
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

  return <WorkspaceScreen />;
}
