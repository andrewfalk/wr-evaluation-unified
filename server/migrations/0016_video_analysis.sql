-- 0016_video_analysis.sql
-- 작업 영상 인간공학 분석(v6.0.0) — clip/job 상태·임시파일 메타·apply 멱등성.
-- 휘발 상태(업로드/처리/삭제 대기)와 임시파일 경로는 환자 JSONB가 아니라 여기서 관리(§8.6/§8.11).
-- 최종 feature·provenance는 환자 payload(JSONB)에 저장된다.

-- 클립: 다중 job이 한 clip을 재사용·sample-detect 상태를 보존(§8.6.1).
CREATE TABLE IF NOT EXISTS video_analysis_clips (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  patient_record_id    UUID        NOT NULL REFERENCES patient_records(id) ON DELETE CASCADE,
  process_id           TEXT,
  upload_path          TEXT,        -- mock 단계 NULL 허용; M3 실제 업로드부터 채움
  original_sha256      TEXT,        -- mock NULL 허용
  sample_detect_result JSONB,       -- sample-detect 상태/person box 후보(컬럼 난립 방지)
  target_person_id     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ
);

CREATE TRIGGER video_analysis_clips_updated_at
  BEFORE UPDATE ON video_analysis_clips
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS video_analysis_clips_patient_idx
  ON video_analysis_clips(patient_record_id);

-- Job: 본 분석 단위. organization_id/patient_record_id는 clip 조회로 서버가 채우는 denormalize
-- (인덱스/큐 조회 정합성 — 클라 body 값은 신뢰하지 않음).
CREATE TABLE IF NOT EXISTS video_analysis_jobs (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  patient_record_id      UUID        NOT NULL REFERENCES patient_records(id) ON DELETE CASCADE,
  clip_id                UUID        NOT NULL REFERENCES video_analysis_clips(id) ON DELETE CASCADE,
  process_id             TEXT,
  status                 TEXT        NOT NULL DEFAULT 'queued'
                           CHECK (status IN (
                             'uploaded','sample_detecting','awaiting_target_selection','target_selected',
                             'queued','processing','review_pending','done','error','expired','cancelled'
                           )),
  analysis_profile       TEXT,
  requested_features     JSONB,
  result_features        JSONB,      -- mock 단계: 검수용 결과(있으면). 실제 추론은 M2에서 채움.
  original_sha256        TEXT,       -- mock NULL 허용
  analysis_input_sha256  TEXT,       -- mock NULL 허용
  preprocess_config_hash TEXT,
  applied_at             TIMESTAMPTZ, -- apply 시각(멱등성)
  applied_revision       INTEGER,     -- apply 후 환자 revision
  applied_inputs_hash    TEXT,        -- 승인된 적용 요청 canonical 해시(재시도 멱등)
  error_code             TEXT,
  error_message          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ
);

CREATE TRIGGER video_analysis_jobs_updated_at
  BEFORE UPDATE ON video_analysis_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS video_analysis_jobs_org_status_idx
  ON video_analysis_jobs(organization_id, status);
CREATE INDEX IF NOT EXISTS video_analysis_jobs_patient_idx
  ON video_analysis_jobs(patient_record_id);
CREATE INDEX IF NOT EXISTS video_analysis_jobs_created_idx
  ON video_analysis_jobs(created_at DESC);

COMMENT ON TABLE video_analysis_clips IS
  '영상 분석 클립 메타·임시파일 경로·sample-detect 상태. 원본 영상은 JSONB에 저장 금지(§8.13).';
COMMENT ON TABLE video_analysis_jobs IS
  '영상 분석 본 분석 job 상태머신(§8.5) + apply 멱등성. 최종 feature/provenance는 환자 payload에 저장.';
