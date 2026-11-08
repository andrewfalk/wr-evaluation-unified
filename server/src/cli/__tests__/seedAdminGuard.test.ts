// Admin seed production guard (SEC-B L12): with NODE_ENV=production the seed refuses when an admin
// account already exists, unless --force.
import { describe, expect, it, vi } from 'vitest';
import { parseSeedAdminArgs, seedAdminRefusal } from '../seedAdminGuard';

const db = (adminRows: unknown[]) => ({ query: vi.fn().mockResolvedValue({ rows: adminRows }) });

describe('parseSeedAdminArgs', () => {
  it('accepts no flags or --force, rejects anything else', () => {
    expect(parseSeedAdminArgs([])).toEqual({ force: false });
    expect(parseSeedAdminArgs(['--force'])).toEqual({ force: true });
    expect(parseSeedAdminArgs(['--yes'])).toMatchObject({ error: expect.stringMatching(/unknown argument: --yes/) });
  });
});

describe('seedAdminRefusal', () => {
  it('production with an existing admin: refused (the message says "already exists" and how to override)', async () => {
    const d = db([{ '?column?': 1 }]);
    const refusal = await seedAdminRefusal(d, { nodeEnv: 'production', force: false });
    expect(refusal).toMatch(/already exists/);
    expect(refusal).toMatch(/--force/);
    expect(d.query).toHaveBeenCalledWith(expect.stringMatching(/FROM users WHERE role = 'admin'/));
  });

  it('production on an empty database (no admin): allowed', async () => {
    expect(await seedAdminRefusal(db([]), { nodeEnv: 'production', force: false })).toBeNull();
  });

  it('production with --force: allowed without asking the database', async () => {
    const d = db([{ '?column?': 1 }]);
    expect(await seedAdminRefusal(d, { nodeEnv: 'production', force: true })).toBeNull();
    expect(d.query).not.toHaveBeenCalled();
  });

  it('outside production: never refused', async () => {
    const d = db([{ '?column?': 1 }]);
    expect(await seedAdminRefusal(d, { nodeEnv: 'development', force: false })).toBeNull();
    expect(await seedAdminRefusal(d, { nodeEnv: undefined, force: false })).toBeNull();
    expect(d.query).not.toHaveBeenCalled();
  });
});
