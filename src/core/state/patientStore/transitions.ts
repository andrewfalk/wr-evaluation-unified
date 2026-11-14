// 환자 목록 전이(REFACTORING_ROADMAP Phase 2 C4, 게이트 A 계획 "꼬리표 전이").
//
// 전이는 `(prev) => next` 함수에 `type`·`payload`를 붙인 것이다 — 그대로 setState updater로 쓸 수 있어서
// 훅은 계속 `setPatients(patientTx.xxx(payload))`를 부르고, 훅 테스트의 `vi.fn()`은 그것을 받아 `updater([…])`로
// 실행할 수 있다(기존 테스트 파일 수정 없음). 운영 경로와 테스트 경로가 같은 함수 하나를 지난다.
// 컨테이너(usePatientsContainer)는 `type`·`payload`를 읽을 수 있다 — 게이트 B의 미들웨어·로그의 발판.
//
// 규칙(계획 "참조 동작 보존"·"payload 보존"):
//   - 전이는 옮기기 전 코드와 같은 참조를 낸다. `prev.map(...)`으로 늘 새 배열을 내던 곳은 새 배열, `prev`를
//     그대로 내던 곳은 `prev`. "최적화"하지 않는다.
//   - 옮기기 전 코드가 클로저 값으로 계산하던 것은 payload로 그대로 넘긴다. 고치는 것은 flagged PR에서만.
import type { PatientRecord } from '../../types/patient';

const TRANSITION_TAG: unique symbol = Symbol.for('wr.patientTransition');

export interface PatientTransition<P = unknown> {
  (prev: PatientRecord[]): PatientRecord[];
  readonly type: string;
  readonly payload: P;
  readonly [TRANSITION_TAG]: true;
}

export type PatientReduce<P> = (prev: PatientRecord[], payload: P) => PatientRecord[];

/** `defineTransition(type, reduce)` → payload를 받아 꼬리표 붙은 전이를 만드는 함수. */
export function defineTransition<P>(type: string, reduce: PatientReduce<P>): (payload: P) => PatientTransition<P> {
  return (payload: P) => {
    const apply = (prev: PatientRecord[]) => reduce(prev, payload);
    Object.defineProperty(apply, 'type', { value: type, enumerable: true });
    Object.defineProperty(apply, 'payload', { value: payload, enumerable: true });
    Object.defineProperty(apply, TRANSITION_TAG, { value: true });
    return apply as PatientTransition<P>;
  };
}

export function isPatientTransition(value: unknown): value is PatientTransition {
  return typeof value === 'function' && (value as { [TRANSITION_TAG]?: unknown })[TRANSITION_TAG] === true;
}

/** 꼬리표 없는 인자(옛 `setPatients(값 | updater)`) — P2-39에서 삭제. */
export type LegacySetPatientsArg = PatientRecord[] | ((prev: PatientRecord[]) => PatientRecord[]);

export const LEGACY_SET_TYPE = 'patients/__legacySet';

/** @deprecated P2-33~39에서 호출부를 전이로 옮기는 동안만 — 컨테이너가 꼬리표 없는 인자를 이것으로 감싼다. */
export const legacySet = defineTransition<LegacySetPatientsArg>(LEGACY_SET_TYPE, (prev, arg) => (
  typeof arg === 'function' ? arg(prev) : arg
));

/** 이름 붙은 전이 모음. P2-33~39에서 훅별로 채운다(계획 "전이 목록"). */
export const patientTx = {} as const;
