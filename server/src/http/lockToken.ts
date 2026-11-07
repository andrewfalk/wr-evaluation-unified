// Optimistic-concurrency and lease-lock headers, parsed once (REFACTORING_ROADMAP S4 / P1-18).
//
//   If-Match: <revision>   the patient revision the client edited (PATCH /api/patients/:id,
//                          identity correction, video analysis apply)
//   X-Lock-Token: <token>  the lease token from POST /api/patients/:id/lock
//
//   router.patch('/:id', …, requireLockToken(), asyncHandler(async (req, res) => {
//     const { ifMatch, token } = lockOf(req);
//   }));
//
// Before S4 the If-Match check was written out in three handlers and the token reader twice; the
// codes and messages below are the ones they all used.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from './errors';

/** Positive integer from a header or query value. Rejects "1abc", "0", "-1", "" (surrounding spaces are trimmed). */
export function parsePositiveInt(val: unknown): number | null {
  const s = String(val ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 ? n : null;
}

/** The X-Lock-Token header, or null when absent or empty. */
export function lockTokenOf(req: Request): string | null {
  const v = req.headers['x-lock-token'];
  return typeof v === 'string' && v ? v : null;
}

const IF_MATCH_REQUIRED = { code: 'IF_MATCH_REQUIRED', error: 'If-Match header with current revision is required' } as const;
const INVALID_IF_MATCH = { code: 'INVALID_IF_MATCH', error: 'If-Match must be a positive integer revision' } as const;

/**
 * Requires `If-Match: <positive integer revision>` — 400 `IF_MATCH_REQUIRED` when missing, 400
 * `INVALID_IF_MATCH` when malformed — and sets `req.lock = { ifMatch, token }` (token = X-Lock-Token
 * or null; whether a token is required is the lock gate's decision, not this middleware's). Place it
 * right before the handler, where the handlers used to check If-Match first.
 */
export function requireLockToken(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const raw = req.headers['if-match'];
    if (!raw) {
      res.status(400).json(IF_MATCH_REQUIRED);
      return;
    }
    const ifMatch = parsePositiveInt(raw);
    if (ifMatch === null) {
      res.status(400).json(INVALID_IF_MATCH);
      return;
    }
    req.lock = { ifMatch, token: lockTokenOf(req) };
    next();
  };
}

/** `req.lock` set by requireLockToken(). If a route forgot it, the same 400 it would have sent (fail-closed). */
export function lockOf(req: Request): { ifMatch: number; token: string | null } {
  if (!req.lock) throw new AppError(400, IF_MATCH_REQUIRED.code, IF_MATCH_REQUIRED.error);
  return req.lock;
}
