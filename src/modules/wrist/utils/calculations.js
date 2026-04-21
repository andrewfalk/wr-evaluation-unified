import { calculateAge, calculateBMI } from '../../../core/utils/common';
import {
  BK_TYPE_LABELS,
  EXPOSURE_TYPE_LABELS,
  PRESSURE_SOURCE_LABELS,
  VIBRATION_TOOL_LABELS,
  WRIST_BRANCH_FIELDS,
  createWristTemporalSequence,
  syncWristModuleData,
} from './data';

export { calculateAge, calculateBMI };

const YES_NO_LABELS = {
  yes: '있음',
  no: '없음',
  unclear: '불분명',
};

const TASK_CHANGE_LABELS = {
  none: '변화 없음',
  increased_load: '부담 증가',
  process_change: '공정 변경',
  new_task: '신규 작업',
};

const LOAD_LEVEL_LABELS = {
  none: '없음',
  mild: '경도',
  moderate: '중등도',
  high: '고강도',
  occasional: '가끔',
  frequent: '빈번',
  present: '있음',
};

const FIELD_LABELS = {
  selectedBkType: 'BK 유형',
  main_task_name: '문제 작업명',
  direct_anatomic_link: '해부학적 연결성',
  exposure_types: '공통 노출 유형',
  repetition_level: '반복 동작 정도',
  daily_exposure_hours: '1일 노출 시간',
  shift_share_percent: '근무시간 비중',
  days_per_week: '주당 근무일수',
  work_pattern: '작업 형태',
  rest_distribution: '휴식 분포',
  force_level: '힘 사용',
  awkward_posture_level: '부자연스러운 자세',
  static_holding_level: '정적 자세 유지',
  direct_pressure_level: '직접 압박/마찰/충격',
  vibration_exposure: '진동 공구 사용',
  recent_task_change: '최근 작업변화',
  task_change_date: '작업변화 시점',
  symptom_onset_interval: '증상 발생까지 기간',
  improves_with_rest: '휴식/업무중단 시 호전',
  bk2113_repetitive_wrist_motion: '반복 손목 굴신',
  bk2101_cycle_seconds: '1회 동작 주기',
  bk2101_repetition_per_hour: '시간당 반복 횟수',
  bk2101_monotony: '단조 반복 여부',
  bk2101_forced_dorsal_extension: '강제 손목 배굴',
  bk2101_prosupination: '반복 회내/회외',
  bk2106_pressure_source: '압박 원인',
  bk2103_vibration_tool_type: '진동 공구 종류',
  bk2103_daily_vibration_hours: '진동 공구 1일 사용 시간',
  bk2103_tool_pressing: '공구를 강하게 쥐거나 누르며 사용',
  bk2103_frequent_high_force_grip: '강한 파지 반복',
};

const REQUIRED_ENTRY_FIELDS = [
  'selectedBkType',
  'main_task_name',
  'direct_anatomic_link',
  'exposure_types',
  'daily_exposure_hours',
  'shift_share_percent',
  'days_per_week',
  'work_pattern',
  'rest_distribution',
];

const FLAG_ORDER = [
  'core_exposure_present',
  'core_exposure_unclear',
  'daily_share_high',
  'daily_share_moderate',
  'daily_share_low',
  'rest_unfavorable',
  'mechanical_load_dominant',
  'pressure_load_dominant',
  'vibration_present',
  'bk2101_high_freq_example',
  'bk2101_pattern_supported',
  'bk2103_pattern_supported',
  'bk2103_transmission_amplifier_present',
  'bk2106_pattern_supported',
  'bk2113_pattern_supported',
  'bk2113_combined_exposure_present',
  'temporal_fit_high',
  'temporal_fit_unclear',
];

const REPETITION_LEVEL_LABELS = {
  none: '없음',
  occasional: '가끔',
  frequent: '빈번',
};

const DEFAULT_BURDEN_THRESHOLDS = {
  highByCount: 5,
  noneMax: 1,
  mildAt: 2,
  moderateMax: 4,
};

const RISK_FACTOR_FLAGS = new Set([
  'core_exposure_present',
  'daily_share_high',
  'daily_share_moderate',
  'rest_unfavorable',
  'mechanical_load_dominant',
  'pressure_load_dominant',
  'vibration_present',
  'bk2101_high_freq_example',
  'bk2101_pattern_supported',
  'bk2103_pattern_supported',
  'bk2103_transmission_amplifier_present',
  'bk2106_pattern_supported',
  'bk2113_pattern_supported',
  'bk2113_combined_exposure_present',
  'temporal_fit_high',
]);

export const FLAG_META = {
  core_exposure_present: { label: '핵심 노출 확인', description: '병변과 직접 연결되는 핵심 노출이 확인됩니다.', tone: 'positive', icon: '🎯' },
  core_exposure_unclear: { label: '핵심 노출 불분명', description: '직접 연결되는 핵심 노출 근거가 부족합니다.', tone: 'neutral', icon: '❔' },
  daily_share_high: { label: '일일 노출량 높음', description: '하루 노출 비중이 높은 편입니다.', tone: 'positive', icon: '⏱️' },
  daily_share_moderate: { label: '일일 노출량 중간', description: '하루 노출 비중이 중간 수준입니다.', tone: 'info', icon: '🕒' },
  daily_share_low: { label: '일일 노출량 낮음', description: '하루 노출 비중이 낮은 편입니다.', tone: 'neutral', icon: '🫧' },
  rest_unfavorable: { label: '휴식 분포 불리', description: '휴식이 충분하지 않아 회복 여건이 좋지 않습니다.', tone: 'warning', icon: '⚠️' },
  mechanical_load_dominant: { label: '기계적 부담 우세', description: '힘 사용이나 부자연스러운 자세 부담이 두드러집니다.', tone: 'positive', icon: '🦾' },
  pressure_load_dominant: { label: '압박 부담 우세', description: '직접 압박이나 마찰 부담이 두드러집니다.', tone: 'warning', icon: '🧱' },
  vibration_present: { label: '진동 노출 존재', description: '진동 공구 노출이 확인됩니다.', tone: 'info', icon: '📳' },
  bk2101_high_freq_example: { label: 'BK2101 고빈도 반복 예시', description: 'BK2101에서 고빈도 반복 작업 사례가 확인됩니다.', tone: 'info', icon: '🔁' },
  bk2101_pattern_supported: { label: 'BK2101 패턴 지지', description: '반복과 힘 사용 양상이 BK2101과 잘 맞습니다.', tone: 'positive', icon: '🧵' },
  bk2103_pattern_supported: { label: 'BK2103 패턴 지지', description: '진동 공구 노출 양상이 BK2103과 잘 맞습니다.', tone: 'positive', icon: '⚙️' },
  bk2103_transmission_amplifier_present: { label: 'BK2103 전달 증폭 요인', description: '강한 파지나 공구 압박으로 진동 전달이 커질 가능성이 있습니다.', tone: 'warning', icon: '📳' },
  bk2106_pattern_supported: { label: 'BK2106 패턴 지지', description: '손목/손바닥 압박 부담 양상이 BK2106과 잘 맞습니다.', tone: 'positive', icon: '🧠' },
  bk2113_pattern_supported: { label: 'BK2113 패턴 지지', description: '반복, 힘, 진동 노출 조합이 BK2113과 잘 맞습니다.', tone: 'positive', icon: '✋' },
  bk2113_combined_exposure_present: { label: 'BK2113 복합 노출', description: '반복, 힘, 진동 중 두 가지 이상이 함께 확인됩니다.', tone: 'info', icon: '🧩' },
  temporal_fit_high: { label: '시간적 선후관계 지지', description: '작업 변화와 증상 변화의 시간 흐름이 비교적 잘 맞습니다.', tone: 'info', icon: '🕰️' },
  temporal_fit_unclear: { label: '시간적 선후관계 불분명', description: '증상과 작업 변화의 시간 흐름이 선명하지 않습니다.', tone: 'neutral', icon: '❔' },
};

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== '' && value !== null && value !== undefined;
}

function toNumber(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getBk2101RepetitionPerHour(entry = {}) {
  const cycleSeconds = toNumber(entry.bk2101_cycle_seconds);
  if (cycleSeconds > 0) {
    return Math.round((3600 / cycleSeconds) * 10) / 10;
  }

  const repetitionPerHour = toNumber(entry.bk2101_repetition_per_hour);
  return repetitionPerHour > 0 ? repetitionPerHour : 0;
}

function formatList(values, labelMap) {
  if (!values || values.length === 0) return '-';
  return values.map(value => labelMap[value] || value).join(', ');
}

function labelValue(value, map) {
  if (!value) return '-';
  return map[value] || value;
}

export function getSideText(side) {
  return side === 'right' ? '우측' : side === 'left' ? '좌측' : side === 'both' ? '양측' : '-';
}

export function getStatusText(status) {
  return status === 'confirmed' ? '확인' : status === 'unconfirmed' ? '미확인' : '-';
}

export function getReasonText(reasons, other) {
  if (typeof reasons === 'string') reasons = reasons ? [reasons] : [];
  if (!reasons || reasons.length === 0) return '-';

  const reasonMap = {
    unrelated: '업무 노출과 직접 연결하기 어려운 상병',
    mild: '병변 정도가 경미하거나 비특이적',
    delayed: '업무 중단 후 상당 기간 경과',
    lowBurden: '누적 노출량이 낮음',
    other: `기타 (${other || ''})`,
  };

  return reasons.map(reason => reasonMap[reason] || reason).join('\n');
}

function getBranchRequiredFields(entry = {}) {
  switch (entry.selectedBkType) {
    case 'BK2113':
      return WRIST_BRANCH_FIELDS.BK2113 || [];
    case 'BK2101':
      return WRIST_BRANCH_FIELDS.BK2101 || [];
    case 'BK2103': {
      const fields = ['vibration_exposure', 'bk2103_tool_pressing'];
      if (entry.vibration_exposure === 'present') {
        fields.push('bk2103_vibration_tool_type', 'bk2103_daily_vibration_hours');
      }
      return fields;
    }
    case 'BK2106': {
      const fields = ['direct_pressure_level', 'static_holding_level'];
      if (entry.direct_pressure_level && entry.direct_pressure_level !== 'none') {
        fields.push('bk2106_pressure_source');
      }
      return fields;
    }
    default:
      return [];
  }
}

function getTemporalRequiredFields(temporalSequence = {}) {
  const required = ['recent_task_change', 'improves_with_rest'];
  if (temporalSequence.recent_task_change && temporalSequence.recent_task_change !== 'none') {
    required.push('task_change_date', 'symptom_onset_interval');
  }
  return required;
}

function getConditionalRequiredFields(entry = {}) {
  if (entry.direct_anatomic_link !== 'yes') return [];
  const conditional = [];
  const exposureTypes = entry.exposure_types || [];
  if (exposureTypes.includes('repetition')) conditional.push('repetition_level');
  if (exposureTypes.includes('force')) conditional.push('force_level');
  if (exposureTypes.includes('awkward_posture')) conditional.push('awkward_posture_level');
  return conditional;
}

function getMissingFields(source, fields) {
  return fields.filter(field => !hasValue(source[field])).map(field => FIELD_LABELS[field] || field);
}

function shouldEvaluateExposureDetails(entry = {}) {
  return entry.direct_anatomic_link === 'yes';
}

function getBk2101BranchNarrative(entry = {}) {
  return [
    `주기 ${entry.bk2101_cycle_seconds || '-'}초`,
    `시간당 ${getBk2101RepetitionPerHour(entry) || '-'}회`,
    `단조 반복 ${labelValue(entry.bk2101_monotony, YES_NO_LABELS)}`,
    `강제 배굴 ${labelValue(entry.bk2101_forced_dorsal_extension, YES_NO_LABELS)}`,
    `회내/회외 ${labelValue(entry.bk2101_prosupination, YES_NO_LABELS)}`,
  ].join(', ');
}

function getBranchNarrative(selectedBkType, entry) {
  switch (selectedBkType) {
    case 'BK2113':
      return [
        `반복 손목 굴신 ${labelValue(entry.bk2113_repetitive_wrist_motion, YES_NO_LABELS)}`,
        `힘 사용 ${labelValue(entry.force_level, LOAD_LEVEL_LABELS)}`,
        `진동 노출 ${labelValue(entry.vibration_exposure, LOAD_LEVEL_LABELS)}`,
      ].join(', ');
    case 'BK2101':
      return getBk2101BranchNarrative(entry);
    case 'BK2106':
      return [
        `직접 압박 ${labelValue(entry.direct_pressure_level, LOAD_LEVEL_LABELS)}`,
        `압박 원인 ${formatList(entry.bk2106_pressure_source, PRESSURE_SOURCE_LABELS)}`,
        `정적 자세 유지 ${labelValue(entry.static_holding_level, LOAD_LEVEL_LABELS)}`,
      ].join(', ');
    case 'BK2103':
      return [
        `진동 공구 ${formatList(entry.bk2103_vibration_tool_type, VIBRATION_TOOL_LABELS)}`,
        `1일 사용 ${entry.bk2103_daily_vibration_hours || '-'}시간`,
        `공구 압박/강한 파지 ${labelValue(entry.bk2103_tool_pressing, YES_NO_LABELS)}`,
      ].join(', ');
    default:
      return '질환별 분기 미입력';
  }
}

export function computeTemporalFlags(temporalSequence = {}) {
  const flags = {};

  if (temporalSequence.recent_task_change && temporalSequence.recent_task_change !== 'none'
    && temporalSequence.improves_with_rest === 'yes') {
    flags.temporal_fit_high = true;
  }

  if (temporalSequence.recent_task_change === 'none'
    && temporalSequence.improves_with_rest === 'no') {
    flags.temporal_fit_unclear = true;
  }

  return flags;
}

export function computeDiagnosisFlags(entry = {}, temporalSequence = {}) {
  const flags = { ...computeTemporalFlags(temporalSequence) };
  const dailyHours = toNumber(entry.daily_exposure_hours);
  const shiftSharePercent = toNumber(entry.shift_share_percent);
  const repetitionPerHour = getBk2101RepetitionPerHour(entry);
  const exposureTypes = entry.exposure_types || [];

  if (entry.direct_anatomic_link === 'yes' && exposureTypes.length >= 1) {
    flags.core_exposure_present = true;
  }

  if (entry.direct_anatomic_link === 'no'
    || (hasValue(entry.direct_anatomic_link) && exposureTypes.length === 0)) {
    flags.core_exposure_unclear = true;
  }

  if (!shouldEvaluateExposureDetails(entry)) {
    return flags;
  }

  if (hasValue(entry.daily_exposure_hours) || hasValue(entry.shift_share_percent)) {
    const isContinuous = entry.work_pattern === 'continuous';
    const highThresholdHours = isContinuous ? 1.5 : 3;
    const highThresholdShare = isContinuous ? 20 : 40;
    const moderateMinHours = isContinuous ? 0 : 1.5;
    const moderateMinShare = isContinuous ? 0 : 20;

    if (dailyHours >= highThresholdHours || shiftSharePercent >= highThresholdShare) {
      flags.daily_share_high = true;
    } else if ((dailyHours >= moderateMinHours && dailyHours < highThresholdHours)
      || (shiftSharePercent >= moderateMinShare && shiftSharePercent < highThresholdShare)) {
      flags.daily_share_moderate = true;
    } else {
      flags.daily_share_low = true;
    }
  }

  if (entry.rest_distribution === 'insufficient'
    || (entry.work_pattern === 'continuous' && entry.rest_distribution === 'moderate')) {
    flags.rest_unfavorable = true;
  }

  if (['moderate', 'high'].includes(entry.force_level)
    || entry.awkward_posture_level === 'frequent') {
    flags.mechanical_load_dominant = true;
  }

  if (entry.direct_pressure_level === 'frequent') {
    flags.pressure_load_dominant = true;
  }

  if (entry.vibration_exposure === 'present') {
    flags.vibration_present = true;
  }

  switch (entry.selectedBkType) {
    case 'BK2113': {
      const repetitionPresent = exposureTypes.includes('repetition');
      const strongForce = ['moderate', 'high'].includes(entry.force_level);
      const vibrationPresent = entry.vibration_exposure === 'present';
      const repetitiveWristMotion = entry.bk2113_repetitive_wrist_motion === 'yes' || repetitionPresent;
      if (repetitiveWristMotion && (strongForce || vibrationPresent)) {
        flags.bk2113_pattern_supported = true;
      }
      if ([repetitionPresent, strongForce, vibrationPresent].filter(Boolean).length >= 2) {
        flags.bk2113_combined_exposure_present = true;
      }
      break;
    }
    case 'BK2101':
      if (repetitionPerHour >= 10000) {
        flags.bk2101_high_freq_example = true;
      }
      if (exposureTypes.includes('repetition')
        && (
          ['moderate', 'high'].includes(entry.force_level)
          || entry.awkward_posture_level === 'frequent'
          || entry.static_holding_level === 'frequent'
          || entry.bk2101_forced_dorsal_extension === 'yes'
          || entry.bk2101_prosupination === 'yes'
        )) {
        flags.bk2101_pattern_supported = true;
      }
      break;
    case 'BK2106':
      if (flags.mechanical_load_dominant
        || entry.static_holding_level === 'frequent'
        || entry.direct_pressure_level === 'frequent') {
        flags.bk2106_pattern_supported = true;
      }
      break;
    case 'BK2103':
      if (entry.vibration_exposure === 'present'
        && (entry.bk2103_vibration_tool_type || []).length >= 1) {
        flags.bk2103_pattern_supported = true;
      }
      if (entry.bk2103_tool_pressing === 'yes'
        || entry.bk2103_frequent_high_force_grip === 'yes') {
        flags.bk2103_transmission_amplifier_present = true;
      }
      break;
    default:
      break;
  }

  return flags;
}

function formatPositiveFlags(flags = {}) {
  return FLAG_ORDER.filter(flagName => flags[flagName]);
}

function buildFlagItems(flags = {}) {
  return formatPositiveFlags(flags).map(key => ({
    key,
    ...(FLAG_META[key] || { label: key, description: key, tone: 'neutral', icon: '❔' }),
  }));
}

function buildRiskFactorItems(flags = {}) {
  return formatPositiveFlags(flags)
    .filter(key => RISK_FACTOR_FLAGS.has(key))
    .map(key => ({
      key,
      ...(FLAG_META[key] || { label: key, description: key, tone: 'neutral', icon: '❔' }),
    }));
}

function hasBkPatternSupported(flags = {}) {
  return Boolean(
    flags.bk2101_pattern_supported
    || flags.bk2103_pattern_supported
    || flags.bk2106_pattern_supported
    || flags.bk2113_pattern_supported
  );
}

function isHighBurdenGateSatisfied(flags = {}) {
  return Boolean(flags.core_exposure_present && flags.daily_share_high && hasBkPatternSupported(flags));
}

export function getWristBurdenGrade(riskFactorCount = 0, flags = {}, thresholds = DEFAULT_BURDEN_THRESHOLDS) {
  if (isHighBurdenGateSatisfied(flags)) return '고도';
  if (riskFactorCount >= thresholds.highByCount) return '고도';
  if (riskFactorCount <= thresholds.noneMax) return '부담 작업 아님';
  if (riskFactorCount === thresholds.mildAt) return '경도';
  if (riskFactorCount <= thresholds.moderateMax) return '중등도';
  return '고도';
}

function getRiskFactorSentence(riskFactorCount = 0, flags = {}) {
  const grade = getWristBurdenGrade(riskFactorCount, flags);
  if (isHighBurdenGateSatisfied(flags)) {
    return '핵심 노출 확인, 일일 노출량 높음, 질환별 패턴 지지 조건을 모두 만족하여 손목/손 부위 부담이 고도인 작업입니다.';
  }
  if (grade === '부담 작업 아님') {
    return `확인된 위험 요인이 ${riskFactorCount}개로 손목/손 부위 부담 작업이 아닙니다.`;
  }
  return `확인된 위험 요인이 ${riskFactorCount}개로 손목/손 부위 부담이 ${grade}인 작업입니다.`;
}

export function formatCommonExposureTypeText(entry = {}) {
  return (entry.exposure_types || []).map(type => {
    if (type === 'repetition') {
      return `반복 동작(${labelValue(entry.repetition_level, REPETITION_LEVEL_LABELS)})`;
    }
    if (type === 'force') {
      return `힘 사용(${labelValue(entry.force_level, LOAD_LEVEL_LABELS)})`;
    }
    if (type === 'awkward_posture') {
      return `부자연스러운 자세(${labelValue(entry.awkward_posture_level, LOAD_LEVEL_LABELS)})`;
    }
    return EXPOSURE_TYPE_LABELS[type] || type;
  }).join(', ') || '-';
}

export function generateNarrative({ diagnosis, entry, temporalSequence }) {
  const bkLabel = BK_TYPE_LABELS[entry.selectedBkType] || 'BK 유형 미선택';
  if (!shouldEvaluateExposureDetails(entry)) {
    return [
      `BK 유형: ${bkLabel}`,
      `해부학적 연결성 ${labelValue(entry.direct_anatomic_link, YES_NO_LABELS)}`,
      '직접 연결되는 핵심 작업이 확인되지 않아 추가 노출 평가는 제한적입니다.',
      `시간적 선후관계 최근 작업변화 ${labelValue(temporalSequence.recent_task_change, TASK_CHANGE_LABELS)}, 변화 시점 ${temporalSequence.task_change_date || '-'}, 증상 발생까지 기간 ${temporalSequence.symptom_onset_interval || '-'}, 휴식/업무중단 시 호전 ${labelValue(temporalSequence.improves_with_rest, YES_NO_LABELS)}`,
    ].join('\n');
  }

  return [
    `상병: ${diagnosis.code || ''} ${diagnosis.name || ''}`.trim(),
    `BK 유형: ${bkLabel}`,
    `문제 작업: ${entry.main_task_name || '미입력'}`,
    `작업량: 1일 ${entry.daily_exposure_hours || '-'}시간, 근무시간 비중 ${entry.shift_share_percent || '-'}%, 주당 ${entry.days_per_week || '-'}일`,
    `공통 노출: ${formatCommonExposureTypeText(entry)}`,
    `질환별 노출 항목: ${getBranchNarrative(entry.selectedBkType, entry)}`,
    `시간적 선후관계 최근 작업변화 ${labelValue(temporalSequence.recent_task_change, TASK_CHANGE_LABELS)}, 변화 시점 ${temporalSequence.task_change_date || '-'}, 증상 발생까지 기간 ${temporalSequence.symptom_onset_interval || '-'}, 휴식/업무중단 시 호전 ${labelValue(temporalSequence.improves_with_rest, YES_NO_LABELS)}`,
  ].join('\n');
}

function buildDiagnosisSummary({ diagnosis, job, entry, temporalSequence }) {
  const safeEntry = entry || {};
  const flags = computeDiagnosisFlags(safeEntry, temporalSequence);
  const riskFactorItems = buildRiskFactorItems(flags);
  const riskFactorCount = riskFactorItems.length;
  const burdenGrade = getWristBurdenGrade(riskFactorCount, flags);
  const detailMissingFields = shouldEvaluateExposureDetails(safeEntry)
    ? [
      ...getMissingFields(safeEntry, REQUIRED_ENTRY_FIELDS),
      ...getMissingFields(safeEntry, getConditionalRequiredFields(safeEntry)),
      ...getMissingFields(safeEntry, getBranchRequiredFields(safeEntry)),
    ]
    : [];
  const missingFields = [
    ...getMissingFields(safeEntry, ['selectedBkType', 'direct_anatomic_link']),
    ...detailMissingFields,
  ];

  return {
    sharedJobId: job?.id || '',
    jobName: job?.jobName || '',
    diagnosisId: diagnosis.id,
    diagnosis,
    entry: safeEntry,
    branchLabel: BK_TYPE_LABELS[safeEntry.selectedBkType] || '-',
    flags,
    positiveFlags: formatPositiveFlags(flags),
    flagItems: buildFlagItems(flags),
    riskFactorItems,
    riskFactorCount,
    burdenGrade,
    riskFactorSentence: getRiskFactorSentence(riskFactorCount, flags),
    missingFields,
    narrative: generateNarrative({ diagnosis, entry: safeEntry, temporalSequence }),
  };
}

export function computeWristCalc(patientData) {
  const shared = patientData.shared || {};
  const jobs = shared.jobs || [];
  const synced = syncWristModuleData(patientData.module || {}, jobs, shared.diagnoses || []);
  const temporalSequence = synced.moduleData.temporalSequence || createWristTemporalSequence();
  const temporalFlags = computeTemporalFlags(temporalSequence);
  const missingCommonFields = getMissingFields(temporalSequence, getTemporalRequiredFields(temporalSequence));
  const temporalFlagItems = buildFlagItems(temporalFlags);
  const age = calculateAge(shared.birthDate, shared.injuryDate);
  const bmi = calculateBMI(shared.height, shared.weight);

  const jobSummaries = synced.moduleData.jobEvaluations.map(jobEvaluation => {
    const job = jobs.find(item => item.id === jobEvaluation.sharedJobId) || { id: jobEvaluation.sharedJobId, jobName: '' };
    const diagnosisSummaries = synced.wristDiagnoses.map(diagnosis => {
      const entry = jobEvaluation.diagnosisEntries.find(item => item.diagnosisId === diagnosis.id);
      return buildDiagnosisSummary({ diagnosis, job, entry, temporalSequence });
    });

    return {
      sharedJobId: job.id,
      jobName: job.jobName || '',
      diagnosisSummaries,
      completedCount: diagnosisSummaries.filter(summary => summary.missingFields.length === 0).length,
      flagCount: diagnosisSummaries.reduce((sum, summary) => sum + summary.flagItems.length, 0),
    };
  });

  const diagnosisSummaries = jobSummaries.flatMap(jobSummary => jobSummary.diagnosisSummaries);

  return {
    age,
    bmi,
    temporalSequence,
    temporalFlags,
    temporalFlagItems,
    missingCommonFields,
    jobSummaries,
    diagnosisSummaries,
    anyFlagged: temporalFlagItems.length > 0 || diagnosisSummaries.some(summary => summary.flagItems.length > 0),
  };
}

function isDiagnosisAssessmentComplete(diag) {
  if (!diag?.side) return false;
  const needRight = diag.side === 'right' || diag.side === 'both';
  const needLeft = diag.side === 'left' || diag.side === 'both';

  if (needRight) {
    if (!diag.confirmedRight || !diag.assessmentRight) return false;
    if (diag.assessmentRight === 'low' && !(diag.reasonRight || []).length) return false;
  }

  if (needLeft) {
    if (!diag.confirmedLeft || !diag.assessmentLeft) return false;
    if (diag.assessmentLeft === 'low' && !(diag.reasonLeft || []).length) return false;
  }

  return true;
}

export function isWristAssessmentComplete(patientData) {
  const shared = patientData.shared || {};
  const jobs = shared.jobs || [];
  const synced = syncWristModuleData(patientData.module || {}, jobs, shared.diagnoses || []);
  const calc = computeWristCalc({ shared, module: synced.moduleData });

  if (synced.wristDiagnoses.length === 0) return false;
  if (jobs.length === 0) return false;
  if (calc.missingCommonFields.length > 0) return false;

  const diagnosisComplete = synced.wristDiagnoses.every(diag => isDiagnosisAssessmentComplete(diag));
  if (!diagnosisComplete) return false;

  return calc.jobSummaries.every(jobSummary =>
    jobSummary.diagnosisSummaries.every(summary => summary.missingFields.length === 0)
  );
}
