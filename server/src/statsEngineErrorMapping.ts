// PR4-B1 — statsAnalyzeHandler.ts(HTTP, 무수정 재사용)와 statsRunsQueue.ts(워커)가
// 공유하는 엔진 에러 분류. 원래 statsAnalyzeHandler.ts에만 있던 로직을 그대로 옮긴
// 것 — 로직 복제가 아니라 단일 진실원을 두는 것이 목적이다(계획서 11차 통합본
// §C "mapEngineErrorToDbCode" — errorCodeForFailure 재사용).
//
// StatsEngineInputTooLargeError/StatsEngineDegradedError는 'denied'로 분류된다 —
// "실행 전 거부"(worker가 시작조차 못함)와 "실제로 시작한 worker의 실패"는 다르게
// 저장·감사해야 한다는 원칙(statsAnalyzeHandler.ts 파일 헤더 주석)이 워커 쪽에도
// 그대로 적용된다. §0의 사전검사(입력상한·degraded)가 이 두 에러를 admission
// 이전에 이미 걸러내므로, 워커의 attempt()에서 이 분류를 만나는 건 방어적 재검사가
// 우연히 트리거된 극히 드문 경우여야 한다 — 그래도 DB error_code에 PROCESS_ERROR
// 대신 잘못된 값을 넣는 사고를 막기 위해 분류 자체는 여기서 정확히 한다.
import {
  StatsEngineBusyError,
  StatsEngineDegradedError,
  StatsEngineInputTooLargeError,
  StatsEngineOutputTooLargeError,
  StatsEngineProcessError,
  StatsEngineResultInvalidError,
  StatsEngineTimeoutError,
} from './statsEngine';

export type EngineErrorClassification = 'denied' | 'failure';

export function classifyEngineError(err: unknown): EngineErrorClassification {
  if (
    err instanceof StatsEngineBusyError ||
    err instanceof StatsEngineDegradedError ||
    err instanceof StatsEngineInputTooLargeError
  ) {
    return 'denied';
  }
  return 'failure';
}

export function reasonCodeForDenied(err: unknown): string {
  if (err instanceof StatsEngineBusyError) return 'ENGINE_BUSY';
  if (err instanceof StatsEngineDegradedError) return 'ENGINE_DEGRADED';
  if (err instanceof StatsEngineInputTooLargeError) return 'INPUT_TOO_LARGE';
  return 'UNKNOWN_DENIED';
}

// StatsEngineCancelledError는 이 매핑에서 PROCESS_ERROR로 떨어진다 — 실제로
// 취소가 원인이었다면 finishRun의 cancel_requested_at 재확인이 outcome.kind와
// 무관하게 'cancelled'로 덮어쓰므로 이 매핑값 자체는 결과에 영향을 주지 않는다.
export function errorCodeForFailure(
  err: unknown,
): 'TIMEOUT' | 'PROCESS_ERROR' | 'INVALID_OUTPUT' | 'OUTPUT_TOO_LARGE' | 'RESULT_SCHEMA_INVALID' {
  if (err instanceof StatsEngineTimeoutError) return 'TIMEOUT';
  if (err instanceof StatsEngineOutputTooLargeError) return 'OUTPUT_TOO_LARGE';
  if (err instanceof StatsEngineResultInvalidError) return 'RESULT_SCHEMA_INVALID';
  if (err instanceof StatsEngineProcessError) return err.code === 'INVALID_OUTPUT' ? 'INVALID_OUTPUT' : 'PROCESS_ERROR';
  return 'PROCESS_ERROR';
}

export function httpStatusFor(err: unknown): number {
  if (err instanceof StatsEngineBusyError) return 429;
  if (err instanceof StatsEngineDegradedError) return 503;
  if (err instanceof StatsEngineInputTooLargeError) return 400;
  return 500;
}

// err.message를 HTTP 응답에 그대로 실으면 spawn 실행 경로, 의미검증의 기대/실제 n,
// DB 오류 문구 등 서버 내부 정보가 새어나간다 — 코드별 고정 메시지만 응답에 싣고,
// 실제 상세는 로그로만 남긴다(7차 검토 필수 수정, statsAnalyzeHandler.ts에서 이관).
const DENIED_MESSAGES: Record<string, string> = {
  ENGINE_BUSY: 'Analysis engine is busy — please retry shortly.',
  ENGINE_DEGRADED: 'Analysis engine is temporarily unavailable.',
  INPUT_TOO_LARGE: 'The recipe exceeds the supported size for statistical analysis.',
  UNKNOWN_DENIED: 'Request denied.',
};
const FAILURE_MESSAGES: Record<string, string> = {
  TIMEOUT: 'Analysis timed out.',
  PROCESS_ERROR: 'Analysis engine failed to complete.',
  INVALID_OUTPUT: 'Analysis engine returned invalid output.',
  OUTPUT_TOO_LARGE: 'Analysis output exceeded the supported size.',
  RESULT_SCHEMA_INVALID: 'Analysis engine returned a result that failed validation.',
};

export function errorBodyFor(err: unknown): { code: string; error: string } {
  const classification = classifyEngineError(err);
  const code = classification === 'denied' ? reasonCodeForDenied(err) : errorCodeForFailure(err);
  const message = (classification === 'denied' ? DENIED_MESSAGES[code] : FAILURE_MESSAGES[code]) ?? 'Analysis request failed.';
  console.error('[stats-analyze] request failed', { code, classification, detail: err instanceof Error ? err.message : err });
  return { code, error: message };
}
