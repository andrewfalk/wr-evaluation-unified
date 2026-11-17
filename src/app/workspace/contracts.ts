// App 컨트롤러(src/app/workspace/use*Controller.ts)가 JS 훅에서 받는 값의 좁은 계약 — REFACTORING_ROADMAP Phase 2 C3-C(P2-44b~).
//
// JS 훅은 TS에서 추론 타입으로 import되지만 `useState(null)`·`useState([])`가 `null`·`never[]`로 굳고 `useAuth()`는 컨텍스트
// 기본값 때문에 쓸 수 없다(계획 C9). 그래서 **App이 실제로 쓰는 값만** 여기 인터페이스로 두고, 호출 지점에서
// `(useX as unknown as UseX)(…)`로 캐스트한다(선례 WorkspaceBoundary.tsx — 최상위 별칭 캐스트는 부분 vi.mock 함정 때문에 쓰지 않는다).
// 훅이 TS가 되면 그 훅의 계약과 캐스트를 지운다. `useAuth` 계약은 WorkspaceBoundary.tsx의 경계용 계약과 따로 둔다(그 파일은
// 이 구간에서 고치지 않는다 — 합치는 일은 AuthContext가 TS가 될 때).
export type AppSettings = Record<string, unknown>;

export interface AppSessionUser {
  id?: string | null;
  role?: string | null;
  organizationId?: string | null;
  mustChangePassword?: boolean | null;
  [field: string]: unknown;
}

/** 세션(src/core/auth/session.js) — App이 읽는 필드만. */
export type AppSession = {
  mode?: string | null;
  apiBaseUrl?: string | null;
  user?: AppSessionUser | null;
  [field: string]: unknown;
} | null;

/** useAuth()(src/core/auth/AuthContext.jsx) — App이 쓰는 값. */
export interface AuthForApp {
  session: AppSession;
  isAuthenticated: boolean;
  sessionVerified: boolean;
  logout: (options?: { expectedGen?: number }) => Promise<boolean>;
  getWorkspaceOwner: () => unknown;
  getAuthEpoch: () => number;
}
export type UseAuth = () => AuthForApp;

/** 서버 공개 설정(src/core/hooks/useServerConfig.js) — App이 읽는 필드만. */
export type ServerConfig = {
  statsWorkbenchAvailable?: boolean;
  videoAnalysisEnabled?: boolean;
  videoAnalysisFixtureMode?: boolean;
  aiEnabled?: boolean;
  [field: string]: unknown;
} | null;

export interface ServerConfigApi {
  serverConfig: ServerConfig;
  configLoading: boolean;
  configError: unknown;
  refetchConfig: () => unknown;
  refreshing: boolean;
  refreshError: unknown;
}
export type UseServerConfig = (args: { session: AppSession; settings: AppSettings }) => ServerConfigApi;

export type UseAIAvailable = (args: { serverConfig: ServerConfig; session: AppSession }) => { aiAvailable: boolean };

export type UseIntegrationStatus = (args: { session: AppSession; settings: AppSettings }) => { status: unknown };
