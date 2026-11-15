// @vitest-environment jsdom
//
// T5 — usePatientSync 선행 특성화(REFACTORING_ROADMAP Phase 2 P2-41b, 게이트 B 계획 "PR 목록" P2-41b).
// P2-41c(훅이 스토어를 직접 읽음)·P2-41d(엔진으로 이동) 전에 **지금 코드에서 통과하는** 동작을 고정한다 — 고치는 것이 아니다.
// 결함 후보 D1(비활성화 순간 push ACK 버림)·D2(일괄 가져오기가 기존 환자 전원을 dirty로)·D3(push 못 하는 dirty 환자의 1초 pull
// 반복)는 "지금 그렇게 동작한다"로 고정해 확인 여부를 기록한다(D1·D2는 확인되면 P2-43a·43b에서 의도대로 바꾸고 이 파일의 해당
// 단언을 갱신한다, D3는 보고만). D5(계정 전환)는 App.accountSwitch.smoke.test.jsx R6이 맡는다.
//
// 하니스는 T3와 같은 환자 상태 컨테이너(+ store) + StrictMode. 락 전이 사례는 App.jsx의 브리지 effect(락이 held가 되면
// flushPatient, held-by-other/lost면 notifyLockOutcome)를 같은 순서(훅 뒤)로 흉내 낸다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useEffect, useRef } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { usePatientSync } from '../usePatientSync.js';
import { usePatientCrud } from '../usePatientCrud.js';
import { usePatientsContainer } from '../../state/patientStore/usePatientsContainer';
import { defineTransition } from '../../state/patientStore/transitions';
import { BatchImportModal } from '../../components/BatchImportModal';

vi.mock('../../services/patientServerRepository', async () => {
  const actual = await vi.importActual('../../services/patientServerRepository');
  return {
    ...actual,
    pushPendingPatients: vi.fn(),
    pullPatients: vi.fn(),
  };
});
vi.mock('../../utils/platform', async () => {
  const actual = await vi.importActual('../../utils/platform');
  return { ...actual, showAlert: vi.fn(async () => {}), showConfirm: vi.fn(async () => true) };
});
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ session: { mode: 'intranet', apiBaseUrl: 'https://x', accessToken: 'tok', user: { id: 'u1', role: 'doctor' } } }),
}));

import { pushPendingPatients, pullPatients } from '../../services/patientServerRepository';
import { clearAllLockTokens, setLockToken } from '../../services/lockTokenStore';

const SESSION = { mode: 'intranet', apiBaseUrl: 'https://x', accessToken: 'tok', user: { id: 'u1', role: 'doctor' } };

function serverPatient(id, sync = {}) {
  return {
    id,
    data: { shared: { name: id }, modules: {}, activeModules: [] },
    sync: { serverId: `s-${id}`, revision: 1, syncStatus: 'synced', ...sync },
  };
}

const rawSet = defineTransition('test/rawSet', (prev, arg) => (typeof arg === 'function' ? arg(prev) : arg));

function useHarness({ initialPatients, initialActiveId, enabled = true, lockState = { status: 'none' }, bridge }) {
  const container = usePatientsContainer(initialPatients, {
    initialActiveId: initialActiveId === undefined ? (initialPatients[0]?.id ?? null) : initialActiveId,
  });
  const { patients, setPatients, activeId, setActiveId, setSelectedIds, store } = container;
  const sync = usePatientSync({
    patients, setPatients, activeId, setActiveId, store,
    session: SESSION, settings: {}, enabled, scope: 'mine', lockState,
  });
  // App.jsx의 락 브리지 effect(usePatientSync 호출 뒤 — 같은 순서).
  const prevLockStatusRef = useRef(lockState.status);
  const { flushPatient, notifyLockOutcome } = sync;
  useEffect(() => {
    if (!bridge) return;
    if (prevLockStatusRef.current === lockState.status) return;
    prevLockStatusRef.current = lockState.status;
    if (lockState.status === 'held') {
      flushPatient(activeId).then(outcome => { bridge.outcomes.push(outcome); });
    } else if (lockState.status === 'held-by-other' || lockState.status === 'lost') {
      notifyLockOutcome(activeId, 'lock-lost');
    }
  }, [bridge, lockState.status, activeId, flushPatient, notifyLockOutcome]);
  return { patients, activeId, setActiveId, setSelectedIds, rawSetPatients: arg => setPatients(rawSet(arg)), ...sync };
}

function renderSync(initialProps) {
  return renderHook(props => useHarness(props), { initialProps, wrapper: StrictMode });
}

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

const byId = (result, id) => result.current.patients.find(p => p.id === id);
// pushPendingPatients는 허용된 환자 전체를 받고 그 안에서 dirty·local-only만 보낸다 — 실제로 보낸 것만 본다.
const isPending = p => !p.sync?.syncPaused && (p.sync?.syncStatus === 'dirty' || p.sync?.syncStatus === 'local-only');
const pushedRevisions = () => pushPendingPatients.mock.calls.map(([targets]) => targets.filter(isPending).map(p => `${p.id}@${p.sync.revision}`));

describe('T5 usePatientSync — 선행 특성화(지금 동작)', () => {
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

  it('T5-1(D1) 비활성화 순간 진행 중이던 push의 ACK는 버려진다 → 다시 켜면 옛 revision으로 재전송 → 서버 409면 충돌 표시', async () => {
    const firstPush = deferred();
    pushPendingPatients.mockImplementationOnce(() => firstPush.promise);
    const initialPatients = [serverPatient('a'), serverPatient('b', { syncStatus: 'dirty' })];
    const { result, rerender } = renderSync({ initialPatients, initialActiveId: 'a', enabled: true });
    await settle(2);
    expect(pushedRevisions()).toEqual([['b@1']]);

    // 응답을 기다리는 동안 동기화가 꺼진다(로그아웃 요청 중·401 뒤 로컬 전환 등).
    rerender({ initialPatients, initialActiveId: 'a', enabled: false });
    await settle();
    const pushed = result.current.patients.find(p => p.id === 'b');
    await act(async () => {
      firstPush.resolve({ synced: [{ patient: pushed, serverPatient: serverPatient('b', { revision: 2 }) }], failed: [] });
    });
    await settle();
    // ACK가 반영되지 않았다: 로컬은 여전히 dirty·revision 1(서버는 2).
    expect(byId(result, 'b').sync).toMatchObject({ syncStatus: 'dirty', revision: 1 });

    // 다시 켜면 옛 revision(1)으로 다시 보낸다 — 서버는 이미 2라 409(내용이 같아도).
    pushPendingPatients.mockImplementationOnce(async (targets) => ({
      synced: [],
      failed: targets.map(p => ({
        patient: p, kind: 'conflict',
        error: Object.assign(new Error('conflict'), { status: 409, data: { code: 'REVISION_CONFLICT', currentRevision: 2 } }),
      })),
    }));
    rerender({ initialPatients, initialActiveId: 'a', enabled: true });
    await settle();
    expect(pushedRevisions().at(-1)).toEqual(['b@1']);
    expect(byId(result, 'b').sync.syncStatus).toBe('conflict');
  });

  it('T5-2 진행 중인 sync가 있으면 syncNow는 곧바로 null을 돌려주고(큐에 합침) 끝난 뒤 큐가 돈다', async () => {
    const pull = deferred();
    pullPatients.mockImplementationOnce(() => pull.promise);
    const { result } = renderSync({ initialPatients: [serverPatient('a')] });
    await settle(2);
    expect(pullPatients).toHaveBeenCalledTimes(1);

    let returned;
    await act(async () => { returned = await result.current.syncNow({ pull: true, reason: 'manual' }); });
    expect(returned).toBeNull();
    await act(async () => { pull.resolve({ items: [serverPatient('a')], total: 1 }); });
    await settle();
    expect(pullPatients).toHaveBeenCalledTimes(2); // 큐에 합쳐진 manual(StrictMode 부팅 2회분도 한 큐로)
  });

  it('T5-3 언마운트 때 기다리던 flush는 error로 풀리고, 늦게 온 push 응답은 아무것도 다시 보내지 않는다', async () => {
    const push = deferred();
    pushPendingPatients.mockImplementationOnce(() => push.promise);
    const { result, unmount } = renderSync({ initialPatients: [serverPatient('a', { syncStatus: 'dirty' })] });
    await settle(2);
    expect(pushPendingPatients).toHaveBeenCalledTimes(1);

    let outcome;
    act(() => { result.current.flushPatient('a').then(o => { outcome = o; }); });
    unmount();
    await settle();
    expect(outcome).toBe('error');
    await act(async () => { push.resolve({ synced: [], failed: [] }); });
    await advance(10_000);
    expect(pushPendingPatients).toHaveBeenCalledTimes(1);
  });

  it('T5-4 락 none→held 때 syncPaused dirty 활성 환자: 브리지 flush는 즉시 lock-lost, 1초 뒤 PATCH 1회 + pull', async () => {
    const bridge = { outcomes: [] };
    const initialPatients = [serverPatient('a', { syncStatus: 'dirty', syncPaused: true }), serverPatient('b')];
    const { result, rerender } = renderSync({ initialPatients, initialActiveId: 'a', lockState: { status: 'none' }, bridge });
    await settle(2);
    expect(pushPendingPatients).not.toHaveBeenCalled(); // 일시정지라 대상 없음
    const pullsBefore = pullPatients.mock.calls.length;

    setLockToken('a', 'lease-a');
    rerender({ initialPatients, initialActiveId: 'a', lockState: { status: 'held' }, bridge });
    await settle();
    // 브리지 flush는 재개가 예약만 된 옛 값(syncPaused)을 보고 즉시 확정한다.
    expect(bridge.outcomes).toEqual(['lock-lost']);
    expect(byId(result, 'a').sync.syncPaused).toBe(false); // 재개는 됐다
    expect(pushPendingPatients).not.toHaveBeenCalled();

    await advance(999);
    expect(pushPendingPatients).not.toHaveBeenCalled();
    await advance(1);
    expect(pushedRevisions()).toEqual([['a@1']]);
    expect(pullPatients.mock.calls.length).toBe(pullsBefore + 1);
  });

  it('T5-5 환자를 바꿨는데 lockState가 아직 이전 환자의 held면, 새 활성 환자의 syncPaused는 그 값으로 풀리지만 토큰이 없어 push하지 않는다', async () => {
    const initialPatients = [serverPatient('a'), serverPatient('b', { syncStatus: 'dirty', syncPaused: true })];
    setLockToken('a', 'lease-a');
    const { result } = renderSync({ initialPatients, initialActiveId: 'a', lockState: { status: 'held' } });
    await settle(2);
    expect(pushPendingPatients).not.toHaveBeenCalled();

    act(() => { result.current.setActiveId('b'); });
    await settle();
    expect(byId(result, 'b').sync.syncPaused).toBe(false); // 이전 환자의 held로 풀림(락 상태가 한 박자 늦음)
    await advance(1000);
    // b는 활성·held·토큰 없음 → bootstrap-pending이라 push 대상에서 빠진다(호출 자체가 없음).
    expect(pushPendingPatients).not.toHaveBeenCalled();
  });

  it('T5-6 push가 423(락)으로 실패하면 flush 결과는 lock-lost(충돌 아님)이고 환자는 conflict로 표시된다', async () => {
    pushPendingPatients.mockImplementation(async (targets) => ({
      synced: [],
      failed: targets.map(p => ({ patient: p, kind: 'lock', error: Object.assign(new Error('locked'), { status: 423, data: {} }) })),
    }));
    const { result } = renderSync({ initialPatients: [serverPatient('a'), serverPatient('b', { syncStatus: 'dirty' })], initialActiveId: 'a' });
    await settle(2);
    pushPendingPatients.mockClear();

    act(() => { result.current.rawSetPatients(prev => prev.map(p => (p.id === 'b' ? { ...p, sync: { ...p.sync, syncStatus: 'dirty' } } : p))); });
    let outcome;
    await act(async () => { result.current.flushPatient('b').then(o => { outcome = o; }); });
    await settle();
    expect(outcome).toBe('lock-lost');
    expect(byId(result, 'b').sync.syncStatus).toBe('conflict');
  });

  it('T5-7 activeId·selectedIds만 바뀌면 1초 debounce 타이머는 다시 잡히지 않는다(patients 참조가 같음)', async () => {
    // pull이 두 환자를 돌려준다('mine' pull에 없는 synced 환자는 범위 밖으로 빠지므로).
    pullPatients.mockResolvedValue({ items: [serverPatient('a'), serverPatient('b')], total: 2 });
    const { result } = renderSync({ initialPatients: [serverPatient('a'), serverPatient('b')], initialActiveId: 'a' });
    await settle(2);
    pushPendingPatients.mockClear();

    act(() => { result.current.rawSetPatients(prev => prev.map(p => (p.id === 'b' ? { ...p, sync: { ...p.sync, syncStatus: 'dirty' } } : p))); });
    await advance(600);
    const patientsRef = result.current.patients;
    act(() => {
      result.current.setActiveId('b');
      result.current.setSelectedIds(new Set(['a']));
    });
    await settle();
    expect(result.current.patients).toBe(patientsRef);
    await advance(399);
    expect(pushPendingPatients).not.toHaveBeenCalled();
    await advance(1);
    expect(pushPendingPatients).toHaveBeenCalledTimes(1);
  });

  it('T5-8(D3) push할 수 없는 dirty 환자(403)가 있으면 pull → 새 배열 → 1초 debounce → push+pull이 약 1초마다 반복된다', async () => {
    pushPendingPatients.mockImplementation(async (targets) => ({
      synced: [],
      failed: targets.map(p => ({ patient: p, kind: 'permission', error: Object.assign(new Error('forbidden'), { status: 403, data: {} }) })),
    }));
    pullPatients.mockResolvedValue({ items: [serverPatient('a')], total: 1 });
    renderSync({ initialPatients: [serverPatient('a'), serverPatient('b', { syncStatus: 'dirty' })], initialActiveId: 'a' });
    await settle(2);
    const pushes0 = pushPendingPatients.mock.calls.length;
    const pulls0 = pullPatients.mock.calls.length;
    for (let i = 0; i < 5; i += 1) await advance(1000);
    // 5초 동안 사이클마다 push 1 + pull 1 — 반복이 멈추지 않는다.
    expect(pushPendingPatients.mock.calls.length - pushes0).toBe(5);
    expect(pullPatients.mock.calls.length - pulls0).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// T5-9(D2) — 일괄 가져오기(진짜 BatchImportModal + usePatientCrud.handleBatchImport)
// ---------------------------------------------------------------------------
function ImportHarness({ initialPatients, onPatients }) {
  const container = usePatientsContainer(initialPatients, { initialActiveId: initialPatients[0].id });
  const { patients, setPatients, activeId, setActiveId, selectedIds, setSelectedIds, store } = container;
  const crud = usePatientCrud({
    activeId, activeModuleId: null, session: SESSION, settings: {},
    patients, setPatients, selectedIds, setSelectedIds,
    setErrors: () => {}, setActiveId, setCurrentStepIndex: () => {},
    setIntakeShared: () => {}, setShowHome: () => {}, handleStartIntake: () => {},
    canMutateActivePatient: true,
  });
  usePatientSync({
    patients, setPatients, activeId, setActiveId, store,
    session: SESSION, settings: {}, enabled: true, scope: 'mine', lockState: { status: 'none' },
  });
  useEffect(() => { onPatients(patients); }, [onPatients, patients]);
  return <BatchImportModal onClose={() => {}} onImport={crud.handleBatchImport} existingPatients={patients} />;
}

describe('T5-9(D2) 일괄 가져오기 — 지금 동작', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllLockTokens();
    pullPatients.mockResolvedValue({ items: [], total: 0 });
    pushPendingPatients.mockImplementation(async () => ({ synced: [], failed: [] }));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('새 환자 1명을 가져오면 기존 서버 환자 3명도 전원 dirty가 되고, 다음 push는 4명(PATCH 3 + POST 1)을 보낸다', async () => {
    const captured = {};
    const existing = ['a', 'b', 'c'].map(id => ({ ...serverPatient(id), data: { ...serverPatient(id).data, shared: { name: id, patientNo: `N-${id}` } } }));
    // pull은 그 세 환자를 돌려준다('mine' pull에 없는 synced 환자는 범위 밖으로 빠지므로).
    pullPatients.mockResolvedValue({ items: existing, total: existing.length });
    const onPatients = (list) => { captured.patients = list; };
    const { container } = render(<StrictMode><ImportHarness initialPatients={existing} onPatients={onPatients} /></StrictMode>);
    await waitFor(() => expect(pullPatients).toHaveBeenCalled());
    pushPendingPatients.mockClear();

    const input = container.querySelector('input[type="file"]');
    const csv = new File(['name,patientno\nnewcomer,N-new\n'], 'import.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [csv] } });
    const button = screen.getByRole('button', { name: '가져오기' });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(captured.patients).toHaveLength(4));
    const statuses = Object.fromEntries(captured.patients.map(p => [p.data.shared.patientNo, p.sync?.syncStatus]));
    expect(statuses).toEqual({ 'N-a': 'dirty', 'N-b': 'dirty', 'N-c': 'dirty', 'N-new': 'local-only' });

    await waitFor(() => expect(pushPendingPatients).toHaveBeenCalled(), { timeout: 3000 });
    const targets = pushPendingPatients.mock.calls[0][0].filter(isPending);
    expect(targets.filter(p => p.sync?.serverId).length).toBe(3); // PATCH 대상
    expect(targets.filter(p => !p.sync?.serverId).length).toBe(1); // POST 대상
  });
});
