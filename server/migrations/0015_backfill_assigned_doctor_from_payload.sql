-- Backfill assigned_doctor_user_id for records where the creator was not a doctor
-- (e.g. admin/staff) but payload.data.shared.doctorName contains a resolvable name.
-- Safety: only assign when exactly 1 active doctor in the same org matches the name.
-- Ambiguous (2+ matches) and unresolved (0 matches) rows stay NULL and surface as
-- DOCTOR_NAME_UNRESOLVED warnings in the UI.

WITH doctor_matches AS (
  SELECT
    pr.id                                               AS patient_id,
    u.id                                                AS doctor_id,
    COUNT(*) OVER (PARTITION BY pr.id)                  AS match_count
  FROM patient_records pr
  JOIN users u
    ON  u.organization_id = pr.organization_id
    AND u.role            = 'doctor'
    AND u.disabled_at     IS NULL
    AND BTRIM(u.name)     = BTRIM(pr.payload #>> '{data,shared,doctorName}')
  WHERE pr.deleted_at               IS NULL
    AND pr.assigned_doctor_user_id  IS NULL
    AND NULLIF(BTRIM(pr.payload #>> '{data,shared,doctorName}'), '') IS NOT NULL
)
UPDATE patient_records pr
SET    assigned_doctor_user_id = dm.doctor_id
FROM   doctor_matches dm
WHERE  pr.id            = dm.patient_id
  AND  dm.match_count   = 1;
