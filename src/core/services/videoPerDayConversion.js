// per-day 환산기 (6.0-6b, PR D1). 서버 워커가 산출한 intrinsic ClipFeatureSet(posture_ratio·각도)을
// 공정 활동시간(수기, process.activeMinutesPerDay)과 결합해 per-day VideoFeatureMap으로 환산한다.
// 영상이 측정 가능한 건 클립 구간의 비율·각도뿐 — 하루치(minutes/hours/cycles per day)는 수기 활동시간이
// 있어야 만들어진다(PRD §8.10.2-1). 환산 위치는 클라이언트(서버는 intrinsic만 저장).
//
// null vs 0 (중요): activeMinutesPerDay == null(모름)이면 해당 per-day numeric을 만들지 않고 누락 처리
// (missingActiveTime) — 0으로 표시해 오적용하는 사고를 막는다. 0(0분 공정)은 정상값.
import { ClipFeatureSetSchema, VIDEO_FEATURE_TARGETS } from '@contracts/index';
import { CANDIDATE_REASONS } from './videoMock';
import { resolveAutoSuggest, DEFAULT_CONFIDENCE_THRESHOLDS } from './videoConfidenceConfig';
import { VIDEO_VIEWPOINT_CONFIG_VERSION } from './videoViewpointConfig';

// 환산 규칙 버전(재현성). feature_config.json version과 함께 recipe를 이룬다(provenance).
export const VIDEO_MAPPING_CONFIG_VERSION = 'pday-1.0.0';

// mode → 자동제안/수기확인 플래그(계약 VIDEO_FEATURE_TARGETS.mode 기준). candidate는 별도 처리.
function flagsForMode(mode) {
  return {
    autoSuggestAllowed: mode !== 'candidate',
    requiresManualReview: mode === 'auto-review',
  };
}

// 근거(evidence) 1건: per-day 값이 "왜" 나왔는지 설명용 sidecar. feature 객체엔 붙이지 않고
// 별도 map으로만 운반한다(영속화 차단 — shared.videoAnalysis에 저장되는 건 features뿐).
// intrinsicValue=클립 측정 원값(예: posture_ratio 0.35), activeMinutesPerDay=환산에 쓴 수기 활동시간.
function buildFeatureEvidence(cf, activeMinutesPerDay, warnings) {
  const ev = {
    intrinsicValue: cf.value,
    intrinsicMetric: cf.metric ?? null,
    intrinsicUnit: cf.unit ?? null,       // 원값 단위(예: degrees) — generic candidate 표시용
    activeMinutesPerDay: activeMinutesPerDay ?? null,
    warnings: warnings || [],
  };
  if (cf.confidenceBreakdown) ev.confidenceBreakdown = cf.confidenceBreakdown;
  if (cf.segments) ev.segments = cf.segments;
  return ev;
}

// posture_ratio(0~1) → target 단위로 환산. 지원: minutes_per_day, hours_per_day.
function convertRatio(ratio, unit, activeMinutesPerDay) {
  const minutes = ratio * activeMinutesPerDay;
  if (unit === 'minutes_per_day') return minutes;
  if (unit === 'hours_per_day') return minutes / 60;
  return null; // 미지원 단위(반복 cyclesPerDay 등은 PR C2/후속)
}

/**
 * intrinsic ClipFeatureSet → per-day VideoFeatureMap.
 * @param {object} clipFeatureSet - 서버 result_features(ClipFeatureSetSchema). 검증 후 사용.
 * @param {number|null|undefined} activeMinutesPerDay - 공정활동분/일(수기). null=모름.
 * @param {object} [opts]
 * @param {string[]} [opts.allowedFeatureKeys] - 지정 시 이 featureKey만 변환(활성 모듈 requested 필터).
 *   worker/Python은 고정 feature set을 내므로, 활성 모듈과 무관한 키(예: 무릎만 켰는데 spine trunkPostureG)를
 *   걸러 mock 경로(requested만 생성)와 동작을 일치시킨다.
 * @param {object} [opts.confidenceThresholds] - 저신뢰 게이팅 임계값(featureKey→{성분:값}). 기본 비활성
 *   (DEFAULT_CONFIDENCE_THRESHOLDS, 6.0-B2 전까지 게이팅 없음). 임계 미만이면 autoSuggestAllowed=false.
 * @returns {{ features: object, evidenceByFeatureKey: object, missingActiveTime: string[], warnings: string[], mappingConfigVersion: string, featureConfigVersion: string }}
 *   features: VideoFeatureMap(featureKey → VideoFeatureValue)
 *   evidenceByFeatureKey: featureKey → 근거 sidecar(영속화 안 함, "왜 이 값?" 패널 렌더 lookup용)
 *   missingActiveTime: 활동시간 누락으로 만들지 못한 per-day featureKey 목록(UI 안내·적용 불가)
 */
export function convertClipFeaturesToPerDay(clipFeatureSet, activeMinutesPerDay, { allowedFeatureKeys, confidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS } = {}) {
  // 서버가 보낸 값이라도 계약으로 한 번 더 검증(신뢰 경계). 실패 시 throw → 호출측이 error 처리.
  const parsed = ClipFeatureSetSchema.parse(clipFeatureSet);
  const allowed = allowedFeatureKeys ? new Set(allowedFeatureKeys) : null;
  const hasActiveTime = activeMinutesPerDay != null; // null·undefined 모두 "모름"
  const features = {};
  const evidenceByFeatureKey = {}; // featureKey → 근거 sidecar(영속화 안 함, 렌더 lookup용)
  const missingActiveTime = [];
  const warnings = [];

  for (const [featureKey, cf] of Object.entries(parsed.features)) {
    // 활성 모듈로 매핑되지 않는 키는 건너뛴다(candidate/누락 집계에도 포함하지 않음).
    if (allowed && !allowed.has(featureKey)) continue;
    const target = VIDEO_FEATURE_TARGETS[featureKey];
    if (!target) {
      warnings.push(`UNKNOWN_FEATURE:${featureKey}`);
      continue;
    }

    // candidate(trunkPostureG 등): 모듈 필드 미기입 — value는 원값(각도/비율)을 그대로 후보로.
    // time 단위 candidate(예: trunkFlexionOver45Duration, 분/일)는 활동시간을 evidence에 실어
    // 근거 패널이 "비율×활동분=분/일" 환산식을 보이게 한다(value 자체는 비율 유지, 분/일은 UI 계산).
    if (target.mode === 'candidate') {
      const isTimeUnit = target.unit === 'minutes_per_day' || target.unit === 'hours_per_day';
      const evActiveMin = isTimeUnit && hasActiveTime ? activeMinutesPerDay : null;
      features[featureKey] = {
        kind: 'candidate',
        value: cf.value,
        reason: CANDIDATE_REASONS[featureKey] || '자동입력 금지 후보',
        confidence: cf.confidence,
        autoSuggestAllowed: false,
        requiresManualReview: true,
        warnings: cf.warnings || [],
      };
      evidenceByFeatureKey[featureKey] = buildFeatureEvidence(cf, evActiveMin, cf.warnings || []);
      continue;
    }

    const flags = flagsForMode(target.mode);
    // 저신뢰 게이팅(§8.8): 임계값 설정 시에만 autoSuggestAllowed=false + LOW_CONFIDENCE_* 사유(warnings).
    // 기본 비활성(6.0-B2 전) → flags 그대로. 사유는 base warnings[]로 운반(candidate reason과 구분).
    const gate = resolveAutoSuggest(featureKey, cf, flags, confidenceThresholds);
    const gatedFlags = { autoSuggestAllowed: gate.autoSuggestAllowed, requiresManualReview: flags.requiresManualReview };
    const gatedWarnings = gate.gateWarnings.length ? [...(cf.warnings || []), ...gate.gateWarnings] : (cf.warnings || []);

    // categorical clip feature(예: neckForcedFlexion) → categorical 통과(활동시간 불필요).
    if (cf.kind === 'categorical') {
      features[featureKey] = {
        kind: 'categorical',
        value: cf.value,
        confidence: cf.confidence,
        ...gatedFlags,
        warnings: gatedWarnings,
      };
      evidenceByFeatureKey[featureKey] = buildFeatureEvidence(cf, null, gatedWarnings);
      continue;
    }

    if (cf.kind === 'boolean') {
      features[featureKey] = {
        kind: 'boolean',
        value: cf.value,
        confidence: cf.confidence,
        ...gatedFlags,
        warnings: gatedWarnings,
      };
      evidenceByFeatureKey[featureKey] = buildFeatureEvidence(cf, null, gatedWarnings);
      continue;
    }

    // numeric: posture_ratio → per-day 환산(활동시간 필요).
    if (cf.metric === 'posture_ratio') {
      if (!hasActiveTime) {
        // 모름 → 만들지 않음(0 오적용 방지). UI가 활동시간 입력을 유도.
        missingActiveTime.push(featureKey);
        continue;
      }
      const value = convertRatio(cf.value, target.unit, activeMinutesPerDay);
      if (value == null) {
        warnings.push(`UNSUPPORTED_UNIT:${featureKey}:${target.unit}`);
        continue;
      }
      features[featureKey] = {
        kind: 'numeric',
        value,
        unit: target.unit,
        confidence: cf.confidence,
        ...gatedFlags,
        warnings: gatedWarnings,
      };
      // 환산에 쓴 활동시간을 근거에 기록(예: 126분/일 = ratio 0.35 × 360분/일).
      evidenceByFeatureKey[featureKey] = buildFeatureEvidence(cf, activeMinutesPerDay, gatedWarnings);
      continue;
    }

    // peak_angle/mean_angle 등 비-ratio numeric은 D1 auto 매핑 미지원(반복·각도 직접매핑은 후속).
    warnings.push(`UNSUPPORTED_METRIC:${featureKey}:${cf.metric}`);
  }

  return {
    features,
    evidenceByFeatureKey,
    missingActiveTime,
    warnings,
    mappingConfigVersion: VIDEO_MAPPING_CONFIG_VERSION,
    featureConfigVersion: parsed.featureConfigVersion,
  };
}

// 분석 recipe(provenance analysisBundleVersion) — feature_config + mapping + viewpoint 정책 버전 결합.
// viewpoint 선호도(PREFERRED_VIEWPOINT)는 다중 시점 산출 선택에 영향 → 재현성 위해 recipe에 포함.
export function buildRecipeVersion(featureConfigVersion) {
  return `fc:${featureConfigVersion}+map:${VIDEO_MAPPING_CONFIG_VERSION}+vp:${VIDEO_VIEWPOINT_CONFIG_VERSION}`;
}
