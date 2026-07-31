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

function setup({ canMutateActivePatient = true, patients = [patient()] } = {}) {
  const setPatients = vi.fn();
  const { result } = renderHook(() => usePatientCrud({
    activeId: 'p1', activeModuleId: null, session: SESSION, settings: {},
    patients, setPatients,
    selectedIds: new Set(), setSelectedIds: vi.fn(),
    errors: {}, setErrors: vi.fn(),
    setActiveId: vi.fn(), setCurrentStepIndex: vi.fn(),
    setIntakeShared: vi.fn(), setShowHome: vi.fn(),
    handleStartIntake: vi.fn(),
    canMutateActivePatient,
  }));
  return { result, setPatients };
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
