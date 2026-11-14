// @vitest-environment jsdom
// usePatientScope·useDoctorRoster(REFACTORING_ROADMAP Phase 2 P2-27) — StrictMode 렌더.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../core/services/patientServerRepository', () => ({ fetchDoctorCounts: vi.fn() }));

import { fetchDoctorCounts } from '../../core/services/patientServerRepository';
import { useDoctorRoster, usePatientScope } from '../usePatientScope';

const doctor = { mode: 'intranet', apiBaseUrl: 'https://srv', user: { id: 'd1', role: 'doctor', organizationId: 'o1' } };
const admin = { mode: 'intranet', apiBaseUrl: 'https://srv', user: { id: 'a1', role: 'admin', organizationId: 'o1' } };
const local = { mode: 'local', user: { id: 'web-user', role: 'clinician' } };
const ROSTER = { doctors: [{ userId: 'd1', name: '김의사', count: 2 }, { userId: 'd2', name: '이의사', count: 1 }], unassignedCount: 1 };

beforeEach(() => {
  vi.mocked(fetchDoctorCounts).mockReset();
  vi.mocked(fetchDoctorCounts).mockResolvedValue(ROSTER);
});
afterEach(() => vi.restoreAllMocks());

describe('usePatientScope', () => {
  it('기본값·파생값: 의사는 mine, 관리자는 all(mine 불가), 로컬은 mine·대시보드 scope 없음', () => {
    const d = renderHook(() => usePatientScope(doctor), { wrapper: StrictMode }).result.current;
    expect(d).toMatchObject({ patientScope: 'mine', effectivePatientScope: 'mine', canUseMinePatientScope: true, canUseDashboardScope: true, effectiveDashboardScope: 'mine' });
    const a = renderHook(() => usePatientScope(admin), { wrapper: StrictMode }).result.current;
    expect(a).toMatchObject({ patientScope: 'all', canUseMinePatientScope: false, canUseDashboardScope: true });
    const l = renderHook(() => usePatientScope(local), { wrapper: StrictMode }).result.current;
    expect(l).toMatchObject({ patientScope: 'mine', canUseMinePatientScope: true, canUseDashboardScope: false, effectiveDashboardScope: 'all' });
  });

  it('관리자의 mine은 정규화에서 all로', () => {
    const { result } = renderHook(() => usePatientScope(admin), { wrapper: StrictMode });
    act(() => result.current.setPatientScope('mine'));
    expect(result.current.patientScope).toBe('mine');
    expect(result.current.effectivePatientScope).toBe('all');
  });

  it('세션(모드·사용자·역할)이 바뀌면 두 scope를 새 세션 기본값으로', () => {
    const { result, rerender } = renderHook((s) => usePatientScope(s), { wrapper: StrictMode, initialProps: doctor });
    act(() => { result.current.setPatientScope('d2'); result.current.setDashboardScope('__unassigned__'); });
    rerender({ ...doctor }); // 같은 사용자 — 그대로
    expect(result.current.patientScope).toBe('d2');
    rerender(admin);
    expect(result.current).toMatchObject({ patientScope: 'all', dashboardScope: 'all' });
  });
});

function useBoth({ session, isAuthenticated = true, sessionVerified = true, syncState = { status: 'idle', lastSyncedAt: 1 } }) {
  const scope = usePatientScope(session);
  const roster = useDoctorRoster({ session, settings: {}, isAuthenticated, sessionVerified, syncState, scope });
  return { scope, roster };
}

describe('useDoctorRoster', () => {
  it('인증된 인트라넷 사용자면 명부를 조회해 ready', async () => {
    const { result } = renderHook((p) => useBoth(p), { wrapper: StrictMode, initialProps: { session: doctor } });
    await waitFor(() => expect(result.current.roster.doctorRosterStatus).toBe('ready'));
    expect(result.current.roster.doctorRoster).toEqual(ROSTER);
    expect(fetchDoctorCounts).toHaveBeenCalledWith({ session: doctor, settings: {} });
  });

  it('로컬·미인증·세션 확인 전·임시 비밀번호면 조회하지 않고 빈 명부 + loading', async () => {
    for (const props of [
      { session: local },
      { session: doctor, isAuthenticated: false },
      { session: doctor, sessionVerified: false },
      { session: { ...doctor, user: { ...doctor.user, mustChangePassword: true } } },
    ]) {
      const { result, unmount } = renderHook((p) => useBoth(p), { wrapper: StrictMode, initialProps: props });
      await Promise.resolve();
      expect(result.current.roster).toMatchObject({ doctorRoster: { doctors: [], unassignedCount: 0 }, doctorRosterStatus: 'loading' });
      unmount();
    }
    expect(fetchDoctorCounts).not.toHaveBeenCalled();
  });

  it('동기화가 끝날 때마다(lastSyncedAt) 다시 조회, 실패하면 마지막 명부 유지 + error', async () => {
    const { result, rerender } = renderHook((p) => useBoth(p), { wrapper: StrictMode, initialProps: { session: doctor, syncState: { status: 'idle', lastSyncedAt: 1 } } });
    await waitFor(() => expect(result.current.roster.doctorRosterStatus).toBe('ready'));
    const calls = fetchDoctorCounts.mock.calls.length;
    vi.mocked(fetchDoctorCounts).mockRejectedValueOnce(new Error('offline'));
    rerender({ session: doctor, syncState: { status: 'idle', lastSyncedAt: 2 } });
    await waitFor(() => expect(result.current.roster.doctorRosterStatus).toBe('error'));
    expect(fetchDoctorCounts.mock.calls.length).toBe(calls + 1);
    expect(result.current.roster.doctorRoster).toEqual(ROSTER);
  });

  it('명부가 ready가 되면 사라진 의사 scope는 기본값으로(사이드바·대시보드 모두)', async () => {
    const { result } = renderHook((p) => useBoth(p), { wrapper: StrictMode, initialProps: { session: doctor } });
    act(() => { result.current.scope.setPatientScope('gone-doctor'); result.current.scope.setDashboardScope('d2'); });
    await waitFor(() => expect(result.current.scope.patientScope).toBe('mine'));
    expect(result.current.scope.dashboardScope).toBe('d2'); // 명부에 있는 의사는 유지
  });

  it('isDashboardScopeLoading = 대시보드 scope 사용 가능 && syncing && 불러온 scope가 다름', () => {
    const syncing = { status: 'syncing', loadedScope: 'all', lastSyncedAt: 1 };
    const { result, rerender } = renderHook((p) => useBoth(p), { wrapper: StrictMode, initialProps: { session: doctor, syncState: syncing } });
    expect(result.current.roster.isDashboardScopeLoading).toBe(true); // 대시보드 scope 'mine' ≠ loaded 'all'
    rerender({ session: doctor, syncState: { ...syncing, loadedScope: 'mine' } });
    expect(result.current.roster.isDashboardScopeLoading).toBe(false);
    rerender({ session: doctor, syncState: { status: 'error', loadedScope: 'all', lastSyncedAt: 1 } });
    expect(result.current.roster.isDashboardScopeLoading).toBe(false);
    rerender({ session: local, syncState: syncing });
    expect(result.current.roster.isDashboardScopeLoading).toBe(false);
  });
});
