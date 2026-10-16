import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { verifyAccessToken } from '../auth/tokens';

// 임시 비밀번호(관리자 생성·초기화·가입 승인 직후)로 로그인한 계정은 비밀번호를 바꾸기 전까지 이 두 경로만
// 쓸 수 있다. 클라이언트 모달(App.jsx)은 화면만 막을 뿐이라, 서버가 강제하지 않으면 발급받은 토큰으로
// 모든 API를 직접 호출할 수 있다. mustChangePassword 클레임은 로그인·refresh·csrf·change-password가 모두
// DB 값으로 발급하고, 관리자 초기화는 해당 사용자의 모든 세션을 무효화하므로 JWT 클레임이 권위 있는 값이다.
// 이 미들웨어는 라우터 안에서 실행되어 req.path가 마운트 경로를 뺀 상대 경로다 → baseUrl과 합쳐 판정한다.
// /logout·/csrf·/refresh는 이 미들웨어를 거치지 않으므로(쿠키 기반) 예외 목록에 필요 없다.
const PASSWORD_CHANGE_EXEMPT_PATHS = new Set(['/api/auth/me', '/api/auth/change-password']);

function isPasswordChangeExempt(req: Request): boolean {
  const path = `${req.baseUrl ?? ''}${req.path ?? ''}`.replace(/\/+$/, '');
  return PASSWORD_CHANGE_EXEMPT_PATHS.has(path);
}

// authMiddleware checks both JWT validity AND live session status in the DB.
// A small DB read per request is acceptable on a hospital intranet (<100 concurrent
// users) and ensures logout / password-change revocation is immediate.
export function createAuthMiddleware(pool: Pool): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ code: 'UNAUTHORIZED', error: 'Bearer token required' });
      return;
    }

    const payload = verifyAccessToken(authHeader.slice(7));
    if (!payload) {
      res.status(401).json({ code: 'TOKEN_INVALID', error: 'Invalid or expired access token' });
      return;
    }

    // Verify the session is still alive (not invalidated by logout / password change).
    // Also confirms user_id matches the token subject as defence-in-depth.
    // Note: revoked_at (rotation grace) is intentionally NOT checked here — the
    // access token remains valid until its own JWT expiry after a normal refresh.
    let rows: { disabled_at: string | null }[];
    try {
      ({ rows } = await pool.query<{ disabled_at: string | null }>(
        `SELECT u.disabled_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id = $1
           AND s.user_id = $2
           AND s.invalidated_at IS NULL
           AND s.expires_at > now()`,
        [payload.sessionId, payload.sub]
      ));
    } catch (err) {
      next(err);
      return;
    }

    if (rows.length === 0) {
      res.status(401).json({ code: 'SESSION_REVOKED', error: 'Session has been revoked or expired' });
      return;
    }

    if (rows[0].disabled_at != null) {
      res.status(401).json({ code: 'USER_DISABLED', error: 'User account is disabled' });
      return;
    }

    if (payload.mustChangePassword && !isPasswordChangeExempt(req)) {
      res.status(403).json({ code: 'PASSWORD_CHANGE_REQUIRED', error: 'Password change required before using this API' });
      return;
    }

    req.sessionInfo = {
      sessionId:          payload.sessionId,
      userId:             payload.sub,
      csrfTokenHash:      payload.csrfHash,
      organizationId:     payload.orgId,
      role:               payload.role,
      name:               payload.name,
      mustChangePassword: payload.mustChangePassword,
    };

    next();
  };
}
