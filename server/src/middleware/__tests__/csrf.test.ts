import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { csrfMiddleware } from '../csrf';
import { hashToken } from '../../auth/sessionStore';

const CSRF_HASH = hashToken('valid-csrf-token');

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    method:      'POST',
    path:        '/api/patients',
    headers:     { 'x-csrf-token': 'valid-csrf-token' },
    sessionInfo: {
      sessionId:          'sess-1',
      userId:             'user-1',
      csrfTokenHash:      CSRF_HASH,
      organizationId:     'org-1',
      role:               'doctor',
      name:               'Dr. Kim',
      mustChangePassword: false,
    },
    ...overrides,
  } as unknown as Request;
}

function makeRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json   = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res    = { status, json } as unknown as Response;
  return { res, status, json };
}

describe('csrfMiddleware', () => {
  it('passes through GET without checking CSRF', () => {
    const req  = makeReq({ method: 'GET', headers: {} });
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    csrfMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes through HEAD and OPTIONS', () => {
    const next = vi.fn() as unknown as NextFunction;
    for (const method of ['HEAD', 'OPTIONS']) {
      const req = makeReq({ method });
      const { res } = makeRes();
      csrfMiddleware(req, res, next);
    }
    expect(next).toHaveBeenCalledTimes(2);
  });

  // HF9: 예외 경로는 없다 — 경로 이름이 /api/auth/csrf여도 세션 없는 변경 요청은 401이다.
  it('does not exempt any path: a session-less POST is 401 even for the old "/api/auth/csrf" path', () => {
    for (const path of ['/api/auth/csrf', '/csrf']) {
      const req  = makeReq({ path, headers: {}, sessionInfo: undefined });
      const next = vi.fn() as unknown as NextFunction;
      const { res, status } = makeRes();
      csrfMiddleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(401);
    }
  });

  it('returns 401 when session is missing on mutating request', () => {
    const req  = makeReq({ sessionInfo: undefined });
    const next = vi.fn() as unknown as NextFunction;
    const { res, status, json } = makeRes();
    csrfMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('returns 403 when X-CSRF-Token header is missing', () => {
    const req  = makeReq({ headers: {} });
    const next = vi.fn() as unknown as NextFunction;
    const { res, status, json } = makeRes();
    csrfMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CSRF_INVALID' }));
  });

  it('returns 403 when X-CSRF-Token value is wrong', () => {
    const req  = makeReq({ headers: { 'x-csrf-token': 'wrong-token' } });
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();
    csrfMiddleware(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
  });

  it('calls next() when CSRF token is valid', () => {
    const req  = makeReq();
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    csrfMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('works for PUT and DELETE as well', () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const req  = makeReq({ method });
      const next = vi.fn() as unknown as NextFunction;
      const { res } = makeRes();
      csrfMiddleware(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });
});
