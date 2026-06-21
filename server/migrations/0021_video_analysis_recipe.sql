-- 0021_video_analysis_recipe.sql
-- 작업 영상 인간공학 분석(v6.0.0) M4 6.0-9 — recipe versioning(§8.11).
-- 워커가 추론 성공 시 재현성 recipe(모델 버전·가중치 sha·preprocessConfigHash·featureConfig·
-- mapping/viewpoint 버전·code commit·status)를 구조적으로 영속한다. apply 라우트가 환자 기록에
-- 들어가는 appliedInputs[].recipe를 이 저장본(서버 source of truth)과 대조해 검증한다.
-- 영상은 안 남겨도 이 recipe로 "같은 입력·모델·코드에서 나온 값"임을 증명(법적 방어가능성).

ALTER TABLE video_analysis_jobs ADD COLUMN IF NOT EXISTS analysis_recipe JSONB;

COMMENT ON COLUMN video_analysis_jobs.analysis_recipe IS
  'recipe versioning(§8.11). { status, modelVersion, detectorSha256, poseSha256, preprocessConfigHash, featureConfigVersion, mappingConfigVersion, viewpointConfigVersion, codeCommit }. apply 검증의 서버 source of truth.';
