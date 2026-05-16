-- 0006_patient_no_audit_retention.sql
-- Tighten patient number semantics and document audit retention posture.

-- Patient numbers are unique within a hospital/organization while the patient
-- record is active. Blank strings are normalized to NULL before the unique
-- index is created so "no patient number" remains allowed.
UPDATE patient_records
SET patient_no = NULL
WHERE patient_no IS NOT NULL AND btrim(patient_no) = '';

UPDATE patient_records
SET patient_no = btrim(patient_no)
WHERE patient_no IS NOT NULL AND patient_no <> btrim(patient_no);

CREATE UNIQUE INDEX IF NOT EXISTS patient_records_org_patient_no_uniq
  ON patient_records (organization_id, patient_no)
  WHERE deleted_at IS NULL AND patient_no IS NOT NULL;

COMMENT ON INDEX patient_records_org_patient_no_uniq IS
  'Active patient numbers are unique within each organization. Soft-deleted patients do not reserve the number.';

-- Policy marker for operations and schema readers. Actual partition cleanup is
-- intentionally not automated here; healthcare audit logs should be reviewed
-- and exported before any destructive retention job is introduced.
COMMENT ON TABLE audit_logs IS
  'Append-only access/audit log. Retention target: at least 10 years for healthcare PHI access traceability.';

COMMENT ON COLUMN audit_logs.target_id IS
  'Target UUID or non-PHI hash. Do not store patient name, resident number, diagnosis text, or other PHI here.';

COMMENT ON COLUMN audit_logs.extra IS
  'Minimal JSON metadata only. Avoid PHI; prefer reason codes, flags, and hashed identifiers.';
