-- Idempotency key cache for POST /api/patients deduplication.
-- Keyed on (key, user_id) — client-supplied UUID paired with the acting user,
-- ensuring one user's key cannot replay another user's response.
-- Cached responses expire after 24 hours; idx_idempotency_expires supports
-- periodic cleanup via DELETE WHERE expires_at < now().
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT        NOT NULL,
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     UUID        NOT NULL,
  status     INTEGER     NOT NULL,
  body       JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '24 hours',
  PRIMARY KEY (key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires
  ON idempotency_keys (expires_at);
