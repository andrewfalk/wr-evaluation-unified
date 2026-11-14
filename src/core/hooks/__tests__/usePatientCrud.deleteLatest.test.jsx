// @vitest-environment jsdom
//
// P2-39a(flagged) — 환자 삭제 결과를 "삭제를 기다리는 동안 바뀐 최신 목록"에 적용한다(REFACTORING_ROADMAP Phase 2,
// 게이트 A 계획 "flagged 수정 설계 ①"). 옮기기 전에는 서버 삭제 `await` 뒤 삭제 시작 시점의 목록(클로저)으로 통째 교체해,
// 그사이 들어온 편집·push 결과·pull·추가가 사라지고, 시작 목록 기준으로 활성 환자를 골라 사용자의 선택을 덮거나 목록에 없는
// 환자를 활성화했다. 진짜 상태(환자 상태 컨테이너 + usePatientCrud), StrictMode.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useLayoutEffect, useState } from 'react';
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

function patient(id, extra = {}) {
  return {
    id,
    assignedDoctorUserId: 'doc-me',
    data: { shared: { name: id }, modules: {}, activeModules: [] },
    sync: { serverId: `s-${id}`, revision: 1, syncStatus: 'synced' },
    ...extra,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function renderCrud(initialPatients, initialActiveId, { initialIntake = { draft: true } } = {}) {
  const setCurrentStepIndex = vi.fn();
  const utils = renderHook(() => {
    const store = usePatientsContainer(initialPatients, { initialActiveId });
    const [intakeShared, setIntakeShared] = useState(initialIntake);
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

const ids = (result) => result.current.patients.map(p => p.id);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('P2-39a — 삭제 결과를 최신 목록에 적용', () => {
  it('① 삭제 대기 중 다른 환자에 들어온 편집이 삭제 뒤에도 남는다', async () => {
    const pending = deferred();
    deletePatientOnServer.mockReturnValue(pending.promise);
    const { result } = renderCrud([patient('a'), patient('b')], 'a');

    let removing;
    await act(async () => { removing = result.current.crud.removePatient('a'); await flush(); });
    expect(deletePatientOnServer).toHaveBeenCalledTimes(1);
    // 대기 중: b의 이름이 바뀌고(편집·push ack 등) 동기화 상태가 바뀐다.
    act(() => {
      result.current.setPatients(patientTx.replacedFromServer({
        id: 'b', keepLocalMeta: true,
        serverPatient: { ...patient('b'), data: { shared: { name: 'b-edited' }, modules: {}, activeModules: [] }, sync: { serverId: 's-b', revision: 2, syncStatus: 'synced' } },
      }));
    });
    await act(async () => { pending.resolve(); await removing; await flush(); });

    expect(ids(result)).toEqual(['b']);
    expect(result.current.patients[0].data.shared.name).toBe('b-edited');
    expect(result.current.patients[0].sync.revision).toBe(2);
  });

  it('② 시작 목록 [A,B] → 대기 중 [A,C]로 바뀐 뒤 A 삭제 → 목록 [C]·활성 C(목록에 없는 B가 되지 않음)', async () => {
    const pending = deferred();
    deletePatientOnServer.mockReturnValue(pending.promise);
    const { result, setCurrentStepIndex } = renderCrud([patient('a'), patient('b')], 'a');

    let removing;
    await act(async () => { removing = result.current.crud.removePatient('a'); await flush(); });
    act(() => { result.current.setPatients(patientTx.replacedAll({ patients: [result.current.patients[0], patient('c')] })); });
    await act(async () => { pending.resolve(); await removing; await flush(); });

    expect(ids(result)).toEqual(['c']);
    expect(result.current.activeId).toBe('c');
    expect(setCurrentStepIndex).toHaveBeenCalledWith(0);
  });

  it('③ 대기 중 사용자가 다른 환자로 전환했으면 그 선택을 유지한다', async () => {
    const pending = deferred();
    deletePatientOnServer.mockReturnValue(pending.promise);
    const { result } = renderCrud([patient('a'), patient('b'), patient('c')], 'a');

    let removing;
    await act(async () => { removing = result.current.crud.removePatient('a'); await flush(); });
    act(() => { result.current.setActiveId('c'); });
    await act(async () => { pending.resolve(); await removing; await flush(); });

    expect(ids(result)).toEqual(['b', 'c']);
    expect(result.current.activeId).toBe('c');
  });

  it('④ 결과 목록이 비면 위자드 초안을 비운다', async () => {
    deletePatientOnServer.mockResolvedValue(undefined);
    const { result } = renderCrud([patient('a')], 'a');
    await act(async () => { await result.current.crud.removePatient('a'); await flush(); });
    expect(result.current.patients).toEqual([]);
    expect(result.current.activeId).toBeNull();
    expect(result.current.intakeShared).toBeNull();
  });

  it('④-b 대기 중 환자가 추가됐으면 목록이 비지 않으므로 그 환자를 지우지 않고 초안도 그대로', async () => {
    const pending = deferred();
    deletePatientOnServer.mockReturnValue(pending.promise);
    const { result } = renderCrud([patient('a')], 'a');

    let removing;
    await act(async () => { removing = result.current.crud.removePatient('a'); await flush(); });
    act(() => { result.current.setPatients(patientTx.appended({ patients: [patient('n', { sync: { syncStatus: 'local-only' } })] })); });
    await act(async () => { pending.resolve(); await removing; await flush(); });

    expect(ids(result)).toEqual(['n']);
    expect(result.current.activeId).toBe('n');
    expect(result.current.intakeShared).toEqual({ draft: true });
  });

  it('⑤ 삭제 적용과 목록 전체 교체·활성 지정이 같은 배치에 들어와도 최종 활성 환자는 최종 목록 안에 있다', async () => {
    const pending = deferred();
    deletePatientOnServer.mockReturnValue(pending.promise);
    const { result } = renderCrud([patient('a'), patient('b')], 'a');

    let removing;
    await act(async () => { removing = result.current.crud.removePatient('a'); await flush(); });
    await act(async () => {
      pending.resolve();
      await flush(); // 삭제 뒤 처리(전이 + tick 예약)가 먼저 돌고
      result.current.setPatients(patientTx.replacedAll({ patients: [patient('c')] })); // 같은 배치에 목록 교체
      result.current.setActiveId('c'); // + 활성 지정
      await removing;
      await flush();
    });

    expect(ids(result)).toEqual(['c']);
    expect(result.current.activeId).toBe('c');
    expect(result.current.patients.some(p => p.id === result.current.activeId)).toBe(true);
  });

  it('⑥ 삭제 커밋 직후(뒤처리 전) 예약된 목록 교체·활성 지정을 뒤처리가 덮지 않는다(#322 Codex 차단 지적)', async () => {
    const pending = deferred();
    deletePatientOnServer.mockReturnValue(pending.promise);
    // 삭제가 반영된 커밋의 layout effect에서 목록 [C] 교체 + 활성 C를 예약하는 하니스 — passive effect의 뒤처리가
    // 캡처한 옛 목록([B,C])·활성(A)으로 판정하면 활성 B를 뒤늦게 예약해 최종 [C]·활성 B(목록에 없음)가 된다.
    const armed = { current: false };
    const setCurrentStepIndex = vi.fn();
    const { result } = renderHook(() => {
      const store = usePatientsContainer([patient('a'), patient('b'), patient('c')], { initialActiveId: 'a' });
      const [intakeShared, setIntakeShared] = useState(null);
      const crud = usePatientCrud({
        activeId: store.activeId, activeModuleId: null, session: SESSION, settings: {},
        patients: store.patients, setPatients: store.setPatients,
        selectedIds: store.selectedIds, setSelectedIds: store.setSelectedIds,
        setErrors: () => {}, setActiveId: store.setActiveId, setCurrentStepIndex,
        setIntakeShared, setShowHome: () => {}, handleStartIntake: () => {}, canMutateActivePatient: true,
      });
      useLayoutEffect(() => {
        if (armed.current && !store.patients.some(p => p.id === 'a')) {
          armed.current = false;
          store.setPatients(patientTx.replacedAll({ patients: [patient('c')] }));
          store.setActiveId('c');
        }
      });
      return { ...store, intakeShared, crud };
    }, { wrapper: StrictMode });

    let removing;
    await act(async () => { removing = result.current.crud.removePatient('a'); await flush(); });
    armed.current = true;
    await act(async () => { pending.resolve(); await removing; await flush(); });

    expect(ids(result)).toEqual(['c']);
    expect(result.current.activeId).toBe('c');
  });

  it('⑦ 단일 삭제(초안 비움 요청)와 일괄 삭제가 같은 배치에서 끝나 목록이 비면 초안을 비운다(#322 Codex 권고)', async () => {
    const single = deferred();
    const bulk = deferred();
    deletePatientOnServer.mockImplementation((serverId) => (serverId === 's-a' ? single.promise : bulk.promise));
    const { result } = renderCrud([patient('a'), patient('b'), patient('c')], 'a');
    act(() => { result.current.setSelectedIds(new Set(['b', 'c'])); });

    let removingOne;
    let removingMany;
    await act(async () => {
      removingOne = result.current.crud.removePatient('a');
      await flush();
    });
    // 일괄 삭제는 "최소 1명 유지" 검사를 지나도록 선택 2명 < 목록 3명인 상태에서 시작한다.
    await act(async () => { removingMany = result.current.crud.removeSelectedPatients(); await flush(); });
    await act(async () => {
      single.resolve();
      bulk.resolve();
      await Promise.all([removingOne, removingMany]);
      await flush(16);
    });

    expect(result.current.patients).toEqual([]);
    expect(result.current.activeId).toBeNull();
    expect(result.current.intakeShared).toBeNull();
  });

  it('삭제 충돌(409)은 최신 목록의 그 환자에 표시하고 목록·활성 환자는 그대로', async () => {
    const pending = deferred();
    deletePatientOnServer.mockReturnValue(pending.promise);
    const { result } = renderCrud([patient('a'), patient('b')], 'a');

    let removing;
    await act(async () => { removing = result.current.crud.removePatient('a'); await flush(); });
    act(() => { result.current.setPatients(patientTx.appended({ patients: [patient('c')] })); });
    const conflict = Object.assign(new Error('changed'), { status: 409, data: { code: 'CONFLICT', currentRevision: 4 } });
    await act(async () => { pending.reject(conflict); await removing; await flush(); });

    expect(ids(result)).toEqual(['a', 'b', 'c']);
    expect(result.current.patients[0].sync).toMatchObject({ syncStatus: 'conflict', conflict: { kind: 'delete', code: 'CONFLICT', serverRevision: 4 } });
    expect(result.current.activeId).toBe('a');
  });

  it('다중 선택 삭제: 대기 중 바뀐 선택(새로 체크한 환자)이 보존된다', async () => {
    const pending = deferred();
    deletePatientOnServer.mockReturnValue(pending.promise);
    const { result } = renderCrud([patient('a'), patient('b'), patient('c'), patient('d')], 'a');
    act(() => { result.current.setSelectedIds(new Set(['b', 'c'])); });

    let removing;
    await act(async () => { removing = result.current.crud.removeSelectedPatients(); await flush(); });
    act(() => { result.current.setSelectedIds(prev => new Set([...prev, 'd'])); });
    await act(async () => { pending.resolve(); await flush(); pending.resolve(); await removing; await flush(); });

    expect(ids(result)).toEqual(['a', 'd']);
    expect([...result.current.selectedIds]).toEqual(['d']);
    expect(result.current.activeId).toBe('a');
  });
});
