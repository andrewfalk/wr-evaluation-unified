-- 0022_inference_device.sql
-- 작업 영상 인간공학 분석(6.0-12) — 추론 디바이스(GPU) 토글.
-- 조직 단위로 추론 디바이스를 선택(auto/cpu/cuda)하고, 각 job에 실제 실행된 디바이스·폴백 여부를 기록한다.
--   organizations.inference_device           : 'auto'(GPU 가능 시 사용, 실패 시 CPU 폴백) | 'cpu' | 'cuda'(강제)
--   video_analysis_jobs.inference_device_used : 실제 추론에 쓰인 디바이스('cpu'|'cuda', 미실행 job은 NULL)
--   video_analysis_jobs.inference_device_fallback        : auto에서 cuda→cpu로 폴백했으면 true
--   video_analysis_jobs.inference_device_fallback_reason : 폴백/감지 사유(UI tooltip·운영 디버깅)
-- 컬럼 추가와 CHECK 제약을 분리(IF NOT EXISTS / DO $$)해 이미 컬럼이 있는 DB에서도 제약이 누락되지 않게 한다.

-- organizations.inference_device --------------------------------------------------
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS inference_device TEXT NOT NULL DEFAULT 'auto';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_inference_device_chk'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_inference_device_chk
      CHECK (inference_device IN ('auto', 'cpu', 'cuda'));
  END IF;
END $$;

-- video_analysis_jobs 실행 결과 컬럼 ------------------------------------------------
ALTER TABLE video_analysis_jobs ADD COLUMN IF NOT EXISTS inference_device_used TEXT;
ALTER TABLE video_analysis_jobs ADD COLUMN IF NOT EXISTS inference_device_fallback BOOLEAN;
ALTER TABLE video_analysis_jobs ADD COLUMN IF NOT EXISTS inference_device_fallback_reason TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'video_analysis_jobs_inference_device_used_chk'
  ) THEN
    ALTER TABLE video_analysis_jobs
      ADD CONSTRAINT video_analysis_jobs_inference_device_used_chk
      CHECK (inference_device_used IS NULL OR inference_device_used IN ('cpu', 'cuda'));
  END IF;
END $$;

COMMENT ON COLUMN organizations.inference_device IS
  '추론 디바이스 정책(6.0-12): auto(GPU 가능 시 사용·실패 시 CPU 폴백) | cpu | cuda(강제, 실패 시 job error).';
COMMENT ON COLUMN video_analysis_jobs.inference_device_used IS
  '실제 추론에 쓰인 디바이스(cpu|cuda). 미실행 job은 NULL. UI 실행 모드 배지.';
COMMENT ON COLUMN video_analysis_jobs.inference_device_fallback IS
  'auto 정책에서 cuda→cpu로 폴백했으면 true(검토 UI "CPU(폴백)" 구분).';
COMMENT ON COLUMN video_analysis_jobs.inference_device_fallback_reason IS
  '폴백/감지 사유 텍스트(UI tooltip·운영 디버깅).';
