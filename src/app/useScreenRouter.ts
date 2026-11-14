// 화면 라우팅 — REFACTORING_ROADMAP Phase 2 C3-A(P2-26). App.jsx에 흩어져 있던 ① 화면 상태(activeScreen + showHome 호환
// shim) ② 통계 워크벤치 열기/닫기(복귀 화면 기억) ③ 어떤 화면을 그릴지의 분기 순서를 한 곳으로 모은다.
// 부팅 게이트(BootGate.tsx)를 통과한 뒤의 순서가 곧 의미다 — selectScreen 머리 주석.
import { useCallback, useRef, useState } from 'react';

export type ActiveScreen = 'workspace' | 'dashboard' | 'statistics';
export type ScreenId = 'statistics' | 'serverPatientsLoading' | 'landing' | 'intake' | 'workspace';

export interface ScreenInputs {
  activeScreen: ActiveScreen;
  /** 인증된 인트라넷 세션(hasIntranetSession). */
  intranetSession: boolean;
  patientCount: number;
  activeId: string | null | undefined;
  /** 신규 환자 위자드 진행 중(intakeShared가 있음). */
  hasIntake: boolean;
  syncStatus: string | null | undefined;
  serverPatientCount: number | null | undefined;
}

/**
 * 그릴 화면. 순서(앞이 이긴다):
 *   1. 통계 워크벤치 — 환자 동기화 로딩·자동 랜딩보다 먼저(이 화면은 환자 목록을 쓰지 않으므로 그 판정이 가리면 안 됨)
 *   2. 인트라넷 첫 부팅 중 서버 환자 목록 로딩(환자 0·선택 없음·위자드 아님·대시보드 아님 + 동기화 중)
 *   3. 랜딩/대시보드 — 사용자가 연 대시보드(showHome)는 항상, 자동 진입은 환자가 없을 때만(인트라넷에서 서버에 환자가
 *      있으면 자동 랜딩을 억제 — 목록 화면에서 scope 전환 등으로 해결)
 *   4. 신규 환자 위자드
 *   5. 작업 화면
 */
export function selectScreen(input: ScreenInputs): ScreenId {
  if (input.activeScreen === 'statistics') return 'statistics';

  const showHome = input.activeScreen === 'dashboard';
  const isBootingFromServer = input.intranetSession
    && input.patientCount === 0
    && !input.activeId
    && !input.hasIntake
    && !showHome;
  if (isBootingFromServer && input.syncStatus === 'syncing') return 'serverPatientsLoading';

  const hasAnyServerPatient = input.intranetSession && (input.serverPatientCount ?? 0) > 0;
  const shouldAutoShowLanding = input.patientCount === 0 && !input.activeId && !input.hasIntake;
  if (showHome || (!hasAnyServerPatient && shouldAutoShowLanding)) return 'landing';

  if (input.hasIntake) return 'intake';
  return 'workspace';
}

export interface OpenStatisticsGuards {
  /** 종합소견 편집 중(미저장 초안) — 막고 onDraftBlocked. */
  draftDirty: boolean;
  onDraftBlocked: () => void;
  statsAvailable: boolean;
  onUnavailable: () => void;
}

export interface ScreenRouter {
  activeScreen: ActiveScreen;
  /** 대시보드 화면인가(예전 showHome boolean — 훅·컴포넌트 21곳 호환). */
  showHome: boolean;
  /** true면 대시보드, false면 작업 화면(통계 화면도 닫힌다 — 예전 shim과 같음). */
  setShowHome: (value: boolean) => void;
  /** 통계 워크벤치 열기. 헤더·랜딩 버튼·Electron 메뉴가 모두 이것을 부른다(경로별 가드를 따로 만들지 않음). */
  openStatistics: (guards: OpenStatisticsGuards) => void;
  /** 통계 워크벤치 닫기 — 연 시점의 화면(작업 화면 또는 대시보드)으로 돌아간다. */
  closeStatistics: () => void;
}

export function useScreenRouter(): ScreenRouter {
  const [activeScreen, setActiveScreen] = useState<ActiveScreen>('workspace');
  // 'workspace' 아니면 'dashboard'만 담는다 — openStatistics가 이미 통계 화면이면 먼저 돌아가므로.
  const returnScreenRef = useRef<Exclude<ActiveScreen, 'statistics'>>('workspace');

  const setShowHome = useCallback((value: boolean) => {
    setActiveScreen(value ? 'dashboard' : 'workspace');
  }, []);

  const openStatistics = useCallback((guards: OpenStatisticsGuards) => {
    if (activeScreen === 'statistics') return; // 이미 통계 화면 — 메뉴 재클릭이 복귀값을 오염시키지 않게
    if (guards.draftDirty) { guards.onDraftBlocked(); return; }
    if (!guards.statsAvailable) { guards.onUnavailable(); return; }
    returnScreenRef.current = activeScreen;
    setActiveScreen('statistics');
  }, [activeScreen]);

  const closeStatistics = useCallback(() => {
    setActiveScreen(returnScreenRef.current);
  }, []);

  return { activeScreen, showHome: activeScreen === 'dashboard', setShowHome, openStatistics, closeStatistics };
}
