// PR4-B1 — stats_runs 행의 타입. 컬럼명을 그대로 snake_case로 쓴다(이 저장소의
// 기존 관례 — pg가 반환하는 raw row 키가 DB 컬럼명과 정확히 일치, 별도 camelCase
// 매핑 레이어 없음).
import type { AnalyzeResult, StatsRunErrorCode, StatsRunManifest } from '@wr/contracts';
import type { FrozenAnalysisInput } from './statsAnalysisContext';

export type StatsRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

// admission/queue/routes 세 곳이 같은 컬럼 목록을 쓴다 — SELECT * 대신 명시해
// StatsRunRow와 어긋나지 않게 한다.
export const STATS_RUN_COLUMNS = `
  id, organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
  requested_disclosure_profile, cacheable, manifest, result, error_code, worker_pid,
  heartbeat_at, created_at, started_at, finished_at, expires_at, analysis_run_id,
  frozen_dataset, cancel_requested_at, cancelled_by, requeue_count, engine_timeout_ms
`;

export interface StatsRunRow {
  id: string;
  organization_id: string;
  requested_by: string | null;
  status: StatsRunStatus;
  recipe_digest: string;
  source_digest: string;
  execution_digest: string;
  requested_disclosure_profile: string;
  cacheable: boolean;
  manifest: StatsRunManifest;
  result: AnalyzeResult | null;
  error_code: StatsRunErrorCode | null;
  worker_pid: number | null;
  heartbeat_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  expires_at: Date;
  analysis_run_id: string;
  frozen_dataset: FrozenAnalysisInput | null;
  cancel_requested_at: Date | null;
  cancelled_by: string | null;
  requeue_count: number;
  engine_timeout_ms: number;
}
