// Argument handling for the workspace retention CLI (cli/runRetention.ts, SEC-B L12). Kept apart from
// the entry point so it can be tested without a process or a database.
//
//   node dist/cli/runRetention.js            → deletes (development); dry run in production
//   node dist/cli/runRetention.js --dry-run  → only counts what would be deleted
//   node dist/cli/runRetention.js --yes      → deletes, also in production (NODE_ENV=production)
//
// Production without --yes is forced to a dry run, so an accidental run (or a copy-pasted command)
// never deletes PHI snapshots without an explicit confirmation.
import type { Pool } from 'pg';
import { countExpiredWorkspaces, runWorkspaceRetention } from '../jobs/workspaceRetention';

export const RETENTION_USAGE = 'usage: runRetention [--dry-run] [--yes]';

export interface RetentionArgs {
  dryRun: boolean;
  /** true when the dry run was forced because NODE_ENV=production and --yes was not given. */
  forced: boolean;
}

export function parseRetentionArgs(argv: readonly string[], nodeEnv: string | undefined): RetentionArgs | { error: string } {
  let dryRun = false;
  let yes = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--yes') yes = true;
    else return { error: `unknown argument: ${arg}\n${RETENTION_USAGE}` };
  }
  if (dryRun && yes) return { error: `--dry-run and --yes cannot be used together\n${RETENTION_USAGE}` };
  if (!dryRun && !yes && nodeEnv === 'production') return { dryRun: true, forced: true };
  return { dryRun, forced: false };
}

export async function runRetentionCommand(
  pool: Pool,
  args: RetentionArgs,
  log: (line: string) => void,
): Promise<{ dryRun: boolean; count: number }> {
  if (args.dryRun) {
    if (args.forced) log('[retention] NODE_ENV=production without --yes: dry run only (nothing is deleted)');
    const count = await countExpiredWorkspaces(pool);
    log(`[retention] dry run: ${count} expired workspace(s) would be deleted`);
    if (args.forced && count > 0) log('[retention] run again with --yes to delete them');
    return { dryRun: true, count };
  }
  const { deleted } = await runWorkspaceRetention(pool);
  log(`[retention] deleted ${deleted} expired workspace(s)`);
  return { dryRun: false, count: deleted };
}
