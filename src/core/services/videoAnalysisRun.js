// 서버 분석 실행 오케스트레이터 (6.0-6b, PR D1/D2b). "분석 실행" 단계 — 공정별로 실제 추론 job을
// 돌려(fixture) intrinsic clipFeatures를 받고, 수기 activeMinutesPerDay로 per-day 환산해
// processFeatures를 구성한다. "제안 적용"(videoServerApply)과 분리되어 적용마다 추론이 재실행되지 않는다.
// D2b: 클립에 대상자 선택(detection: serverClipId+selectedId)이 있으면 그 serverClipId로 job을 돌려
// 서버에 보존된 target을 쓴다(새 clip 미생성). 선택 없으면 createClip(fixtureClipName)→job(dominant).
import { VIDEO_FEATURE_TARGETS } from '@contracts/index';
import { createClip, createJob, pollJob } from './videoAnalysisClient';
import { convertClipFeaturesToPerDay, buildRecipeVersion } from './videoPerDayConversion';

// 활성 모듈로 매핑되는 featureKey 목록(컴포넌트 헬퍼와 동일 정의 — 순환 import 회피 위해 인라인).
function requestedFeaturesForModules(activeModules = []) {
  return Object.keys(VIDEO_FEATURE_TARGETS).filter(
    (k) => activeModules.includes(VIDEO_FEATURE_TARGETS[k].moduleId)
  );
}

/**
 * 서버 모드에서 공정별 실분석을 수행한다.
 * @param {object} patient - synced 환자(서버 createClip에 serverId 필요)
 * @param {object} va - videoAnalysis 데이터(processes/clips)
 * @param {object} opts - { activeModules, session, settings, detections }
 *   detections: { [clipMetaId]: { serverClipId, selectedId } } — 대상자 선택된 클립은 그 serverClipId 재사용.
 * @returns {Promise<{ processFeatures: Array, missingActiveTime: object, bundleVersion: string|null, errors: Array }>}
 *   processFeatures: [{ processId, jobId, features }]
 *   missingActiveTime: { [processId]: featureKey[] } — 활동시간 누락으로 못 만든 per-day feature
 *   errors: [{ processId, message }]
 */
export async function runServerAnalysis(patient, va, { activeModules = [], session, settings, detections = {} } = {}) {
  const requested = requestedFeaturesForModules(activeModules);
  const processFeatures = [];
  const missingActiveTime = {};
  const errors = [];
  let bundleVersion = null;

  for (const p of va.processes || []) {
    // 공정에 연결된 fixture 클립(basename). 공정당 단일 클립·단일 인물.
    const clipMeta = (va.clips || []).find((c) => c.processId === p.id && c.fixtureClipName);
    if (!clipMeta) {
      errors.push({ processId: p.id, message: `공정 "${p.name}"에 fixture 클립이 없습니다(클립에 파일명 입력 필요).` });
      continue;
    }
    try {
      // 대상자 선택(detection)이 있으면 그 serverClipId 재사용(서버 보존 target). 없으면 새 clip(dominant).
      const det = detections[clipMeta.id];
      let serverClipId = det?.serverClipId;
      if (!serverClipId) {
        const clip = await createClip(patient, { processId: p.id, fixtureClipName: clipMeta.fixtureClipName, session, settings });
        serverClipId = clip.clipId;
      }
      const job = await createJob(
        { clipId: serverClipId, processId: p.id, analysisProfile: p.analysisProfile, requestedFeatures: requested },
        { session, settings }
      );
      const done = await pollJob(job.jobId, { session, settings });
      if (!done || done.status !== 'review_pending') {
        errors.push({ processId: p.id, message: `분석 실패(${done?.status || 'no-response'}${done?.errorCode ? `: ${done.errorCode}` : ''}).` });
        continue;
      }
      // 활성 모듈로 매핑되는 featureKey만 변환(고정 feature set → 무관 키 제거, mock 경로와 일치).
      const conv = convertClipFeaturesToPerDay(done.resultFeatures, p.activeMinutesPerDay, { allowedFeatureKeys: requested });
      processFeatures.push({ processId: p.id, jobId: done.jobId, features: conv.features });
      if (conv.missingActiveTime.length > 0) missingActiveTime[p.id] = conv.missingActiveTime;
      bundleVersion = buildRecipeVersion(conv.featureConfigVersion);
    } catch (e) {
      errors.push({ processId: p.id, message: e?.message || '분석 중 오류가 발생했습니다.' });
    }
  }

  return { processFeatures, missingActiveTime, bundleVersion, errors };
}
