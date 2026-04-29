import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../auth';
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

function makeReq(authorization?: string): Request {
  return { headers: { authorization } } as unknown as Request;
}

function makeRes() {
  const json   = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

describe('authMiddleware', () => {
  it('returns 401 when Authorization header is missing', () => {
    const req  = makeReq();
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();
    authMiddleware(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is invalid', () => {
    const req  = makeReq('Bearer bad.token.here');
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();
    authMiddleware(req, res, next);
    expect(status).toHaveBeenCalledWith(401);
  });

  it('populates req.sessionInfo and calls next for valid token', () => {
    const { token } = generateAccessToken(BASE);
    const req  = makeReq(`Bearer ${token}`) as Request & { sessionInfo?: unknown };
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    authMiddleware(req, res, next);

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
