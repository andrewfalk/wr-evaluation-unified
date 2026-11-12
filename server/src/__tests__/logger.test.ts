// S11: the logger reads only LOG_LEVEL / NODE_ENV — not the whole config — so modules a CLI reaches without the
// server's required settings (db/client.ts, db/migrate.ts) can import it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLogLevel } from '../config/schema';

afterEach(() => {
  vi.doUnmock('../config');
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('logger', () => {
  it('importing it (and db/client, db/migrate) does not load the config', async () => {
    vi.resetModules();
    vi.doMock('../config', () => { throw new Error('the config must not be loaded'); });
    const { logger } = await import('../logger.js');
    await import('../db/client.js');
    await import('../db/migrate.js');
    expect(typeof logger.info).toBe('function');
  });

  it('takes its level from LOG_LEVEL', async () => {
    vi.resetModules();
    vi.stubEnv('LOG_LEVEL', 'warn');
    const { logger } = await import('../logger.js');
    expect(logger.level).toBe('warn');
  });
});

describe('resolveLogLevel', () => {
  it('defaults by NODE_ENV and rejects an unknown level', () => {
    expect(resolveLogLevel({})).toBe('info');
    expect(resolveLogLevel({ NODE_ENV: 'test' })).toBe('silent');
    expect(resolveLogLevel({ NODE_ENV: 'production', LOG_LEVEL: 'debug' })).toBe('debug');
    expect(() => resolveLogLevel({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL must be one of/);
  });
});
