import { describe, it, expect } from 'vitest';
import { verifyAccessToken } from '../../auth/tokens';
import { validateCsrf } from '../../auth/csrf';
import { makeAccessToken, authHeaders, TEST_CSRF_HASH, TEST_CSRF_TOKEN, TEST_ORG_ID, TEST_SESSION_ID, TEST_USER_ID } from '../tokens';
import { testConfig, deepMerge } from '../configMock';

describe('makeAccessToken / authHeaders', () => {
  it('defaults to a doctor in the test org with the test CSRF hash', () => {
    const payload = verifyAccessToken(makeAccessToken());
    expect(payload).toMatchObject({
      sub: TEST_USER_ID,
      sessionId: TEST_SESSION_ID,
      orgId: TEST_ORG_ID,
      role: 'doctor',
      mustChangePassword: false,
      csrfHash: TEST_CSRF_HASH,
    });
  });

  it('applies overrides, including a null org and a custom CSRF token', () => {
    const payload = verifyAccessToken(makeAccessToken({ role: 'admin', orgId: null, csrfToken: 'other' }));
    expect(payload?.role).toBe('admin');
    expect(payload?.orgId).toBeNull();
    expect(validateCsrf('other', payload!.csrfHash)).toBe(true);
    expect(validateCsrf(TEST_CSRF_TOKEN, payload!.csrfHash)).toBe(false);
  });

  it('authHeaders carries the bearer token and the CSRF header', () => {
    expect(authHeaders('tok')).toEqual({ Authorization: 'Bearer tok', 'x-csrf-token': TEST_CSRF_TOKEN });
    expect(authHeaders('tok', 'c')['x-csrf-token']).toBe('c');
  });
});

describe('testConfig', () => {
  it('has the shared shape the route tests copy today', () => {
    expect(testConfig()).toEqual({
      env: 'test',
      cors: { origins: [] },
      auth: { accessTokenTtl: 900, accessTokenSecret: 'test-access-secret', refreshTokenSecret: 'test-refresh-secret' },
      lockEnforcementMode: 'off',
    });
  });

  it('deep-merges overrides without dropping sibling keys', () => {
    const cfg = testConfig({ lockEnforcementMode: 'enforce', auth: { accessTokenTtl: 60 } });
    expect(cfg.lockEnforcementMode).toBe('enforce');
    expect(cfg.auth).toEqual({ accessTokenTtl: 60, accessTokenSecret: 'test-access-secret', refreshTokenSecret: 'test-refresh-secret' });
  });

  it('replaces arrays wholesale and ignores undefined values', () => {
    expect(deepMerge({ a: [1, 2], b: 1 }, { a: [3], b: undefined })).toEqual({ a: [3], b: 1 });
  });

  it('returns a fresh object every call (overrides do not leak between tests)', () => {
    const a = testConfig({ auth: { accessTokenTtl: 1 } });
    const b = testConfig();
    expect((a.auth as { accessTokenTtl: number }).accessTokenTtl).toBe(1);
    expect((b.auth as { accessTokenTtl: number }).accessTokenTtl).toBe(900);
  });
});
