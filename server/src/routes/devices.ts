import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthMiddleware } from '../middleware/auth';
import { deviceRegisterIpRateLimit, deviceRegisterUserRateLimit } from '../middleware/rateLimit';
import { writeAuditLog } from '../middleware/audit';

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

function keyFingerprint(publicKeyBase64: string): string {
  const normalized = publicKeyBase64.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(normalized, 'base64');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// User-Agent heuristic: Electron embeds "Electron/" in the UA string.
// Informational only (easily spoofed) — surfaced in admin UI as a flag.
function isElectronUA(ua: string | undefined): boolean {
  return Boolean(ua && ua.includes('Electron/'));
}

// ---------------------------------------------------------------------------
// POST /api/devices/register
// ---------------------------------------------------------------------------
async function registerDevice(pool: Pool, req: Request, res: Response): Promise<void> {
  const parsed = RegisterDeviceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    return;
  }

  const { publicKey, buildTarget } = parsed.data;
  const session     = req.sessionInfo!;
  const ua          = req.headers['user-agent'];
  const origin      = req.headers.origin ?? null;
  const ip          = req.ip ?? null;
  const fingerprint = keyFingerprint(publicKey);

  // ON CONFLICT returns the existing row when the same key is re-registered,
  // updating last_seen_at so admins know it was attempted again.
  const { rows } = await pool.query<{ id: string; status: string; inserted: boolean }>(
    `INSERT INTO devices
       (user_id, organization_id, public_key, public_key_fingerprint,
        build_target, status, register_origin, register_ua, register_ip)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)
     ON CONFLICT (user_id, public_key_fingerprint)
       DO UPDATE SET last_seen_at = now()
     RETURNING id, status, (xmax = 0) AS inserted`,
    [
      session.userId,
      session.organizationId ?? null,
      publicKey,
      fingerprint,
      buildTarget,
      origin,
      ua ?? null,
      ip,
    ]
  );

  const { id: deviceId, status, inserted } = rows[0];

  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  session.organizationId ?? null,
    action:      inserted ? 'device_register' : 'device_register_duplicate',
    targetType:  'device',
    targetId:    deviceId,
    outcome:     'success',
    ip,
    userAgent:   ua ?? null,
    extra: !isElectronUA(ua) ? { suspiciousUA: true, ua: ua ?? null } : null,
  });

  // 201 for new registrations, 200 for duplicate key (already pending/active).
  res.status(inserted ? 201 : 200).json({
    deviceId,
    status,
    message: inserted
      ? 'Device registration pending admin approval'
      : 'Device already registered with this key',
  });
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

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
    (req, res) => registerDevice(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  return router;
}
