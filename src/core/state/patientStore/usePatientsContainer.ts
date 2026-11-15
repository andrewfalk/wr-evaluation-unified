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
// - (P2-40a, 게이트 B 설계 3) 안쪽은 "앞서 실행하는 스토어 + 함수형 갱신 큐"다: setter는 스토어(store.ts)에 묶여 전이를
//   지금 한 번 실행해 앞선 상태를 갱신하고, React에는 지금처럼 setState(함수)를 한 번 넣는다(prev가 base와 같으면 미리 계산된
//   next를 그대로). 커밋 구성·렌더 횟수·다른 setState와의 lane 관계는 옮기기 전과 같다. 반환에 `store`가 더해졌다.
import { useState } from 'react';
import type { PatientRecord } from '../../types/patient';
import {
  createPatientsState,
  type ActiveIdUpdater, type PatientsState, type ValueOrUpdater,
} from './reducer';
import { createPatientStore, resolveQueueEntry, UNTAGGED_SET_PATIENTS_MESSAGE, type PatientStore } from './store';
import type { PatientTransition } from './transitions';

export type SetPatients = (transition: PatientTransition) => void;

export { UNTAGGED_SET_PATIENTS_MESSAGE };

/** 값 또는 updater(옮기기 전 useState와 같은 한 인자, reducer.ts ActiveIdUpdater). */
export type SetActiveId = (arg: string | null | ActiveIdUpdater) => void;
export type SetSelectedIds = (arg: ValueOrUpdater<Set<string>>) => void;

export interface PatientsContainer {
  patients: PatientRecord[];
  setPatients: SetPatients;
  activeId: string | null;
  setActiveId: SetActiveId;
  selectedIds: Set<string>;
  setSelectedIds: SetSelectedIds;
  /** 앞서 실행하는 스토어(P2-40a) — sync 엔진만 getState()를 읽는다(훅 본문·이벤트 핸들러 금지, 래칫 storeGetStateOutsideSync). */
  store: PatientStore;
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
  // 스토어는 React 초기 상태와 **같은 객체**에서 시작한다(state는 첫 렌더의 초기값). 인스턴스는 컨테이너(= App, 작업 공간 경계 아래)
  // 하나당 하나 — 모듈 싱글턴이면 계정이 바뀌어 App이 다시 마운트돼도 이전 계정의 목록이 살아남는다(계정 전환 수정 AS-4).
  // StrictMode가 초기화 함수를 두 번 불러도 생성에는 부수효과가 없다. setState는 참조 고정이라 enqueue도 고정.
  const [api] = useState(() => {
    const store = createPatientStore(state, (entry) => { setState(prev => resolveQueueEntry(prev, entry)); });
    const setPatients: SetPatients = (arg) => { store.dispatch(arg); };
    const setActiveId: SetActiveId = (arg) => { store.setActiveId(arg); };
    const setSelectedIds: SetSelectedIds = (arg) => { store.setSelectedIds(arg); };
    return { store, setPatients, setActiveId, setSelectedIds };
  });
  const { store, setPatients, setActiveId, setSelectedIds } = api;

  return {
    patients: state.patients, setPatients,
    activeId: state.activeId, setActiveId,
    selectedIds: state.selectedIds, setSelectedIds,
    store,
  };
}
