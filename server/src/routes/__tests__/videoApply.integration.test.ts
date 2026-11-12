// POST /api/video-analysis/jobs/:jobId/apply against real PostgreSQL (S7-2). Written against the route
// handler before its patient section moved to domain/patients/applyVideoAnalysis.ts, and kept unchanged
// across the move: these tests replace the order-based mock tests of the apply in videoAnalysis.test.ts.
// The client's whole apply flow (apply → replay → re-apply → reads) is frozen in G5
// (__tests__/golden.api.integration.test.ts).
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { VIDEO_MAPPING_CONFIG_VERSION, VIDEO_VIEWPOINT_CONFIG_VERSION } from '@wr/contracts';

const lockMode = vi.hoisted(() => ({ mode: 'off' as 'off' | 'observe' | 'enforce' }));
vi.mock('../../config', async (importOriginal) => {
  const actualModule = await importOriginal<typeof import('../../config')>();
  const cfg = { ...actualModule.default, videoAnalysisEnabled: true, video: { ...actualModule.default.video, allowUnverifiedRecipe: false } };
  Object.defineProperty(cfg, 'lockEnforcementMode', { get: () => lockMode.mode, enumerable: true });
  return { ...actualModule, default: cfg };
});

import { createVideoAnalysisRouter } from '../videoAnalysis';
import { makeRouterApp } from '../../testing/app';
import { acquireLock, lockPatientAnchor } from '../../db/patientLocks';
import {
  createIntegrationOrg, integrationPool, waitForLockWait, TEST_DATABASE_URL,
  type IntegrationOrg, type IntegrationUser,
} from '../../testing/integrationDb';

const APP = 'wr-itest-video-apply';
const HOLDER_APP = 'wr-itest-video-apply-holder';

const RECIPE = {
  status: 'verified', modelVersion: 'rtmlib-0.0.15',
  detectorSha256: 'a'.repeat(64), poseSha256: 'b'.repeat(64),
  preprocessConfigHash: 'pch', featureConfigVersion: 'fc-1',
  mappingConfigVersion: VIDEO_MAPPING_CONFIG_VERSION, viewpointConfigVersion: VIDEO_VIEWPOINT_CONFIG_VERSION,
  codeCommit: 'abc1234',
};

describe.skipIf(!TEST_DATABASE_URL)('video analysis apply → patient_records (real PostgreSQL, S7-2)', () => {
  let pool: Pool;
  let holderPool: Pool;
  let org: IntegrationOrg;
  let docA: IntegrationUser;
  let docB: IntegrationUser;
  let adminC: IntegrationUser;

  beforeAll(async () => {
    pool = integrationPool(APP);
    holderPool = integrationPool(HOLDER_APP);
    org = await createIntegrationOrg(holderPool, 'video-apply');
    docA = await org.makeUser('doctor', 'Doc A');
    docB = await org.makeUser('doctor', 'Doc B');
    adminC = await org.makeUser('admin', 'Admin C');
  });

  afterEach(async () => {
    lockMode.mode = 'off';
    await org.resetData();
  });

  afterAll(async () => {
    if (!pool) return;
    await org?.destroy();
    await pool.end();
    await holderPool.end();
  });

  const app = () => makeRouterApp((a) => { a.use('/api/video-analysis', createVideoAnalysisRouter(pool)); });

  interface Fixture { pid: string; clipId: string; analysisJobId: string; shellJobId: string }

  /** A patient assigned to `assigned` (revision 1) with a review_pending analysis job and an apply shell job. */
  async function seed(assigned: IntegrationUser | null = docA): Promise<Fixture> {
    const pid = crypto.randomUUID();
    const person = await holderPool.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, name) VALUES ($1, '영상 환자') RETURNING id`, [org.orgId],
    );
    await holderPool.query(
      `INSERT INTO patient_records (id, organization_id, owner_user_id, assigned_doctor_user_id, patient_person_id, name, revision, payload)
       VALUES ($1, $2, $3, $4, $5, '영상 환자', 1, $6)`,
      [pid, org.orgId, docA.id, assigned?.id ?? null, person.rows[0].id,
        JSON.stringify({ id: pid, phase: 'intake', marker: 'before', data: { shared: { name: '영상 환자' }, modules: {}, activeModules: [] } })],
    );
    const clipId = (await holderPool.query<{ id: string }>(
      `INSERT INTO video_analysis_clips (organization_id, patient_record_id, process_id, source_type, file_state)
       VALUES ($1, $2, 'p1', 'apply_shell', 'none') RETURNING id`,
      [org.orgId, pid],
    )).rows[0].id;
    const analysisJobId = (await holderPool.query<{ id: string }>(
      `INSERT INTO video_analysis_jobs
         (organization_id, patient_record_id, clip_id, process_id, status, analysis_profile,
          requested_features, result_features, preprocess_config_hash, analysis_recipe)
       VALUES ($1, $2, $3, 'p1', 'review_pending', 'posture-basic', $4, $5, 'pch', $6) RETURNING id`,
      [org.orgId, pid, clipId, JSON.stringify(['overheadHours']), JSON.stringify({ schemaVersion: 1, features: {} }), JSON.stringify(RECIPE)],
    )).rows[0].id;
    const shellJobId = (await holderPool.query<{ id: string }>(
      `INSERT INTO video_analysis_jobs (organization_id, patient_record_id, clip_id, status, analysis_profile)
       VALUES ($1, $2, $3, 'review_pending', 'posture-basic') RETURNING id`,
      [org.orgId, pid, clipId],
    )).rows[0].id;
    return { pid, clipId, analysisJobId, shellJobId };
  }

  function appliedInput(f: Fixture, over: Record<string, unknown> = {}) {
    return {
      moduleId: 'shoulder', targetPath: 'modules.shoulder.jobExtras[sharedJobId=job-1].overheadHours',
      suggestedValue: 1.8, appliedValue: 1.8, previousValue: null, unit: 'hours_per_day',
      source: 'video', processIds: ['p1'], clipIds: [f.clipId], analysisJobIds: [f.analysisJobId], confidence: 0.8,
      analysisBundleVersion: 'itest-bundle', recipe: RECIPE, appliedAt: '2026-01-01T00:00:00.000Z', appliedBy: docA.id,
      ...over,
    };
  }

  /** The apply body the client sends: the patient's new data with one new video appliedInput. */
  function applyBody(f: Fixture, over: Record<string, unknown> = {}, input: Record<string, unknown> = appliedInput(f)) {
    return {
      data: { shared: { name: '영상 환자', videoAnalysis: { appliedInputs: [input] } }, modules: {}, activeModules: [] } as Record<string, unknown>,
      appliedInputsHash: `hash-${f.shellJobId}`, appliedInputsCount: 1, sourceAnalysisJobIds: [f.analysisJobId],
      ...over,
    };
  }

  function apply(user: IntegrationUser, jobId: string, ifMatch: number | null, body: unknown, extraHeaders: Record<string, string> = {}): Promise<request.Response> {
    let req = request(app()).post(`/api/video-analysis/jobs/${jobId}/apply`).set(org.headers(user)).set(extraHeaders);
    if (ifMatch !== null) req = req.set('If-Match', String(ifMatch));
    return Promise.resolve(req.send(body as object));
  }

  async function patient(pid: string) {
    const { rows } = await holderPool.query<{
      revision: number; marker: string | null; applied: unknown; status: string;
      observed_at: string | null; source: string | null; verified_at: string | null; engine: string | null;
    }>(
      `SELECT revision, payload->>'marker' AS marker, payload->'data'->'shared'->'videoAnalysis'->'appliedInputs' AS applied,
              completion_status AS status, server_observed_modules_complete_at::text AS observed_at, completion_source AS source,
              server_verified_modules_complete_at::text AS verified_at, completion_verification_engine_version AS engine
       FROM patient_records WHERE id = $1`,
      [pid],
    );
    return rows[0];
  }

  async function job(id: string) {
    const { rows } = await holderPool.query<{ status: string; applied_at: Date | null; applied_revision: number | null; applied_inputs_hash: string | null }>(
      `SELECT status, applied_at, applied_revision, applied_inputs_hash FROM video_analysis_jobs WHERE id = $1`, [id],
    );
    return rows[0];
  }

  async function auditRows(action: string, targetId: string, atLeast = 1) {
    const deadline = Date.now() + 3000;
    for (;;) {
      const { rows } = await holderPool.query<{ actor: string | null; outcome: string; extra: Record<string, unknown> | null }>(
        `SELECT actor_user_id AS actor, outcome, extra FROM audit_logs
          WHERE action = $1 AND target_id = $2 AND actor_org_id = $3 ORDER BY created_at, id`,
        [action, targetId, org.orgId],
      );
      if (rows.length >= atLeast || Date.now() > deadline) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function holdLock(user: IntegrationUser, pid: string): Promise<string> {
    const c = await holderPool.connect();
    try {
      await c.query('BEGIN');
      await lockPatientAnchor(c, { patientId: pid, orgId: org.orgId });
      const r = await acquireLock(c, {
        patientId: pid, orgId: org.orgId, userId: user.id, holderName: user.name, clientInstanceId: crypto.randomUUID(),
      });
      await c.query('COMMIT');
      if (!r.ok) throw new Error('lock not acquired');
      return r.leaseToken;
    } finally {
      c.release();
    }
  }

  async function withHolder<T>(fn: (t1: PoolClient) => Promise<T>): Promise<T> {
    const t1 = await holderPool.connect();
    try {
      return await fn(t1);
    } finally {
      await t1.query('ROLLBACK').catch(() => {});
      t1.release();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Success, replay, consumption, audit
  // ---------------------------------------------------------------------------------------------

  it('applies: payload data replaced (other payload keys kept), revision + 1, shell and source jobs done, audited', async () => {
    const f = await seed();
    const res = await apply(docA, f.shellJobId, 1, applyBody(f));
    expect(res.status).toBe(200);
    expect(res.body.patient).toMatchObject({ id: f.pid, marker: 'before', sync: { serverId: f.pid, revision: 2, syncStatus: 'synced' } });
    expect(res.body.idempotent).toBeUndefined();

    const p = await patient(f.pid);
    expect(p.revision).toBe(2);
    expect(p.marker).toBe('before');
    expect(p.applied).toEqual([appliedInput(f)]);
    expect(await job(f.shellJobId)).toMatchObject({ status: 'done', applied_revision: 2, applied_inputs_hash: `hash-${f.shellJobId}` });
    expect((await job(f.shellJobId)).applied_at).not.toBeNull();
    expect(await job(f.analysisJobId)).toMatchObject({ status: 'done', applied_revision: 2 });

    expect(await auditRows('video_analysis_apply', f.pid)).toEqual([{
      actor: docA.id, outcome: 'success',
      extra: { jobId: f.shellJobId, clipId: f.clipId, appliedInputsCount: 1, appliedRevision: 2, sourceAnalysisJobIds: [f.analysisJobId] },
    }]);
  });

  it('a replay with the same hash returns the stored patient (idempotent) and changes nothing — even with a stale If-Match', async () => {
    const f = await seed();
    const first = await apply(docA, f.shellJobId, 1, applyBody(f));
    expect(first.status).toBe(200);
    const replay = await apply(docA, f.shellJobId, 1, applyBody(f));
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ idempotent: true, patient: first.body.patient });
    expect((await patient(f.pid)).revision).toBe(2);
  });

  it('two concurrent applies of the same job: one applies, the other is answered as the idempotent replay', async () => {
    const f = await seed();
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await t1.query(`SELECT 1 FROM video_analysis_jobs WHERE id = $1 FOR UPDATE`, [f.shellJobId]);
      const a = apply(docA, f.shellJobId, 1, applyBody(f));
      const b = apply(docA, f.shellJobId, 1, applyBody(f));
      await waitForLockWait(holderPool, APP, { count: 2 });
      await t1.query('COMMIT');
      const results = await Promise.all([a, b]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(results.filter((r) => r.body.idempotent === true)).toHaveLength(1);
    });
    expect((await patient(f.pid)).revision).toBe(2);
    expect(await auditRows('video_analysis_apply', f.pid)).toHaveLength(1);
  });

  it('a done job with a different hash → 409 JOB_NOT_APPLIABLE', async () => {
    const f = await seed();
    await apply(docA, f.shellJobId, 1, applyBody(f));
    const res = await apply(docA, f.shellJobId, 2, applyBody(f, { appliedInputsHash: 'another-hash' }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'JOB_NOT_APPLIABLE', error: "Job is 'done', expected 'review_pending'", status: 'done' });
  });

  it('an expired job → 409 JOB_NOT_APPLIABLE', async () => {
    const f = await seed();
    await holderPool.query(`UPDATE video_analysis_jobs SET status = 'expired' WHERE id = $1`, [f.shellJobId]);
    const res = await apply(docA, f.shellJobId, 1, applyBody(f));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'JOB_NOT_APPLIABLE', error: "Job is 'expired', expected 'review_pending'", status: 'expired' });
    expect((await patient(f.pid)).revision).toBe(1);
  });

  // ---------------------------------------------------------------------------------------------
  // Completion columns
  // ---------------------------------------------------------------------------------------------

  it('a completion report and a server-verifiable case set the completion columns', async () => {
    const f = await seed();
    const body = applyBody(f, {
      modulesCompleteObserved: true, completionClientBuildVersion: 'build-1', completionClientSchemaVersion: 1,
    });
    body.data = {
      shared: {
        name: '영상 환자', videoAnalysis: { appliedInputs: [appliedInput(f)] },
        diagnoses: [{ code: 'M17.0', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }],
      },
      modules: { knee: {} }, activeModules: ['knee'],
    };
    expect((await apply(docA, f.shellJobId, 1, body)).status).toBe(200);
    const p = await patient(f.pid);
    expect(p).toMatchObject({ status: 'modules_complete', source: 'client_reported' });
    expect(p.observed_at).not.toBeNull();
    expect(p.verified_at).not.toBeNull();
    expect(p.engine).not.toBeNull();
  });

  it('server verification does not depend on the client report: a verifiable case without a report gets only the server columns', async () => {
    const f = await seed();
    const body = applyBody(f);
    body.data = {
      shared: {
        name: '영상 환자', videoAnalysis: { appliedInputs: [appliedInput(f)] },
        diagnoses: [{ code: 'M17.0', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }],
      },
      modules: { knee: {} }, activeModules: ['knee'],
    };
    expect((await apply(docA, f.shellJobId, 1, body)).status).toBe(200);
    const p = await patient(f.pid);
    expect(p).toMatchObject({ status: 'draft', observed_at: null, source: null });
    expect(p.verified_at).not.toBeNull();
    expect(p.engine).not.toBeNull();
  });

  it('a second apply keeps the completion provenance of the first (time, source, client versions) and the status follows the report', async () => {
    const f = await seed();
    const reported = (build: string) => ({ modulesCompleteObserved: true, completionClientBuildVersion: build, completionClientSchemaVersion: 1 });
    expect((await apply(docA, f.shellJobId, 1, applyBody(f, reported('build-1')))).status).toBe(200);
    const first = await patient(f.pid);
    expect(first).toMatchObject({ status: 'modules_complete', source: 'client_reported' });
    // A later apply of another shell job (no new inputs: the stored appliedInputs as they are).
    const secondShell = (await holderPool.query<{ id: string }>(
      `INSERT INTO video_analysis_jobs (organization_id, patient_record_id, clip_id, status, analysis_profile)
       VALUES ($1, $2, $3, 'review_pending', 'posture-basic') RETURNING id`,
      [org.orgId, f.pid, f.clipId],
    )).rows[0].id;
    const again = await apply(docA, secondShell, 2, {
      ...applyBody(f, { ...reported('build-2'), appliedInputsHash: 'second', appliedInputsCount: 0, sourceAnalysisJobIds: [] }),
    });
    expect(again.status).toBe(200);
    expect(await patient(f.pid)).toMatchObject({ revision: 3, status: 'modules_complete', observed_at: first.observed_at, source: 'client_reported' });
    const build = await holderPool.query<{ b: string }>(`SELECT completion_client_build_version AS b FROM patient_records WHERE id = $1`, [f.pid]);
    expect(build.rows[0].b).toBe('build-1');
  });

  it('without a report and without a verifiable case the completion columns stay empty', async () => {
    const f = await seed();
    expect((await apply(docA, f.shellJobId, 1, applyBody(f))).status).toBe(200);
    expect(await patient(f.pid)).toMatchObject({ status: 'draft', observed_at: null, source: null, verified_at: null, engine: null });
  });

  it('modulesCompleteObserved: true without the version fields → 400 before anything is read', async () => {
    const f = await seed();
    const res = await apply(docA, f.shellJobId, 1, applyBody(f, { modulesCompleteObserved: true }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    expect((await job(f.shellJobId)).status).toBe('review_pending');
  });

  // ---------------------------------------------------------------------------------------------
  // Authorization, revision, lock
  // ---------------------------------------------------------------------------------------------

  it('no If-Match → 400', async () => {
    const f = await seed();
    const res = await apply(docA, f.shellJobId, null, applyBody(f));
    expect(res.status).toBe(400);
    expect((await patient(f.pid)).revision).toBe(1);
  });

  it('a PATCH (revision bump) after the client read → 409 with the current revision; the job stays review_pending', async () => {
    const f = await seed();
    await holderPool.query(`UPDATE patient_records SET revision = 2 WHERE id = $1`, [f.pid]);
    const res = await apply(docA, f.shellJobId, 1, applyBody(f));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'CONFLICT', error: 'Revision mismatch. Fetch the latest version before retrying.', currentRevision: 2 });
    expect(await job(f.shellJobId)).toMatchObject({ status: 'review_pending', applied_at: null });
    expect(await job(f.analysisJobId)).toMatchObject({ status: 'review_pending' });
  });

  it('not the assigned doctor → 403; an admin may apply', async () => {
    const f = await seed(docA);
    const res = await apply(docB, f.shellJobId, 1, applyBody(f));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
    expect((await apply(adminC, f.shellJobId, 1, applyBody(f))).status).toBe(200);
  });

  it('reassigned between the job check and the patient lock (TOCTOU) → 403, nothing written', async () => {
    const f = await seed(docA);
    await withHolder(async (t1) => {
      // Hold the patient row: the apply passes its job check (docA in the joined snapshot), then waits here.
      await t1.query('BEGIN');
      await t1.query(`SELECT 1 FROM patient_records WHERE id = $1 FOR UPDATE`, [f.pid]);
      const pending = apply(docA, f.shellJobId, 1, applyBody(f));
      await waitForLockWait(holderPool, APP);
      await t1.query(`UPDATE patient_records SET assigned_doctor_user_id = $2 WHERE id = $1`, [f.pid, docB.id]);
      await t1.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
    });
    expect((await patient(f.pid)).revision).toBe(1);
    expect(await job(f.shellJobId)).toMatchObject({ status: 'review_pending', applied_at: null });
  });

  it('a patient soft-deleted after the client read → 404 JOB_NOT_FOUND (the job join hides deleted patients)', async () => {
    const f = await seed();
    await holderPool.query(`UPDATE patient_records SET deleted_at = now() WHERE id = $1`, [f.pid]);
    const res = await apply(docA, f.shellJobId, 1, applyBody(f));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'JOB_NOT_FOUND', error: 'Job not found' });
  });

  it('a patient soft-deleted while the apply waits for it → 404 PATIENT_NOT_FOUND', async () => {
    const f = await seed();
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await t1.query(`SELECT 1 FROM patient_records WHERE id = $1 FOR UPDATE`, [f.pid]);
      const pending = apply(docA, f.shellJobId, 1, applyBody(f));
      await waitForLockWait(holderPool, APP);
      await t1.query(`UPDATE patient_records SET deleted_at = now() WHERE id = $1`, [f.pid]);
      await t1.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
    });
  });

  it('enforce: another user\'s lock → 423 with the holder, before the revision check (stale If-Match still 423)', async () => {
    const f = await seed();
    await holdLock(docB, f.pid);
    lockMode.mode = 'enforce';
    const res = await apply(docA, f.shellJobId, 99, applyBody(f));
    expect(res.status).toBe(423);
    expect(res.body).toEqual({
      code: 'LOCK_HELD', error: 'Currently being edited by Doc B',
      holder: { holderName: 'Doc B', acquiredAt: expect.any(String), expiresAt: expect.any(String) },
    });
    expect(Object.keys(res.body.holder)).toEqual(['holderName', 'acquiredAt', 'expiresAt']);
    expect((await patient(f.pid)).revision).toBe(1);
  });

  it('enforce: the caller\'s own lease token (X-Lock-Token) passes', async () => {
    const f = await seed();
    const token = await holdLock(docA, f.pid);
    lockMode.mode = 'enforce';
    expect((await apply(docA, f.shellJobId, 1, applyBody(f), { 'X-Lock-Token': token })).status).toBe(200);
  });

  it('enforce: an idempotent replay is answered before the lock check', async () => {
    const f = await seed();
    expect((await apply(docA, f.shellJobId, 1, applyBody(f))).status).toBe(200);
    await holdLock(docB, f.pid);
    lockMode.mode = 'enforce';
    const replay = await apply(docA, f.shellJobId, 1, applyBody(f));
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent).toBe(true);
  });

  it('observe: another user\'s lock does not block; a patient_lock_observed_block row with context video_analysis_apply', async () => {
    const f = await seed();
    await holdLock(docB, f.pid);
    lockMode.mode = 'observe';
    expect((await apply(docA, f.shellJobId, 1, applyBody(f))).status).toBe(200);
    expect(await auditRows('patient_lock_observed_block', f.pid)).toEqual([
      { actor: docA.id, outcome: 'success', extra: { holderName: 'Doc B', context: 'video_analysis_apply' } },
    ]);
  });

  // ---------------------------------------------------------------------------------------------
  // Source jobs and the recipe gate
  // ---------------------------------------------------------------------------------------------

  it('a source job of another patient → 400 INVALID_SOURCE_JOB, nothing written', async () => {
    const f = await seed();
    const other = await seed();
    const res = await apply(docA, f.shellJobId, 1, applyBody(f, { sourceAnalysisJobIds: [other.analysisJobId] }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 'INVALID_SOURCE_JOB', error: 'sourceAnalysisJobIds must reference completed analysis jobs of this patient' });
    expect(await job(other.analysisJobId)).toMatchObject({ status: 'review_pending' });
  });

  it('the shell job itself as a source → 400 INVALID_SOURCE_JOB', async () => {
    const f = await seed();
    const res = await apply(docA, f.shellJobId, 1, applyBody(f, { sourceAnalysisJobIds: [f.shellJobId] }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SOURCE_JOB');
  });

  it('recipe gate: appliedInputsCount mismatch → 400, patient and jobs unchanged', async () => {
    const f = await seed();
    const res = await apply(docA, f.shellJobId, 1, applyBody(f, { appliedInputsCount: 2 }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('APPLIED_INPUTS_COUNT_MISMATCH');
    expect((await patient(f.pid)).revision).toBe(1);
    expect(await job(f.shellJobId)).toMatchObject({ status: 'review_pending', applied_at: null });
    expect(await job(f.analysisJobId)).toMatchObject({ status: 'review_pending' });
  });

  it('recipe gate: a new video appliedInput without provenance → 400 (unverified recipes not allowed)', async () => {
    const f = await seed();
    const res = await apply(docA, f.shellJobId, 1,
      applyBody(f, { sourceAnalysisJobIds: [] }, appliedInput(f, { analysisJobIds: [] })));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROVENANCE_REQUIRED');
    expect((await patient(f.pid)).revision).toBe(1);
  });

  it('recipe gate: a recipe that differs from the stored source recipe → 400', async () => {
    const f = await seed();
    const res = await apply(docA, f.shellJobId, 1,
      applyBody(f, {}, appliedInput(f, { recipe: { ...RECIPE, modelVersion: 'tampered' } })));
    expect(res.status).toBe(400);
    expect(res.body.code).toMatch(/RECIPE/);
    expect((await patient(f.pid)).revision).toBe(1);
    expect(await job(f.analysisJobId)).toMatchObject({ status: 'review_pending' });
  });
});
