import { useCallback, useEffect, useRef, useState } from 'react';
import { getStatsRun, cancelStatsRun } from '../services/statsRepository';

// PR4-B1 §B/§프론트엔드 — POST /analyze가 202를 돌려주면 이 훅이 GET /runs/:analysisRunId를
// 폴링해 종결 상태를 기다린다. 핵심 원칙(계획서 pr4-b-virtual-pnueli.md 11차 통합본 §프론트엔드):
//   - unmount 시 stop()은 진행 중인 GET fetch abort + 타이머 정리만 한다 — 서버 job
//     취소는 절대 자동 호출하지 않는다. 명시적 "취소" 버튼만 cancelStatsRun()을 부른다.
//   - start(analysisRunId)는 새/기존 id 둘 다 받을 수 있다(재마운트 시 이어서 폴링
//     가능 — 완전한 탭 간 영속은 범위 밖으로 명시적으로 미룸).
//   - 요청 세대(generation) 카운터로 낡은 폴링 응답이 최신 상태를 덮어쓰지 않게 한다.
const POLL_INTERVAL_MS = 1200;
const MAX_POLL_MS = 15 * 60 * 1000; // 클라이언트 측 안전 상한 — 서버 버그로 영원히 폴링하지 않게.

// session은 useAuth()로 내부에서 끌어오지 않고 인자로 받는다 — 이 훅을 쓰는
// StatisticsWorkbench.jsx 자체가 session을 prop으로 받는 컨벤션이라(AuthProvider
// context가 아님), 그 관례를 그대로 따른다.
export function useStatsRunPolling(session) {
  const [state, setState] = useState({ status: 'idle', analysisRunId: null, data: null, error: null });

  const generationRef = useRef(0);
  const abortRef = useRef(null);
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 진행 중인 GET fetch abort + 타이머 정리만 한다 — 서버 job 취소는 호출하지 않는다.
  const stop = useCallback(() => {
    generationRef.current += 1; // 이후 도착하는 폴링 응답은 전부 낡은 것으로 취급
    clearTimer();
    abortRef.current?.abort();
    abortRef.current = null;
  }, [clearTimer]);

  const start = useCallback((analysisRunId) => {
    stop(); // 이전 폴링이 있었다면 정리
    const generation = generationRef.current; // stop()이 이미 +1 했으므로 현재 값 사용
    startedAtRef.current = Date.now();
    setState({ status: 'polling', analysisRunId, data: null, error: null });

    const poll = async () => {
      if (generationRef.current !== generation) return; // 그 사이 stop()/새 start() 발생
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const data = await getStatsRun(analysisRunId, session, { signal: controller.signal });
        if (generationRef.current !== generation) return; // 응답 도착 사이 낡아짐

        if (data.status === 'succeeded' || data.status === 'failed' || data.status === 'cancelled') {
          setState({ status: data.status, analysisRunId, data, error: null });
          return;
        }
        // queued/running — 계속 폴링(클라이언트 측 안전 상한 확인).
        if (Date.now() - startedAtRef.current >= MAX_POLL_MS) {
          setState({ status: 'error', analysisRunId, data: null, error: new Error('폴링 시간이 너무 오래 걸립니다. 잠시 후 다시 시도해주세요.') });
          return;
        }
        timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (err) {
        if (controller.signal.aborted || generationRef.current !== generation) return; // stop()에 의한 정상 abort
        // 네트워크/5xx는 제한된 재시도, 4xx(403/404)는 즉시 중단 — err.status는
        // httpClient.js의 기존 관례(요청 실패 시 항상 세팅).
        const status = err?.status;
        if (status === 403 || status === 404) {
          setState({ status: 'error', analysisRunId, data: null, error: err });
          return;
        }
        if (Date.now() - startedAtRef.current >= MAX_POLL_MS) {
          setState({ status: 'error', analysisRunId, data: null, error: err });
          return;
        }
        timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    poll();
  }, [session, stop]);

  // 명시적 취소 버튼 전용 — 서버 job 취소를 실제로 요청한다. 로컬 상태는 즉시 바꾸지
  // 않는다(서버 진실 우선) — 다음 폴링이 status:'cancelled'를 받아올 때까지 폴링을 유지.
  const cancel = useCallback(async () => {
    if (!state.analysisRunId) return;
    try {
      await cancelStatsRun(state.analysisRunId, session);
    } catch {
      // 취소 요청 자체의 실패(예: 이미 종결됨)는 조용히 무시 — 다음 폴링이 실제
      // 최신 상태를 반영한다.
    }
  }, [state.analysisRunId, session]);

  useEffect(() => stop, [stop]); // unmount 시 폴링만 정리, 취소 호출 없음

  return { ...state, start, cancel, stop };
}
