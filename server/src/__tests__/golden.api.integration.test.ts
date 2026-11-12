// Golden (characterization) test G5 — the real app (createApp) against a real PostgreSQL: the JSON
// responses of the core patient and workspace API paths, frozen with ids and timestamps normalised.
// REFACTORING_ROADMAP P0-9. Runs in the integration project (`npm run check:full` provides the
// throwaway wr_test database). Update the golden only for an intended API change, never in a
// refactor: `npx vitest run --config vitest.integration.config.ts -u <this file>` + reason in the PR.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app';
// S8: the video fixtures are rows of this server's queue namespace (the routes only see their own).
import config from '../config';
import { generateAccessToken } from '../auth/tokens';
import { hashToken, generateToken } from '../auth/tokenHash';
import { VIDEO_MAPPING_CONFIG_VERSION, VIDEO_VIEWPOINT_CONFIG_VERSION } from '@wr/contracts';

// The video-analysis routes answer 404 unless the feature flag is on. config.ts reads the env once
// at import, so set it before any import (vi.hoisted runs first). It does not change the patient
// and workspace responses frozen in the first test.
vi.hoisted(() => { process.env.VIDEO_ANALYSIS_ENABLED = 'true'; });

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const CSRF_TOKEN = 'golden-api-csrf';
const GOLDEN_PATIENTS = path.resolve(__dirname, '../../../src/core/fixtures/goldenPatients.json');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const LEASE_TOKEN = /^[0-9a-f]{64}$/; // random lease token returned by POST /api/patients/:id/lock

// Replace every UUID with a stable placeholder (same UUID → same placeholder, in order of first
// appearance), every timestamp with <time> and every lock lease token with <lease-token>, so the golden holds the response SHAPE and VALUES
// that do not depend on when or where the test ran.
function normalise(value: unknown, ids = new Map<string, string>()): unknown {
  if (Array.isArray(value)) return value.map((v) => normalise(v, ids));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalise(v, ids)]));
  }
  if (typeof value === 'string') {
    if (UUID.test(value)) {
      if (!ids.has(value)) ids.set(value, `<uuid-${ids.size + 1}>`);
      return ids.get(value);
    }
    if (ISO_TIME.test(value)) return '<time>';
    if (LEASE_TOKEN.test(value)) return '<lease-token>';
  }
  return value;
}

describe.skipIf(!TEST_DB_URL)('G5 — patient and workspace API responses (real PostgreSQL)', () => {
  let pool: Pool;
  let app: Express;
  let orgId: string;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    app = createApp({ pool, auditPool: pool });
    orgId = (await pool.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('__golden_api_org__') RETURNING id`)).rows[0].id;
    userId = (await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id) VALUES ($1,'x','골든 의사','doctor',$2) RETURNING id`,
      [`__golden_api_${crypto.randomUUID()}__`, orgId],
    )).rows[0].id;
    const sessionId = crypto.randomUUID();
    const csrfHash = hashToken(CSRF_TOKEN);
    await pool.query(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, csrf_token_hash, expires_at, family_id)
       VALUES ($1,$2,$3,$4, now() + interval '1 day', $5)`,
      [sessionId, userId, hashToken(generateToken()), csrfHash, crypto.randomUUID()],
    );
    token = generateAccessToken({ sub: userId, sessionId, orgId, role: 'doctor', name: '골든 의사', mustChangePassword: false, csrfHash }).token;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM patient_locks WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_records WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_persons WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM workspaces WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
  });

  const auth = (req: request.Test) => req.set('Authorization', `Bearer ${token}`).set('X-CSRF-Token', CSRF_TOKEN);

  it('patients: create → list → read → update → lock → delete; workspaces: save → list → read → update → delete', async () => {
    const [knee, elbow] = (() => {
      const all = JSON.parse(fs.readFileSync(GOLDEN_PATIENTS, 'utf8')) as Array<{ id: string; data: { activeModules: string[] } }>;
      const pick = (m: string) => all.find((p) => p.data.activeModules.includes(m))!;
      // The server assigns the doctor by matching data.shared.doctorName to a user's name; use this
      // test's doctor so the assigned-doctor paths (update, lock, delete) run instead of 403.
      return [pick('knee'), pick('elbow')].map((p) => {
        const copy = JSON.parse(JSON.stringify(p));
        copy.data.shared.doctorName = '골든 의사';
        return copy;
      });
    })();
    const steps: Array<{ step: string; status: number; body: unknown }> = [];
    const record = (step: string, res: request.Response) => steps.push({ step, status: res.status, body: res.body });

    // --- patients ---
    const created = await auth(request(app).post('/api/patients'))
      .set('Idempotency-Key', 'golden-create-1')
      .send({ id: knee.id, phase: 'intake', data: knee.data });
    record('POST /api/patients', created);
    const pid = created.body?.id ?? knee.id;

    record('GET /api/patients', await auth(request(app).get('/api/patients')));
    record('GET /api/patients/:id', await auth(request(app).get(`/api/patients/${pid}`)));

    const changed = JSON.parse(JSON.stringify(knee.data));
    changed.shared.name = `${changed.shared.name}(수정)`;
    record('PATCH /api/patients/:id', await auth(request(app).patch(`/api/patients/${pid}`)).set('If-Match', '1').send({ data: changed }));
    record('PATCH /api/patients/:id (stale If-Match)', await auth(request(app).patch(`/api/patients/${pid}`)).set('If-Match', '1').send({ data: changed }));

    const acquired = await auth(request(app).post(`/api/patients/${pid}/lock`)).send({ clientInstanceId: '11111111-1111-4111-8111-111111111111' });
    record('POST /api/patients/:id/lock', acquired);
    const leaseToken = acquired.body?.leaseToken;
    expect(leaseToken, 'leaseToken from POST /api/patients/:id/lock').toBeTruthy();
    record('GET /api/patients/:id/lock', await auth(request(app).get(`/api/patients/${pid}/lock`)));
    // Release answers 204 with or without a valid token, so a GET after each release records
    // whether the lock is actually gone.
    record('DELETE /api/patients/:id/lock (no token)', await auth(request(app).delete(`/api/patients/${pid}/lock`)).send({}));
    record('GET /api/patients/:id/lock (after release without token)', await auth(request(app).get(`/api/patients/${pid}/lock`)));
    record('DELETE /api/patients/:id/lock', await auth(request(app).delete(`/api/patients/${pid}/lock`)).set('X-Lock-Token', leaseToken).send({}));
    record('GET /api/patients/:id/lock (after release)', await auth(request(app).get(`/api/patients/${pid}/lock`)));

    // --- workspaces (saving a workspace also writes patient_records) ---
    const saved = await auth(request(app).post('/api/workspaces')).send({ name: '골든 워크스페이스', patients: [{ ...elbow }] });
    record('POST /api/workspaces', saved);
    const wid = saved.body?.items?.[0]?.id;
    expect(wid, 'workspace id from POST /api/workspaces').toBeTruthy();
    record('GET /api/workspaces', await auth(request(app).get('/api/workspaces')));
    {
      record('GET /api/workspaces/:id', await auth(request(app).get(`/api/workspaces/${wid}`)));
      record('PUT /api/workspaces/:id', await auth(request(app).put(`/api/workspaces/${wid}`)).send({ name: '골든 워크스페이스(수정)', patients: [] }));
      record('DELETE /api/workspaces/:id', await auth(request(app).delete(`/api/workspaces/${wid}`)).send({}));
    }

    record('DELETE /api/patients/:id (no revision)', await auth(request(app).delete(`/api/patients/${pid}`)).send({}));
    record('DELETE /api/patients/:id', await auth(request(app).delete(`/api/patients/${pid}?revision=2`)).send({}));

    const ids = new Map<string, string>([[orgId, '<org>'], [userId, '<user>']]);
    await expect(JSON.stringify(normalise(steps, ids), null, 2) + '\n').toMatchFileSnapshot('./__goldens__/api-patients-workspaces.json');
  });

  // REFACTORING_ROADMAP P1-08 — frozen BEFORE routes/videoAnalysis.ts is touched in S1. The apply path
  // the client uses (patientServerRepository.js applyVideoAnalysisJob): a per-process analysis job in
  // review_pending with a stored, verified recipe + an apply shell job; POST /jobs/:shellId/apply with
  // the patient's whole new data (an appliedInputs entry pointing at the analysis job), then the
  // replay, a second apply on the consumed job, a missing If-Match, and the patient and job reads.
  it('video analysis: apply → idempotent replay → re-apply rejected → patient and jobs read', async () => {
    const all = JSON.parse(fs.readFileSync(GOLDEN_PATIENTS, 'utf8')) as Array<{ id: string }>;
    const shoulder = JSON.parse(JSON.stringify(all.find((p) => p.id === '00000000-0000-4000-8000-000000000118')!));
    shoulder.data.shared.doctorName = '골든 의사'; // assigned to this test's doctor (apply needs the assigned doctor)
    const sharedJobId: string = shoulder.data.shared.jobs[0].id;
    const steps: Array<{ step: string; status: number; body: unknown }> = [];
    const record = (step: string, res: request.Response) => steps.push({ step, status: res.status, body: res.body });

    const created = await auth(request(app).post('/api/patients'))
      .set('Idempotency-Key', 'golden-video-create-1')
      .send({ id: shoulder.id, phase: shoulder.phase ?? 'intake', data: shoulder.data });
    expect(created.status, 'POST /api/patients').toBe(201);
    const pid: string = created.body.id;
    const revision: number = created.body.sync.revision; // the client sends sync.revision as If-Match
    expect(revision, 'sync.revision from POST /api/patients').toBe(1);

    // Rows the worker and the client flow would have created (sample-detect, target selection and
    // inference are outside this golden). Columns: 0016 + 0017 (source_type, file_state) + 0021
    // (analysis_recipe); every other column keeps its default.
    const recipe = {
      status: 'verified', modelVersion: 'rtmlib-0.0.15',
      detectorSha256: 'a'.repeat(64), poseSha256: 'b'.repeat(64),
      preprocessConfigHash: 'pch', featureConfigVersion: 'fc-1',
      mappingConfigVersion: VIDEO_MAPPING_CONFIG_VERSION, viewpointConfigVersion: VIDEO_VIEWPOINT_CONFIG_VERSION,
      codeCommit: 'abc1234',
    };
    const clipId = (await pool.query<{ id: string }>(
      `INSERT INTO video_analysis_clips (organization_id, patient_record_id, process_id, source_type, file_state, queue_namespace)
       VALUES ($1, $2, 'p1', 'apply_shell', 'none', $3) RETURNING id`,
      [orgId, pid, config.queueNamespace],
    )).rows[0].id;
    const analysisJobId = (await pool.query<{ id: string }>(
      `INSERT INTO video_analysis_jobs
         (organization_id, patient_record_id, clip_id, process_id, status, analysis_profile,
          requested_features, result_features, preprocess_config_hash, analysis_recipe, queue_namespace)
       VALUES ($1, $2, $3, 'p1', 'review_pending', 'posture-basic', $4, $5, 'pch', $6, $7) RETURNING id`,
      [orgId, pid, clipId, JSON.stringify(['overheadHours']), JSON.stringify({ schemaVersion: 1, features: {} }), JSON.stringify(recipe), config.queueNamespace],
    )).rows[0].id;
    const shellJobId = (await pool.query<{ id: string }>(
      `INSERT INTO video_analysis_jobs (organization_id, patient_record_id, clip_id, status, analysis_profile, queue_namespace)
       VALUES ($1, $2, $3, 'review_pending', 'posture-basic', $4) RETURNING id`,
      [orgId, pid, clipId, config.queueNamespace],
    )).rows[0].id;

    const newData = JSON.parse(JSON.stringify(shoulder.data));
    newData.shared.videoAnalysis = {
      appliedInputs: [{
        moduleId: 'shoulder', targetPath: `modules.shoulder.jobExtras[sharedJobId=${sharedJobId}].overheadHours`,
        suggestedValue: 1.8, appliedValue: 1.8, previousValue: null, unit: 'hours_per_day',
        source: 'video', processIds: ['p1'], clipIds: [clipId], analysisJobIds: [analysisJobId], confidence: 0.8,
        analysisBundleVersion: 'golden-bundle', recipe, appliedAt: '2026-01-01T00:00:00.000Z', appliedBy: userId,
      }],
    };
    const applyBody = {
      data: newData, appliedInputsHash: 'golden-applied-inputs-1', appliedInputsCount: 1, sourceAnalysisJobIds: [analysisJobId],
      modulesCompleteObserved: false, completionClientBuildVersion: 'golden-build', completionClientSchemaVersion: 1,
    };
    const apply = (body: object) =>
      auth(request(app).post(`/api/video-analysis/jobs/${shellJobId}/apply`)).set('If-Match', String(revision)).send(body);

    record('POST /api/video-analysis/jobs/:shellId/apply', await apply(applyBody));
    record('POST /api/video-analysis/jobs/:shellId/apply (same hash → idempotent replay)', await apply(applyBody));
    record('POST /api/video-analysis/jobs/:shellId/apply (new hash on a done job)', await apply({ ...applyBody, appliedInputsHash: 'golden-applied-inputs-2' }));
    record('POST /api/video-analysis/jobs/:shellId/apply (no If-Match)',
      await auth(request(app).post(`/api/video-analysis/jobs/${shellJobId}/apply`)).send(applyBody));
    record('GET /api/patients/:id (after apply)', await auth(request(app).get(`/api/patients/${pid}`)));
    record('GET /api/video-analysis/jobs/:analysisId', await auth(request(app).get(`/api/video-analysis/jobs/${analysisJobId}`)));
    record('GET /api/video-analysis/jobs/:shellId', await auth(request(app).get(`/api/video-analysis/jobs/${shellJobId}`)));

    // Guard the scenario itself, so a broken fixture cannot be frozen as the golden.
    expect(steps.map((s) => s.status), 'apply, replay, re-apply, no If-Match, reads').toEqual([200, 200, 409, 400, 200, 200, 200]);
    expect((steps[1].body as { idempotent?: boolean }).idempotent, 'replay is idempotent').toBe(true);

    const ids = new Map<string, string>([[orgId, '<org>'], [userId, '<user>']]);
    await expect(JSON.stringify(normalise(steps, ids), null, 2) + '\n').toMatchFileSnapshot('./__goldens__/api-video-apply.json');
  });
});
