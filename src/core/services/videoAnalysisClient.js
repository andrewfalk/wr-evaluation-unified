// 영상 분석 서버 API 클라이언트 (6.0-4). analysisClient.js의 형제 — 플랫폼 분기.
// 영상 분석은 사실상 인트라넷 기능: 인트라넷에서만 서버 호출, 그 외(electron standalone/web)는
// 미지원 stub(§8.2). 실제 업로드(multipart)는 M3에서 추가된다.
import { requestJson, requestMultipart, requestBlob } from './httpClient';

function getBaseUrl(session, settings) {
  return session?.apiBaseUrl || settings?.apiBaseUrl || '';
}

export function isVideoAnalysisSupported(session) {
  return session?.mode === 'intranet';
}

function ensureIntranet(session) {
  if (!isVideoAnalysisSupported(session)) {
    const err = new Error('영상 분석은 인트라넷 모드에서만 지원됩니다.');
    err.status = 400;
    err.code = 'VIDEO_UNSUPPORTED_MODE';
    throw err;
  }
}

export const PATIENT_NOT_SYNCED = 'PATIENT_NOT_SYNCED';

// 영상 분석 시작/적용은 서버에 동기화된 환자(serverId + syncStatus==='synced')만 가능하다.
// 서버는 클라 syncStatus를 모르므로 게이팅은 클라 책임(§8.12). dirty/conflict/local-only는
// 미동기 로컬 변경이 섞여 서버 payload와 어긋날 수 있어 차단하고, 먼저 저장·동기화를 유도한다.
// 반환: 서버 patient_records.id (= sync.serverId). 절대 로컬 patient.id가 아니다.
export function requireSyncedServerId(patient) {
  const serverId = patient?.sync?.serverId ?? null;
  const status = patient?.sync?.syncStatus;
  if (!serverId || status !== 'synced') {
    const err = new Error('서버에 동기화된 환자만 영상 분석을 시작/적용할 수 있습니다. 먼저 저장·동기화하세요.');
    err.status = 409;
    err.code = PATIENT_NOT_SYNCED;
    throw err;
  }
  return serverId;
}

// 환자 객체를 받아 serverId를 추출(synced 강제)해 clip을 생성한다 — 로컬 id 오전송 방지.
// purpose(M3-7a 필수): 'analysis_upload'(실 업로드 대기) | 'apply_shell'(추론 없는 적용 셸) | 'fixture'(dev).
//   서버가 source_type을 추론하지 않고 명시 설정 — 호출부가 반드시 지정.
// processId: 분석 job은 어느 공정 클립인지 채운다(per-process). 적용 셸 경로는 생략(=null).
// fixtureClipName(dev): purpose='fixture'일 때만. fixtureMode 서버에서 resolve→upload_path 저장.
export async function createClip(patient, { processId, purpose, fixtureClipName, session, settings } = {}) {
  ensureIntranet(session);
  const serverPatientId = requireSyncedServerId(patient);
  return requestJson('/api/video-analysis/clips', {
    baseUrl: getBaseUrl(session, settings), method: 'POST', session,
    body: { patientId: serverPatientId, processId: processId ?? null, purpose, fixtureClipName },
  });
}

// 실 영상 업로드(M3-7a). createClip(purpose='analysis_upload')로 만든 clip에 파일을 multipart 전송.
// onProgress({loaded,total})로 진행률, signal로 취소. 반환: { clipId, sha256 }.
export async function uploadClip(clipId, file, { session, settings, onProgress, signal } = {}) {
  ensureIntranet(session);
  return requestMultipart(`/api/video-analysis/clips/${clipId}/upload`, {
    baseUrl: getBaseUrl(session, settings), session, file, onProgress, signal,
  });
}

export async function sampleDetectClip(clipId, { session, settings } = {}) {
  ensureIntranet(session);
  return requestJson(`/api/video-analysis/clips/${clipId}/sample-detect`, {
    baseUrl: getBaseUrl(session, settings), method: 'POST', session,
  });
}

// 대상자 선택용 대표 프레임 썸네일(정책 예외). 게이트 off/미생성이면 404→null. 200이면 objectURL 반환.
// 호출측은 더 이상 안 쓸 때 URL.revokeObjectURL로 해제할 것(누수 방지).
export async function fetchSampleFrame(clipId, { session, settings } = {}) {
  ensureIntranet(session);
  const blob = await requestBlob(`/api/video-analysis/clips/${clipId}/sample-frame`, {
    baseUrl: getBaseUrl(session, settings), session,
  });
  return blob ? URL.createObjectURL(blob) : null;
}

// 골격 검수 overlay 실 프레임(privacy 게이트 예외). 게이트 off/미생성/검수종료면 404→null. 200이면 Blob 반환.
// objectURL 생성·해제(스크럽 캐시·trim)는 호출측(SkeletonOverlay)이 관리한다.
export async function fetchOverlayFrame(jobId, frameIndex, { session, settings } = {}) {
  ensureIntranet(session);
  return requestBlob(`/api/video-analysis/jobs/${jobId}/overlay-frame/${frameIndex}`, {
    baseUrl: getBaseUrl(session, settings), session,
  });
}

export async function selectTarget(clipId, targetPersonId, { session, settings } = {}) {
  ensureIntranet(session);
  return requestJson(`/api/video-analysis/clips/${clipId}/select-target`, {
    baseUrl: getBaseUrl(session, settings), method: 'POST', session, body: { targetPersonId },
  });
}

// 큐 결정은 서버가 clip.upload_path로 일원화(PR D2b) — fixtureClipName은 createClip에만 전달, job에는 없음.
export async function createJob({ clipId, processId, analysisProfile, requestedFeatures }, { session, settings } = {}) {
  ensureIntranet(session);
  return requestJson('/api/video-analysis/jobs', {
    baseUrl: getBaseUrl(session, settings), method: 'POST', session,
    body: { clipId, processId, analysisProfile, requestedFeatures },
  });
}

export async function getJob(jobId, { session, settings } = {}) {
  ensureIntranet(session);
  return requestJson(`/api/video-analysis/jobs/${jobId}`, {
    baseUrl: getBaseUrl(session, settings), session,
  });
}

const TERMINAL_STATUSES = new Set(['review_pending', 'done', 'error', 'expired', 'cancelled']);

// job이 종료 상태에 도달할 때까지 getJob을 간격 폴링한다(분석 실행 → review_pending 대기).
// 타임아웃/최대 시도 초과 시 마지막 job을 반환(호출측이 status로 판단).
export async function pollJob(jobId, { session, settings } = {}, { intervalMs = 1000, maxAttempts = 120 } = {}) {
  let last = null;
  for (let i = 0; i < maxAttempts; i += 1) {
    last = await getJob(jobId, { session, settings });
    if (last && TERMINAL_STATUSES.has(last.status)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

// 검수용 골격 overlay(6.0-8): 서버가 sha256+계약 검증한 keypoints를 반환.
// → { jobId, clipId, targetTrackId, keypoints }. UI는 payload만으로 그릴 수 있다(별도 조회 불필요).
// artifact가 없으면(검수 종료/미산출) 서버는 404 OVERLAY_NOT_AVAILABLE → 여기서 null로 흡수(호출부 fallback).
// httpClient의 requestJson은 non-2xx에서 err.status·err.data만 붙인다(err.code 없음) → status+data로 판별.
export async function fetchOverlay(jobId, { session, settings } = {}) {
  ensureIntranet(session);
  try {
    return await requestJson(`/api/video-analysis/jobs/${jobId}/overlay`, {
      baseUrl: getBaseUrl(session, settings), session,
    });
  } catch (err) {
    const code = err?.data?.code || err?.data?.error?.code;
    if (err?.status === 404 && code === 'OVERLAY_NOT_AVAILABLE') return null;
    throw err;
  }
}

// 검수 종료(6.0-8, job 단위): 해당 job의 keypoints artifact를 서버가 즉시 회수.
// 반환: { ok, jobId, cleared }. 진행 중(queued/processing) job이면 서버가 409 JOB_NOT_READY로 거부.
export async function closeReview(jobId, { session, settings } = {}) {
  ensureIntranet(session);
  return requestJson(`/api/video-analysis/jobs/${jobId}/close-review`, {
    baseUrl: getBaseUrl(session, settings), method: 'POST', session,
  });
}
