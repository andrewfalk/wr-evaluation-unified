// App 컨트롤러 3 — editing(REFACTORING_ROADMAP Phase 2 C3-C, P2-44c). 옛 `src/App.jsx` 137-186줄을 순서 그대로 옮겼다:
// 편집 락·편집 가능 여부(canMutateActivePatient)·프리셋·마이그레이션·운영 알림·내보내기·EMR 연동.
// 규칙은 useShellController.ts 머리 주석과 같다.
import { usePatientLock, requiresLock } from '../../core/hooks/usePatientLock';
import { usePresetManagement } from '../../core/hooks/usePresetManagement';
import { useMigration } from '../../core/hooks/useMigration';
import { useOpsStatus } from '../../core/hooks/useOpsStatus';
import { useExportHandlers } from '../../core/hooks/useExportHandlers';
import { useEMRIntegration } from '../../core/hooks/useEMRIntegration';
import { canEditPatient } from '../../core/utils/patientOwnership';
import type { PatientRecord } from '../../core/types/patient';
import type { SetPatients } from '../../core/state/patientStore/usePatientsContainer';
import type { ModalState } from '../useModalState';
import type {
  AppSession, AppSettings, EmrIntegrationApi, ExportHandlersApi, LockState, MigrationApi, PresetManagementApi,
  UseEMRIntegration, UseExportHandlers, UseMigration, UseOpsStatus, UsePatientLock, UsePresetManagement,
} from './contracts';

export interface EditingControllerInput {
  activeId: string | null;
  activePatient: PatientRecord | undefined;
  activeModules: string[];
  patients: PatientRecord[];
  selectedIds: Set<string>;
  session: AppSession;
  settings: AppSettings;
  isAuthenticated: boolean;
  setPatients: SetPatients;
  modals: ModalState['modals'];
  setterFor: ModalState['setterFor'];
  dirtyAssessmentPatientId: string | null;
}

export interface EditingController extends
  Omit<PresetManagementApi, never>,
  ExportHandlersApi,
  EmrIntegrationApi {
  lockState: LockState;
  forceAcquire: () => Promise<unknown>;
  canMutateActivePatient: boolean;
  migrationStatus: MigrationApi['status'];
  migrationResult: MigrationApi['result'];
  startMigration: MigrationApi['start'];
  retryMigration: MigrationApi['retry'];
  resetMigration: MigrationApi['reset'];
  showOpsBanner: boolean;
  opsBannerMessage: string | null;
}

export function useEditingController({
  activeId, activePatient, activeModules, patients, selectedIds, session, settings, isAuthenticated, setPatients,
  modals, setterFor, dirtyAssessmentPatientId,
}: EditingControllerInput): EditingController {
  // 환자를 여는 것 자체가 편집 세션의 시작 — 서버 측 TTL lease lock을 자동으로 acquire/renew한다.
  // usePatientSync/usePresetManagement는 이 lockState(또는 그로부터 합성한 canMutateActivePatient)를
  // 읽기 전용으로만 받는다(콜백을 주고받지 않음). 두 훅과의 연결(브리지)은 sync 컨트롤러의 별도 effect가
  // lockState 전이를 관찰해 담당한다.
  const { lockState, forceAcquire } = (usePatientLock as unknown as UsePatientLock)({ activeId, activePatient, session, settings });
  // 프리셋 모달은 StepContent의 read-only 이벤트 차단 바깥에서 열리므로(§리뷰), 담당의 권한만으로는
  // "모달이 열려있는 동안 락을 상실"하는 레이스를 못 막는다 — canEditPatient AND 락 보유를 합성해
  // usePatientCrud/usePresetManagement/StepContent 모두가 이 값 하나만 신뢰하게 한다.
  const canMutateActivePatient =
    canEditPatient(activePatient, session) &&
    (!requiresLock(activePatient, session) || lockState.status === 'held');

  const {
    presets, presetMeta, presetError,
    presetModalJobId, presetEditingPreset, presetBrowseJobId,
    setPresetModalJobId, setPresetEditingPreset, setPresetBrowseJobId,
    reloadPresets,
    handlePresetSelect, handleSaveCustomPreset, closePresetManageModal, handleDeleteCustomPreset,
  } = (usePresetManagement as unknown as UsePresetManagement)({
    activeId, activeModules, session, setPatients, canMutateActivePatient,
    modalSlots: {
      presetModalJobId: modals.presetManageJobId, setPresetModalJobId: setterFor('presetManageJobId'),
      presetEditingPreset: modals.presetEditingPreset, setPresetEditingPreset: setterFor('presetEditingPreset'),
      presetBrowseJobId: modals.presetBrowseJobId, setPresetBrowseJobId: setterFor('presetBrowseJobId'),
    },
  });

  const {
    status: migrationStatus,
    result: migrationResult,
    start:  startMigration,
    retry:  retryMigration,
    reset:  resetMigration,
  } = (useMigration as unknown as UseMigration)({ session, settings });

  const isAdmin = session?.user?.role === 'admin' && isAuthenticated;
  const { showBanner: showOpsBanner, bannerMessage: opsBannerMessage } = (useOpsStatus as unknown as UseOpsStatus)({ session, enabled: isAdmin });

  const {
    exportDropdown, setExportDropdown,
    handleExportSingle, handleExportSelected, handleExportBatch,
    handleExportBatchFormatSingle, handleExportBatchFormatSelected, handleExportBatchFormatAll,
    handleExportBatchTemplate,
  } = (useExportHandlers as unknown as UseExportHandlers)({ activePatient, patients, selectedIds, dirtyAssessmentPatientId });

  const {
    extractProgress, setExtractProgress,
    handleInjectEMR, handleInjectConsultReply,
    handleEmrExtractBatch, handleExtractConsultation,
  } = (useEMRIntegration as unknown as UseEMRIntegration)({ activePatient, patients, selectedIds, session, setPatients, dirtyAssessmentPatientId });

  return {
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
  };
}
