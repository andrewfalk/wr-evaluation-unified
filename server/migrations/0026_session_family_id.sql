-- Rotation creates a NEW row per refresh (old row marked revoked_at). family_id
-- ties every row in one rotation lineage together so a single logout can
-- invalidate whichever row is the *current* live descendant, even if a
-- concurrent /refresh rotated the session in between logout's lookup and its
-- revoke (see revokeSessionFamily in sessionStore.ts).
ALTER TABLE sessions ADD COLUMN family_id UUID;
UPDATE sessions SET family_id = id WHERE family_id IS NULL;
ALTER TABLE sessions ALTER COLUMN family_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_family_id_idx ON sessions(family_id);
