import { describe, it, expect, vi } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
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

function makeReq(authorization?: string, baseUrl = '/api/patients', path = '/'): Request {
  return { headers: { authorization }, baseUrl, path } as unknown as Request;
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

  // HF2(M1): 임시 비밀번호(생성·초기화·가입 승인 직후)로 로그인한 계정은 비밀번호를 바꾸기 전까지
  // /api/auth/me 와 /api/auth/change-password 외에는 쓸 수 없다. 클라이언트 모달만으로는 토큰으로 직접 API를 부르는 걸 못 막는다.
  describe('mustChangePassword 강제', () => {
    const FORCED: AccessTokenPayload = { ...BASE, mustChangePassword: true };

    async function run(payload: AccessTokenPayload, baseUrl: string, path: string, rows: unknown[] = [{ exists: 1 }]) {
      const { token } = generateAccessToken(payload);
      const next = vi.fn() as unknown as NextFunction;
      const { res, status, json } = makeRes();
      await createAuthMiddleware(makePool(rows))(makeReq(`Bearer ${token}`, baseUrl, path), res, next);
      return { next, status, json };
    }

    it('플래그가 켜진 계정은 일반 API에서 403 PASSWORD_CHANGE_REQUIRED', async () => {
      const { next, status, json } = await run(FORCED, '/api/patients', '/abc');
      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PASSWORD_CHANGE_REQUIRED' }));
      expect(next).not.toHaveBeenCalled();
    });

    it.each([
      ['/api/auth', '/change-password'],
      ['/api/auth', '/me'],
      ['/api/auth', '/me/'], // 끝 슬래시도 Express는 같은 라우트로 매칭한다
    ])('플래그가 켜져 있어도 %s%s 는 통과한다', async (baseUrl, path) => {
      const { next, status } = await run(FORCED, baseUrl, path);
      expect(next).toHaveBeenCalledOnce();
      expect(status).not.toHaveBeenCalled();
    });

    it.each([
      ['/api/auth', '/change-password/extra'],
      ['/api/auth', '/me-evil'],
      ['/api/admin', '/me'],
      ['/api/patients', '/api/auth/me'],
    ])('예외는 정확히 일치하는 경로만 — %s%s 는 403', async (baseUrl, path) => {
      const { next, status } = await run(FORCED, baseUrl, path);
      expect(status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('플래그가 꺼진 계정은 일반 API를 그대로 쓴다', async () => {
      const { next, status } = await run(BASE, '/api/patients', '/abc');
      expect(next).toHaveBeenCalledOnce();
      expect(status).not.toHaveBeenCalled();
    });

    it('인증 실패가 먼저다 — 폐기된 세션은 플래그와 무관하게 403이 아니라 401', async () => {
      const { status, json } = await run(FORCED, '/api/patients', '/abc', []);
      expect(status).toHaveBeenCalledWith(401);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_REVOKED' }));
    });

    it('라우터에 마운트된 실제 Express에서 req.baseUrl + req.path로 판정된다(상대 경로 가정 검증)', async () => {
      const { token } = generateAccessToken(FORCED);
      const auth = createAuthMiddleware(makePool([{ exists: 1 }]));
      const authRouter = Router();
      authRouter.get('/me', auth, (_req, res) => { res.json({ ok: 'me' }); });
      authRouter.post('/change-password', auth, (_req, res) => { res.json({ ok: 'change' }); });
      authRouter.post('/logout', (_req, res) => { res.json({ ok: 'logout' }); }); // auth 미들웨어를 거치지 않는 경로
      const dataRouter = Router();
      dataRouter.get('/list', auth, (_req, res) => { res.json({ ok: 'list' }); });
      const app = express();
      app.use('/api/auth', authRouter);
      app.use('/api/patients', dataRouter);

      const bearer = { Authorization: `Bearer ${token}` };
      expect((await request(app).get('/api/auth/me').set(bearer)).status).toBe(200);
      expect((await request(app).post('/api/auth/change-password').set(bearer)).status).toBe(200);
      expect((await request(app).post('/api/auth/logout')).status).toBe(200);
      const blocked = await request(app).get('/api/patients/list').set(bearer);
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    });
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
