import crypto from 'crypto';
import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthMiddleware } from '../middleware/auth';
import { writeAuditLog, writeAuditLogStrict } from '../middleware/audit';
import { asyncHandler } from '../http/asyncHandler';
import { createKeyedLimiter, emrAuditIpRateLimit, type KeyedLimiter } from '../middleware/rateLimit';

// SEC-A L3 — signed EMR audit events accepted per device per minute (a normal device sends a few per
// EMR action; a queue flush after a long offline period is spread over several minutes).
export const EMR_AUDIT_EVENTS_PER_DEVICE_PER_MINUTE = 120;

// ---------------------------------------------------------------------------
// POST /api/audit/emr
//
// Called by Electron main process after every EMR helper operation.
// The main process signs the payload with the device's Ed25519 private key
// so the server can verify authenticity independently of the render-process
// session (a compromised renderer cannot fabricate EMR audit entries).
//
// Required headers:
//   X-WR-Device-Id:  UUID of the registered device
//   X-WR-Device-Sig: base64-encoded Ed25519 signature over the canonical body
//   X-WR-Device-Ts:  ISO-8601 timestamp — must be within ±5 minutes
//   X-WR-Source:     must equal 'electron-main'
// ---------------------------------------------------------------------------

const DEVICE_HEADER_ID    = 'x-wr-device-id';
const DEVICE_HEADER_SIG   = 'x-wr-device-sig';
const DEVICE_HEADER_TS    = 'x-wr-device-ts';
const DEVICE_HEADER_NONCE = 'x-wr-device-nonce';
const SOURCE_HEADER       = 'x-wr-source';

// Replay window: ±5 minutes
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

// Nonces are recorded in emr_audit_nonces (migration 0038) in the same transaction as the audit row
// — see step 8 (SEC-A L11). jobs/emrAuditNonces.ts removes old rows.

const EMR_AUDIT_ACTIONS = new Set([
  'emr_inject',
  'emr_extract_record',
  'emr_extract_consultation',
  'audit_queue_corrupt',  // diagnostic: sent when the client-side encrypted queue was corrupt
]);

const EmrAuditBody = z.object({
  action:      z.string().refine((a) => EMR_AUDIT_ACTIONS.has(a), {
    message: `action must be one of: ${[...EMR_AUDIT_ACTIONS].join(', ')}`,
  }),
  targetId:    z.string().max(256).optional().nullable(),
  outcome:     z.enum(['success', 'failure']),
  extra:       z.record(z.unknown()).optional().nullable(),
});

interface DeviceRow {
  user_id:         string;
  organization_id: string | null;
  public_key:      string;
  status:          string;
}

async function handleEmrAudit(pool: Pool, deviceLimiter: KeyedLimiter, req: Request, res: Response): Promise<void> {
  // --- 1. Source guard ---
  if (req.headers[SOURCE_HEADER] !== 'electron-main') {
    res.status(401).json({ code: 'UNAUTHORIZED', error: 'Invalid source' });
    return;
  }

  // --- 2. Device headers ---
  const deviceId    = req.headers[DEVICE_HEADER_ID]    as string | undefined;
  const deviceSig   = req.headers[DEVICE_HEADER_SIG]   as string | undefined;
  const deviceTs    = req.headers[DEVICE_HEADER_TS]    as string | undefined;
  const deviceNonce = req.headers[DEVICE_HEADER_NONCE] as string | undefined;

  if (!deviceId || !deviceSig || !deviceTs || !deviceNonce) {
    res.status(401).json({ code: 'UNAUTHORIZED', error: 'Missing device headers' });
    return;
  }

  // --- 3. Timestamp replay guard ---
  const ts = new Date(deviceTs).getTime();
  if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > TIMESTAMP_TOLERANCE_MS) {
    res.status(401).json({ code: 'UNAUTHORIZED', error: 'Timestamp out of range' });
    return;
  }

  // --- 4. Body validation ---
  const parse = EmrAuditBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  const body = parse.data;

  // --- 5. Load device + verify status ---
  const deviceRes = await pool.query<DeviceRow>(
    `SELECT user_id, organization_id, public_key, status
     FROM devices WHERE id = $1`,
    [deviceId]
  );
  if (deviceRes.rows.length === 0) {
    res.status(401).json({ code: 'UNAUTHORIZED', error: 'Device not found' });
    return;
  }
  const device = deviceRes.rows[0];

  if (device.status !== 'active') {
    res.status(401).json({ code: 'UNAUTHORIZED', error: 'Device not active' });
    return;
  }

  // --- 6. Optional session check + actor resolution ---
  // When replaying from the encrypted local queue (session expired), no Bearer
  // token is sent. In that case we skip the user/org mismatch check and use
  // the device's own user_id / organization_id as the audit actor, marked with
  // session_missing=true in the extra field.
  const session = req.sessionInfo ?? null;
  const sessionMissing = session === null;

  if (!sessionMissing) {
    const userMismatch = session.userId !== device.user_id;
    // If the session belongs to an org, the device must belong to the same org.
    // A null device.organization_id is not tolerated for org-scoped sessions:
    // legitimate devices are always registered with an org in production.
    // Superadmin (session.organizationId === null) bypasses the org check.
    const orgMismatch =
      session.organizationId !== null &&
      session.organizationId !== device.organization_id;

    if (userMismatch || orgMismatch) {
      const action = userMismatch ? 'device_user_mismatch' : 'device_org_mismatch';
      writeAuditLog(pool, {
        actorUserId: session.userId,
        actorOrgId:  session.organizationId ?? null,
        action,
        targetType:  'device',
        targetId:    deviceId,
        outcome:     'denied',
        ip:          req.ip ?? null,
        userAgent:   req.headers['user-agent'] ?? null,
        extra: userMismatch
          ? { deviceUserId: device.user_id }
          : { deviceOrgId: device.organization_id },
      });
      res.status(401).json({ code: 'UNAUTHORIZED', error: 'Device / session identity mismatch' });
      return;
    }
  }

  // Actor identity: from live session when present, from device registration otherwise.
  const actorUserId = session?.userId ?? device.user_id;
  const actorOrgId  = session?.organizationId ?? device.organization_id ?? null;

  // --- 7. Ed25519 signature verification ---
  // Canonical message = "<deviceId>.<deviceTs>.<deviceNonce>.<JSON-sorted-body>"
  // Including deviceId and deviceNonce binds the signature to this specific
  // device+request so an attacker cannot reuse a valid signature by substituting
  // a fresh nonce (which would otherwise bypass the nonce replay guard).
  const canonicalBody = JSON.stringify(
    Object.fromEntries(
      Object.entries(body).sort(([a], [b]) => a.localeCompare(b))
    )
  );
  const message = `${deviceId}.${deviceTs}.${deviceNonce}.${canonicalBody}`;

  let sigValid = false;
  try {
    const rawKeyBytes = Buffer.from(device.public_key, 'base64');
    // Ed25519 SPKI DER header (12 bytes): prepend to raw 32-byte key
    const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiDer    = Buffer.concat([spkiHeader, rawKeyBytes]);
    const pubKey     = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    sigValid = crypto.verify(
      null,
      Buffer.from(message),
      pubKey,
      Buffer.from(deviceSig, 'base64')
    );
  } catch {
    sigValid = false;
  }

  if (!sigValid) {
    res.status(401).json({ code: 'UNAUTHORIZED', error: 'Invalid device signature' });
    return;
  }

  // --- 7b. Per-device rate limit (SEC-A L3) — keyed by the device id only now that the signature
  // proved the sender holds that device's key (keying on the unverified header would let anyone
  // create unlimited buckets). Before the nonce is claimed (step 8), so the device's queue can
  // resend the same signed entry later.
  const limit = deviceLimiter.hit(deviceId);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many audit events from this device, please retry later' });
    return;
  }

  // --- 8. Nonce + audit row, in one transaction (SEC-A L11) ---
  // The nonce is claimed only now — after the signature proved the request — and in the same
  // transaction as the audit row:
  //  - a nonce already recorded (replay, or a duplicate in flight that committed first) → 0 rows →
  //    401 as before; concurrent duplicates are serialised by the primary-key row lock.
  //  - if the audit INSERT fails, ROLLBACK removes the nonce row too, so the device's queue can resend
  //    the same signed request (this endpoint exists to record the audit row; never 200 without it).
  // Server-set fields come after the client's `extra`, so a client cannot overwrite them.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `INSERT INTO emr_audit_nonces (device_id, nonce) VALUES ($1, $2)
       ON CONFLICT (device_id, nonce) DO NOTHING
       RETURNING 1`,
      [deviceId, deviceNonce],
    );
    if ((claimed.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      res.status(401).json({ code: 'UNAUTHORIZED', error: 'Duplicate request (nonce reuse)' });
      return;
    }
    await writeAuditLogStrict(client, {
      actorUserId,
      actorOrgId,
      action:    body.action,
      targetType: 'emr',
      targetId:   body.targetId ?? null,
      outcome:    body.outcome,
      ip:         req.ip ?? null,
      userAgent:  req.headers['user-agent'] ?? null,
      extra:      {
        ...(body.extra ?? {}),
        deviceId,
        source:   'electron-main',
        ...(sessionMissing ? { session_missing: true, actor_from_queue: true } : {}),
      },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // Update device last_seen_at
  pool.query(
    `UPDATE devices SET last_seen_at = now() WHERE id = $1`,
    [deviceId]
  ).catch(() => undefined);

  res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

// Optional auth: if no Authorization header is present, skip token verification
// and let the request through with req.sessionInfo undefined (null after ??).
// This enables the Electron main process to replay queued audit entries after the
// user's session expires, relying on the Ed25519 device signature for authenticity.
// If an Authorization header IS present it must be valid — invalid tokens still 401.
function makeOptionalAuth(pool: Pool): RequestHandler {
  const required = createAuthMiddleware(pool);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers['authorization']) return next();
    required(req, res, next);
  };
}

export interface AuditRouterOptions {
  /** Per-device limit after signature verification (tests lower it). Default EMR_AUDIT_EVENTS_PER_DEVICE_PER_MINUTE. */
  emrEventsPerDevicePerMinute?: number;
}

export function createAuditRouter(pool: Pool, options: AuditRouterOptions = {}): Router {
  const router = Router();

  // SEC-A L3: per-device events per minute after signature verification (one bucket per router).
  const deviceLimiter = createKeyedLimiter({
    windowMs: 60 * 1000,
    max: options.emrEventsPerDevicePerMinute ?? EMR_AUDIT_EVENTS_PER_DEVICE_PER_MINUTE,
  });

  router.post(
    '/emr',
    emrAuditIpRateLimit(), // before anything that queries the database
    makeOptionalAuth(pool),
    asyncHandler((req, res) => handleEmrAudit(pool, deviceLimiter, req, res))
  );

  return router;
}
