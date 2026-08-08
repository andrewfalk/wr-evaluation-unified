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
