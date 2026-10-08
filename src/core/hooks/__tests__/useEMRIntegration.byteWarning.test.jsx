// @vitest-environment jsdom
//
// handleInjectEMR의 EMR 종합소견(b8/txtSyth1Cont) byte 한도 초과 경고 + 종합소견
// 직접 편집 오버라이드(dirty/invalid 차단, 낡음 재확인, _source 전달) 검증.
// generateUnifiedEMR/resolveAssessment 자체의 텍스트 생성·판정 로직은
// exportService.emr.test.js에서 이미 검증하므로, 여기서는 useEMRIntegration이
// prepareEmrInjection의 결과에 따라 확인창을 띄우고 그 응답에 맞게 전송을 진행/중단하는지만 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useEMRIntegration } from '../useEMRIntegration.js';

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
  showConfirm: vi.fn(async () => true),
}));

const mockPrepareEmrInjection = vi.fn();

vi.mock('../../utils/emrReport', () => ({
  prepareEmrInjection: (...args) => mockPrepareEmrInjection(...args),
}));

import { showAlert, showConfirm } from '../../utils/platform';

const patient = { id: 'p1', data: { shared: {}, modules: {}, activeModules: [] } };

function autoResult(fieldData = { txtSyth1Cont: 'x', _truncatedFields: [] }, bytesOverride) {
  const bytes = bytesOverride ?? fieldData.txtSyth1Cont.length;
  return {
    fieldData,
    effective: { text: fieldData.txtSyth1Cont, generated: fieldData.txtSyth1Cont, isOverride: false, isStale: false, hasInvalidOverride: false },
    bytes,
  };
}

function overrideResult({ isStale = false, hasInvalidOverride = false, text = 'edited', bytes } = {}) {
  const fieldData = { txtSyth1Cont: text, _truncatedFields: [] };
  return {
    fieldData,
    effective: { text, generated: 'generated', isOverride: true, isStale, hasInvalidOverride },
    bytes: bytes ?? text.length,
  };
}

function setup(extraProps = {}) {
  return renderHook(() => useEMRIntegration({
    activePatient: patient, patients: [patient], selectedIds: new Set(), session: {}, setPatients: vi.fn(),
    ...extraProps,
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
    mockPrepareEmrInjection.mockReturnValue(autoResult({ txtSyth1Cont: 'a'.repeat(100), _truncatedFields: [] }));
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenCalledTimes(1); // 최초 "계속하시겠습니까?" 확인만
    expect(window.electron.injectEMR).toHaveBeenCalledTimes(1);
  });

  it('한도를 초과하면 초과분을 알리는 확인창을 추가로 띄운다', async () => {
    mockPrepareEmrInjection.mockReturnValue(autoResult({ txtSyth1Cont: 'a'.repeat(4200), _truncatedFields: ['txtSyth1Cont'] }, 4200));
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenCalledTimes(2);
    expect(showConfirm).toHaveBeenNthCalledWith(2, expect.stringContaining('byte 초과'));
    expect(showConfirm).toHaveBeenNthCalledWith(2, expect.stringContaining('4,200'));
    expect(window.electron.injectEMR).toHaveBeenCalledTimes(1);
  });

  it('초과 확인창에서 거절하면 EMR로 전송하지 않는다', async () => {
    mockPrepareEmrInjection.mockReturnValue(autoResult({ txtSyth1Cont: 'a'.repeat(4200), _truncatedFields: ['txtSyth1Cont'] }, 4200));
    showConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(window.electron.injectEMR).not.toHaveBeenCalled();
  });

  it('최초 확인창에서 거절하면 prepareEmrInjection 자체를 호출하지 않는다', async () => {
    showConfirm.mockResolvedValueOnce(false);
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(mockPrepareEmrInjection).not.toHaveBeenCalled();
    expect(window.electron.injectEMR).not.toHaveBeenCalled();
  });

  it('오버라이드 상태에서 byte 초과 시 "패턴 그룹" 대신 편집본 축소를 안내한다', async () => {
    mockPrepareEmrInjection.mockReturnValue(overrideResult({ text: 'a'.repeat(4200), bytes: 4200 }));
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenNthCalledWith(2, expect.stringContaining('직접 편집한 내용을 줄이면'));
    expect(showConfirm).toHaveBeenNthCalledWith(2, expect.not.stringContaining('패턴 그룹'));
  });
});

describe('useEMRIntegration — 확인 상병 칸 사전 경고', () => {
  const withConfirmedDx = (confirmedDx) => ({ ...autoResult(), confirmedDx });

  it('확인 상병이 정상이면 추가 확인 없이 전송한다', async () => {
    mockPrepareEmrInjection.mockReturnValue(withConfirmedDx({ isEmpty: false, bytes: 40, overLimit: false }));
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(window.electron.injectEMR).toHaveBeenCalledTimes(1);
  });

  it('확인 상병이 0건이면 EMR 기존 값이 남는다는 경고를 띄운다', async () => {
    mockPrepareEmrInjection.mockReturnValue(withConfirmedDx({ isEmpty: true, bytes: 0, overLimit: false }));
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenCalledTimes(2);
    expect(showConfirm).toHaveBeenNthCalledWith(2, expect.stringContaining('"확인"으로 입력된 상병이 없습니다'));
    expect(window.electron.injectEMR).toHaveBeenCalledTimes(1);
  });

  it('0건 경고에서 거절하면 전송하지 않는다', async () => {
    mockPrepareEmrInjection.mockReturnValue(withConfirmedDx({ isEmpty: true, bytes: 0, overLimit: false }));
    showConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(window.electron.injectEMR).not.toHaveBeenCalled();
  });

  it('원본 확인 상병이 한도를 넘으면(절단 전 바이트 기준) 초과 경고를 띄운다', async () => {
    mockPrepareEmrInjection.mockReturnValue(withConfirmedDx({ isEmpty: false, bytes: 4300, overLimit: true }));
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenCalledTimes(2);
    expect(showConfirm).toHaveBeenNthCalledWith(2, expect.stringContaining('확인 상병이 EMR 한도를 초과'));
    expect(showConfirm).toHaveBeenNthCalledWith(2, expect.stringContaining('4,300'));
  });

  it('종합소견 초과와 확인 상병 0건이 겹치면 사유를 합쳐 확인창 한 번으로 묻는다', async () => {
    mockPrepareEmrInjection.mockReturnValue({
      ...autoResult({ txtSyth1Cont: 'a'.repeat(4200), _truncatedFields: ['txtSyth1Cont'] }, 4200),
      confirmedDx: { isEmpty: true, bytes: 0, overLimit: false },
    });
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenCalledTimes(2); // 최초 + 합친 경고 1회
    const merged = showConfirm.mock.calls[1][0];
    expect(merged).toContain('byte 초과');
    expect(merged).toContain('"확인"으로 입력된 상병이 없습니다');
    expect(merged.match(/전송하시겠습니까\?/g)).toHaveLength(1);
    expect(window.electron.injectEMR).toHaveBeenCalledTimes(1);
  });

  it('종합소견과 확인 상병이 모두 한도를 넘으면 두 사유를 한 창에 보여준다', async () => {
    mockPrepareEmrInjection.mockReturnValue({
      ...autoResult({ txtSyth1Cont: 'a'.repeat(4200), _truncatedFields: ['txtSyth1Cont', 'txtAppv_Sick_Cont'] }, 4200),
      confirmedDx: { isEmpty: false, bytes: 4300, overLimit: true },
    });
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenCalledTimes(2);
    const merged = showConfirm.mock.calls[1][0];
    expect(merged).toContain('6.종합소견이 EMR 한도를 초과');
    expect(merged).toContain('확인 상병이 EMR 한도를 초과');
    expect(merged).toContain('4,200');
    expect(merged).toContain('4,300');
    expect(merged).toContain('잘린 상태로 계속 전송하시겠습니까?');
  });

  it('합친 경고에서 거절하면 전송하지 않는다', async () => {
    mockPrepareEmrInjection.mockReturnValue({
      ...autoResult({ txtSyth1Cont: 'a'.repeat(4200), _truncatedFields: ['txtSyth1Cont', 'txtAppv_Sick_Cont'] }, 4200),
      confirmedDx: { isEmpty: false, bytes: 4300, overLimit: true },
    });
    showConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenCalledTimes(2);
    expect(window.electron.injectEMR).not.toHaveBeenCalled();
  });

  it('낡은 편집본 + 종합소견 초과 + 확인 상병 0건: 낡음 확인은 따로, 나머지 경고는 한 창이다', async () => {
    mockPrepareEmrInjection.mockReturnValue({
      ...overrideResult({ isStale: true, text: 'a'.repeat(4200), bytes: 4200 }),
      confirmedDx: { isEmpty: true, bytes: 0, overLimit: false },
    });
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenCalledTimes(3); // 최초 + 낡음 + 합친 경고
    expect(showConfirm).toHaveBeenNthCalledWith(2, expect.stringContaining('변경되었습니다'));
    const merged = showConfirm.mock.calls[2][0];
    expect(merged).toContain('byte 초과');
    expect(merged).toContain('"확인"으로 입력된 상병이 없습니다');
  });
});

describe('useEMRIntegration — dirty(미저장 편집 중) 차단', () => {
  it('활성 환자가 dirtyAssessmentPatientId와 일치하면 확인창 없이 전송을 차단한다', async () => {
    const { result } = setup({ dirtyAssessmentPatientId: 'p1' });

    await result.current.handleInjectEMR();

    expect(showAlert).toHaveBeenCalledWith(expect.stringContaining('저장하지 않은'));
    expect(showConfirm).not.toHaveBeenCalled();
    expect(window.electron.injectEMR).not.toHaveBeenCalled();
  });

  it('dirtyAssessmentPatientId가 다른 환자를 가리키면 차단하지 않는다', async () => {
    mockPrepareEmrInjection.mockReturnValue(autoResult());
    const { result } = setup({ dirtyAssessmentPatientId: 'other-patient' });

    await result.current.handleInjectEMR();

    expect(window.electron.injectEMR).toHaveBeenCalledTimes(1);
  });
});

describe('useEMRIntegration — 깨진 오버라이드 차단', () => {
  it('hasInvalidOverride면 최초 확인 이후 전송을 차단한다', async () => {
    mockPrepareEmrInjection.mockReturnValue(overrideResult({ hasInvalidOverride: true }));
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showAlert).toHaveBeenCalledWith(expect.stringContaining('손상'));
    expect(window.electron.injectEMR).not.toHaveBeenCalled();
  });
});

describe('useEMRIntegration — 낡은 오버라이드 재확인', () => {
  it('isStale이면 byte 확인보다 먼저 낡음 재확인 창을 띄운다', async () => {
    mockPrepareEmrInjection.mockReturnValue(overrideResult({ isStale: true, text: 'short' }));
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenNthCalledWith(2, expect.stringContaining('변경되었습니다'));
    expect(window.electron.injectEMR).toHaveBeenCalledTimes(1);
  });

  it('낡음 재확인에서 거절하면 byte 확인 없이 전송을 중단한다', async () => {
    mockPrepareEmrInjection.mockReturnValue(overrideResult({ isStale: true, text: 'a'.repeat(4200), bytes: 4200 }));
    showConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenCalledTimes(2); // 최초 + 낡음 재확인. byte 확인창은 안 뜬다.
    expect(window.electron.injectEMR).not.toHaveBeenCalled();
  });

  it('낡음 + byte 초과가 겹치면 낡음 확인 → byte 확인 순으로 두 번 다 띄운다', async () => {
    mockPrepareEmrInjection.mockReturnValue(overrideResult({ isStale: true, text: 'a'.repeat(4200), bytes: 4200 }));
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(showConfirm).toHaveBeenCalledTimes(3); // 최초 + 낡음 + byte
    expect(showConfirm).toHaveBeenNthCalledWith(2, expect.stringContaining('변경되었습니다'));
    expect(showConfirm).toHaveBeenNthCalledWith(3, expect.stringContaining('byte 초과'));
    expect(window.electron.injectEMR).toHaveBeenCalledTimes(1);
  });
});

describe('useEMRIntegration — _source 전달', () => {
  it('자동 생성본 전송 시 _source: "auto"를 함께 보낸다', async () => {
    mockPrepareEmrInjection.mockReturnValue(autoResult());
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(window.electron.injectEMR).toHaveBeenCalledWith(expect.objectContaining({ _source: 'auto' }));
  });

  it('편집본 전송 시 _source: "edited"를 함께 보낸다', async () => {
    mockPrepareEmrInjection.mockReturnValue(overrideResult());
    const { result } = setup();

    await result.current.handleInjectEMR();

    expect(window.electron.injectEMR).toHaveBeenCalledWith(expect.objectContaining({ _source: 'edited' }));
  });
});
