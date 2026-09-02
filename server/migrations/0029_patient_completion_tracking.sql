-- 평가완료 시각 추적(PR0-A). 과거 데이터로 복구가 불가능해 오늘부터 쌓기 시작한다.
--
-- server_observed_modules_complete_at은 서버가 검증한 값이 아니라 "공식 클라이언트가
-- 전체 모듈 완료를 보고한 것을 서버가 처음 수신한 시각"이다 — 판정은 클라이언트가
-- 하고 서버는 시각만 stamp한다. 서버가 직접 판정할 수 있게 되면(모듈 isComplete()가
-- analytics-core로 이관된 뒤) server_verified_modules_complete_at을 별도 컬럼으로
-- 추가한다 — 이 컬럼의 값을 소급 변경하지 않는다(원래의 provenance를 보존).
--
-- completion_fields_consistent CHECK: 관측시각/source/build버전/schema버전 4개는
-- 전부 NULL이거나 전부 채워진 상태여야 한다. completion_source는 현재 'client_reported'
-- 값만 허용한다 — server_verified는 이 컬럼의 값이 아니라 별도 컬럼으로 표현될 것이므로.
ALTER TABLE patient_records
  ADD COLUMN completion_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (completion_status IN ('draft','modules_complete','finalized','reopened')),
  ADD COLUMN server_observed_modules_complete_at TIMESTAMPTZ,
  ADD COLUMN completion_source TEXT,
  ADD COLUMN completion_client_build_version TEXT,
  ADD COLUMN completion_client_schema_version INTEGER,
  ADD CONSTRAINT completion_fields_consistent CHECK (
    (server_observed_modules_complete_at IS NULL
     AND completion_source IS NULL
     AND completion_client_build_version IS NULL
     AND completion_client_schema_version IS NULL)
    OR
    (server_observed_modules_complete_at IS NOT NULL
     AND completion_source = 'client_reported'
     AND completion_client_build_version IS NOT NULL
     AND completion_client_schema_version IS NOT NULL)
  );

CREATE INDEX patient_records_completion_status
  ON patient_records(organization_id, completion_status) WHERE deleted_at IS NULL;
