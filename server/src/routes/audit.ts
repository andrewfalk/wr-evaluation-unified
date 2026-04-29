import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthMiddleware } from '../middleware/auth';
import { writeAuditLog, writeAuditLogStrict } from '../middleware/audit';

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

// ---------------------------------------------------------------------------
// In-memory nonce store: prevents replay of the same signed request within
// the timestamp window. Each entry = nonce → expiry timestamp.
// A periodic sweep bounds memory. For multi-instance deployments, replace
// with a shared Redis SETNX + TTL key.
// ---------------------------------------------------------------------------
const seenNonces    = new Map<string, number>(); // nonce → expiry ms
const pendingNonces = new Set<string>();          // in-flight nonces (pre-commit)
const NONCE_TTL_MS  = TIMESTAMP_TOLERANCE_MS * 2 + 1000;

// Sweep expired entries every minute so memory stays bounded.
function sweepNonces(): void {
  const now = Date.now();
  for (const [nonce, expiresAt] of seenNonces) {
    if (expiresAt < now) seenNonces.delete(nonce);
  }
}
setInterval(sweepNonces, 60_000).unref();

const EMR_AUDIT_ACTIONS = new Set([
  'emr_inject',
  'emr_extract_record',
  'emr_extract_consultation',
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

async function handleEmrAudit(pool: Pool, req: Request, res: Response): Promise<void> {
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

  // --- 3b. Nonce atomic guard ---
  // seenNonces:    committed nonces (signature verified, audit written)
  // pendingNonces: in-flight nonces (claimed before the first await)
  //
  // Both sets are checked together so two concurrent requests with the same
  // nonce cannot both slip through the gap between the has() check and the
  // first DB await. The nonce is added to pendingNonces synchronously (no
  // await between the has() check and the add()), which is safe because
  // Node.js is single-threaded within a synchronous block.
  //
  // The nonce is only promoted to seenNonces (permanent) on signature success.
  // On any failure path it is removed from pendingNonces so the device can
  // retry the same nonce after a transient error.
  const nonceKey = `${deviceId}:${deviceNonce}`;
  if (seenNonces.has(nonceKey) || pendingNonces.has(nonceKey)) {
    res.status(401).json({ code: 'UNAUTHORIZED', error: 'Duplicate request (nonce reuse)' });
    return;
  }
  pendingNonces.add(nonceKey);

  let nonceCommitted = false;
  try {
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

    // --- 6. Verify session.user_id ≡ device.user_id AND org match ---
    const session = req.sessionInfo!;

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

    // --- 8. Write audit log (strict — throws on failure) ---
    // This endpoint exists solely to record the audit row. If the INSERT fails
    // we must NOT return 200; the caller's retry logic depends on it.
    //
    // IMPORTANT: nonce is committed to seenNonces ONLY after a successful INSERT.
    // If writeAuditLogStrict throws, nonceCommitted stays false → finally releases
    // the nonce from pendingNonces so the device can retry with the same nonce+sig.
    await writeAuditLogStrict(pool, {
      actorUserId: session.userId,
      actorOrgId:  device.organization_id,
      action:      body.action,
      targetType:  'emr',
      targetId:    body.targetId ?? null,
      outcome:     body.outcome,
      ip:          req.ip ?? null,
      userAgent:   req.headers['user-agent'] ?? null,
      extra:       {
        deviceId,
        source:     'electron-main',
        ...(body.extra ?? {}),
      },
    });

    // Audit row persisted — permanently block replay of this nonce.
    nonceCommitted = true;
    seenNonces.set(nonceKey, Date.now() + NONCE_TTL_MS);

    // Update device last_seen_at
    pool.query(
      `UPDATE devices SET last_seen_at = now() WHERE id = $1`,
      [deviceId]
    ).catch(() => undefined);

    res.status(200).json({ ok: true });
  } finally {
    // Release the in-flight claim on failure so the device can retry.
    // On success nonceCommitted=true and the nonce lives in seenNonces instead.
    if (!nonceCommitted) pendingNonces.delete(nonceKey);
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
export function createAuditRouter(pool: Pool): Router {
  const router = Router();
  const auth   = createAuthMiddleware(pool);

  router.post(
    '/emr',
    auth,
    (req, res) => handleEmrAudit(pool, req, res).catch(() =>
      res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Internal server error' })
    )
  );

  return router;
}
