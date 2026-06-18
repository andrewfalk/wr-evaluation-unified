-- 0018_video_analysis_artifacts.sql
-- 작업 영상 인간공학 분석(v6.0.0) M3-7b — keypoints artifact 영속화.
-- 워커는 추론 성공 시 keypoints(좌표만, 원본 프레임 미포함)를 디스크 artifact로 보존한다.
-- privacy_first에서 원본 영상은 추론 직후 삭제되므로, skeleton overlay 검수(6.0-8)의 입력은
-- result_features(intrinsic)가 아니라 이 keypoints artifact다. 파일은 uploadDir/artifacts/ 하위,
-- DB엔 경로·해시만(원본 영상은 §8.13에 따라 JSONB 저장 금지).

ALTER TABLE video_analysis_jobs ADD COLUMN IF NOT EXISTS keypoints_path   TEXT;
ALTER TABLE video_analysis_jobs ADD COLUMN IF NOT EXISTS keypoints_sha256 TEXT;

COMMENT ON COLUMN video_analysis_jobs.keypoints_path IS
  'keypoints artifact 파일 경로(uploadDir/artifacts/<jobId>.keypoints.json). overlay 검수 입력. clip TTL까지 보존.';
COMMENT ON COLUMN video_analysis_jobs.keypoints_sha256 IS
  'keypoints artifact sha256(재현성·무결성).';
