// S9: a server shutdown stops the stats worker with a run in flight. The run goes back to the queue — not 'cancelled'
// (nobody asked to cancel it) and not left 'running' for the stale sweep — and worker.stop() resolves only after that
// is written, so the pool can be closed after it. A user's cancel still ends as 'cancelled'. Real PostgreSQL; the
// engine is a fake that runs until its signal is aborted, and the analysis context is a minimal descriptive one.
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const engine = vi.hoisted(() => ({ started: [] as Array<() => void> }));
vi.mock('../../engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../engine')>();
  return {
    ...actual,
    isEngineSlotAvailable: () => true,
    runStatsEngine: (_request: unknown, opts: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      const cancel = () => reject(new actual.StatsEngineCancelledError());
      if (opts.signal?.aborted) { cancel(); return; }
      opts.signal?.addEventListener('abort', cancel, { once: true });
      engine.started.shift()?.();
    }),
  };
});
vi.mock('../../recipe/analysisContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../recipe/analysisContext')>();
  return {
    ...actual,
    deriveAnalysisContext: () => ({
      ok: true,
      ctx: {
        recipe: { analysisMode: 'descriptive', variableKeys: [], formulaPolicies: {} },
        dataset: { rows: [], personCount: 0 }, catalogByKey: new Map(), descriptiveStratifyPartition: null,
        requestSuppressed: false,
      },
    }),
  };
});

import config from '../../../config';
import { attempt, claimNextQueuedRun, createStatsRunsQueueWorker, requestCancel } from '../runsQueue';
import { buildPendingStatsRunManifest } from '../runManifest';
import { computeExecutionDigest } from '../executionDigest';
import { createIntegrationOrg, integrationPool, TEST_DATABASE_URL, type IntegrationOrg, type IntegrationUser } from '../../../testing/integrationDb';

const NS = config.queueNamespace;

describe.skipIf(!TEST_DATABASE_URL)('stats worker shutdown (S9, real PostgreSQL)', () => {
  let pool: Pool;
  let org: IntegrationOrg;
  let user: IntegrationUser;

  beforeAll(async () => {
    pool = integrationPool('wr-itest-stats-shutdown');
    org = await createIntegrationOrg(pool, 'stats-shutdown');
    user = await org.makeUser('doctor', 'Shutdown Doctor');
  });

  afterEach(async () => {
    engine.started.length = 0;
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [org.orgId]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [org.orgId]);
    await org?.destroy();
    await pool.end();
  });

  /** A queued run whose digest matches the current versions (no drift), and a promise for its engine start. */
  async function queuedRun(): Promise<{ id: string; analysisRunId: string; engineStarted: Promise<void> }> {
    const analysisRunId = crypto.randomUUID();
    const recipeDigest = `recipe-${analysisRunId}`;
    const executionDigest = computeExecutionDigest({ organizationId: org.orgId, requestedBy: user.id, recipeDigest, sourceDigest: 's' });
    const manifest = buildPendingStatsRunManifest({
      recipeDigest, sourceDigest: 's', snapshotAsOf: new Date().toISOString(), formulaPolicies: {}, analysisMode: 'descriptive', analysisRunId,
    });
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO stats_runs (organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
         requested_disclosure_profile, cacheable, manifest, frozen_dataset, engine_timeout_ms, expires_at, analysis_run_id, queue_namespace)
       VALUES ($1,$2,'queued',$3,'s',$4,'aggregate',true,$5,$6,30000, now() + interval '1 day',$7,$8) RETURNING id`,
      [org.orgId, user.id, recipeDigest, executionDigest, JSON.stringify(manifest), JSON.stringify({ recipe: { analysisMode: 'descriptive' } }), analysisRunId, NS],
    );
    const engineStarted = new Promise<void>((resolve) => { engine.started.push(resolve); });
    return { id: rows[0].id, analysisRunId, engineStarted };
  }

  const row = async (id: string) =>
    (await pool.query(`SELECT status, requeue_count, claimed_by, cancel_requested_at, error_code FROM stats_runs WHERE id = $1`, [id])).rows[0];

  it('a shutdown abort during the engine puts the run back to queued (requeue_count + 1), not cancelled', async () => {
    const run = await queuedRun();
    const claimed = await claimNextQueuedRun(pool, 600000, NS);
    expect(claimed?.id).toBe(run.id);

    const shutdown = new AbortController();
    const attempting = attempt(pool, claimed!, shutdown.signal);
    await run.engineStarted;
    shutdown.abort();
    await attempting;

    expect(await row(run.id)).toMatchObject({ status: 'queued', requeue_count: 1, claimed_by: null, cancel_requested_at: null, error_code: null });
  });

  it("a user's cancel during the engine still ends as cancelled", async () => {
    const run = await queuedRun();
    const claimed = await claimNextQueuedRun(pool, 600000, NS);
    const attempting = attempt(pool, claimed!, new AbortController().signal);
    await run.engineStarted;
    expect((await requestCancel(pool, run.analysisRunId, org.orgId, user.id, NS)).outcome).toBe('cancelled');
    await attempting;
    expect((await row(run.id)).status).toBe('cancelled');
  });

  it('a shutdown after a cancel request ends as cancelled (the requeue sees the request)', async () => {
    const run = await queuedRun();
    const claimed = await claimNextQueuedRun(pool, 600000, NS);
    const shutdown = new AbortController();
    const attempting = attempt(pool, claimed!, shutdown.signal);
    await run.engineStarted;
    await pool.query(`UPDATE stats_runs SET cancel_requested_at = now() WHERE id = $1`, [run.id]);
    shutdown.abort();
    await attempting;
    expect((await row(run.id)).status).toBe('cancelled');
  });

  it('worker.stop() with a run in flight resolves after the run is back in the queue', async () => {
    const run = await queuedRun();
    const worker = createStatsRunsQueueWorker(pool);
    await run.engineStarted; // the worker's claim loop picked it up
    expect((await row(run.id)).status).toBe('running');

    await worker.stop();

    expect(await row(run.id)).toMatchObject({ status: 'queued', requeue_count: 1 });
  });

  it('worker.stop() rejects when the run in flight cannot be put back (every persist retry fails)', async () => {
    const run = await queuedRun();
    const worker = createStatsRunsQueueWorker(pool);
    await run.engineStarted;
    // From here on every transaction fails to start (requeueOrFinish → withWriteTransaction → pool.connect).
    const connect = vi.spyOn(pool, 'connect').mockImplementation((() => Promise.reject(new Error('db down'))) as never);
    try {
      await expect(worker.stop()).rejects.toThrow(/could not be stored while stopping/);
    } finally {
      connect.mockRestore();
    }
    expect((await row(run.id)).status).toBe('running'); // left to the stale sweep, as before
  });
});
