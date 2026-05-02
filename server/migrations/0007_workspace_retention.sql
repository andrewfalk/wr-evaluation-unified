-- 0007_workspace_retention.sql
-- Document workspace 5-year retention policy and PHI redaction contract.

-- When a patient is soft-deleted, their PHI is immediately redacted from every
-- workspace snapshot. The redacted stub { id, redacted: true } preserves the
-- structural slot without exposing name/patient_no/birth_date or payload.
-- Workspaces older than 5 years are eligible for deletion by the
-- workspaceRetention job. Admins may purge individual workspaces earlier via
-- DELETE /api/admin/workspaces/:id/purge.
COMMENT ON TABLE workspaces IS
  'Snapshot semantics: payload frozen at save time. '
  'Retention target: 5 years from created_at. '
  'Patient PHI is redacted in-place on soft-delete (no full-row removal). '
  'Use DELETE /api/admin/workspaces/:id/purge for earlier hard deletion.';
