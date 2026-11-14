// 환자 상태 컨테이너의 상태 모양과 전이 적용(REFACTORING_ROADMAP Phase 2 C4, P2-32).
// 순수 함수 — 전이가 같은 배열을 내면 같은 상태 객체를 돌려줘 React가 재렌더를 건너뛰게 한다.
import type { PatientRecord } from '../../types/patient';
import type { PatientTransition } from './transitions';

export interface PatientsState {
  readonly patients: PatientRecord[];
}

export function createPatientsState(patients: PatientRecord[] = []): PatientsState {
  return { patients };
}

export function applyPatientTransition(state: PatientsState, transition: PatientTransition): PatientsState {
  const next = transition(state.patients);
  return Object.is(next, state.patients) ? state : { ...state, patients: next };
}
