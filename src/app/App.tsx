// 작업 공간 화면(App) — REFACTORING_ROADMAP Phase 2 C3-C(P2-44~46). 옛 `src/App.jsx`(735줄, @ts-nocheck)를 컨트롤러 훅 7개
// (src/app/workspace/use*Controller.ts)·작업 공간 Context(src/app/providers/WorkspaceContext.tsx)·화면 분기(src/app/router/ScreenRouter.tsx)·
// 공통 모달(src/app/modals/ModalHost.tsx)로 나눴다.
//
// 트리: StrictMode > AuthProvider > WorkspaceBoundary(계정이 바뀌면 key로 다시 띄움) > App > (부팅 게이트 | 서버 목록 로딩 |
//       WorkspaceProvider > ScreenRouter)
//
// 규칙(계획 phase2-c3c-plan.md "설계"):
//  - **훅·state는 전부 이 App fiber에 있고 effect 등록 순서는 옛 App.jsx와 같다** — 컨트롤러는 자식 컴포넌트가 아니라 App이 차례로
//    부르는 커스텀 훅이고, 각 컨트롤러는 옛 호출 순서의 연속 구간이다. 순서는 scripts/__goldens__/appHookOrder.json이 지킨다.
//  - 컨트롤러는 값을 가공하지 않는다(훅이 준 참조를 이름만 붙여 돌려준다). 뒤 컨트롤러는 앞 컨트롤러의 반환을 펼쳐 받는다.
//  - Context는 1개, 값은 컨트롤러 반환 묶음 + 설정 props(매 렌더 새 객체). 반환 이름은 서로 겹치지 않는다(scripts/appWorkspaceKeys.test.mjs).
//  - 부팅 게이트와 서버 환자 목록 로딩 화면은 App 루트에서 그린다(둘 다 같은 자리라 "세션 확인 중 → 서버 목록 로딩"에서 DOM이 유지된다).
//  - 설정(settings·handleSaveSettings·switchToLocalMode)은 작업 공간 경계가 넘긴다 — 계정이 바뀌어 App이 다시 띄워져도 설정(특히
//    운영 인트라넷 빌드의 "로컬 모드로 전환")이 유지되도록(계정 전환 수정 AS-4).
import { renderBootGate, withLocalEscape } from './BootGate';
import { selectScreen } from './useScreenRouter';
import type { WorkspaceAppProps } from './WorkspaceBoundary';
import { useShellController } from './workspace/useShellController';
import { useEnvController } from './workspace/useEnvController';
import { useEditingController } from './workspace/useEditingController';
import { useNavController } from './workspace/useNavController';
import { useSyncController } from './workspace/useSyncController';
import { useDataController } from './workspace/useDataController';
import { useCommandsController } from './workspace/useCommandsController';
import type { WorkspaceValue } from './workspace/workspaceValue';
import { WorkspaceProvider } from './providers/WorkspaceContext';
import { ScreenRouter } from './router/ScreenRouter';
import { hasIntranetSession } from '../platform/dataMode';

// 모듈 등록 (사이드이펙트 import) — 순서 그대로(옛 App.jsx 62-67줄)
import '../modules/knee';
import '../modules/spine';
import '../modules/cervical';
import '../modules/shoulder';
import '../modules/elbow';
import '../modules/wrist';

function App({ settings, handleSaveSettings, switchToLocalMode }: WorkspaceAppProps) {
  // 컨트롤러 1~7 — 옛 App.jsx의 호출 순서 그대로(이 순서를 바꾸면 effect 순서가 바뀐다).
  const shell = useShellController();
  const env = useEnvController({ ...shell, settings });
  const editing = useEditingController({ ...shell, ...env, settings });
  const nav = useNavController({ ...shell, ...env, settings });
  const sync = useSyncController({ ...shell, ...env, ...editing, ...nav, settings });
  const data = useDataController({ ...shell, ...env, ...editing, ...nav, settings });
  const commands = useCommandsController({ ...shell, ...env, ...editing, ...nav, ...sync, ...data, settings, handleSaveSettings });

  // 작업 공간 Context 값 — 화면(ScreenRouter·WorkspaceScreen)과 모달(ModalHost)이 useWorkspace()로 읽는다.
  const ws: WorkspaceValue = {
    settings, handleSaveSettings, switchToLocalMode, ...shell, ...env, ...editing, ...nav, ...sync, ...data, ...commands,
  };

  // ===========================================
  // 인트라넷 모드 부팅 게이팅
  // ===========================================
  const bootScreen = renderBootGate({
    isIntranetMode: env.isIntranetMode, configLoading: env.configLoading, configError: env.configError,
    session: shell.session, settings, sessionVerified: shell.sessionVerified, isAuthenticated: shell.isAuthenticated,
    onSwitchToLocal: switchToLocalMode,
    onBeforeLogin: commands.onBeforeLogin, loginPending: commands.loginPending, onLoginPendingChange: commands.setLoginPending,
  });
  if (bootScreen) return bootScreen;

  // 부팅 게이트 뒤의 화면 — 분기 순서(통계 → 서버 환자 로딩 → 랜딩/대시보드 → 위자드 → 작업 화면)는
  // src/app/useScreenRouter.ts selectScreen(P2-26).
  const screen = selectScreen({
    activeScreen: shell.activeScreen,
    intranetSession: hasIntranetSession(shell.session),
    patientCount: shell.patients.length,
    activeId: shell.activeId,
    hasIntake: !!nav.intakeShared,
    syncStatus: sync.syncState.status,
    serverPatientCount: sync.syncState.serverPatientCount,
  });

  // ===========================================
  // 인트라넷 초기 부팅: 서버 환자 목록 pull 중 → 로딩 화면(pull 뒤 mine=0이지만 서버에 환자가 있으면 자동 랜딩 억제 —
  // 환자 목록 껍데기에서 scope 전환·재마이그레이션 등 다음 행동을 하게 함). 부팅 화면 아래 "로컬 모드로 전환" 탈출구 —
  // src/app/BootGate.tsx(P2-25).
  // ===========================================
  if (screen === 'serverPatientsLoading') {
    return withLocalEscape(
      <div className="app-boot-overlay">
        <div className="app-boot-box">
          <p>서버 환자 목록을 불러오는 중입니다…</p>
        </div>
      </div>,
      switchToLocalMode,
    );
  }

  // 통계 → 랜딩/대시보드 → 위자드 → 작업 화면 — src/app/router/ScreenRouter.tsx(P2-45c), 값은 작업 공간 Context에서.
  return <WorkspaceProvider value={ws}><ScreenRouter screen={screen} /></WorkspaceProvider>;
}

export default App;
