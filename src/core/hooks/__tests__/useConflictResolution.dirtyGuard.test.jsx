// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useConflictResolution } from '../useConflictResolution.js';

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
  showConfirm: vi.fn(async () => true),
}));

vi.mock('../../services/patientServerRepository', () => ({
  correctPatientIdentity: vi.fn(),
  deletePatientOnServer: vi.fn(),
}));

vi.mock('../../services/lockTokenStore', () => ({
  getLockToken: vi.fn(() => null),
}));

import { correctPatientIdentity, deletePatientOnServer } from '../../services/patientServerRepository';

function setup({ dirtyAssessmentPatientId } = {}) {
  const setPatients = vi.fn();
  const setConflictPatientId = vi.fn();
  const onBlockedByUnsavedDraft = vi.fn();
  const utils = renderHook(() => useConflictResolution({
    setPatients, activeId: 'p1', setActiveId: vi.fn(), setCurrentStepIndex: vi.fn(),
    session: {}, settings: {}, setConflictPatientId, syncNow: vi.fn(),
    dirtyAssessmentPatientId, onBlockedByUnsavedDraft,
  }));
  return { ...utils, setPatients, setConflictPatientId, onBlockedByUnsavedDraft };
}

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('useConflictResolution — 편집 중인 환자의 충돌 해결/정정 차단', () => {
  it('applyResolvedConflict: 대상 환자가 dirty면 setPatients를 호출하지 않는다', () => {
    const { result, setPatients, onBlockedByUnsavedDraft } = setup({ dirtyAssessmentPatientId: 'conflicted-1' });
    result.current.applyResolvedConflict('conflicted-1', 'use-server', {});
    expect(setPatients).not.toHaveBeenCalled();
    expect(onBlockedByUnsavedDraft).toHaveBeenCalledTimes(1);
  });

  it('applyResolvedConflict: 다른 환자가 dirty면 차단하지 않는다', () => {
    const { result, setPatients } = setup({ dirtyAssessmentPatientId: 'someone-else' });
    result.current.applyResolvedConflict('conflicted-1', 'use-server', {});
    expect(setPatients).toHaveBeenCalled();
  });

  it('handleCorrectServerIdentity: 대상 환자가 dirty면 API를 호출하지 않는다', async () => {
    const { result, onBlockedByUnsavedDraft } = setup({ dirtyAssessmentPatientId: 'conflicted-1' });
    await result.current.handleCorrectServerIdentity({ patient: { id: 'conflicted-1' }, birthDate: '2000-01-01', reasonCode: 'x' });
    expect(correctPatientIdentity).not.toHaveBeenCalled();
    expect(onBlockedByUnsavedDraft).toHaveBeenCalledTimes(1);
  });

  it('handleResolveConflict(use-local+delete): 대상 환자가 dirty면 서버 삭제를 시도하지 않는다', async () => {
    const { result, onBlockedByUnsavedDraft } = setup({ dirtyAssessmentPatientId: 'conflicted-1' });
    const patient = { id: 'conflicted-1', sync: { serverId: 's1', revision: 1, conflict: { kind: 'delete' } } };
    await result.current.handleResolveConflict('use-local', { patient });
    expect(deletePatientOnServer).not.toHaveBeenCalled();
    expect(onBlockedByUnsavedDraft).toHaveBeenCalledTimes(1);
  });
});
