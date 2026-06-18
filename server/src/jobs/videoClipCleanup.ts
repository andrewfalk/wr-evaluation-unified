import fs from 'fs';
import path from 'path';
import type { Pool } from 'pg';
import config from '../config';
import { resolveSampleFramePath } from '../workers/fixturePath';

// ---------------------------------------------------------------------------
// 영상 분석 임시파일 회수(M3-7b). cron/setInterval/CLI에서 호출(HTTP 라우트 아님).
//  1) TTL 만료 clip: 원본 영상 삭제 + file_state='deleted'+upload_path=null.
//  2) TTL 만료 clip의 job keypoints artifact 삭제(artifact는 clip TTL까지 보존 → 만료 시 회수).
//  3) orphan 파일 회수: uploadDir 미참조 파일 + tmp/ 1시간 이상 미완료 업로드 잔여물.
// 원본 영상은 PostgreSQL JSONB에 저장하지 않으며(§8.13), 미확정 임시파일은 여기서 회수한다.
// ---------------------------------------------------------------------------

const TMP_GRACE_MS = 60 * 60 * 1000; // 진행 중 업로드와의 경합 방지(1h)

async function safeUnlink(p: string | null | undefined): Promise<void> {
  if (!p) return;
  await fs.promises.unlink(p).catch(() => {});
}

// 디렉터리의 파일을 회수. byAge=true면 mtime이 grace 초과한 파일만, 아니면 referenced 미포함 파일만.
async function sweepDir(dir: string, referenced: Set<string>, byAge: boolean): Promise<number> {
  let n = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // 디렉터리 없음
  }
  for (const e of entries) {
    if (!e.isFile()) continue; // 하위 디렉터리(tmp/artifacts)는 각자 처리
    const full = path.resolve(dir, e.name);
    if (byAge) {
      const st = await fs.promises.stat(full).catch(() => null);
      if (!st || Date.now() - st.mtimeMs < TMP_GRACE_MS) continue;
      await safeUnlink(full); n += 1;
    } else {
      if (referenced.has(full)) continue;
      await safeUnlink(full); n += 1;
    }
  }
  return n;
}

async function sweepOrphans(pool: Pool, uploadDir: string): Promise<number> {
  const referenced = new Set<string>();
  const clips = await pool.query<{ upload_path: string | null; sample_frame_path: string | null }>(
    `SELECT upload_path, sample_frame_path FROM video_analysis_clips
     WHERE upload_path IS NOT NULL OR sample_frame_path IS NOT NULL`,
  );
  for (const c of clips.rows) {
    if (c.upload_path) referenced.add(path.resolve(c.upload_path));
    if (c.sample_frame_path) referenced.add(path.resolve(c.sample_frame_path)); // 살아있는 썸네일 오삭제 방지
  }
  const jobs = await pool.query<{ keypoints_path: string | null }>(
    `SELECT keypoints_path FROM video_analysis_jobs WHERE keypoints_path IS NOT NULL`,
  );
  for (const j of jobs.rows) if (j.keypoints_path) referenced.add(path.resolve(j.keypoints_path));

  let n = 0;
  n += await sweepDir(uploadDir, referenced, false);                       // 최종 원본(미참조)
  n += await sweepDir(path.join(uploadDir, 'artifacts'), referenced, false); // keypoints artifact(미참조)
  n += await sweepDir(path.join(uploadDir, 'tmp'), referenced, true);      // 미완료 업로드 잔여물(나이 기준)
  return n;
}

export interface VideoClipCleanupResult {
  clipsExpired: number;
  originalsDeleted: number;
  artifactsDeleted: number;
  sampleFramesDeleted: number;
  orphansDeleted: number;
}

export async function runVideoClipCleanup(pool: Pool): Promise<VideoClipCleanupResult> {
  let clipsExpired = 0;
  let originalsDeleted = 0;
  let artifactsDeleted = 0;
  let sampleFramesDeleted = 0;

  // 1) TTL 만료 clip 원본 회수. 원본 삭제는 실 업로드(source_type='upload')만 — fixture(dev allowlist)는 미삭제.
  //    DB 상태 전이를 먼저 하고(present→deleted), 그 다음 파일 unlink. unlink 실패는 orphan sweep이 회수해
  //    "present인데 파일 없음"으로 DB가 깨지지 않게 한다.
  const expired = await pool.query<{ id: string; upload_path: string | null }>(
    `SELECT id, upload_path FROM video_analysis_clips
     WHERE expires_at IS NOT NULL AND expires_at < now() AND file_state = 'present' AND source_type = 'upload'`,
  );
  for (const c of expired.rows) {
    await pool.query(
      `UPDATE video_analysis_clips SET upload_path = NULL, file_state = 'deleted' WHERE id = $1`,
      [c.id],
    );
    clipsExpired += 1;
    if (c.upload_path) { await safeUnlink(c.upload_path); originalsDeleted += 1; }
  }

  // 2) TTL 만료 clip에 속한 job의 keypoints artifact 회수. DB를 먼저 비우고 그 다음 unlink(미참조 → orphan sweep 안전망).
  const staleArtifacts = await pool.query<{ id: string; keypoints_path: string | null }>(
    `SELECT j.id, j.keypoints_path FROM video_analysis_jobs j
     JOIN video_analysis_clips c ON c.id = j.clip_id
     WHERE j.keypoints_path IS NOT NULL
       AND c.expires_at IS NOT NULL AND c.expires_at < now()`,
  );
  for (const j of staleArtifacts.rows) {
    await pool.query(
      `UPDATE video_analysis_jobs SET keypoints_path = NULL, keypoints_sha256 = NULL WHERE id = $1`,
      [j.id],
    );
    await safeUnlink(j.keypoints_path); artifactsDeleted += 1;
  }

  // 3) TTL 만료 clip의 대표 프레임 썸네일 회수(식별 이미지). source 무관, resolver 통과 경로만 unlink.
  const staleFrames = await pool.query<{ id: string; sample_frame_path: string | null }>(
    `SELECT id, sample_frame_path FROM video_analysis_clips
     WHERE sample_frame_path IS NOT NULL AND expires_at IS NOT NULL AND expires_at < now()`,
  );
  for (const c of staleFrames.rows) {
    await pool.query(`UPDATE video_analysis_clips SET sample_frame_path = NULL WHERE id = $1`, [c.id]);
    const real = resolveSampleFramePath(c.sample_frame_path, c.id, config.video.uploadDir);
    if (real) { await safeUnlink(real); sampleFramesDeleted += 1; }
  }

  // 4) orphan 파일 회수(uploadDir 구성 시).
  const orphansDeleted = config.video.uploadDir ? await sweepOrphans(pool, config.video.uploadDir) : 0;

  return { clipsExpired, originalsDeleted, artifactsDeleted, sampleFramesDeleted, orphansDeleted };
}
