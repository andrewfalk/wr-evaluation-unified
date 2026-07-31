// @vitest-environment jsdom
//
// usePatientSync의 flushPatient/notifyLockOutcome/getPushEligibility 검증.
// pull/merge/reconcile 로직 자체는 usePatientSync.test.js(순수 함수 reconcilePulledPatients)가
// 다루므로 여기서는 락 게이팅 + 커밋 배리어 경로만 다룬다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { usePatientSync, getPushEligibility } from '../usePatientSync.js';

vi.mock('../../services/patientServerRepository', async () => {
  const actual = await vi.importActual('../../services/patientServerRepository');
  return {
    ...actual,
    pushPendingPatients: vi.fn(),
    pullPatients: vi.fn(),
  };
});

import { pushPendingPatients, pullPatients } from '../../services/patientServerRepository';
import { setLockToken, clearAllLockTokens } from '../../services/lockTokenStore';

const SESSION = { mode: 'intranet', apiBaseUrl: 'https://x', accessToken: 'tok', user: { id: 'u1' } };

function dirtyPatient(overrides = {}) {
  return {
    id: 'p1',
    data: { shared: {}, modules: {}, activeModules: [] },
    sync: { serverId: 's1', revision: 1, syncStatus: 'dirty' },
    ...overrides,
  };
}

function useHarness({ initialPatients, enabled, lockState }) {
  const [patients, setPatients] = useState(initialPatients);
  const [activeId, setActiveId] = useState(initialPatients[0]?.id ?? null);
  const sync = usePatientSync({
    patients, setPatients, activeId, setActiveId,
    session: SESSION, settings: {}, enabled, lockState,
  });
  return { patients, activeId, ...sync };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAllLockTokens();
  pullPatients.mockResolvedValue({ items: [], total: 0 });
  pushPendingPatients.mockResolvedValue({ synced: [], failed: [] });
});

afterEach(() => {
  cleanup();
});

describe('getPushEligibility', () => {
  const patient = dirtyPatient();

  it('non-active patients are always allowed (opt-in compatibility)', () => {
    expect(getPushEligibility('other', { activeId: 'p1', lockState: { status: 'held-by-other' }, patient }))
      .toEqual({ allowed: true });
  });

  it('status "none" (local-only / non-intranet) is always allowed', () => {
    expect(getPushEligibility('p1', { activeId: 'p1', lockState: { status: 'none' }, patient }))
      .toEqual({ allowed: true });
  });

  it('"held" with a stored token is allowed', () => {
    setLockToken('p1', 'tok');
    expect(getPushEligibility('p1', { activeId: 'p1', lockState: { status: 'held' }, patient }).allowed).toBe(true);
  });

  it('"held" without a token yet is bootstrap-pending (defensive race guard)', () => {
    expect(getPushEligibility('p1', { activeId: 'p1', lockState: { status: 'held' }, patient }))
      .toEqual({ allowed: false, reason: 'bootstrap-pending' });
  });

  it('"held-by-other" is blocked with reason lock-held-by-other', () => {
    expect(getPushEligibility('p1', { activeId: 'p1', lockState: { status: 'held-by-other' }, patient }))
      .toEqual({ allowed: false, reason: 'lock-held-by-other' });
  });

  it('"lost" is blocked with reason lock-lost', () => {
    expect(getPushEligibility('p1', { activeId: 'p1', lockState: { status: 'lost' }, patient }))
      .toEqual({ allowed: false, reason: 'lock-lost' });
  });

  it('"acquiring"/"peeking" (no conclusion yet) is bootstrap-pending', () => {
    expect(getPushEligibility('p1', { activeId: 'p1', lockState: { status: 'acquiring' }, patient }))
      .toEqual({ allowed: false, reason: 'bootstrap-pending' });
  });

  it('a per-patient syncPaused flag blocks even while held', () => {
    setLockToken('p1', 'tok');
    const paused = dirtyPatient({ sync: { serverId: 's1', revision: 1, syncStatus: 'dirty', syncPaused: true } });
    expect(getPushEligibility('p1', { activeId: 'p1', lockState: { status: 'held' }, patient: paused }))
      .toEqual({ allowed: false, reason: 'sync-paused' });
  });
});

describe('usePatientSync — flushPatient', () => {
  it('resolves "conflict" immediately for an already-conflicted patient, without any network call', async () => {
    const conflicted = dirtyPatient({ sync: { serverId: 's1', revision: 1, syncStatus: 'conflict', conflict: { kind: 'push' } } });
    const { result } = renderHook(() => useHarness({ initialPatients: [conflicted], enabled: false, lockState: { status: 'none' } }));

    const outcome = await result.current.flushPatient('p1');

    expect(outcome).toBe('conflict');
    expect(pushPendingPatients).not.toHaveBeenCalled();
  });

  it('resolves "synced" immediately for a patient that is not dirty', async () => {
    const synced = dirtyPatient({ sync: { serverId: 's1', revision: 1, syncStatus: 'synced' } });
    const { result } = renderHook(() => useHarness({ initialPatients: [synced], enabled: false, lockState: { status: 'none' } }));

    const outcome = await result.current.flushPatient('p1');

    expect(outcome).toBe('synced');
    expect(pushPendingPatients).not.toHaveBeenCalled();
  });

  it('resolves "lock-lost" immediately when the active patient is held-by-other, without pushing', async () => {
    const { result } = renderHook(() => useHarness({
      initialPatients: [dirtyPatient()], enabled: false, lockState: { status: 'held-by-other' },
    }));

    const outcome = await result.current.flushPatient('p1');

    expect(outcome).toBe('lock-lost');
    expect(pushPendingPatients).not.toHaveBeenCalled();
  });

  it('returns "error" for an unknown patient id', async () => {
    const { result } = renderHook(() => useHarness({ initialPatients: [], enabled: false, lockState: { status: 'none' } }));
    await expect(result.current.flushPatient('nope')).resolves.toBe('error');
  });

  it('joins the in-flight/queued autosync cycle instead of firing a duplicate PATCH, and resolves once the patient is committed as synced', async () => {
    pushPendingPatients.mockImplementation(async (patients) => {
      const target = patients.find(p => p.id === 'p1');
      if (!target) return { synced: [], failed: [] };
      const serverPatient = { ...target, sync: { ...target.sync, syncStatus: 'synced', revision: 2, lastSyncedAt: 'now' } };
      return { synced: [{ patient: target, serverPatient }], failed: [] };
    });

    const { result, rerender } = renderHook(
      ({ enabled, lockState }) => useHarness({ initialPatients: [dirtyPatient()], enabled, lockState }),
      { initialProps: { enabled: false, lockState: { status: 'acquiring' } } }
    );

    // Enabling sync triggers the automatic 'startup' push/pull cycle in the same commit.
    // Calling flushPatient right after (already 'held') must not cause a second PATCH —
    // it should merge into whatever cycle is already running/queued.
    rerender({ enabled: true, lockState: { status: 'held' } });
    setLockToken('p1', 'tok-1');

    const flushOutcome = result.current.flushPatient('p1');

    await waitFor(() => expect(result.current.patients[0]?.sync?.syncStatus).toBe('synced'));
    await expect(flushOutcome).resolves.toBe('synced');

    expect(pushPendingPatients).toHaveBeenCalledTimes(1);
  });
});

describe('usePatientSync — notifyLockOutcome', () => {
  it('resolves a bootstrap-pending waiter directly, even though sync is active (startup cycle excludes this patient)', async () => {
    const { result } = renderHook(() => useHarness({
      initialPatients: [dirtyPatient()], enabled: true, lockState: { status: 'acquiring' },
    }));

    // 활성 환자가 bootstrap-pending이므로 startup 사이클(자동 실행)도 이 환자를 제외한다 —
    // 유일한 dirty 환자라 pushPendingPatients 자체가 호출되지 않아야 한다.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(pushPendingPatients).not.toHaveBeenCalled();

    const flushOutcome = result.current.flushPatient('p1');
    result.current.notifyLockOutcome('p1', 'lock-lost');

    await expect(flushOutcome).resolves.toBe('lock-lost');
    expect(pushPendingPatients).not.toHaveBeenCalled();
  });
});
