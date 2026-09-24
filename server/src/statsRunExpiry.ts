import config from './config';

// stats_runs.expires_at 계산 — idempotency 캐시 TTL(succeeded 행)과 admission이
// queued 행을 예약할 때 쓰는 값이 같은 정책을 공유한다(PR4-B1 — statsAnalyzeHandler.ts
// 에서 이관, statsRunAdmission.ts도 재사용).
export function statsRunExpiresAt(): Date {
  return new Date(Date.now() + config.stats.resultTtlHours * 60 * 60 * 1000);
}
