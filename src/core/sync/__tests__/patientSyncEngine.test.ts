// 환자 동기화 엔진 단위 테스트(REFACTORING_ROADMAP Phase 2 P2-41d, 게이트 B 계획 설계 4) — React 없이, 진짜 createPatientStore +
// fake timer. 엔진이 스토어를 구독하지 않고 타이머도 갖지 않으므로 트리거는 테스트가 직접 부른다(훅의 effect 몫).
// push 중 로컬 편집 · push 중 큐 합류 · pull 중 scope 변경 · 비활성화 순간의 push · 정지 뒤 재시작 · 423·403·409·오프라인 분류 ·
// flush waiter의 cycle 규칙.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPatientSyncEngine, type SyncInputs, type SyncState } from '../patientSyncEngine';
import { createPatientStore } from '../../state/patientStore/store';
import { createPatientsState } from '../../state/patientStore/reducer';
import { patientTx } from '../../state/patientStore/transitions';
import type { PatientRecord } from '../../types/patient';

vi.mock('../../services/patientServerRepository', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../services/patientServerRepository');
  return { ...actual, pushPendingPatients: vi.fn(), pullPatients: vi.fn() };
});

import { pushPendingPatients, pullPatients } from '../../services/patientServerRepository';
import { clearAllLockTokens } from '../../services/lockTokenStore';

const push = pushPendingPatients as unknown as ReturnType<typeof vi.fn>;
const pull = pullPatients as unknown as ReturnType<typeof vi.fn>;
const SESSION = { mode: 'intranet', apiBaseUrl: 'https://x', accessToken: 'tok', user: { id: 'u1' } };

function patient(id: string, sync: Record<string, unknown> = {}): PatientRecord {
  return {
    id,
    data: { shared: { name: id }, modules: {}, activeModules: [] },
    sync: { serverId: `s-${id}`, revision: 1, syncStatus: 'synced', ...sync },
  } as unknown as PatientRecord;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function setup(initial: PatientRecord[], activeId: string | null = initial[0]?.id ?? null) {
  const store = createPatientStore(createPatientsState(initial, { activeId }), () => {});
  const inputs: SyncInputs = { session: SESSION, settings: {}, scope: 'mine', lockState: { status: 'none' }, enabled: true };
  let state: SyncState = {
    status: 'idle', lastSyncedAt: null, lastError: null, serverUnassignedCount: null, serverPatientCount: null, loadedScope: null,
  };
  const engine = createPatientSyncEngine({ store, getInputs: () => inputs, setSyncState: (u) => { state = u(state); } });
  return { store, inputs, engine, syncState: () => state };
}

const flushMicrotasks = async () => { await vi.advanceTimersByTimeAsync(0); };
const ofStore = (store: ReturnType<typeof setup>['store'], id: string) => store.getState().patients.find(p => p.id === id) as unknown as { sync: Record<string, unknown>; data: { shared: { name: string } } };
const ack = (p: PatientRecord, revision: number) => ({ patient: p, serverPatient: patient(p.id, { revision }) });
const pendingSent = (call: unknown[]) => (call[0] as PatientRecord[])
  .filter(p => ['dirty', 'local-only'].includes((p as unknown as { sync: { syncStatus: string } }).sync.syncStatus))
  .map(p => `${p.id}@${(p as unknown as { sync: { revision: number } }).sync.revision}`);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearAllLockTokens();
  pull.mockResolvedValue({ items: [], total: 0 });
  push.mockResolvedValue({ synced: [], failed: [] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createPatientSyncEngine', () => {
  it('push 중 로컬 편집: ACK가 병합돼도 편집은 dirty로 남고, 다음 사이클은 새 revision으로 그 편집만 보낸다', async () => {
    const { store, engine } = setup([patient('a', { syncStatus: 'dirty' })]);
    const first = deferred<unknown>();
    push.mockImplementationOnce(() => first.promise);
    const run = engine.runSync({ push: true, reason: 'test' });
    await flushMicrotasks();
    const pushed = (push.mock.calls[0][0] as PatientRecord[])[0];
    // 응답을 기다리는 동안 로컬 편집
    store.dispatch(patientTx.dataEdited({ id: 'a', edit: { shared: { name: 'edited' } }, session: SESSION, stampUpdatedAt: true } as never));
    first.resolve({ synced: [ack(pushed, 2)], failed: [] });
    await run;
    expect(ofStore(store, 'a').sync).toMatchObject({ revision: 2, syncStatus: 'dirty' });
    expect(ofStore(store, 'a').data.shared.name).toBe('edited');
    await engine.runSync({ push: true, reason: 'next' });
    expect(pendingSent(push.mock.calls[1])).toEqual(['a@2']); // 옛 revision 재전송 없음(I1)
  });

  it('push 중 큐 합류: 진행 중이면 null, 큐는 push·pull을 OR로 합쳐 끝난 뒤 한 번 돈다', async () => {
    const { engine } = setup([patient('a', { syncStatus: 'dirty' })]);
    const first = deferred<unknown>();
    push.mockImplementationOnce(() => first.promise);
    void engine.runSync({ push: true, reason: 'a' });
    await flushMicrotasks();
    expect(await engine.runSync({ pull: true, reason: 'b' })).toBeNull();
    expect(await engine.runSync({ push: true, reason: 'c' })).toBeNull();
    first.resolve({ synced: [], failed: [] });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(push).toHaveBeenCalledTimes(2);
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('pull 중 scope가 바뀌면 그 결과는 적용하지 않는다(stale-pull 가드, loadedScope 그대로)', async () => {
    const { store, inputs, engine, syncState } = setup([patient('a')]);
    const page = deferred<unknown>();
    pull.mockImplementationOnce(() => page.promise);
    const run = engine.runSync({ pull: true, reason: 'test' });
    await flushMicrotasks();
    inputs.scope = 'all';
    page.resolve({ items: [patient('z')], total: 1 });
    await run;
    expect(store.getState().patients.map(p => p.id)).toEqual(['a']);
    expect(syncState().loadedScope).toBeNull();
  });

  it('비활성화 순간의 push: ACK를 버리고 idle로 끝나며 큐를 돌리지 않는다(D1 — 이 구간은 보존)', async () => {
    const { store, inputs, engine, syncState } = setup([patient('a', { syncStatus: 'dirty' })]);
    const first = deferred<unknown>();
    push.mockImplementationOnce(() => first.promise);
    const run = engine.runSync({ push: true, reason: 'test' });
    await flushMicrotasks();
    void engine.runSync({ pull: true, reason: 'queued' });
    inputs.enabled = false;
    const pushed = (push.mock.calls[0][0] as PatientRecord[])[0];
    first.resolve({ synced: [ack(pushed, 2)], failed: [] });
    expect(await run).toBeNull();
    await flushMicrotasks();
    expect(ofStore(store, 'a').sync).toMatchObject({ revision: 1, syncStatus: 'dirty' });
    expect(syncState().status).toBe('idle');
    expect(pull).not.toHaveBeenCalled();
  });

  it('정지 뒤 재시작: 꺼져 있으면 runSync·flush가 바로 끝나고(null·error), 다시 켜면 다음 호출부터 돈다', async () => {
    const { inputs, engine } = setup([patient('a', { syncStatus: 'dirty' })]);
    inputs.enabled = false;
    expect(await engine.runSync({ push: true })).toBeNull();
    expect(await engine.flushPatient('a')).toBe('error');
    expect(push).not.toHaveBeenCalled();
    inputs.enabled = true;
    await engine.runSync({ push: true, reason: 'restart' });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['lock', 423, 'lock-lost', 'conflict'],
    ['permission', 403, 'permission', 'dirty'],
    ['conflict', 409, 'conflict', 'conflict'],
    ['offline', undefined, 'offline', 'dirty'],
  ])('실패 분류 %s(%s) → flush 결과 %s, 환자 상태 %s', async (kind, status, outcome, syncStatus) => {
    const { store, engine } = setup([patient('x'), patient('b', { syncStatus: 'dirty' })], 'x');
    push.mockImplementationOnce(async (targets: PatientRecord[]) => ({
      synced: [],
      failed: targets.filter(p => p.id === 'b').map(p => ({
        patient: p, kind,
        error: Object.assign(new Error(kind), status ? { status, data: { currentRevision: 2 } } : {}),
      })),
    }));
    const result = await engine.flushPatient('b');
    expect(result).toBe(outcome);
    expect(ofStore(store, 'b').sync.syncStatus).toBe(syncStatus);
  });

  it('flush waiter의 cycle 규칙: 진행 중 사이클의 결과로는 풀리지 않고, 그 뒤 새로 시작한 사이클의 결과로 풀린다', async () => {
    const { store, engine } = setup([patient('x'), patient('b', { syncStatus: 'dirty' })], 'x');
    const first = deferred<unknown>();
    push.mockImplementationOnce(() => first.promise);
    void engine.runSync({ push: true, reason: 'running' });
    await flushMicrotasks();
    let outcome: string | undefined;
    void engine.flushPatient('b').then(o => { outcome = o; });
    // 큐에 합류한 flush 사이클(2)의 응답: 성공 ACK
    const second = deferred<unknown>();
    push.mockImplementationOnce(() => second.promise);
    // 진행 중 사이클(1)의 결과에 b의 판정이 있어도(여기서는 403) 목표 사이클 전이라 풀리지 않는다
    first.resolve({ synced: [], failed: [{ patient: patient('b', { syncStatus: 'dirty' }), kind: 'permission', error: Object.assign(new Error('x'), { status: 403 }) }] });
    await flushMicrotasks();
    expect(outcome).toBeUndefined(); // cycle 1 < 목표 cycle 2
    expect(push).toHaveBeenCalledTimes(2); // 큐의 flush 사이클이 시작됨
    const sent = (push.mock.calls[1][0] as PatientRecord[]).filter(p => p.id === 'b');
    second.resolve({ synced: sent.map(p => ack(p, 2)), failed: [] });
    await flushMicrotasks();
    expect(outcome).toBe('synced');
    expect(ofStore(store, 'b').sync).toMatchObject({ revision: 2, syncStatus: 'synced' });
  });

  it('settleWaiters는 이미 결론이 난(synced·conflict) 환자만 풀고, disposeWaiters는 남은 것을 error로 푼다', async () => {
    const { engine } = setup([patient('x'), patient('b', { syncStatus: 'dirty' }), patient('c', { syncStatus: 'dirty' })], 'x');
    const hold = deferred<unknown>();
    push.mockImplementation(() => hold.promise);
    const results: Record<string, string> = {};
    void engine.flushPatient('b').then(o => { results.b = o; });
    void engine.flushPatient('c').then(o => { results.c = o; });
    await flushMicrotasks();
    engine.settleWaiters([patient('x'), patient('b', { syncStatus: 'synced' }), patient('c', { syncStatus: 'dirty' })]);
    await flushMicrotasks();
    expect(results).toEqual({ b: 'synced' });
    engine.disposeWaiters();
    await flushMicrotasks();
    expect(results).toEqual({ b: 'synced', c: 'error' });
  });

  it('resumePatient: 일시정지가 아니면 dispatch하지 않고(같은 상태), 일시정지면 락 상태 규칙대로 푼다', () => {
    const { store, engine } = setup([patient('a'), patient('b', { syncStatus: 'dirty', syncPaused: true })]);
    const before = store.getState();
    engine.resumePatient('a', 'held', SESSION);
    expect(store.getState()).toBe(before);
    engine.resumePatient('b', 'acquiring', SESSION); // 서버 환자 + 락 미확보 → 그대로
    expect(ofStore(store, 'b').sync.syncPaused).toBe(true);
    engine.resumePatient('b', 'held', SESSION);
    expect(ofStore(store, 'b').sync.syncPaused).toBe(false);
  });
});
