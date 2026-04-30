-- Migration 0004: wr_audit_reader role
--
-- Creates a read-only PostgreSQL role for audit log access.
-- The app server uses a separate connection pool (AUDIT_DATABASE_URL) with
-- this role — it can only SELECT on audit_logs and nothing else.
--
-- One-time password setup (run after first deploy):
--   docker compose exec postgres psql -U wr_user -d wr_evaluation \
--     -c "ALTER ROLE wr_audit_reader PASSWORD 'your_secure_password';"
-- Then set AUDIT_DATABASE_URL in .env:
--   AUDIT_DATABASE_URL=postgres://wr_audit_reader:your_secure_password@postgres:5432/wr_evaluation

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wr_audit_reader') THEN
    -- Created without a password — cannot authenticate until password is set by operator.
    CREATE ROLE wr_audit_reader LOGIN;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE wr_evaluation TO wr_audit_reader;
GRANT USAGE ON SCHEMA public TO wr_audit_reader;

-- Read-only access to audit_logs only.
GRANT SELECT ON audit_logs TO wr_audit_reader;

-- Explicitly block write capabilities in case of future default privilege changes.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON audit_logs FROM wr_audit_reader;
