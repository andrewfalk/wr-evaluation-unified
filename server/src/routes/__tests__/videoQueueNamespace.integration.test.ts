// S8-c: video analysis stays inside its queue namespace, against real PostgreSQL. Two servers sharing one database
// (and possibly one upload directory) must not reach, apply, claim, sweep or clean each other's clips and jobs.
// The routes use config.queueNamespace ('itest' in the integration env); the worker and the cleanup take it as an
// argument. Every test is "the other namespace's row stays as it was" plus the control that its own path acts on it.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { VIDEO_MAPPING_CONFIG_VERSION, VIDEO_VIEWPOINT_CONFIG_VERSION } from '@wr/contracts';

const state = vi.hoisted(() => ({ uploadDir: null as string | null }));
vi.mock('../../config', async (importOriginal) => {
  const actualModule = await importOriginal<typeof import('../../config')>();
  const actual = actualModule.default;
  const video = { ...actual.video, allowUnverifiedRecipe: false };
  Object.defineProperty(video, 'uploadDir', { get: () => state.uploadDir, enumerable: true });
  const cfg = { ...actual, videoAnalysisEnabled: true, video };
  Object.defineProperty(cfg, 'lockEnforcementMode', { get: () => 'off', enumerable: true });
  return { ...actualModule, default: cfg };
});

import config from '../../config';
import { createVideoAnalysisRouter } from '../videoAnalysis';
import { makeRouterApp } from '../../testing/app';
import { pollOnce } from '../../workers/videoAnalysisWorker';
import { runVideoClipCleanup } from '../../jobs/videoClipCleanup';
import {
  createIntegrationOrg, integrationPool, waitForLockWait, TEST_DATABASE_URL, type IntegrationOrg, type IntegrationUser,
} from '../../testing/integrationDb';

const OTHER = 'ns-other';
const RECIPE = {
  status: 'verified', modelVersion: 'rtmlib-0.0.15',
  detectorSha256: 'a'.repeat(64), poseSha256: 'b'.repeat(64),
  preprocessConfigHash: 'pch', featureConfigVersion: 'fc-1',
  mappingConfigVersion: VIDEO_MAPPING_CONFIG_VERSION, viewpointConfigVersion: VIDEO_VIEWPOINT_CONFIG_VERSION,
  codeCommit: 'abc1234',
};

describe.skipIf(!TEST_DATABASE_URL)('video analysis queue namespace isolation (S8-c, real PostgreSQL)', () => {
  let pool: Pool;
  let org: IntegrationOrg;
  let doc: IntegrationUser;
  const OWN = config.queueNamespace;

  beforeAll(async () => {
    pool = integrationPool('wr-itest-video-queue-ns');
    org = await createIntegrationOrg(pool, 'video-queue-ns');
    doc = await org.makeUser('doctor', 'NS Doc');
  });

  afterEach(async () => {
    await org.resetData();
    if (state.uploadDir) fs.rmSync(state.uploadDir, { recursive: true, force: true });
    state.uploadDir = null;
  });

  afterAll(async () => {
    if (!pool) return;
    await org?.destroy();
    await pool.end();
  });

  const app = () => makeRouterApp((a) => { a.use('/api/video-analysis', createVideoAnalysisRouter(pool)); });

  async function seedPatient(): Promise<string> {
    const pid = crypto.randomUUID();
    const person = await pool.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, name) VALUES ($1, '영상 환자') RETURNING id`, [org.orgId],
    );
    await pool.query(
      `INSERT INTO patient_records (id, organization_id, owner_user_id, assigned_doctor_user_id, patient_person_id, name, revision, payload)
       VALUES ($1, $2, $3, $3, $4, '영상 환자', 1, $5)`,
      [pid, org.orgId, doc.id, person.rows[0].id,
        JSON.stringify({ id: pid, phase: 'intake', data: { shared: { name: '영상 환자' }, modules: {}, activeModules: [] } })],
    );
    return pid;
  }

  async function insertClip(pid: string, ns: string, extra: { sourceType?: string; fileState?: string } = {}): Promise<string> {
    return (await pool.query<{ id: string }>(
      `INSERT INTO video_analysis_clips (organization_id, patient_record_id, process_id, source_type, file_state, queue_namespace)
       VALUES ($1, $2, 'p1', $3, $4, $5) RETURNING id`,
      [org.orgId, pid, extra.sourceType ?? 'upload', extra.fileState ?? 'none', ns],
    )).rows[0].id;
  }

  /** A job on `clipId`: by default a finished per-process analysis job (review_pending, result + recipe). */
  async function insertJob(pid: string, clipId: string, ns: string, extra: { status?: string; shell?: boolean; createdAt?: Date; updatedAt?: Date } = {}): Promise<string> {
    const shell = extra.shell === true;
    return (await pool.query<{ id: string }>(
      `INSERT INTO video_analysis_jobs
         (organization_id, patient_record_id, clip_id, process_id, status, analysis_profile,
          requested_features, result_features, preprocess_config_hash, analysis_recipe, queue_namespace, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'posture-basic', $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [org.orgId, pid, clipId, shell ? null : 'p1', extra.status ?? 'review_pending',
        shell ? null : JSON.stringify(['overheadHours']), shell ? null : JSON.stringify({ schemaVersion: 1, features: {} }),
        shell ? null : 'pch', shell ? null : JSON.stringify(RECIPE), ns,
        extra.createdAt ?? new Date(), extra.updatedAt ?? new Date()],
    )).rows[0].id;
  }

  const job = async (id: string) => (await pool.query(`SELECT * FROM video_analysis_jobs WHERE id = $1`, [id])).rows[0];
  const clip = async (id: string) => (await pool.query(`SELECT * FROM video_analysis_clips WHERE id = $1`, [id])).rows[0];
  const post = (url: string, body: object = {}) => request(app()).post(`/api/video-analysis${url}`).set(org.headers(doc)).send(body);
  const get = (url: string) => request(app()).get(`/api/video-analysis${url}`).set(org.headers(doc));

  describe('clip routes (loadAccessibleClip)', () => {
    it("another namespace's clip is 404 on create-job, sample-detect, sample-frame and select-target; this server's is not", async () => {
      const pid = await seedPatient();
      const other = await insertClip(pid, OTHER);
      const own = await insertClip(pid, OWN);

      for (const [res, label] of [
        [await post('/jobs', { clipId: other, processId: 'p1' }), 'create-job'],
        [await post(`/clips/${other}/sample-detect`), 'sample-detect'],
        [await get(`/clips/${other}/sample-frame`), 'sample-frame'],
        [await post(`/clips/${other}/select-target`, { targetPersonId: 'person-1' }), 'select-target'],
      ] as const) {
        expect({ label, status: res.status, code: res.body.code }).toEqual({ label, status: 404, code: 'CLIP_NOT_FOUND' });
      }
      expect(await clip(other)).toMatchObject({ target_person_id: null, sample_detect_result: null });
      const { rows: jobsOfOther } = await pool.query(`SELECT 1 FROM video_analysis_jobs WHERE clip_id = $1`, [other]);
      expect(jobsOfOther).toEqual([]);

      // control: this server's clip passes the access check (sample-detect then stops at "no upload yet")
      expect((await post(`/clips/${own}/sample-detect`)).body.code).toBe('NO_UPLOAD');
    });

    it("a job created from this server's clip carries the clip's namespace", async () => {
      const pid = await seedPatient();
      const own = await insertClip(pid, OWN, { sourceType: 'apply_shell' });
      const res = await post('/jobs', { clipId: own, processId: 'p1' });
      expect(res.status).toBe(201);
      expect((await job(res.body.id ?? res.body.jobId)).queue_namespace).toBe(OWN);
    });
  });

  describe('job routes (loadAccessibleJob) and apply', () => {
    it("another namespace's job is 404 on get, overlay and close-review, and its artifact paths stay", async () => {
      const pid = await seedPatient();
      const other = await insertJob(pid, await insertClip(pid, OTHER), OTHER);
      await pool.query(`UPDATE video_analysis_jobs SET keypoints_path = '/x/k.json' WHERE id = $1`, [other]);

      for (const res of [await get(`/jobs/${other}`), await get(`/jobs/${other}/overlay`), await post(`/jobs/${other}/close-review`)]) {
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 404, code: 'JOB_NOT_FOUND' });
      }
      expect((await job(other)).keypoints_path).toBe('/x/k.json');

      const own = await insertJob(pid, await insertClip(pid, OWN), OWN);
      expect((await get(`/jobs/${own}`)).status).toBe(200);
    });

    function applyBody(clipId: string, sourceJobId: string, shellJobId: string) {
      const input = {
        moduleId: 'shoulder', targetPath: 'modules.shoulder.jobExtras[sharedJobId=job-1].overheadHours',
        suggestedValue: 1.8, appliedValue: 1.8, previousValue: null, unit: 'hours_per_day',
        source: 'video', processIds: ['p1'], clipIds: [clipId], analysisJobIds: [sourceJobId], confidence: 0.8,
        analysisBundleVersion: 'itest-bundle', recipe: RECIPE, appliedAt: '2026-01-01T00:00:00.000Z', appliedBy: doc.id,
      };
      return {
        data: { shared: { name: '영상 환자', videoAnalysis: { appliedInputs: [input] } }, modules: {}, activeModules: [] },
        appliedInputsHash: `hash-${shellJobId}`, appliedInputsCount: 1, sourceAnalysisJobIds: [sourceJobId],
      };
    }
    const apply = (jobId: string, body: object) =>
      request(app()).post(`/api/video-analysis/jobs/${jobId}/apply`).set(org.headers(doc)).set('If-Match', '1').send(body);

    it("apply on another namespace's job → 404 JOB_NOT_FOUND and the job is untouched", async () => {
      const pid = await seedPatient();
      const otherClip = await insertClip(pid, OTHER, { sourceType: 'apply_shell' });
      const source = await insertJob(pid, otherClip, OTHER);
      const shell = await insertJob(pid, otherClip, OTHER, { shell: true });

      const res = await apply(shell, applyBody(otherClip, source, shell));
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 404, code: 'JOB_NOT_FOUND' });
      expect(await job(shell)).toMatchObject({ status: 'review_pending', applied_at: null });
      expect((await pool.query(`SELECT revision FROM patient_records WHERE id = $1`, [pid])).rows[0].revision).toBe(1);
    });

    it("another namespace's job as a source job → 400 INVALID_SOURCE_JOB and it stays review_pending; this server's source applies", async () => {
      const pid = await seedPatient();
      const ownClip = await insertClip(pid, OWN, { sourceType: 'apply_shell' });
      const shell = await insertJob(pid, ownClip, OWN, { shell: true });
      const otherSource = await insertJob(pid, await insertClip(pid, OTHER), OTHER);

      const res = await apply(shell, applyBody(ownClip, otherSource, shell));
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 400, code: 'INVALID_SOURCE_JOB' });
      expect(await job(otherSource)).toMatchObject({ status: 'review_pending', applied_at: null });

      // control: the same body with a source job of this namespace applies and consumes it
      const ownSource = await insertJob(pid, ownClip, OWN);
      const ok = await apply(shell, applyBody(ownClip, ownSource, shell));
      expect(ok.status).toBe(200);
      expect((await job(ownSource)).status).toBe('done');
      expect((await job(otherSource)).status).toBe('review_pending');
    });
  });

  describe('worker (pollOnce)', () => {
    const deps = { runInference: vi.fn() };

    it("a worker of another namespace does not claim this namespace's queued job; its own worker does", async () => {
      const pid = await seedPatient();
      const queued = await insertJob(pid, await insertClip(pid, OWN, { sourceType: 'apply_shell' }), OWN, { status: 'queued' });

      expect(await pollOnce(pool, deps, OTHER)).toBe(false);
      expect((await job(queued)).status).toBe('queued');

      // its own worker claims it (and fails it: an apply_shell clip has no file to analyse)
      expect(await pollOnce(pool, deps, OWN)).toBe(true);
      expect(await job(queued)).toMatchObject({ status: 'error', error_code: 'CLIP_UNAVAILABLE' });
      expect(deps.runInference).not.toHaveBeenCalled();
    });

    it("the timeout and queue-expiry sweeps of another namespace leave this namespace's jobs as they were", async () => {
      const pid = await seedPatient();
      const clipId = await insertClip(pid, OWN, { sourceType: 'apply_shell' });
      const longAgo = new Date(Date.now() - 24 * 3600_000);
      const processing = await insertJob(pid, clipId, OWN, { status: 'processing', updatedAt: longAgo });
      const stale = await insertJob(pid, clipId, OWN, { status: 'queued', createdAt: longAgo });

      await pollOnce(pool, deps, OTHER);
      expect((await job(processing)).status).toBe('processing');
      expect((await job(stale)).status).toBe('queued');

      await pollOnce(pool, deps, OWN);
      expect(await job(processing)).toMatchObject({ status: 'error', error_code: 'TIMEOUT' });
      expect((await job(stale)).status).toBe('expired');
    });
  });

  describe('cleanup (runVideoClipCleanup)', () => {
    /** An expired upload clip with its original and thumbnail, and a job with keypoints and a frames directory. */
    async function seedExpired(pid: string, ns: string, dir: string) {
      const clipId = await insertClip(pid, ns);
      const original = path.join(dir, `${clipId}.bin`);
      const thumb = path.join(dir, 'artifacts', `${clipId}.${crypto.randomUUID()}.thumb.jpg`);
      fs.writeFileSync(original, 'x');
      fs.writeFileSync(thumb, 'x');
      await pool.query(
        `UPDATE video_analysis_clips SET upload_path = $2, sample_frame_path = $3, file_state = 'present',
           expires_at = now() - interval '1 minute' WHERE id = $1`,
        [clipId, original, thumb],
      );
      const jobId = await insertJob(pid, clipId, ns);
      const keypoints = path.join(dir, 'artifacts', `${jobId}.keypoints.json`);
      const frames = path.join(dir, 'artifacts', `${jobId}.frames`);
      fs.writeFileSync(keypoints, '{}');
      fs.mkdirSync(frames);
      fs.writeFileSync(path.join(frames, '0.jpg'), 'x');
      await pool.query(`UPDATE video_analysis_jobs SET keypoints_path = $2, keypoints_sha256 = 'k', frames_path = $3 WHERE id = $1`,
        [jobId, keypoints, frames]);
      return { clipId, jobId, files: [original, thumb, keypoints, frames] };
    }
    const exists = (files: string[]) => files.map((f) => fs.existsSync(f));

    it("cleans only its namespace's expired clips and jobs; the other namespace's rows and files (shared upload dir) stay", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-ns-clean-'));
      fs.mkdirSync(path.join(dir, 'artifacts'));
      fs.mkdirSync(path.join(dir, 'tmp'));
      state.uploadDir = dir;
      const pid = await seedPatient();
      const own = await seedExpired(pid, OWN, dir);
      const other = await seedExpired(pid, OTHER, dir);

      const res = await runVideoClipCleanup(pool, OWN);

      expect(res).toMatchObject({ clipsExpired: 1, originalsDeleted: 1, artifactsDeleted: 1, sampleFramesDeleted: 1, framesDirsDeleted: 1, orphansDeleted: 0 });
      expect(exists(own.files)).toEqual([false, false, false, false]);
      expect(await clip(own.clipId)).toMatchObject({ upload_path: null, sample_frame_path: null, file_state: 'deleted' });
      expect(await job(own.jobId)).toMatchObject({ keypoints_path: null, frames_path: null });

      // the other namespace's: rows untouched, and its files survive both the expiry steps and the orphan sweep
      expect(exists(other.files)).toEqual([true, true, true, true]);
      expect(await clip(other.clipId)).toMatchObject({ file_state: 'present', upload_path: other.files[0], sample_frame_path: other.files[1] });
      expect(await job(other.jobId)).toMatchObject({ keypoints_path: other.files[2], frames_path: other.files[3] });

      // control: its own cleanup removes them
      await runVideoClipCleanup(pool, OTHER);
      expect(exists(other.files)).toEqual([false, false, false, false]);
    });

    // A row that changes between the cleanup's SELECT and its UPDATE (here: another cleanup of the same namespace
    // clears the path first) is not this run's — its UPDATE re-checks the path, changes nothing, and the run neither
    // removes the file nor counts it. Deterministic: a holder transaction locks the row, the cleanup's UPDATE waits on
    // it (pg_stat_activity), the holder clears the path and commits.
    it.each([
      ['originals', 'clip', `UPDATE video_analysis_clips SET upload_path = NULL, file_state = 'deleted' WHERE id = $1`, 'originalsDeleted'],
      ['keypoints', 'job', `UPDATE video_analysis_jobs SET keypoints_path = NULL, keypoints_sha256 = NULL WHERE id = $1`, 'artifactsDeleted'],
      ['thumbnail', 'clip', `UPDATE video_analysis_clips SET sample_frame_path = NULL WHERE id = $1`, 'sampleFramesDeleted'],
      ['frames dir', 'job', `UPDATE video_analysis_jobs SET frames_path = NULL WHERE id = $1`, 'framesDirsDeleted'],
    ] as const)('%s: a path cleared after the SELECT is not deleted or counted by this run', async (step, table, clear, counter) => {
      const CLEAN_APP = 'wr-itest-video-ns-cleanup';
      const cleanPool = integrationPool(CLEAN_APP, { max: 2 });
      const holderPool = integrationPool('wr-itest-video-ns-holder', { max: 2 });
      try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-ns-race-'));
        fs.mkdirSync(path.join(dir, 'artifacts'));
        fs.mkdirSync(path.join(dir, 'tmp'));
        state.uploadDir = dir;
        const pid = await seedPatient();
        // Only the step under test has work: an apply_shell clip is not an original (step 1 skips it).
        const clipId = await insertClip(pid, OWN, { sourceType: step === 'originals' ? 'upload' : 'apply_shell' });
        const jobId = await insertJob(pid, clipId, OWN);
        await pool.query(`UPDATE video_analysis_clips SET expires_at = now() - interval '1 minute' WHERE id = $1`, [clipId]);
        if (step === 'originals') {
          const p = path.join(dir, `${clipId}.bin`);
          fs.writeFileSync(p, 'x');
          await pool.query(`UPDATE video_analysis_clips SET upload_path = $2, file_state = 'present' WHERE id = $1`, [clipId, p]);
        } else if (step === 'thumbnail') {
          const p = path.join(dir, 'artifacts', `${clipId}.${crypto.randomUUID()}.thumb.jpg`);
          fs.writeFileSync(p, 'x');
          await pool.query(`UPDATE video_analysis_clips SET sample_frame_path = $2 WHERE id = $1`, [clipId, p]);
        } else if (step === 'keypoints') {
          const p = path.join(dir, 'artifacts', `${jobId}.keypoints.json`);
          fs.writeFileSync(p, '{}');
          await pool.query(`UPDATE video_analysis_jobs SET keypoints_path = $2, keypoints_sha256 = 'k' WHERE id = $1`, [jobId, p]);
        } else {
          const p = path.join(dir, 'artifacts', `${jobId}.frames`);
          fs.mkdirSync(p);
          await pool.query(`UPDATE video_analysis_jobs SET frames_path = $2 WHERE id = $1`, [jobId, p]);
        }
        const rowId = table === 'clip' ? clipId : jobId;

        const holder = await holderPool.connect();
        try {
          await holder.query('BEGIN');
          await holder.query(`SELECT 1 FROM video_analysis_${table === 'clip' ? 'clips' : 'jobs'} WHERE id = $1 FOR UPDATE`, [rowId]);
          const cleanup = runVideoClipCleanup(cleanPool, OWN);
          await waitForLockWait(pool, CLEAN_APP);
          await holder.query(clear, [rowId]);
          await holder.query('COMMIT');
          const res = await cleanup;
          expect(res[counter]).toBe(0);
          if (step === 'originals') expect(res.clipsExpired).toBe(0);
        } finally {
          await holder.query('ROLLBACK').catch(() => {});
          holder.release();
        }
      } finally {
        await cleanPool.end();
        await holderPool.end();
      }
    });
  });
});
