// @vitest-environment jsdom
// useOpsStatus의 새로고침 통로(P2-83e) — 운영 상태 탭이 알림을 처리한 뒤 배너를 다음 폴링(5분)까지 기다리지 않고 다시 판정한다.
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/httpClient', () => ({ requestJson: vi.fn() }));

import { requestJson } from '../../services/httpClient';
import { useOpsStatus } from '../useOpsStatus';

const SESSION = { mode: 'intranet', apiBaseUrl: 'https://srv.test/' };
const report = (summary: string) => ({ monitorReport: { summary } });

beforeEach(() => {
  vi.mocked(requestJson).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useOpsStatus — refresh', () => {
  it('켜져 있으면 지금 다시 불러와 배너를 새 요약으로 판정한다', async () => {
    vi.mocked(requestJson).mockResolvedValue(report('alert_open'));
    const { result } = renderHook(() => useOpsStatus({ session: SESSION, enabled: true }), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.showBanner).toBe(true));
    const before = vi.mocked(requestJson).mock.calls.length;
    vi.mocked(requestJson).mockResolvedValue(report('ok'));
    act(() => { result.current.refresh(); });
    await waitFor(() => expect(result.current.showBanner).toBe(false));
    expect(vi.mocked(requestJson).mock.calls.length).toBe(before + 1);
    expect(vi.mocked(requestJson).mock.calls.at(-1)).toEqual(['/api/admin/ops/backup-status', { baseUrl: 'https://srv.test', session: SESSION }]);
  });

  it('꺼져 있으면(관리자 아님) 아무것도 하지 않는다', async () => {
    const { result } = renderHook(() => useOpsStatus({ session: SESSION, enabled: false }), { wrapper: StrictMode });
    act(() => { result.current.refresh(); });
    await Promise.resolve();
    expect(requestJson).not.toHaveBeenCalled();
    expect(result.current.showBanner).toBe(false);
  });
});
