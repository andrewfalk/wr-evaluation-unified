// Auth router: rate limits, middleware and the route table.
// Split out of routes/auth.ts (S5 P1-32); handler bodies unchanged.
import { Router } from 'express';
import type { Pool } from 'pg';
import { createAuthMiddleware } from '../../middleware/auth';
import { csrfMiddleware } from '../../middleware/csrf';
import { loginRateLimit, csrfRateLimit, refreshRateLimit, signupRateLimit } from '../../middleware/rateLimit';
import { asyncHandler } from '../../http/asyncHandler';
import { login } from './login';
import { refresh, logout, me, csrfReissue } from './session';
import { changePassword } from './password';
import { createSignupRequest } from './signup';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAuthRouter(pool: Pool): Router {
  const router = Router();
  const auth   = createAuthMiddleware(pool);

  // Unauthenticated
  router.post('/login',   loginRateLimit(), asyncHandler((req, res) => login(pool, req, res)));
  router.post('/refresh', refreshRateLimit(), asyncHandler((req, res) => refresh(pool, req, res)));

  // /csrf is exempt from csrfMiddleware (wr_csrf cookie is missing when called).
  // Protected by: HttpOnly wr_refresh cookie (SameSite=Strict), Origin check
  // (CORS middleware), and rate limit below.
  router.post('/csrf', csrfRateLimit(), asyncHandler((req, res) => csrfReissue(pool, req, res)));

  // Requires valid access token + live DB session check
  router.get('/me', auth, asyncHandler((req, res) => me(pool, req, res)));

  // logout: cookie + manual CSRF check inside logout() itself (see comment there) —
  // deliberately NOT behind `auth`/`csrfMiddleware`, which require a live access token.
  router.post('/logout', asyncHandler((req, res) => logout(pool, req, res)));

  // change-password: auth + CSRF (mutating POST)
  router.post('/change-password', auth, csrfMiddleware, asyncHandler((req, res) => changePassword(pool, req, res)));

  // Public: no auth, no CSRF — protected only by rate limit.
  router.post('/signup-requests', signupRateLimit(), asyncHandler((req, res) => createSignupRequest(pool, req, res)));

  return router;
}
