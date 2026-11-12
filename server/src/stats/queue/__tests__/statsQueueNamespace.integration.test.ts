// S8-b: the stats queue stays inside its queue namespace, against real PostgreSQL. Two servers sharing one database
// (ns A, ns B) must not claim, sweep, finish, clean, cancel, cache-hit, join or count each other's runs.
// Every test is "ns A's path leaves ns B's row as it was" plus the control that ns B's own path does act on it.
import crypto from 'crypto';
import os from 'os';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { AnalyzeResult } from '@wr/contracts';

// The workbench gate (flag ∧ intranet) is not what this file tests — open it so the cancel route answers.
vi.mock('../../policy/workbenchRuntimeState', () => ({
  getStatsWorkbenchAvailability: () => ({ available: true, reason: null, checkedAt: null }),
  setStatsWorkbenchHealthy: () => {},
}));

import config from '../../../config';
import { buildPendingStatsRunManifest } from '../runManifest';
import {
  claimNextQueuedRun, sweepStale, sweepQueuedTerminal, finishRun, requeueOrFinish, requestCancel,
} from '../runsQueue';
import { admitAnalysisRun } from '../runAdmission';
import { runStatsRunCleanup } from '../../../jobs/statsRunCleanup';
import { createStatsRouter } from '../../routes/router';
import type { AnalysisContext } from '../../recipe/analysisContext';
import {
  createIntegrationOrg, integrationPool, TEST_DATABASE_URL, type IntegrationOrg, type IntegrationUser,
} from '../../../testing/integrationDb';

const NS_A = 'ns-a';
const NS_B = 'ns-b';
const FAKE_RESULT = { kind: 'descriptive', rows: [] } as unknown as AnalyzeResult;

interface RunSpec {
  ns: string;
  status?: 'queued' | 'running' | 'succeeded' | 'failed';
  digest?: string;
  requestedBy?: string;
  createdAt?: Date;
  heartbeatAt?: Date | null;
  cancelRequestedAt?: Date | null;
  expiresAt?: Date;
  cacheable?: boolean;
  analysisMode?: string;
}

describe.skipIf(!TEST_DATABASE_URL)('stats queue namespace isolation (S8-b, real PostgreSQL)', () => {
  let pool: Pool;
  let org: IntegrationOrg;
  let user: IntegrationUser;
  let user2: IntegrationUser;

  beforeAll(async () => {
    pool = integrationPool('wr-itest-stats-queue-ns');
    org = await createIntegrationOrg(pool, 'stats-queue-ns');
    user = await org.makeUser('doctor', 'NS Doctor');
    user2 = await org.makeUser('doctor', 'NS Doctor 2');
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

  async function insertRun(spec: RunSpec): Promise<{ id: string; analysisRunId: string; digest: string }> {
    const analysisRunId = crypto.randomUUID();
    const status = spec.status ?? 'queued';
    const digest = spec.digest ?? `digest-${analysisRunId}`;
    const analysisMode = spec.analysisMode ?? 'descriptive';
    const manifest = buildPendingStatsRunManifest({
      recipeDigest: 'r', sourceDigest: 's', snapshotAsOf: new Date().toISOString(), formulaPolicies: {},
      analysisMode: analysisMode as 'descriptive', analysisRunId,
    });
    const running = status === 'running';
    const terminal = status === 'succeeded' || status === 'failed';
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO stats_runs (
         organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
         requested_disclosure_profile, cacheable, manifest, result, error_code, frozen_dataset, engine_timeout_ms,
         expires_at, analysis_run_id, created_at, started_at, heartbeat_at, cancel_requested_at, finished_at,
         queue_namespace
       ) VALUES ($1,$2,$3,'r','s',$4,'aggregate',$5,$6,$7,$8,$9,30000,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        org.orgId, spec.requestedBy ?? user.id, status, digest, spec.cacheable ?? true, JSON.stringify(manifest),
        status === 'succeeded' ? JSON.stringify(FAKE_RESULT) : null, status === 'failed' ? 'PROCESS_ERROR' : null,
        JSON.stringify({ recipe: { analysisMode } }), spec.expiresAt ?? new Date(Date.now() + 24 * 3600_000),
        analysisRunId, spec.createdAt ?? new Date(), running ? new Date() : null,
        spec.heartbeatAt !== undefined ? spec.heartbeatAt : (running ? new Date() : null),
        spec.cancelRequestedAt ?? null, terminal ? new Date() : null, spec.ns,
      ],
    );
    return { id: rows[0].id, analysisRunId, digest };
  }

  async function fetchRow(id: string) {
    const { rows } = await pool.query(`SELECT * FROM stats_runs WHERE id = $1`, [id]);
    return rows[0];
  }

  // The fields admission reads (orgId, userId, recipeDigest, recipe, snapshot, dataset, predictionState).
  function ctx(analysisMode: 'descriptive' | 'prediction' = 'descriptive'): AnalysisContext {
    return {
      orgId: org.orgId, userId: user.id, recipeDigest: 'r',
      recipe: { grain: 'case', filters: [], analysisPurpose: 'association', analysisMode, variableKeys: [], formulaPolicies: {} },
      snapshot: { sourceDigest: 's', snapshotAsOf: new Date().toISOString() },
      dataset: { rows: [], personCount: 0 },
      predictionState: analysisMode === 'prediction' ? { s2Rows: [] } : null,
    } as unknown as AnalysisContext;
  }

  const admit = (ns: string, digest: string, mode: 'descriptive' | 'prediction' = 'descriptive') =>
    admitAnalysisRun(pool, ctx(mode), digest, 30000, 'aggregate', ns);

  describe('claim', () => {
    it("a worker of ns A does not claim ns B's queued run; ns B's worker does and records claimed_by", async () => {
      const b = await insertRun({ ns: NS_B });

      expect(await claimNextQueuedRun(pool, 600000, NS_A)).toBeNull();
      expect(await fetchRow(b.id)).toMatchObject({ status: 'queued', claimed_by: null, started_at: null });

      const claimed = await claimNextQueuedRun(pool, 600000, NS_B);
      expect(claimed?.id).toBe(b.id);
      expect(claimed?.queue_namespace).toBe(NS_B);
      expect(await fetchRow(b.id)).toMatchObject({ status: 'running', claimed_by: `${os.hostname()}:${process.pid}` });
    });

    it('a requeue (engine busy) clears claimed_by', async () => {
      const b = await insertRun({ ns: NS_B });
      await claimNextQueuedRun(pool, 600000, NS_B);
      await requeueOrFinish(pool, b.id);
      expect(await fetchRow(b.id)).toMatchObject({ status: 'queued', claimed_by: null, requeue_count: 1 });
    });
  });

  describe('sweeps', () => {
    it("sweepStale of ns A leaves ns B's stale running run running; ns B's sweep fails it", async () => {
      const b = await insertRun({ ns: NS_B, status: 'running', heartbeatAt: new Date(Date.now() - 24 * 3600_000) });

      await sweepStale(pool, NS_A);
      expect((await fetchRow(b.id)).status).toBe('running');

      await sweepStale(pool, NS_B);
      expect(await fetchRow(b.id)).toMatchObject({ status: 'failed', error_code: 'PROCESS_ERROR' });
    });

    it("sweepQueuedTerminal of ns A (short wait budget) leaves ns B's cancel-requested and over-budget queued runs queued", async () => {
      const cancelled = await insertRun({ ns: NS_B, cancelRequestedAt: new Date() });
      const overBudget = await insertRun({ ns: NS_B, createdAt: new Date(Date.now() - 10_000) });

      await sweepQueuedTerminal(pool, NS_A, 1);
      expect((await fetchRow(cancelled.id)).status).toBe('queued');
      expect((await fetchRow(overBudget.id)).status).toBe('queued');

      await sweepQueuedTerminal(pool, NS_B, 1);
      expect((await fetchRow(cancelled.id)).status).toBe('cancelled');
      expect(await fetchRow(overBudget.id)).toMatchObject({ status: 'failed', error_code: 'QUEUE_WAIT_EXCEEDED' });
    });

    it("the cleanup of ns A deletes its own expired runs, not ns B's", async () => {
      const past = new Date(Date.now() - 1000);
      const a = await insertRun({ ns: NS_A, status: 'failed', expiresAt: past });
      const b = await insertRun({ ns: NS_B, status: 'failed', expiresAt: past });

      expect(await runStatsRunCleanup(pool, NS_A)).toEqual({ deleted: 1 });
      expect(await fetchRow(a.id)).toBeUndefined();
      expect(await fetchRow(b.id)).toBeDefined();

      expect(await runStatsRunCleanup(pool, NS_B)).toEqual({ deleted: 1 });
      expect(await fetchRow(b.id)).toBeUndefined();
    });
  });

  describe('cache at finish', () => {
    it("ns B's valid cached success does not demote ns A's success of the same digest to cacheable=false", async () => {
      const b = await insertRun({ ns: NS_B, status: 'succeeded', digest: 'd-finish' });
      const a = await insertRun({ ns: NS_A, status: 'running', digest: 'd-finish' });

      await finishRun(pool, a.id, { origin: 'computed', outcome: { kind: 'succeeded', result: FAKE_RESULT } });

      expect(await fetchRow(a.id)).toMatchObject({ status: 'succeeded', cacheable: true });
      expect(await fetchRow(b.id)).toMatchObject({ status: 'succeeded', cacheable: true });
    });

    it("finishing ns A's run does not delete ns B's expired cached success of the same digest", async () => {
      const b = await insertRun({ ns: NS_B, status: 'succeeded', digest: 'd-expired', expiresAt: new Date(Date.now() - 1000) });
      const a = await insertRun({ ns: NS_A, status: 'running', digest: 'd-expired' });

      await finishRun(pool, a.id, { origin: 'computed', outcome: { kind: 'succeeded', result: FAKE_RESULT } });

      expect(await fetchRow(b.id)).toBeDefined();
      expect((await fetchRow(a.id)).cacheable).toBe(true);
    });
  });

  describe('admission', () => {
    it("ns A does not hit ns B's cache — it admits its own run; ns B hits its cache", async () => {
      const b = await insertRun({ ns: NS_B, status: 'succeeded', digest: 'd-cache' });

      const inA = await admit(NS_A, 'd-cache');
      expect(inA.kind).toBe('admitted');
      expect(inA.kind !== 'denied' && inA.row.queue_namespace).toBe(NS_A);

      const inB = await admit(NS_B, 'd-cache');
      expect(inB).toMatchObject({ kind: 'cache_hit', row: { id: b.id } });
    });

    it("ns A does not join ns B's in-flight run — it admits its own; ns B joins", async () => {
      const b = await insertRun({ ns: NS_B, digest: 'd-join' });

      const inA = await admit(NS_A, 'd-join');
      expect(inA.kind).toBe('admitted');
      expect(inA.kind !== 'denied' && inA.row.id).not.toBe(b.id);

      expect(await admit(NS_B, 'd-join')).toMatchObject({ kind: 'joined', row: { id: b.id } });
    });

    it("the per-user concurrency quota counts only the namespace's runs", async () => {
      for (let i = 0; i < config.stats.async.maxConcurrentPerUser; i += 1) await insertRun({ ns: NS_B });

      expect((await admit(NS_A, 'd-user-conc')).kind).toBe('admitted');
      expect(await admit(NS_B, 'd-user-conc')).toMatchObject({ kind: 'denied', code: 'USER_CONCURRENCY_LIMIT' });
    });

    it("the per-org concurrency quota counts only the namespace's runs", async () => {
      for (let i = 0; i < config.stats.async.maxConcurrentPerOrg; i += 1) await insertRun({ ns: NS_B, requestedBy: user2.id });

      expect((await admit(NS_A, 'd-org-conc')).kind).toBe('admitted');
      expect(await admit(NS_B, 'd-org-conc')).toMatchObject({ kind: 'denied', code: 'ORG_CONCURRENCY_LIMIT' });
    });

    it("the per-user hourly quota counts only the namespace's runs", async () => {
      for (let i = 0; i < config.stats.async.maxHourlyPerUser; i += 1) await insertRun({ ns: NS_B, status: 'failed' });

      expect((await admit(NS_A, 'd-user-hour')).kind).toBe('admitted');
      expect(await admit(NS_B, 'd-user-hour')).toMatchObject({ kind: 'denied', code: 'USER_HOURLY_LIMIT' });
    });

    it("the per-org hourly quota counts only the namespace's runs", async () => {
      for (let i = 0; i < config.stats.async.maxHourlyPerOrg; i += 1) await insertRun({ ns: NS_B, status: 'failed', requestedBy: user2.id });

      expect((await admit(NS_A, 'd-org-hour')).kind).toBe('admitted');
      expect(await admit(NS_B, 'd-org-hour')).toMatchObject({ kind: 'denied', code: 'ORG_HOURLY_LIMIT' });
    });

    it("the one-prediction-per-org limit counts only the namespace's runs", async () => {
      await insertRun({ ns: NS_B, analysisMode: 'prediction', requestedBy: user2.id });

      expect((await admit(NS_A, 'd-pred', 'prediction')).kind).toBe('admitted');
      expect(await admit(NS_B, 'd-pred', 'prediction')).toMatchObject({ kind: 'denied', code: 'ORG_PREDICTION_CONCURRENCY_LIMIT' });
    });
  });

  describe('cancel', () => {
    it("requestCancel from ns A on ns B's run is not_found and leaves the row untouched; from ns B it cancels", async () => {
      const b = await insertRun({ ns: NS_B, status: 'running' });

      expect(await requestCancel(pool, b.analysisRunId, org.orgId, user.id, NS_A)).toEqual({ outcome: 'not_found' });
      expect(await fetchRow(b.id)).toMatchObject({ cancel_requested_at: null, cancelled_by: null, status: 'running' });

      expect(await requestCancel(pool, b.analysisRunId, org.orgId, user.id, NS_B)).toEqual({ outcome: 'cancelled' });
      expect((await fetchRow(b.id)).cancel_requested_at).not.toBeNull();
    });

    it("POST /runs/:id/cancel on another namespace's run → 404 and the row is untouched; on this server's run → 200", async () => {
      const app = express();
      app.use(express.json());
      app.use(cookieParser());
      app.use('/api/stats', createStatsRouter(pool));

      const other = await insertRun({ ns: NS_B });
      const res = await request(app).post(`/api/stats/runs/${other.analysisRunId}/cancel`).set(org.headers(user)).send({});
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('RUN_NOT_FOUND');
      expect(await fetchRow(other.id)).toMatchObject({ cancel_requested_at: null, cancelled_by: null });

      const own = await insertRun({ ns: config.queueNamespace });
      const ok = await request(app).post(`/api/stats/runs/${own.analysisRunId}/cancel`).set(org.headers(user)).send({});
      expect(ok.status).toBe(200);
      expect((await fetchRow(own.id)).cancel_requested_at).not.toBeNull();
    });
  });
});
