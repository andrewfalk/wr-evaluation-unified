import { rateLimit } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';

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
    keyGenerator:    (req: Request) => req.sessionInfo!.userId,
    message:         { code: 'RATE_LIMITED', error: 'Device registration limit reached for this account' },
  });
}
