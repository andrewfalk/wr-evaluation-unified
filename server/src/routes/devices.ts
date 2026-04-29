import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthMiddleware } from '../middleware/auth';
import { deviceRegisterIpRateLimit, deviceRegisterUserRateLimit } from '../middleware/rateLimit';
import { writeAuditLog } from '../middleware/audit';

const RegisterDeviceBody = z.object({
  publicKey:   z.string().min(1).max(512),
  buildTarget: z.enum(['intranet', 'standalone']),
  deviceName:  z.string().max(100).optional(),
});

// User-Agent heuristic: Electron embeds "Electron/" in the UA string.
// This is informational only (easily spoofed) — used for admin UI display,
// not as a security gate.
function isElectronUA(ua: string | undefined): boolean {
  return Boolean(ua && ua.includes('Electron/'));
}

// ---------------------------------------------------------------------------
// POST /api/devices/register
// ---------------------------------------------------------------------------
async function registerDevice(pool: Pool, req: Request, res: Response): Promise<void> {
  const parsed = RegisterDeviceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: 'publicKey and buildTarget are required' });
    return;
  }

  const { publicKey, buildTarget } = parsed.data;
  const session  = req.sessionInfo!;
  const ua       = req.headers['user-agent'];
  const origin   = req.headers.origin ?? null;
  const ip       = req.ip ?? null;

  // Warn via audit if the UA does not look like Electron (admin UI will flag it).
  const looksLikeElectron = isElectronUA(ua);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO devices
       (user_id, organization_id, public_key, build_target, status,
        register_origin, register_ua, register_ip)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
     RETURNING id`,
    [
      session.userId,
      session.organizationId ?? null,
      publicKey,
      buildTarget,
      origin,
      ua ?? null,
      ip,
    ]
  );

  const deviceId = rows[0].id;

  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  session.organizationId ?? null,
    action:      'device_register',
    targetType:  'device',
    targetId:    deviceId,
    outcome:     'success',
    ip,
    userAgent:   ua ?? null,
    extra: looksLikeElectron ? null : { suspiciousUA: true, ua: ua ?? null },
  });

  res.status(201).json({
    deviceId,
    status: 'pending',
    message: 'Device registration pending admin approval',
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
