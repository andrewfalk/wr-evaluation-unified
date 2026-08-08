// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useIntakeWizard } from '../useIntakeWizard.js';

function setup({ hasUnsavedAssessmentDraft = false } = {}) {
  const setPatients = vi.fn();
  const setActiveId = vi.fn();
  const setCurrentStepIndex = vi.fn();
  const setShowHome = vi.fn();
  const onBlockedByUnsavedDraft = vi.fn();
  const utils = renderHook(() => useIntakeWizard({
    settings: {}, session: {}, setPatients, setActiveId, setCurrentStepIndex, setShowHome,
    hasUnsavedAssessmentDraft, onBlockedByUnsavedDraft,
  }));
  return { ...utils, setShowHome, onBlockedByUnsavedDraft };
}

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('useIntakeWizard — dirty 시 신규 접수 시작 차단', () => {
  it('dirty면 handleStartIntake가 intakeShared를 세팅하지 않고 onBlockedByUnsavedDraft만 호출한다', () => {
    const { result, setShowHome, onBlockedByUnsavedDraft } = setup({ hasUnsavedAssessmentDraft: true });
    act(() => result.current.handleStartIntake());
    expect(result.current.intakeShared).toBeNull();
    expect(setShowHome).not.toHaveBeenCalled();
    expect(onBlockedByUnsavedDraft).toHaveBeenCalledTimes(1);
  });

  it('dirty가 아니면 정상적으로 intakeShared가 세팅된다', () => {
    const { result, setShowHome } = setup({ hasUnsavedAssessmentDraft: false });
    act(() => result.current.handleStartIntake());
    expect(result.current.intakeShared).not.toBeNull();
    expect(setShowHome).toHaveBeenCalledWith(false);
  });
});
