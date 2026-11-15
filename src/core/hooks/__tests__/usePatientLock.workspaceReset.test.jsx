// @vitest-environment jsdom
// 계정 전환 수정 후속 — 작업 공간 세대가 오르면 전역 락 토큰이 화면이 내려가기 전에 비워진다(AuthContext.applyWorkspace).
// 그래도 화면의 언마운트 정리는 자기가 잡은 편집 락을 해제한다(로컬 전환은 서버 로그아웃이 없어 락이 만료까지 남지 않게).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { usePatientLock } from '../usePatientLock.js';

vi.mock('../../services/patientServerRepository', () => ({
  acquirePatientLock: vi.fn(),
  renewPatientLock: vi.fn(),
  forcePatientLock: vi.fn(),
  releasePatientLock: vi.fn(),
  isLockError: (err) => err?.status === 423,
}));

import { acquirePatientLock, releasePatientLock, renewPatientLock } from '../../services/patientServerRepository';
import { clearAllLockTokens, getLockToken } from '../../services/lockTokenStore';

const SESSION = { mode: 'intranet', apiBaseUrl: 'https://x', accessToken: 'tok', user: { id: 'u1', organizationId: 'o1' } };
const PATIENT = { id: 'local-1', sync: { serverId: 'server-1', revision: 1, syncStatus: 'synced' } };

function renderLock(props = {}) {
  return renderHook(
    (p) => usePatientLock({ activeId: 'local-1', activePatient: PATIENT, session: SESSION, ...p }),
    { initialProps: props, wrapper: StrictMode },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAllLockTokens();
  window.sessionStorage.clear();
  releasePatientLock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('작업 공간 세대 증가로 전역 락 토큰이 먼저 비워져도 언마운트 정리는 자기 락을 해제한다', () => {
  it('락 보유 → 전역 토큰 비움 → 언마운트: 받은 리스 토큰으로 해제 요청 1회', async () => {
    acquirePatientLock.mockResolvedValue({ leaseToken: 'lease-1', expiresAt: '2030-01-01T00:01:40Z', ttlMs: 100000 });
    const view = renderLock();
    await waitFor(() => expect(view.result.current.lockState.status).toBe('held'));
    releasePatientLock.mockClear();

    clearAllLockTokens(); // AuthContext.applyWorkspace가 세대를 올릴 때와 같은 순서(화면이 내려가기 전)
    expect(getLockToken('local-1')).toBeNull();
    view.unmount();

    expect(releasePatientLock).toHaveBeenCalledTimes(1);
    expect(releasePatientLock).toHaveBeenCalledWith('server-1', 'lease-1', expect.objectContaining({ session: SESSION }));
  });

  it('전역 토큰이 남아 있으면 예전처럼 그 토큰으로 해제한다(1회)', async () => {
    acquirePatientLock.mockResolvedValue({ leaseToken: 'lease-2', expiresAt: '2030-01-01T00:01:40Z', ttlMs: 100000 });
    const view = renderLock();
    await waitFor(() => expect(view.result.current.lockState.status).toBe('held'));
    releasePatientLock.mockClear();
    view.unmount();
    expect(releasePatientLock).toHaveBeenCalledTimes(1);
    expect(releasePatientLock).toHaveBeenCalledWith('server-1', 'lease-2', expect.anything());
    expect(getLockToken('local-1')).toBeNull();
  });

  it('갱신 실패로 락을 잃은 뒤에는 전역 토큰을 비우고 언마운트해도 해제 요청을 보내지 않는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    acquirePatientLock.mockResolvedValue({ leaseToken: 'lease-3', expiresAt: '2030-01-01T00:01:40Z', ttlMs: 30000 });
    renewPatientLock.mockRejectedValue(Object.assign(new Error('lost'), { status: 423 }));
    const view = renderLock();
    await waitFor(() => expect(view.result.current.lockState.status).toBe('held'));
    await vi.advanceTimersByTimeAsync(30000);
    await waitFor(() => expect(view.result.current.lockState.status).toBe('lost'));
    releasePatientLock.mockClear();
    clearAllLockTokens();
    view.unmount();
    expect(releasePatientLock).not.toHaveBeenCalled();
  });

  it('환자를 바꾸면 이전 환자의 리스만 해제하고, 다른 환자의 리스로 해제하지 않는다', async () => {
    acquirePatientLock
      .mockResolvedValueOnce({ leaseToken: 'lease-a', expiresAt: '2030-01-01T00:01:40Z', ttlMs: 100000 })
      .mockResolvedValue({ leaseToken: 'lease-b', expiresAt: '2030-01-01T00:01:40Z', ttlMs: 100000 });
    const view = renderLock();
    await waitFor(() => expect(view.result.current.lockState.status).toBe('held'));
    const leaseOf1 = getLockToken('local-1');
    releasePatientLock.mockClear();
    const other = { id: 'local-2', sync: { serverId: 'server-2', revision: 1, syncStatus: 'synced' } };
    view.rerender({ activeId: 'local-2', activePatient: other });
    await waitFor(() => expect(getLockToken('local-2')).not.toBeNull());
    expect(releasePatientLock.mock.calls.map((c) => c.slice(0, 2))).toEqual([['server-1', leaseOf1]]);
    releasePatientLock.mockClear();
    const leaseOf2 = getLockToken('local-2');
    clearAllLockTokens();
    view.unmount();
    expect(releasePatientLock.mock.calls.map((c) => c.slice(0, 2))).toEqual([['server-2', leaseOf2]]);
  });
});

