// 작업 공간 Context 값의 타입(REFACTORING_ROADMAP Phase 2 C3-C, P2-45a) — 컨트롤러 1~7 반환 + App이 받은 설정 props.
// 컨트롤러 반환 이름은 서로 겹치지 않는다(겹치면 App에서 펼칠 때 뒤의 것이 앞의 것을 가린다 — workspaceValue.test가 확인).
import type { WorkspaceAppProps } from '../WorkspaceBoundary';
import type { ShellController } from './useShellController';
import type { EnvController } from './useEnvController';
import type { EditingController } from './useEditingController';
import type { NavController } from './useNavController';
import type { SyncController } from './useSyncController';
import type { DataController } from './useDataController';
import type { CommandsController } from './useCommandsController';

export type WorkspaceValue = WorkspaceAppProps
  & ShellController & EnvController & EditingController & NavController
  & SyncController & DataController & CommandsController;
