import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { ClipFeatureSetSchema } from '@wr/contracts';
import config from '../config';
import { resolveFixtureClip } from './fixturePath';

// ---------------------------------------------------------------------------
// 작업 영상 분석 job 워커 (6.0-6b, PR D1). dev-only fixture 영상을 입력으로 실제 추론을 돌려
// queued→processing→review_pending 상태머신을 실동작시킨다. 서버는 intrinsic ClipFeatureSet만
// result_features에 저장하고(검증 후), per-day 환산은 클라이언트가 수행한다.
//
// 동시 추론 1건(순차 큐). claim은 단일 트랜잭션 + FOR UPDATE SKIP LOCKED로 중복 처리를 막는다.
// 추론(Python subprocess)은 트랜잭션 밖에서 실행해 행 락을 오래 잡지 않는다.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const PROFILE_FPS: Record<string, number> = {
  'posture-basic': 5,
  'repetition-upper-limb': 12,
  'hand-wrist': 20,
};
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

export interface InferenceResult {
  clipFeatures: unknown; // ClipFeatureSetSchema 통과값
  preprocessConfigHash: string | null;
  inputSha256: string | null;
}

export interface WorkerDeps {
  // 추론 실행기(테스트에서 주입). 기본은 Python subprocess.
  runInference: (clipPath: string, profile: string | null) => Promise<InferenceResult>;
}

interface ClaimedJob {
  id: string;
  clip_id: string;
  analysis_profile: string | null;
}

// 기본 추론기: infer_clip.py → keypoints, feature_calc.py → clip_features. ClipFeatureSetSchema로 검증.
async function defaultRunInference(clipPath: string, profile: string | null): Promise<InferenceResult> {
  const fps = PROFILE_FPS[profile ?? 'posture-basic'] ?? 5;
  const scripts = config.video.scriptsDir;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'va-job-'));
  try {
    const kpPath = path.join(work, 'keypoints.json');
    const cfPath = path.join(work, 'clip_features.json');
    await execFileAsync(
      config.video.python,
      [path.join(scripts, 'infer_clip.py'), '--input', clipPath, '--output', kpPath, '--fps', String(fps)],
      { timeout: PROCESSING_TIMEOUT_MS },
    );
    await execFileAsync(
      config.video.python,
      [path.join(scripts, 'feature_calc.py'), '--keypoints', kpPath, '--output', cfPath],
      { timeout: PROCESSING_TIMEOUT_MS },
    );
    const kpRaw = fs.readFileSync(kpPath, 'utf-8');
    const cfRaw = fs.readFileSync(cfPath, 'utf-8');
    const clipFeatures = ClipFeatureSetSchema.parse(JSON.parse(cfRaw)); // 신뢰 경계 — 계약 검증
    const kpDoc = JSON.parse(kpRaw) as { model?: { preprocessConfigHash?: string } };
    return {
      clipFeatures,
      preprocessConfigHash: kpDoc?.model?.preprocessConfigHash ?? null,
      inputSha256: crypto.createHash('sha256').update(kpRaw).digest('hex'),
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// queued 1건을 단일 트랜잭션에서 claim(processing 전이). 동시/중복 워커가 같은 job을 못 집게 한다.
async function claimJob(pool: Pool): Promise<ClaimedJob | null> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<ClaimedJob>(
      `SELECT id, clip_id, analysis_profile
       FROM video_analysis_jobs
       WHERE status = 'queued'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    if (rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }
    const job = rows[0];
    await client.query(`UPDATE video_analysis_jobs SET status = 'processing' WHERE id = $1`, [job.id]);
    await client.query('COMMIT');
    return job;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// clip.upload_path(=fixture 절대경로) 로드 후 심층방어 재검증. 실패 시 null.
async function resolveJobClipPath(pool: Pool, clipId: string): Promise<string | null> {
  const { rows } = await pool.query<{ upload_path: string | null }>(
    `SELECT upload_path FROM video_analysis_clips WHERE id = $1`,
    [clipId],
  );
  const uploadPath = rows[0]?.upload_path;
  if (!uploadPath) return null;
  // basename만 취해 fixtureDir 안에서 다시 검증(저장된 경로가 변조됐어도 allowlist 밖이면 거부).
  return resolveFixtureClip(path.basename(uploadPath), config.video.fixtureDir);
}

// 정체/타임아웃 정리(최소 TTL): processing 타임아웃 → error, queued 정체 → expired.
// review_pending은 검수 보존을 위해 자동 만료 제외(적용 시 done 전이는 apply 핸들러가 담당).
async function sweepStale(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE video_analysis_jobs
       SET status = 'error', error_code = 'TIMEOUT', error_message = 'processing exceeded timeout'
     WHERE status = 'processing' AND updated_at < now() - interval '5 minutes'`,
  );
  await pool.query(
    `UPDATE video_analysis_jobs SET status = 'expired'
     WHERE status = 'queued' AND created_at < now() - interval '1 hour'`,
  );
}

/**
 * queued job 1건을 처리한다. 처리했으면 true, 큐가 비었으면 false.
 * 추론은 claim 트랜잭션 밖에서 실행(락 미보유). 성공→review_pending, 실패→error.
 */
export async function pollOnce(pool: Pool, deps: WorkerDeps): Promise<boolean> {
  await sweepStale(pool);
  const job = await claimJob(pool);
  if (!job) return false;

  try {
    const clipPath = await resolveJobClipPath(pool, job.clip_id);
    if (!clipPath) {
      throw Object.assign(new Error('fixture clip unavailable or outside allowlist'), { code: 'FIXTURE_UNAVAILABLE' });
    }
    const result = await deps.runInference(clipPath, job.analysis_profile);
    await pool.query(
      `UPDATE video_analysis_jobs
         SET status = 'review_pending', result_features = $2,
             preprocess_config_hash = $3, analysis_input_sha256 = $4
       WHERE id = $1`,
      [job.id, JSON.stringify(result.clipFeatures), result.preprocessConfigHash, result.inputSha256],
    );
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'INFERENCE_ERROR';
    const message = String((err as Error)?.message ?? err).slice(0, 500);
    await pool.query(
      `UPDATE video_analysis_jobs SET status = 'error', error_code = $2, error_message = $3 WHERE id = $1`,
      [job.id, code, message],
    );
  }
  return true;
}

/**
 * 영상 분석 fixture 워커를 시작한다(2초 간격). 이전 틱이 진행 중이면 skip(재진입 방지).
 * config.videoAnalysisEnabled && config.video.fixtureMode일 때만 등록할 것.
 */
export function createVideoAnalysisWorker(pool: Pool, deps: Partial<WorkerDeps> = {}): { stop: () => void } {
  const merged: WorkerDeps = { runInference: defaultRunInference, ...deps };
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // 큐를 비울 때까지 순차 처리(동시 1건).
      let processed = true;
      while (processed) processed = await pollOnce(pool, merged);
    } catch (err) {
      console.error('[wr-server] video-analysis-worker error', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 2000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
