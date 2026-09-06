-- 서버 검증 완료시각(PR0-B2 §5.5). analytics-core 이관(PR0-B1/B2)으로 6개 모듈의
-- isComplete()가 packages/analytics-core/completion.ts로 옮겨져 서버가 클라이언트 신고에
-- 의존하지 않고 직접 완료 여부를 판정할 수 있게 됐다.
--
-- 0029의 server_observed_modules_complete_at(클라이언트 신고를 서버가 stamp)과는 별도
-- 컬럼이다 — 기존 값을 소급해 "server_verified"로 바꾸지 않는다. 그러면 원래 그 시각이
-- 무엇을 근거로 찍혔는지(client_reported)라는 provenance가 사라진다.
--
-- completion_verification_engine_version: 판정 시점의 completion.ts 로직 버전
-- (COMPLETION_ENGINE_VERSION). isComplete 기준이 나중에 바뀌면 과거에 검증된 행이 새
-- 기준으로는 다른 결과가 나올 수 있으므로, 어느 버전 기준으로 검증됐는지 추적한다.
--
-- verification_fields_consistent CHECK: 둘은 전부 NULL이거나 전부 채워진 상태여야 한다
-- (0029의 completion_fields_consistent와 동일한 형태).
ALTER TABLE patient_records
  ADD COLUMN server_verified_modules_complete_at TIMESTAMPTZ,
  ADD COLUMN completion_verification_engine_version TEXT,
  ADD CONSTRAINT completion_verification_fields_consistent CHECK (
    (server_verified_modules_complete_at IS NULL
     AND completion_verification_engine_version IS NULL)
    OR
    (server_verified_modules_complete_at IS NOT NULL
     AND completion_verification_engine_version IS NOT NULL)
  );
