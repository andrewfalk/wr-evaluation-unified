#!/bin/sh
# wr-evaluation-unified — daily backup script
#
# Runs inside the 'backup' Docker container (postgres:16-alpine + gnupg).
# Invoked by crond at 02:00 daily.
#
# Required environment variables:
#   PGHOST              — PostgreSQL host (default: postgres)
#   PGPORT              — PostgreSQL port (default: 5432)
#   PGUSER              — PostgreSQL user (default: wr_user)
#   PGPASSWORD          — PostgreSQL password
#   PGDATABASE          — Database name (default: wr_evaluation)
#   BACKUP_GPG_RECIPIENT — GPG key fingerprint or email of the recipient
#   BACKUP_DIR          — Backup root directory (default: /backups)
#
# Retention policy:
#   Daily   → keep 30 days
#   Monthly → keep 12 months (first backup of each calendar month)
#   Yearly  → keep 5 years   (first backup of each calendar year)

set -euo pipefail

PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-wr_user}"
PGDATABASE="${PGDATABASE:-wr_evaluation}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:?BACKUP_GPG_RECIPIENT is required}"

NOW=$(date +%Y%m%d_%H%M%S)
DUMP_TMP="/tmp/wr-backup-${NOW}.dump"
ENCRYPTED_FILE="wr-backup-${NOW}.dump.gpg"

DAILY_DIR="${BACKUP_DIR}/daily"
MONTHLY_DIR="${BACKUP_DIR}/monthly"
YEARLY_DIR="${BACKUP_DIR}/yearly"
mkdir -p "${DAILY_DIR}" "${MONTHLY_DIR}" "${YEARLY_DIR}"

# ---------------------------------------------------------------------------
# 1. pg_dump (custom format — allows selective table restore)
# ---------------------------------------------------------------------------
echo "[backup] $(date) — starting pg_dump"
pg_dump \
  -h "${PGHOST}" \
  -p "${PGPORT}" \
  -U "${PGUSER}" \
  -d "${PGDATABASE}" \
  --format=custom \
  --file="${DUMP_TMP}"
echo "[backup] pg_dump complete ($(du -sh "${DUMP_TMP}" | cut -f1))"

# ---------------------------------------------------------------------------
# 2. GPG encrypt — asymmetric, public key must be pre-imported
# ---------------------------------------------------------------------------
gpg \
  --batch \
  --yes \
  --trust-model always \
  --recipient "${GPG_RECIPIENT}" \
  --output "${DAILY_DIR}/${ENCRYPTED_FILE}" \
  --encrypt "${DUMP_TMP}"
rm -f "${DUMP_TMP}"
echo "[backup] Encrypted: ${DAILY_DIR}/${ENCRYPTED_FILE}"

# ---------------------------------------------------------------------------
# 3. Monthly / yearly promotion (first backup of each period)
# ---------------------------------------------------------------------------
MONTH_TAG=$(date +%Y%m)
YEAR_TAG=$(date +%Y)
MONTHLY_DEST="${MONTHLY_DIR}/wr-backup-${MONTH_TAG}.dump.gpg"
YEARLY_DEST="${YEARLY_DIR}/wr-backup-${YEAR_TAG}.dump.gpg"

if [ ! -f "${MONTHLY_DEST}" ]; then
  cp "${DAILY_DIR}/${ENCRYPTED_FILE}" "${MONTHLY_DEST}"
  echo "[backup] Monthly copy saved: ${MONTHLY_DEST}"
fi

if [ ! -f "${YEARLY_DEST}" ]; then
  cp "${DAILY_DIR}/${ENCRYPTED_FILE}" "${YEARLY_DEST}"
  echo "[backup] Yearly copy saved: ${YEARLY_DEST}"
fi

# ---------------------------------------------------------------------------
# 4. Retention pruning
#   Daily   30 days  → -mtime +30
#   Monthly 12 months → -mtime +365
#   Yearly  5 years  → -mtime +1825
# ---------------------------------------------------------------------------
find "${DAILY_DIR}"   -name "*.gpg" -mtime +30   -delete
find "${MONTHLY_DIR}" -name "*.gpg" -mtime +365  -delete
find "${YEARLY_DIR}"  -name "*.gpg" -mtime +1825 -delete
echo "[backup] Retention pruning complete"

# ---------------------------------------------------------------------------
# 5. List current backup inventory
# ---------------------------------------------------------------------------
echo "[backup] Current inventory:"
echo "  Daily:   $(find "${DAILY_DIR}"   -name "*.gpg" | wc -l) files"
echo "  Monthly: $(find "${MONTHLY_DIR}" -name "*.gpg" | wc -l) files"
echo "  Yearly:  $(find "${YEARLY_DIR}"  -name "*.gpg" | wc -l) files"
echo "[backup] $(date) — done"
