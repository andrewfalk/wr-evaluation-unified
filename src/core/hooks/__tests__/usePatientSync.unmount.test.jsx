// @vitest-environment jsdom
//
// usePatientSync 언마운트 가드(계정 전환 수정 AS-2) — 화면이 내려간 뒤에는 큐에 남아 있던 동기화가
// 옛 목록·옛 세션으로 서버에 저장 요청을 보내지 않는다. 계정이 바뀌면 화면(App)을 다시 띄우므로
// 이전 화면의 훅 인스턴스가 언마운트된 뒤에도 돌면 안 된다.
//
// 하니스는 App과 같은 환자 상태 컨테이너(patients·activeId + store) — 게이트 B P2-41a에서 T3·flush와 함께 맨 useState를
// 컨테이너로 바꿨다(본문·단언은 그대로, store 인자는 P2-41c 전까지 옛 훅이 무시한다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { usePatientSync } from '../usePatientSync.js';
import { usePatientsContainer } from '../../state/patientStore/usePatientsContainer';
import { defineTransition } from '../../state/patientStore/transitions';

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

function serverPatient(id, overrides = {}) {
  return {
    id,
    data: { shared: { name: id }, modules: {}, activeModules: [] },
    sync: { serverId: `s-${id}`, revision: 1, syncStatus: 'synced' },
    ...overrides,
  };
}

// 테스트가 목록을 직접 바꾸는 경로(옛 하니스의 맨 setState와 같은 의미 — 값 또는 updater).
const rawSet = defineTransition('test/rawSet', (prev, arg) => (typeof arg === 'function' ? arg(prev) : arg));

function useHarness({ initialPatients, initialActiveId }) {
  const { patients, setPatients, activeId, setActiveId, store } = usePatientsContainer(initialPatients, { initialActiveId });
  const sync = usePatientSync({
    patients, setPatients, activeId, setActiveId, store,
    session: SESSION, settings: {}, enabled: true, scope: 'mine', lockState: { status: 'none' },
  });
  return { patients, rawSetPatients: arg => setPatients(rawSet(arg)), ...sync };
}

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearAllLockTokens();
  pushPendingPatients.mockResolvedValue({ synced: [], failed: [] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('usePatientSync — 언마운트 뒤에는 저장 요청을 보내지 않는다', () => {
  it('pull이 진행 중이고 push가 큐에 있을 때 언마운트하면, pull이 끝나도 추가 push는 0건', async () => {
    const pull = deferred();
    pullPatients.mockImplementationOnce(() => pull.promise);
    pullPatients.mockResolvedValue({ items: [], total: 0 });

    const view = renderHook(props => useHarness(props), {
      initialProps: { initialPatients: [serverPatient('p1'), serverPatient('p2')], initialActiveId: 'p1' },
      wrapper: StrictMode,
    });
    await settle(2);
    expect(pullPatients).toHaveBeenCalledTimes(1); // 첫 sync의 pull이 진행 중

    // 큐에 push를 쌓는다(비활성 환자를 dirty로) — 진행 중인 sync 뒤에 실행될 몫
    act(() => {
      view.result.current.rawSetPatients(prev => prev.map(p => (p.id === 'p2'
        ? { ...p, sync: { ...p.sync, syncStatus: 'dirty' } }
        : p)));
    });
    act(() => { view.result.current.syncNow({ push: true, reason: 'manual' }); });

    view.unmount();

    await act(async () => { pull.resolve({ items: [], total: 0 }); });
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await settle();

    expect(pushPendingPatients).not.toHaveBeenCalled();
  });

  it('push 응답을 기다리는 동안 언마운트하면, 응답이 와도 큐의 다음 sync는 돌지 않는다', async () => {
    const push = deferred();
    pushPendingPatients.mockImplementationOnce(() => push.promise);
    pullPatients.mockResolvedValue({ items: [], total: 0 });

    const view = renderHook(props => useHarness(props), {
      initialProps: {
        initialPatients: [serverPatient('p1'), serverPatient('p2', { sync: { serverId: 's-p2', revision: 1, syncStatus: 'dirty' } })],
        initialActiveId: 'p1',
      },
      wrapper: StrictMode,
    });
    await settle(2);
    expect(pushPendingPatients).toHaveBeenCalledTimes(1);

    view.unmount();
    await act(async () => { push.resolve({ synced: [], failed: [] }); });
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await settle();

    expect(pushPendingPatients).toHaveBeenCalledTimes(1);
    expect(pullPatients).not.toHaveBeenCalled();
  });
});
