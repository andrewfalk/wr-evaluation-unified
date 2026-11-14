// @vitest-environment jsdom
// useModalState(REFACTORING_ROADMAP Phase 2 P2-30) — 키별 맵: 여러 모달이 동시에 열린다(단일 슬롯이 아님, 계획 F4).
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../core/services/presetRepository', async (importOriginal) => ({
  ...(await importOriginal()),
  loadAllPresets: vi.fn(async () => ({ merged: [], builtinCount: 0, customCount: 0 })),
}));

import { loadAllPresets } from '../../core/services/presetRepository';
import { INITIAL_MODAL_SLOTS, useModalState } from '../useModalState';
import { usePresetManagement } from '../../core/hooks/usePresetManagement';

// session·setPatients 참조를 고정한다 — usePresetManagement는 session이 바뀌면 프리셋을 다시 불러오므로, 렌더마다 새 객체를
// 넘기면 모달 조작마다 무관한 재조회가 일어난다(#310 Codex 권고).
const LOCAL_SESSION = { mode: 'local' };
const noopSetPatients = () => {};

afterEach(() => cleanup());

describe('useModalState', () => {
  it('처음엔 모두 닫힘(불리언 8 false, 프리셋 3 null)', () => {
    const { result } = renderHook(() => useModalState(), { wrapper: StrictMode });
    expect(result.current.modals).toEqual(INITIAL_MODAL_SLOTS);
    expect(Object.keys(INITIAL_MODAL_SLOTS)).toHaveLength(11);
  });

  it('여러 모달이 동시에 열린다 — 하나를 열어도 다른 키는 그대로', () => {
    const { result } = renderHook(() => useModalState(), { wrapper: StrictMode });
    act(() => {
      result.current.setterFor('settings')(true);
      result.current.setterFor('batchImport')(true);
      result.current.setterFor('presetBrowseJobId')('job-1');
    });
    expect(result.current.modals).toMatchObject({ settings: true, batchImport: true, presetBrowseJobId: 'job-1', save: false });
    act(() => result.current.setterFor('settings')(false));
    expect(result.current.modals).toMatchObject({ settings: false, batchImport: true, presetBrowseJobId: 'job-1' });
  });

  it('setter는 useState처럼 이전 값 → 새 값 함수도 받는다', () => {
    const { result } = renderHook(() => useModalState(), { wrapper: StrictMode });
    act(() => result.current.setterFor('load')((v) => !v));
    expect(result.current.modals.load).toBe(true);
  });

  it('같은 값이면 상태 객체를 바꾸지 않는다(재렌더 없음 — 예전 개별 useState와 같음), setter 참조는 고정', () => {
    let renders = 0;
    const { result, rerender } = renderHook(() => { renders += 1; return useModalState(); });
    const before = result.current.modals;
    const setter = result.current.setterFor('save');
    const count = renders;
    act(() => setter(false));
    expect(result.current.modals).toBe(before);
    expect(renders).toBe(count);
    rerender();
    expect(result.current.setterFor('save')).toBe(setter);
  });
});

describe('useModalState + usePresetManagement(modalSlots)', () => {
  function useBoth() {
    const { modals, setterFor } = useModalState();
    const presets = usePresetManagement({
      activeId: null, activeModules: [], session: LOCAL_SESSION, setPatients: noopSetPatients,
      modalSlots: {
        presetModalJobId: modals.presetManageJobId, setPresetModalJobId: setterFor('presetManageJobId'),
        presetEditingPreset: modals.presetEditingPreset, setPresetEditingPreset: setterFor('presetEditingPreset'),
        presetBrowseJobId: modals.presetBrowseJobId, setPresetBrowseJobId: setterFor('presetBrowseJobId'),
      },
    });
    return { modals, presets };
  }

  it('조회 → 관리(수정) 전환 중에는 두 칸이 함께 차 있고, 관리 모달을 닫으면 조회 모달로 돌아간다', async () => {
    const { result } = renderHook(() => useBoth(), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.presets.presetMeta).not.toBeNull()); // 첫 프리셋 로딩이 끝난 뒤 조작
    const loads = vi.mocked(loadAllPresets).mock.calls.length;
    act(() => result.current.presets.setPresetBrowseJobId('job-1'));
    act(() => {
      result.current.presets.setPresetEditingPreset({ id: 'p1', jobName: '용접공' });
      result.current.presets.setPresetModalJobId('job-1');
    });
    expect(result.current.modals).toMatchObject({ presetBrowseJobId: 'job-1', presetManageJobId: 'job-1' });
    expect(result.current.presets.presetModalJobId).toBe('job-1'); // 훅은 바깥 칸의 값을 그대로 본다
    act(() => result.current.presets.closePresetManageModal());
    expect(result.current.modals).toMatchObject({ presetManageJobId: null, presetEditingPreset: null, presetBrowseJobId: 'job-1' });
    expect(vi.mocked(loadAllPresets).mock.calls.length).toBe(loads); // 모달 조작이 프리셋 재조회를 일으키지 않음
  });

  it('modalSlots 없이 부르면 예전처럼 훅이 직접 들고 있다(호환)', async () => {
    const { result } = renderHook(() => usePresetManagement({
      activeId: null, activeModules: [], session: LOCAL_SESSION, setPatients: noopSetPatients,
    }), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.presetMeta).not.toBeNull());
    act(() => result.current.setPresetBrowseJobId('job-9'));
    expect(result.current.presetBrowseJobId).toBe('job-9');
  });
});
