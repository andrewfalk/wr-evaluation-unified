// Migration 0042 (S8): the queue namespace columns and the namespaced unique indexes, against real PostgreSQL.
// The queue scans that use the namespace (claim, sweeps, cache, quota, cleanup) are tested where they change
// (S8-b, S8-c); this file pins the schema they rely on.
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { buildPendingStatsRunManifest } from '../runManifest';
import { createIntegrationOrg, integrationPool, TEST_DATABASE_URL, type IntegrationOrg, type IntegrationUser } from '../../../testing/integrationDb';

describe.skipIf(!TEST_DATABASE_URL)('queue namespace schema (migration 0042, real PostgreSQL)', () => {
  let pool: Pool;
  let org: IntegrationOrg;
  let user: IntegrationUser;

  beforeAll(async () => {
    pool = integrationPool('wr-itest-queue-namespace');
    org = await createIntegrationOrg(pool, 'queue-namespace');
    user = await org.makeUser('doctor', 'NS Doctor');
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [org.orgId]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [org.orgId]);
    await org?.destroy();
    await pool.end();
  });

  async function insertRun(ns: string | null, executionDigest: string, status: 'queued' | 'succeeded' = 'queued') {
    const analysisRunId = crypto.randomUUID();
    const manifest = buildPendingStatsRunManifest({
      recipeDigest: 'r', sourceDigest: 's', snapshotAsOf: new Date().toISOString(), formulaPolicies: {},
      analysisMode: 'descriptive', analysisRunId,
    });
    const succeeded = status === 'succeeded';
    const columns = ['organization_id', 'requested_by', 'status', 'recipe_digest', 'source_digest', 'execution_digest',
      'requested_disclosure_profile', 'cacheable', 'manifest', 'result', 'frozen_dataset', 'engine_timeout_ms',
      'expires_at', 'analysis_run_id', 'finished_at'];
    const values: unknown[] = [org.orgId, user.id, status, 'r', 's', executionDigest, 'aggregate', true,
      JSON.stringify(manifest), succeeded ? JSON.stringify({}) : null, JSON.stringify({}), 30000,
      new Date(Date.now() + 3600_000), analysisRunId, succeeded ? new Date() : null];
    if (ns !== null) {
      columns.push('queue_namespace');
      values.push(ns);
    }
    await pool.query(
      `INSERT INTO stats_runs (${columns.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})`,
      values,
    );
  }

  it('the new columns: queue_namespace NOT NULL DEFAULT \'default\' on the three tables, stats_runs.claimed_by nullable', async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name IN ('stats_runs','video_analysis_clips','video_analysis_jobs')
          AND column_name IN ('queue_namespace','claimed_by')
        ORDER BY table_name, column_name`,
    );
    expect(rows).toEqual([
      { table_name: 'stats_runs', column_name: 'claimed_by', is_nullable: 'YES', column_default: null },
      { table_name: 'stats_runs', column_name: 'queue_namespace', is_nullable: 'NO', column_default: "'default'::text" },
      { table_name: 'video_analysis_clips', column_name: 'queue_namespace', is_nullable: 'NO', column_default: "'default'::text" },
      { table_name: 'video_analysis_jobs', column_name: 'queue_namespace', is_nullable: 'NO', column_default: "'default'::text" },
    ]);
  });

  it('the unique and claim indexes carry the namespace', async () => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE indexname IN ('stats_runs_inflight_uniq','stats_runs_succeeded_uniq','stats_runs_queue_claim','video_analysis_jobs_queue_claim')
        ORDER BY indexname`,
    );
    const def = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(def.stats_runs_inflight_uniq).toMatch(/UNIQUE INDEX .* \(organization_id, execution_digest, queue_namespace\) WHERE \(status = ANY/);
    expect(def.stats_runs_succeeded_uniq).toMatch(/UNIQUE INDEX .* \(organization_id, execution_digest, queue_namespace\) WHERE \(\(status = 'succeeded'::text\) AND cacheable\)/);
    expect(def.stats_runs_queue_claim).toMatch(/\(queue_namespace, created_at\) WHERE \(status = 'queued'::text\)/);
    expect(def.video_analysis_jobs_queue_claim).toMatch(/\(queue_namespace, created_at\) WHERE \(status = 'queued'::text\)/);
  });

  it('a row inserted without a namespace gets \'default\'', async () => {
    await insertRun(null, 'digest-default');
    const { rows } = await pool.query(`SELECT queue_namespace FROM stats_runs WHERE organization_id = $1`, [org.orgId]);
    expect(rows).toEqual([{ queue_namespace: 'default' }]);
  });

  it('the same execution digest can be in flight once per namespace — not twice in one', async () => {
    await insertRun('ns-a', 'digest-1');
    await insertRun('ns-b', 'digest-1');
    await expect(insertRun('ns-a', 'digest-1')).rejects.toMatchObject({ code: '23505', constraint: 'stats_runs_inflight_uniq' });
  });

  it('a cacheable success of the same digest can exist once per namespace — not twice in one', async () => {
    await insertRun('ns-a', 'digest-2', 'succeeded');
    await insertRun('ns-b', 'digest-2', 'succeeded');
    await expect(insertRun('ns-b', 'digest-2', 'succeeded')).rejects.toMatchObject({ code: '23505', constraint: 'stats_runs_succeeded_uniq' });
  });
});
