// 영상 분석 서버 API 클라이언트 (6.0-4). analysisClient.js의 형제 — 플랫폼 분기.
// 영상 분석은 사실상 인트라넷 기능: 인트라넷에서만 서버 호출, 그 외(electron standalone/web)는
// 미지원 stub(§8.2). 실제 업로드(multipart)는 M3에서 추가된다.
import { requestJson } from './httpClient';

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
export async function createClip(patient, { session, settings } = {}) {
  ensureIntranet(session);
  const serverPatientId = requireSyncedServerId(patient);
  return requestJson('/api/video-analysis/clips', {
    baseUrl: getBaseUrl(session, settings), method: 'POST', session, body: { patientId: serverPatientId },
  });
}

export async function sampleDetectClip(clipId, { session, settings } = {}) {
  ensureIntranet(session);
  return requestJson(`/api/video-analysis/clips/${clipId}/sample-detect`, {
    baseUrl: getBaseUrl(session, settings), method: 'POST', session,
  });
}

export async function selectTarget(clipId, targetPersonId, { session, settings } = {}) {
  ensureIntranet(session);
  return requestJson(`/api/video-analysis/clips/${clipId}/select-target`, {
    baseUrl: getBaseUrl(session, settings), method: 'POST', session, body: { targetPersonId },
  });
}

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
