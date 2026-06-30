-- Backfill: convert legacy private presets to organization visibility.
-- Before the preset-sharing feature, the save UI hardcoded visibility='private',
-- so every existing private preset is private by default, not by user choice.
-- This retroactively applies the new 'organization' default to that legacy data
-- so existing presets become discoverable to colleagues. Runs once, at boot
-- before the server accepts connections, so it only ever sees legacy rows.
-- IMPORTANT: ship this migration in the SAME release as the visibility toggle;
-- do NOT apply it later as a standalone migration (a later release could clobber
-- presets a user has by then intentionally set to private).
-- revision is bumped to stay consistent with the route (which bumps revision on
-- every state change) and to invalidate stale client copies.
-- Safety: visibility is not part of the preset unique index (0011), so this
-- cannot trigger a uniqueness conflict. The migration runner wraps each file in
-- its own BEGIN/COMMIT, so no transaction block here.

UPDATE custom_presets
SET    visibility = 'organization',
       revision   = revision + 1,
       updated_at = now()
WHERE  deleted_at IS NULL
  AND  visibility = 'private';
