// @vitest-environment jsdom
//
// handleInjectEMR의 EMR 종합소견(b8/txtSyth1Cont) byte 한도 초과 경고 검증.
// generateUnifiedEMR/generateEMRFieldData 자체의 텍스트 생성 로직은 assessmentGroups.test.js·
// exportService.emr.test.js에서 이미 검증하므로, 여기서는 useEMRIntegration이 byte 계산
// 결과에 따라 추가 확인창을 띄우고 그 응답에 맞게 전송을 진행/중단하는지만 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useEMRIntegration } from '../useEMRIntegration.js';

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
  showConfirm: vi.fn(async () => true),
}));

const mockGenerateUnifiedEMR = vi.fn();
const mockGenerateEMRFieldData = vi.fn(() => ({ txtSyth1Cont: 'x', _truncatedFields: [] }));

vi.mock('../../utils/emrReport', () => ({
  generateUnifiedEMR: (...args) => mockGenerateUnifiedEMR(...args),
}));
vi.mock('../../utils/exportService', () => ({
  generateEMRFieldData: (...args) => mockGenerateEMRFieldData(...args),
}));

import { showConfirm } from '../../utils/platform';

const patient = { id: 'p1', data: { shared: {}, modules: {}, activeModules: [] } };

function setup() {
  return renderHook(() => useEMRIntegration({
    activePatient: patient, patients: [patient], selectedIds: new Set(), session: {}, setPatients: vi.fn(),
  }));
}

beforeEach(() => {
  window.electron = { injectEMR: vi.fn(async () => ({ success: true, message: '완료' })) };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete window.electron;
});

describe('useEMRIntegration — EMR 종합소견(b8) byte 한도 초과 경고', () => {
  it('한도 이내면 추가 확인 없이 바로 전송한다', async () => {
    mockGenerateUnifiedEMR.mockReturnValue({ b8: 'a'.repeat(100) });
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenCalledTimes(1); // 최초 "계속하시겠습니까?" 확인만
    expect(window.electron.injectEMR).toHaveBeenCalledTimes(1);
  });

  it('한도를 초과하면 초과분을 알리는 확인창을 추가로 띄운다', async () => {
    mockGenerateUnifiedEMR.mockReturnValue({ b8: 'a'.repeat(4200) }); // ASCII 1byte × 4200 > 3950
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenCalledTimes(2);
    expect(showConfirm).toHaveBeenNthCalledWith(2, expect.stringContaining('byte 초과'));
    expect(showConfirm).toHaveBeenNthCalledWith(2, expect.stringContaining('4,200'));
    expect(window.electron.injectEMR).toHaveBeenCalledTimes(1);
  });

  it('초과 확인창에서 거절하면 EMR로 전송하지 않는다', async () => {
    mockGenerateUnifiedEMR.mockReturnValue({ b8: 'a'.repeat(4200) });
    showConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(window.electron.injectEMR).not.toHaveBeenCalled();
  });

  it('최초 확인창에서 거절하면 byte 계산 자체를 하지 않는다', async () => {
    showConfirm.mockResolvedValueOnce(false);
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(mockGenerateUnifiedEMR).not.toHaveBeenCalled();
    expect(window.electron.injectEMR).not.toHaveBeenCalled();
  });
});
