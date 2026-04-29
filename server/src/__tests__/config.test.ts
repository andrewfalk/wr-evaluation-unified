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

  it('external: enabled when both flags + endpoint + key are set', () => {
    const c = make({
      AI_PROVIDER:                  'external',
      AI_EXTERNAL_VENDOR_APPROVED:  'true',
      AI_DEIDENTIFY_REQUIRED:       'true',
      AI_EXTERNAL_ENDPOINT:         'https://llm.hospital.local',
      AI_EXTERNAL_API_KEY:          'secret-key',
    });
    expect(c.ai.enabled).toBe(true);
    expect(c.ai.externalEndpoint).toBe('https://llm.hospital.local');
  });

  it('external: throws when endpoint is missing but flags are set', () => {
    expect(() => make({
      AI_PROVIDER:                 'external',
      AI_EXTERNAL_VENDOR_APPROVED: 'true',
      AI_DEIDENTIFY_REQUIRED:      'true',
    })).toThrow('AI_EXTERNAL_ENDPOINT is required');
  });

  it('external: throws when api key is missing but flags + endpoint are set', () => {
    expect(() => make({
      AI_PROVIDER:                 'external',
      AI_EXTERNAL_VENDOR_APPROVED: 'true',
      AI_DEIDENTIFY_REQUIRED:      'true',
      AI_EXTERNAL_ENDPOINT:        'https://llm.hospital.local',
    })).toThrow('AI_EXTERNAL_API_KEY is required');
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

  it('throws on non-integer TTL', () => {
    expect(() => make({ ACCESS_TOKEN_TTL: 'abc' })).toThrow(
      'ACCESS_TOKEN_TTL must be a positive integer'
    );
  });

  it('throws on zero TTL', () => {
    expect(() => make({ REFRESH_TOKEN_TTL: '0' })).toThrow(
      'REFRESH_TOKEN_TTL must be a positive integer'
    );
  });

  it('throws on negative TTL', () => {
    expect(() => make({ ACCESS_TOKEN_TTL: '-300' })).toThrow(
      'ACCESS_TOKEN_TTL must be a positive integer'
    );
  });
});

describe('config — PORT validation', () => {
  it('uses default port 3001', () => {
    expect(make().port).toBe(3001);
  });

  it('parses valid PORT', () => {
    expect(make({ PORT: '8080' }).port).toBe(8080);
  });

  it('throws on non-integer PORT', () => {
    expect(() => make({ PORT: 'abc' })).toThrow('PORT must be a positive integer');
  });

  it('throws on zero PORT', () => {
    expect(() => make({ PORT: '0' })).toThrow('PORT must be a positive integer');
  });
});

describe('config — NODE_ENV validation', () => {
  it('throws on unknown NODE_ENV', () => {
    expect(() => make({ NODE_ENV: 'staging' })).toThrow(
      "NODE_ENV must be 'development', 'production', or 'test'"
    );
  });

  it('accepts production', () => {
    expect(make({ NODE_ENV: 'production' }).env).toBe('production');
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
