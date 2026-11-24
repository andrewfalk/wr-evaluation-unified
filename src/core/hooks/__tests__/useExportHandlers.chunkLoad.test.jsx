// @vitest-environment jsdom
//
// FX-5(flagged, Phase 2 C7-a) — 내보내기 코드 조각(exportService)을 내려받지 못하면 브라우저의 영어 메시지 대신
// 한국어 새로고침 안내를 띄운다. 조각은 받았는데 내보내기 자체가 실패하면 그 오류 문구는 전과 같다(구분).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { CHUNK_LOAD_FAILED_MESSAGE } from '../../components/lazyWithReload';

const control = vi.hoisted(() => ({ failLoad: false, exportSingle: null }));

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
}));
vi.mock('../../utils/emrReport', () => ({
  resolveAssessment: () => ({ hasInvalidOverride: false }),
}));
vi.mock('../../utils/exportService', () => {
  if (control.failLoad) throw new TypeError('Failed to fetch dynamically imported module: /assets/exportService-old.js');
  return { exportSingle: (...args) => control.exportSingle(...args) };
});

import { showAlert } from '../../utils/platform';
import { useExportHandlers } from '../useExportHandlers.js';

const active = { id: 'active', data: { shared: {} } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  control.failLoad = false;
  control.exportSingle = vi.fn();
});
afterEach(cleanup);

async function exportSingle() {
  const { result } = renderHook(() => useExportHandlers({
    activePatient: active, patients: [active], selectedIds: new Set(), dirtyAssessmentPatientId: null,
  }));
  await act(async () => { await result.current.handleExportSingle(); });
}

describe('FX-5 — 내보내기 조각 로드 실패 안내', () => {
  it('조각을 내려받지 못하면 한국어 새로고침 안내를 띄운다(브라우저 메시지 아님)', async () => {
    control.failLoad = true;
    await exportSingle();
    expect(showAlert).toHaveBeenCalledTimes(1);
    expect(showAlert.mock.calls[0][0]).toBe(CHUNK_LOAD_FAILED_MESSAGE);
    expect(control.exportSingle).not.toHaveBeenCalled();
  });

  it('조각은 받았고 내보내기가 실패하면 그 오류 문구 그대로(전과 같음)', async () => {
    control.exportSingle.mockImplementation(() => { throw new Error('파일을 쓰지 못했습니다'); });
    await exportSingle();
    expect(showAlert.mock.calls[0][0]).toBe('파일을 쓰지 못했습니다');
  });

  it('둘 다 성공하면 알림 없음', async () => {
    await exportSingle();
    expect(control.exportSingle).toHaveBeenCalledWith(active);
    expect(showAlert).not.toHaveBeenCalled();
  });
});
