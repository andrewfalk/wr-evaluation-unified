import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { LocalDbAuthProvider } from '../LocalDbAuthProvider';
import bcrypt from 'bcrypt';

function makePool(rows: unknown[]): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool;
}

// bcrypt.hash at module level: use a pre-computed hash (cost 4) to keep tests fast
// Generated with: bcrypt.hash('correct-password', 4)
const HASHED_PASS = '$2b$04$yD1h8iMKEXEK.m/wFBndFeIjQdx7fCnmpe6Js7O.6YaMYAR/hWuKK';

describe('LocalDbAuthProvider.verifyCredentials', () => {
  it('returns null when user is not found', async () => {
    const pool = makePool([]);
    const provider = new LocalDbAuthProvider(pool);
    const result = await provider.verifyCredentials('unknown', 'pass');
    expect(result).toBeNull();
  });

  it('returns null when user is disabled', async () => {
    const pool = makePool([{
      id: 'u1', password_hash: HASHED_PASS, organization_id: 'org1',
      role: 'doctor', name: 'Dr. Kim', must_change_password: false,
      disabled_at: '2025-01-01T00:00:00Z',
    }]);
    const provider = new LocalDbAuthProvider(pool);
    const result = await provider.verifyCredentials('doctor1', 'correct-password');
    expect(result).toBeNull();
  });

  it('returns null when password is wrong', async () => {
    const pool = makePool([{
      id: 'u1', password_hash: HASHED_PASS, organization_id: 'org1',
      role: 'doctor', name: 'Dr. Kim', must_change_password: false,
      disabled_at: null,
    }]);
    const provider = new LocalDbAuthProvider(pool);
    const result = await provider.verifyCredentials('doctor1', 'wrong-password');
    expect(result).toBeNull();
  });

  it('returns credentials when login id + password are correct', async () => {
    const pool = makePool([{
      id: 'u1', password_hash: HASHED_PASS, organization_id: 'org1',
      role: 'doctor', name: 'Dr. Kim', must_change_password: false,
      disabled_at: null,
    }]);
    const provider = new LocalDbAuthProvider(pool);
    const result = await provider.verifyCredentials('doctor1', 'correct-password');

    expect(result).toEqual({
      userId:             'u1',
      organizationId:     'org1',
      role:               'doctor',
      name:               'Dr. Kim',
      mustChangePassword: false,
    });
  });

  it('returns mustChangePassword=true when flag is set', async () => {
    const pool = makePool([{
      id: 'u1', password_hash: HASHED_PASS, organization_id: null,
      role: 'admin', name: 'Admin', must_change_password: true,
      disabled_at: null,
    }]);
    const provider = new LocalDbAuthProvider(pool);
    const result = await provider.verifyCredentials('admin', 'correct-password');
    expect(result?.mustChangePassword).toBe(true);
    expect(result?.organizationId).toBeNull();
  });

  it('queries by login_id (not name or id)', async () => {
    const pool = makePool([]);
    const provider = new LocalDbAuthProvider(pool);
    await provider.verifyCredentials('mylogin', 'pass');

    const [_sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('mylogin');
  });
});
