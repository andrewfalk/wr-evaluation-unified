import { rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';

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
