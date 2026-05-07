-- Prevent duplicate custom presets at the DB level.
-- Two presets with the same (org, owner, job_name, category, description)
-- are considered identical by buildPresetIdentity on the client.
-- The partial index covers only live rows (deleted_at IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_presets_identity
  ON custom_presets (organization_id, owner_user_id, job_name, category, description)
  WHERE deleted_at IS NULL;
