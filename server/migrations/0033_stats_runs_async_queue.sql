-- PR4-B1 — 통계 워크벤치 비동기 job 인프라. admission/attempt/finish 파이프라인이
-- 필요로 하는 컬럼·제약·인덱스를 추가한다. 계획서(pr4-b-virtual-pnueli.md) 11차
-- 통합본 참고 — admission의 캐시확인→합류→quota/degraded→예약 순서, finishRun의
-- 잠금+상태전이+감사 원자성, sweep의 origin별 잠금 안 재검증, claim의 queueWaitMs
-- 경계(claim: created_at > cutoff / sweep: created_at <= cutoff, 둘 다 DB now() 기준)가
-- 이 컬럼들에 의존한다.

ALTER TABLE stats_runs
  -- enqueue 시점에 얼린 실행 입력(recipe+DatasetResult+snapshot 식별정보+catalogVersion).
  -- claim 시점 워커 재실행과 GET 조회의 limited_row 재구성 양쪽이 소비한다. descriptive·
  -- bivariate·regression은 성공 후에도 expires_at까지 보존(limited_row 재구성 필요),
  -- correlation_matrix는 성공 확정 직후 즉시 NULL화(그 메커니즘이 없음), 모든 실패/취소/
  -- orphan/버전드리프트 종결은 analysisMode 무관하게 즉시 NULL화.
  ADD COLUMN frozen_dataset JSONB,
  -- 취소 "의도 확정"(durable, 즉시, 취소 핸들러가 감사와 같은 트랜잭션으로 씀)과
  -- "OS 종료 확인"(finishRun만 running→cancelled 전이를 씀)을 분리하는 플래그.
  -- COALESCE 기반 UPDATE로 반복 호출을 멱등하게 만든다(새 status 값을 추가하지 않음).
  ADD COLUMN cancel_requested_at TIMESTAMPTZ,
  ADD COLUMN cancelled_by UUID,
  -- BUSY(슬롯 경합)로 재큐잉된 횟수. MAX_REQUEUE_COUNT 초과 시 PROCESS_ERROR로 확정 실패.
  ADD COLUMN requeue_count INTEGER NOT NULL DEFAULT 0,
  -- 행별 엔진 실행 타임아웃. B1의 기존 분석은 전부 기존 config.stats.timeoutMs(30초)
  -- 그대로 — B2의 prediction 워크로드가 더 긴 값을 쓸 수 있는 배관만 지금 놓는다.
  -- statsEngine.ts의 실행 타이머·안전 타이머 양쪽에 전달돼야 한다(한쪽만 고치면
  -- 행별 timeout이 반쪽만 적용됨).
  ADD COLUMN engine_timeout_ms INTEGER NOT NULL DEFAULT 30000;

-- 0031이 만든 CHECK를 확장 — EXECUTION_VERSION_DRIFTED(claim 시점 13개 버전 상수
-- 재계산 불일치)와 QUEUE_WAIT_EXCEEDED(대기예산 초과) 추가.
ALTER TABLE stats_runs DROP CONSTRAINT stats_runs_error_code_check;
ALTER TABLE stats_runs ADD CONSTRAINT stats_runs_error_code_check CHECK (
  error_code IS NULL OR error_code IN (
    'TIMEOUT','PROCESS_ERROR','INVALID_OUTPUT','OUTPUT_TOO_LARGE','RESULT_SCHEMA_INVALID',
    'EXECUTION_VERSION_DRIFTED','QUEUE_WAIT_EXCEEDED'
  )
);

-- 0031은 succeeded/failed만 종결로 인정했다(당시 PR1은 cancelled를 절대 안 씀) —
-- cancelled도 종결 상태로 포함해 finished_at을 요구한다.
ALTER TABLE stats_runs DROP CONSTRAINT run_terminal_fields;
ALTER TABLE stats_runs ADD CONSTRAINT run_terminal_fields CHECK (
  (status IN ('succeeded','failed','cancelled') AND finished_at IS NOT NULL) OR
  (status NOT IN ('succeeded','failed','cancelled'))
);

-- claimNextQueuedRun(FOR UPDATE SKIP LOCKED)이 큐 앞머리를 빠르게 찾기 위한 인덱스.
CREATE INDEX stats_runs_queue_claim ON stats_runs (created_at) WHERE status = 'queued';
-- sweepStale(orphan 회수)이 heartbeat 만료 running 행을 찾기 위한 인덱스.
CREATE INDEX stats_runs_running_heartbeat ON stats_runs (heartbeat_at) WHERE status = 'running';
-- admission의 quota 검사(동시실행 카운트)용.
CREATE INDEX stats_runs_requested_by_inflight ON stats_runs (requested_by, status)
  WHERE status IN ('queued','running');
-- admission의 quota 검사(시간당 카운트, 상태 무관)용.
CREATE INDEX stats_runs_requested_by_created_at ON stats_runs (requested_by, created_at);
CREATE INDEX stats_runs_org_created_at ON stats_runs (organization_id, created_at);
-- (organization_id, analysis_run_id) 조회는 0032의 stats_runs_analysis_run_id_uniq가
-- 이미 커버한다 — 중복 인덱스를 추가하지 않는다.
