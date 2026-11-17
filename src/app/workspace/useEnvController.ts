// App 컨트롤러 2 — env(REFACTORING_ROADMAP Phase 2 C3-C, P2-44b). 옛 `src/App.jsx` 122-135줄을 순서 그대로 옮겼다:
// 서버 공개 설정·AI 가용성·연동 상태와 그 파생값(통계 가용성·인트라넷 모드), 활성 환자·충돌 대상 환자·활성 모듈 목록.
// 규칙은 useShellController.ts 머리 주석과 같다(훅은 App fiber에서 지금 순서로, 값은 가공하지 않는다 — 파생값 식은 글자 그대로).
import { useServerConfig } from '../../core/hooks/useServerConfig';
import { useAIAvailable } from '../../core/hooks/useAIAvailable';
import { useIntegrationStatus } from '../../core/hooks/useIntegrationStatus';
import { isRedactedPatientRecord } from '../../core/services/patientRecords';
import { isIntranetContext } from '../../platform/dataMode';
import type { PatientRecord } from '../../core/types/patient';
import type {
  AppSession, AppSettings, ServerConfig, UseAIAvailable, UseIntegrationStatus, UseServerConfig,
} from './contracts';

export interface EnvControllerInput {
  session: AppSession;
  settings: AppSettings;
  patients: PatientRecord[];
  activeId: string | null;
  conflictPatientId: string | null;
}

export interface EnvController {
  serverConfig: ServerConfig;
  configLoading: boolean;
  configError: unknown;
  refetchConfig: () => unknown;
  statsConfigRefreshing: boolean;
  statsConfigRefreshError: unknown;
  aiAvailable: boolean;
  statsAvailable: boolean;
  isIntranetMode: boolean;
  integrationStatus: unknown;
  activePatient: PatientRecord | undefined;
  conflictPatient: PatientRecord | undefined;
  activeModules: string[];
}

export function useEnvController({ session, settings, patients, activeId, conflictPatientId }: EnvControllerInput): EnvController {
  const { serverConfig, configLoading, configError, refetchConfig, refreshing: statsConfigRefreshing, refreshError: statsConfigRefreshError } =
    (useServerConfig as unknown as UseServerConfig)({ session, settings });
  const { aiAvailable } = (useAIAvailable as unknown as UseAIAvailable)({ serverConfig, session });
  // PR2 §4 — 통계 워크벤치 가용성. videoAnalysisEnabled(:190)와 같은 단순 boolean 패턴 —
  // 별도 훅 없이 statsWorkbenchAvailable 플래그 하나로 메뉴 노출을 결정한다.
  const statsAvailable = !!serverConfig?.statsWorkbenchAvailable;
  const isIntranetMode =
    isIntranetContext({ session, settings });
  const { status: integrationStatus } = (useIntegrationStatus as unknown as UseIntegrationStatus)({ session, settings });
  const activePatient = patients.find(p => p.id === activeId);
  const conflictPatient = patients.find(
    p => p.id === conflictPatientId && p.sync?.syncStatus === 'conflict'
  );
  const activeModules = isRedactedPatientRecord(activePatient) ? [] : (activePatient?.data?.activeModules || []);

  return {
    serverConfig, configLoading, configError, refetchConfig, statsConfigRefreshing, statsConfigRefreshError,
    aiAvailable, statsAvailable, isIntranetMode, integrationStatus,
    activePatient, conflictPatient, activeModules,
  };
}
