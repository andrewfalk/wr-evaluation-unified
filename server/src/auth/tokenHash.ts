import crypto from 'crypto';

// Split out of sessionStore.ts so csrf.ts (validateCsrf) can be imported back
// into sessionStore.ts (revokeSessionFamily needs it) without a circular
// import — sessionStore.ts re-exports these for existing callers.
export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
