// App 컨트롤러 1 — shell(REFACTORING_ROADMAP Phase 2 C3-C, P2-44b). 옛 `src/App.jsx` 72-108줄을 **순서 그대로** 옮겼다:
// 인증·화면 수명 가드·환자 상태 컨테이너·scope·동기화 일시정지·모달 열림 상태·UI 상태(필터·사이드바·오류)·화면 라우터·
// 충돌 대상 환자·종합소견 미저장 초안 가드.
//
// 컨트롤러 규칙(계획 "설계 원칙" 2·3): 훅·useState는 App fiber에서 지금 순서로 불린다(App이 컨트롤러를 차례로 부른다 —
// effect 등록 순서는 scripts/appHookOrder.test.mjs 골든이 지킨다). 값은 가공하지 않고 훅이 준 참조를 이름만 붙여 돌려준다.
import { useState, type Dispatch, type SetStateAction } from 'react';
import { useAuth } from '../../core/auth/AuthContext';
import { showAlert, showConfirm } from '../../core/utils/platform';
import { usePatientsContainer } from '../../core/state/patientStore/usePatientsContainer';
import type { PatientsContainer } from '../../core/state/patientStore/usePatientsContainer';
import type { PatientStore } from '../../core/state/patientStore/store';
import { useGuardedDialogs } from '../useWorkspaceLifetime';
import { usePatientScope, type PatientScopeState } from '../usePatientScope';
import { useModalState, type ModalState, type SlotSetter } from '../useModalState';
import { useScreenRouter, type ScreenRouter } from '../useScreenRouter';
import { useUnsavedDraftGuard, type UnsavedDraftGuard } from '../useUnsavedDraftGuard';
import type { AuthForApp, UseAuth } from './contracts';

export const DEFAULT_PATIENT_FILTERS = {
  searchQuery: '',
  statusFilter: 'all',
  moduleFilter: 'all',
  jobFilter: '',
  registrationFrom: '',
  registrationTo: '',
  completionFrom: '',
  completionTo: '',
  sortKey: 'default',
  sortDirection: 'asc',
};
export type PatientFilters = typeof DEFAULT_PATIENT_FILTERS;

type GuardedDialogs = ReturnType<typeof useGuardedDialogs>;

export interface ShellController extends
  Pick<AuthForApp, 'session' | 'isAuthenticated' | 'sessionVerified' | 'logout' | 'getWorkspaceOwner' | 'getAuthEpoch'>,
  GuardedDialogs,
  Omit<PatientsContainer, 'store'>,
  Pick<PatientScopeState, 'setPatientScope' | 'setDashboardScope' | 'effectivePatientScope' | 'canUseDashboardScope' | 'effectiveDashboardScope'>,
  Pick<ModalState, 'modals' | 'setterFor' | 'adminConsoleTab' | 'setAdminConsoleTab'>,
  Pick<ScreenRouter, 'activeScreen' | 'setShowHome' | 'openStatistics' | 'closeStatistics'>,
  UnsavedDraftGuard {
  patientStore: PatientStore;
  patientScopeState: PatientScopeState;
  patientSyncPaused: boolean;
  setPatientSyncPaused: Dispatch<SetStateAction<boolean>>;
  showSaveModal: boolean; setShowSaveModal: SlotSetter<'save'>;
  showLoadModal: boolean; setShowLoadModal: SlotSetter<'load'>;
  errors: Record<string, unknown>; setErrors: Dispatch<SetStateAction<Record<string, unknown>>>;
  showSidebar: boolean; setShowSidebar: Dispatch<SetStateAction<boolean>>;
  patientFilters: PatientFilters; setPatientFilters: Dispatch<SetStateAction<PatientFilters>>;
  showSettings: boolean; setShowSettings: SlotSetter<'settings'>;
  showAdminConsole: boolean; setShowAdminConsole: SlotSetter<'adminConsole'>;
  showAccountProfile: boolean; setShowAccountProfile: SlotSetter<'accountProfile'>;
  showChangePassword: boolean; setShowChangePassword: SlotSetter<'changePassword'>;
  showMigrationReport: boolean; setShowMigrationReport: SlotSetter<'migrationReport'>;
  showBatchImport: boolean; setShowBatchImport: SlotSetter<'batchImport'>;
  conflictPatientId: string | null; setConflictPatientId: Dispatch<SetStateAction<string | null>>;
}

export function useShellController(): ShellController {
  const { session, isAuthenticated, sessionVerified, logout, getWorkspaceOwner, getAuthEpoch } = (useAuth as unknown as UseAuth)();
  // 화면 수명(계정 전환 수정 AS-4) — 계정이 바뀌어 이 화면이 내려간 뒤에는 기다리던 처리의 저장소 쓰기·서버 요청·알림·확인창을
  // 이어 가지 않는다(src/app/useWorkspaceLifetime). 이 한 인스턴스를 뒤 컨트롤러가 인자로 받는다(계획 원칙 3).
  const { isAlive, alertAlive, confirmAlive } = useGuardedDialogs(showAlert, showConfirm);
  // 환자 목록·활성 환자·선택 집합 — 환자 상태 컨테이너(src/core/state/patientStore, REFACTORING_ROADMAP Phase 2 C4·P2-32·P2-37).
  // setter는 전부 참조 고정, 훅에는 지금처럼 따로 넘긴다.
  const { patients, setPatients, activeId, setActiveId, selectedIds, setSelectedIds, store: patientStore } = usePatientsContainer();
  // 목록·대시보드 scope 상태·파생값, 세션이 바뀌면 기본값으로 — src/app/usePatientScope.ts(P2-27).
  const patientScopeState = usePatientScope(session);
  const {
    setPatientScope, setDashboardScope,
    effectivePatientScope, canUseDashboardScope, effectiveDashboardScope,
  } = patientScopeState;
  const [patientSyncPaused, setPatientSyncPaused] = useState(false);
  // 모달 열림 상태 — 키별 맵 하나(불리언 8 + 프리셋 3, 여러 모달이 동시에 열릴 수 있음): src/app/useModalState.ts(P2-30).
  // 아래 이름들은 예전 개별 useState와 같은 값·setter다(하위 훅은 인자로, 모달은 ModalHost가 작업 공간 Context로 받는다 — P2-45a).
  const { modals, setterFor, adminConsoleTab, setAdminConsoleTab } = useModalState();
  const showSaveModal = modals.save; const setShowSaveModal = setterFor('save');
  const showLoadModal = modals.load; const setShowLoadModal = setterFor('load');
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const [showSidebar, setShowSidebar] = useState(false);
  const [patientFilters, setPatientFilters] = useState(DEFAULT_PATIENT_FILTERS);
  const showSettings = modals.settings; const setShowSettings = setterFor('settings');
  const showAdminConsole = modals.adminConsole; const setShowAdminConsole = setterFor('adminConsole');
  const showAccountProfile = modals.accountProfile; const setShowAccountProfile = setterFor('accountProfile');
  const showChangePassword = modals.changePassword; const setShowChangePassword = setterFor('changePassword');
  const showMigrationReport = modals.migrationReport; const setShowMigrationReport = setterFor('migrationReport');
  const showBatchImport = modals.batchImport; const setShowBatchImport = setterFor('batchImport');
  // 화면 상태(activeScreen)·showHome 호환 shim·통계 열기/닫기 — src/app/useScreenRouter.ts(P2-26). setShowHome은
  // 훅·컴포넌트 21곳이 그대로 쓰며, true/false 모두 통계 화면을 닫는다(PR2 §1의 단일 진실원 그대로).
  const { activeScreen, setShowHome, openStatistics, closeStatistics } = useScreenRouter();
  const [conflictPatientId, setConflictPatientId] = useState<string | null>(null);

  // 종합소견 미저장 초안 — 상태(환자 ID)·안내·편집 신호·가드·셸 신호·beforeunload는 src/app/useUnsavedDraftGuard.ts(P2-29).
  const {
    dirtyAssessmentPatientId, blockedByUnsavedDraftAlert, handleAssessmentEditingChange, blockIfDraftDirty,
  } = useUnsavedDraftGuard();

  return {
    session, isAuthenticated, sessionVerified, logout, getWorkspaceOwner, getAuthEpoch,
    isAlive, alertAlive, confirmAlive,
    patients, setPatients, activeId, setActiveId, selectedIds, setSelectedIds, patientStore,
    patientScopeState, setPatientScope, setDashboardScope, effectivePatientScope, canUseDashboardScope, effectiveDashboardScope,
    patientSyncPaused, setPatientSyncPaused,
    modals, setterFor, adminConsoleTab, setAdminConsoleTab,
    showSaveModal, setShowSaveModal, showLoadModal, setShowLoadModal,
    errors, setErrors, showSidebar, setShowSidebar, patientFilters, setPatientFilters,
    showSettings, setShowSettings, showAdminConsole, setShowAdminConsole, showAccountProfile, setShowAccountProfile,
    showChangePassword, setShowChangePassword, showMigrationReport, setShowMigrationReport, showBatchImport, setShowBatchImport,
    activeScreen, setShowHome, openStatistics, closeStatistics,
    conflictPatientId, setConflictPatientId,
    dirtyAssessmentPatientId, blockedByUnsavedDraftAlert, handleAssessmentEditingChange, blockIfDraftDirty,
  };
}
