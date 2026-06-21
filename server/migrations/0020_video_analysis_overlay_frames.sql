-- 0020_video_analysis_overlay_frames.sql
-- 작업 영상 인간공학 분석(v6.0.0) — 골격 검수 overlay 실 프레임(privacy 정책 예외, 게이트 off 기본).
-- VIDEO_ANALYSIS_OVERLAY_FRAMES on일 때만 워커가 샘플 프레임을 다운스케일 JPEG로 추출해
-- uploadDir/artifacts/<jobId>.frames/ 디렉터리에 보관하고, DB엔 그 디렉터리 경로만 둔다(원본 영상 JSONB 저장 금지 §8.13).
-- 프레임은 식별 가능 이미지 → keypoints artifact와 같은 수명(clip TTL/close-review까지). sha 불필요(이미지·미파싱).

ALTER TABLE video_analysis_jobs ADD COLUMN IF NOT EXISTS frames_path TEXT;

COMMENT ON COLUMN video_analysis_jobs.frames_path IS
  'overlay 실 프레임 디렉터리 경로(uploadDir/artifacts/<jobId>.frames). 게이트 on 추출 시에만. close-review/clip TTL/cleanup 회수.';
