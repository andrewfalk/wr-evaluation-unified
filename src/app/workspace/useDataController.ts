// App 컨트롤러 6 — data(REFACTORING_ROADMAP Phase 2 C3-C, P2-44d). 옛 `src/App.jsx` 279-311줄을 순서 그대로 옮겼다:
// 작업 공간 저장/불러오기·자동저장(useWorkspacePersistence) → 현재 단계·활성 모듈 → 환자 CRUD(usePatientCrud).
// 옛 App이 받기만 하고 쓰지 않던 `setSavedItems`는 받지 않는다(계획). 규칙은 useShellController.ts 머리 주석과 같다.
import { useWorkspacePersistence } from '../../core/hooks/useWorkspacePersistence';
import { usePatientCrud } from '../../core/hooks/usePatientCrud';
import { getModule } from '../../core/moduleRegistry';
import type { Dispatch, SetStateAction } from 'react';
import type { PatientRecord } from '../../core/types/patient';
import type { SetActiveId, SetPatients, SetSelectedIds } from '../../core/state/patientStore/usePatientsContainer';
import type { SlotSetter } from '../useModalState';
import type {
  AppModule, AppSession, AppSettings, PatientCrudApi, ServerConfig, Step, UsePatientCrud, UseWorkspacePersistence,
  WorkspacePersistenceApi,
} from './contracts';

export interface DataControllerInput {
  patients: PatientRecord[];
  setPatients: SetPatients;
  session: AppSession;
  settings: AppSettings;
  serverConfig: ServerConfig;
  activeId: string | null;
  setActiveId: SetActiveId;
  selectedIds: Set<string>;
  setSelectedIds: SetSelectedIds;
  setErrors: Dispatch<SetStateAction<Record<string, unknown>>>;
  setCurrentStepIndex: (index: number) => void;
  setIntakeShared: (value: unknown) => void;
  setShowHome: (value: boolean) => void;
  setShowSaveModal: SlotSetter<'save'>;
  setShowLoadModal: SlotSetter<'load'>;
  isIntranetMode: boolean;
  configLoading: boolean;
  configError: unknown;
  steps: Step[];
  currentStepIndex: number;
  handleStartIntake: () => unknown;
  canMutateActivePatient: boolean;
  dirtyAssessmentPatientId: string | null;
  blockedByUnsavedDraftAlert: () => void;
}

export interface DataController extends Omit<WorkspacePersistenceApi, 'setSavedItems'>, PatientCrudApi {
  currentStep: Step;
  activeModuleId: string | null;
  activeModule: AppModule | null | undefined;
}

export function useDataController({
  patients, setPatients, session, settings, serverConfig, activeId, setActiveId, selectedIds, setSelectedIds, setErrors,
  setCurrentStepIndex, setIntakeShared, setShowHome, setShowSaveModal, setShowLoadModal, isIntranetMode, configLoading,
  configError, steps, currentStepIndex, handleStartIntake, canMutateActivePatient, dirtyAssessmentPatientId,
  blockedByUnsavedDraftAlert,
}: DataControllerInput): DataController {
  const {
    savedItems, saveName, setSaveName, lastAutoSave, legacyItems,
    handleSave, handleOverwriteSave, handleLoad, handleDelete, openLoadModal, waitForAutosaveRestore,
  } = (useWorkspacePersistence as unknown as UseWorkspacePersistence)({
    patients, setPatients,
    session, settings, serverConfig,
    setActiveId, setCurrentStepIndex, setIntakeShared, setShowHome,
    setShowSaveModal, setShowLoadModal,
    disabled: isIntranetMode && (configLoading || !!configError),
    dirtyAssessmentPatientId, onBlockedByUnsavedDraft: blockedByUnsavedDraftAlert,
  });
  const currentStep = steps[currentStepIndex] || steps[0];

  // 현재 스텝의 모듈 정보
  const activeModuleId = currentStep?.moduleId || null;
  const activeModule = activeModuleId ? (getModule(activeModuleId) as AppModule | undefined) : null;

  const {
    updatePatient, updateShared, updateActiveModules,
    updateModule, updateModuleById, updateDiagnoses,
    addPatient, removePatient, removeSelectedPatients,
    handleBatchImport, handleLoadTestData,
  } = (usePatientCrud as unknown as UsePatientCrud)({
    activeId, activeModuleId, session, settings,
    patients, setPatients,
    selectedIds, setSelectedIds,
    setErrors,
    setActiveId, setCurrentStepIndex,
    setIntakeShared, setShowHome,
    handleStartIntake,
    canMutateActivePatient,
    dirtyAssessmentPatientId, onBlockedByUnsavedDraft: blockedByUnsavedDraftAlert,
  });

  return {
    savedItems, saveName, setSaveName, lastAutoSave, legacyItems,
    handleSave, handleOverwriteSave, handleLoad, handleDelete, openLoadModal, waitForAutosaveRestore,
    currentStep, activeModuleId, activeModule,
    updatePatient, updateShared, updateActiveModules,
    updateModule, updateModuleById, updateDiagnoses,
    addPatient, removePatient, removeSelectedPatients,
    handleBatchImport, handleLoadTestData,
  };
}
