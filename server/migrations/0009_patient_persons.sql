-- 0009_patient_persons.sql
-- Split patient identity (person) from evaluation/injury records (cases).
--
-- Domain model:
--   patient_persons: one real patient/person per organization + patient_no.
--   patient_records: one evaluation/injury case. Multiple records may point to
--                    the same person when injury_date/evaluation_date differs.

CREATE TABLE IF NOT EXISTS patient_persons (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  patient_no      TEXT,
  name            TEXT        NOT NULL,
  birth_date      DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE TRIGGER patient_persons_updated_at
  BEFORE UPDATE ON patient_persons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Normalize any pre-existing patient numbers before moving uniqueness to the
-- person table.
UPDATE patient_records
SET patient_no = NULL
WHERE patient_no IS NOT NULL AND btrim(patient_no) = '';

UPDATE patient_records
SET patient_no = btrim(patient_no)
WHERE patient_no IS NOT NULL AND patient_no <> btrim(patient_no);

ALTER TABLE patient_records
  ADD COLUMN IF NOT EXISTS patient_person_id UUID,
  ADD COLUMN IF NOT EXISTS injury_date DATE;

-- Backfill person rows for records with a patient number. Existing unique
-- patient_no semantics mean active duplicates should not exist, but deleted
-- historical records may share the number; they intentionally resolve to the
-- same person.
INSERT INTO patient_persons (organization_id, patient_no, name, birth_date, created_at, updated_at)
SELECT DISTINCT ON (organization_id, patient_no)
       organization_id,
       patient_no,
       name,
       birth_date,
       created_at,
       updated_at
FROM patient_records
WHERE patient_no IS NOT NULL
ORDER BY organization_id, patient_no, deleted_at NULLS FIRST, updated_at DESC, created_at DESC
ON CONFLICT DO NOTHING;

UPDATE patient_records pr
SET patient_person_id = pp.id
FROM patient_persons pp
WHERE pr.patient_person_id IS NULL
  AND pr.patient_no IS NOT NULL
  AND pp.organization_id = pr.organization_id
  AND pp.patient_no = pr.patient_no
  AND pp.deleted_at IS NULL;

-- Records without a patient number still need a stable person row so all cases
-- can use the same FK shape. These anonymous persons are one-per-record.
DO $$
DECLARE
  r RECORD;
  pid UUID;
BEGIN
  FOR r IN
    SELECT id, organization_id, name, birth_date, created_at, updated_at
    FROM patient_records
    WHERE patient_person_id IS NULL
  LOOP
    INSERT INTO patient_persons (organization_id, patient_no, name, birth_date, created_at, updated_at)
    VALUES (r.organization_id, NULL, r.name, r.birth_date, r.created_at, r.updated_at)
    RETURNING id INTO pid;

    UPDATE patient_records
    SET patient_person_id = pid
    WHERE id = r.id;
  END LOOP;
END $$;

-- Backfill injury_date from the JSON payload when it is a simple ISO date.
UPDATE patient_records
SET injury_date = to_date(payload #>> '{data,shared,injuryDate}', 'YYYY-MM-DD')
WHERE injury_date IS NULL
  AND NULLIF(btrim(payload #>> '{data,shared,injuryDate}'), '') IS NOT NULL
  AND (payload #>> '{data,shared,injuryDate}') ~ '^\d{4}-\d{2}-\d{2}$'
  AND to_char(to_date(payload #>> '{data,shared,injuryDate}', 'YYYY-MM-DD'), 'YYYY-MM-DD')
      = payload #>> '{data,shared,injuryDate}';

ALTER TABLE patient_records
  ALTER COLUMN patient_person_id SET NOT NULL,
  ADD CONSTRAINT patient_records_patient_person_fk
    FOREIGN KEY (patient_person_id) REFERENCES patient_persons(id) ON DELETE RESTRICT;

DROP INDEX IF EXISTS patient_records_org_patient_no_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS patient_persons_org_patient_no_uniq
  ON patient_persons (organization_id, patient_no)
  WHERE deleted_at IS NULL AND patient_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS patient_persons_org_patient_no_trgm
  ON patient_persons USING gin(patient_no gin_trgm_ops)
  WHERE deleted_at IS NULL AND patient_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS patient_records_person_idx
  ON patient_records(patient_person_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS patient_records_injury_date
  ON patient_records(injury_date DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE patient_persons IS
  'Patient/person master. patient_no identifies a person within an organization; one person may have many patient_records cases.';

COMMENT ON TABLE patient_records IS
  'Evaluation/injury case records. /api/patients remains case-oriented for client compatibility.';

COMMENT ON COLUMN patient_records.patient_person_id IS
  'FK to patient_persons; separates patient identity from evaluation/injury cases.';

COMMENT ON COLUMN patient_records.injury_date IS
  'Case injury/accident date extracted from payload.data.shared.injuryDate.';
