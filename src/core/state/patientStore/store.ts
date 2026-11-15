// 환자 스토어 코어(REFACTORING_ROADMAP Phase 2 C4-2, 게이트 B 계획 설계 1·3, P2-40a) — React 없음.
//
// - "앞선 상태"(getState)를 동기로 읽고 쓴다: dispatch는 전이를 **지금 한 번** 실행해 앞선 상태를 갱신하고, 같은 갱신을
//   React의 함수형 갱신 큐에 항목 `{ base, next, replay }`로 넣는다(enqueue). React는 그 항목을 처리할 때 prev가 base와 같은
//   객체면 이미 계산된 next를 그대로 쓰고(전이를 두 번 돌리지 않음 — React 상태와 스토어 상태가 같은 객체), lane 때문에 앞
//   항목을 건너뛰는 일시적인 렌더에서만 replay(prev)로 다시 계산한다(옮기기 전 컨테이너가 하던 일과 같다).
// - useSyncExternalStore도, 스토어 전체 스냅샷을 값으로 넣는 미러(setSnapshot(getState()))도 쓰지 않는다 — 둘 다 이벤트 밖의
//   다른 setState와 lane이 갈려 "목록은 새 값, 스텝·화면은 옛 값"인 중간 커밋이 생긴다(계획 B1·B1b, 대조 테스트
//   __tests__/store.laneContrast.test.jsx). 함수형 갱신 큐는 React가 lane 순서대로 다시 적용하므로 그 문제가 없다.
// - 구독(subscribe)은 만들지 않는다. React로 가는 길은 enqueue 하나이고, sync 엔진은 스토어를 구독하지 않는다(계획 B6).
// - **규칙**: 훅 본문·이벤트 핸들러에서 getState()를 읽지 않는다(읽는 곳은 sync 엔진뿐, 전이는 prev·derive 인자를 쓴다) —
//   렌더 값 클로저의 의미가 조용히 바뀌지 않게. 구조 래칫 storeGetStateOutsideSync = 0으로 강제한다.
import {
  applyActiveId, applyPatientTransition, applySelectedIds,
  type ActiveIdUpdater, type PatientsState, type ValueOrUpdater,
} from './reducer';
import { isPatientTransition, untaggedFallback, type PatientTransition, type UntaggedSetPatientsArg } from './transitions';

export const UNTAGGED_SET_PATIENTS_MESSAGE =
  '[patientStore] setPatients는 꼬리표 전이(patientTx.…)만 받는다 — 값·updater를 직접 넘기지 말 것(REFACTORING_ROADMAP Phase 2 P2-39)';

export const REENTRANT_DISPATCH_MESSAGE =
  '[patientStore] 전이·updater 실행 중에 다시 dispatch했다 — 전이는 순수해야 한다(REFACTORING_ROADMAP Phase 2 P2-40a)';

/** React 함수형 갱신 큐에 넣는 항목. base = 이 갱신 직전의 앞선 상태, next = 이 갱신 뒤의 앞선 상태. */
export interface StoreQueueEntry {
  readonly base: PatientsState;
  readonly next: PatientsState;
  /** lane 건너뛰기로 prev가 base와 다를 때 다시 계산 — receipt를 버린 사본 전이로 돌려 이미 읽힌 receipt를 덮지 않는다. */
  readonly replay: (prev: PatientsState) => PatientsState;
}

export type StoreEnqueue = (entry: StoreQueueEntry) => void;

export interface PatientStore {
  /** "앞선 상태" — 지금까지 dispatch된 것이 전부 적용된 상태. React 커밋을 기다리지 않는다. */
  getState(): PatientsState;
  /** 전이를 동기로 정확히 한 번 실행해 앞선 상태를 갱신하고 React 큐에 항목을 넣는다. 갱신 뒤 앞선 상태를 돌려준다. */
  dispatch(transition: PatientTransition): PatientsState;
  /** 값 또는 updater(두 번째 인자 = 같은 상태의 최신 환자 목록, reducer.ts ActiveIdUpdater). */
  setActiveId(arg: string | null | ActiveIdUpdater): void;
  setSelectedIds(arg: ValueOrUpdater<Set<string>>): void;
}

/** 꼬리표 없는 인자: 개발·테스트는 던지고, 운영은 오류를 남긴 뒤 옛 방식대로 적용(화면이 죽지 않게). */
function toTransition(arg: unknown): PatientTransition {
  if (isPatientTransition(arg)) return arg;
  if (import.meta.env.DEV) throw new TypeError(UNTAGGED_SET_PATIENTS_MESSAGE);
  // 인자 원본(환자 목록·updater)은 로그에 남기지 않는다 — 환자 이름·진료 데이터가 오류 로그로 새지 않게(#321 Codex). 종류만.
  console.error(UNTAGGED_SET_PATIENTS_MESSAGE, { argKind: Array.isArray(arg) ? 'array' : typeof arg });
  return untaggedFallback(arg as UntaggedSetPatientsArg);
}

export function createPatientStore(initial: PatientsState, enqueue: StoreEnqueue): PatientStore {
  let ahead = initial;
  let running = false;
  // 운영 빌드에서 재진입이 생기면 바깥 갱신이 끝난 직후 이어서 적용한다(바깥이 안쪽 결과를 덮어 React 큐와 앞선 상태가
  // 어긋나는 일을 막는다). 개발·테스트는 던진다.
  const pending: Array<() => void> = [];

  function update(compute: (state: PatientsState) => PatientsState, replay: (prev: PatientsState) => PatientsState): void {
    if (running) {
      if (import.meta.env.DEV) throw new Error(REENTRANT_DISPATCH_MESSAGE);
      console.error(REENTRANT_DISPATCH_MESSAGE);
      pending.push(() => update(compute, replay));
      return;
    }
    running = true;
    let entry: StoreQueueEntry;
    try {
      const base = ahead;
      // 전이가 던지면 앞선 상태·React 큐 모두 그대로이고 예외는 호출부로 나간다(렌더가 아니라).
      const next = compute(base);
      ahead = next;
      entry = { base, next, replay };
    } catch (error) {
      // 실패한 전이가 실행 중에 미뤄 둔 재진입 갱신도 버린다 — 남겨 두면 다음 무관한 갱신 뒤에 적용된다(#336 Codex 1회차).
      // running 중에는 바깥 갱신 하나만 돌므로 지금 pending에 있는 것은 전부 이 전이가 넣은 것이다.
      pending.length = 0;
      throw error;
    } finally {
      running = false;
    }
    // 같은 값이어도 항목을 넣는다 — 같은 값 판정(렌더 생략)은 옮기기 전처럼 React에 맡긴다(계획 B4).
    enqueue(entry);
    while (pending.length > 0) (pending.shift() as () => void)();
  }

  return {
    getState: () => ahead,
    dispatch(arg) {
      const transition = toTransition(arg);
      // withoutReceipt는 defineTransition이 붙인다 — 손으로 만든 꼬리표 전이(없을 리 없지만)는 자기 자신으로 다시 적용.
      const replayTransition = typeof transition.withoutReceipt === 'function' ? transition.withoutReceipt() : transition;
      update(
        state => applyPatientTransition(state, transition),
        prev => applyPatientTransition(prev, replayTransition),
      );
      return ahead;
    },
    setActiveId(arg) {
      update(state => applyActiveId(state, arg), prev => applyActiveId(prev, arg));
    },
    setSelectedIds(arg) {
      update(state => applySelectedIds(state, arg), prev => applySelectedIds(prev, arg));
    },
  };
}

/** React 쪽 갱신 함수: base가 같은 객체면 미리 계산된 next를 그대로, 아니면 replay. */
export function resolveQueueEntry(prev: PatientsState, entry: StoreQueueEntry): PatientsState {
  return prev === entry.base ? entry.next : entry.replay(prev);
}
