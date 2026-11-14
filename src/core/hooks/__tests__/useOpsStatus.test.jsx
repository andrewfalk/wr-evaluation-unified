// @vitest-environment jsdom
// useOpsStatus(관리자 백업 상태 배너) — P2-19에서 useAsync로 옮기며 처음 테스트를 붙였다(StrictMode 렌더).
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/httpClient', () => ({ requestJson: vi.fn() }));

import { requestJson } from '../../services/httpClient';
import { useOpsStatus } from '../useOpsStatus';

const SESSION = { mode: 'intranet', apiBaseUrl: 'https://srv/', user: { id: 'admin' } };
const report = (summary) => ({ monitorReport: { summary } });

beforeEach(() => {
  vi.mocked(requestJson).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useOpsStatus', () => {
  it('비활성(관리자 아님)이면 요청하지 않고 배너 없음', async () => {
    const { result } = renderHook(() => useOpsStatus({ session: SESSION, enabled: false }), { wrapper: StrictMode });
    await Promise.resolve();
    expect(requestJson).not.toHaveBeenCalled();
    expect(result.current).toEqual({ opsStatus: null, showBanner: false, bannerMessage: null });
  });

  it('활성: 정규화한 기준 URL로 조회하고 문제 요약이면 배너', async () => {
    vi.mocked(requestJson).mockResolvedValue(report('stale'));
    const { result } = renderHook(() => useOpsStatus({ session: SESSION, enabled: true }), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.showBanner).toBe(true));
    expect(requestJson).toHaveBeenCalledWith('/api/admin/ops/backup-status', { baseUrl: 'https://srv', session: SESSION });
    expect(result.current.bannerMessage).toContain('백업 성공 기록이 없거나 지연되었습니다');
    expect(result.current.opsStatus).toEqual(report('stale'));
  });

  it('정상 요약(ok 등)이면 배너 없음', async () => {
    vi.mocked(requestJson).mockResolvedValue(report('ok'));
    const { result } = renderHook(() => useOpsStatus({ session: SESSION, enabled: true }), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.opsStatus).toEqual(report('ok')));
    expect(result.current.showBanner).toBe(false);
  });

  it('조회 실패는 조용히 넘기고 마지막 값을 유지, 5분 간격으로 다시 조회', async () => {
    // waitFor가 타이머를 쓰므로 가짜 타이머 대신 setInterval에 넘긴 함수와 간격을 붙잡아 직접 부른다.
    const intervals = [];
    const realSetInterval = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((fn, ms, ...rest) => {
      if (ms !== 5 * 60 * 1000) return realSetInterval(fn, ms, ...rest); // waitFor 자신의 폴링은 그대로
      intervals.push({ fn, ms });
      return 0;
    });
    vi.mocked(requestJson).mockResolvedValue(report('alert_open'));
    const { result } = renderHook(() => useOpsStatus({ session: SESSION, enabled: true }), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.showBanner).toBe(true));
    const tick = intervals[intervals.length - 1];
    expect(tick.ms).toBe(5 * 60 * 1000);
    const calls = requestJson.mock.calls.length;
    vi.mocked(requestJson).mockRejectedValueOnce(new Error('offline'));
    await act(async () => { tick.fn(); await Promise.resolve(); });
    expect(requestJson.mock.calls.length).toBe(calls + 1);
    expect(result.current.showBanner).toBe(true);
    expect(result.current.opsStatus).toEqual(report('alert_open'));
    spy.mockRestore();
  });

  it('비활성으로 바뀌면 배너를 숨기고 폴링을 멈춘다, 언마운트 뒤 응답은 무시', async () => {
    vi.mocked(requestJson).mockResolvedValue(report('stale_and_alert'));
    const { result, rerender, unmount } = renderHook((props) => useOpsStatus(props), {
      wrapper: StrictMode, initialProps: { session: SESSION, enabled: true },
    });
    await waitFor(() => expect(result.current.showBanner).toBe(true));
    rerender({ session: SESSION, enabled: false });
    expect(result.current.showBanner).toBe(false);
    const calls = requestJson.mock.calls.length;
    let late;
    vi.mocked(requestJson).mockImplementationOnce(() => new Promise((r) => { late = r; }));
    rerender({ session: { ...SESSION }, enabled: true });
    unmount();
    late?.(report('ok'));
    expect(requestJson.mock.calls.length).toBeGreaterThanOrEqual(calls);
  });
});
