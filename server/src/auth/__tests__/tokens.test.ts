import { describe, it, expect } from 'vitest';
import { generateAccessToken, verifyAccessToken, type AccessTokenPayload } from '../tokens';

const BASE: AccessTokenPayload = {
  sub:                'user-1',
  sessionId:          'sess-1',
  orgId:              'org-1',
  role:               'doctor',
  name:               'Dr. Kim',
  mustChangePassword: false,
  csrfHash:           'abc123hash',
};

describe('generateAccessToken / verifyAccessToken', () => {
  it('round-trips all payload fields', () => {
    const { token } = generateAccessToken(BASE);
    const decoded = verifyAccessToken(token);

    expect(decoded).not.toBeNull();
    expect(decoded!.sub).toBe(BASE.sub);
    expect(decoded!.sessionId).toBe(BASE.sessionId);
    expect(decoded!.orgId).toBe(BASE.orgId);
    expect(decoded!.role).toBe(BASE.role);
    expect(decoded!.name).toBe(BASE.name);
    expect(decoded!.mustChangePassword).toBe(BASE.mustChangePassword);
    expect(decoded!.csrfHash).toBe(BASE.csrfHash);
  });

  it('returns an expiresAt in the future', () => {
    const { expiresAt } = generateAccessToken(BASE);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns null for a tampered token', () => {
    const { token } = generateAccessToken(BASE);
    const [h, p, s] = token.split('.');
    const tampered = `${h}.${p}.${s}xx`;
    expect(verifyAccessToken(tampered)).toBeNull();
  });

  it('returns null for an arbitrary string', () => {
    expect(verifyAccessToken('not.a.token')).toBeNull();
  });

  it('different payloads produce different tokens', () => {
    const t1 = generateAccessToken({ ...BASE, sub: 'user-1' }).token;
    const t2 = generateAccessToken({ ...BASE, sub: 'user-2' }).token;
    expect(t1).not.toBe(t2);
  });

  it('handles null orgId', () => {
    const { token } = generateAccessToken({ ...BASE, orgId: null });
    const decoded = verifyAccessToken(token);
    expect(decoded!.orgId).toBeNull();
  });
});
