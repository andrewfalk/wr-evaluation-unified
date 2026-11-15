// 환자 스토어 코어(REFACTORING_ROADMAP Phase 2 P2-40a, 게이트 B 계획 설계 1·3) — React 없이.
// dispatch 때 한 번 실행 · base가 같으면 재실행 없음 · 건너뛴 뒤 최종 상태가 스토어 객체와 같음 · replay가 receipt를 덮지 않음 ·
// 재진입 throw · 전이 예외는 호출부로 · derive.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPatientStore, resolveQueueEntry, REENTRANT_DISPATCH_MESSAGE, UNTAGGED_SET_PATIENTS_MESSAGE } from '../store';
import { createPatientsState } from '../reducer';
import { defineTransition, patientTx } from '../transitions';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function setup(patients = [], extras) {
  const queue = [];
  const store = createPatientStore(createPatientsState(patients, extras), entry => { queue.push(entry); });
  return { store, queue };
}

/** React 큐 처리 흉내: entries를 순서대로 prev에 적용(옮기기 전 컨테이너와 같은 함수형 갱신). */
const drain = (prev, entries) => entries.reduce((state, entry) => resolveQueueEntry(state, entry), prev);

function countingTx(type, add) {
  let calls = 0;
  const make = defineTransition(type, (prev) => { calls += 1; return [...prev, { id: add }]; });
  return { make, calls: () => calls };
}

describe('createPatientStore', () => {
  it('dispatch는 전이를 지금 한 번 실행해 앞선 상태를 갱신하고, 큐에 { base, next } 항목을 넣는다', () => {
    const { store, queue } = setup([{ id: 'a' }]);
    const initial = store.getState();
    const tx = countingTx('test/add', 'b');
    const returned = store.dispatch(tx.make({}));
    expect(tx.calls()).toBe(1);
    expect(store.getState().patients.map(p => p.id)).toEqual(['a', 'b']);
    expect(returned).toBe(store.getState());
    expect(queue).toHaveLength(1);
    expect(queue[0].base).toBe(initial);
    expect(queue[0].next).toBe(store.getState());
  });

  it('React가 base와 같은 prev로 처리하면 미리 계산된 next를 그대로 쓴다(전이 재실행 없음, 같은 객체)', () => {
    const { store, queue } = setup([]);
    const initial = store.getState();
    const tx = countingTx('test/add', 'x');
    store.dispatch(tx.make({}));
    const committed = drain(initial, queue);
    expect(committed).toBe(store.getState());
    expect(tx.calls()).toBe(1);
  });

  it('lane 건너뛰기: 뒤 항목을 먼저 옛 상태에 replay해도, 원래 순서로 다시 처리한 최종 상태는 스토어 객체와 같다', () => {
    const { store, queue } = setup([]);
    const initial = store.getState();
    const first = countingTx('test/first', 'f');
    const second = countingTx('test/second', 's');
    store.dispatch(first.make({}));
    store.dispatch(second.make({}));
    // 동기 렌더: 첫 항목(DefaultLane)을 건너뛰고 둘째만 옛 상태에 — replay로 다시 계산
    const transient = resolveQueueEntry(initial, queue[1]);
    expect(transient.patients.map(p => p.id)).toEqual(['s']);
    expect(second.calls()).toBe(2);
    // 다음 렌더: 건너뛴 항목부터 원래 순서로 — base가 같아 미리 계산된 값
    const final = drain(initial, queue);
    expect(final).toBe(store.getState());
    expect(final.patients.map(p => p.id)).toEqual(['f', 's']);
    expect(second.calls()).toBe(2);
  });

  it('같은 목록을 내는 전이도 항목을 넣는다(같은 값 판정은 React에 맡긴다) — next는 base 그대로', () => {
    const { store, queue } = setup([{ id: 'a' }]);
    const before = store.getState();
    store.dispatch(defineTransition('test/keep', prev => prev)({}));
    expect(store.getState()).toBe(before);
    expect(queue).toHaveLength(1);
    expect(queue[0].next).toBe(queue[0].base);
  });

  it('replay는 receipt를 버린 사본으로 돌려 이미 읽힌 receipt를 덮지 않는다', () => {
    const { store, queue } = setup([{ id: 'a', data: { shared: { patientNo: 'P1' } } }]);
    const receipt = {};
    store.dispatch(patientTx.sharedPatched({
      id: 'a', requested: { patientNo: 'P1' }, patch: shared => ({ ...shared, x: 1 }), session: null, receipt,
    }));
    expect(receipt.applied).toBe(true);
    // 다른 prev(대상 환자가 없음)로 replay — 사본 전이는 receipt에 쓰지 않는다
    const replayed = queue[0].replay(createPatientsState([]));
    expect(replayed.patients).toEqual([]);
    expect(receipt.applied).toBe(true);
  });

  it('전이 실행 중 다시 dispatch하면 개발·테스트에서는 던지고, 앞선 상태·큐는 그대로다', () => {
    const { store, queue } = setup([]);
    const before = store.getState();
    const reentrant = defineTransition('test/reentrant', (prev) => {
      store.dispatch(patientTx.appended({ patients: [{ id: 'inner' }] }));
      return prev;
    });
    expect(() => store.dispatch(reentrant({}))).toThrow(REENTRANT_DISPATCH_MESSAGE);
    expect(store.getState()).toBe(before);
    expect(queue).toHaveLength(0);
    // 실패 뒤에도 다음 dispatch는 정상
    store.dispatch(patientTx.appended({ patients: [{ id: 'ok' }] }));
    expect(store.getState().patients.map(p => p.id)).toEqual(['ok']);
  });

  it('운영 빌드의 재진입은 오류를 남기고 바깥 갱신 뒤에 이어서 적용한다(앞선 상태와 큐가 어긋나지 않음)', () => {
    vi.stubEnv('DEV', false);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, queue } = setup([]);
    const initial = store.getState();
    const reentrant = defineTransition('test/reentrant', (prev) => {
      store.dispatch(patientTx.appended({ patients: [{ id: 'inner' }] }));
      return [...prev, { id: 'outer' }];
    });
    store.dispatch(reentrant({}));
    expect(error).toHaveBeenCalledWith(REENTRANT_DISPATCH_MESSAGE);
    expect(store.getState().patients.map(p => p.id)).toEqual(['outer', 'inner']);
    expect(drain(initial, queue)).toBe(store.getState());
  });

  it('운영 빌드: 재진입을 미뤄 둔 바깥 전이가 실패하면 미룬 갱신도 버린다(다음 dispatch에 섞이지 않음, #336 Codex)', () => {
    vi.stubEnv('DEV', false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, queue } = setup([]);
    const before = store.getState();
    const failing = defineTransition('test/failing', () => {
      store.dispatch(patientTx.appended({ patients: [{ id: 'inner' }] }));
      throw new Error('outer failed');
    });
    expect(() => store.dispatch(failing({}))).toThrow('outer failed');
    expect(store.getState()).toBe(before);
    expect(queue).toHaveLength(0);
    store.dispatch(patientTx.appended({ patients: [{ id: 'ok' }] }));
    expect(store.getState().patients.map(p => p.id)).toEqual(['ok']);
    expect(queue).toHaveLength(1);
  });

  it('전이가 던진 예외는 dispatch 호출부로 나가고 앞선 상태·큐는 그대로다', () => {
    const { store, queue } = setup([{ id: 'a' }]);
    const before = store.getState();
    const boom = defineTransition('test/boom', () => { throw new Error('boom'); });
    expect(() => store.dispatch(boom({}))).toThrow('boom');
    expect(store.getState()).toBe(before);
    expect(queue).toHaveLength(0);
  });

  it('꼬리표 없는 인자: 개발·테스트는 던지고, 운영은 오류(인자 종류만)를 남긴 뒤 옛 방식대로 적용', () => {
    const { store } = setup([{ id: 'a' }]);
    expect(() => store.dispatch([{ id: 'b' }])).toThrow(UNTAGGED_SET_PATIENTS_MESSAGE);
    expect(store.getState().patients.map(p => p.id)).toEqual(['a']);
    vi.stubEnv('DEV', false);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.dispatch(prev => [...prev, { id: 'c' }]);
    expect(store.getState().patients.map(p => p.id)).toEqual(['a', 'c']);
    expect(error.mock.calls[0]).toEqual([UNTAGGED_SET_PATIENTS_MESSAGE, { argKind: 'function' }]);
  });

  it('derive가 있는 전이는 같은 적용에서 활성 환자를 정한다(직전 상태·새 목록·payload를 받음)', () => {
    const { store } = setup([{ id: 'a' }, { id: 'b' }], { activeId: 'a' });
    const seen = [];
    const removeWithFallback = defineTransition('test/remove', (prev, { id }) => prev.filter(p => p.id !== id), {
      derive: (prevState, nextPatients, payload) => {
        seen.push([prevState.activeId, nextPatients.map(p => p.id), payload.id]);
        return nextPatients.some(p => p.id === prevState.activeId) ? {} : { activeId: nextPatients[0]?.id ?? null };
      },
    });
    store.dispatch(removeWithFallback({ id: 'a' }));
    expect(store.getState().activeId).toBe('b');
    store.dispatch(removeWithFallback({ id: 'b' }));
    expect(store.getState().activeId).toBeNull();
    expect(seen).toEqual([['a', ['b'], 'a'], ['b', [], 'b']]);
    // derive 결과가 그대로면(키 없음) 같은 상태 객체
    const before = store.getState();
    store.dispatch(removeWithFallback({ id: 'zzz' }));
    expect(store.getState().patients).toEqual([]);
    expect(store.getState().activeId).toBeNull();
    expect(store.getState()).not.toBe(before); // filter는 늘 새 배열(참조 동작 보존 — 전이 규칙)
  });

  it('setActiveId·setSelectedIds도 앞선 상태를 갱신하고 큐에 항목을 넣는다(값·updater)', () => {
    const { store, queue } = setup([{ id: 'a' }, { id: 'b' }]);
    const initial = store.getState();
    store.dispatch(patientTx.appended({ patients: [{ id: 'c' }] }));
    store.setActiveId(prev => (prev === null ? 'c' : prev));
    store.setSelectedIds(prev => new Set([...prev, 'a']));
    expect(store.getState().activeId).toBe('c');
    expect([...store.getState().selectedIds]).toEqual(['a']);
    expect(queue).toHaveLength(3);
    expect(drain(initial, queue)).toBe(store.getState());
  });
});
