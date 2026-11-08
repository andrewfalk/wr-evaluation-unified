// Stats engine error classes (mapped to HTTP by stats/engine/errorMapping.ts).
// Split out of stats/engine/index.ts (S6 P1-34); handler bodies unchanged.

export class StatsEngineBusyError extends Error {
  constructor() { super('stats engine worker slot is busy'); this.name = 'StatsEngineBusyError'; }
}
export class StatsEngineTimeoutError extends Error {
  constructor() { super('stats engine process timed out'); this.name = 'StatsEngineTimeoutError'; }
}
export class StatsEngineOutputTooLargeError extends Error {
  constructor() { super('stats engine process output exceeded size limit'); this.name = 'StatsEngineOutputTooLargeError'; }
}
export class StatsEngineProcessError extends Error {
  public code: 'PROCESS_ERROR' | 'INVALID_OUTPUT';
  constructor(code: 'PROCESS_ERROR' | 'INVALID_OUTPUT', message: string) {
    super(message);
    this.name = 'StatsEngineProcessError';
    this.code = code;
  }
}
export class StatsEngineResultInvalidError extends Error {
  constructor(message: string) { super(message); this.name = 'StatsEngineResultInvalidError'; }
}
// §2.1 최종 안전 타이머가 발동한 뒤 — 엔진 상태가 불확실해 신뢰 회복까지(서버 재시작)
// 신규 작업을 받지 않는다. 자동 복구는 PR1 범위 밖(PR2 검토 대상).
export class StatsEngineDegradedError extends Error {
  constructor() { super('stats engine is degraded — process termination could not be confirmed'); this.name = 'StatsEngineDegradedError'; }
}
// §7.4 — spawn 전 입력 상한 위반(변수당/총합/문자열길이/전체 바이트). 세마포어를 건드리지
// 않는 순수 입력 검증 실패라 §5 표의 INPUT_TOO_LARGE(감사만, stats_runs 행 없음)로 매핑된다.
export class StatsEngineInputTooLargeError extends Error {
  constructor(message: string) { super(message); this.name = 'StatsEngineInputTooLargeError'; }
}
// PR4-B1 §0/§C — 비동기 job 취소. AbortSignal이 spawn 전/후 어느 시점에 abort되든
// 이 에러로 수렴한다. finishRun이 cancel_requested_at을 outcome.kind와 무관하게
// 재확인하므로, 이 에러의 정확한 발생 시점은 결과에 영향을 주지 않는다.
export class StatsEngineCancelledError extends Error {
  constructor() { super('stats engine process was cancelled'); this.name = 'StatsEngineCancelledError'; }
}
