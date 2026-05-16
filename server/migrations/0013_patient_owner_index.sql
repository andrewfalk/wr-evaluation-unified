-- Supports the default scope=mine filter on GET /api/patients.
-- Composite on (org, owner) so the planner can use it for both the scoped
-- query and the full-org query (which needs only organization_id).
CREATE INDEX IF NOT EXISTS idx_patient_records_owner
  ON patient_records (organization_id, owner_user_id)
  WHERE deleted_at IS NULL;
