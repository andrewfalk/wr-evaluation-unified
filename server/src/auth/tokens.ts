import jwt from 'jsonwebtoken';
import config from '../config';

// The one signing algorithm (REFACTORING_ROADMAP SEC-A / L5): sign and verify name it explicitly.
const JWT_ALGORITHM = 'HS256';

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
    algorithm: JWT_ALGORITHM,
    expiresIn: config.auth.accessTokenTtl,
  });
  return { token, expiresAt };
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    // Only HS256 — a token signed with any other algorithm (or `none`) is rejected (SEC-A L5).
    return jwt.verify(token, config.auth.accessTokenSecret, { algorithms: [JWT_ALGORITHM] }) as AccessTokenPayload;
  } catch {
    return null;
  }
}
