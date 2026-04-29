-- Stores up to 5 most recent bcrypt hashes for each user so change-password
-- can reject re-use of a recent password.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_history TEXT[] NOT NULL DEFAULT '{}';
