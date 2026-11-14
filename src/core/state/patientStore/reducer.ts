// 환자 상태 컨테이너의 상태 모양과 전이 적용(REFACTORING_ROADMAP Phase 2 C4, P2-32·P2-37).
// 순수 함수 — 전이·값이 같으면 같은 상태 객체를 돌려줘 React가 재렌더를 건너뛰게 한다.
import type { PatientRecord } from '../../types/patient';
import type { PatientTransition } from './transitions';

export interface PatientsState {
  readonly patients: PatientRecord[];
  readonly activeId: string | null;
  readonly selectedIds: Set<string>;
}

export interface PatientsStateExtras {
  activeId?: string | null;
  selectedIds?: Set<string>;
}

/** 첫 인자는 P2-32와 같은 환자 목록. */
export function createPatientsState(
  patients: PatientRecord[] = [],
  { activeId = null, selectedIds = new Set<string>() }: PatientsStateExtras = {},
): PatientsState {
  return { patients, activeId, selectedIds };
}

export function applyPatientTransition(state: PatientsState, transition: PatientTransition): PatientsState {
  const next = transition(state.patients);
  return Object.is(next, state.patients) ? state : { ...state, patients: next };
}

/** `useState` setter와 같은 규칙: 함수면 이전 값에 적용, 같은 값(Object.is)이면 같은 상태. */
export type ValueOrUpdater<T> = T | ((prev: T) => T);

function resolve<T>(arg: ValueOrUpdater<T>, prev: T): T {
  return typeof arg === 'function' ? (arg as (p: T) => T)(prev) : arg;
}

export function applyActiveId(state: PatientsState, arg: ValueOrUpdater<string | null>): PatientsState {
  const next = resolve(arg, state.activeId);
  return Object.is(next, state.activeId) ? state : { ...state, activeId: next };
}

export function applySelectedIds(state: PatientsState, arg: ValueOrUpdater<Set<string>>): PatientsState {
  const next = resolve(arg, state.selectedIds);
  return Object.is(next, state.selectedIds) ? state : { ...state, selectedIds: next };
}
