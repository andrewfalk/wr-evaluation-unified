// @vitest-environment jsdom
//
// 저장된 워크스페이스 스냅샷 불러오기(handleLoad)는 환자 목록·활성 환자를 통째로 갈아치운다 —
// 종합소견을 편집 중이면 draft가 어느 환자 기준으로 남을지 불명확해지므로 먼저 막는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useWorkspacePersistence } from '../useWorkspacePersistence.js';

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
  showConfirm: vi.fn(async () => true),
}));

vi.mock('../../services/workspaceRepository', () => ({
  clearAutoSavedWorkspace: vi.fn(async () => {}),
  deleteWorkspaceSnapshot: vi.fn(),
  hasDuplicateWorkspaceName: vi.fn(() => false),
  loadAutoSavedWorkspace: vi.fn(async () => null),
  loadSavedWorkspaces: vi.fn(async () => []),
  migrateWorkspaceStorage: vi.fn(),
  saveAutoSavedWorkspace: vi.fn(),
  saveWorkspaceSnapshot: vi.fn(),
}));

function setup({ dirtyAssessmentPatientId } = {}) {
  const setPatients = vi.fn();
  const setActiveId = vi.fn();
  const onBlockedByUnsavedDraft = vi.fn();
  const utils = renderHook(() => useWorkspacePersistence({
    patients: [], setPatients,
    session: { mode: 'local' }, settings: {}, serverConfig: {},
    setActiveId, setCurrentStepIndex: vi.fn(), setIntakeShared: vi.fn(), setShowHome: vi.fn(),
    setShowSaveModal: vi.fn(), setShowLoadModal: vi.fn(),
    disabled: true, // 자동 로드/자동 저장 effect를 꺼서 handleLoad 자체만 관찰
    dirtyAssessmentPatientId, onBlockedByUnsavedDraft,
  }));
  return { ...utils, setPatients, setActiveId, onBlockedByUnsavedDraft };
}

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('useWorkspacePersistence — dirty 시 불러오기 차단', () => {
  it('dirty면 handleLoad가 환자 목록을 갈아치우지 않는다(overwrite 모드)', async () => {
    const { result, setPatients, onBlockedByUnsavedDraft } = setup({ dirtyAssessmentPatientId: 'p1' });
    await result.current.handleLoad({ id: 'w1', patients: [{ id: 'x', data: { shared: {}, activeModules: [] } }] }, 'overwrite');
    expect(setPatients).not.toHaveBeenCalled();
    expect(onBlockedByUnsavedDraft).toHaveBeenCalledTimes(1);
  });

  it('dirty면 merge 모드도 차단한다', async () => {
    const { result, setPatients } = setup({ dirtyAssessmentPatientId: 'p1' });
    await result.current.handleLoad({ id: 'w1', patients: [{ id: 'x', data: { shared: {}, activeModules: [] } }] }, 'merge');
    expect(setPatients).not.toHaveBeenCalled();
  });

  it('dirty가 아니면 정상적으로 불러온다', async () => {
    const { result, setPatients } = setup({ dirtyAssessmentPatientId: null });
    await result.current.handleLoad({ id: 'w1', patients: [{ id: 'x', data: { shared: {}, activeModules: [] } }] }, 'overwrite');
    expect(setPatients).toHaveBeenCalled();
  });
});
