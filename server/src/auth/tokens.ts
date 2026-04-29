import jwt from 'jsonwebtoken';
import config from '../config';

export interface AccessTokenPayload {
  sub:                string;   // userId
  sessionId:          string;
  orgId:              string | null;
  role:               string;
  name:               string;
  mustChangePassword: boolean;
  csrfHash:           string;   // SHA-256 hash of csrf token (for CSRF middleware)
}

export function generateAccessToken(payload: AccessTokenPayload): {
  token: string;
  expiresAt: Date;
} {
  const expiresAt = new Date(Date.now() + config.auth.accessTokenTtl * 1000);
  const token = jwt.sign(payload, config.auth.accessTokenSecret, {
    expiresIn: config.auth.accessTokenTtl,
  });
  return { token, expiresAt };
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    return jwt.verify(token, config.auth.accessTokenSecret) as AccessTokenPayload;
  } catch {
    return null;
  }
}
