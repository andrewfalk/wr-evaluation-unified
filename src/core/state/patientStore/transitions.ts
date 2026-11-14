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
import { applyWorkspaceSaveAck as applyWorkspaceSaveAckJs } from '../../services/patientServerRepository';
import { resolvePatientConflictInList as resolvePatientConflictInListJs } from '../../services/patientConflictResolution';

// JS 서비스를 TS에서 부를 때의 모양(본체는 그대로 재사용 — 계획 "전이 본체는 기존 순수 함수를 재사용").
// import 바인딩은 호출 시점에만 읽는다(최상위에서 읽지 않음): 훅 테스트가 서비스 모듈을 일부 export만 가진 vi.mock으로
// 바꿔 두면 최상위 접근은 모듈 로드 자체를 실패시킨다(그 테스트가 부르지 않는 전이까지).
type TouchContext = { session?: unknown };
function touchPatientRecord(patient: PatientRecord, context: TouchContext): PatientRecord {
  return (touchPatientRecordJs as unknown as (p: PatientRecord, c: TouchContext) => PatientRecord)(patient, context);
}
function applyWorkspaceSaveAck(localPatients: PatientRecord[], sentPatients: PatientRecord[], ack: unknown): PatientRecord[] {
  return (applyWorkspaceSaveAckJs as unknown as (l: PatientRecord[], s: PatientRecord[], a: unknown) => PatientRecord[])(
    localPatients, sentPatients, ack,
  );
}
function resolvePatientConflictInList(
  patients: PatientRecord[], patientId: string, resolution: string, options: unknown,
): PatientRecord[] {
  return (resolvePatientConflictInListJs as unknown as (
    p: PatientRecord[], id: string, r: string, o: unknown,
  ) => PatientRecord[])(patients, patientId, resolution, options);
}

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

export interface AppendedPayload {
  patients: PatientRecord[];
}

/** 목록 끝에 덧붙인다 — 늘 새 배열(옮기기 전 `[...prev, ...추가]`, 빈 추가여도). */
const appended = defineTransition<AppendedPayload>('patients/appended', (prev, { patients }) => [...prev, ...patients]);

export interface SaveAckAppliedPayload {
  /** 저장 요청에 실어 보낸 스냅샷 — 옮기기 전 updater가 클로저로 읽던 `patients`(의도된 "보낸 스냅샷"). */
  sentPatients: PatientRecord[];
  ack: unknown;
}

/** 워크스페이스 저장 응답을 적용 시점 목록(prev)에 반영 — applyWorkspaceSaveAck 재사용(ack 없으면 prev 그대로). */
const saveAckApplied = defineTransition<SaveAckAppliedPayload>('workspace/saveAckApplied', (prev, { sentPatients, ack }) => (
  applyWorkspaceSaveAck(prev, sentPatients, ack)
));

/**
 * 임시(게이트 B에서 제거): 옮기기 전 updater 안에서 하던 활성 환자 예약(`queueMicrotask(setActiveId…)`)을 그대로 실행하는 콜백.
 * 전이 본체는 순수하고 예약만 호출부가 넘긴다 — 병합 결과(next)를 봐야 활성 환자를 정할 수 있는데 훅 인자가 별개 setter라서다(계획 A5).
 * StrictMode 이중 실행 시 두 번 불리는 것도 옮기기 전과 같다. `conflict/resolved`·`sync/pullApplied`만 받는다.
 */
export type OnReduced = (prev: PatientRecord[], next: PatientRecord[]) => void;

export interface ConflictResolvedPayload {
  patientId: string;
  resolution: string;
  options?: unknown;
  onReduced?: OnReduced;
}

/** 충돌 해결 — resolvePatientConflictInList 재사용(flatMap이라 늘 새 배열). */
const conflictResolved = defineTransition<ConflictResolvedPayload>('conflict/resolved', (prev, { patientId, resolution, options, onReduced }) => {
  // options는 그대로 넘긴다(undefined면 resolvePatientConflictInList의 기본값 — 옮기기 전과 같음).
  const next = resolvePatientConflictInList(prev, patientId, resolution, options);
  onReduced?.(prev, next);
  return next;
});

export interface PatientIdPayload {
  id: string;
}

/** 원격 삭제 충돌 표시. */
const remoteDeleteMarked = defineTransition<PatientIdPayload>('conflict/remoteDeleteMarked', (prev, { id }) => (
  prev.map(p => (
    p.id === id
      ? {
        ...p,
        sync: {
          ...(p.sync || {}),
          syncStatus: 'conflict' as const,
          conflict: {
            ...(p.sync?.conflict || {}),
            kind: 'remote-delete',
            serverRevision: null,
          },
        },
      }
      : p
  ))
));

export interface DeleteRevisionUpdatedPayload {
  id: string;
  /** 삭제 응답의 `error.data.currentRevision` — 없으면(undefined·null) 기존 충돌의 serverRevision, 그것도 없으면 null. */
  currentRevision: number | null | undefined;
}

/** 충돌 해결 중 서버 삭제가 실패했을 때 충돌의 서버 revision 갱신. */
const deleteRevisionUpdated = defineTransition<DeleteRevisionUpdatedPayload>('conflict/deleteRevisionUpdated', (prev, { id, currentRevision }) => (
  prev.map(p => (
    p.id === id
      ? {
        ...p,
        sync: {
          ...(p.sync || {}),
          syncStatus: 'conflict' as const,
          conflict: {
            ...(p.sync?.conflict || {}),
            serverRevision: currentRevision ?? p.sync?.conflict?.serverRevision ?? null,
          },
        },
      }
      : p
  ))
));

export interface ReplacedFromServerPayload {
  id: string;
  serverPatient: PatientRecord;
  /** true면 서버 값에 로컬 id와 로컬 meta(없으면 서버 meta)를 얹는다(#11 생년월일 정정). false면 서버 값 그대로(#2 영상 분석 적용). */
  keepLocalMeta: boolean;
}

/** 한 환자를 서버 값으로 교체. */
const replacedFromServer = defineTransition<ReplacedFromServerPayload>('patient/replacedFromServer', (prev, { id, serverPatient, keepLocalMeta }) => (
  prev.map(p => {
    if (p.id !== id) return p;
    return keepLocalMeta ? { ...serverPatient, id, meta: p.meta ?? serverPatient.meta } : serverPatient;
  })
));

export interface SharedReplacedPayload {
  id: string;
  /**
   * 새 shared 전체 — 현행 그대로 EMR 추출·다학제 회신 시작 시점 사본을 기반으로 만든 값(그사이 바뀐 다른 필드·상병을 되돌리는
   * 결함은 P2-39b에서 `patient/sharedPatched`로 교체한다).
   */
  shared: PatientDataValue['shared'];
  session: unknown;
}

/** 한 환자의 shared를 통째로 교체하고 touch(옮기기 전처럼 touch 전에 updatedAt을 찍음). */
const sharedReplaced = defineTransition<SharedReplacedPayload>('patient/sharedReplaced', (prev, { id, shared, session }) => (
  prev.map(p => (
    p.id === id
      ? touchPatientRecord(
        { ...p, updatedAt: new Date().toISOString(), data: { ...(p.data as PatientDataValue), shared } },
        { session },
      )
      : p
  ))
));

/** "저장하지 않고 이동" — 그 환자를 자동 push 대상에서 뺀다(usePatientSync가 다시 열 때 푼다). */
const patientPaused = defineTransition<PatientIdPayload>('sync/patientPaused', (prev, { id }) => (
  prev.map(p => (p.id === id ? { ...p, sync: { ...(p.sync || {}), syncPaused: true } } : p))
));

/** 이름 붙은 전이 모음. P2-33~39에서 훅별로 채운다(계획 "전이 목록"). */
export const patientTx = {
  /** #13 usePatientCrud.updatePatient · #23 usePresetManagement.applyPreset */
  dataEdited,
  /** #3 App 초기화 · #4·#7 자동저장 복원·불러오기 · #14 삭제(현행 — 클로저 목록, P2-39a에서 교체) · #15 일괄 가져오기 · #16 테스트 데이터 */
  replacedAll,
  /** #8 불러오기(추가) · #22 위자드 완료 */
  appended,
  /** #5·#6 워크스페이스 저장(새 이름·덮어쓰기) 응답 */
  saveAckApplied,
  /** #9 충돌 해결(updater 안 활성 환자 예약은 onReduced로 격리 — 게이트 B에서 제거) */
  conflictResolved,
  /** #10 원격 삭제 충돌 표시 */
  remoteDeleteMarked,
  /** #12 충돌 해결 중 서버 삭제 실패 → 충돌 serverRevision 갱신 */
  deleteRevisionUpdated,
  /** #11 생년월일 정정 응답(keepLocalMeta: true) · #2 영상 분석 서버 적용(false) */
  replacedFromServer,
  /** #20 EMR 일괄 추출 · #21 다학제 회신(현행 그대로 — P2-39b에서 sharedPatched로 교체) */
  sharedReplaced,
  /** #1 App 환자 전환 — 저장하지 않고 이동 */
  patientPaused,
} as const;
