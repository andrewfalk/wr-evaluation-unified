#!/bin/sh
# wr-evaluation-unified — database restore script
#
# AUTHORIZATION REQUIRED:
#   This script permanently overwrites the target database.
#   Two-person authorization is mandatory (system admin + security team).
#   Do NOT run against the production database for rehearsals —
#   use a separate restore-test environment with de-identified data.
#
# Usage:
#   ./restore.sh <backup.dump.gpg>
#
# Required environment variables:
#   PGHOST       — PostgreSQL host (default: postgres)
#   PGPORT       — PostgreSQL port (default: 5432)
#   PGUSER       — PostgreSQL user (default: wr_user)
#   PGPASSWORD   — PostgreSQL password
#   PGDATABASE   — Database name (default: wr_evaluation)
#   RESTORE_AUTH_TICKET — Authorization ticket number (mandatory)
#   GPG_PASSPHRASE      — (optional) passphrase for the private key.
#                         Leave unset when using a passphrase-free restore key (recommended).
#
# Required tools: gpg (with private key imported), pg_restore, psql
#
# The restore runs in a single transaction: it either completes (exit 0, then the
# row-count check runs) or rolls back and leaves the database unchanged (exit 1).
# Temporary space in /tmp: the decrypted dump plus the dump rendered as SQL
# (roughly the uncompressed size of the data) — both are removed on exit.
# Restoring into an EMPTY cluster: create the roles first (7.3.0~, see
# docs/BACKUP_RESTORE.md 5-2) — the dump grants to wr_owner·wr_app·wr_audit_reader,
# and a GRANT to a missing role now fails the restore instead of being skipped.

set -euo pipefail

BACKUP_FILE="${1:?Usage: restore.sh <backup.dump.gpg>}"
PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-wr_user}"
PGDATABASE="${PGDATABASE:-wr_evaluation}"
AUTH_TICKET="${RESTORE_AUTH_TICKET:?RESTORE_AUTH_TICKET is required — get approval from system admin + security team before running}"

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "[restore] ERROR: backup file not found: ${BACKUP_FILE}" >&2
  exit 1
fi

echo "============================================================"
echo "  WR EVALUATION — DATABASE RESTORE"
echo "  Authorization ticket : ${AUTH_TICKET}"
echo "  Backup file          : ${BACKUP_FILE}"
echo "  Target database      : ${PGDATABASE}@${PGHOST}:${PGPORT}"
echo "  Started at           : $(date)"
echo "============================================================"
echo ""
echo "WARNING: This will OVERWRITE all data in '${PGDATABASE}'."
printf "Type 'YES' to proceed: "
read -r CONFIRM
if [ "${CONFIRM}" != "YES" ]; then
  echo "[restore] Aborted."
  exit 0
fi

WORK_DIR=$(mktemp -d /tmp/wr-restore.XXXXXX)
DUMP_TMP="${WORK_DIR}/backup.dump"
TOC_TMP="${WORK_DIR}/toc.txt"
SQL_TMP="${WORK_DIR}/restore.sql"
PRECLEAN_SQL="${WORK_DIR}/preclean.sql"

# Always wipe the plaintext dump and the rendered SQL on exit, even on error or Ctrl-C.
trap 'rm -rf "${WORK_DIR}"' EXIT

# ---------------------------------------------------------------------------
# 1. GPG decrypt
# ---------------------------------------------------------------------------
echo "[restore] Decrypting ${BACKUP_FILE} ..."
if [ -n "${GPG_PASSPHRASE:-}" ]; then
  printf '%s' "${GPG_PASSPHRASE}" | \
    gpg --batch --pinentry-mode loopback --passphrase-fd 0 \
        --decrypt --output "${DUMP_TMP}" "${BACKUP_FILE}"
else
  gpg --batch --decrypt --output "${DUMP_TMP}" "${BACKUP_FILE}"
fi
echo "[restore] Decryption complete ($(du -sh "${DUMP_TMP}" | cut -f1))"

# ---------------------------------------------------------------------------
# 2. Restore — in ONE transaction
# ---------------------------------------------------------------------------
# Restoring over an existing database: `pg_restore --clean` drops each partition's
# primary key (audit_logs_<month>_pkey) before the parent's (audit_logs_pkey). The
# partition's copy is inherited from the parent and cannot be dropped on its own
# ("cannot drop inherited constraint"), so a direct pg_restore ended with exit 1
# even though every row was restored. Instead:
#   a) read the archive and render it to SQL first — an unreadable or corrupt
#      archive fails here, before the database is touched;
#   b) in one transaction: drop the parent-level constraints of the partitioned
#      tables the dump recreates (pre-clean, below), then run the rendered SQL
#      with ON_ERROR_STOP. Any error rolls the whole transaction back and the
#      database is left exactly as it was before the restore.
echo "[restore] Reading archive ..."
pg_restore --list "${DUMP_TMP}" > "${TOC_TMP}"
# Tables the dump recreates (and so `--clean` drops): TOC lines "<id>; <oid> <oid> TABLE <schema> <name> <owner>".
DUMP_TABLES=$(awk '$1 ~ /^[0-9]+;$/ && $4 == "TABLE" && $5 != "DATA" { printf "%s%s.%s", sep, $5, $6; sep = "," }' "${TOC_TMP}")
pg_restore --clean --if-exists --no-owner --file="${SQL_TMP}" "${DUMP_TMP}"
echo "[restore] Archive rendered ($(du -sh "${SQL_TMP}" | cut -f1) of SQL)"

# Pre-clean: the parent-level PRIMARY KEY / UNIQUE / FOREIGN KEY constraints of the
# partitioned tables in the dump, and the foreign keys of dumped tables that point at
# them. Dropping a parent's constraint drops its partitions' inherited copies with it.
# `--clean` drops every one of these a few statements later anyway (the dump recreates
# their tables) — this only moves those drops ahead of the partitions' copies. No table
# or row is removed here. Anything else that depends on them (an object the dump does
# not recreate) makes the drop fail, and the whole restore rolls back.
cat > "${PRECLEAN_SQL}" <<'SQL'
SET LOCAL wr_restore.dump_tables = :'dump_tables';
DO $preclean$
DECLARE
  dumped text[] := pg_catalog.string_to_array(pg_catalog.current_setting('wr_restore.dump_tables'), ',');
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname, c.relname, con.conname
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid
      LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
     WHERE con.contype IN ('p', 'u', 'f')
       AND con.conparentid = 0
       AND con.conislocal
       AND (n.nspname || '.' || c.relname) = ANY (dumped)
       AND (c.relkind = 'p'
            OR (con.contype = 'f' AND rc.relkind = 'p' AND (rn.nspname || '.' || rc.relname) = ANY (dumped)))
     ORDER BY con.contype = 'f' DESC, n.nspname, c.relname, con.conname
  LOOP
    RAISE NOTICE 'pre-clean: ALTER TABLE %.% DROP CONSTRAINT %', r.nspname, r.relname, r.conname;
    EXECUTE pg_catalog.format('ALTER TABLE %I.%I DROP CONSTRAINT %I', r.nspname, r.relname, r.conname);
  END LOOP;
END
$preclean$;
SQL

echo "[restore] Restoring to ${PGDATABASE} (single transaction) ..."
# -o /dev/null: the dump's own SELECTs (set_config, setval) print nothing useful; errors and
# notices go to stderr and stay visible.
if ! psql -X -q -o /dev/null \
    -h "${PGHOST}" \
    -p "${PGPORT}" \
    -U "${PGUSER}" \
    -d "${PGDATABASE}" \
    -v ON_ERROR_STOP=1 \
    -v "dump_tables=${DUMP_TABLES}" \
    --single-transaction \
    -f "${PRECLEAN_SQL}" \
    -f "${SQL_TMP}"; then
  echo "[restore] ERROR: restore failed — the transaction was rolled back; '${PGDATABASE}' was not changed." >&2
  exit 1
fi

echo "[restore] Restore complete (committed)"
# DUMP_TMP and SQL_TMP are cleaned up by the EXIT trap.

# ---------------------------------------------------------------------------
# 3. Verification — basic row count sanity check
# ---------------------------------------------------------------------------
echo "[restore] Verification:"
psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" \
  -c "SELECT 'users' AS tbl, COUNT(*) FROM users
      UNION ALL SELECT 'patient_records', COUNT(*) FROM patient_records
      UNION ALL SELECT 'audit_logs', COUNT(*) FROM audit_logs;"

echo "[restore] Done at $(date)"
echo "[restore] Auth ticket: ${AUTH_TICKET}"
