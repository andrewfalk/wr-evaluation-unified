// @vitest-environment jsdom
//
// usePatientCrud의 canMutateActivePatient 가드(락 미보유/권한 없음 → silent guard) 및
// 삭제 호출부의 leaseToken 배선을 검증한다. App.jsx가 canEditPatient와 lockState를 이미
// 합성해 canMutateActivePatient 하나로 넘기므로, 이 훅 레벨에서는 그 결과값만 신뢰하면
// 된다는 전제를 확인한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { usePatientCrud } from '../usePatientCrud.js';

vi.mock('../../services/patientServerRepository', () => ({
  deletePatientOnServer: vi.fn(),
  isConflictError: (err) => err?.status === 409,
}));

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
  showConfirm: vi.fn(async () => true),
}));

import { deletePatientOnServer } from '../../services/patientServerRepository';
import { setLockToken, clearAllLockTokens } from '../../services/lockTokenStore';

const SESSION = { mode: 'intranet', user: { id: 'doc-me', role: 'doctor' } };

function patient(overrides = {}) {
  return {
    id: 'p1',
    assignedDoctorUserId: 'doc-me',
    data: { shared: {}, modules: {}, activeModules: [] },
    sync: { serverId: 's1', revision: 3, syncStatus: 'synced' },
    ...overrides,
  };
}

// canMutateActivePatient를 renderHook props로 넘긴다 — 훅 본문에서 지역값으로 캡처하면
// rerender()를 호출해도 값이 안 바뀌어 락 전이(취득/상실)를 재현할 수 없다.
function setup({ canMutateActivePatient = true, patients = [patient()], selectedIds = new Set(), dirtyAssessmentPatientId, onBlockedByUnsavedDraft = vi.fn() } = {}) {
  const setPatients = vi.fn();
  const { result, rerender } = renderHook(props => usePatientCrud({
    activeId: 'p1', activeModuleId: null, session: SESSION, settings: {},
    patients, setPatients,
    selectedIds, setSelectedIds: vi.fn(),
    errors: {}, setErrors: vi.fn(),
    setActiveId: vi.fn(), setCurrentStepIndex: vi.fn(),
    setIntakeShared: vi.fn(), setShowHome: vi.fn(),
    handleStartIntake: vi.fn(),
    canMutateActivePatient: props.canMutateActivePatient,
    dirtyAssessmentPatientId,
    onBlockedByUnsavedDraft,
  }), { initialProps: { canMutateActivePatient } });
  return { result, rerender, setPatients, onBlockedByUnsavedDraft };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAllLockTokens();
});

afterEach(() => {
  cleanup();
});

describe('usePatientCrud — canMutateActivePatient guard', () => {
  it('blocks updatePatient when canMutateActivePatient is false (e.g. held-by-other)', () => {
    const { result, setPatients } = setup({ canMutateActivePatient: false });

    result.current.updatePatient(d => ({ ...d, shared: { ...d.shared, name: 'x' } }));

    expect(setPatients).not.toHaveBeenCalled();
  });

  it('allows updatePatient when canMutateActivePatient is true', () => {
    const { result, setPatients } = setup({ canMutateActivePatient: true });

    result.current.updatePatient(d => ({ ...d, shared: { ...d.shared, name: 'x' } }));

    expect(setPatients).toHaveBeenCalledTimes(1);
  });
});

// 락 취득/상실은 비동기다(usePatientLock의 acquire/renew). 환자를 여는 렌더에서는 아직
// 'none'/'acquiring'이라 canMutateActivePatient가 false이고, 그 뒤 'held'로 바뀐다.
// updateModuleById·updateActiveModules는 useCallback([activeId, session])로 메모이즈돼
// 그 시점의 updatePatient를 붙잡으므로, 가드가 캡처값을 읽으면 전이 이후에도 옛 판정이 굳는다.
describe('usePatientCrud — 락 상태 전이 후에도 가드가 최신값을 읽는다', () => {
  it('false → true: 락 취득이 끝나면 updateModuleById가 반영된다', () => {
    const { result, rerender, setPatients } = setup({ canMutateActivePatient: false });

    rerender({ canMutateActivePatient: true });
    result.current.updateModuleById('knee', cur => ({ ...cur, returnConsiderations: 'x' }));

    expect(setPatients).toHaveBeenCalledTimes(1);
  });

  it('false → true: 락 취득이 끝나면 updateActiveModules가 반영된다', () => {
    const { result, rerender, setPatients } = setup({ canMutateActivePatient: false });

    rerender({ canMutateActivePatient: true });
    result.current.updateActiveModules(['knee']);

    expect(setPatients).toHaveBeenCalledTimes(1);
  });

  // 입력 불가보다 이쪽이 심각하다 — 락 없이 수정이 새어나간다.
  it('true → false: 락을 잃으면 updateModuleById가 차단된다', () => {
    const { result, rerender, setPatients } = setup({ canMutateActivePatient: true });

    rerender({ canMutateActivePatient: false });
    result.current.updateModuleById('knee', cur => ({ ...cur, returnConsiderations: 'x' }));

    expect(setPatients).not.toHaveBeenCalled();
  });

  it('true → false: 락을 잃으면 updateActiveModules가 차단된다', () => {
    const { result, rerender, setPatients } = setup({ canMutateActivePatient: true });

    rerender({ canMutateActivePatient: false });
    result.current.updateActiveModules(['knee']);

    expect(setPatients).not.toHaveBeenCalled();
  });

  // 가드를 ref로 옮기는 대신 useCallback을 걷어내면 identity가 매 렌더 바뀌어
  // PR#77(경추/팔꿈치/손목 저장 무한루프)이 되살아날 수 있다.
  it('전이 전후로 콜백 identity가 유지된다', () => {
    const { result, rerender } = setup({ canMutateActivePatient: false });
    const beforeModule = result.current.updateModuleById;
    const beforeActive = result.current.updateActiveModules;

    rerender({ canMutateActivePatient: true });

    expect(result.current.updateModuleById).toBe(beforeModule);
    expect(result.current.updateActiveModules).toBe(beforeActive);
  });
});

describe('usePatientCrud — updateShared 함수형 업데이터 (stale write 방지)', () => {
  it('객체를 넘기면 기존 동작대로 shared를 통째 교체한다', () => {
    const initial = patient({ data: { shared: { name: 'old' }, modules: {}, activeModules: [] } });
    const { result, setPatients } = setup({ patients: [initial] });

    result.current.updateShared({ name: 'new' });

    const updater = setPatients.mock.calls[0][0];
    const next = updater([initial]);
    expect(next[0].data.shared).toEqual({ name: 'new' });
  });

  it('함수형 업데이터는 setPatients 반영 시점의 최신 shared를 기준으로 병합된다(stale 스냅샷 덮어쓰기 방지)', () => {
    const initial = patient({ data: { shared: { name: 'stale', diagnoses: ['stale-diag'] }, modules: {}, activeModules: [] } });
    const { result, setPatients } = setup({ patients: [initial] });

    result.current.updateShared(prevShared => ({ ...prevShared, name: 'edited' }));

    const updater = setPatients.mock.calls[0][0];
    // setPatients가 실제로 반영되는 시점에는 diagnoses가 다른 경로로 이미 바뀌어 있을 수
    // 있다 — 함수형 업데이터는 호출 당시 캡처값이 아니라 이 최신 prev를 기준으로 병합돼야 한다.
    const latestPrev = [patient({ data: { shared: { name: 'stale', diagnoses: ['fresh-diag'] }, modules: {}, activeModules: [] } })];
    const next = updater(latestPrev);
    expect(next[0].data.shared).toEqual({ name: 'edited', diagnoses: ['fresh-diag'] });
  });
});

describe('usePatientCrud — 종합소견 편집 dirty 가드', () => {
  it('removePatient: 삭제 대상이 dirty 환자면 삭제하지 않는다', async () => {
    const { result, setPatients, onBlockedByUnsavedDraft } = setup({ dirtyAssessmentPatientId: 'p1' });
    await result.current.removePatient('p1');
    expect(setPatients).not.toHaveBeenCalled();
    expect(onBlockedByUnsavedDraft).toHaveBeenCalledTimes(1);
  });

  it('removePatient: dirty가 다른 환자를 가리키면 정상 삭제된다', async () => {
    deletePatientOnServer.mockResolvedValue(undefined);
    const { result, setPatients } = setup({ dirtyAssessmentPatientId: 'other', patients: [patient()] });
    await result.current.removePatient('p1');
    expect(setPatients).toHaveBeenCalled();
  });

  it('removeSelectedPatients: 선택 집합에 dirty 환자가 포함되면 차단한다', async () => {
    const { result, setPatients, onBlockedByUnsavedDraft } = setup({
      dirtyAssessmentPatientId: 'p1',
      patients: [patient(), patient({ id: 'p2' })],
      selectedIds: new Set(['p1', 'p2']),
    });
    await result.current.removeSelectedPatients();
    expect(setPatients).not.toHaveBeenCalled();
    expect(onBlockedByUnsavedDraft).toHaveBeenCalledTimes(1);
  });

  it('handleBatchImport: dirty면 목록을 갈아치우지 않는다', () => {
    const { result, setPatients, onBlockedByUnsavedDraft } = setup({ dirtyAssessmentPatientId: 'p1' });
    result.current.handleBatchImport([], { newPatients: 0, newDiagnoses: 0, newJobs: 0, skipped: 0, updatedAssessments: 0, withDoctorName: 0 });
    expect(setPatients).not.toHaveBeenCalled();
    expect(onBlockedByUnsavedDraft).toHaveBeenCalledTimes(1);
  });

  it('handleLoadTestData: dirty면 목록을 갈아치우지 않는다', async () => {
    const { result, setPatients, onBlockedByUnsavedDraft } = setup({ dirtyAssessmentPatientId: 'p1' });
    await result.current.handleLoadTestData();
    expect(setPatients).not.toHaveBeenCalled();
    expect(onBlockedByUnsavedDraft).toHaveBeenCalledTimes(1);
  });
});

describe('usePatientCrud — delete wiring reads the stored lease token', () => {
  it('passes the stored lease token as leaseToken to deletePatientOnServer', async () => {
    setLockToken('p1', 'lease-xyz');
    deletePatientOnServer.mockResolvedValue(undefined);
    const { result } = setup({ patients: [patient()] });

    await result.current.removePatient('p1');

    expect(deletePatientOnServer).toHaveBeenCalledWith('s1', 3, expect.objectContaining({ leaseToken: 'lease-xyz' }));
  });

  it('passes leaseToken: null when nothing is stored (opt-in — server still allows if unlocked)', async () => {
    deletePatientOnServer.mockResolvedValue(undefined);
    const { result } = setup({ patients: [patient()] });

    await result.current.removePatient('p1');

    expect(deletePatientOnServer).toHaveBeenCalledWith('s1', 3, expect.objectContaining({ leaseToken: null }));
  });
});
