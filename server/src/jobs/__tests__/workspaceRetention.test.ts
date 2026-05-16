import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { runWorkspaceRetention } from '../workspaceRetention';

function makePool(): Pool {
  return { query: vi.fn() } as unknown as Pool;
}

describe('runWorkspaceRetention', () => {
  it('deletes workspaces older than 5 years by default', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rowCount: 3 });

    const result = await runWorkspaceRetention(pool);

    expect(result.deleted).toBe(3);
    const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM workspaces');
    expect(params[0]).toBe(5);
  });

  it('respects a custom retention window', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rowCount: 1 });

    await runWorkspaceRetention(pool, 10);

    const [, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(10);
  });

  it('returns 0 when no workspaces are old enough', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rowCount: 0 });

    const result = await runWorkspaceRetention(pool);
    expect(result.deleted).toBe(0);
  });

  it('handles null rowCount gracefully', async () => {
    const pool = makePool();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rowCount: null });

    const result = await runWorkspaceRetention(pool);
    expect(result.deleted).toBe(0);
  });

  it('throws on invalid retentionYears (0, negative, non-integer)', async () => {
    const pool = makePool();
    await expect(runWorkspaceRetention(pool, 0)).rejects.toThrow('retentionYears must be a positive integer');
    await expect(runWorkspaceRetention(pool, -1)).rejects.toThrow('retentionYears must be a positive integer');
    await expect(runWorkspaceRetention(pool, 1.5)).rejects.toThrow('retentionYears must be a positive integer');
    // DB should never have been called
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
