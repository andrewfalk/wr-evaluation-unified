import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import { createAuthMiddleware } from '../auth';
import { generateAccessToken, type AccessTokenPayload } from '../../auth/tokens';

const BASE: AccessTokenPayload = {
  sub:                'user-1',
  sessionId:          'sess-1',
  orgId:              'org-1',
  role:               'doctor',
  name:               'Dr. Kim',
  mustChangePassword: false,
  csrfHash:           'csrfhash',
};

function makePool(sessionRows: unknown[]): Pool {
  return { query: vi.fn().mockResolvedValue({ rows: sessionRows }) } as unknown as Pool;
}

function makeReq(authorization?: string): Request {
  return { headers: { authorization } } as unknown as Request;
}

function makeRes() {
  const json   = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

describe('createAuthMiddleware', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const middleware = createAuthMiddleware(makePool([]));
    const req  = makeReq();
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();
    await middleware(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is invalid', async () => {
    const middleware = createAuthMiddleware(makePool([]));
    const req  = makeReq('Bearer bad.token.here');
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();
    await middleware(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
  });

  it('returns 401 when session is revoked in DB (invalidated_at set)', async () => {
    const { token } = generateAccessToken(BASE);
    // DB returns empty rows → session revoked / expired
    const middleware = createAuthMiddleware(makePool([]));
    const req  = makeReq(`Bearer ${token}`) as Request & { sessionInfo?: unknown };
    const next = vi.fn() as unknown as NextFunction;
    const { res, status, json } = makeRes();
    await middleware(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_REVOKED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the user account is disabled', async () => {
    const { token } = generateAccessToken(BASE);
    const middleware = createAuthMiddleware(makePool([{ disabled_at: '2026-01-01T00:00:00Z' }]));
    const req  = makeReq(`Bearer ${token}`) as Request & { sessionInfo?: unknown };
    const next = vi.fn() as unknown as NextFunction;
    const { res, status, json } = makeRes();
    await middleware(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'USER_DISABLED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next(err) when pool.query throws (DB down)', async () => {
    const { token } = generateAccessToken(BASE);
    const pool = { query: vi.fn().mockRejectedValue(new Error('DB down')) } as unknown as Pool;
    const middleware = createAuthMiddleware(pool);
    const req  = makeReq(`Bearer ${token}`) as Request & { sessionInfo?: unknown };
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('populates req.sessionInfo and calls next when JWT + DB session are valid', async () => {
    const { token } = generateAccessToken(BASE);
    // DB returns a row → session is live
    const middleware = createAuthMiddleware(makePool([{ exists: 1 }]));
    const req  = makeReq(`Bearer ${token}`) as Request & { sessionInfo?: unknown };
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.sessionInfo).toMatchObject({
      userId:        'user-1',
      sessionId:     'sess-1',
      organizationId: 'org-1',
      role:           'doctor',
      name:           'Dr. Kim',
      csrfTokenHash:  'csrfhash',
      mustChangePassword: false,
    });
  });
});
