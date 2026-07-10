// @vitest-environment jsdom
//
// handlePresetSelect의 담당의 권한 가드 검증. 프리셋 적용 로직 자체(모듈별 applyToModule
// 병합 등)는 이 테스트의 범위가 아니다 — activeModules를 비워서 "적용 대상 없음" 경로를
// 타게 해 모듈 레지스트리 등록 없이도 setPatients가 호출되는지(=가드를 통과했는지)만 본다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { usePresetManagement } from '../usePresetManagement.js';

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
  showConfirm: vi.fn(async () => true),
}));

// reloadPresets()가 마운트 시 loadAllPresets()를 호출하는데, 실제 구현은
// fetch('./job-presets.json')로 정적 파일을 불러온다 — jsdom(서버 없음)에서는 불필요한
// 실제 네트워크 시도가 된다. 이 훅 테스트의 관심사는 프리셋 로딩이 아니라 담당의 권한
// 가드이므로 네트워크를 완전히 우회한다.
//
// 주의: handlePresetSelect 호출을 `act(async () => { await ... })`로 감싸지 않는다 —
// 이 경로는 훅 내부 state를 갱신하지 않아(setPatients는 훅 밖에서 주입된 mock일 뿐) act가
// 기다릴 리렌더가 애초에 없는데, 실측 결과 이 조합이 테스트를 결정적으로 행(hang)시켰다
// (act 없이 그냥 await하면 정상 동작 — 별도 React 상태 갱신이 없는 호출이라 act 불필요).
vi.mock('../../services/presetRepository', () => ({
  loadAllPresets: vi.fn(async () => ({ merged: [], builtinCount: 0, customCount: 0 })),
  normalizeBuiltinPreset: vi.fn(x => x),
  saveCustomPreset: vi.fn(async () => ({})),
  deleteCustomPreset: vi.fn(async () => {}),
  getPresetCategory: vi.fn(() => ''),
  getPresetDescription: vi.fn(() => ''),
}));

import { showAlert } from '../../utils/platform';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function doctorSession(id = 'doc-me') {
  return { mode: 'intranet', user: { id, role: 'doctor' } };
}

const notOwnedPatient = {
  id: 'p1',
  assignedDoctorUserId: 'someone-else',
  data: { shared: {}, modules: {}, activeModules: [] },
};

const ownedPatient = {
  id: 'p1',
  assignedDoctorUserId: 'doc-me',
  data: { shared: {}, modules: {}, activeModules: [] },
};

function setup(activePatient) {
  const setPatients = vi.fn();
  const { result } = renderHook(() => usePresetManagement({
    activeId: 'p1',
    activePatient,
    activeModules: [],
    session: doctorSession(),
    setPatients,
  }));
  return { result, setPatients };
}

describe('usePresetManagement — handlePresetSelect ownership guard', () => {
  it('blocks a non-owned patient: no setPatients call, no false success alert', async () => {
    const { result, setPatients } = setup(notOwnedPatient);

    await result.current.handlePresetSelect('job-1', { jobName: '테스트 프리셋', modules: {} });

    expect(setPatients).not.toHaveBeenCalled();
    expect(showAlert).toHaveBeenCalledTimes(1);
    expect(showAlert).toHaveBeenCalledWith(expect.stringContaining('담당 의사가 아니므로'));
    expect(showAlert).not.toHaveBeenCalledWith(expect.stringContaining('적용되었습니다'));
  });

  it('does not block the owning doctor (regression: guard must not over-block legitimate use)', async () => {
    const { result, setPatients } = setup(ownedPatient);

    await result.current.handlePresetSelect('job-1', { jobName: '테스트 프리셋', modules: {} });

    expect(setPatients).toHaveBeenCalledTimes(1);
    expect(showAlert).toHaveBeenCalledTimes(1);
    expect(showAlert).not.toHaveBeenCalledWith(expect.stringContaining('담당 의사가 아니므로'));
  });

  it('blocks when activePatient is missing entirely (defensive: undefined must not be treated as editable)', async () => {
    const { result, setPatients } = setup(undefined);

    await result.current.handlePresetSelect('job-1', { jobName: '테스트 프리셋', modules: {} });

    expect(setPatients).not.toHaveBeenCalled();
    expect(showAlert).toHaveBeenCalledWith(expect.stringContaining('담당 의사가 아니므로'));
  });
});
