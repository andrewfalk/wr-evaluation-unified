// 비동기 요청 상태 훅 — REFACTORING_ROADMAP Phase 2 C2(P2-19). 화면마다 손으로 쓰던 loading/error/data useState 묶음
// (AdminConsoleModal 탭 9 + 모달 3 + useAIAnalysis ≈ 13곳)을 대신한다. C2에서는 useOpsStatus 1곳만 옮기고 나머지는 C9 분할 때.
//
// 지키는 것:
//   - 늦게 도착한 응답은 버린다: run()을 다시 부르거나 cancel()·reset() 뒤에는 앞선 run의 결과가 상태를 바꾸지 않는다.
//   - 언마운트 뒤에는 상태를 바꾸지 않는다. mountedRef는 effect setup에서 true, cleanup에서 false로 둔다
//     (cleanup에서만 바꾸면 StrictMode 이중 effect 뒤 영구 false — 2026-09 통계 워크벤치 결함과 같은 함정).
//   - run()은 거부(reject)하지 않는다 — 실패는 status 'error' + error로 남고 결과는 undefined. 실패해도 마지막 data는 유지한다
//     (폴링 화면이 일시 오류로 내용을 잃지 않게).
import { useCallback, useEffect, useRef, useState } from 'react';

export type AsyncStatus = 'idle' | 'pending' | 'success' | 'error';

export interface AsyncState<T> {
  status: AsyncStatus;
  data: T | undefined;
  error: unknown;
}

export interface UseAsyncResult<T> extends AsyncState<T> {
  run: (task: () => Promise<T>) => Promise<T | undefined>;
  /** 진행 중인 run의 결과를 버린다(상태는 그대로). effect cleanup에서 쓴다. */
  cancel: () => void;
  /** 진행 중인 run을 버리고 처음 상태(idle, data·error 없음)로. */
  reset: () => void;
}

function initialState<T>(): AsyncState<T> {
  return { status: 'idle', data: undefined, error: undefined };
}

export function useAsync<T>(): UseAsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>(initialState);
  const seqRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
    };
  }, []);

  const run = useCallback(async (task: () => Promise<T>): Promise<T | undefined> => {
    seqRef.current += 1;
    const seq = seqRef.current;
    const isCurrent = () => mountedRef.current && seq === seqRef.current;
    if (mountedRef.current) setState((prev) => ({ status: 'pending', data: prev.data, error: undefined }));
    try {
      const data = await task();
      if (isCurrent()) setState({ status: 'success', data, error: undefined });
      return data;
    } catch (error) {
      if (isCurrent()) setState((prev) => ({ status: 'error', data: prev.data, error }));
      return undefined;
    }
  }, []);

  const cancel = useCallback(() => {
    seqRef.current += 1;
  }, []);

  const reset = useCallback(() => {
    seqRef.current += 1;
    setState(initialState<T>());
  }, []);

  return { ...state, run, cancel, reset };
}
