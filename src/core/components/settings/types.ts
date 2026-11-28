// 설정 창 조각(P2-86c, Phase 2 C9 구간 A) — SettingsModal.tsx에서 옮겼다. 이 창이 쓰는 값의 타입.
/** 설정 값(settingsStore) — 이 창이 읽고 쓰는 필드. 부모는 Record<string, unknown>으로 넘긴다. */
export interface SettingsDraft {
  theme?: string;
  fontSize?: string;
  hospitalName?: string;
  department?: string;
  doctorName?: string;
  autoSaveInterval?: number;
  integrationMode?: string | null;
  apiBaseUrl?: string | null;
  geminiApiKey?: string;
  claudeApiKey?: string;
  [field: string]: unknown;
}

/** 세션 — 이 창이 읽는 필드(나머지 필드는 '연결 확인'의 미리보기 세션에 그대로 펼쳐 넘긴다). */
export interface SettingsSession {
  mode?: string | null;
  apiBaseUrl?: string | null;
}

// integrationStatus.js(JS)의 상태 객체 가운데 이 창이 읽는 필드. 런타임 보장은 없다 — 기존 `?.`·`||`를 지우지 않는다.
export interface DiagnosticStatus {
  connectivity?: string;
  mock?: boolean;
  baseUrl?: string;
  message?: string;
  lastCheckedAt?: string | null;
  lastError?: string | null;
  activeStore?: string;
  sessionInfo?: { userId?: string | null; organizationId?: string | null } | null;
  meDetails?: { userName?: string | null; userRole?: string | null; orgName?: string | null; capabilities?: { ai?: boolean } | null } | null;
  mockDetails?: {
    scopeKey?: string | null;
    userId?: string | null;
    organizationId?: string | null;
    workspaceCount?: number | null;
    hasAutosave?: boolean | null;
    storageFile?: string | null;
  } | null;
  remoteDetails?: { workspaceCount?: number | null } | null;
}

export interface SettingsModalProps {
  settings: SettingsDraft;
  session: SettingsSession | null | undefined;
  /** 부모(useEnvController)는 unknown으로 들고 있다 — 이 창이 DiagnosticStatus로 읽는다. */
  integrationStatus: unknown;
  onSave: (draft: SettingsDraft) => void;
  onClose: () => void;
  onLogout?: () => Promise<boolean | undefined | void>;
  onMigrate?: () => void;
  onPresetsImported?: (...args: never[]) => unknown;
}
