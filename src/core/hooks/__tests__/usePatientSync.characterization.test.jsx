// @vitest-environment jsdom
//
// T3 — usePatientSync 특성화(REFACTORING_ROADMAP Phase 2 P2-31a, 게이트 A 계획 A8).
// 기존 테스트(usePatientSync.flush.test.jsx·usePatientSync.test.js)가 다루지 않는 동작을
// "지금 동작 그대로" 고정한다: pull 다중 페이지·빈 페이지 중단, 5분 interval, 1초 debounce,
// scope 변경 재pull, stale-pull 가드, 첫 환자 자동 선택, 사라진 활성 환자 교체,
// focus/visibility pull, 권한 거부 배너 카운트.
//
// 하니스는 flush 테스트와 같은 진짜 useState 두 개(patients·activeId) — 훅 인자 모양을
// 바꾸는 C4 리팩터링(P2-32~39)에서도 이 파일은 수정하지 않는다. App이 StrictMode로 돌므로
// 여기서도 StrictMode로 렌더한다(부팅 sync가 이중 effect로 두 번 예약되는 것까지 그대로).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { usePatientSync } from '../usePatientSync.js';

vi.mock('../../services/patientServerRepository', async () => {
  const actual = await vi.importActual('../../services/patientServerRepository');
  return {
    ...actual,
    pushPendingPatients: vi.fn(),
    pullPatients: vi.fn(),
  };
});

import { pushPendingPatients, pullPatients } from '../../services/patientServerRepository';
import { clearAllLockTokens } from '../../services/lockTokenStore';

const SESSION = { mode: 'intranet', apiBaseUrl: 'https://x', accessToken: 'tok', user: { id: 'u1' } };
const FIVE_MINUTES = 5 * 60 * 1000;

function serverPatient(id, overrides = {}) {
  return {
    id,
    data: { shared: { name: id }, modules: {}, activeModules: [] },
    sync: { serverId: `s-${id}`, revision: 1, syncStatus: 'synced' },
    ...overrides,
  };
}

function useHarness({ initialPatients, initialActiveId, scope = 'mine', enabled = true, lockState = { status: 'none' } }) {
  const [patients, setPatients] = useState(initialPatients);
  const [activeId, setActiveId] = useState(initialActiveId === undefined ? (initialPatients[0]?.id ?? null) : initialActiveId);
  const sync = usePatientSync({
    patients, setPatients, activeId, setActiveId,
    session: SESSION, settings: {}, enabled, scope, lockState,
  });
  return { patients, activeId, rawSetPatients: setPatients, ...sync };
}

function renderSync(initialProps) {
  return renderHook(props => useHarness(props), { initialProps, wrapper: StrictMode });
}

// 가짜 타이머 아래에서 마이크로태스크·0ms 타이머·React 커밋을 충분히 흘려보낸다.
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
}

async function advance(ms) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await settle();
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function pullCallParams() {
  return pullPatients.mock.calls.map(([arg]) => arg.params);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearAllLockTokens();
  pullPatients.mockResolvedValue({ items: [], total: 0 });
  pushPendingPatients.mockResolvedValue({ synced: [], failed: [] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('T3 usePatientSync — 부팅', () => {
  it('StrictMode 부팅: startup sync가 두 번 예약되어(두 번째는 큐에 합류) pull이 두 번 일어난다', async () => {
    renderSync({ initialPatients: [] });
    await settle();
    // 첫 effect의 runSync가 진행 중일 때 두 번째 effect의 호출은 queuedRef로 합쳐져 끝난 뒤 한 번 더 돈다.
    expect(pullCallParams()).toEqual([
      { limit: 100, offset: 0, scope: 'mine' },
      { limit: 100, offset: 0, scope: 'mine' },
    ]);
  });

  it('canSync가 거짓이면(enabled=false) 아무 요청도 보내지 않는다', async () => {
    renderSync({ initialPatients: [serverPatient('a', { sync: { serverId: 's-a', revision: 1, syncStatus: 'dirty' } })], enabled: false });
    await advance(FIVE_MINUTES + 2000);
    expect(pullPatients).not.toHaveBeenCalled();
    expect(pushPendingPatients).not.toHaveBeenCalled();
  });
});

describe('T3 usePatientSync — pull 페이지', () => {
  it('total까지 offset을 늘려 가며 여러 페이지를 받아 모두 반영한다', async () => {
    const { result } = renderSync({ initialPatients: [] });
    await settle();
    pullPatients.mockClear();

    const page1 = Array.from({ length: 100 }, (_, i) => serverPatient(`p${i}`));
    const page2 = Array.from({ length: 50 }, (_, i) => serverPatient(`p${100 + i}`));
    pullPatients
      .mockResolvedValueOnce({ items: page1, total: 150 })
      .mockResolvedValueOnce({ items: page2, total: 150 });

    await act(async () => { await result.current.syncNow({ pull: true, reason: 'manual' }); });
    await settle();

    expect(pullCallParams()).toEqual([
      { limit: 100, offset: 0, scope: 'mine' },
      { limit: 100, offset: 100, scope: 'mine' },
    ]);
    expect(result.current.patients).toHaveLength(150);
    expect(result.current.patients[149].id).toBe('p149');
  });

  it('total보다 적게 왔어도 빈 페이지를 받으면 거기서 멈춘다', async () => {
    const { result } = renderSync({ initialPatients: [] });
    await settle();
    pullPatients.mockClear();

    pullPatients
      .mockResolvedValueOnce({ items: [serverPatient('a'), serverPatient('b')], total: 5 })
      .mockResolvedValueOnce({ items: [], total: 5 });

    await act(async () => { await result.current.syncNow({ pull: true }); });
    await settle();

    expect(pullCallParams()).toEqual([
      { limit: 100, offset: 0, scope: 'mine' },
      { limit: 100, offset: 2, scope: 'mine' },
    ]);
    expect(result.current.patients.map(p => p.id)).toEqual(['a', 'b']);
  });

  it('unassignedCount·orgPatientCount를 syncState에 싣고 loadedScope를 pull한 scope로 둔다', async () => {
    pullPatients.mockResolvedValue({ items: [], total: 0, unassignedCount: 3, orgPatientCount: 12 });
    const { result } = renderSync({ initialPatients: [] });
    await settle();
    expect(result.current.syncState).toMatchObject({
      status: 'idle',
      serverUnassignedCount: 3,
      serverPatientCount: 12,
      loadedScope: 'mine',
      lastError: null,
    });
    expect(typeof result.current.syncState.lastSyncedAt).toBe('string');
  });
});

describe('T3 usePatientSync — 타이머', () => {
  it('5분 interval마다 push+pull 한 번(StrictMode에서도 interval은 하나)', async () => {
    renderSync({ initialPatients: [] });
    await settle();
    pullPatients.mockClear();
    pushPendingPatients.mockClear();

    await advance(FIVE_MINUTES - 1);
    expect(pullPatients).not.toHaveBeenCalled();

    await advance(1);
    expect(pullPatients).toHaveBeenCalledTimes(1);
    // 보낼 환자가 없으면 push 네트워크 호출 자체를 생략한다(hasPendingPatients 거짓).
    expect(pushPendingPatients).not.toHaveBeenCalled();

    await advance(FIVE_MINUTES);
    expect(pullPatients).toHaveBeenCalledTimes(2);
  });

  it('로컬 변경(dirty) 뒤 1초 debounce로 push — 창 안의 추가 변경은 타이머를 다시 시작한다', async () => {
    const synced = serverPatient('a');
    // 부팅 pull이 이 환자를 돌려주지 않으면 scope=mine에서 synced 환자는 out-of-scope로 지워진다.
    pullPatients.mockResolvedValue({ items: [serverPatient('a')], total: 1 });
    const { result } = renderSync({ initialPatients: [synced] });
    await settle();
    expect(result.current.patients.map(p => p.id)).toEqual(['a']);
    pushPendingPatients.mockClear();
    pullPatients.mockClear();

    const markDirty = (name) => act(() => {
      result.current.rawSetPatients(prev => prev.map(p => (
        p.id === 'a'
          ? { ...p, data: { ...p.data, shared: { ...p.data.shared, name } }, sync: { ...p.sync, syncStatus: 'dirty' } }
          : p
      )));
    });

    markDirty('first');
    await advance(500);
    markDirty('second');
    await advance(999);
    expect(pushPendingPatients).not.toHaveBeenCalled();

    await advance(1);
    expect(pushPendingPatients).toHaveBeenCalledTimes(1);
    const [pushed] = pushPendingPatients.mock.calls[0];
    expect(pushed.map(p => p.data.shared.name)).toEqual(['second']);
    // local-change 사이클은 push 뒤 pull도 한다.
    expect(pullPatients).toHaveBeenCalledTimes(1);
  });

  it('syncPaused 환자만 dirty면 debounce가 잡히지 않는다', async () => {
    pullPatients.mockResolvedValue({ items: [serverPatient('a')], total: 1 });
    const { result } = renderSync({ initialPatients: [serverPatient('a')], initialActiveId: null });
    await settle();
    pushPendingPatients.mockClear();
    pullPatients.mockClear();

    act(() => {
      result.current.rawSetPatients(prev => prev.map(p => ({ ...p, sync: { ...p.sync, syncStatus: 'dirty', syncPaused: true } })));
    });
    await advance(1500);
    expect(result.current.patients[0].sync).toMatchObject({ syncStatus: 'dirty', syncPaused: true });
    expect(pushPendingPatients).not.toHaveBeenCalled();
    expect(pullPatients).not.toHaveBeenCalled();
  });
});

describe('T3 usePatientSync — scope', () => {
  it('scope가 바뀌면 새 scope로 pull만 한다(push 없음)', async () => {
    const { result, rerender } = renderSync({ initialPatients: [serverPatient('a', { sync: { serverId: 's-a', revision: 1, syncStatus: 'dirty' } })], initialActiveId: null, scope: 'mine' });
    await settle();
    pullPatients.mockClear();
    pushPendingPatients.mockClear();

    rerender({ initialPatients: [], initialActiveId: null, scope: 'all' });
    await settle();

    expect(pullCallParams()).toEqual([{ limit: 100, offset: 0, scope: 'all' }]);
    expect(pushPendingPatients).not.toHaveBeenCalled();
    expect(result.current.syncState.loadedScope).toBe('all');
  });

  it('stale-pull 가드: pull 도중 scope가 바뀌면 옛 scope 결과는 버리고, 큐에 든 새 scope pull만 반영한다', async () => {
    const local = serverPatient('a');
    pullPatients.mockResolvedValue({ items: [serverPatient('a')], total: 1 });
    const { result, rerender } = renderSync({ initialPatients: [local], initialActiveId: null, scope: 'mine' });
    await settle();
    expect(result.current.patients.map(p => p.id)).toEqual(['a']);
    pullPatients.mockClear();

    const minePull = deferred();
    const allPull = deferred();
    pullPatients
      .mockImplementationOnce(() => minePull.promise)
      .mockImplementationOnce(() => allPull.promise);

    let manual;
    act(() => { manual = result.current.syncNow({ pull: true, reason: 'manual' }); });
    rerender({ initialPatients: [local], initialActiveId: null, scope: 'all' });
    await settle();
    expect(pullCallParams()).toEqual([{ limit: 100, offset: 0, scope: 'mine' }]);

    // mine 결과(빈 목록)를 all 화면에 적용했다면 synced 환자 a가 out-of-scope로 지워졌을 것이다.
    await act(async () => { minePull.resolve({ items: [], total: 0 }); await manual; });
    await settle();
    expect(result.current.patients.map(p => p.id)).toEqual(['a']);
    expect(result.current.syncState.loadedScope).toBe('mine');
    expect(pullCallParams()).toEqual([
      { limit: 100, offset: 0, scope: 'mine' },
      { limit: 100, offset: 0, scope: 'all' },
    ]);

    await act(async () => { allPull.resolve({ items: [serverPatient('a'), serverPatient('b')], total: 2 }); });
    await settle();
    expect(result.current.patients.map(p => p.id)).toEqual(['a', 'b']);
    expect(result.current.syncState.loadedScope).toBe('all');
  });
});

describe('T3 usePatientSync — 활성 환자', () => {
  it('목록이 비어 있고 활성 환자가 없을 때 pull로 환자가 생기면 첫 환자를 선택한다', async () => {
    pullPatients.mockResolvedValue({ items: [serverPatient('a'), serverPatient('b')], total: 2 });
    const { result } = renderSync({ initialPatients: [], initialActiveId: null });
    await settle();
    expect(result.current.activeId).toBe('a');
  });

  it('로컬 환자가 이미 있으면(활성 없음) pull 뒤에도 자동 선택하지 않는다', async () => {
    pullPatients.mockResolvedValue({ items: [serverPatient('a')], total: 1 });
    const local = { id: 'local-1', data: { shared: {}, modules: {}, activeModules: [] }, sync: { syncStatus: 'local-only' } };
    const { result } = renderSync({ initialPatients: [local], initialActiveId: null });
    await settle();
    expect(result.current.patients.map(p => p.id)).toEqual(['local-1', 'a']);
    expect(result.current.activeId).toBeNull();
  });

  it('pull로 활성 환자가 사라지면 남은 첫 환자로 바꾼다(scope=all의 권위 있는 삭제)', async () => {
    const { result } = renderSync({ initialPatients: [serverPatient('a'), serverPatient('b')], initialActiveId: 'a', scope: 'all' });
    pullPatients.mockResolvedValue({ items: [serverPatient('b')], total: 1 });
    await settle();
    expect(result.current.patients.map(p => p.id)).toEqual(['b']);
    expect(result.current.activeId).toBe('b');
  });

  it('pull로 모든 환자가 사라지면 활성 환자는 null', async () => {
    const { result } = renderSync({ initialPatients: [serverPatient('a')], initialActiveId: 'a', scope: 'all' });
    await settle();
    expect(result.current.patients).toEqual([]);
    expect(result.current.activeId).toBeNull();
  });
});

describe('T3 usePatientSync — focus·visibility', () => {
  let visibility = 'visible';
  beforeEach(() => {
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });

  it('창 focus는 pull만 한다(dirty 환자가 있어도 push 없음)', async () => {
    pullPatients.mockResolvedValue({ items: [serverPatient('a')], total: 1 });
    const { result } = renderSync({ initialPatients: [serverPatient('a', { sync: { serverId: 's-a', revision: 1, syncStatus: 'dirty' } })], initialActiveId: null });
    // dirty가 남아 1초 debounce가 계속 잡히지 않게 push를 성공 ack로 둔다.
    pushPendingPatients.mockImplementation(async (patients) => ({
      synced: patients.map(p => ({ patient: p, serverPatient: { ...p, sync: { ...p.sync, syncStatus: 'synced', revision: 2 } } })),
      failed: [],
    }));
    await settle();
    await advance(1500);
    pullPatients.mockClear();
    pushPendingPatients.mockClear();

    act(() => {
      result.current.rawSetPatients(prev => prev.map(p => ({ ...p, sync: { ...p.sync, syncStatus: 'dirty' } })));
    });
    expect(result.current.patients[0].sync.syncStatus).toBe('dirty');
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settle();
    expect(pullPatients).toHaveBeenCalledTimes(1);
    expect(pushPendingPatients).not.toHaveBeenCalled();
  });

  it('visibilitychange는 visible일 때만 pull', async () => {
    renderSync({ initialPatients: [] });
    await settle();
    pullPatients.mockClear();

    visibility = 'hidden';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(pullPatients).not.toHaveBeenCalled();

    visibility = 'visible';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    expect(pullPatients).toHaveBeenCalledTimes(1);
  });

  it('언마운트 뒤에는 focus로 요청하지 않는다', async () => {
    const { unmount } = renderSync({ initialPatients: [] });
    await settle();
    pullPatients.mockClear();
    unmount();
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(pullPatients).not.toHaveBeenCalled();
  });
});

describe('T3 usePatientSync — 권한 거부 배너', () => {
  it('push 403은 lastPermissionDeniedCount·At을 남기고, 다음 성공 sync에서 0·null로 지운다', async () => {
    const dirty = serverPatient('a', { sync: { serverId: 's-a', revision: 1, syncStatus: 'dirty' } });
    const permissionError = Object.assign(new Error('forbidden'), { status: 403 });
    pushPendingPatients.mockImplementation(async (patients) => ({
      synced: [],
      failed: patients.map(p => ({ patient: p, error: permissionError, kind: 'permission' })),
    }));

    const { result } = renderSync({ initialPatients: [dirty], initialActiveId: null });
    await settle();

    expect(result.current.syncState.lastPermissionDeniedCount).toBe(1);
    expect(typeof result.current.syncState.lastPermissionDeniedAt).toBe('string');
    expect(result.current.syncState.lastPermissionDeniedAt).toBe(result.current.syncState.lastSyncedAt);
    expect(result.current.syncState.status).toBe('idle');
    // 권한 실패만으로는 환자 상태를 바꾸지 않는다(dirty 그대로).
    expect(result.current.patients[0].sync.syncStatus).toBe('dirty');

    // 다음 sync(pull만)에서 권한 실패가 없으면 배너 카운트를 지운다.
    await act(async () => { await result.current.syncNow({ pull: true }); });
    await settle();
    expect(result.current.syncState.lastPermissionDeniedCount).toBe(0);
    expect(result.current.syncState.lastPermissionDeniedAt).toBeNull();
  });

  it('conflict·permission·lock이 아닌 실패는 status=error와 오류 문구로 끝난다', async () => {
    const dirty = serverPatient('a', { sync: { serverId: 's-a', revision: 1, syncStatus: 'dirty' } });
    pushPendingPatients.mockImplementation(async (patients) => ({
      synced: [],
      failed: patients.map(p => ({ patient: p, error: new Error('boom'), kind: 'error' })),
    }));
    const { result } = renderSync({ initialPatients: [dirty], initialActiveId: null });
    await settle();
    expect(result.current.syncState.status).toBe('error');
    expect(result.current.syncState.lastError).toBe('boom');
  });
});
