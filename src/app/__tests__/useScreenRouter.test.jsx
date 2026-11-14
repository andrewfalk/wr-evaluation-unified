// @vitest-environment jsdom
// selectScreen(분기 순서) + useScreenRouter(StrictMode) — REFACTORING_ROADMAP Phase 2 P2-26.
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { selectScreen, useScreenRouter } from '../useScreenRouter';

const base = {
  activeScreen: 'workspace',
  intranetSession: true,
  patientCount: 3,
  activeId: 'p1',
  hasIntake: false,
  syncStatus: 'idle',
  serverPatientCount: 3,
};

describe('selectScreen — 분기 순서', () => {
  it('통계 화면이 환자 동기화 로딩보다 먼저(계획 완료 기준)', () => {
    expect(selectScreen({ ...base, activeScreen: 'statistics', patientCount: 0, activeId: null, syncStatus: 'syncing' })).toBe('statistics');
  });

  it('통계 화면이 위자드·자동 랜딩보다도 먼저', () => {
    expect(selectScreen({ ...base, activeScreen: 'statistics', hasIntake: true })).toBe('statistics');
    expect(selectScreen({ ...base, activeScreen: 'statistics', intranetSession: false, patientCount: 0, activeId: null })).toBe('statistics');
  });

  it('인트라넷 첫 부팅 + 동기화 중 → 서버 환자 로딩(랜딩보다 먼저)', () => {
    expect(selectScreen({ ...base, patientCount: 0, activeId: null, syncStatus: 'syncing', serverPatientCount: 0 })).toBe('serverPatientsLoading');
  });

  it('서버 환자 로딩은 인트라넷 세션·환자 0·선택 없음·위자드 아님·대시보드 아님·syncing일 때만', () => {
    const booting = { ...base, patientCount: 0, activeId: null, syncStatus: 'syncing', serverPatientCount: 0 };
    expect(selectScreen({ ...booting, intranetSession: false })).toBe('landing');
    expect(selectScreen({ ...booting, patientCount: 1 })).not.toBe('serverPatientsLoading');
    expect(selectScreen({ ...booting, activeId: 'x' })).not.toBe('serverPatientsLoading');
    expect(selectScreen({ ...booting, hasIntake: true })).toBe('intake');
    expect(selectScreen({ ...booting, activeScreen: 'dashboard' })).toBe('landing');
    expect(selectScreen({ ...booting, syncStatus: 'idle' })).toBe('landing');
  });

  it('대시보드(showHome)는 서버 상태와 무관하게 랜딩, 위자드보다 먼저', () => {
    expect(selectScreen({ ...base, activeScreen: 'dashboard', hasIntake: true })).toBe('landing');
  });

  it('자동 랜딩: 환자 0·선택 없음·위자드 아님 — 단 인트라넷에서 서버에 환자가 있으면 억제(작업 화면 껍데기)', () => {
    const empty = { ...base, patientCount: 0, activeId: null, syncStatus: 'idle' };
    expect(selectScreen({ ...empty, serverPatientCount: 0 })).toBe('landing');
    expect(selectScreen({ ...empty, serverPatientCount: 5 })).toBe('workspace');
    expect(selectScreen({ ...empty, serverPatientCount: null })).toBe('landing');
    expect(selectScreen({ ...empty, intranetSession: false, serverPatientCount: 5 })).toBe('landing');
  });

  it('위자드 → 작업 화면', () => {
    expect(selectScreen({ ...base, hasIntake: true })).toBe('intake');
    expect(selectScreen(base)).toBe('workspace');
  });
});

describe('useScreenRouter', () => {
  const render = () => renderHook(() => useScreenRouter(), { wrapper: StrictMode });
  const guards = (over = {}) => ({ draftDirty: false, onDraftBlocked: vi.fn(), statsAvailable: true, onUnavailable: vi.fn(), ...over });

  it('처음은 작업 화면, setShowHome(true/false)로 대시보드 ↔ 작업 화면', () => {
    const { result } = render();
    expect(result.current).toMatchObject({ activeScreen: 'workspace', showHome: false });
    act(() => result.current.setShowHome(true));
    expect(result.current).toMatchObject({ activeScreen: 'dashboard', showHome: true });
    act(() => result.current.setShowHome(false));
    expect(result.current.activeScreen).toBe('workspace');
  });

  it('통계 열기 → 닫기는 연 시점의 화면(대시보드)으로 돌아간다, 통계 중 재열기는 복귀값을 바꾸지 않는다', () => {
    const { result } = render();
    act(() => result.current.setShowHome(true));
    act(() => result.current.openStatistics(guards()));
    expect(result.current.activeScreen).toBe('statistics');
    act(() => result.current.openStatistics(guards()));
    act(() => result.current.closeStatistics());
    expect(result.current.activeScreen).toBe('dashboard');
  });

  it('setShowHome은 통계 화면도 닫는다(Electron "새로 만들기" 등 — 예전 shim과 같음)', () => {
    const { result } = render();
    act(() => result.current.openStatistics(guards()));
    act(() => result.current.setShowHome(false));
    expect(result.current.activeScreen).toBe('workspace');
  });

  it('가드 순서: 미저장 초안이면 막고(가용 여부와 무관), 그다음 사용 불가 안내', () => {
    const { result } = render();
    const g1 = guards({ draftDirty: true, statsAvailable: false });
    act(() => result.current.openStatistics(g1));
    expect(g1.onDraftBlocked).toHaveBeenCalledTimes(1);
    expect(g1.onUnavailable).not.toHaveBeenCalled();
    const g2 = guards({ statsAvailable: false });
    act(() => result.current.openStatistics(g2));
    expect(g2.onUnavailable).toHaveBeenCalledTimes(1);
    expect(result.current.activeScreen).toBe('workspace');
  });

  it('setShowHome·closeStatistics는 안정된 참조', () => {
    const { result, rerender } = render();
    const first = result.current;
    rerender();
    expect(result.current.setShowHome).toBe(first.setShowHome);
    expect(result.current.closeStatistics).toBe(first.closeStatistics);
  });
});
