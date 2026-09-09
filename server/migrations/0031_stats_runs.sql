-- PR1 — Python subprocess 기술통계 실행 결과 영속화. 마스터 계획서 §10/§8.1 stats_runs
-- 스케치를 6차례 검토를 거쳐 다듬은 최종안이다(pr1-giggly-treehouse.md 참고).
--
-- PR1은 이 테이블에 항상 종결 상태('succeeded'|'failed')로만 INSERT한다 — 'queued'/
-- 'running'/'cancelled'는 CHECK 제약값으로만 존재하고 PR1 코드 경로에서는 절대 쓰지
-- 않는다(비동기 job 모델은 PR2). worker_pid/heartbeat_at 컬럼은 그 대비로 미리 만들어
-- 두되 PR1은 항상 NULL로 둔다.
CREATE TABLE stats_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  requested_by      UUID,
  status            TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  recipe_digest     TEXT NOT NULL,
  source_digest     TEXT NOT NULL,
  execution_digest  TEXT NOT NULL,
  requested_disclosure_profile TEXT NOT NULL,
  -- 요청 단위 억제(코호트 미달/differencing 초과) 결과는 false — differencing 상태는
  -- 시간에 따라 바뀌므로 execution_digest 캐시로 재사용하면 안 된다(계획서 §5).
  cacheable         BOOLEAN NOT NULL DEFAULT true,
  -- shape은 애플리케이션 레벨 discriminated union(StatsRunManifestSchema, 계획서 §4.5)으로
  -- 구분한다 — 성공 행은 resultDigest 필수 문자열, 실패 행은 그 필드 자체가 없다(생략).
  manifest          JSONB NOT NULL,
  result            JSONB,
  error_code        TEXT CHECK (error_code IS NULL OR error_code IN
                      ('TIMEOUT','PROCESS_ERROR','INVALID_OUTPUT','OUTPUT_TOO_LARGE','RESULT_SCHEMA_INVALID')),
  worker_pid        INTEGER,
  heartbeat_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ NOT NULL,

  -- 복합 FK의 기본 ON DELETE SET NULL은 (requested_by, organization_id) 둘 다 NULL로
  -- 바꾸려 하는데 organization_id는 NOT NULL이라 사용자 삭제가 실패한다(0028의
  -- capability grant는 별도 nullable granted_by_org로 이 문제를 피했지만, 이 테이블은
  -- 조직이 실행의 핵심 축이라 그 패턴을 재사용하지 않는다). PG16의 컬럼 지정 SET NULL로
  -- requested_by만 NULL화하고 organization_id·행 자체는 유지한다.
  CONSTRAINT run_requester_in_org FOREIGN KEY (requested_by, organization_id)
    REFERENCES users(id, organization_id) ON DELETE SET NULL (requested_by),

  CONSTRAINT run_terminal_fields CHECK (
    (status IN ('succeeded','failed') AND finished_at IS NOT NULL) OR (status NOT IN ('succeeded','failed'))
  ),
  -- 성공 행은 result 필수+error_code 없음, 실패 행은 그 반대 — 상태와 결과 필드의 짝을
  -- CHECK로 강제한다(계획서 §3, "종결 상태만 요구할 뿐 result/error_code 조합은 강제 안
  -- 했다"는 1차 초안의 결함 수정).
  CONSTRAINT run_result_error_pairing CHECK (
    (status = 'succeeded' AND result IS NOT NULL AND error_code IS NULL) OR
    (status = 'failed'    AND result IS NULL     AND error_code IS NOT NULL) OR
    (status NOT IN ('succeeded','failed'))
  )
);

-- PR2가 비동기 실행을 켤 때 유효해지는 인덱스(PR1에선 no-op — queued/running 행이 없음).
CREATE UNIQUE INDEX stats_runs_inflight_uniq
  ON stats_runs (organization_id, execution_digest)
  WHERE status IN ('queued','running');

-- idempotency 캐시의 유일성 보장 — cacheable 행만 대상(요청 단위 억제는 cacheable=false라
-- 여러 개가 쌓여도 무방, 서로 충돌하지 않는다). 교차 프로세스 idempotency의 2차 방어선
-- (1차는 in-process in-flight map, statsAnalyzeInFlight.ts) — 단일 인스턴스 배포 전제가
-- 바뀌어도 DB 레벨에서 안전하다. expires_at은 immutable 함수가 아닌 now()를 predicate에
-- 못 써서 조건에서 제외 — TTL 만료 행 교체는 요청 처리 시점의 DELETE-then-INSERT가
-- 담당한다(statsAnalyzeInFlight.ts), 주기적 cleanup job(§8)은 저장공간 정리용일 뿐이다.
CREATE UNIQUE INDEX stats_runs_succeeded_uniq
  ON stats_runs (organization_id, execution_digest) WHERE status = 'succeeded' AND cacheable;

CREATE INDEX stats_runs_execution_digest_lookup
  ON stats_runs (organization_id, execution_digest, status, cacheable, expires_at);
CREATE INDEX stats_runs_expires_at ON stats_runs (expires_at);
