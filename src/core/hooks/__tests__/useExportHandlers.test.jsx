// @vitest-environment jsdom
//
// 환자 데이터 내보내기 6개 경로의 dirty(미저장 종합소견 편집)·hasInvalidOverride(깨진
// 오버라이드) 차단을 검증한다. 차단 판정은 각 핸들러의 "실제 export 대상 배열" 전체를
// 봐야 한다 — Single=활성 환자, Selected=선택 집합, Batch/All=전체.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useExportHandlers } from '../useExportHandlers.js';

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
}));

const mockResolveAssessment = vi.fn(() => ({ hasInvalidOverride: false }));
vi.mock('../../utils/emrReport', () => ({
  resolveAssessment: (...args) => mockResolveAssessment(...args),
}));

const exportServiceMocks = {
  exportSingle: vi.fn(),
  exportSelected: vi.fn(async () => {}),
  exportBatch: vi.fn(async () => {}),
  exportBatchFormatSingle: vi.fn(),
  exportBatchFormatSelected: vi.fn(async () => {}),
  exportBatchFormatAll: vi.fn(async () => {}),
  exportBatchTemplate: vi.fn(),
};
vi.mock('../../utils/exportService', () => ({
  exportSingle: (...args) => exportServiceMocks.exportSingle(...args),
  exportSelected: (...args) => exportServiceMocks.exportSelected(...args),
  exportBatch: (...args) => exportServiceMocks.exportBatch(...args),
  exportBatchFormatSingle: (...args) => exportServiceMocks.exportBatchFormatSingle(...args),
  exportBatchFormatSelected: (...args) => exportServiceMocks.exportBatchFormatSelected(...args),
  exportBatchFormatAll: (...args) => exportServiceMocks.exportBatchFormatAll(...args),
  exportBatchTemplate: (...args) => exportServiceMocks.exportBatchTemplate(...args),
}));

import { showAlert } from '../../utils/platform';

const active = { id: 'active', data: { shared: {} } };
const other = { id: 'other', data: { shared: {} } };
const inactive = { id: 'inactive-invalid', data: { shared: {} } };

function setup({ dirtyAssessmentPatientId, selectedIds = new Set() } = {}) {
  return renderHook(() => useExportHandlers({
    activePatient: active,
    patients: [active, other, inactive],
    selectedIds,
    dirtyAssessmentPatientId,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveAssessment.mockReturnValue({ hasInvalidOverride: false });
});

afterEach(cleanup);

describe('useExportHandlers — dirty 차단(활성 환자 대상)', () => {
  it('handleExportSingle: 활성 환자가 dirty면 차단한다', async () => {
    const { result } = setup({ dirtyAssessmentPatientId: 'active' });
    await result.current.handleExportSingle();
    expect(exportServiceMocks.exportSingle).not.toHaveBeenCalled();
    expect(showAlert).toHaveBeenCalledWith(expect.stringContaining('저장하지 않은'));
  });

  it('handleExportSingle: dirty가 다른 환자를 가리키면 차단하지 않는다', async () => {
    const { result } = setup({ dirtyAssessmentPatientId: 'other' });
    await result.current.handleExportSingle();
    expect(exportServiceMocks.exportSingle).toHaveBeenCalledWith(active);
  });

  it('handleExportBatchFormatSingle: 활성 환자가 dirty면 차단한다', async () => {
    const { result } = setup({ dirtyAssessmentPatientId: 'active' });
    await result.current.handleExportBatchFormatSingle();
    expect(exportServiceMocks.exportBatchFormatSingle).not.toHaveBeenCalled();
  });
});

describe('useExportHandlers — dirty 차단(선택 집합 대상)', () => {
  it('handleExportSelected: 선택 집합에 dirty 환자가 "비활성" 환자로 포함되어 있어도 차단한다', async () => {
    const { result } = setup({ dirtyAssessmentPatientId: 'other', selectedIds: new Set(['other', 'inactive-invalid']) });
    await result.current.handleExportSelected();
    expect(exportServiceMocks.exportSelected).not.toHaveBeenCalled();
  });

  it('handleExportSelected: dirty 환자가 선택 집합 밖이면 차단하지 않는다', async () => {
    const { result } = setup({ dirtyAssessmentPatientId: 'other', selectedIds: new Set(['inactive-invalid']) });
    await result.current.handleExportSelected();
    expect(exportServiceMocks.exportSelected).toHaveBeenCalled();
  });

  it('handleExportBatchFormatSelected도 동일 기준으로 차단한다', async () => {
    const { result } = setup({ dirtyAssessmentPatientId: 'active', selectedIds: new Set(['active']) });
    await result.current.handleExportBatchFormatSelected();
    expect(exportServiceMocks.exportBatchFormatSelected).not.toHaveBeenCalled();
  });
});

describe('useExportHandlers — dirty 차단(전체 대상)', () => {
  it('handleExportBatch: 전체 목록 중 어디든 dirty면 차단한다', async () => {
    const { result } = setup({ dirtyAssessmentPatientId: 'inactive-invalid' });
    await result.current.handleExportBatch();
    expect(exportServiceMocks.exportBatch).not.toHaveBeenCalled();
  });

  it('handleExportBatchFormatAll도 동일하게 차단한다', async () => {
    const { result } = setup({ dirtyAssessmentPatientId: 'inactive-invalid' });
    await result.current.handleExportBatchFormatAll();
    expect(exportServiceMocks.exportBatchFormatAll).not.toHaveBeenCalled();
  });
});

describe('useExportHandlers — hasInvalidOverride 차단', () => {
  it('선택 집합이 아닌 전체 대상 중 하나라도 invalid override면 handleExportBatch를 차단한다', async () => {
    mockResolveAssessment.mockImplementation((patient) => ({ hasInvalidOverride: patient.id === 'inactive-invalid' }));
    const { result } = setup();
    await result.current.handleExportBatch();
    expect(exportServiceMocks.exportBatch).not.toHaveBeenCalled();
    expect(showAlert).toHaveBeenCalledWith(expect.stringContaining('손상'));
  });

  it('활성 환자만 유효하면 handleExportSingle은 차단되지 않는다', async () => {
    mockResolveAssessment.mockImplementation((patient) => ({ hasInvalidOverride: patient.id === 'inactive-invalid' }));
    const { result } = setup();
    await result.current.handleExportSingle();
    expect(exportServiceMocks.exportSingle).toHaveBeenCalled();
  });
});

describe('useExportHandlers — 빈 양식 내보내기는 예외', () => {
  it('handleExportBatchTemplate은 dirty·invalid와 무관하게 항상 통과한다', async () => {
    mockResolveAssessment.mockReturnValue({ hasInvalidOverride: true });
    const { result } = setup({ dirtyAssessmentPatientId: 'active' });
    await result.current.handleExportBatchTemplate();
    expect(exportServiceMocks.exportBatchTemplate).toHaveBeenCalled();
  });
});
