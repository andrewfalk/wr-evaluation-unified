-- 0019_video_analysis_sample_frame.sql
-- 작업 영상 인간공학 분석(v6.0.0) — 대상자 선택용 대표 프레임 썸네일 artifact 경로.
-- privacy 정책 예외(동의+인트라넷 전제, VIDEO_ANALYSIS_TARGET_THUMBNAIL=true)에서만 생성된다.
-- 썸네일 파일은 uploadDir/artifacts/<clipId>.<uuid>.thumb.jpg(다운스케일 JPEG); DB엔 경로만(§8.13 원본/이미지 JSONB 저장 금지).
-- 식별 가능 이미지라 select-target 성공·retention A·clip TTL·orphan sweep에서 적극 회수한다.

ALTER TABLE video_analysis_clips ADD COLUMN IF NOT EXISTS sample_frame_path TEXT;

COMMENT ON COLUMN video_analysis_clips.sample_frame_path IS
  '대상자 선택용 대표 프레임 썸네일(JPEG) 파일 경로. privacy 예외에서만; 선택/분석 후 회수.';
