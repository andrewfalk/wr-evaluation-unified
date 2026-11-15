// @vitest-environment jsdom
//
// F7 대조 테스트(REFACTORING_ROADMAP Phase 2 P2-40a, 게이트 B 계획 B1·B1b) — 스토어를 React에 잇는 방식 넷을 같은 사건 순서로
// 돌려 **커밋된 값 조합의 순서**를 비교한다.
//   old    : 옮기기 전 컨테이너(useState 하나 위 함수형 갱신)
//   uses   : useSyncExternalStore 연결
//   mirror : 스토어 전체 스냅샷을 값으로 넣는 미러(dispatch 뒤 setSnapshot(store.getState()))
//   store  : 이 구현(usePatientsContainer — 앞서 실행하는 스토어 + 함수형 갱신 큐)
// 사례 ① 매크로태스크 뒤 dispatch + 다른 setState(스텝) ② 그 갱신이 대기 중일 때 클릭(SyncLane)이 다른 dispatch를 일으킴.
// 단언: store는 old와 같은 순서이고, uses·mirror는 "목록은 새 값, 스텝은 옛 값"인 중간 커밋을 만든다.
//
// act를 쓰지 않는다 — act는 lane을 한 번에 비워 실제 스케줄 순서를 감춘다. 그래서 testing-library를 import하지 않고
// IS_REACT_ACT_ENVIRONMENT를 끈 채 createRoot로 직접 렌더한다(StrictMode).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { StrictMode, useCallback, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { usePatientsContainer } from '../usePatientsContainer';
import { applyPatientTransition, createPatientsState } from '../reducer';
import { defineTransition } from '../transitions';

const t1 = defineTransition('test/t1', prev => [...prev, { id: 't1' }]);
const t2 = defineTransition('test/t2', prev => [...prev, { id: 't2' }]);

function useOldContainer() {
  const [state, setState] = useState(() => createPatientsState([]));
  const dispatch = useCallback((t) => { setState(s => applyPatientTransition(s, t)); }, []);
  return { patients: state.patients, dispatch };
}

function createExternalStore() {
  let state = createPatientsState([]);
  const listeners = new Set();
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispatch(t) {
      state = applyPatientTransition(state, t);
      for (const listener of listeners) listener();
    },
  };
}

function makeUses() {
  const external = createExternalStore();
  return function useUsesContainer() {
    const state = useSyncExternalStore(external.subscribe, external.getState);
    return { patients: state.patients, dispatch: external.dispatch };
  };
}

function makeMirror() {
  const external = createExternalStore();
  return function useMirrorContainer() {
    const [snapshot, setSnapshot] = useState(external.getState);
    const dispatch = useCallback((t) => { external.dispatch(t); setSnapshot(external.getState()); }, []);
    return { patients: snapshot.patients, dispatch };
  };
}

function useStoreContainer() {
  const { patients, setPatients } = usePatientsContainer();
  return { patients, dispatch: setPatients };
}

const VARIANTS = {
  old: () => useOldContainer,
  uses: makeUses,
  mirror: makeMirror,
  store: () => useStoreContainer,
};

function Harness({ useImpl, log, apiRef }) {
  const { patients, dispatch } = useImpl();
  const [step, setStep] = useState(0);
  useLayoutEffect(() => {
    log.push(`${patients.map(p => p.id).join('+') || '-'}|${step}`);
  });
  useLayoutEffect(() => {
    apiRef.current = { dispatch, setStep };
  }, [apiRef, dispatch]);
  return <button type="button" onClick={() => dispatch(t2({}))}>t2</button>;
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let mounted = [];
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  // jsdom은 타이머 안에서 보낸 클릭 뒤 window.event를 그 클릭으로 남겨 둔다(실제 브라우저는 undefined로 되돌림). React는
  // 이벤트 밖 갱신의 우선순위를 window.event로 정하므로, 그대로 두면 다음 사례의 타이머 갱신까지 전부 SyncLane이 된다.
  // React 이벤트 처리기 안의 갱신은 window.event와 무관하게 Discrete 우선순위다 — 브라우저처럼 늘 undefined로 둔다.
  Object.defineProperty(window, 'event', { configurable: true, get: () => undefined });
});
afterEach(() => {
  for (const { root, host } of mounted) { root.unmount(); host.remove(); }
  mounted = [];
});

async function runScenario(variant, scenario) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const log = [];
  const apiRef = { current: null };
  const useImpl = VARIANTS[variant]();
  root.render(<StrictMode><Harness useImpl={useImpl} log={log} apiRef={apiRef} /></StrictMode>);
  await wait(30);
  log.length = 0; // 마운트 커밋(StrictMode 이중 effect 포함)은 비교하지 않는다
  const button = host.querySelector('button');
  setTimeout(() => {
    apiRef.current.dispatch(t1({}));
    apiRef.current.setStep(1);
    if (scenario === 'interleavedClick') button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, 0);
  await wait(60);
  // 사례마다 루트를 내린다 — 같은 문서에 이전 사례의 루트가 남아 있으면 클릭의 동기 렌더가 대기 중이던 갱신과 합쳐져
  // (여러 루트를 한 번에 비우는 경로) 첫 사례와 결과가 달라졌다.
  root.unmount();
  host.remove();
  mounted = mounted.filter(m => m.root !== root);
  return log;
}

describe('F7 — React 연결 방식별 커밋 순서(act 없이, StrictMode)', () => {
  it('① 매크로태스크 뒤 dispatch + setStep: store는 old와 같고(한 커밋), uses는 "새 목록 + 옛 스텝" 중간 커밋을 만든다', async () => {
    const results = {};
    for (const variant of Object.keys(VARIANTS)) results[variant] = await runScenario(variant, 'plain');
    expect(results.old).toEqual(['t1|1']);
    expect(results.store).toEqual(results.old);
    expect(results.mirror).toEqual(['t1|1']); // 둘 다 DefaultLane이라 이 사례에서는 합쳐진다
    expect(results.uses).toEqual(['t1|0', 't1|1']); // 스토어 갱신은 SyncLane — 스텝(DefaultLane)보다 먼저 커밋
  });

  it('② 그 갱신이 대기 중일 때 클릭이 다른 dispatch를 일으킴: store는 old와 같고, uses·mirror는 대기 중이던 t1을 옛 스텝과 함께 먼저 커밋한다', async () => {
    const results = {};
    for (const variant of Object.keys(VARIANTS)) results[variant] = await runScenario(variant, 'interleavedClick');
    // old: 클릭(SyncLane)은 자기 갱신(t2)만 옛 상태에 적용해 먼저 커밋하고, 대기 중이던 t1·스텝은 다음 커밋에 함께 들어간다.
    expect(results.old).toEqual(['t2|0', 't1+t2|1']);
    expect(results.store).toEqual(results.old);
    // uses·mirror: 클릭의 동기 렌더에 대기 중이던 t1이 실려(스냅샷 값) 스텝 1 없이 먼저 커밋된다 — 중간 커밋(B1b).
    expect(results.uses).toEqual(['t1+t2|0', 't1+t2|1']);
    expect(results.mirror).toEqual(['t1+t2|0', 't1+t2|1']);
  });
});
