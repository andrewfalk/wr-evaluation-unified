'use strict';
// backup-monitor — hourly check of backup status and alert files.
// Writes /backups/_status/monitor-report.json for the app server to read.
// No external runtime dependencies — pure Node.js built-ins only.

const fs   = require('node:fs/promises');
const path = require('node:path');

const BACKUPS_DIR           = process.env.BACKUPS_DIR            ?? '/backups';
const CHECK_INTERVAL_SECONDS = Number(process.env.CHECK_INTERVAL_SECONDS ?? 3600);
const STALE_THRESHOLD_HOURS  = Number(process.env.STALE_THRESHOLD_HOURS  ?? 36);

const STATUS_DIR  = path.join(BACKUPS_DIR, '_status');
const ALERTS_DIR  = path.join(BACKUPS_DIR, '_alerts');
const STATUS_FILE = path.join(STATUS_DIR, 'backup-status.json');
const REPORT_FILE = path.join(STATUS_DIR, 'monitor-report.json');

// ---------------------------------------------------------------------------
// Pure functions (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Returns true when the last known successful backup is older than thresholdHours,
 * or when lastSuccessAt is null/undefined/invalid (fail-closed: unknown = stale).
 */
function isStale(lastSuccessAt, nowMs = Date.now(), thresholdHours = STALE_THRESHOLD_HOURS) {
  if (!lastSuccessAt) return true;
  const parsedMs = new Date(lastSuccessAt).getTime();
  if (!Number.isFinite(parsedMs)) return true;   // corrupt date string → treat as stale
  return (nowMs - parsedMs) > thresholdHours * 3_600_000;
}

/**
 * Derives a summary string from stale flag and alert counts.
 * summary is based on *real* (non-dry-run) alerts so Step 14 verification alerts
 * don't trigger operational emergency banners in the admin UI.
 *
 * @param {boolean} stale
 * @param {number}  realAlertCount  — openAlerts where dryRun !== true
 * @param {number}  totalAlertCount — all open alerts including dry-run
 * @returns {'ok'|'stale'|'alert_open'|'stale_and_alert'|'dry_run_alert_open'}
 */
function computeSummary(stale, realAlertCount, totalAlertCount) {
  if (stale && realAlertCount > 0) return 'stale_and_alert';
  if (stale)                       return 'stale';
  if (realAlertCount > 0)          return 'alert_open';
  if (totalAlertCount > 0)         return 'dry_run_alert_open';
  return 'ok';
}

module.exports = { isStale, computeSummary };

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

async function readOpenAlerts() {
  let files;
  try {
    files = await fs.readdir(ALERTS_DIR);
  } catch {
    return [];
  }
  const alerts = [];
  for (const file of files) {
    if (!file.startsWith('FAILED_') || !file.endsWith('.json')) continue;
    const alert = await readJsonSafe(path.join(ALERTS_DIR, file));
    if (alert && alert.resolvedAt === null) alerts.push(alert);
  }
  return alerts;
}

async function writeJsonAtomic(dest, obj) {
  const tmp = `${dest}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  await fs.rename(tmp, dest);
}

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

async function check() {
  const now    = Date.now();
  const status = await readJsonSafe(STATUS_FILE);
  const openAlerts = await readOpenAlerts();

  const lastSuccessAt = status?.lastSuccessAt ?? null;
  const stale = isStale(lastSuccessAt, now, STALE_THRESHOLD_HOURS);
  const realAlertCount = openAlerts.filter(a => !a.dryRun).length;
  const summary = computeSummary(stale, realAlertCount, openAlerts.length);

  const report = {
    checkedAt: new Date(now).toISOString(),
    isStale: stale,
    staleThresholdHours: STALE_THRESHOLD_HOURS,
    lastSuccessAt,
    openAlerts: openAlerts.map(a => ({
      runId:       a.runId,
      dryRun:      a.dryRun ?? false,
      reasonClass: a.reasonClass,
      createdAt:   a.createdAt,
    })),
    summary,
  };

  await fs.mkdir(STATUS_DIR, { recursive: true });
  await writeJsonAtomic(REPORT_FILE, report);
  console.log(
    `[monitor] ${report.checkedAt}  summary=${summary}  isStale=${stale}  openAlerts=${openAlerts.length}`,
  );
}

// ---------------------------------------------------------------------------
// Entry point (skipped when imported by tests via require.main guard)
// ---------------------------------------------------------------------------

async function run() {
  console.log(
    `[monitor] Starting — interval=${CHECK_INTERVAL_SECONDS}s  staleThreshold=${STALE_THRESHOLD_HOURS}h`,
  );
  // Run immediately on startup so the first report is available right away.
  await check().catch(err => console.error('[monitor] check failed:', err));
  setInterval(
    () => check().catch(err => console.error('[monitor] check failed:', err)),
    CHECK_INTERVAL_SECONDS * 1_000,
  );
}

if (require.main === module) run();
