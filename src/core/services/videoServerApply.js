// 영상 분석 서버 적용 오케스트레이터 (6.0-4 UI). 인트라넷+synced 환자에서 제안 1건을
// 서버 경로로 적용한다: clip 생성 → job 생성(review_pending) → 환자 data 계산 → apply(영속화).
// 별도 모듈인 이유: videoAnalysisClient ↔ patientServerRepository 순환 import 회피.
import { applyFeatureToModule } from './videoProvenance';
import { createClip, createJob } from './videoAnalysisClient';
import { applyVideoAnalysisJob } from './patientServerRepository';

const MOCK_BUNDLE = 'mock-6.0-2';

// 멱등 해시 — 서버는 text 동등비교만 하므로 결정적 canonical 문자열이면 충분(§8.12).
// previousValue는 제외(재시도 시 변동 방지) — jobId + targetPath + appliedValue 기준.
export function computeAppliedInputsHash(jobId, appliedInput) {
  return JSON.stringify({
    jobId,
    items: [{ targetPath: appliedInput.targetPath, appliedValue: appliedInput.appliedValue }],
  });
}

/**
 * 제안 1건을 서버 경로로 적용하고, 서버가 반환한 synced 환자를 돌려준다.
 * @param {object} patient - 현재(synced) 환자
 * @param {object} opts - { moduleId, ctx, featureKey, suggestedValue, confidence, processIds, processId, analysisProfile }
 * @param {object} env - { session, settings, appliedBy }
 * @returns {Promise<object>} 서버 동기화된 환자(로컬 id 보존)
 */
export async function applyVideoFeatureViaServer(patient, opts, env) {
  const { session, settings, appliedBy } = env;
  // 서버 적용은 원본 분석 job 추적이 필수(D3b) — 빈 provenance면 거부(이 경로는 서버모드 real-apply 전용,
  // 로컬/mock은 updatePatient로 처리되어 여기 오지 않는다). UI에서도 1차 차단하나 직접 호출 방어.
  const sourceAnalysisJobIds = opts.analysisJobIds || [];
  if (sourceAnalysisJobIds.length === 0) {
    const err = new Error('원본 분석 정보(provenance)가 없어 서버 적용을 거부합니다.');
    err.code = 'EMPTY_PROVENANCE';
    throw err;
  }
  // 1) clip 생성(서버가 sync.serverId 추출·synced 강제)
  const clip = await createClip(patient, { session, settings });
  // 2) job 생성 → review_pending (mock 서버는 즉시 review_pending). org/patient는 서버가 clip 조회로 채움.
  //    processId는 job-scope 제안(여러 공정 집계)이라 의도적으로 null — 공정 추적은 provenance의
  //    appliedInputs.processIds에 남는다. 실제 추론·job 폴링(getJob 루프)은 M2에서 연결.
  const job = await createJob(
    { clipId: clip.clipId, processId: opts.processId ?? null, analysisProfile: opts.analysisProfile, requestedFeatures: [opts.featureKey] },
    { session, settings }
  );
  // 방어: 분석이 검수 대기(review_pending)가 아니면 적용하지 않는다(서버 apply가 409로 거부하기 전 조기 차단).
  if (job.status && job.status !== 'review_pending') {
    const err = new Error(`분석이 아직 검수 대기 상태가 아닙니다(${job.status}).`);
    err.code = 'JOB_NOT_READY';
    throw err;
  }
  // 3) 환자 data 로컬 계산(모듈 값 + appliedInputs) — 서버는 coerce를 모르므로 클라가 계산.
  //    analysisJobIds: 이 제안을 만든 원본 분석 job(들). 적용 셸 job(job.jobId)과 구분해 provenance에 기록.
  const { patient: nextLocal, appliedInput } = applyFeatureToModule(patient, {
    moduleId: opts.moduleId, ctx: opts.ctx, featureKey: opts.featureKey,
    suggestedValue: opts.suggestedValue, confidence: opts.confidence,
    processIds: opts.processIds || [], analysisJobIds: sourceAnalysisJobIds,
    analysisBundleVersion: opts.analysisBundleVersion || MOCK_BUNDLE, appliedBy,
  });
  // 4) apply(영속화) — If-Match 단일 트랜잭션. 서버가 payload 저장·revision+1·audit + source job consumed.
  const hash = computeAppliedInputsHash(job.jobId, appliedInput);
  return applyVideoAnalysisJob(job.jobId, patient, nextLocal.data, {
    appliedInputsHash: hash, appliedInputsCount: 1, sourceAnalysisJobIds, session, settings,
  });
}
