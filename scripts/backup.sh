#!/bin/sh
# wr-evaluation-unified — daily backup script
#
# Runs inside the 'backup' Docker container (postgres:16-alpine + gnupg).
# Invoked by crond at 02:00 daily.
#
# Required env vars:
#   PGHOST               — PostgreSQL host (default: postgres)
#   PGPORT               — PostgreSQL port (default: 5432)
#   PGUSER               — PostgreSQL user (default: wr_user)
#   PGPASSWORD           — PostgreSQL password
#   PGDATABASE           — Database name (default: wr_evaluation)
#   BACKUP_GPG_RECIPIENT — GPG key fingerprint/email (not required when BACKUP_DRY_RUN=1)
#   BACKUP_DIR           — Backup root directory (default: /backups)
#
# Dry-run env vars (Step 14 / ops verification only):
#   BACKUP_DRY_RUN=1
#     Skip pg_dump and GPG encrypt entirely. Status is written to
#     backup-status-dry.json, NOT the operational backup-status.json.
#     .last_success / .last_failure tracking files are never updated.
#
#   BACKUP_DRY_RUN=1  +  BACKUP_DRY_RUN_FAIL_REASON=<reason_class>
#     Simulate a failure to exercise the alert pipeline without touching the DB.
#     Writes FAILED_<runId>.json with dryRun=true, purpose="step14_verification".
#     Valid reason_class values: pg_dump_failed gpg_encrypt_failed promote_failed
#
# Status output — BACKUP_DIR/_status/:
#   backup-status.json      — operational state (real runs only, never overwritten by dry-runs)
#   backup-status-dry.json  — dry-run state (separate file; ignored by the monitor)
#   .last_success           — ISO-8601 timestamp of last real success (cross-run carry)
#   .last_failure           — ISO-8601 timestamp of last real failure
#
# Alert output — BACKUP_DIR/_alerts/FAILED_<runId>.json:
#   Created on any failure (real or dry-run).
#   Pruned only when both acknowledgedAt AND resolvedAt are set AND file age > 90 days.
#   Dry-run failure alerts carry dryRun=true, purpose="step14_verification".
#
# Retention policy:
#   Daily   → keep 30 days
#   Monthly → keep 12 months (first backup of each calendar month)
#   Yearly  → keep 5 years   (first backup of each calendar year)

set -euo pipefail

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-wr_user}"
PGDATABASE="${PGDATABASE:-wr_evaluation}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
DRY_RUN="${BACKUP_DRY_RUN:-0}"
DRY_FAIL_REASON="${BACKUP_DRY_RUN_FAIL_REASON:-}"
if [ -n "${DRY_FAIL_REASON}" ]; then
  case "${DRY_FAIL_REASON}" in
    pg_dump_failed|gpg_encrypt_failed|promote_failed|pruning_failed) ;;
    *)
      printf '[backup] ERROR: BACKUP_DRY_RUN_FAIL_REASON="%s" is invalid.\n' "${DRY_FAIL_REASON}" >&2
      echo '[backup] Valid values: pg_dump_failed gpg_encrypt_failed promote_failed pruning_failed' >&2
      exit 1
      ;;
  esac
fi

if [ "${DRY_RUN}" = "1" ]; then
  GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:-DRY_RUN_NO_KEY}"
else
  GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:?BACKUP_GPG_RECIPIENT is required}"
fi

NOW=$(date +%Y%m%d_%H%M%S)
RUN_ID="${NOW}"
RUN_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DUMP_TMP="/tmp/wr-backup-${RUN_ID}.dump"
ENCRYPTED_FILE="wr-backup-${RUN_ID}.dump.gpg"

# ---------------------------------------------------------------------------
# Directories
# ---------------------------------------------------------------------------
DAILY_DIR="${BACKUP_DIR}/daily"
MONTHLY_DIR="${BACKUP_DIR}/monthly"
YEARLY_DIR="${BACKUP_DIR}/yearly"
STATUS_DIR="${BACKUP_DIR}/_status"
ALERTS_DIR="${BACKUP_DIR}/_alerts"
mkdir -p "${DAILY_DIR}" "${MONTHLY_DIR}" "${YEARLY_DIR}" "${STATUS_DIR}" "${ALERTS_DIR}"

# ---------------------------------------------------------------------------
# State tracking
#
# BACKUP_OK stays 0 until the very last line; set -e exits the script on any
# command failure, so the EXIT trap checks BACKUP_OK to distinguish success
# from failure without needing a separate ERR trap.
#
# Dry-run writes go to a separate file (backup-status-dry.json) so the
# operational backup-status.json is never touched by verification runs.
# ---------------------------------------------------------------------------
BACKUP_OK=0
BACKUP_STEP="init"

if [ "${DRY_RUN}" = "1" ]; then
  CURRENT_STATUS_FILE="${STATUS_DIR}/backup-status-dry.json"
else
  CURRENT_STATUS_FILE="${STATUS_DIR}/backup-status.json"
fi

LAST_SUCCESS_FILE="${STATUS_DIR}/.last_success"
LAST_FAILURE_FILE="${STATUS_DIR}/.last_failure"
LAST_SUCCESS_AT=""
LAST_FAILURE_AT=""
[ -f "${LAST_SUCCESS_FILE}" ] && LAST_SUCCESS_AT=$(cat "${LAST_SUCCESS_FILE}")
[ -f "${LAST_FAILURE_FILE}" ] && LAST_FAILURE_AT=$(cat "${LAST_FAILURE_FILE}")

# ---------------------------------------------------------------------------
# JSON helpers (no jq dependency — all values are controlled ISO-8601 / enum)
# ---------------------------------------------------------------------------

j_str() {
  # j_str VALUE  →  "VALUE"  or  null when VALUE is empty
  if [ -z "${1:-}" ]; then printf 'null'; else printf '"%s"' "$1"; fi
}

j_bool() {
  if [ "${1:-0}" = "1" ]; then printf 'true'; else printf 'false'; fi
}

write_json_atomic() {
  # write_json_atomic DEST CONTENT — write to tmp then rename (atomic on POSIX)
  local dest="$1"
  local content="$2"
  local tmp="${dest}.tmp.$$"
  printf '%s\n' "${content}" > "${tmp}"
  mv "${tmp}" "${dest}"
}

fmt_status_json() {
  # fmt_status_json STATUS FINISHED_AT SUCCESS_AT FAILURE_AT REASON_CLASS
  printf '{"status":"%s","runId":"%s","job":"daily-backup","dryRun":%s,"lastStartedAt":"%s","lastFinishedAt":%s,"lastSuccessAt":%s,"lastFailureAt":%s,"reasonClass":%s}' \
    "$1" "${RUN_ID}" "$(j_bool "${DRY_RUN}")" "${RUN_STARTED_AT}" \
    "$(j_str "$2")" "$(j_str "$3")" "$(j_str "$4")" "$(j_str "$5")"
}

fmt_alert_json() {
  # fmt_alert_json REASON_CLASS CREATED_AT
  local purpose_field=""
  [ "${DRY_RUN}" = "1" ] && purpose_field=',"purpose":"step14_verification"'
  printf '{"type":"backup_failed","severity":"critical","runId":"%s","dryRun":%s%s,"reasonClass":"%s","createdAt":"%s","acknowledgedAt":null,"acknowledgedBy":null,"resolvedAt":null,"resolvedBy":null}' \
    "${RUN_ID}" "$(j_bool "${DRY_RUN}")" "${purpose_field}" "$1" "$2"
}

# ---------------------------------------------------------------------------
# Alert retention — called only after real (non-dry) success
# ---------------------------------------------------------------------------
prune_resolved_alerts() {
  find "${ALERTS_DIR}" -name "FAILED_*.json" -mtime +90 | while read -r f; do
    # Skip if not yet fully acknowledged and resolved
    if grep -q '"acknowledgedAt":null' "${f}" 2>/dev/null; then continue; fi
    if grep -q '"resolvedAt":null'     "${f}" 2>/dev/null; then continue; fi
    rm -f "${f}"
    echo "[backup] Pruned resolved alert: ${f}"
  done
}

# ---------------------------------------------------------------------------
# Exit trap — runs on both normal exit and early exit caused by set -e
# ---------------------------------------------------------------------------
on_exit() {
  set +e  # prevent cascading failures inside the trap handler

  rm -f "${DUMP_TMP}"

  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  if [ "${BACKUP_OK}" = "1" ]; then
    # Real success: update .last_success and prune old resolved alerts.
    # Dry-run success: leave operational tracking files untouched.
    local success_at
    if [ "${DRY_RUN}" != "1" ]; then
      echo "${ts}" > "${LAST_SUCCESS_FILE}"
      success_at="${ts}"
    else
      success_at="${LAST_SUCCESS_AT}"
    fi
    write_json_atomic "${CURRENT_STATUS_FILE}" \
      "$(fmt_status_json "success" "${ts}" "${success_at}" "${LAST_FAILURE_AT}" "")"
    [ "${DRY_RUN}" != "1" ] && prune_resolved_alerts
    echo "[backup] Status: success (runId=${RUN_ID}, dryRun=${DRY_RUN})"
  else
    # Determine which step caused the failure.
    # For dry-run simulations BACKUP_DRY_RUN_FAIL_REASON is used directly so the
    # alert carries a meaningful reasonClass without any real step having run.
    local reason_class
    if [ "${DRY_RUN}" = "1" ] && [ -n "${DRY_FAIL_REASON}" ]; then
      reason_class="${DRY_FAIL_REASON}"
    else
      case "${BACKUP_STEP}" in
        pg_dump)     reason_class="pg_dump_failed" ;;
        gpg_encrypt) reason_class="gpg_encrypt_failed" ;;
        promote)     reason_class="promote_failed" ;;
        pruning)     reason_class="pruning_failed" ;;
        *)           reason_class="unknown" ;;
      esac
    fi

    # Real failure: update .last_failure tracking.
    # Dry-run failure: leave tracking files untouched — the alert file is the
    # only artifact. This keeps lastFailureAt in status consistent with reality.
    local failure_at
    if [ "${DRY_RUN}" != "1" ]; then
      echo "${ts}" > "${LAST_FAILURE_FILE}"
      failure_at="${ts}"
    else
      failure_at="${LAST_FAILURE_AT}"
    fi

    write_json_atomic "${CURRENT_STATUS_FILE}" \
      "$(fmt_status_json "failed" "${ts}" "${LAST_SUCCESS_AT}" "${failure_at}" "${reason_class}")"
    write_json_atomic "${ALERTS_DIR}/FAILED_${RUN_ID}.json" \
      "$(fmt_alert_json "${reason_class}" "${ts}")"
    echo "[backup] Status: FAILED (runId=${RUN_ID}, step=${BACKUP_STEP}, reason=${reason_class})" >&2
  fi
}

trap 'on_exit' EXIT

# ---------------------------------------------------------------------------
# Write "running" heartbeat — lets the monitor detect stale/hung jobs.
# Goes to the same file that on_exit will finalize.
# ---------------------------------------------------------------------------
write_json_atomic "${CURRENT_STATUS_FILE}" \
  "$(fmt_status_json "running" "" "${LAST_SUCCESS_AT}" "${LAST_FAILURE_AT}" "")"

# ---------------------------------------------------------------------------
# DRY_RUN dispatch
#   DRY_RUN=1  (no FAIL_REASON) → validate status-file writes, exit success
#   DRY_RUN=1 + FAIL_REASON=X  → simulate failure; write alert with dryRun=true
# ---------------------------------------------------------------------------
if [ "${DRY_RUN}" = "1" ]; then
  if [ -n "${DRY_FAIL_REASON}" ]; then
    echo "[backup] DRY_RUN=1, FAIL_REASON=${DRY_FAIL_REASON} — simulating failure for Step 14 verification"
    exit 1  # triggers on_exit with BACKUP_OK=0; reason_class comes from DRY_FAIL_REASON
  else
    echo "[backup] DRY_RUN=1 — skipping pg_dump and GPG encrypt, writing success status"
    BACKUP_OK=1
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# 1. pg_dump (custom format — allows selective table restore)
# ---------------------------------------------------------------------------
BACKUP_STEP="pg_dump"
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
BACKUP_STEP="gpg_encrypt"
gpg \
  --batch \
  --yes \
  --trust-model always \
  --recipient "${GPG_RECIPIENT}" \
  --output "${DAILY_DIR}/${ENCRYPTED_FILE}" \
  --encrypt "${DUMP_TMP}"
echo "[backup] Encrypted: ${DAILY_DIR}/${ENCRYPTED_FILE}"
# DUMP_TMP is removed by the EXIT trap.

# ---------------------------------------------------------------------------
# 3. Monthly / yearly promotion (first backup of each period)
# ---------------------------------------------------------------------------
BACKUP_STEP="promote"
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
BACKUP_STEP="pruning"
find "${DAILY_DIR}"   -name "*.gpg" -mtime +30   -delete
find "${MONTHLY_DIR}" -name "*.gpg" -mtime +365  -delete
find "${YEARLY_DIR}"  -name "*.gpg" -mtime +1825 -delete
echo "[backup] Retention pruning complete"

# ---------------------------------------------------------------------------
# 5. Inventory
# ---------------------------------------------------------------------------
echo "[backup] Current inventory:"
echo "  Daily:   $(find "${DAILY_DIR}"   -name "*.gpg" | wc -l) files"
echo "  Monthly: $(find "${MONTHLY_DIR}" -name "*.gpg" | wc -l) files"
echo "  Yearly:  $(find "${YEARLY_DIR}"  -name "*.gpg" | wc -l) files"
echo "[backup] $(date) — done"

# All steps complete. on_exit will write "success" status.
BACKUP_STEP="done"
BACKUP_OK=1
