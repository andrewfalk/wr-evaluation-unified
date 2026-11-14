// @vitest-environment jsdom
//
// useConflictResolution — 충돌 해결 뒤 활성 환자 폴백(REFACTORING_ROADMAP Phase 2 P2-35, 게이트 A 계획).
// 해결로 활성 환자가 목록에서 사라지면 남은 첫 환자를 고른다 — 옮기기 전 updater 안의 queueMicrotask 예약을
// `onReduced`로 격리한 뒤에도 같은지, 진짜 상태(환자 상태 컨테이너 + activeId useState)·StrictMode로 확인한다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useConflictResolution } from '../useConflictResolution.js';
import { usePatientsContainer } from '../../state/patientStore/usePatientsContainer';

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
  showConfirm: vi.fn(async () => true),
}));

afterEach(cleanup);

function patient(id, conflictKind) {
  return {
    id,
    data: { shared: { name: id }, modules: {}, activeModules: [] },
    sync: conflictKind
      ? { serverId: `s-${id}`, revision: 2, syncStatus: 'conflict', conflict: { kind: conflictKind, serverRevision: null } }
      : { serverId: `s-${id}`, revision: 1, syncStatus: 'synced' },
  };
}

function renderResolver(initialPatients, initialActiveId) {
  const setCurrentStepIndex = vi.fn();
  const setConflictPatientId = vi.fn();
  const utils = renderHook(() => {
    const { patients, setPatients } = usePatientsContainer(initialPatients);
    const [activeId, setActiveId] = useState(initialActiveId);
    const resolver = useConflictResolution({
      setPatients, activeId, setActiveId, setCurrentStepIndex,
      session: {}, settings: {}, setConflictPatientId, syncNow: vi.fn(),
    });
    return { patients, activeId, ...resolver };
  }, { wrapper: StrictMode });
  return { ...utils, setCurrentStepIndex, setConflictPatientId };
}

async function flushMicrotasks() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('useConflictResolution — 해결 뒤 활성 환자', () => {
  it('활성 환자가 해결로 사라지면(원격 삭제를 서버 쪽으로) 남은 첫 환자를 고르고 스텝을 0으로', async () => {
    const { result, setCurrentStepIndex, setConflictPatientId } = renderResolver([patient('a', 'remote-delete'), patient('b')], 'a');
    act(() => { result.current.applyResolvedConflict('a', 'use-server', { serverPatient: null }); });
    await flushMicrotasks();
    expect(result.current.patients.map(p => p.id)).toEqual(['b']);
    expect(result.current.activeId).toBe('b');
    expect(setCurrentStepIndex).toHaveBeenCalledWith(0);
    expect(setConflictPatientId).toHaveBeenCalledWith(null);
  });

  it('유일한 활성 환자가 사라지면 활성 환자는 null', async () => {
    const { result } = renderResolver([patient('a', 'delete')], 'a');
    act(() => { result.current.applyResolvedConflict('a', 'use-local', {}); });
    await flushMicrotasks();
    expect(result.current.patients).toEqual([]);
    expect(result.current.activeId).toBeNull();
  });

  it('비활성 환자가 사라지면 활성 환자·스텝은 그대로', async () => {
    const { result, setCurrentStepIndex } = renderResolver([patient('a'), patient('b', 'delete')], 'a');
    act(() => { result.current.applyResolvedConflict('b', 'use-local', {}); });
    await flushMicrotasks();
    expect(result.current.patients.map(p => p.id)).toEqual(['a']);
    expect(result.current.activeId).toBe('a');
    expect(setCurrentStepIndex).not.toHaveBeenCalled();
  });

  it('원격 삭제를 로컬로 살리면(새 id) 옛 id가 사라져 목록 첫 환자(살린 환자)가 활성', async () => {
    const { result } = renderResolver([patient('a', 'remote-delete'), patient('b')], 'a');
    act(() => { result.current.applyResolvedConflict('a', 'use-local', { newId: 'a-new' }); });
    await flushMicrotasks();
    expect(result.current.patients.map(p => p.id)).toEqual(['a-new', 'b']);
    expect(result.current.activeId).toBe('a-new');
    expect(result.current.patients[0].sync.syncStatus).toBe('local-only');
  });

  it('원격 삭제 표시(markRemoteDeleteConflict)는 그 환자만 conflict로, 활성 환자는 그대로', async () => {
    const { result } = renderResolver([patient('a'), patient('b')], 'a');
    act(() => { result.current.markRemoteDeleteConflict('b'); });
    await flushMicrotasks();
    expect(result.current.patients[1].sync).toMatchObject({ syncStatus: 'conflict', conflict: { kind: 'remote-delete', serverRevision: null } });
    expect(result.current.patients[0].sync.syncStatus).toBe('synced');
    expect(result.current.activeId).toBe('a');
  });
});
