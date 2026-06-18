-- 0017_video_analysis_clip_state.sql
-- 작업 영상 인간공학 분석(v6.0.0) M3-7a — clip 출처/파일상태 명시 컬럼.
-- 실 업로드 경로를 열면서 fixture/upload/apply_shell을 path prefix 추론이 아니라 명시 컬럼으로 구분한다.
--   source_type: 'fixture'(dev allowlist) | 'upload'(실 multipart 업로드) | 'apply_shell'(추론 없는 적용 셸 clip)
--   file_state : 'none'(파일 없음: apply_shell/업로드 전) | 'present'(업로드 완료) | 'deleted'(privacy_first 추론 후 원본 삭제)
-- 컬럼 간 불변식(route guard/test에서 강제): apply_shell→none&upload_path NULL, upload→none→present→deleted, fixture→present(dev).

-- source_type: nullable 추가 → backfill → NOT NULL DEFAULT + CHECK (0016 status 패턴)
ALTER TABLE video_analysis_clips ADD COLUMN IF NOT EXISTS source_type TEXT;

UPDATE video_analysis_clips
  SET source_type = CASE WHEN upload_path IS NOT NULL THEN 'fixture' ELSE 'apply_shell' END
  WHERE source_type IS NULL;

ALTER TABLE video_analysis_clips
  ALTER COLUMN source_type SET DEFAULT 'apply_shell',
  ALTER COLUMN source_type SET NOT NULL,
  ADD CONSTRAINT video_analysis_clips_source_type_chk
    CHECK (source_type IN ('fixture', 'upload', 'apply_shell'));

-- file_state: nullable 추가 → backfill → NOT NULL DEFAULT + CHECK
ALTER TABLE video_analysis_clips ADD COLUMN IF NOT EXISTS file_state TEXT;

UPDATE video_analysis_clips
  SET file_state = CASE WHEN upload_path IS NOT NULL THEN 'present' ELSE 'none' END
  WHERE file_state IS NULL;

ALTER TABLE video_analysis_clips
  ALTER COLUMN file_state SET DEFAULT 'none',
  ALTER COLUMN file_state SET NOT NULL,
  ADD CONSTRAINT video_analysis_clips_file_state_chk
    CHECK (file_state IN ('none', 'present', 'deleted'));

COMMENT ON COLUMN video_analysis_clips.source_type IS
  'clip 출처: fixture(dev allowlist) | upload(실 업로드) | apply_shell(추론 없는 적용 셸). 워커 경로해석 분기.';
COMMENT ON COLUMN video_analysis_clips.file_state IS
  '원본 파일 상태: none(없음) | present(업로드 완료) | deleted(privacy_first 추론 후 삭제).';
