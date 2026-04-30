#!/bin/sh
# wr-evaluation-unified — audit_logs partition maintenance script
#
# Creates monthly partitions for audit_logs for the current month and the
# next 3 months. Idempotent: safe to run multiple times.
#
# Runs inside the 'backup' Docker container (postgres:16-alpine).
# Invoked by crond at 03:00 on the 25th of each month so the next month's
# partition is ready before the month turns over.
#
# Required environment variables (same as backup.sh):
#   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE

set -euo pipefail

PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-wr_user}"
PGDATABASE="${PGDATABASE:-wr_evaluation}"

echo "[audit-partition] $(date) — ensuring audit_logs partitions (current + 3 months)"

psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" <<'ENDSQL'
DO $$
DECLARE
  start_date DATE;
  end_date   DATE;
  pname      TEXT;
BEGIN
  FOR i IN 0..3 LOOP
    start_date := (date_trunc('month', now()) + (i * INTERVAL '1 month'))::DATE;
    end_date   := (start_date + INTERVAL '1 month')::DATE;
    pname      := 'audit_logs_' || to_char(start_date, 'YYYY_MM');
    BEGIN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
        pname, start_date, end_date
      );
      RAISE NOTICE 'Created partition: %', pname;
    EXCEPTION WHEN duplicate_table THEN
      RAISE NOTICE 'Partition already exists (ok): %', pname;
    END;
  END LOOP;
END;
$$;
ENDSQL

echo "[audit-partition] $(date) — done"
