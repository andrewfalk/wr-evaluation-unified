// @vitest-environment jsdom
//
// 종합소견 편집 dirty 상태에서 스텝 이동·환자 전환이 AssessmentStep을 언마운트해 draft를
// 잃지 않도록 useStepNavigation이 막는지 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useStepNavigation } from '../useStepNavigation.js';

const steps = [{ id: 'info' }, { id: 'assessment' }, { id: 'ai' }];

function setup({ hasUnsavedAssessmentDraft = false } = {}) {
  const setActiveId = vi.fn();
  const setShowSidebar = vi.fn();
  const onBlockedByUnsavedDraft = vi.fn();
  const utils = renderHook(() => useStepNavigation({
    steps, activeId: 'p1', setActiveId, setShowSidebar, hasUnsavedAssessmentDraft, onBlockedByUnsavedDraft,
  }));
  return { ...utils, setActiveId, setShowSidebar, onBlockedByUnsavedDraft };
}

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('useStepNavigation — dirty 시 스텝 이동 차단', () => {
  it('dirty가 아니면 goToStep이 정상 진행된다', () => {
    const { result } = setup({ hasUnsavedAssessmentDraft: false });
    act(() => result.current.goToStep(1));
    expect(result.current.currentStepIndex).toBe(1);
  });

  it('dirty면 goToStep이 막히고 onBlockedByUnsavedDraft가 호출된다', () => {
    const { result, onBlockedByUnsavedDraft } = setup({ hasUnsavedAssessmentDraft: true });
    act(() => result.current.goToStep(2));
    expect(result.current.currentStepIndex).toBe(0);
    expect(onBlockedByUnsavedDraft).toHaveBeenCalledTimes(1);
  });

  it('dirty면 goNext/goPrev도 막힌다(중간 스텝 기준 — index 0에서 goPrev는 범위 밖이라 별도로 확인)', () => {
    const setActiveId = vi.fn();
    const setShowSidebar = vi.fn();
    const onBlockedByUnsavedDraft = vi.fn();
    const { result, rerender } = renderHook(
      ({ hasUnsavedAssessmentDraft }) => useStepNavigation({
        steps, activeId: 'p1', setActiveId, setShowSidebar, hasUnsavedAssessmentDraft, onBlockedByUnsavedDraft,
      }),
      { initialProps: { hasUnsavedAssessmentDraft: false } }
    );
    act(() => result.current.goToStep(1)); // dirty 없이 중간 스텝으로 먼저 이동
    expect(result.current.currentStepIndex).toBe(1);

    rerender({ hasUnsavedAssessmentDraft: true });
    act(() => result.current.goNext());
    act(() => result.current.goPrev());

    expect(result.current.currentStepIndex).toBe(1);
    expect(onBlockedByUnsavedDraft).toHaveBeenCalledTimes(2);
  });

  it('같은 인덱스로의 이동은 dirty여도 조용히 무시한다(경고 없음)', () => {
    const { result, onBlockedByUnsavedDraft } = setup({ hasUnsavedAssessmentDraft: true });
    act(() => result.current.goToStep(0));
    expect(onBlockedByUnsavedDraft).not.toHaveBeenCalled();
  });
});

describe('useStepNavigation — dirty 시 환자 전환 차단', () => {
  it('dirty면 다른 환자로의 switchPatient가 막힌다', () => {
    const { result, setActiveId, onBlockedByUnsavedDraft } = setup({ hasUnsavedAssessmentDraft: true });
    act(() => result.current.switchPatient('p2'));
    expect(setActiveId).not.toHaveBeenCalled();
    expect(onBlockedByUnsavedDraft).toHaveBeenCalledTimes(1);
  });

  it('dirty여도 같은 환자로의 switchPatient(activeId와 동일)는 허용한다', () => {
    const { result, setActiveId, onBlockedByUnsavedDraft } = setup({ hasUnsavedAssessmentDraft: true });
    act(() => result.current.switchPatient('p1'));
    expect(setActiveId).toHaveBeenCalledWith('p1');
    expect(onBlockedByUnsavedDraft).not.toHaveBeenCalled();
  });

  it('dirty가 아니면 다른 환자로 정상 전환된다', () => {
    const { result, setActiveId } = setup({ hasUnsavedAssessmentDraft: false });
    act(() => result.current.switchPatient('p2'));
    expect(setActiveId).toHaveBeenCalledWith('p2');
  });
});
