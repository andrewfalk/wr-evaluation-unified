// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { usePatientLock, requiresLock } from '../usePatientLock.js';

vi.mock('../../services/patientServerRepository', () => ({
  acquirePatientLock: vi.fn(),
  renewPatientLock:   vi.fn(),
  forcePatientLock:   vi.fn(),
  releasePatientLock: vi.fn(),
  isLockError:        (err) => err?.status === 423,
}));

import {
  acquirePatientLock,
  renewPatientLock,
  forcePatientLock,
  releasePatientLock,
} from '../../services/patientServerRepository';
import { getLockToken, clearAllLockTokens } from '../../services/lockTokenStore';

const SESSION = { mode: 'intranet', apiBaseUrl: 'https://x', accessToken: 'tok', user: { id: 'u1' } };

function syncedPatient(overrides = {}) {
  return {
    id: 'local-1',
    sync: { serverId: 'server-1', revision: 1, syncStatus: 'synced' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAllLockTokens();
  window.sessionStorage.clear();
  // 대부분의 테스트가 release 자체를 검증 대상으로 삼지 않으므로 기본 성공값을 준다 —
  // 그렇지 않으면 언마운트/전환 시 훅의 best-effort release(.catch(...))가
  // "undefined.catch"로 깨진다(vi.fn()의 기본 반환값은 undefined).
  releasePatientLock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('requiresLock', () => {
  it('true only for intranet + a patient that already has a serverId', () => {
    expect(requiresLock(syncedPatient(), SESSION)).toBe(true);
    expect(requiresLock(syncedPatient(), { mode: 'local' })).toBe(false);
    expect(requiresLock({ sync: { serverId: null } }, SESSION)).toBe(false);
    expect(requiresLock(null, SESSION)).toBe(false);
  });
});

describe('usePatientLock — acquire', () => {
  it('local-only patient (no serverId): stays none, no API calls', () => {
    const patient = { id: 'p1', sync: { serverId: null, syncStatus: 'local-only' } };
    const { result } = renderHook(() => usePatientLock({ activeId: 'p1', activePatient: patient, session: SESSION }));

    expect(result.current.lockState.status).toBe('none');
    expect(acquirePatientLock).not.toHaveBeenCalled();
  });

  it('acquires successfully and stores the lease token', async () => {
    acquirePatientLock.mockResolvedValue({ leaseToken: 'tok-1', expiresAt: '2024-01-01T00:01:40Z', ttlMs: 100000 });
    const patient = syncedPatient();

    const { result } = renderHook(() => usePatientLock({ activeId: 'local-1', activePatient: patient, session: SESSION }));

    await waitFor(() => expect(result.current.lockState.status).toBe('held'));
    expect(getLockToken('local-1')).toBe('tok-1');
    expect(acquirePatientLock).toHaveBeenCalledWith('server-1', expect.any(String), expect.objectContaining({ session: SESSION }));
  });

  it('423 on acquire → held-by-other with holder info, no token stored', async () => {
    const err = new Error('locked');
    err.status = 423;
    err.data = { holder: { holderName: 'Dr. Lee' } };
    acquirePatientLock.mockRejectedValue(err);

    const { result } = renderHook(() => usePatientLock({ activeId: 'local-1', activePatient: syncedPatient(), session: SESSION }));

    await waitFor(() => expect(result.current.lockState.status).toBe('held-by-other'));
    expect(result.current.lockState.holder).toEqual({ holderName: 'Dr. Lee' });
    expect(getLockToken('local-1')).toBeNull();
  });

  it('non-lock error on acquire (e.g. network) → lost, does not assume held', async () => {
    acquirePatientLock.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => usePatientLock({ activeId: 'local-1', activePatient: syncedPatient(), session: SESSION }));

    await waitFor(() => expect(result.current.lockState.status).toBe('lost'));
  });

  it('generation guard: switching patients before the first acquire resolves ignores the stale response', async () => {
    let resolveFirst;
    acquirePatientLock.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    acquirePatientLock.mockResolvedValueOnce({ leaseToken: 'tok-2', expiresAt: 'x', ttlMs: 100000 });

    const { result, rerender } = renderHook(
      ({ activeId, patient }) => usePatientLock({ activeId, activePatient: patient, session: SESSION }),
      { initialProps: { activeId: 'p1', patient: syncedPatient({ id: 'p1', sync: { serverId: 's1', syncStatus: 'synced' } }) } }
    );

    rerender({ activeId: 'p2', patient: syncedPatient({ id: 'p2', sync: { serverId: 's2', syncStatus: 'synced' } }) });

    // p1's acquire resolves late — must not overwrite p2's state.
    resolveFirst({ leaseToken: 'tok-1-late', expiresAt: 'x', ttlMs: 100000 });
    await Promise.resolve();
    await Promise.resolve();

    expect(result.current.lockState.status).not.toBe('held');
    // Cast a wide net: whichever transient state p2 is in, it must never have adopted p1's token.
    expect(getLockToken('p1')).toBeNull();
  });
});

describe('usePatientLock — renew heartbeat', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('schedules a renew at ttlMs/4 and keeps the same token on success', async () => {
    acquirePatientLock.mockResolvedValue({ leaseToken: 'tok-1', expiresAt: 'e1', ttlMs: 100000 });
    renewPatientLock.mockResolvedValue({ expiresAt: 'e2', ttlMs: 100000 });

    const { result } = renderHook(() => usePatientLock({ activeId: 'local-1', activePatient: syncedPatient(), session: SESSION }));

    await vi.waitFor(() => expect(result.current.lockState.status).toBe('held'));

    await vi.advanceTimersByTimeAsync(25000);

    expect(renewPatientLock).toHaveBeenCalledWith('server-1', 'tok-1', expect.objectContaining({ session: SESSION }));
    expect(result.current.lockState.status).toBe('held');
    expect(getLockToken('local-1')).toBe('tok-1'); // renew never rotates the token
  });

  it('renew failure (423/403) transitions to lost and clears the token', async () => {
    acquirePatientLock.mockResolvedValue({ leaseToken: 'tok-1', expiresAt: 'e1', ttlMs: 100000 });
    renewPatientLock.mockRejectedValue(Object.assign(new Error('lost'), { status: 423 }));

    const { result } = renderHook(() => usePatientLock({ activeId: 'local-1', activePatient: syncedPatient(), session: SESSION }));

    await vi.waitFor(() => expect(result.current.lockState.status).toBe('held'));
    await vi.advanceTimersByTimeAsync(25000);
    await vi.waitFor(() => expect(result.current.lockState.status).toBe('lost'));

    expect(getLockToken('local-1')).toBeNull();
  });
});

describe('usePatientLock — forceAcquire', () => {
  it('force-takeover succeeds: held with a new token', async () => {
    const err = new Error('locked');
    err.status = 423;
    err.data = { holder: { holderName: 'Dr. Lee' } };
    acquirePatientLock.mockRejectedValue(err);
    forcePatientLock.mockResolvedValue({ leaseToken: 'forced-tok', expiresAt: 'e', ttlMs: 100000 });

    const { result } = renderHook(() => usePatientLock({ activeId: 'local-1', activePatient: syncedPatient(), session: SESSION }));
    await waitFor(() => expect(result.current.lockState.status).toBe('held-by-other'));

    result.current.forceAcquire();

    await waitFor(() => expect(result.current.lockState.status).toBe('held'));
    expect(forcePatientLock).toHaveBeenCalledWith('server-1', expect.any(String), expect.objectContaining({ session: SESSION }));
    expect(getLockToken('local-1')).toBe('forced-tok');
  });
});

describe('usePatientLock — release on cleanup', () => {
  it('releases the held lock when the active patient changes', async () => {
    acquirePatientLock.mockResolvedValue({ leaseToken: 'tok-1', expiresAt: 'e', ttlMs: 100000 });

    const { result, rerender } = renderHook(
      ({ activeId, patient }) => usePatientLock({ activeId, activePatient: patient, session: SESSION }),
      { initialProps: { activeId: 'p1', patient: syncedPatient({ id: 'p1', sync: { serverId: 's1', syncStatus: 'synced' } }) } }
    );

    await waitFor(() => expect(result.current.lockState.status).toBe('held'));

    rerender({ activeId: 'p2', patient: syncedPatient({ id: 'p2', sync: { serverId: 's2', syncStatus: 'synced' } }) });

    expect(releasePatientLock).toHaveBeenCalledWith('s1', 'tok-1', expect.objectContaining({ session: SESSION }));
    expect(getLockToken('p1')).toBeNull();
  });
});
