import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { auditMiddleware } from '../middleware/audit';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
const MAX_DEVICE_ID_LEN = 256;

// Returns the deviceId query param if valid, or null.
function parseDeviceId(req: Request): string | null {
  const raw = req.query['deviceId'];
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_DEVICE_ID_LEN) return null;
  return raw.trim();
}

const MISSING_DEVICE_ID = { code: 'MISSING_DEVICE_ID', error: 'deviceId query parameter is required' } as const;

// PUT body: patients array (stored as-is; client validates individual patient shape)
const PutBody = z.object({
  patients: z.array(z.unknown()),
});

// ---------------------------------------------------------------------------
// GET /api/autosave?deviceId=
// Returns the stored autosave for this user+device, or null if none exists.
// ---------------------------------------------------------------------------
async function getAutosave(pool: Pool, req: Request, res: Response): Promise<void> {
  const deviceId = parseDeviceId(req);
  if (!deviceId) {
    res.status(400).json(MISSING_DEVICE_ID);
    return;
  }

  const session = req.sessionInfo!;
  interface AutosaveRow { saved_at: Date; payload: unknown; }
  const { rows } = await pool.query<AutosaveRow>(
    `SELECT saved_at, payload FROM autosaves WHERE user_id = $1 AND device_id = $2`,
    [session.userId, deviceId]
  );

  if (rows.length === 0) {
    res.status(200).json(null);
    return;
  }

  const row = rows[0];
  // payload is stored as the patients array directly
  const patients = Array.isArray(row.payload) ? row.payload : [];
  res.status(200).json({ savedAt: row.saved_at.toISOString(), patients });
}

// ---------------------------------------------------------------------------
// PUT /api/autosave?deviceId=
// Upsert (one row per user+device). Updates saved_at and payload on conflict.
// ---------------------------------------------------------------------------
async function putAutosave(pool: Pool, req: Request, res: Response): Promise<void> {
  const deviceId = parseDeviceId(req);
  if (!deviceId) {
    res.status(400).json(MISSING_DEVICE_ID);
    return;
  }

  const parse = PutBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  const { patients } = parse.data;

  const session = req.sessionInfo!;
  const orgId   = session.organizationId;

  const { rows } = await pool.query<{ saved_at: Date }>(
    `INSERT INTO autosaves (user_id, device_id, organization_id, saved_at, payload)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (user_id, device_id) DO UPDATE
       SET saved_at = now(), payload = EXCLUDED.payload
     RETURNING saved_at`,
    [session.userId, deviceId, orgId, JSON.stringify(patients)]
  );

  res.status(200).json({ ok: true, savedAt: rows[0].saved_at.toISOString() });
}

// ---------------------------------------------------------------------------
// DELETE /api/autosave?deviceId=
// Removes the autosave row for this user+device.
// Returns ok:true even if no row existed (idempotent).
// ---------------------------------------------------------------------------
async function deleteAutosave(pool: Pool, req: Request, res: Response): Promise<void> {
  const deviceId = parseDeviceId(req);
  if (!deviceId) {
    res.status(400).json(MISSING_DEVICE_ID);
    return;
  }

  const session = req.sessionInfo!;
  await pool.query(
    `DELETE FROM autosaves WHERE user_id = $1 AND device_id = $2`,
    [session.userId, deviceId]
  );

  res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

export function createAutosaveRouter(pool: Pool): Router {
  const router = Router();
  const auth   = createAuthMiddleware(pool);
  const audit  = (action: string) =>
    auditMiddleware(pool, action, 'autosave', (req) => req.query['deviceId'] as string ?? null);

  router.get(
    '/',
    auth, audit('autosave_load'),
    (req, res) => getAutosave(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.put(
    '/',
    auth, csrfMiddleware, audit('autosave_save'),
    (req, res) => putAutosave(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.delete(
    '/',
    auth, csrfMiddleware, audit('autosave_delete'),
    (req, res) => deleteAutosave(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  return router;
}
