import type { Request, Response, NextFunction } from 'express';
import { CSRF_HEADER, validateCsrf } from '../auth/csrf';

const SAFE_METHODS  = new Set(['GET', 'HEAD', 'OPTIONS']);

// 모든 변경 요청이 이 검사를 통과해야 한다. POST /api/auth/csrf는 CSRF 쿠키가 없을 때 부르는 경로라
// 이 미들웨어를 아예 달지 않는다(routes/auth.ts) — 예전의 EXEMPT_PATHS는 라우터 안에서 req.path가
// 마운트 경로를 뺀 상대 경로라 '/api/auth/csrf'와 절대 일치하지 않는 죽은 코드였고, 쓰는 척하는 예외
// 목록은 나중에 잘못된 확신을 주므로 제거했다.
export function csrfMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  // sessionInfo is attached by the auth middleware (T11).
  // If it is absent here, auth failed before CSRF — return 401.
  const session = req.sessionInfo;
  if (!session) {
    res.status(401).json({ code: 'UNAUTHORIZED', error: 'Authentication required' });
    return;
  }

  if (!validateCsrf(req.headers[CSRF_HEADER], session.csrfTokenHash)) {
    res.status(403).json({ code: 'CSRF_INVALID', error: 'Invalid or missing CSRF token' });
    return;
  }

  next();
}
