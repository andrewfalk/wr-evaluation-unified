// @vitest-environment jsdom
//
// 특성화 테스트(P2-48, Phase 2 C5·C6) — 프리셋 파일을 불러오지 못했을 때의 폴백 경로.
// 지금은 무릎 모듈의 FALLBACK_PRESETS 3건을 normalizeBuiltinPreset으로 정규화해 쓰고
// "Preset 파일 로드 실패"를 띄운다. P2-53이 이 상수를 core로 옮길 때 결과가 같은지 이 테스트로 본다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { usePresetManagement } from '../usePresetManagement.js';

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
  showConfirm: vi.fn(async () => true),
}));

vi.mock('../../services/presetRepository', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadAllPresets: vi.fn(async () => { throw new Error('fetch failed'); }),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('usePresetManagement — 프리셋 파일 로드 실패 폴백', () => {
  it('폴백 3건(정규화된 값)과 실패 문구, 개수 정보를 그대로 낸다', async () => {
    const { result } = renderHook(() => usePresetManagement({
      activeId: null,
      activeModules: [],
      session: null,
      setPatients: vi.fn(),
    }));

    await waitFor(() => expect(result.current.presetError).toBe('Preset 파일 로드 실패'));

    expect(result.current.presetMeta).toEqual({ count: 3, builtinCount: 3, customCount: 0 });
    const kneeFlags = { stairs: false, kneeTwist: false, startStop: false, tightSpace: false, kneeContact: false, jumpDown: false };
    const builtin = (id, jobName, category, weight, squatting) => ({
      id: `builtin-${id}`, jobName, category, description: '', source: 'builtin', createdAt: null, updatedAt: null,
      modules: { knee: { weight, squatting, ...kneeFlags } },
    });
    expect(result.current.presets).toEqual([
      builtin(1, '건설 현장 배근공', '건설업', 2500, 180),
      builtin(2, '기계 조립원', '제조업', 1500, 120),
      builtin(3, '포장작업원', '제조업', 300, 60),
    ]);
  });
});
