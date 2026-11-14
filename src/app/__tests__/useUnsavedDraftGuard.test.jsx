// @vitest-environment jsdom
// useUnsavedDraftGuard(REFACTORING_ROADMAP Phase 2 P2-29) — StrictMode 렌더.
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { makeBridgeStub } from '../../testing/bridgeStub';
import { UNSAVED_DRAFT_MESSAGE, useUnsavedDraftGuard } from '../useUnsavedDraftGuard';

afterEach(() => {
  cleanup(); // 앞 테스트에서 마운트된 훅의 beforeunload 리스너가 남지 않게
  delete window.electron;
  vi.restoreAllMocks();
});

const render = () => renderHook(() => useUnsavedDraftGuard(), { wrapper: StrictMode });

describe('useUnsavedDraftGuard', () => {
  it('편집 진입 → 그 환자가 dirty, 다른 환자의 낡은 종료 신호는 무시, 같은 환자 종료면 해제', () => {
    const { result } = render();
    expect(result.current.dirtyAssessmentPatientId).toBeNull();
    act(() => result.current.handleAssessmentEditingChange('p1', true));
    expect(result.current.dirtyAssessmentPatientId).toBe('p1');
    act(() => result.current.handleAssessmentEditingChange('p0', false));
    expect(result.current.dirtyAssessmentPatientId).toBe('p1');
    act(() => result.current.handleAssessmentEditingChange('p1', false));
    expect(result.current.dirtyAssessmentPatientId).toBeNull();
  });

  it('blockIfDraftDirty: 초안 없으면 false(안내 없음), 있으면 안내하고 true', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { result } = render();
    expect(result.current.blockIfDraftDirty()).toBe(false);
    expect(alertSpy).not.toHaveBeenCalled();
    act(() => result.current.handleAssessmentEditingChange('p1', true));
    let blocked;
    act(() => { blocked = result.current.blockIfDraftDirty(); });
    expect(blocked).toBe(true);
    expect(alertSpy).toHaveBeenCalledWith(UNSAVED_DRAFT_MESSAGE);
  });

  it('인트라넷 셸: setHasUnsavedDraft로 boolean만 알리고(PHI 없음) beforeunload는 등록하지 않는다', () => {
    const bridge = makeBridgeStub('intranet');
    window.electron = bridge;
    const add = vi.spyOn(window, 'addEventListener');
    const { result } = render();
    act(() => result.current.handleAssessmentEditingChange('p1', true));
    expect(bridge.__callsOf('setHasUnsavedDraft').at(-1)).toEqual([true]);
    expect(bridge.__callsOf('setHasUnsavedDraft').flat().every((v) => typeof v === 'boolean')).toBe(true);
    expect(add.mock.calls.filter(([t]) => t === 'beforeunload')).toEqual([]);
  });

  it('웹·독립형: 초안이 있을 때만 beforeunload가 닫기를 막는다, 언마운트하면 해제', () => {
    window.electron = makeBridgeStub('standalone');
    const { result, unmount } = render();
    const fire = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire()).toBe(false);
    act(() => result.current.handleAssessmentEditingChange('p1', true));
    expect(fire()).toBe(true);
    unmount();
    expect(fire()).toBe(false);
  });

  it('blockedByUnsavedDraftAlert·handleAssessmentEditingChange는 안정된 참조', () => {
    const { result, rerender } = render();
    const first = result.current;
    rerender();
    expect(result.current.blockedByUnsavedDraftAlert).toBe(first.blockedByUnsavedDraftAlert);
    expect(result.current.handleAssessmentEditingChange).toBe(first.handleAssessmentEditingChange);
  });
});
