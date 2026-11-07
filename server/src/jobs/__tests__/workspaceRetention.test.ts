import { describe, it, expect } from 'vitest';
import { runWorkspaceRetention } from '../workspaceRetention';
import { createFakePool, sequenceHandler, type FakePool, type FakeQueryReply } from '../../testing/fakePool';

// 기존 mockResolvedValueOnce 큐(호출 순서) → sequenceHandler. 응답이 없으면 어떤 쿼리도 받지 않는다.
function retentionFake(responses: FakeQueryReply[] = []): FakePool {
  return createFakePool({ handlers: [sequenceHandler(responses)] });
}

describe('runWorkspaceRetention', () => {
  it('deletes workspaces older than 5 years by default', async () => {
    const fake = retentionFake([{ rowCount: 3 }]);

    const result = await runWorkspaceRetention(fake.pool);

    expect(result.deleted).toBe(3);
    const { sql, params } = fake.calls[0]!;
    expect(sql).toContain('DELETE FROM workspaces');
    expect(params[0]).toBe(5);
  });

  it('respects a custom retention window', async () => {
    const fake = retentionFake([{ rowCount: 1 }]);

    await runWorkspaceRetention(fake.pool, 10);

    const { params } = fake.calls[0]!;
    expect(params[0]).toBe(10);
  });

  it('returns 0 when no workspaces are old enough', async () => {
    const fake = retentionFake([{ rowCount: 0 }]);

    const result = await runWorkspaceRetention(fake.pool);
    expect(result.deleted).toBe(0);
  });

  it('handles null rowCount gracefully', async () => {
    const fake = retentionFake([{ rowCount: null }]);

    const result = await runWorkspaceRetention(fake.pool);
    expect(result.deleted).toBe(0);
  });

  it('throws on invalid retentionYears (0, negative, non-integer)', async () => {
    const fake = retentionFake();
    await expect(runWorkspaceRetention(fake.pool, 0)).rejects.toThrow('retentionYears must be a positive integer');
    await expect(runWorkspaceRetention(fake.pool, -1)).rejects.toThrow('retentionYears must be a positive integer');
    await expect(runWorkspaceRetention(fake.pool, 1.5)).rejects.toThrow('retentionYears must be a positive integer');
    // DB should never have been called
    expect(fake.calls).toHaveLength(0);
  });
});
