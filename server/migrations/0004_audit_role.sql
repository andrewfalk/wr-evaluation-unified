-- Migration 0004: wr_audit_reader role
--
-- Creates a read-only PostgreSQL role for audit log access.
-- The app server uses a separate connection pool (AUDIT_DATABASE_URL) with
-- this role — it can only SELECT on audit_logs and nothing else.
--
-- Default password is 'changeme_audit_reader'. Change it in production:
--   docker compose exec postgres psql -U wr_user \
--     -c "ALTER ROLE wr_audit_reader PASSWORD 'your_secure_password';"
-- And set AUDIT_DB_PASSWORD=your_secure_password in .env.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wr_audit_reader') THEN
    CREATE ROLE wr_audit_reader LOGIN PASSWORD 'changeme_audit_reader';
  END IF;
END
$$;

-- Use current_database() so this migration works with any database name.
DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO wr_audit_reader',
    current_database()
  );
END
$$;

GRANT USAGE ON SCHEMA public TO wr_audit_reader;

-- Read-only access to audit_logs only.
GRANT SELECT ON audit_logs TO wr_audit_reader;

-- Explicitly block write capabilities in case of future default privilege changes.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON audit_logs FROM wr_audit_reader;
