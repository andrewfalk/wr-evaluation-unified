// @vitest-environment jsdom
//
// 환자 상태 컨테이너(REFACTORING_ROADMAP Phase 2 P2-32) — setter 참조 고정(계획 A3), 값·함수·전이 3형태,
// 같은 배열이면 재렌더 생략(A6), StrictMode 마운트 반복에도 같은 상태.
import { describe, expect, it } from 'vitest';
import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { usePatientsContainer } from '../usePatientsContainer';
import { defineTransition, isPatientTransition, legacySet, LEGACY_SET_TYPE } from '../transitions';
import { applyPatientTransition, createPatientsState } from '../reducer';

const A = { id: 'a' };
const B = { id: 'b' };

const renameTx = defineTransition('test/renamed', (prev, { id, name }) => prev.map(p => (p.id === id ? { ...p, name } : p)));
const keepTx = defineTransition('test/kept', prev => prev);

function renderContainer(initial = [A]) {
  let renders = 0;
  const utils = renderHook(() => {
    renders += 1;
    return usePatientsContainer(initial);
  }, { wrapper: StrictMode });
  return { ...utils, renders: () => renders };
}

describe('defineTransition·isPatientTransition', () => {
  it('전이는 updater로 쓸 수 있는 함수이고 type·payload를 싣는다', () => {
    const tx = renameTx({ id: 'a', name: 'x' });
    expect(typeof tx).toBe('function');
    expect(tx.type).toBe('test/renamed');
    expect(tx.payload).toEqual({ id: 'a', name: 'x' });
    expect(tx([A, B])).toEqual([{ id: 'a', name: 'x' }, B]);
    expect(isPatientTransition(tx)).toBe(true);
  });

  it('꼬리표 없는 함수·배열·null은 전이가 아니다', () => {
    expect(isPatientTransition(prev => prev)).toBe(false);
    expect(isPatientTransition([A])).toBe(false);
    expect(isPatientTransition(null)).toBe(false);
    // type 속성만 흉내 낸 함수도 아니다(꼬리표는 모듈 안 심볼).
    const fake = Object.assign(prev => prev, { type: 'test/fake', payload: null });
    expect(isPatientTransition(fake)).toBe(false);
  });

  it('legacySet은 값이면 그 값을, updater면 prev에 적용한 결과를 낸다', () => {
    const value = [B];
    expect(legacySet(value)([A])).toBe(value);
    expect(legacySet(prev => [...prev, B])([A])).toEqual([A, B]);
    expect(legacySet(value).type).toBe(LEGACY_SET_TYPE);
  });
});

describe('applyPatientTransition', () => {
  it('전이가 같은 배열을 내면 같은 상태 객체, 새 배열이면 새 상태', () => {
    const state = createPatientsState([A]);
    expect(applyPatientTransition(state, keepTx())).toBe(state);
    const next = applyPatientTransition(state, renameTx({ id: 'a', name: 'x' }));
    expect(next).not.toBe(state);
    expect(next.patients).toEqual([{ id: 'a', name: 'x' }]);
  });
});

describe('usePatientsContainer', () => {
  it('초기값과 setter 참조 고정(StrictMode·여러 번 갱신 뒤에도 같은 함수)', () => {
    const { result } = renderContainer([A]);
    const first = result.current.setPatients;
    expect(result.current.patients).toEqual([A]);
    act(() => { result.current.setPatients([A, B]); });
    act(() => { result.current.setPatients(renameTx({ id: 'b', name: 'y' })); });
    expect(result.current.setPatients).toBe(first);
  });

  it('값·updater·전이 세 형태를 모두 적용한다', () => {
    const { result } = renderContainer([A]);
    act(() => { result.current.setPatients([B]); });
    expect(result.current.patients).toEqual([B]);
    act(() => { result.current.setPatients(prev => [...prev, A]); });
    expect(result.current.patients).toEqual([B, A]);
    act(() => { result.current.setPatients(renameTx({ id: 'a', name: 'z' })); });
    expect(result.current.patients).toEqual([B, { id: 'a', name: 'z' }]);
  });

  it('같은 배열을 내는 갱신(전이·updater)은 다시 렌더하지 않는다', () => {
    const { result, renders } = renderContainer([A]);
    const before = renders();
    const patientsBefore = result.current.patients;
    act(() => { result.current.setPatients(keepTx()); });
    act(() => { result.current.setPatients(prev => prev); });
    expect(renders()).toBe(before);
    expect(result.current.patients).toBe(patientsBefore);
  });

  it('한 배치의 여러 갱신은 순서대로 적용된다(앞 갱신 결과가 뒤 updater의 prev)', () => {
    const { result } = renderContainer([]);
    act(() => {
      result.current.setPatients([A]);
      result.current.setPatients(prev => [...prev, B]);
      result.current.setPatients(renameTx({ id: 'a', name: 'n' }));
    });
    expect(result.current.patients).toEqual([{ id: 'a', name: 'n' }, B]);
  });

  it('언마운트 뒤 다시 마운트하면 초기값에서 시작한다(StrictMode 이중 마운트는 상태를 잃지 않음)', () => {
    const first = renderContainer([A]);
    act(() => { first.result.current.setPatients([B]); });
    expect(first.result.current.patients).toEqual([B]);
    first.unmount();
    const second = renderContainer([A]);
    expect(second.result.current.patients).toEqual([A]);
  });
});
