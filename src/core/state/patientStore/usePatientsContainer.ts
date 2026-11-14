// 환자 상태 컨테이너(REFACTORING_ROADMAP Phase 2 C4-1, 게이트 A 계획 §3) — App의 환자 목록·활성 환자·선택 집합 상태.
//
// - 상태는 한 객체 { patients, activeId, selectedIds }(P2-32: patients, P2-37: + activeId·selectedIds).
//   환자 목록 쓰기는 전부 전이(transitions.ts)를 거친다. activeId·selectedIds는 옮기기 전 useState setter와 같은 규칙
//   (값 또는 updater, 같은 값이면 상태 그대로) — 훅에는 지금처럼 따로 넘긴다(계획 A2: usePatientSync 테스트 하니스 모양).
// - 반환하는 setter는 전부 참조가 고정이다 — usePatientSync의 runSync deps에 setPatients·setActiveId가 있어서, 참조가
//   바뀌면 startup·interval·debounce effect가 매 렌더 다시 돈다(계획 A3).
// - useReducer가 아니라 useState(함수형 갱신) 위에 리듀서(reducer.ts)를 얹는다: useState는 큐가 비어 있으면 갱신을 미리
//   계산해 같은 상태면 렌더 예약 자체를 생략하지만 useReducer(React 18)는 그 최적화가 없어, "바뀔 게 없으면 prev"인
//   전이(sync/patientResumed 등)·같은 activeId 지정에서 App 렌더가 늘 수 있다(계획 A6) — 옮기기 전과 같은 동작을 지킨다.
// - setPatients는 꼬리표 전이(patientTx.…)만 받는다(P2-39 — 정적 보증은 구조 래칫 untaggedSetPatients = 0). 꼬리표 없는
//   인자가 오면 개발·테스트에서는 던지고, 운영 빌드에서는 진료 중 화면이 죽지 않게 console.error 뒤 옛 방식대로 적용한다.
import { useCallback, useState } from 'react';
import type { PatientRecord } from '../../types/patient';
import {
  applyActiveId, applyPatientTransition, applySelectedIds, createPatientsState,
  type PatientsState, type ValueOrUpdater,
} from './reducer';
import { isPatientTransition, untaggedFallback, type PatientTransition, type UntaggedSetPatientsArg } from './transitions';

export type SetPatients = (transition: PatientTransition) => void;

export const UNTAGGED_SET_PATIENTS_MESSAGE =
  '[patientStore] setPatients는 꼬리표 전이(patientTx.…)만 받는다 — 값·updater를 직접 넘기지 말 것(REFACTORING_ROADMAP Phase 2 P2-39)';

/** 꼬리표 없는 인자: 개발·테스트는 던지고, 운영은 오류를 남긴 뒤 옛 방식대로 적용(화면이 죽지 않게). */
function toTransition(arg: unknown): PatientTransition {
  if (isPatientTransition(arg)) return arg;
  if (import.meta.env.DEV) throw new TypeError(UNTAGGED_SET_PATIENTS_MESSAGE);
  console.error(UNTAGGED_SET_PATIENTS_MESSAGE, arg);
  return untaggedFallback(arg as UntaggedSetPatientsArg);
}
export type SetActiveId = (arg: ValueOrUpdater<string | null>) => void;
export type SetSelectedIds = (arg: ValueOrUpdater<Set<string>>) => void;

export interface PatientsContainer {
  patients: PatientRecord[];
  setPatients: SetPatients;
  activeId: string | null;
  setActiveId: SetActiveId;
  selectedIds: Set<string>;
  setSelectedIds: SetSelectedIds;
}

export interface PatientsContainerOptions {
  initialActiveId?: string | null;
  initialSelectedIds?: Set<string>;
}

/** 첫 인자는 P2-32와 같은 초기 환자 목록(App은 인자 없이 — 빈 목록·활성 없음·빈 선택). */
export function usePatientsContainer(
  initialPatients: PatientRecord[] = [],
  { initialActiveId = null, initialSelectedIds }: PatientsContainerOptions = {},
): PatientsContainer {
  const [state, setState] = useState<PatientsState>(() => createPatientsState(initialPatients, {
    activeId: initialActiveId, selectedIds: initialSelectedIds,
  }));

  const setPatients = useCallback<SetPatients>((arg) => {
    const transition = toTransition(arg);
    setState((current) => applyPatientTransition(current, transition));
  }, []);
  const setActiveId = useCallback<SetActiveId>((arg) => {
    setState((current) => applyActiveId(current, arg));
  }, []);
  const setSelectedIds = useCallback<SetSelectedIds>((arg) => {
    setState((current) => applySelectedIds(current, arg));
  }, []);

  return {
    patients: state.patients, setPatients,
    activeId: state.activeId, setActiveId,
    selectedIds: state.selectedIds, setSelectedIds,
  };
}
