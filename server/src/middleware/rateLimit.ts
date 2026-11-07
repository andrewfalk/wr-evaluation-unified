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

// SEC-A L3 — POST /api/audit/emr, outer guard: 120 per minute per IP. The route accepts requests
// without a session (queued replays), and the device id is a request header — so before the
// signature is verified the only safe key is the address. This bounds the device lookups an
// unverified sender can cause. The per-device limit runs after verification (createKeyedLimiter).
export function emrAuditIpRateLimit(): RequestHandler {
  return rateLimit({
    windowMs:        60 * 1000,
    limit:           120,
    standardHeaders: 'draft-7',
    legacyHeaders:   false,
    message:         { code: 'RATE_LIMITED', error: 'Too many audit requests, please try again later' },
  });
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
