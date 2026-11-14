// 환자 상태 컨테이너(REFACTORING_ROADMAP Phase 2 C4-1, 게이트 A 계획 §3) — App의 `useState([])`를 대신한다.
//
// - 상태는 한 객체(P2-32: patients, P2-37: + activeId·selectedIds). 쓰기는 전부 전이(transitions.ts)를 거친다.
// - 반환하는 setter는 참조가 고정이다 — usePatientSync의 runSync deps에 setPatients가 있어서, 참조가 바뀌면
//   startup·interval·debounce effect가 매 렌더 다시 돈다(계획 A3).
// - useReducer가 아니라 useState(함수형 갱신) 위에 리듀서(applyPatientTransition)를 얹는다: useState는 큐가 비어
//   있으면 갱신을 미리 계산해 같은 상태면 렌더 예약 자체를 생략하지만 useReducer(React 18)는 그 최적화가 없어,
//   "바뀔 게 없으면 prev"인 전이(sync/patientResumed 등)에서 App 렌더가 늘 수 있다(계획 A6) — 옮기기 전과 같은 동작을 지킨다.
// - P2-39 전까지는 꼬리표 없는 인자(값·updater)도 받아 `patients/__legacySet` 전이로 감싼다.
import { useCallback, useState } from 'react';
import type { PatientRecord } from '../../types/patient';
import { applyPatientTransition, createPatientsState, type PatientsState } from './reducer';
import { isPatientTransition, legacySet, type LegacySetPatientsArg, type PatientTransition } from './transitions';

export type SetPatients = (arg: PatientTransition | LegacySetPatientsArg) => void;

export interface PatientsContainer {
  patients: PatientRecord[];
  setPatients: SetPatients;
}

export function usePatientsContainer(initialPatients: PatientRecord[] = []): PatientsContainer {
  const [state, setState] = useState<PatientsState>(() => createPatientsState(initialPatients));

  const setPatients = useCallback<SetPatients>((arg) => {
    const transition = isPatientTransition(arg) ? arg : legacySet(arg);
    setState((current) => applyPatientTransition(current, transition));
  }, []);

  return { patients: state.patients, setPatients };
}
