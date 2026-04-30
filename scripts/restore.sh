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
#
# Required tools: gpg (with private key imported), pg_restore

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

DUMP_TMP="/tmp/wr-restore-$(date +%s).dump"

# Always wipe the plaintext dump on exit, even on error or Ctrl-C.
trap 'rm -f "${DUMP_TMP}"' EXIT

# ---------------------------------------------------------------------------
# 1. GPG decrypt
# ---------------------------------------------------------------------------
echo "[restore] Decrypting ${BACKUP_FILE} ..."
gpg --batch --decrypt --output "${DUMP_TMP}" "${BACKUP_FILE}"
echo "[restore] Decryption complete ($(du -sh "${DUMP_TMP}" | cut -f1))"

# ---------------------------------------------------------------------------
# 2. pg_restore
# ---------------------------------------------------------------------------
echo "[restore] Restoring to ${PGDATABASE} ..."
pg_restore \
  -h "${PGHOST}" \
  -p "${PGPORT}" \
  -U "${PGUSER}" \
  -d "${PGDATABASE}" \
  --clean \
  --if-exists \
  --no-owner \
  "${DUMP_TMP}"

echo "[restore] Restore complete"
# DUMP_TMP is cleaned up by the EXIT trap.

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
