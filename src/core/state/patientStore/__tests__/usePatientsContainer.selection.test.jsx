// @vitest-environment jsdom
//
// 환자 상태 컨테이너 — activeId·selectedIds(REFACTORING_ROADMAP Phase 2 P2-37). 옮기기 전 개별 useState setter와 같은 규칙:
// 값 또는 updater, 같은 값(Object.is)이면 다시 렌더하지 않음, setter 참조 고정. StrictMode.
import { describe, expect, it } from 'vitest';
import { StrictMode, useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { usePatientsContainer } from '../usePatientsContainer';
import { applyActiveId, applySelectedIds, createPatientsState } from '../reducer';
import { patientTx } from '../transitions';

function renderContainer(...args) {
  let renders = 0;
  const utils = renderHook(() => {
    renders += 1;
    return usePatientsContainer(...args);
  }, { wrapper: StrictMode });
  return { ...utils, renders: () => renders };
}

// 대조군: 옮기기 전 App처럼 개별 useState. 같은 조작 순서에서 렌더 횟수가 같아야 한다(같은 값 지정 직후의
// React 자체 추가 렌더까지 포함 — 컨테이너가 렌더를 늘리지 않는다는 증명, 계획 A6).
function renderPlain(initialActiveId = null, initialSelectedIds = new Set()) {
  let renders = 0;
  const utils = renderHook(() => {
    renders += 1;
    const [activeId, setActiveId] = useState(initialActiveId);
    const [selectedIds, setSelectedIds] = useState(initialSelectedIds);
    return { activeId, setActiveId, selectedIds, setSelectedIds };
  }, { wrapper: StrictMode });
  return { ...utils, renders: () => renders };
}

describe('reducer — activeId·selectedIds', () => {
  it('같은 값이면 같은 상태, 다르면 그 칸만 바뀐 새 상태', () => {
    const ids = new Set(['a']);
    const state = createPatientsState([{ id: 'a' }], { activeId: 'a', selectedIds: ids });
    expect(applyActiveId(state, 'a')).toBe(state);
    expect(applyActiveId(state, prev => prev)).toBe(state);
    expect(applySelectedIds(state, ids)).toBe(state);
    const next = applyActiveId(state, null);
    expect(next).toEqual({ ...state, activeId: null });
    expect(next.patients).toBe(state.patients);
    expect(next.selectedIds).toBe(ids);
  });

  it('기본값: 빈 목록·활성 없음·빈 선택', () => {
    const state = createPatientsState();
    expect(state.patients).toEqual([]);
    expect(state.activeId).toBeNull();
    expect(state.selectedIds).toBeInstanceOf(Set);
    expect(state.selectedIds.size).toBe(0);
  });
});

describe('usePatientsContainer — activeId·selectedIds', () => {
  it('App처럼 인자 없이: 빈 목록·null·빈 Set, setter 세 개 모두 참조 고정', () => {
    const { result } = renderContainer();
    const { setPatients, setActiveId, setSelectedIds } = result.current;
    expect(result.current.patients).toEqual([]);
    expect(result.current.activeId).toBeNull();
    expect(result.current.selectedIds.size).toBe(0);
    act(() => { setPatients(patientTx.appended({ patients: [{ id: 'a' }] })); });
    act(() => { setActiveId('a'); });
    act(() => { setSelectedIds(new Set(['a'])); });
    expect(result.current.setPatients).toBe(setPatients);
    expect(result.current.setActiveId).toBe(setActiveId);
    expect(result.current.setSelectedIds).toBe(setSelectedIds);
  });

  it('setActiveId: 값·updater, 처음부터 같은 값이면 다시 렌더하지 않음', () => {
    const { result, renders } = renderContainer([{ id: 'a' }, { id: 'b' }], { initialActiveId: 'a' });
    expect(result.current.activeId).toBe('a');
    const before = renders();
    act(() => { result.current.setActiveId('a'); });
    expect(renders()).toBe(before);
    act(() => { result.current.setActiveId(prev => (prev === 'a' ? 'b' : 'a')); });
    expect(result.current.activeId).toBe('b');
  });

  it('setSelectedIds: PatientSidebar의 함수형 갱신(prev → new Set)과 값 지정', () => {
    const { result } = renderContainer([{ id: 'a' }, { id: 'b' }]);
    act(() => {
      result.current.setSelectedIds(prev => { const next = new Set(prev); next.add('a'); return next; });
      result.current.setSelectedIds(prev => { const next = new Set(prev); next.add('b'); return next; });
    });
    expect([...result.current.selectedIds]).toEqual(['a', 'b']);
    act(() => { result.current.setSelectedIds(new Set()); });
    expect(result.current.selectedIds.size).toBe(0);
  });

  it('렌더 횟수가 옮기기 전 개별 useState와 같다(갱신 → 같은 값 → 같은 값 → 다른 값 순서)', () => {
    const steps = [
      h => h.setActiveId('b'),
      h => h.setActiveId('b'),
      h => h.setActiveId('b'),
      h => h.setSelectedIds(prev => new Set([...prev, 'a'])),
      h => h.setActiveId(prev => prev),
      h => h.setActiveId(null),
    ];
    const container = renderContainer([{ id: 'a' }, { id: 'b' }], { initialActiveId: 'a' });
    const plain = renderPlain('a');
    const trace = [];
    for (const step of steps) {
      act(() => { step(container.result.current); });
      act(() => { step(plain.result.current); });
      trace.push([container.renders(), plain.renders()]);
    }
    expect(trace.map(([c]) => c)).toEqual(trace.map(([, p]) => p));
    expect(container.result.current.activeId).toBe(plain.result.current.activeId);
    expect([...container.result.current.selectedIds]).toEqual([...plain.result.current.selectedIds]);
  });

  it('한 배치의 목록 교체 + 활성 지정 + 선택 초기화가 함께 반영된다(초기화 handleResetPatients 순서)', () => {
    const { result } = renderContainer([{ id: 'a' }], { initialActiveId: 'a', initialSelectedIds: new Set(['a']) });
    act(() => {
      result.current.setPatients(patientTx.replacedAll({ patients: [] }));
      result.current.setActiveId(null);
      result.current.setSelectedIds(new Set());
    });
    expect(result.current.patients).toEqual([]);
    expect(result.current.activeId).toBeNull();
    expect(result.current.selectedIds.size).toBe(0);
  });
});
