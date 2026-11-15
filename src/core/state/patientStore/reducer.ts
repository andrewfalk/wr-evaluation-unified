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

/**
 * 전이를 적용한다. 전이가 `derive`를 가지면(스토어 경로) 같은 적용 안에서 활성 환자도 정한다(게이트 B 설계 2).
 * 목록·활성 환자가 모두 같으면 같은 상태 객체.
 */
export function applyPatientTransition(state: PatientsState, transition: PatientTransition): PatientsState {
  const next = transition(state.patients);
  const derived = transition.derive ? transition.derive(state, next) : undefined;
  const activeId = derived && 'activeId' in derived ? (derived.activeId ?? null) : state.activeId;
  if (Object.is(next, state.patients) && Object.is(activeId, state.activeId)) return state;
  return { ...state, patients: next, activeId };
}

/** `useState` setter와 같은 규칙: 함수면 이전 값에 적용, 같은 값(Object.is)이면 같은 상태. */
export type ValueOrUpdater<T> = T | ((prev: T) => T);

function resolve<T>(arg: ValueOrUpdater<T>, prev: T): T {
  return typeof arg === 'function' ? (arg as (p: T) => T)(prev) : arg;
}

/**
 * activeId updater는 두 번째 인자로 **같은 상태의 최신 환자 목록**을 받는다 — 앞서 예약된 목록 갱신이 반영된 뒤의 목록으로
 * 활성 환자를 판정해야 하는 뒤처리용(usePatientCrud 삭제 뒤 폴백, P2-39a). 한 인자 updater는 옮기기 전 useState와 같다.
 */
export type ActiveIdUpdater = (prev: string | null, latestPatients: PatientRecord[]) => string | null;

export function applyActiveId(state: PatientsState, arg: string | null | ActiveIdUpdater): PatientsState {
  const next = typeof arg === 'function' ? arg(state.activeId, state.patients) : arg;
  return Object.is(next, state.activeId) ? state : { ...state, activeId: next };
}

export function applySelectedIds(state: PatientsState, arg: ValueOrUpdater<Set<string>>): PatientsState {
  const next = resolve(arg, state.selectedIds);
  return Object.is(next, state.selectedIds) ? state : { ...state, selectedIds: next };
}
