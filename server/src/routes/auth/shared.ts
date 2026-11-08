// Auth route helpers: refresh/CSRF cookie handling and the user payload.
// Split out of routes/auth.ts (S5 P1-32); handler bodies unchanged.
import type { Response } from 'express';
import config from '../../config';
import { clearCsrfCookie } from '../../auth/csrf';

export const REFRESH_COOKIE = 'wr_refresh';

export const isSecure = config.env === 'production';

export interface AuthUserRow {
  user_id: string;
  role: string;
  name: string;
  organization_id: string | null;
  must_change_password: boolean;
  disabled_at: string | null;
}

export function toUserPayload(user: {
  user_id: string;
  name: string;
  role: string;
  organization_id: string | null;
  must_change_password: boolean;
}) {
  return {
    id:                 user.user_id,
    name:               user.name,
    role:               user.role,
    organizationId:     user.organization_id,
    mustChangePassword: user.must_change_password,
  };
}

export function setRefreshCookie(res: Response, rawToken: string, expiresAt: Date, persistentCookie: boolean): void {
  res.cookie(REFRESH_COOKIE, rawToken, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'strict',
    path: '/',
    // Electron logins (rememberMe=false) get a session cookie (no expires) so
    // the app forces re-login whenever a new Electron session starts.
    ...(persistentCookie ? { expires: expiresAt } : {}),
  });
}

export function clearAuthCookies(res: Response): void {
  const opts = { httpOnly: true, secure: isSecure, sameSite: 'strict' as const, path: '/', maxAge: 0 };
  res.cookie(REFRESH_COOKIE, '', opts);
  clearCsrfCookie(res, isSecure);
}
