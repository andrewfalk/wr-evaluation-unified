-- 0001_init.sql
-- Initial schema for wr-evaluation-unified intranet server

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  login_id             TEXT        NOT NULL UNIQUE,
  password_hash        TEXT        NOT NULL,
  name                 TEXT        NOT NULL,
  role                 TEXT        NOT NULL DEFAULT 'doctor'
                         CHECK (role IN ('admin', 'doctor', 'nurse', 'staff')),
  organization_id      UUID        REFERENCES organizations(id) ON DELETE SET NULL,
  must_change_password BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at        TIMESTAMPTZ,
  disabled_at          TIMESTAMPTZ
);

CREATE INDEX users_org_idx ON users(organization_id);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT        NOT NULL UNIQUE,
  csrf_token_hash    TEXT        NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  -- revoked_at: set during token rotation; grace window applies (30s)
  revoked_at         TIMESTAMPTZ,
  -- invalidated_at: set on logout / password change; no grace window
  invalidated_at     TIMESTAMPTZ,
  user_agent         TEXT,
  ip                 INET,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx      ON sessions(user_id);
CREATE INDEX sessions_refresh_hash_idx ON sessions(refresh_token_hash);
CREATE INDEX sessions_expires_at_idx   ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- patient_records
-- organization_id NOT NULL: patient data must always belong to an org for
-- row-level permission isolation.
-- ---------------------------------------------------------------------------
CREATE TABLE patient_records (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  owner_user_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  name             TEXT        NOT NULL,
  patient_no       TEXT,
  birth_date       DATE,
  evaluation_date  DATE,
  active_modules   TEXT[]      NOT NULL DEFAULT '{}',
  diagnoses_codes  TEXT[]      NOT NULL DEFAULT '{}',
  jobs_names       TEXT[]      NOT NULL DEFAULT '{}',
  revision         INTEGER     NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  payload          JSONB       NOT NULL DEFAULT '{}'
);

-- updated_at auto-maintenance
CREATE OR REPLACE FUNCTION set_updated_at()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER patient_records_updated_at
  BEFORE UPDATE ON patient_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Trigram indexes for partial-match text search
CREATE INDEX patient_records_name_trgm
  ON patient_records USING gin(name gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX patient_records_patient_no_trgm
  ON patient_records USING gin(patient_no gin_trgm_ops)
  WHERE deleted_at IS NULL AND patient_no IS NOT NULL;

-- GIN indexes for array containment / overlap queries
CREATE INDEX patient_records_active_modules_gin
  ON patient_records USING gin(active_modules)
  WHERE deleted_at IS NULL;

CREATE INDEX patient_records_diagnoses_codes_gin
  ON patient_records USING gin(diagnoses_codes)
  WHERE deleted_at IS NULL;

CREATE INDEX patient_records_jobs_names_gin
  ON patient_records USING gin(jobs_names)
  WHERE deleted_at IS NULL;

-- Scalar indexes for list/sort queries
CREATE INDEX patient_records_org_updated
  ON patient_records(organization_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX patient_records_evaluation_date
  ON patient_records(evaluation_date DESC)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- workspaces  (snapshot semantics — payload frozen at save time)
-- organization_id NOT NULL: same permission isolation requirement as patients.
-- ---------------------------------------------------------------------------
CREATE TABLE workspaces (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  owner_user_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
  name             TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  patient_ids      UUID[]      NOT NULL DEFAULT '{}',
  snapshot_payload JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX workspaces_org_created ON workspaces(organization_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- autosaves  (one row per user+device, upsert semantics)
-- organization_id nullable: temporary local data, less critical for isolation.
-- ---------------------------------------------------------------------------
CREATE TABLE autosaves (
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id       TEXT        NOT NULL,
  organization_id UUID        REFERENCES organizations(id) ON DELETE SET NULL,
  saved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload         JSONB       NOT NULL,
  PRIMARY KEY (user_id, device_id)
);

-- ---------------------------------------------------------------------------
-- audit_logs  (append-only, PARTITION BY RANGE(created_at))
--
-- PRIMARY KEY (id, created_at): partition key must be part of PK in pg.
-- BIGSERIAL replaced by a standalone sequence since BIGSERIAL is not valid
-- on a partitioned table parent.
-- T24 adds the auto-partition cron; this migration creates the initial
-- monthly partitions plus a DEFAULT catch-all for safety.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE audit_logs_id_seq;

CREATE TABLE audit_logs (
  id            BIGINT      NOT NULL DEFAULT nextval('audit_logs_id_seq'),
  actor_user_id UUID,
  actor_org_id  UUID,
  action        TEXT        NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  outcome       TEXT        NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  ip            INET,
  user_agent    TEXT,
  extra         JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create partitions for current month + next 3 months dynamically
DO $$
DECLARE
  start_date DATE;
  end_date   DATE;
  pname      TEXT;
BEGIN
  FOR i IN 0..3 LOOP
    start_date := date_trunc('month', now())::DATE + (i * INTERVAL '1 month')::INTERVAL;
    end_date   := start_date + INTERVAL '1 month';
    pname      := 'audit_logs_' || to_char(start_date, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
      pname, start_date, end_date
    );
  END LOOP;
END;
$$;

-- Default partition: catches rows that fall outside explicit monthly partitions
-- (e.g., before T24 cron creates future months)
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;

CREATE INDEX audit_logs_actor_user_idx ON audit_logs(actor_user_id);
CREATE INDEX audit_logs_action_idx     ON audit_logs(action);
CREATE INDEX audit_logs_created_at_idx ON audit_logs(created_at DESC);
