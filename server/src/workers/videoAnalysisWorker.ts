import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { ClipFeatureSetSchema, SampleDetectResultSchema } from '@wr/contracts';
import { VIDEO_MAPPING_CONFIG_VERSION, VIDEO_VIEWPOINT_CONFIG_VERSION } from '@wr/contracts';
import type { AnalysisRecipe } from '@wr/contracts';
import config from '../config';
import { resolveFixtureClip, resolveUploadedClipPath, resolveSampleFramePath } from './fixturePath';

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
  keypointsJson: string | null; // keypoints 원문(좌표만). overlay 검수용 artifact로 영속(M3-7b).
  // recipe components(6.0-9, §8.11) — keypoints `model` + clip_features에서 추출. 워커가 analysis_recipe로 조립.
  modelVersion: string | null;
  detectorSha256: string | null;
  poseSha256: string | null;
  weightsComplete: boolean;
  featureConfigVersion: string | null;
}

// 사용자가 고른 대상자(§8.7, PR D2b). sample-detect 후보 bbox(xywh 픽셀) + 대표 프레임 시각.
export interface TargetSelection {
  id: string;
  bbox: [number, number, number, number];
  timestampMs: number;
}

export interface RunInferenceOptions {
  // 지정 시 infer_clip이 샘플 프레임을 <frameIndex>.jpg로 저장(overlay 검수 게이트, best-effort). 미지정/off면 미추출.
  framesDir?: string | null;
}

export interface WorkerDeps {
  // 추론 실행기(테스트에서 주입). 기본은 Python subprocess. targetSelection이 있으면 박스→트랙 매핑 후 --target-track.
  runInference: (clipPath: string, profile: string | null, targetSelection: TargetSelection | null, options?: RunInferenceOptions) => Promise<InferenceResult>;
}

interface ClaimedJob {
  id: string;
  clip_id: string;
  analysis_profile: string | null;
}

// box→track 매핑 허용치(worker 레이어 — xywh 픽셀 기준). sample-detect 프레임과 분석 샘플 프레임의 시각 차 허용.
const MAX_TIME_GAP_MS = 500;
const MIN_MATCH_IOU = 0.3;

// xywh 픽셀 박스 IoU(D2a tracker의 xyxy `iou`와 구분 — 좌표계 혼동 방지).
export function iouXywh(a: number[], b: number[]): number {
  const ax2 = a[0] + a[2], ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const union = Math.max(0, a[2]) * Math.max(0, a[3]) + Math.max(0, b[2]) * Math.max(0, b[3]) - inter;
  return union > 0 ? inter / union : 0;
}

interface KpPerson { trackId?: string | null; bbox?: number[] }
interface KpFrame { timestampMs: number; persons?: KpPerson[] }

// 선택 박스를 keypoints 트랙에 매핑. |frame.ts − sampleTs| ≤ MAX_TIME_GAP_MS 프레임들 중 IoU ≥ MIN_MATCH_IOU 최대.
// 매핑 실패 → throw TARGET_TRACK_MAP_FAILED(dominant 폴백 금지 — 다른 사람 분석 방지, §8.7).
export function mapTargetTrack(kpDoc: { frames?: KpFrame[] }, sel: TargetSelection): string {
  let best: { iou: number; trackId: string } | null = null;
  for (const f of kpDoc.frames ?? []) {
    if (Math.abs(f.timestampMs - sel.timestampMs) > MAX_TIME_GAP_MS) continue;
    for (const p of f.persons ?? []) {
      if (!p.trackId || !p.bbox) continue;
      const score = iouXywh(p.bbox, sel.bbox);
      if (score >= MIN_MATCH_IOU && (!best || score > best.iou)) best = { iou: score, trackId: p.trackId };
    }
  }
  if (!best) {
    throw Object.assign(new Error('selected target could not be mapped to a track'), { code: 'TARGET_TRACK_MAP_FAILED' });
  }
  return best.trackId;
}

// 기본 추론기: infer_clip.py → keypoints, (선택)박스→트랙 매핑, feature_calc.py → clip_features. ClipFeatureSetSchema 검증.
async function defaultRunInference(
  clipPath: string, profile: string | null, targetSelection: TargetSelection | null, options?: RunInferenceOptions,
): Promise<InferenceResult> {
  const fps = PROFILE_FPS[profile ?? 'posture-basic'] ?? 5;
  const scripts = config.video.scriptsDir;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'va-job-'));
  try {
    const kpPath = path.join(work, 'keypoints.json');
    const cfPath = path.join(work, 'clip_features.json');
    const inferArgs = [path.join(scripts, 'infer_clip.py'), '--input', clipPath, '--output', kpPath, '--fps', String(fps)];
    // overlay 검수 게이트(privacy 예외): 샘플 프레임을 frameIndex별 JPEG로 저장(infer_clip best-effort).
    if (options?.framesDir) inferArgs.push('--frames-dir', options.framesDir);
    await execFileAsync(config.video.python, inferArgs, { timeout: PROCESSING_TIMEOUT_MS });
    // 매핑은 keypoints가 나와야 가능 → infer_clip 후에 처리. 선택 있으면 박스→트랙(실패 시 throw → job error).
    const kpRaw = fs.readFileSync(kpPath, 'utf-8');
    const kpDoc = JSON.parse(kpRaw) as {
      model?: {
        preprocessConfigHash?: string;
        modelVersion?: string;
        detectorSha256?: string | null;
        poseSha256?: string | null;
        weightsComplete?: boolean;
      };
      frames?: KpFrame[];
    };
    const featureArgs = [path.join(scripts, 'feature_calc.py'), '--keypoints', kpPath, '--output', cfPath];
    if (targetSelection) {
      featureArgs.push('--target-track', mapTargetTrack(kpDoc, targetSelection));
    }
    await execFileAsync(config.video.python, featureArgs, { timeout: PROCESSING_TIMEOUT_MS });
    const cfRaw = fs.readFileSync(cfPath, 'utf-8');
    const clipFeatures = ClipFeatureSetSchema.parse(JSON.parse(cfRaw)); // 신뢰 경계 — 계약 검증
    const m = kpDoc?.model ?? {};
    return {
      clipFeatures,
      preprocessConfigHash: m.preprocessConfigHash ?? null,
      inputSha256: crypto.createHash('sha256').update(kpRaw).digest('hex'),
      keypointsJson: kpRaw, // tmp work dir는 곧 삭제되므로 원문을 반환해 호출측이 artifact로 영속.
      modelVersion: m.modelVersion ?? null,
      detectorSha256: m.detectorSha256 ?? null,
      poseSha256: m.poseSha256 ?? null,
      weightsComplete: m.weightsComplete === true,
      featureConfigVersion:
        (clipFeatures as { featureConfigVersion?: string }).featureConfigVersion ?? null,
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

// 조용한 unlink(존재 안 해도 무시).
async function safeUnlink(p: string | null | undefined): Promise<void> {
  if (!p) return;
  await fs.promises.unlink(p).catch(() => {});
}

/** keypoints 원문을 uploadDir/artifacts/<jobId>.keypoints.json로 영속(uploadDir 없으면 skip). */
async function persistKeypoints(
  jobId: string, keypointsJson: string | null,
): Promise<{ keypointsPath: string | null; keypointsSha: string | null }> {
  if (!config.video.uploadDir || !keypointsJson) return { keypointsPath: null, keypointsSha: null };
  const artDir = path.join(config.video.uploadDir, 'artifacts');
  await fs.promises.mkdir(artDir, { recursive: true });
  const keypointsPath = path.join(artDir, `${jobId}.keypoints.json`);
  await fs.promises.writeFile(keypointsPath, keypointsJson);
  const keypointsSha = crypto.createHash('sha256').update(keypointsJson).digest('hex');
  return { keypointsPath, keypointsSha };
}

/**
 * 추론 결과에서 재현성 recipe(§8.11)를 조립한다(서버 source of truth). 가중치 sha가 모두 확정
 * (weightsComplete)이어야 status='verified'. mapping/viewpoint 버전은 서버 상수(@wr/contracts)에서,
 * code commit은 env WR_GIT_COMMIT(PR-B Dockerfile ARG→ENV)에서 채운다.
 */
export function buildJobRecipe(result: InferenceResult): AnalysisRecipe {
  return {
    status: result.weightsComplete ? 'verified' : 'unverified',
    modelVersion: result.modelVersion ?? 'unknown',
    detectorSha256: result.detectorSha256,
    poseSha256: result.poseSha256,
    preprocessConfigHash: result.preprocessConfigHash,
    featureConfigVersion: result.featureConfigVersion ?? 'unknown',
    mappingConfigVersion: VIDEO_MAPPING_CONFIG_VERSION,
    viewpointConfigVersion: VIDEO_VIEWPOINT_CONFIG_VERSION,
    codeCommit: process.env.WR_GIT_COMMIT || 'unknown',
  };
}

/** overlay 프레임 디렉터리 경로(게이트 on + uploadDir일 때만). 실제 프레임 추출은 infer_clip이 --frames-dir로 수행. */
function overlayFramesDir(jobId: string): string | null {
  if (!config.video.overlayFrames || !config.video.uploadDir) return null;
  return path.join(config.video.uploadDir, 'artifacts', `${jobId}.frames`);
}

/** 디렉터리에 .jpg가 1개 이상 있으면 그 경로 반환(없으면 null). Python best-effort라 빈 디렉터리 가능 → 빈 건 미기록. */
async function framesPathIfPopulated(dir: string | null): Promise<string | null> {
  if (!dir) return null;
  try {
    const entries = await fs.promises.readdir(dir);
    return entries.some((e) => e.toLowerCase().endsWith('.jpg')) ? dir : null;
  } catch {
    return null;
  }
}

/** 조용한 재귀 디렉터리 삭제(존재 안 해도 무시). */
async function safeRmDir(p: string | null | undefined): Promise<void> {
  if (!p) return;
  await fs.promises.rm(p, { recursive: true, force: true }).catch(() => {});
}

interface JobClip {
  resolvedPath: string | null; // 심층방어 재검증된 실경로(추론 입력)
  sourceType: string;
  uploadPath: string | null;
  sampleFramePath: string | null;
}
// clip 메타 로드 + 출처(source_type)별 allowlist 재검증. 보존정책(원본/썸네일 삭제) 판정에 sourceType/경로도 반환.
async function loadJobClip(pool: Pool, clipId: string): Promise<JobClip> {
  const { rows } = await pool.query<{ upload_path: string | null; source_type: string; file_state: string; sample_frame_path: string | null }>(
    `SELECT upload_path, source_type, file_state, sample_frame_path FROM video_analysis_clips WHERE id = $1`,
    [clipId],
  );
  const row = rows[0];
  if (!row) return { resolvedPath: null, sourceType: 'unknown', uploadPath: null, sampleFramePath: null };
  let resolvedPath: string | null = null;
  if (row.upload_path) {
    if (row.source_type === 'fixture') {
      // basename만 취해 fixtureDir 안에서 다시 검증(저장된 경로가 변조됐어도 allowlist 밖이면 거부).
      resolvedPath = resolveFixtureClip(path.basename(row.upload_path), config.video.fixtureDir);
    } else if (row.source_type === 'upload' && row.file_state === 'present') {
      // 원본이 이미 삭제(privacy_first)됐으면(file_state≠present) 재분석 불가.
      resolvedPath = resolveUploadedClipPath(row.upload_path, config.video.uploadDir);
    }
  }
  return { resolvedPath, sourceType: row.source_type, uploadPath: row.upload_path, sampleFramePath: row.sample_frame_path };
}

// clip의 대상자 선택(target_person_id + sample_detect_result) → TargetSelection. 선택 없으면 null(dominant).
// sample_detect_result는 신뢰 경계 밖 → 계약 검증. 선택했는데 후보가 없으면 매핑 실패로 본다(TARGET_TRACK_MAP_FAILED).
async function resolveTargetSelection(pool: Pool, clipId: string): Promise<TargetSelection | null> {
  const { rows } = await pool.query<{ sample_detect_result: unknown; target_person_id: string | null }>(
    `SELECT sample_detect_result, target_person_id FROM video_analysis_clips WHERE id = $1`,
    [clipId],
  );
  const row = rows[0];
  // 선택 없음 → dominant 폴백(null). 선택했는데 후보 데이터가 없으면 "선택=그 사람 or 실패" 원칙상 폴백 금지 → job error.
  if (!row?.target_person_id) return null;
  if (row.sample_detect_result == null) {
    throw Object.assign(new Error('target selected but sample-detect result is missing'), { code: 'INVALID_SAMPLE_DETECT' });
  }
  const parsed = SampleDetectResultSchema.safeParse(row.sample_detect_result);
  if (!parsed.success) {
    throw Object.assign(new Error('stored sample-detect result is invalid'), { code: 'INVALID_SAMPLE_DETECT' });
  }
  const cand = parsed.data.persons.find((p) => p.id === row.target_person_id);
  if (!cand) {
    throw Object.assign(new Error('selected target is not among sample-detect candidates'), { code: 'TARGET_TRACK_MAP_FAILED' });
  }
  return { id: cand.id, bbox: cand.bbox, timestampMs: parsed.data.timestampMs };
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

  // DB에 경로가 기록되기 전 예외 시 즉시 정리할 artifact(orphan 방지). 기록 성공 후 null로 비운다.
  let pendingKeypointsPath: string | null = null;
  let pendingFramesDir: string | null = null;
  let succeeded: { clip: JobClip } | null = null;
  try {
    const clip = await loadJobClip(pool, job.clip_id);
    if (!clip.resolvedPath) {
      throw Object.assign(new Error('clip unavailable or outside allowlist'), { code: 'CLIP_UNAVAILABLE' });
    }
    const targetSelection = await resolveTargetSelection(pool, job.clip_id);
    // overlay 프레임 게이트(privacy 예외): on이면 추론이 프레임을 이 dir에 저장. 실패/error 시 즉시 정리 대상.
    const framesDir = overlayFramesDir(job.id);
    pendingFramesDir = framesDir;
    const result = await deps.runInference(clip.resolvedPath, job.analysis_profile, targetSelection, { framesDir });

    // keypoints artifact 영속화(overlay 검수 입력, M3-7b). uploadDir 구성 시에만(좌표만, 원본 프레임 없음).
    const { keypointsPath, keypointsSha } = await persistKeypoints(job.id, result.keypointsJson);
    pendingKeypointsPath = keypointsPath;
    // 프레임은 실제 .jpg가 생성된 경우에만 frames_path 기록(best-effort라 빈 디렉터리 가능).
    const framesPath = await framesPathIfPopulated(framesDir);

    const recipe = buildJobRecipe(result); // 재현성 recipe(§8.11) — apply 검증의 서버 source of truth.
    await pool.query(
      `UPDATE video_analysis_jobs
         SET status = 'review_pending', result_features = $2,
             preprocess_config_hash = $3, analysis_input_sha256 = $4,
             keypoints_path = $5, keypoints_sha256 = $6, frames_path = $7,
             analysis_recipe = $8
       WHERE id = $1`,
      [job.id, JSON.stringify(result.clipFeatures), result.preprocessConfigHash, result.inputSha256, keypointsPath, keypointsSha, framesPath, JSON.stringify(recipe)],
    );
    pendingKeypointsPath = null; // DB에 경로 기록 완료 → 더 이상 orphan 아님.
    // 프레임: 기록됐으면 보존(orphan 아님), 빈 디렉터리면 즉시 제거.
    if (framesPath) pendingFramesDir = null;
    else { await safeRmDir(framesDir); pendingFramesDir = null; }
    succeeded = { clip }; // 분석 성공 확정 — 이후 보존정책 후처리 실패가 이 성공을 덮지 않게 한다.
  } catch (err) {
    // DB에 경로가 기록되기 전 실패한 artifact는 즉시 정리(hourly orphan sweep 대기 없이).
    if (pendingKeypointsPath) await safeUnlink(pendingKeypointsPath);
    if (pendingFramesDir) await safeRmDir(pendingFramesDir);
    const code = (err as { code?: string })?.code ?? 'INFERENCE_ERROR';
    const message = String((err as Error)?.message ?? err).slice(0, 500);
    await pool.query(
      `UPDATE video_analysis_jobs SET status = 'error', error_code = $2, error_message = $3 WHERE id = $1`,
      [job.id, code, message],
    );
  }

  // 보존 정책 A(privacy_first) 후처리 — 분석 성공 전이와 분리. 여기서 실패해도 job은 review_pending을 유지하고
  // cleanup(orphan/TTL)이 안전망이 된다(이미 성공한 분석을 error로 되돌리지 않음). 실 업로드만 대상(fixture 미삭제).
  // DB를 먼저 deleted로 전이한 뒤 unlink → "file_state='present'인데 파일 없음" 상태 방지.
  if (succeeded && config.video.retentionPolicy === 'privacy_first' && succeeded.clip.sourceType === 'upload') {
    try {
      await pool.query(
        `UPDATE video_analysis_clips SET upload_path = NULL, file_state = 'deleted'
         WHERE id = $1 AND source_type = 'upload'`,
        [job.clip_id],
      );
      if (succeeded.clip.resolvedPath) await safeUnlink(succeeded.clip.resolvedPath);
    } catch (e) {
      console.error('[wr-server] video retention cleanup failed (job kept review_pending)', { jobId: job.id, err: e });
    }
  }

  // 분석 성공 시 대표 프레임 썸네일(선택용 식별 이미지)은 더 이상 불필요 → 회수(모든 source/retention,
  // select 안 거친 dominant 경로 안전망). resolver 통과 경로만 unlink.
  if (succeeded && succeeded.clip.sampleFramePath) {
    try {
      await pool.query(`UPDATE video_analysis_clips SET sample_frame_path = NULL WHERE id = $1`, [job.clip_id]);
      const real = resolveSampleFramePath(succeeded.clip.sampleFramePath, job.clip_id, config.video.uploadDir);
      if (real) await safeUnlink(real);
    } catch (e) {
      console.error('[wr-server] sample-frame reclaim failed', { jobId: job.id, err: e });
    }
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
