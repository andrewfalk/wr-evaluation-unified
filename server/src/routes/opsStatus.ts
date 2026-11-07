import { Router, type Request, type Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { createAuthMiddleware } from '../middleware/auth';
import { adminOnly } from '../middleware/adminOnly';
import { csrfMiddleware } from '../middleware/csrf';
import { asyncHandler } from '../http/asyncHandler';
import config from '../config';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// config.backupsDir (BACKUPS_DIR ?? '/backups'), read when a request is handled rather than at
// import (P1-10).
const statusDir = (): string => path.join(config.backupsDir, '_status');
const alertsDir = (): string => path.join(config.backupsDir, '_alerts');

// backup.sh encodes runId as YYYYmmdd_HHMMSS — validate strictly to prevent
// path traversal via the :runId URL param.
const VALID_RUN_ID = /^\d{8}_\d{6}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(dest: string, obj: unknown): Promise<void> {
  const tmp = `${dest}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  await fs.rename(tmp, dest);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// Reads _alerts/FAILED_*.json and returns entries where resolvedAt is null.
// Called live on each GET so ack/resolve changes are immediately reflected.
async function readOpenAlerts(): Promise<Record<string, unknown>[]> {
  let files: string[];
  try {
    files = await fs.readdir(alertsDir());
  } catch {
    return [];
  }
  const alertFiles = files.filter(f => f.startsWith('FAILED_') && f.endsWith('.json'));
  const results = await Promise.all(
    alertFiles.map(f => readJsonFile(path.join(alertsDir(), f)))
  );
  return results.filter(
    (a): a is Record<string, unknown> =>
      a !== null && typeof a === 'object' &&
      (a as Record<string, unknown>).resolvedAt === null,
  );
}

// Mirrors the monitor's computeSummary so live openAlerts yield the correct summary.
// isStale is taken from monitor-report.json (updated hourly — accurate enough).
function recomputeSummary(stale: boolean, openAlerts: Record<string, unknown>[]): string {
  const realAlertCount  = openAlerts.filter(a => a.dryRun !== true).length;
  const totalAlertCount = openAlerts.length;
  if (stale && realAlertCount > 0) return 'stale_and_alert';
  if (stale)                        return 'stale';
  if (realAlertCount > 0)           return 'alert_open';
  if (totalAlertCount > 0)          return 'dry_run_alert_open';
  return 'ok';
}

// GET /api/admin/ops/backup-status
// Returns monitor-report.json (with live-recomputed openAlerts + summary)
// and backup-status.json. 503 when neither file exists.
async function getBackupStatus(_req: Request, res: Response): Promise<void> {
  const [monitorReport, backupStatus, openAlerts] = await Promise.all([
    readJsonFile(path.join(statusDir(), 'monitor-report.json')),
    readJsonFile(path.join(statusDir(), 'backup-status.json')),
    readOpenAlerts(),
  ]);

  if (!monitorReport && !backupStatus) {
    res.status(503).json({ error: 'Backup status not available — monitor may not have run yet.' });
    return;
  }

  // Recompute summary from live openAlerts so the banner clears immediately after resolve,
  // not just after the next hourly monitor cycle.
  let report: Record<string, unknown> | null = null;
  if (monitorReport) {
    const base  = monitorReport as Record<string, unknown>;
    // isStale is already computed by the monitor against the threshold — reuse as-is.
    const stale = Boolean(base.isStale);
    report = { ...base, openAlerts, summary: recomputeSummary(stale, openAlerts) };
  }

  res.json({ monitorReport: report, backupStatus });
}

// POST /api/admin/ops/backup-alerts/:runId/ack
// Sets acknowledgedAt on the alert file. Idempotent.
async function ackAlert(req: Request, res: Response): Promise<void> {
  const { runId } = req.params;
  if (!VALID_RUN_ID.test(runId)) {
    res.status(400).json({ error: 'Invalid runId format.' });
    return;
  }

  const alertPath = path.join(alertsDir(), `FAILED_${runId}.json`);
  const alert = await readJsonFile(alertPath) as Record<string, unknown> | null;
  if (!alert) {
    res.status(404).json({ error: 'Alert not found.' });
    return;
  }

  if (alert.acknowledgedAt) {
    res.json({ ok: true, alert }); // already acked — idempotent
    return;
  }

  const updated = {
    ...alert,
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: req.sessionInfo?.userId ?? 'unknown',
  };
  await writeJsonAtomic(alertPath, updated);
  res.json({ ok: true, alert: updated });
}

// POST /api/admin/ops/backup-alerts/:runId/resolve
// Sets resolvedAt on the alert file. Idempotent.
async function resolveAlert(req: Request, res: Response): Promise<void> {
  const { runId } = req.params;
  if (!VALID_RUN_ID.test(runId)) {
    res.status(400).json({ error: 'Invalid runId format.' });
    return;
  }

  const alertPath = path.join(alertsDir(), `FAILED_${runId}.json`);
  const alert = await readJsonFile(alertPath) as Record<string, unknown> | null;
  if (!alert) {
    res.status(404).json({ error: 'Alert not found.' });
    return;
  }

  if (alert.resolvedAt) {
    res.json({ ok: true, alert }); // already resolved — idempotent
    return;
  }

  const updated = {
    ...alert,
    resolvedAt: new Date().toISOString(),
    resolvedBy: req.sessionInfo?.userId ?? 'unknown',
  };
  await writeJsonAtomic(alertPath, updated);
  res.json({ ok: true, alert: updated });
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
export function createOpsStatusRouter(pool: Pool) {
  const router = Router();
  const auth  = createAuthMiddleware(pool);
  const admin = adminOnly();

  router.get(
    '/backup-status',
    auth, admin,
    asyncHandler((req, res) => getBackupStatus(req, res)),
  );

  router.post(
    '/backup-alerts/:runId/ack',
    auth, admin, csrfMiddleware,
    asyncHandler((req, res) => ackAlert(req, res)),
  );

  router.post(
    '/backup-alerts/:runId/resolve',
    auth, admin, csrfMiddleware,
    asyncHandler((req, res) => resolveAlert(req, res)),
  );

  return router;
}
