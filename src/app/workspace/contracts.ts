// App 컨트롤러(src/app/workspace/use*Controller.ts)가 JS 훅에서 받는 값의 좁은 계약 — REFACTORING_ROADMAP Phase 2 C3-C(P2-44b~).
//
// JS 훅은 TS에서 추론 타입으로 import되지만 `useState(null)`·`useState([])`가 `null`·`never[]`로 굳고 `useAuth()`는 컨텍스트
// 기본값 때문에 쓸 수 없다(계획 C9). 그래서 **App이 실제로 쓰는 값만** 여기 인터페이스로 두고, 호출 지점에서
// `(useX as unknown as UseX)(…)`로 캐스트한다(선례 WorkspaceBoundary.tsx — 최상위 별칭 캐스트는 부분 vi.mock 함정 때문에 쓰지 않는다).
// 훅이 TS가 되면 그 훅의 계약과 캐스트를 지운다. `useAuth` 계약은 WorkspaceBoundary.tsx의 경계용 계약과 따로 둔다(그 파일은
// 이 구간에서 고치지 않는다 — 합치는 일은 AuthContext가 TS가 될 때).
import type { Dispatch, SetStateAction } from 'react';
import type { PatientRecord } from '../../core/types/patient';
import type { SetActiveId, SetPatients } from '../../core/state/patientStore/usePatientsContainer';
import type { SlotSetter } from '../useModalState';
import type { PatientStore } from '../../core/state/patientStore/store';
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

/** 넘겨주기만 하는 핸들러(App·컨트롤러가 직접 부르지 않는다 — 화면·모달이 부른다). 부르는 곳이 TS가 되면 시그니처를 좁힌다. */
export type ForwardedHandler = (...args: never[]) => unknown;

// --- 컨트롤러 3 editing(P2-44c) ---

/** 편집 락 상태(src/core/hooks/usePatientLock.js). */
export interface LockState {
  status: 'none' | 'acquiring' | 'held' | 'held-by-other' | 'lost';
  holder: { holderName?: string | null; [field: string]: unknown } | null;
  expiresAt: string | null;
}
export type UsePatientLock = (args: {
  activeId: string | null; activePatient: PatientRecord | undefined; session: AppSession; settings: AppSettings;
}) => { lockState: LockState; forceAcquire: () => Promise<unknown> };

/** 프리셋(src/core/hooks/usePresetManagement.js) — 모달 슬롯은 useModalState의 것을 그대로 돌려준다. */
export interface PresetManagementApi {
  presets: unknown[];
  presetMeta: unknown;
  presetError: unknown;
  presetModalJobId: string | null;
  presetEditingPreset: unknown;
  presetBrowseJobId: string | null;
  setPresetModalJobId: SlotSetter<'presetManageJobId'>;
  setPresetEditingPreset: SlotSetter<'presetEditingPreset'>;
  setPresetBrowseJobId: SlotSetter<'presetBrowseJobId'>;
  reloadPresets: ForwardedHandler;
  handlePresetSelect: (jobId: string, preset: unknown) => Promise<unknown>;
  handleSaveCustomPreset: ForwardedHandler;
  closePresetManageModal: ForwardedHandler;
  handleDeleteCustomPreset: ForwardedHandler;
}
export type UsePresetManagement = (args: {
  activeId: string | null; activeModules: string[]; session: AppSession; setPatients: SetPatients;
  canMutateActivePatient: boolean;
  modalSlots: {
    presetModalJobId: string | null; setPresetModalJobId: SlotSetter<'presetManageJobId'>;
    presetEditingPreset: unknown; setPresetEditingPreset: SlotSetter<'presetEditingPreset'>;
    presetBrowseJobId: string | null; setPresetBrowseJobId: SlotSetter<'presetBrowseJobId'>;
  };
}) => PresetManagementApi;

/** 로컬 → 서버 마이그레이션(src/core/hooks/useMigration.js). */
export interface MigrationApi {
  status: string;
  result: unknown;
  start: ForwardedHandler;
  retry: ForwardedHandler;
  reset: ForwardedHandler;
}
export type UseMigration = (args: { session: AppSession; settings: AppSettings }) => MigrationApi;

export type UseOpsStatus = (args: { session: AppSession; enabled: boolean }) => { showBanner: boolean; bannerMessage: unknown };

/** 내보내기(src/core/hooks/useExportHandlers.js). */
export interface ExportHandlersApi {
  exportDropdown: string | null;
  setExportDropdown: Dispatch<SetStateAction<string | null>>;
  handleExportSingle: ForwardedHandler;
  handleExportSelected: ForwardedHandler;
  handleExportBatch: ForwardedHandler;
  handleExportBatchFormatSingle: ForwardedHandler;
  handleExportBatchFormatSelected: ForwardedHandler;
  handleExportBatchFormatAll: ForwardedHandler;
  handleExportBatchTemplate: ForwardedHandler;
}
export type UseExportHandlers = (args: {
  activePatient: PatientRecord | undefined; patients: PatientRecord[]; selectedIds: Set<string>; dirtyAssessmentPatientId: string | null;
}) => ExportHandlersApi;

/** EMR 연동(src/core/hooks/useEMRIntegration.js). */
export interface EmrIntegrationApi {
  extractProgress: unknown;
  setExtractProgress: Dispatch<SetStateAction<unknown>>;
  handleInjectEMR: ForwardedHandler;
  handleInjectConsultReply: ForwardedHandler;
  handleEmrExtractBatch: ForwardedHandler;
  handleExtractConsultation: ForwardedHandler;
}
export type UseEMRIntegration = (args: {
  activePatient: PatientRecord | undefined; patients: PatientRecord[]; selectedIds: Set<string>; session: AppSession;
  setPatients: SetPatients; dirtyAssessmentPatientId: string | null;
}) => EmrIntegrationApi;

// --- 컨트롤러 4 nav(P2-44c) ---

/** 단계(src/core/utils/steps.js buildSteps). */
export interface Step {
  id: string;
  label?: string;
  group?: string;
  moduleId?: string | null;
  [field: string]: unknown;
}

export interface StepNavigationApi {
  currentStepIndex: number;
  setCurrentStepIndex: Dispatch<SetStateAction<number>>;
  goToStep: ForwardedHandler;
  goNext: ForwardedHandler;
  goPrev: ForwardedHandler;
  switchPatient: (patientId: string) => void;
}
export type UseStepNavigation = (args: {
  steps: Step[]; activeId: string | null; setActiveId: SetActiveId; setShowSidebar: Dispatch<SetStateAction<boolean>>;
  hasUnsavedAssessmentDraft: boolean; onBlockedByUnsavedDraft: () => void;
}) => StepNavigationApi;

export interface IntakeWizardApi {
  intakeShared: unknown;
  setIntakeShared: Dispatch<SetStateAction<unknown>>;
  handleStartIntake: () => unknown;
  handleIntakeComplete: ForwardedHandler;
}
export type UseIntakeWizard = (args: {
  settings: AppSettings; session: AppSession; setPatients: SetPatients; setActiveId: SetActiveId;
  setCurrentStepIndex: Dispatch<SetStateAction<number>>; setShowHome: (value: boolean) => void; videoAnalysisEnabled: boolean;
  hasUnsavedAssessmentDraft: boolean; onBlockedByUnsavedDraft: () => void;
}) => IntakeWizardApi;

// --- 컨트롤러 5 sync(P2-44d) ---

/** 동기화 상태(src/core/hooks/usePatientSync.js) — App·화면이 읽는 필드만. */
export interface SyncState {
  status?: string;
  serverPatientCount?: number | null;
  serverUnassignedCount?: number | null;
  lastPermissionDeniedCount?: number;
  [field: string]: unknown;
}

export type FlushOutcome = 'synced' | 'conflict' | 'still-dirty' | 'lock-lost' | 'permission' | 'offline' | 'error' | string;

export interface PatientSyncApi {
  syncState: SyncState;
  syncNow: (options?: { pull?: boolean; reason?: string }) => unknown;
  flushPatient: (patientId: string | null) => Promise<FlushOutcome>;
  notifyLockOutcome: (patientId: string | null, outcome: string) => void;
}
export type UsePatientSync = (args: {
  patients: PatientRecord[]; activeId: string | null; store: PatientStore; session: AppSession; settings: AppSettings;
  scope: string; lockState: LockState; enabled: boolean;
}) => PatientSyncApi;

/** 동기화 요약(src/core/hooks/useSyncStatusSummary.js). */
export interface SyncStatusSummary {
  pendingCount: number;
  conflictCount: number;
  lockLostCount: number;
  offline: boolean;
  [field: string]: unknown;
}
export type UseSyncStatusSummary = (patients: PatientRecord[], syncState: SyncState) => SyncStatusSummary;

// --- 컨트롤러 6 data(P2-44d) ---

/** 모듈(src/core/moduleRegistry.js getModule) — App이 읽는 필드만. */
export interface AppModule {
  computeCalc?: (input: { shared: unknown; module: unknown }) => unknown;
  EvaluationComponent?: unknown;
  [field: string]: unknown;
}

export interface WorkspacePersistenceApi {
  savedItems: unknown[];
  saveName: string;
  setSaveName: Dispatch<SetStateAction<string>>;
  lastAutoSave: unknown;
  legacyItems: unknown[];
  handleSave: ForwardedHandler;
  handleOverwriteSave: ForwardedHandler;
  handleLoad: ForwardedHandler;
  handleDelete: ForwardedHandler;
  openLoadModal: ForwardedHandler;
  waitForAutosaveRestore: () => Promise<unknown>;
}
export type UseWorkspacePersistence = (args: object) => WorkspacePersistenceApi;

export interface PatientCrudApi {
  updatePatient: ForwardedHandler;
  updateShared: ForwardedHandler;
  updateActiveModules: ForwardedHandler;
  updateModule: ForwardedHandler;
  updateModuleById: ForwardedHandler;
  updateDiagnoses: ForwardedHandler;
  addPatient: ForwardedHandler;
  removePatient: ForwardedHandler;
  removeSelectedPatients: ForwardedHandler;
  handleBatchImport: ForwardedHandler;
  handleLoadTestData: ForwardedHandler;
}
export type UsePatientCrud = (args: object) => PatientCrudApi;
