-- 0008_workspace_snapshot_default.sql
-- Fix snapshot_payload column default: object {} → array [].
--
-- The save/redaction code always treats snapshot_payload as a JSON array.
-- The original DEFAULT '{}' was a copy-paste from other JSONB columns; this
-- migration corrects it and backfills any stale {} rows that may exist from
-- manual inserts or early test data.

-- Backfill rows where the payload is a plain empty object (not yet a valid array).
UPDATE workspaces
SET snapshot_payload = '[]'::jsonb
WHERE snapshot_payload = '{}'::jsonb;

-- Change the column default so future INSERTs that omit snapshot_payload get [].
ALTER TABLE workspaces
  ALTER COLUMN snapshot_payload SET DEFAULT '[]'::jsonb;
