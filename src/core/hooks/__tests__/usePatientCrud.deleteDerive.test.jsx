// @vitest-environment jsdom
//
// P2-40d(정의 변경) — 삭제 뒤처리(활성 환자 폴백·위자드 초안 비우기)를 "삭제 전이가 적용되는 순간의 목록"으로 정한다(REFACTORING_ROADMAP
// Phase 2, 게이트 B 계획 B5·"동작이 바뀌는 PR" ②). 옮기기 전에는 일괄 삭제가 초안을 비우지 않았다(resetIntakeWhenEmpty는 단일
// 삭제만) — 일괄 삭제를 기다리는 동안 다른 경로(pull 등)가 나머지 환자를 지워 결과 목록이 비면 초안이 남았다. 이제는 단일·일괄
// 모두 "삭제 결과로 목록이 비면 초안을 비운다". 진짜 상태(환자 상태 컨테이너 + usePatientCrud), StrictMode.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { usePatientCrud } from '../usePatientCrud.js';
import { usePatientsContainer } from '../../state/patientStore/usePatientsContainer';
import { patientTx } from '../../state/patientStore/transitions';

vi.mock('../../services/patientServerRepository', async () => {
  const actual = await vi.importActual('../../services/patientServerRepository');
  return { ...actual, deletePatientOnServer: vi.fn() };
});
vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
  showConfirm: vi.fn(async () => true),
}));

import { deletePatientOnServer } from '../../services/patientServerRepository';

const SESSION = { mode: 'intranet', user: { id: 'doc-me', role: 'doctor' } };

function patient(id) {
  return {
    id,
    assignedDoctorUserId: 'doc-me',
    data: { shared: { name: id }, modules: {}, activeModules: [] },
    sync: { serverId: `s-${id}`, revision: 1, syncStatus: 'synced' },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function renderCrud(initialPatients, initialActiveId) {
  const setCurrentStepIndex = vi.fn();
  const utils = renderHook(() => {
    const store = usePatientsContainer(initialPatients, { initialActiveId });
    const [intakeShared, setIntakeShared] = useState({ draft: true });
    const crud = usePatientCrud({
      activeId: store.activeId, activeModuleId: null, session: SESSION, settings: {},
      patients: store.patients, setPatients: store.setPatients,
      selectedIds: store.selectedIds, setSelectedIds: store.setSelectedIds,
      setErrors: () => {}, setActiveId: store.setActiveId, setCurrentStepIndex,
      setIntakeShared, setShowHome: () => {}, handleStartIntake: () => {},
      canMutateActivePatient: true,
    });
    return { ...store, intakeShared, crud };
  }, { wrapper: StrictMode });
  return { ...utils, setCurrentStepIndex };
}

async function flush(n = 8) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('P2-40d — 삭제 뒤처리는 삭제 전이가 적용되는 순간의 목록으로', () => {
  it('일괄 삭제를 기다리는 동안 나머지 환자가 다른 경로로 지워져 결과 목록이 비면 초안을 비우고 활성 환자는 null·스텝 0', async () => {
    const pending = deferred();
    deletePatientOnServer.mockReturnValue(pending.promise);
    const { result, setCurrentStepIndex } = renderCrud([patient('a'), patient('b'), patient('c')], 'a');
    act(() => { result.current.setSelectedIds(new Set(['b', 'c'])); });

    let removing;
    await act(async () => { removing = result.current.crud.removeSelectedPatients(); await flush(); });
    // 대기 중: 다른 경로(pull 등)가 a를 지운다 — 목록에는 삭제 중인 b·c만 남는다.
    act(() => { result.current.setPatients(patientTx.replacedAll({ patients: [patient('b'), patient('c')] })); });
    await act(async () => { pending.resolve(); await removing; await flush(); });

    expect(result.current.patients).toEqual([]);
    expect(result.current.activeId).toBeNull();
    expect(result.current.intakeShared).toBeNull();
    expect(setCurrentStepIndex).toHaveBeenCalledWith(0);
  });

  it('비활성 환자 삭제는 활성 환자·스텝·초안을 그대로 둔다', async () => {
    deletePatientOnServer.mockResolvedValue(undefined);
    const { result, setCurrentStepIndex } = renderCrud([patient('a'), patient('b')], 'a');
    await act(async () => { await result.current.crud.removePatient('b'); await flush(); });

    expect(result.current.patients.map(p => p.id)).toEqual(['a']);
    expect(result.current.activeId).toBe('a');
    expect(setCurrentStepIndex).not.toHaveBeenCalled();
    expect(result.current.intakeShared).toEqual({ draft: true });
  });
});
