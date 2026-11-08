// Workspace retention CLI (SEC-B L12): --dry-run only counts; in production a run without --yes is
// forced to a dry run, so nothing is deleted without an explicit confirmation.
import { describe, expect, it } from 'vitest';
import { parseRetentionArgs, runRetentionCommand } from '../retentionCommand';
import { createFakePool, type FakePool } from '../../testing/fakePool';

function fake(): FakePool {
  return createFakePool({
    handlers: [
      { name: 'count', match: /SELECT count\(\*\)::int AS n FROM workspaces WHERE created_at < now\(\)/, reply: { rows: [{ n: 4 }] } },
      { name: 'delete', match: /DELETE FROM workspaces WHERE created_at < now\(\)/, reply: { rowCount: 4 } },
    ],
  });
}

describe('parseRetentionArgs', () => {
  it('development: no flags deletes, --dry-run counts', () => {
    expect(parseRetentionArgs([], 'development')).toEqual({ dryRun: false, forced: false });
    expect(parseRetentionArgs([], undefined)).toEqual({ dryRun: false, forced: false });
    expect(parseRetentionArgs(['--dry-run'], 'development')).toEqual({ dryRun: true, forced: false });
  });

  it('production: no flags is forced to a dry run; --yes deletes; --dry-run stays a dry run', () => {
    expect(parseRetentionArgs([], 'production')).toEqual({ dryRun: true, forced: true });
    expect(parseRetentionArgs(['--yes'], 'production')).toEqual({ dryRun: false, forced: false });
    expect(parseRetentionArgs(['--dry-run'], 'production')).toEqual({ dryRun: true, forced: false });
  });

  it('rejects unknown arguments and --dry-run with --yes', () => {
    expect(parseRetentionArgs(['--force'], 'production')).toMatchObject({ error: expect.stringMatching(/unknown argument: --force/) });
    expect(parseRetentionArgs(['--dry-run', '--yes'], 'production')).toMatchObject({ error: expect.stringMatching(/cannot be used together/) });
  });
});

describe('runRetentionCommand', () => {
  it('a dry run only counts — no DELETE is sent', async () => {
    const f = fake();
    const lines: string[] = [];
    const result = await runRetentionCommand(f.pool, { dryRun: true, forced: false }, l => lines.push(l));
    expect(result).toEqual({ dryRun: true, count: 4 });
    expect(f.callsTo('count')).toHaveLength(1);
    expect(f.callsTo('delete')).toHaveLength(0);
    expect(f.callsTo('count')[0].params).toEqual([5]); // same 5-year condition as the delete
    expect(lines).toEqual(['[retention] dry run: 4 expired workspace(s) would be deleted']);
    f.assertNoUnmatched();
  });

  it('a forced (production) dry run says why and how to delete', async () => {
    const f = fake();
    const lines: string[] = [];
    await runRetentionCommand(f.pool, { dryRun: true, forced: true }, l => lines.push(l));
    expect(f.callsTo('delete')).toHaveLength(0);
    expect(lines[0]).toMatch(/NODE_ENV=production without --yes: dry run only/);
    expect(lines.at(-1)).toMatch(/run again with --yes/);
  });

  it('a confirmed run deletes', async () => {
    const f = fake();
    const lines: string[] = [];
    const result = await runRetentionCommand(f.pool, { dryRun: false, forced: false }, l => lines.push(l));
    expect(result).toEqual({ dryRun: false, count: 4 });
    expect(f.callsTo('delete')).toHaveLength(1);
    expect(f.callsTo('count')).toHaveLength(0);
    expect(lines).toEqual(['[retention] deleted 4 expired workspace(s)']);
  });
});
