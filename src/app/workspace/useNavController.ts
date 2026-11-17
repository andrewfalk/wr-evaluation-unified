// App 컨트롤러 4 — nav(REFACTORING_ROADMAP Phase 2 C3-C, P2-44c). 옛 `src/App.jsx` 188-206줄을 순서 그대로 옮겼다:
// Electron 메뉴용 ref 3개·단계 목록·단계 이동·새 환자 위자드. 옛 111-121줄의 guardedSelectPatient(공용 환자 선택 가드)는
// 단계 이동 훅 뒤로 옮겼다 — 그 안에서 쓰는 setCurrentStepIndex가 여기서 선언된다(계획 C11; useCallback은 effect가 없어
// effect 순서는 그대로).
// 규칙은 useShellController.ts 머리 주석과 같다.
import { useCallback, useMemo, useRef, type MutableRefObject } from 'react';
import { useStepNavigation } from '../../core/hooks/useStepNavigation';
import { useIntakeWizard } from '../../core/hooks/useIntakeWizard';
import { buildSteps } from '../../core/utils/steps';
import type { SetActiveId, SetPatients } from '../../core/state/patientStore/usePatientsContainer';
import type { Dispatch, SetStateAction } from 'react';
import type {
  AppSession, AppSettings, IntakeWizardApi, ServerConfig, Step, StepNavigationApi, UseIntakeWizard, UseStepNavigation,
} from './contracts';

type MenuHandlerRef = MutableRefObject<(() => unknown) | null>;

export interface NavControllerInput {
  settings: AppSettings;
  session: AppSession;
  serverConfig: ServerConfig;
  activeModules: string[];
  activeId: string | null;
  setActiveId: SetActiveId;
  setPatients: SetPatients;
  setShowSidebar: Dispatch<SetStateAction<boolean>>;
  setShowHome: (value: boolean) => void;
  dirtyAssessmentPatientId: string | null;
  blockedByUnsavedDraftAlert: () => void;
  blockIfDraftDirty: () => boolean;
}

export interface NavController extends StepNavigationApi, IntakeWizardApi {
  handleStartIntakeRef: MenuHandlerRef;
  handleResetPatientsRef: MenuHandlerRef;
  handleOpenStatisticsRef: MenuHandlerRef;
  videoAnalysisEnabled: boolean;
  steps: Step[];
  guardedSelectPatient: (patientId: string, options?: { stepIndex?: number }) => boolean;
}

export function useNavController({
  settings, session, serverConfig, activeModules, activeId, setActiveId, setPatients, setShowSidebar, setShowHome,
  dirtyAssessmentPatientId, blockedByUnsavedDraftAlert, blockIfDraftDirty,
}: NavControllerInput): NavController {
  const handleStartIntakeRef: MenuHandlerRef = useRef(null);
  const handleResetPatientsRef: MenuHandlerRef = useRef(null);
  const handleOpenStatisticsRef: MenuHandlerRef = useRef(null); // PR2 §3 — Electron 메뉴가 구독

  // 현재 환자의 스텝 목록
  const videoAnalysisEnabled = !!serverConfig?.videoAnalysisEnabled;
  const steps = useMemo(
    () => buildSteps(activeModules, { videoAnalysisEnabled }),
    [activeModules, videoAnalysisEnabled]
  );
  const { currentStepIndex, setCurrentStepIndex, goToStep, goNext, goPrev, switchPatient } = (useStepNavigation as unknown as UseStepNavigation)({
    steps, activeId, setActiveId, setShowSidebar,
    hasUnsavedAssessmentDraft: !!dirtyAssessmentPatientId, onBlockedByUnsavedDraft: blockedByUnsavedDraftAlert,
  });
  const { intakeShared, setIntakeShared, handleStartIntake, handleIntakeComplete } = (useIntakeWizard as unknown as UseIntakeWizard)({
    settings, session, setPatients, setActiveId, setCurrentStepIndex, setShowHome, videoAnalysisEnabled,
    hasUnsavedAssessmentDraft: !!dirtyAssessmentPatientId, onBlockedByUnsavedDraft: blockedByUnsavedDraftAlert,
  });
  // 렌더 중 대입(Electron 메뉴가 ref로 최신 핸들러를 부른다) — effect로 바꾸면 effect가 늘고 대입이 커밋 뒤로 밀린다(계획).
  // eslint-disable-next-line react-hooks/refs -- 렌더 중 대입 유지(옛 App.jsx와 같은 시점)
  handleStartIntakeRef.current = handleStartIntake;

  // guardedSelectPatient()로 모으지 못한 직접 setActiveId 호출부(랜딩 화면의 "이어서 작업",
  // 충돌 모달의 "정정 화면으로 이동")가 개별적으로 재구현하지 않도록 공용 가드를 둔다.
  const guardedSelectPatient = useCallback((patientId: string, { stepIndex = 0 }: { stepIndex?: number } = {}) => {
    // 이미 활성인 환자를 다시 선택했으면 스텝을 건드리지 않는다(useStepNavigation의
    // switchPatient와 동일한 이유 — dirty 여부와 무관하게 항상 no-op이어야 한다).
    if (patientId === activeId) { setShowHome(false); return true; }
    if (blockIfDraftDirty()) return false;
    setActiveId(patientId);
    setCurrentStepIndex(stepIndex);
    setShowHome(false);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockIfDraftDirty, activeId]);

  return {
    handleStartIntakeRef, handleResetPatientsRef, handleOpenStatisticsRef,
    videoAnalysisEnabled, steps,
    currentStepIndex, setCurrentStepIndex, goToStep, goNext, goPrev, switchPatient,
    intakeShared, setIntakeShared, handleStartIntake, handleIntakeComplete,
    guardedSelectPatient,
  };
}
