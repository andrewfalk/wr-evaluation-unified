import { rateLimit } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import { sessionOf } from '../http/authz';

// 5 login attempts per minute per IP — brute-force protection.
export function loginRateLimit(): RequestHandler {
  return rateLimit({
    windowMs:         60 * 1000,
    limit:            5,
    standardHeaders:  'draft-7',
    legacyHeaders:    false,
    message:          { code: 'RATE_LIMITED', error: 'Too many login attempts, please try again later' },
    skipSuccessfulRequests: false,
  });
}

// 10 CSRF reissue requests per minute per IP — prevents enumeration abuse.
export function csrfRateLimit(): RequestHandler {
  return rateLimit({
    windowMs:         60 * 1000,
    limit:            10,
    standardHeaders:  'draft-7',
    legacyHeaders:    false,
    message:          { code: 'RATE_LIMITED', error: 'Too many CSRF reissue requests, please try again later' },
  });
}

// Device registration: 1 per minute per IP (outer guard, before auth).
export function deviceRegisterIpRateLimit(): RequestHandler {
  return rateLimit({
    windowMs:        60 * 1000,
    limit:           1,
    standardHeaders: 'draft-7',
    legacyHeaders:   false,
    message:         { code: 'RATE_LIMITED', error: 'Too many device registration requests, please try again later' },
  });
}

// Signup requests: 3 per hour per IP — prevents spam account requests.
export function signupRateLimit(): RequestHandler {
  return rateLimit({
    windowMs:        60 * 60 * 1000,
    limit:           3,
    standardHeaders: 'draft-7',
    legacyHeaders:   false,
    message:         { code: 'RATE_LIMITED', error: 'Too many signup requests, please try again later' },
  });
}

// Device registration: 5 per hour per authenticated user (inner guard, after auth).
// keyGenerator uses userId from req.sessionInfo so each user has a separate bucket.
export function deviceRegisterUserRateLimit(): RequestHandler {
  return rateLimit({
    windowMs:        60 * 60 * 1000,
    limit:           5,
    standardHeaders: 'draft-7',
    legacyHeaders:   false,
    // Auth middleware runs before this limiter, so sessionInfo is always set.
    // Avoid using req.ip here to sidestep the IPv6 normalisation warning.
    keyGenerator:    (req: Request) => sessionOf(req).userId,
    message:         { code: 'RATE_LIMITED', error: 'Device registration limit reached for this account' },
  });
}

// PR1 — POST /analyze: 20 per minute per authenticated user. Python subprocess를 실제로
// 스폰할 수 있는 유일한 엔드포인트라 volume을 얕게 통제한다(가드A/가드C와는 별개 레이어 —
// 계획서 §4.0). deviceRegisterUserRateLimit()와 동일 패턴(userId 키).
export function analyzeRateLimit(): RequestHandler {
  return rateLimit({
    windowMs:        60 * 1000,
    limit:           20,
    standardHeaders: 'draft-7',
    legacyHeaders:   false,
    keyGenerator:    (req: Request) => sessionOf(req).userId,
    message:         { code: 'RATE_LIMITED', error: 'Too many analysis requests, please try again later' },
  });
}

// SEC-A L3 — POST /api/auth/refresh: 60 per minute per IP. Each call rotates the refresh token and
// issues an access token; a normal client refreshes a few times per hour.
export function refreshRateLimit(): RequestHandler {
  return rateLimit({
    windowMs:        60 * 1000,
    limit:           60,
    standardHeaders: 'draft-7',
    legacyHeaders:   false,
    message:         { code: 'RATE_LIMITED', error: 'Too many token refresh requests, please try again later' },
  });
}

// SEC-A L3 — POST /api/audit/emr, outer guard: 120 failed requests per minute per IP. The route accepts
// requests without a session (queued replays), and the device id is a request header — so before the
// signature is verified the only safe key is the address. This bounds the device lookups an
// unverified sender can cause. Only responses that ended in an error (status >= 400) are counted, when
// they end — requests in progress and accepted requests use none of it, so a PC sending its stored
// events (or several PCs behind one address) is paced by the per-PC limit only (createPacedLimiter).
export const EMR_AUDIT_IP_FAILURES_PER_MINUTE = 120;

export function emrAuditIpRateLimit(options: { windowMs?: number; maxFailures?: number; now?: () => number } = {}): RequestHandler {
  const windowMs = options.windowMs ?? 60 * 1000;
  const maxFailures = options.maxFailures ?? EMR_AUDIT_IP_FAILURES_PER_MINUTE;
  const now = options.now ?? Date.now;
  const failures = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const key = req.ip ?? 'unknown';
    const t = now();
    const w = failures.get(key);
    if (w && w.resetAt > t && w.count >= maxFailures) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((w.resetAt - t) / 1000))));
      res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many audit requests, please try again later' });
      return;
    }
    res.on('finish', () => {
      if (res.statusCode < 400) return;
      const at = now();
      let cur = failures.get(key);
      if (!cur || cur.resetAt <= at) {
        if (!cur && failures.size >= 10_000) {
          for (const [k, v] of failures) if (v.resetAt <= at) failures.delete(k);
          if (failures.size >= 10_000) failures.delete(failures.keys().next().value as string);
        }
        cur = { count: 0, resetAt: at + windowMs };
        failures.set(key, cur);
      }
      cur.count += 1;
    });
    next();
  };
}

export interface KeyedLimiter {
  /** Counts one event for `key`; `allowed` is false once the window's limit is used up. */
  hit(key: string): { allowed: boolean; retryAfterSec: number };
}

/**
 * Fixed-window counter keyed by an arbitrary string, for limits that can only be keyed after the
 * handler has verified something (express-rate-limit keys before the handler runs). In memory, per
 * process — like the other limiters here. Keys whose window has ended are dropped when the map grows
 * past `maxKeys`, so a stream of distinct keys cannot grow it without bound.
 */
export function createKeyedLimiter(options: { windowMs: number; max: number; maxKeys?: number; now?: () => number }): KeyedLimiter {
  const { windowMs, max, maxKeys = 10_000, now = Date.now } = options;
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key: string) {
      const t = now();
      let w = windows.get(key);
      if (!w || w.resetAt <= t) {
        if (!w && windows.size >= maxKeys) {
          for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
          if (windows.size >= maxKeys) windows.delete(windows.keys().next().value as string); // oldest entry
        }
        w = { count: 0, resetAt: t + windowMs };
        windows.set(key, w);
      }
      w.count += 1;
      return { allowed: w.count <= max, retryAfterSec: Math.max(1, Math.ceil((w.resetAt - t) / 1000)) };
    },
  };
}

export type PacedAcquire =
  /**
   * Go ahead after `delayMs`. A request that waits must call `doneWaiting()` when its wait is over (it counts
   * towards `maxWaiting` until then). `refund()` gives the slot back (the event was not recorded after all).
   */
  | { allowed: true; delayMs: number; doneWaiting: () => void; refund: () => void }
  /** Too many requests of this key are already waiting. */
  | { allowed: false; retryAfterSec: number };

export interface PacedLimiter {
  acquire(key: string): PacedAcquire;
}

/**
 * Token bucket that delays instead of refusing: each key may take `burst` events at once, then `ratePerSec`
 * events per second. A request over the rate is told how long to wait for its slot; at most `maxWaiting`
 * requests of one key may be waiting at a time (counted until each calls doneWaiting), beyond that the
 * request is refused. Throughput per key is therefore bounded by burst + rate × time whether requests arrive
 * one by one or all at once. In memory, per process. Keys whose bucket is full again and has nobody waiting
 * are dropped when the map grows past `maxKeys`.
 */
export function createPacedLimiter(options: {
  burst: number; ratePerSec: number; maxWaiting: number; maxKeys?: number; now?: () => number;
}): PacedLimiter {
  const { burst, ratePerSec, maxWaiting, maxKeys = 10_000, now = Date.now } = options;
  // tokens may go below 0: -n means n slots are promised to waiting requests.
  interface Bucket { tokens: number; at: number; waiting: number }
  const buckets = new Map<string, Bucket>();
  const refill = (b: Bucket, t: number) => {
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * ratePerSec);
    b.at = t;
  };
  return {
    acquire(key) {
      const t = now();
      let b = buckets.get(key);
      if (!b) {
        if (buckets.size >= maxKeys) {
          for (const [k, v] of buckets) { refill(v, t); if (v.tokens >= burst && v.waiting === 0) buckets.delete(k); }
          if (buckets.size >= maxKeys) {
            for (const [k, v] of buckets) if (v.waiting === 0) { buckets.delete(k); break; }
          }
        }
        b = { tokens: burst, at: t, waiting: 0 };
        buckets.set(key, b);
      }
      refill(b, t);
      const mustWait = b.tokens < 1;
      if (mustWait && b.waiting >= maxWaiting) {
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / ratePerSec)) };
      }
      b.tokens -= 1;
      const delayMs = mustWait ? Math.ceil((-b.tokens / ratePerSec) * 1000) : 0;
      const bucket = b;
      let waiting = mustWait;
      if (waiting) bucket.waiting += 1;
      let refunded = false;
      return {
        allowed: true,
        delayMs,
        doneWaiting: () => {
          if (!waiting) return;
          waiting = false;
          bucket.waiting -= 1;
        },
        refund: () => {
          if (refunded) return;
          refunded = true;
          refill(bucket, now());
          bucket.tokens = Math.min(burst, bucket.tokens + 1);
        },
      };
    },
  };
}
