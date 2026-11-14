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
import { touchPatientRecord as touchPatientRecordJs } from '../../services/patientRecords';

// JS 서비스를 TS에서 부를 때의 모양(본체는 그대로 재사용 — 계획 "전이 본체는 기존 순수 함수를 재사용").
type TouchContext = { session?: unknown };
const touchPatientRecord = touchPatientRecordJs as unknown as (patient: PatientRecord, context: TouchContext) => PatientRecord;

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

// ---------------------------------------------------------------------------
// 전이 본체(계획 "전이 목록"). 주석의 #번호는 계획의 쓰기 지점 표.
// ---------------------------------------------------------------------------

type PatientDataValue = NonNullable<PatientRecord['data']>;
/** 함수면 그 환자의 data를 받아 새 data를, 객체면 data에 얕게 합친다(옮기기 전 updatePatient와 같음). */
export type DataEdit = Partial<PatientDataValue> | ((data: PatientDataValue) => PatientDataValue);

export interface DataEditedPayload {
  /** 편집할 환자. null이면 아무 환자도 바꾸지 않는다(그래도 prev.map처럼 새 배열 — 옮기기 전과 같음). */
  id: string | null;
  edit: DataEdit;
  session: unknown;
  /**
   * touch 전에 updatedAt을 찍는다 — 옮기기 전 updatePatient(#13)가 하던 그대로. touch가 늘 다시 쓰므로 보통은 결과가 같고,
   * 가림 환자처럼 touch가 입력을 그대로 돌려주는 경우에만 차이가 난다(그 차이까지 보존하려고 둔다).
   */
  stampUpdatedAt?: boolean;
}

const dataEdited = defineTransition<DataEditedPayload>('patient/dataEdited', (prev, { id, edit, session, stampUpdatedAt }) => (
  prev.map(p => (
    p.id === id
      ? touchPatientRecord(
        {
          ...p,
          ...(stampUpdatedAt ? { updatedAt: new Date().toISOString() } : {}),
          data: typeof edit === 'function'
            ? edit(p.data as PatientDataValue)
            : { ...(p.data as PatientDataValue), ...edit },
        },
        { session },
      )
      : p
  ))
));

export interface ReplacedAllPayload {
  patients: PatientRecord[];
}

/** 목록 전체 교체 — prev를 보지 않는다(옮기기 전 `setPatients(값)`과 같음). */
const replacedAll = defineTransition<ReplacedAllPayload>('patients/replacedAll', (_prev, { patients }) => patients);

/** 이름 붙은 전이 모음. P2-33~39에서 훅별로 채운다(계획 "전이 목록"). */
export const patientTx = {
  /** #13 usePatientCrud.updatePatient · #23 usePresetManagement.applyPreset */
  dataEdited,
  /** #3 App 초기화 · #4·#7 자동저장 복원·불러오기 · #14 삭제(현행 — 클로저 목록, P2-39a에서 교체) · #15 일괄 가져오기 · #16 테스트 데이터 */
  replacedAll,
} as const;
