import os from 'os';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { createConfig } from '../config';

const BASE = {
  DATABASE_URL:         'postgresql://test',
  ACCESS_TOKEN_SECRET:  'access-secret-0123456789abcdef0123',
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
    const c = make({ DEPLOYMENT_MODE: 'intranet', CORS_ORIGINS: 'https://wr.hospital.local:8443' });
    expect(c.deploymentMode).toBe('intranet');
    expect(c.localFallbackAllowed).toBe(false);
  });

  it('trusts one proxy hop by default in intranet mode', () => {
    const c = make({ DEPLOYMENT_MODE: 'intranet', CORS_ORIGINS: 'https://wr.hospital.local:8443' });
    expect(c.trustProxy).toBe(1);
  });

  it('does not trust proxy headers by default in standalone mode', () => {
    const c = make();
    expect(c.trustProxy).toBe(false);
  });

  it('allows TRUST_PROXY override', () => {
    expect(make({ TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(make({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(make({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
  });

  it('throws on invalid TRUST_PROXY', () => {
    expect(() => make({ TRUST_PROXY: 'sideways' })).toThrow('TRUST_PROXY must be');
  });

  it('throws on unknown DEPLOYMENT_MODE', () => {
    expect(() => make({ DEPLOYMENT_MODE: 'cloud' })).toThrow(
      "DEPLOYMENT_MODE must be 'intranet' or 'standalone'"
    );
  });
});

describe('config — statsWorkbenchEnabled (PR0-A)', () => {
  it('defaults to false', () => {
    expect(make().statsWorkbenchEnabled).toBe(false);
  });

  it('enables via STATS_WORKBENCH_ENABLED=true', () => {
    expect(make({ STATS_WORKBENCH_ENABLED: 'true' }).statsWorkbenchEnabled).toBe(true);
  });
});

describe('config — AI gate', () => {
  it('AI disabled by default (provider=none)', () => {
    const c = make();
    expect(c.ai.enabled).toBe(false);
    expect(c.ai.provider).toBe('none');
  });

  it('AI_TIMEOUT_MS defaults to 60000 and can be overridden', () => {
    expect(make().ai.timeoutMs).toBe(60000);
    expect(make({ AI_TIMEOUT_MS: '15000' }).ai.timeoutMs).toBe(15000);
  });

  it.each(['0', '-1', '1.5', 'abc'])('AI_TIMEOUT_MS=%s is rejected', (value) => {
    expect(() => make({ AI_TIMEOUT_MS: value })).toThrow(/AI_TIMEOUT_MS/);
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
      createConfig({ ACCESS_TOKEN_SECRET: 'access-secret-0123456789abcdef0123' })
    ).toThrow('Missing required env var: DATABASE_URL');
  });

  it('throws when ACCESS_TOKEN_SECRET is missing', () => {
    expect(() =>
      createConfig({ DATABASE_URL: 'pg://x' })
    ).toThrow('Missing required env var: ACCESS_TOKEN_SECRET');
  });

  // SEC-A L5 — HS256 key length.
  it('throws when ACCESS_TOKEN_SECRET is shorter than 32 bytes', () => {
    expect(() => createConfig({ DATABASE_URL: 'pg://x', ACCESS_TOKEN_SECRET: 'x'.repeat(31) }))
      .toThrow('ACCESS_TOKEN_SECRET must be at least 32 bytes (generate with: openssl rand -hex 32)');
    expect(createConfig({ DATABASE_URL: 'pg://x', ACCESS_TOKEN_SECRET: 'x'.repeat(32) }).auth.accessTokenSecret).toHaveLength(32);
  });

  it('counts bytes, not characters (multi-byte secrets)', () => {
    expect(() => createConfig({ DATABASE_URL: 'pg://x', ACCESS_TOKEN_SECRET: '가'.repeat(10) })).toThrow(/at least 32 bytes/); // 30 bytes
    expect(createConfig({ DATABASE_URL: 'pg://x', ACCESS_TOKEN_SECRET: '가'.repeat(11) }).auth.accessTokenSecret).toBe('가'.repeat(11)); // 33 bytes
  });

  it('no longer needs REFRESH_TOKEN_SECRET, and ignores one left in an existing .env', () => {
    const c = createConfig({ DATABASE_URL: 'pg://x', ACCESS_TOKEN_SECRET: 'x'.repeat(32), REFRESH_TOKEN_SECRET: 'old' });
    expect(c.auth).not.toHaveProperty('refreshTokenSecret');
  });
});

describe('config — auth TTLs', () => {
  it('uses defaults when not set', () => {
    const c = make();
    expect(c.auth.accessTokenTtl).toBe(15 * 60);
    // SEC-B M3: idle 24 hours (was 7 days), absolute 12 hours.
    expect(c.auth.refreshTokenTtl).toBe(24 * 60 * 60);
    expect(c.auth.sessionAbsoluteTtl).toBe(12 * 60 * 60);
  });

  it('parses custom TTLs', () => {
    const c = make({ ACCESS_TOKEN_TTL: '300', REFRESH_TOKEN_TTL: '604800', SESSION_ABSOLUTE_TTL: '28800' });
    expect(c.auth.accessTokenTtl).toBe(300);
    expect(c.auth.refreshTokenTtl).toBe(604800); // an explicit 7-day value in an existing .env is kept
    expect(c.auth.sessionAbsoluteTtl).toBe(28800);
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

  it('accepts production when CORS_ORIGINS is provided', () => {
    expect(make({ NODE_ENV: 'production', CORS_ORIGINS: 'https://wr.hospital.local:8443' }).env).toBe('production');
  });
});

describe('config — video.poseTier (6.0-14)', () => {
  it('defaults to standard — env 미설정 배포에서 동작 변화 0', () => {
    expect(make().video.poseTier).toBe('standard');
  });

  it('accepts auto (GPU 서버에서 l 자동 사용 opt-in)', () => {
    expect(make({ VIDEO_POSE_TIER: 'auto' }).video.poseTier).toBe('auto');
  });

  it("rejects 'high' — dev CLI 전용, 운영 env에선 조용한 강등 없이 기동 실패", () => {
    expect(() => make({ VIDEO_POSE_TIER: 'high' })).toThrow(/VIDEO_POSE_TIER/);
  });

  it('rejects unknown values (오타도 fail-fast)', () => {
    expect(() => make({ VIDEO_POSE_TIER: 'ultra' })).toThrow(/VIDEO_POSE_TIER/);
  });
});

describe('config — video.detIntervalSec (6.0-15)', () => {
  it('defaults to 0 — env 미설정 배포에서 동작 변화 0(매 프레임 det)', () => {
    expect(make().video.detIntervalSec).toBe(0);
  });

  it('accepts values in (0, 1.0] (det 빈도 감소 opt-in)', () => {
    expect(make({ VIDEO_DET_INTERVAL_SEC: '0.5' }).video.detIntervalSec).toBe(0.5);
    expect(make({ VIDEO_DET_INTERVAL_SEC: '1' }).video.detIntervalSec).toBe(1);
  });

  it('rejects >1.0 — target 매핑 ±500ms 창 이탈 위험은 조용한 수용 없이 기동 실패', () => {
    expect(() => make({ VIDEO_DET_INTERVAL_SEC: '1.5' })).toThrow(/VIDEO_DET_INTERVAL_SEC/);
  });

  it('rejects negative and non-numeric (fail-fast)', () => {
    expect(() => make({ VIDEO_DET_INTERVAL_SEC: '-1' })).toThrow(/VIDEO_DET_INTERVAL_SEC/);
    expect(() => make({ VIDEO_DET_INTERVAL_SEC: 'fast' })).toThrow(/VIDEO_DET_INTERVAL_SEC/);
  });
});

describe('config — CORS origins', () => {
  it('parses comma-separated origins', () => {
    const c = make({ CORS_ORIGINS: 'https://wr.hospital.local:8443, https://wr2.hospital.local:8443' });
    expect(c.cors.origins).toEqual([
      'https://wr.hospital.local:8443',
      'https://wr2.hospital.local:8443',
    ]);
  });

  it('returns empty array when CORS_ORIGINS is unset (development)', () => {
    const c = make({ NODE_ENV: 'development' });
    expect(c.cors.origins).toEqual([]);
  });

  it('throws when CORS_ORIGINS is empty in production', () => {
    expect(() => make({ NODE_ENV: 'production' })).toThrow(
      'CORS_ORIGINS must be set'
    );
  });

  it('throws when CORS_ORIGINS is empty in intranet mode', () => {
    expect(() => make({ DEPLOYMENT_MODE: 'intranet' })).toThrow(
      'CORS_ORIGINS must be set'
    );
  });

  it('does not throw in intranet mode when CORS_ORIGINS is provided', () => {
    expect(() => make({
      DEPLOYMENT_MODE: 'intranet',
      CORS_ORIGINS:    'https://wr.hospital.local:8443',
    })).not.toThrow();
  });
});

describe('config — LOG_LEVEL (P1-01)', () => {
  it('defaults to info outside tests and silent under NODE_ENV=test', () => {
    expect(make({ NODE_ENV: 'development' }).log.level).toBe('info');
    expect(make({ NODE_ENV: 'production', CORS_ORIGINS: 'https://wr.hospital.local:8443' }).log.level).toBe('info');
    expect(make({ NODE_ENV: 'test' }).log.level).toBe('silent');
  });

  it('accepts an explicit pino level', () => {
    expect(make({ LOG_LEVEL: 'debug' }).log.level).toBe('debug');
  });

  it('throws on an unknown level', () => {
    expect(() => make({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });
});

describe('config — default tool paths do not depend on the working directory (P1-09)', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');

  it('resolves services/ from the repository root wherever the server was started', () => {
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(path.join(os.tmpdir(), 'somewhere-else'));
    try {
      const c = make();
      expect(c.video.scriptsDir).toBe(path.join(repoRoot, 'services', 'pose-inference'));
      expect(c.video.fixtureDir).toBe(path.join(repoRoot, 'services', 'pose-inference', 'samples'));
      expect(c.stats.scriptsDir).toBe(path.join(repoRoot, 'services', 'stats-engine'));
      expect(c.stats.python.startsWith(path.join(repoRoot, 'services', 'stats-engine', '.venv'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('still prefers the env paths (production/containers)', () => {
    const c = make({ VIDEO_ANALYSIS_SCRIPTS_DIR: '/opt/pose', STATS_ENGINE_SCRIPTS_DIR: '/opt/stats', STATS_ENGINE_PYTHON: '/opt/stats-venv/bin/python' });
    expect(c.video.scriptsDir).toBe('/opt/pose');
    expect(c.stats.scriptsDir).toBe('/opt/stats');
    expect(c.stats.python).toBe('/opt/stats-venv/bin/python');
  });
});

describe('config — keys added by S2 for former process.env readers (P1-09)', () => {
  it('gitCommit: WR_GIT_COMMIT or "unknown"', () => {
    expect(make().gitCommit).toBe('unknown');
    expect(make({ WR_GIT_COMMIT: '' }).gitCommit).toBe('unknown');
    expect(make({ WR_GIT_COMMIT: 'abc1234' }).gitCommit).toBe('abc1234');
  });

  it('backupsDir: BACKUPS_DIR ?? "/backups" (an empty value stays empty, as opsStatus read it)', () => {
    expect(make().backupsDir).toBe('/backups');
    expect(make({ BACKUPS_DIR: '' }).backupsDir).toBe('');
    expect(make({ BACKUPS_DIR: '/mnt/backups' }).backupsDir).toBe('/mnt/backups');
  });

  it('updatesDir: UPDATES_DIR or "/app/updates"', () => {
    expect(make().updatesDir).toBe('/app/updates');
    expect(make({ UPDATES_DIR: '' }).updatesDir).toBe('/app/updates');
    expect(make({ UPDATES_DIR: '/srv/updates' }).updatesDir).toBe('/srv/updates');
  });

  it('queueNamespace (S8): QUEUE_NAMESPACE or "default"; anything else than a short lowercase name fails at start-up', () => {
    expect(make().queueNamespace).toBe('default');
    expect(make({ QUEUE_NAMESPACE: '' }).queueNamespace).toBe('default');
    expect(make({ QUEUE_NAMESPACE: 'dev-pc1-1a2b3c4d' }).queueNamespace).toBe('dev-pc1-1a2b3c4d');
    expect(make({ QUEUE_NAMESPACE: 'itest' }).queueNamespace).toBe('itest');
    for (const bad of ['Dev', '-x', 'a b', 'x'.repeat(65), "x';--"]) {
      expect(() => make({ QUEUE_NAMESPACE: bad })).toThrow(/QUEUE_NAMESPACE/);
    }
  });

  it('stats.timingEnabled: only STATS_ENGINE_TIMING=1', () => {
    expect(make().stats.timingEnabled).toBe(false);
    expect(make({ STATS_ENGINE_TIMING: 'true' }).stats.timingEnabled).toBe(false);
    expect(make({ STATS_ENGINE_TIMING: '0' }).stats.timingEnabled).toBe(false);
    expect(make({ STATS_ENGINE_TIMING: '1' }).stats.timingEnabled).toBe(true);
  });
});
