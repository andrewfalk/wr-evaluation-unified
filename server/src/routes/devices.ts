import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthMiddleware } from '../middleware/auth';
import { deviceRegisterIpRateLimit, deviceRegisterUserRateLimit } from '../middleware/rateLimit';
import { writeAuditLog } from '../middleware/audit';
import { asyncHandler } from '../http/asyncHandler';
import { sessionOf } from '../http/authz';
import { DEVICE_SCOPE_PC, keyFingerprint, lockPcRows, loadPcRows, summarizePc } from '../devices/pcIdentity';

// Ed25519 public keys are exactly 32 raw bytes.
// Accept standard base64 (44 chars, optional trailing =) or
// base64url (43–44 chars, no padding).
const Ed25519PublicKey = z.string()
  .refine((key) => {
    try {
      const normalized = key.replace(/-/g, '+').replace(/_/g, '/');
      const buf = Buffer.from(normalized, 'base64');
      // Re-encode and compare to reject non-base64 garbage that Buffer silently ignores
      const reencoded = buf.toString('base64').replace(/=+$/, '');
      const inputNopad = normalized.replace(/=+$/, '');
      return reencoded === inputNopad && buf.length === 32;
    } catch {
      return false;
    }
  }, 'publicKey must be a base64-encoded Ed25519 public key (32 bytes)');

// buildTarget is restricted to 'intranet': standalone Electron handles EMR
// operations locally without server-side audit signing, so there is no reason
// to register a standalone device here.
const RegisterDeviceBody = z.object({
  publicKey:   Ed25519PublicKey,
  buildTarget: z.literal('intranet'),
  deviceName:  z.string().max(100).optional(),
});

// User-Agent heuristic: Electron embeds "Electron/" in the UA string.
// Informational only (easily spoofed) — surfaced in admin UI as a flag.
function isElectronUA(ua: string | undefined): boolean {
  return Boolean(ua && ua.includes('Electron/'));
}

type RegisterOutcome =
  | { kind: 'inserted'; id: string }
  | { kind: 'existing'; anchorId: string; status: string }
  | { kind: 'other_org' };

// ---------------------------------------------------------------------------
// POST /api/devices/register
//
// One PC (signing key) belongs to one organisation. The key's rows are read under a per-fingerprint
// transaction lock, so two registrations of the same key cannot both insert:
//  - the session's organisation already has a row of this key → no new row; the PC's fixed row id and
//    its status (revoked if any row is revoked) are returned;
//  - the key is registered in another organisation → refused (409), no row;
//  - otherwise a pending row is created (as before).
// The response says it comes from a server that works per PC (`deviceScope: 'pc'`) and which
// organisation the answer is for — the desktop shell ties its EMR gate to it.
// ---------------------------------------------------------------------------
async function registerDevice(pool: Pool, req: Request, res: Response): Promise<void> {
  const parsed = RegisterDeviceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    return;
  }

  const { publicKey, buildTarget } = parsed.data;
  const session     = sessionOf(req);
  const sessionOrg  = session.organizationId ?? null;
  const ua          = req.headers['user-agent'];
  const origin      = req.headers.origin ?? null;
  const ip          = req.ip ?? null;
  const fingerprint = keyFingerprint(publicKey);

  let outcome: RegisterOutcome;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockPcRows(client, fingerprint);
    const rows = await loadPcRows(client, fingerprint);
    if (rows.some((r) => (r.organization_id ?? null) === sessionOrg)) {
      const pc = summarizePc(fingerprint, rows);
      await client.query(`UPDATE devices SET last_seen_at = now() WHERE public_key_fingerprint = $1`, [fingerprint]);
      outcome = { kind: 'existing', anchorId: pc.anchorId, status: pc.status };
    } else if (rows.length > 0) {
      outcome = { kind: 'other_org' };
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO devices
           (user_id, organization_id, public_key, public_key_fingerprint,
            build_target, status, register_origin, register_ua, register_ip)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)
         RETURNING id`,
        [session.userId, sessionOrg, publicKey, fingerprint, buildTarget, origin, ua ?? null, ip],
      );
      outcome = { kind: 'inserted', id: inserted.rows[0].id };
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const uaExtra = !isElectronUA(ua) ? { suspiciousUA: true, ua: ua ?? null } : {};

  if (outcome.kind === 'other_org') {
    writeAuditLog(pool, {
      actorUserId: session.userId,
      actorOrgId:  sessionOrg,
      action:      'device_register_other_org',
      targetType:  'device',
      targetId:    null,
      outcome:     'denied',
      ip,
      userAgent:   ua ?? null,
      extra:       { fingerprintPrefix: fingerprint.slice(0, 8), ...uaExtra },
    });
    res.status(409).json({
      code:        'DEVICE_REGISTERED_TO_OTHER_ORG',
      error:       'This device is registered to another organization',
      deviceScope: DEVICE_SCOPE_PC,
      status:      'other_org',
      organizationId: sessionOrg,
    });
    return;
  }

  const deviceId = outcome.kind === 'inserted' ? outcome.id : outcome.anchorId;
  const status   = outcome.kind === 'inserted' ? 'pending' : outcome.status;
  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  sessionOrg,
    action:      outcome.kind === 'inserted' ? 'device_register' : 'device_register_duplicate',
    targetType:  'device',
    targetId:    deviceId,
    outcome:     'success',
    ip,
    userAgent:   ua ?? null,
    extra: Object.keys(uaExtra).length > 0 || outcome.kind === 'existing'
      ? { ...uaExtra, ...(outcome.kind === 'existing' ? { pcStatus: status } : {}) }
      : null,
  });

  // 201 for a new registration, 200 when the organisation already has this PC.
  res.status(outcome.kind === 'inserted' ? 201 : 200).json({
    deviceId,
    status,
    deviceScope:    DEVICE_SCOPE_PC,
    organizationId: sessionOrg,
    message: outcome.kind === 'inserted'
      ? 'Device registration pending admin approval'
      : 'Device already registered with this key',
  });
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createDevicesRouter(pool: Pool): Router {
  const router = Router();
  const auth   = createAuthMiddleware(pool);

  // IP rate limit first (before auth, cheap check).
  // User rate limit after auth (needs userId for key).
  router.post(
    '/register',
    deviceRegisterIpRateLimit(),
    auth,
    deviceRegisterUserRateLimit(),
    asyncHandler((req, res) => registerDevice(pool, req, res))
  );

  return router;
}
