-- Separate "responsible physician" from "record creator".
-- owner_user_id continues to track who created/pushes the record.
-- assigned_doctor_user_id tracks the responsible physician determined by name
-- matching at creation time and changeable by admins only.
ALTER TABLE patient_records
  ADD COLUMN IF NOT EXISTS assigned_doctor_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_patient_records_assigned_doctor
  ON patient_records (organization_id, assigned_doctor_user_id)
  WHERE deleted_at IS NULL;

-- Backfill: where the creator is a doctor, copy owner to assigned doctor.
-- Records created by admin/staff/nurse remain NULL until explicitly assigned.
UPDATE patient_records pr
SET assigned_doctor_user_id = pr.owner_user_id
FROM users u
WHERE pr.owner_user_id = u.id
  AND u.role = 'doctor'
  AND pr.assigned_doctor_user_id IS NULL
  AND pr.deleted_at IS NULL;
