// P2-43a(flagged, D1) — 동기화가 꺼지는 순간 진행 중이던 push의 서버 응답(ACK)을 버리지 않는다(REFACTORING_ROADMAP Phase 2 게이트 B
// 계획 "P2-43a 설계"). 옮기기 전에는 ACK를 통째로 버려 로컬은 dirty·옛 revision, 서버는 새 revision이 되고, 다시 켜면 옛 revision으로
// 재전송해 409 충돌로 표시됐다(내용이 같아도 — T5-1이 고정, 실서버 ⑧은 화면이 다시 시작돼 드러나지 않음).
// 이제는 push를 시작할 때와 ACK가 도착할 때의 세션 식별(sessionIdentityOf — 서버 주소 포함)이 같으면, **목록에 아직 남아 있는
// 환자에만** ACK를 반영하고 pull은 하지 않는다(sync/pushAckSettled). 세션이 바뀌었으면 지금처럼 버린다.
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
const SESSION = { mode: 'intranet', apiBaseUrl: 'https://x', accessToken: 'tok', user: { id: 'u1', organizationId: 'o1' } };
const OTHER_USER = { ...SESSION, user: { id: 'u2', organizationId: 'o1' } };

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
type Synced = { sync: Record<string, unknown> };
const syncOf = (store: ReturnType<typeof setup>['store'], id: string) => (store.getState().patients.find(p => p.id === id) as unknown as Synced | undefined)?.sync;
const ack = (p: PatientRecord, revision: number) => ({ patient: p, serverPatient: patient(p.id, { revision }) });

/** b(dirty)의 push가 응답을 기다리는 동안 hold()를 부른 뒤, b의 성공 ACK(revision 2)로 응답한다. */
async function pushWhile(ctx: ReturnType<typeof setup>, hold: () => void, respond?: (sent: PatientRecord[]) => unknown) {
  const first = deferred<unknown>();
  push.mockImplementationOnce(() => first.promise);
  const run = ctx.engine.runSync({ push: true, pull: true, reason: 'test' });
  await flushMicrotasks();
  const sent = (push.mock.calls[0][0] as PatientRecord[]).filter(p => p.id === 'b');
  hold();
  first.resolve(respond ? respond(sent) : { synced: sent.map(p => ack(p, 2)), failed: [] });
  return run;
}

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

describe('P2-43a — 비활성화 순간의 push ACK(세션이 같으면 남아 있는 환자에만 반영)', () => {
  it('ACK를 반영해 다음 push가 새 revision을 쓴다 — 409 없음, pull은 하지 않고 idle로 끝난다', async () => {
    const ctx = setup([patient('a'), patient('b', { syncStatus: 'dirty' })]);
    const result = await pushWhile(ctx, () => { ctx.inputs.enabled = false; });
    expect(result).toBeNull();
    expect(syncOf(ctx.store, 'b')).toMatchObject({ revision: 2, syncStatus: 'synced' });
    expect(pull).not.toHaveBeenCalled();
    expect(ctx.syncState().status).toBe('idle');

    // 다시 켜고 편집하면 새 revision(2)으로 보낸다(옛 revision 재전송 → 409가 없다).
    ctx.inputs.enabled = true;
    ctx.store.dispatch(patientTx.dataEdited({ id: 'b', edit: { shared: { name: 'b2' } }, session: SESSION, stampUpdatedAt: true } as never));
    await ctx.engine.runSync({ push: true, reason: 'next' });
    const resent = (push.mock.calls[1][0] as PatientRecord[]).filter(p => p.id === 'b');
    expect((resent[0] as unknown as Synced).sync.revision).toBe(2);
  });

  it('초기화로 비운 목록(세션 그대로, 동기화 끔)이 되살아나지 않는다 — 목록 길이가 늘지 않아 일시정지도 풀리지 않는다', async () => {
    const ctx = setup([patient('a'), patient('b', { syncStatus: 'dirty' })]);
    await pushWhile(ctx, () => {
      ctx.inputs.enabled = false; // App.handleResetPatients: setPatientSyncPaused(true)
      ctx.store.dispatch(patientTx.replacedAll({ patients: [] }));
    });
    expect(ctx.store.getState().patients).toEqual([]);
  });

  it('기다리는 동안 지운 환자는 다시 생기지 않고, 남은 환자는 그대로다', async () => {
    const ctx = setup([patient('a'), patient('b', { syncStatus: 'dirty' })]);
    await pushWhile(ctx, () => {
      ctx.inputs.enabled = false;
      ctx.store.dispatch(patientTx.deleteResultsApplied({ deletedIds: ['b'], conflicts: [] }));
    });
    expect(ctx.store.getState().patients.map(p => p.id)).toEqual(['a']);
  });

  const failure = (kind: string, status: number) => (sent: PatientRecord[]) => ({
    synced: [],
    failed: sent.map(p => ({ patient: p, kind, error: Object.assign(new Error(kind), { status, data: { currentRevision: 3 } }) })),
  });

  it.each([['conflict', 409], ['lock', 423]])('%s(%s) 실패 표시는 남아 있는 환자에 한다', async (kind, status) => {
    const ctx = setup([patient('a'), patient('b', { syncStatus: 'dirty' })]);
    await pushWhile(ctx, () => { ctx.inputs.enabled = false; }, failure(kind as string, status as number));
    expect(syncOf(ctx.store, 'b')?.syncStatus).toBe('conflict');
  });

  it.each([['conflict', 409], ['lock', 423]])('%s(%s) 실패라도 기다리는 동안 지운 환자·초기화로 비운 목록은 되살리지 않는다', async (kind, status) => {
    const deleted = setup([patient('a'), patient('b', { syncStatus: 'dirty' })]);
    await pushWhile(deleted, () => {
      deleted.inputs.enabled = false;
      deleted.store.dispatch(patientTx.deleteResultsApplied({ deletedIds: ['b'], conflicts: [] }));
    }, failure(kind as string, status as number));
    expect(deleted.store.getState().patients.map(p => p.id)).toEqual(['a']);
    expect(syncOf(deleted.store, 'a')?.syncStatus).toBe('synced');

    vi.clearAllMocks();
    push.mockResolvedValue({ synced: [], failed: [] });
    const cleared = setup([patient('a'), patient('b', { syncStatus: 'dirty' })]);
    await pushWhile(cleared, () => {
      cleared.inputs.enabled = false;
      cleared.store.dispatch(patientTx.replacedAll({ patients: [] }));
    }, failure(kind as string, status as number));
    expect(cleared.store.getState().patients).toEqual([]);
  });

  it('세션이 바뀌었으면(다른 계정) 지금처럼 버린다', async () => {
    const ctx = setup([patient('a'), patient('b', { syncStatus: 'dirty' })]);
    await pushWhile(ctx, () => { ctx.inputs.enabled = false; ctx.inputs.session = OTHER_USER; });
    expect(syncOf(ctx.store, 'b')).toMatchObject({ revision: 1, syncStatus: 'dirty' });
  });

  it('같은 계정이라도 서버 주소가 바뀌었으면 버린다(sessionIdentityOf는 서버 주소 포함)', async () => {
    const ctx = setup([patient('a'), patient('b', { syncStatus: 'dirty' })]);
    await pushWhile(ctx, () => { ctx.inputs.enabled = false; ctx.inputs.session = { ...SESSION, apiBaseUrl: 'https://y' }; });
    expect(syncOf(ctx.store, 'b')).toMatchObject({ revision: 1, syncStatus: 'dirty' });
  });

  it('그 사이클의 flush waiter가 반영된 결과로 풀린다', async () => {
    const ctx = setup([patient('a'), patient('b', { syncStatus: 'dirty' })]);
    const first = deferred<unknown>();
    push.mockImplementationOnce(() => first.promise);
    let outcome: string | undefined;
    void ctx.engine.flushPatient('b').then(o => { outcome = o; });
    await flushMicrotasks();
    const sent = (push.mock.calls[0][0] as PatientRecord[]).filter(p => p.id === 'b');
    ctx.inputs.enabled = false;
    first.resolve({ synced: sent.map(p => ack(p, 2)), failed: [] });
    await flushMicrotasks();
    expect(outcome).toBe('synced');
  });
});
