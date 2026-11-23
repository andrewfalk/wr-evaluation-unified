import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuthMiddleware } from '../middleware/auth';
import { writeAuditLog, writeAuditLogStrict } from '../middleware/audit';
import { asyncHandler } from '../http/asyncHandler';
import { createPacedLimiter, emrAuditIpRateLimit, type PacedLimiter } from '../middleware/rateLimit';
import { createPcResolver, type PcResolver, type PcResolverOptions } from '../devices/pcIdentity';
import {
  clientExtraWithoutReserved, createBurstTracker, createEventThrottle, fallbackActor, isCurrentShellEvent,
  legacyShellFlags, sessionMatchesPc,
} from '../devices/emrAuditRecord';

// Per-PC pacing of signed EMR audit events (after signature verification). A PC may send EMR_AUDIT_PC_BURST
// events at once, then EMR_AUDIT_PC_RATE_PER_SEC per second; a request over the rate waits for its slot
// instead of being refused (a shell sending its stored events one by one slows down but does not fail), and
// at most EMR_AUDIT_PC_MAX_WAITING requests of one PC wait at a time (beyond that: 429).
// Measured (scripts/tier3/emr-audit-smoke.mjs): a shell sends its stored events back to back at about 120 per
// second. With these values one 5-minute resend round of a PC takes in up to 300 + 10 × 300 = 3,300 events,
// so the round ends before the next one starts; one PC can write at most 300 + 600 per minute.
export const EMR_AUDIT_PC_BURST = 300;
export const EMR_AUDIT_PC_RATE_PER_SEC = 10;
export const EMR_AUDIT_PC_MAX_WAITING = 8;

// One device/session organisation mismatch row, and one "PC not approved / revoked" row, per PC per window
// (the rest are counted in the next row).
const ORG_MISMATCH_RECORD_WINDOW_MS = 10 * 60 * 1000;
const DENIED_RECORD_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// POST /api/audit/emr
//
// Called by Electron main process after every EMR helper operation.
// The main process signs the payload with the device's Ed25519 private key
// so the server can verify authenticity independently of the render-process
// session (a compromised renderer cannot fabricate EMR audit entries).
//
// Required headers:
//   X-WR-Device-Id:    UUID chosen by the shell — part of the signed message; the PC is found by the signature
//   X-WR-Device-Sig:   base64-encoded Ed25519 signature over the canonical body
//   X-WR-Device-Ts:    ISO-8601 timestamp — must be within ±5 minutes
//   X-WR-Device-Nonce: unique per request
//   X-WR-Source:       must equal 'electron-main'
// ---------------------------------------------------------------------------

const DEVICE_HEADER_ID    = 'x-wr-device-id';
const DEVICE_HEADER_SIG   = 'x-wr-device-sig';
const DEVICE_HEADER_TS    = 'x-wr-device-ts';
const DEVICE_HEADER_NONCE = 'x-wr-device-nonce';
const SOURCE_HEADER       = 'x-wr-source';

// Replay window: ±5 minutes
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

// Nonces are recorded in emr_audit_nonces (migration 0038) in the same transaction as the audit row
// — see step 11 (SEC-A L11). jobs/emrAuditNonces.ts removes old rows.

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

// One answer for every "this device cannot send" reason (unknown key, bad signature, not approved, malformed id).
const DEVICE_NOT_RECOGNIZED = { code: 'UNAUTHORIZED', error: 'Device not recognized' } as const;

interface AuditDeps {
  resolver: PcResolver;
  pcLimiter: PacedLimiter;
  burst: ReturnType<typeof createBurstTracker>;
  orgMismatch: ReturnType<typeof createEventThrottle>;
  denied: ReturnType<typeof createEventThrottle>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleEmrAudit(pool: Pool, deps: AuditDeps, req: Request, res: Response): Promise<void> {
  // --- 1. Source guard ---
  if (req.headers[SOURCE_HEADER] !== 'electron-main') {
    res.status(401).json({ code: 'UNAUTHORIZED', error: 'Invalid source' });
    return;
  }

  // --- 2. Device headers ---
  const headerId    = req.headers[DEVICE_HEADER_ID]    as string | undefined;
  const deviceSig   = req.headers[DEVICE_HEADER_SIG]   as string | undefined;
  const deviceTs    = req.headers[DEVICE_HEADER_TS]    as string | undefined;
  const deviceNonce = req.headers[DEVICE_HEADER_NONCE] as string | undefined;

  if (!headerId || !deviceSig || !deviceTs || !deviceNonce) {
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

  // --- 5. Find the PC by signature ---
  // Canonical message = "<header id>.<deviceTs>.<deviceNonce>.<JSON-sorted-body>". The header id is used as
  // sent, only as part of the signed message; the PC is the registered key that verifies the signature.
  // Including the id and nonce binds the signature to this request, so a captured signature cannot be
  // reused with a fresh nonce.
  const canonicalBody = JSON.stringify(
    Object.fromEntries(
      Object.entries(body).sort(([a], [b]) => a.localeCompare(b))
    )
  );
  const message = `${headerId}.${deviceTs}.${deviceNonce}.${canonicalBody}`;

  const lookup = await deps.resolver.resolve(headerId, message, deviceSig);
  if (lookup.kind === 'scan_limited') {
    res.setHeader('Retry-After', String(lookup.retryAfterSec));
    res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many audit requests, please try again later' });
    return;
  }
  if (lookup.kind === 'not_found') {
    res.status(401).json(DEVICE_NOT_RECOGNIZED);
    return;
  }
  const pc = lookup.pc;

  // --- 6. PC status: every row of the key counts (one revoked row revokes the PC) ---
  // A signed request from a revoked or not yet approved PC leaves one summary row per PC per window (older
  // shells keep EMR open after a revocation; this makes that use visible to the PC's organisation admins).
  if (pc.status !== 'active') {
    const record = deps.denied.take(pc.anchorId);
    if (record) {
      writeAuditLog(pool, {
        actorUserId: req.sessionInfo?.userId ?? null,
        actorOrgId:  pc.orgResolved ? pc.orgId : null,
        action:      'emr_audit_denied',
        targetType:  'device',
        targetId:    pc.anchorId,
        outcome:     'denied',
        ip:          req.ip ?? null,
        userAgent:   req.headers['user-agent'] ?? null,
        extra:       {
          pcStatus: pc.status,
          emrAction: body.action,
          header_device_id: headerId,
          ...(req.sessionInfo ? {} : { session_missing: true }),
          ...(record.suppressed > 0 ? { suppressed: record.suppressed } : {}),
        },
      });
    }
    res.status(401).json(DEVICE_NOT_RECOGNIZED);
    return;
  }

  // --- 7. Optional session: its organisation must be the PC's ---
  // Queue replays may come without a token (expired session). Any user of the PC's organisation may send events
  // from an approved PC; the PC's organisation decides the row's organisation either way.
  const session = req.sessionInfo
    ? { userId: req.sessionInfo.userId, organizationId: req.sessionInfo.organizationId ?? null }
    : null;
  if (session && !sessionMatchesPc(session, pc)) {
    const record = deps.orgMismatch.take(pc.anchorId);
    if (record) {
      writeAuditLog(pool, {
        actorUserId: session.userId,
        actorOrgId:  session.organizationId,
        action:      'device_org_mismatch',
        targetType:  'device',
        targetId:    pc.anchorId,
        outcome:     'denied',
        ip:          req.ip ?? null,
        userAgent:   req.headers['user-agent'] ?? null,
        extra:       {
          deviceOrgId: pc.orgId,
          header_device_id: headerId,
          ...(record.suppressed > 0 ? { suppressed: record.suppressed } : {}),
        },
      });
    }
    res.status(401).json({ code: 'UNAUTHORIZED', error: 'Device / session identity mismatch' });
    return;
  }

  // --- 8. Replay check before pacing, so a replay of a recorded request does not use up the PC's pace ---
  // New nonces are recorded under the PC's fixed row; nonces recorded under any other row of the PC (by earlier
  // versions, which keyed them by the header id) still count.
  const seen = await pool.query(
    `SELECT 1 FROM emr_audit_nonces WHERE device_id = ANY($1::uuid[]) AND nonce = $2 LIMIT 1`,
    [pc.rows.map((r) => r.id), deviceNonce],
  );
  if ((seen.rowCount ?? 0) > 0) {
    res.status(401).json({ code: 'UNAUTHORIZED', error: 'Duplicate request (nonce reuse)' });
    return;
  }

  // --- 9. Per-PC pacing: over the rate the request waits for its slot (keyed by the PC's fixed row) ---
  const slot = deps.pcLimiter.acquire(pc.anchorId);
  if (!slot.allowed) {
    res.setHeader('Retry-After', String(slot.retryAfterSec));
    res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many audit events from this device, please retry later' });
    return;
  }
  if (slot.delayMs > 0) {
    try {
      await sleep(slot.delayMs);
    } finally {
      slot.doneWaiting();
    }
  }

  // --- 10. Actor and flags ---
  const legacy = !isCurrentShellEvent(body.extra);
  const actor = fallbackActor(pc, session, {
    ...(legacy ? legacyShellFlags() : {}),
    ...(legacy && deps.burst.isBurst(pc.anchorId) ? { burst: true } : {}),
  });

  // --- 11. Nonce + audit row, in one transaction (SEC-A L11) ---
  // A nonce already recorded (a duplicate in flight that committed first) → 0 rows → 401; concurrent
  // duplicates are serialised by the primary-key row lock. If the audit INSERT fails, ROLLBACK removes the
  // nonce row too, so the PC can resend the same signed request (never 200 without the audit row).
  // Server-set fields come after the client's `extra` (from which every server-reserved key was removed).
  const client = await pool.connect();
  let recorded = false;
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `INSERT INTO emr_audit_nonces (device_id, nonce) VALUES ($1, $2)
       ON CONFLICT (device_id, nonce) DO NOTHING
       RETURNING 1`,
      [pc.anchorId, deviceNonce],
    );
    if ((claimed.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      res.status(401).json({ code: 'UNAUTHORIZED', error: 'Duplicate request (nonce reuse)' });
      return;
    }
    await writeAuditLogStrict(client, {
      actorUserId: actor.actorUserId,
      actorOrgId:  actor.actorOrgId,
      action:    body.action,
      targetType: 'emr',
      targetId:   body.targetId ?? null,
      outcome:    body.outcome,
      ip:         req.ip ?? null,
      userAgent:  req.headers['user-agent'] ?? null,
      extra:      {
        ...clientExtraWithoutReserved(body.extra),
        deviceId: pc.anchorId,
        header_device_id: headerId,
        source:   'electron-main',
        ...actor.flags,
      },
    });
    await client.query('COMMIT');
    recorded = true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    if (!recorded) slot.refund();
  }
  deps.burst.accepted(pc.anchorId);

  // Last seen on every row of the PC.
  pool.query(
    `UPDATE devices SET last_seen_at = now() WHERE public_key_fingerprint = $1`,
    [pc.fingerprint]
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
  /** Per-PC pacing (tests lower it). Defaults EMR_AUDIT_PC_BURST / EMR_AUDIT_PC_RATE_PER_SEC / EMR_AUDIT_PC_MAX_WAITING. */
  pcBurst?: number;
  pcRatePerSec?: number;
  pcMaxWaiting?: number;
  /** PC lookup limits (tests lower them). */
  resolver?: PcResolverOptions;
  /** Gap under which an older shell's event is flagged as part of a burst. */
  burstGapMs?: number;
}

export function createAuditRouter(pool: Pool, options: AuditRouterOptions = {}): Router {
  const router = Router();

  // One set per router (per process in production).
  const deps: AuditDeps = {
    resolver: createPcResolver(pool, options.resolver),
    pcLimiter: createPacedLimiter({
      burst: options.pcBurst ?? EMR_AUDIT_PC_BURST,
      ratePerSec: options.pcRatePerSec ?? EMR_AUDIT_PC_RATE_PER_SEC,
      maxWaiting: options.pcMaxWaiting ?? EMR_AUDIT_PC_MAX_WAITING,
    }),
    burst: createBurstTracker({ gapMs: options.burstGapMs }),
    orgMismatch: createEventThrottle({ windowMs: ORG_MISMATCH_RECORD_WINDOW_MS }),
    denied: createEventThrottle({ windowMs: DENIED_RECORD_WINDOW_MS }),
  };

  router.post(
    '/emr',
    emrAuditIpRateLimit(), // before anything that queries the database; counts failed requests only
    makeOptionalAuth(pool),
    asyncHandler((req, res) => handleEmrAudit(pool, deps, req, res))
  );

  return router;
}
