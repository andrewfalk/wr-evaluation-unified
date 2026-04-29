import { describe, it, expect } from 'vitest';
import { createConfig } from '../config';

const BASE = {
  DATABASE_URL:         'postgresql://test',
  ACCESS_TOKEN_SECRET:  'access-secret',
  REFRESH_TOKEN_SECRET: 'refresh-secret',
} satisfies NodeJS.ProcessEnv;

function make(overrides: NodeJS.ProcessEnv = {}) {
  return createConfig({ ...BASE, ...overrides });
}

describe('config — deployment mode', () => {
  it('defaults to standalone', () => {
    const c = make();
    expect(c.deploymentMode).toBe('standalone');
    expect(c.localFallbackAllowed).toBe(true);
  });

  it('intranet mode disables local fallback', () => {
    const c = make({ DEPLOYMENT_MODE: 'intranet' });
    expect(c.deploymentMode).toBe('intranet');
    expect(c.localFallbackAllowed).toBe(false);
  });

  it('throws on unknown DEPLOYMENT_MODE', () => {
    expect(() => make({ DEPLOYMENT_MODE: 'cloud' })).toThrow(
      "DEPLOYMENT_MODE must be 'intranet' or 'standalone'"
    );
  });
});

describe('config — AI gate', () => {
  it('AI disabled by default (provider=none)', () => {
    const c = make();
    expect(c.ai.enabled).toBe(false);
    expect(c.ai.provider).toBe('none');
  });

  it('internal provider enables AI without approval flags', () => {
    const c = make({ AI_PROVIDER: 'internal' });
    expect(c.ai.enabled).toBe(true);
  });

  it('external: disabled when no flags set', () => {
    const c = make({ AI_PROVIDER: 'external' });
    expect(c.ai.enabled).toBe(false);
  });

  it('external: disabled when only vendor approved', () => {
    const c = make({ AI_PROVIDER: 'external', AI_EXTERNAL_VENDOR_APPROVED: 'true' });
    expect(c.ai.enabled).toBe(false);
  });

  it('external: enabled only when both flags are true', () => {
    const c = make({
      AI_PROVIDER:                  'external',
      AI_EXTERNAL_VENDOR_APPROVED:  'true',
      AI_DEIDENTIFY_REQUIRED:       'true',
    });
    expect(c.ai.enabled).toBe(true);
  });

  it('throws on unknown AI_PROVIDER', () => {
    expect(() => make({ AI_PROVIDER: 'openai' })).toThrow(
      "AI_PROVIDER must be 'none', 'internal', or 'external'"
    );
  });
});

describe('config — required env vars', () => {
  it('throws when DATABASE_URL is missing', () => {
    expect(() =>
      createConfig({ ACCESS_TOKEN_SECRET: 'a', REFRESH_TOKEN_SECRET: 'b' })
    ).toThrow('Missing required env var: DATABASE_URL');
  });

  it('throws when ACCESS_TOKEN_SECRET is missing', () => {
    expect(() =>
      createConfig({ DATABASE_URL: 'pg://x', REFRESH_TOKEN_SECRET: 'b' })
    ).toThrow('Missing required env var: ACCESS_TOKEN_SECRET');
  });
});

describe('config — auth TTLs', () => {
  it('uses defaults when not set', () => {
    const c = make();
    expect(c.auth.accessTokenTtl).toBe(15 * 60);
    expect(c.auth.refreshTokenTtl).toBe(7 * 24 * 60 * 60);
  });

  it('parses custom TTLs', () => {
    const c = make({ ACCESS_TOKEN_TTL: '300', REFRESH_TOKEN_TTL: '86400' });
    expect(c.auth.accessTokenTtl).toBe(300);
    expect(c.auth.refreshTokenTtl).toBe(86400);
  });
});

describe('config — CORS origins', () => {
  it('parses comma-separated origins', () => {
    const c = make({ CORS_ORIGINS: 'https://wr.hospital.local, https://wr2.hospital.local' });
    expect(c.cors.origins).toEqual([
      'https://wr.hospital.local',
      'https://wr2.hospital.local',
    ]);
  });

  it('returns empty array when CORS_ORIGINS is unset', () => {
    const c = make();
    expect(c.cors.origins).toEqual([]);
  });
});
