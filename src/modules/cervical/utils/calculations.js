import { calculateAge, calculateBMI } from '../../../core/utils/common';
import { getEffectiveWorkPeriod } from '../../../core/utils/workPeriod';
import {
  EXPOSURE_TYPE_LABELS,
  syncCervicalModuleData,
} from './data';

export { calculateAge, calculateBMI };

const YES_NO_LABELS = {
  yes: '예',
  no: '아니오',
};

const FIELD_LABELS = {
  main_task_name: '문제 작업명',
  exposure_types: '노출 유형',
  load_weight_kg: '하중',
  carry_hours_per_shift: '한 작업 교대(shift)당 노출 시간',
  forced_neck_posture: '운반 시 목의 부자연스러운 자세(굴곡, 신전, 꺾임 20도 초과)가 강제됨',
  neck_flexion_hours_per_day: '굴곡/신전/회전/측굴을 모두 포함한 비중립 정적 자세 수행 시간',
  combined_flexion_rotation_posture: '굴곡/신전과 회전/측굴이 동시에 발생',
  precision_work: '고도의 정밀(precision) 작업 여부',
};

const FLAG_ORDER = [
  'heavy_load_present',
  'carry_time_supported',
  'forced_neck_posture_present',
  'cumulative_load_supported',
  'bk2109_pattern_supported',
  'daily_share_high',
  'daily_share_moderate',
  'awkward_static_neck_supported',
  'mechanical_cervical_load_dominant',
];

const RISK_FACTOR_FLAGS = new Set(FLAG_ORDER);
const BK2109_REFERENCE_KG_HOURS = 44000;

export const FLAG_META = {
  heavy_load_present: {
    label: '무거운 하중 기준 충족',
    description: '어깨에 올려 운반하는 하중이 40kg 이상입니다.',
    tone: 'warning',
  },
  carry_time_supported: {
    label: '운반시간 기준 충족',
    description: '한 작업 교대당 운반 시간이 0.5시간 이상입니다.',
    tone: 'warning',
  },
  forced_neck_posture_present: {
    label: '운반 시 부자연스러운 목 자세 강제',
    description: '하중 운반 중 목의 부자연스러운 자세가 강제됩니다.',
    tone: 'warning',
  },
  cumulative_load_supported: {
    label: '누적 총부하 기준 충족',
    description: '누적 총부하량이 44,000 kg·h 이상입니다.',
    tone: 'warning',
  },
  bk2109_pattern_supported: {
    label: 'BK2109형 패턴 지지',
    description: '독일 BK2109 정량 4요건이 모두 충족됩니다.',
    tone: 'positive',
  },
  daily_share_high: {
    label: '일일 노출량 높음',
    description: '하중 운반과 비중립 정적 자세의 대표 노출 시간이 하루 3.5시간 이상입니다.',
    tone: 'positive',
  },
  daily_share_moderate: {
    label: '일일 노출량 중간',
    description: '하중 운반과 비중립 정적 자세의 대표 노출 시간이 하루 2.5시간 이상 3.5시간 미만입니다.',
    tone: 'info',
  },
  awkward_static_neck_supported: {
    label: '비중립·정적 목 부하',
    description: '비중립 정적 목 자세 노출이 의미 있게 확인됩니다.',
    tone: 'positive',
  },
  mechanical_cervical_load_dominant: {
    label: '기계적 경추 부담 우세',
    description: '기계적 경추 부담 노출이 우세하게 확인됩니다.',
    tone: 'positive',
  },
};

function toNumber(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== '' && value !== null && value !== undefined;
}

function labelValue(value, map) {
  if (!value) return '-';
  return map[value] || value;
}

function formatPositiveFlags(flags = {}) {
  return FLAG_ORDER.filter(flagName => flags[flagName]);
}

function buildFlagItems(flags = {}) {
  return formatPositiveFlags(flags).map(key => ({
    key,
    ...(FLAG_META[key] || { label: key, description: key, tone: 'neutral' }),
  }));
}

function buildRiskFactorItems(flags = {}) {
  return formatPositiveFlags(flags)
    .filter(key => RISK_FACTOR_FLAGS.has(key))
    .map(key => ({
      key,
      ...(FLAG_META[key] || { label: key, description: key, tone: 'neutral' }),
    }));
}

function getEntryRequiredFields(entry = {}) {
  const required = ['main_task_name', 'exposure_types'];
  const exposureTypes = entry.exposure_types || [];

  if (exposureTypes.includes('shoulder_heavy_load')) {
    required.push('load_weight_kg', 'carry_hours_per_shift', 'forced_neck_posture');
  }

  if (exposureTypes.includes('awkward_static_neck_load')) {
    required.push(
      'neck_flexion_hours_per_day',
      'combined_flexion_rotation_posture',
      'precision_work'
    );
  }

  return required;
}

function getMissingFields(entry = {}) {
  return getEntryRequiredFields(entry)
    .filter(field => !hasValue(entry[field]))
    .map(field => FIELD_LABELS[field] || field);
}

function getCumulativeKgHours(entry = {}, job = {}) {
  const loadWeightKg = toNumber(entry.load_weight_kg);
  const carryHoursPerShift = toNumber(entry.carry_hours_per_shift);
  const workDaysPerYear = Number(job.workDaysPerYear) || 0;
  const yearsExposed = getEffectiveWorkPeriod(job);

  return loadWeightKg * carryHoursPerShift * workDaysPerYear * yearsExposed;
}

function getDailyRepresentativeHours(entry = {}) {
  return toNumber(entry.carry_hours_per_shift) + toNumber(entry.neck_flexion_hours_per_day);
}

function formatNumber(value, digits = 0) {
  return Number(value || 0).toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatHours(value) {
  if (!hasValue(value)) return '-';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  if (Number.isInteger(numeric)) return `${numeric}시간`;
  return `${numeric.toLocaleString('ko-KR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })}시간`;
}

export function formatExposureTypeText(entry = {}) {
  return (entry.exposure_types || []).map(type => EXPOSURE_TYPE_LABELS[type] || type).join(', ') || '-';
}

export function computeDiagnosisFlags(entry = {}, job = {}) {
  const flags = {};
  const exposureTypes = entry.exposure_types || [];
  const cumulativeKgHours = getCumulativeKgHours(entry, job);
  const awkwardHours = toNumber(entry.neck_flexion_hours_per_day);
  const representativeHours = getDailyRepresentativeHours(entry);

  if (exposureTypes.includes('shoulder_heavy_load') && toNumber(entry.load_weight_kg) >= 40) {
    flags.heavy_load_present = true;
  }
  if (exposureTypes.includes('shoulder_heavy_load') && toNumber(entry.carry_hours_per_shift) >= 0.5) {
    flags.carry_time_supported = true;
  }
  if (exposureTypes.includes('shoulder_heavy_load') && entry.forced_neck_posture === 'yes') {
    flags.forced_neck_posture_present = true;
  }
  if (exposureTypes.includes('shoulder_heavy_load') && cumulativeKgHours >= BK2109_REFERENCE_KG_HOURS) {
    flags.cumulative_load_supported = true;
  }
  if (
    flags.heavy_load_present
    && flags.carry_time_supported
    && flags.forced_neck_posture_present
    && flags.cumulative_load_supported
  ) {
    flags.bk2109_pattern_supported = true;
  }

  if (representativeHours >= 3.5) {
    flags.daily_share_high = true;
  } else if (representativeHours >= 2.5) {
    flags.daily_share_moderate = true;
  }

  if (
    exposureTypes.includes('awkward_static_neck_load')
    && (
      awkwardHours >= 2
      || (
        awkwardHours >= 1.5
        && (
          entry.combined_flexion_rotation_posture === 'yes'
          || entry.precision_work === 'yes'
        )
      )
    )
  ) {
    flags.awkward_static_neck_supported = true;
  }

  if (
    flags.awkward_static_neck_supported
    || flags.daily_share_high
    || flags.bk2109_pattern_supported
  ) {
    flags.mechanical_cervical_load_dominant = true;
  }

  return {
    ...flags,
    cumulativeKgHours,
    representativeHours,
  };
}

export function getCervicalBurdenGrade(flags = {}) {
  if (flags.bk2109_pattern_supported) return 'high_bk2109';
  if (
    flags.awkward_static_neck_supported
    || flags.daily_share_high
    || flags.daily_share_moderate
  ) {
    return 'present';
  }
  return 'low';
}

function getCervicalConclusionText(burdenGrade) {
  if (burdenGrade === 'high_bk2109') {
    return '어깨에 무거운 하중 운반, 운반시간 기준, 강제된 부자연스러운 목 자세, 누적 총부하 기준이 확인되어 독일 BK2109(어깨에 무거운 하중 올려 운반)형 경추 부담 노출이 강하게 지지됩니다.';
  }
  if (burdenGrade === 'present') {
    return '장시간 비중립·정적 목 부하가 확인되어 경추 부담 노출은 있으나, 독일 BK2109(어깨에 무거운 하중 올려 운반) 정량 요건 지지는 제한적입니다.';
  }
  return '현재 입력된 노출정보만으로는 경추 부담 노출을 뚜렷하게 지지하기 어렵습니다.';
}

export function generateNarrative({ job, entry, flags }) {
  const cumulativeKgHours = flags.cumulativeKgHours || 0;
  const referenceRatio = cumulativeKgHours > 0
    ? (cumulativeKgHours / BK2109_REFERENCE_KG_HOURS) * 100
    : 0;
  const lines = [
    `직업: ${job.jobName || '-'}`,
    `문제 작업: ${entry.main_task_name || '-'}`,
    `노출 유형: ${formatExposureTypeText(entry)}`,
  ];

  if ((entry.exposure_types || []).includes('shoulder_heavy_load')) {
    lines.push('(어깨에 무거운 하중 올려서 운반)');
    lines.push(` - 하중 : ${hasValue(entry.load_weight_kg) ? `${formatNumber(entry.load_weight_kg)}kg` : '-'}`);
    lines.push(` - 한 작업 교대(shift)당 노출 시간 : ${formatHours(entry.carry_hours_per_shift)}`);
    lines.push(` - 운반 시 목의 부자연스러운 자세가 강제 : ${labelValue(entry.forced_neck_posture, YES_NO_LABELS)}`);
    lines.push(
      ` - 누적 총부하량 : ${formatNumber(cumulativeKgHours)} kg·h (참고치 ${formatNumber(BK2109_REFERENCE_KG_HOURS)} kg·h, 참고치 대비 ${formatNumber(referenceRatio, 1)}%)`
    );
  }

  if ((entry.exposure_types || []).includes('awkward_static_neck_load')) {
    lines.push('(비중립·정적 목 부하)');
    lines.push(` - 수행 시간 : ${formatHours(entry.neck_flexion_hours_per_day)}`);
    lines.push(` - 굴곡/신전과 회전/측굴이 동시에 발생 : ${labelValue(entry.combined_flexion_rotation_posture, YES_NO_LABELS)}`);
    lines.push(` - 고도의 정밀(precision) 작업 : ${labelValue(entry.precision_work, YES_NO_LABELS)}`);
  }

  if (entry.notes) {
    lines.push(`메모: ${entry.notes}`);
  }

  return lines.join('\n');
}

function buildDiagnosisSummary({ diagnosis, job, entry }) {
  const rawFlags = computeDiagnosisFlags(entry, job);
  const flags = Object.fromEntries(
    Object.entries(rawFlags).filter(([key, value]) => key === 'cumulativeKgHours' || key === 'representativeHours' || value)
  );
  const burdenGrade = getCervicalBurdenGrade(flags);
  const riskFactorItems = buildRiskFactorItems(flags);

  return {
    sharedJobId: job?.id || '',
    jobName: job?.jobName || '',
    diagnosisId: diagnosis.id,
    diagnosis,
    entry,
    flags,
    flagItems: buildFlagItems(flags),
    riskFactorItems,
    riskFactorCount: riskFactorItems.length,
    burdenGrade,
    missingFields: getMissingFields(entry),
    narrative: generateNarrative({ job, entry, flags }),
    conclusionText: getCervicalConclusionText(burdenGrade),
    cumulativeKgHours: rawFlags.cumulativeKgHours || 0,
    representativeHours: rawFlags.representativeHours || 0,
    workDaysPerYear: Number(job?.workDaysPerYear) || 0,
    yearsExposed: getEffectiveWorkPeriod(job),
  };
}

export function computeCervicalCalc(patientData) {
  const shared = patientData.shared || {};
  const jobs = shared.jobs || [];
  const synced = syncCervicalModuleData(patientData.module || {}, jobs, shared.diagnoses || []);
  const age = calculateAge(shared.birthDate, shared.injuryDate);
  const bmi = calculateBMI(shared.height, shared.weight);

  const jobSummaries = synced.moduleData.jobEvaluations.map(jobEvaluation => {
    const job = jobs.find(item => item.id === jobEvaluation.sharedJobId) || { id: jobEvaluation.sharedJobId, jobName: '' };
    const diagnosisSummaries = synced.cervicalDiagnoses.map(diagnosis => {
      const entry = jobEvaluation.diagnosisEntries.find(item => item.diagnosisId === diagnosis.id)
        || {};
      return buildDiagnosisSummary({ diagnosis, job, entry });
    });

    return {
      sharedJobId: job.id,
      jobName: job.jobName || '',
      diagnosisSummaries,
      completedCount: diagnosisSummaries.filter(summary => summary.missingFields.length === 0).length,
      flaggedCount: diagnosisSummaries.reduce((sum, summary) => sum + summary.flagItems.length, 0),
    };
  });

  const diagnosisSummaries = jobSummaries.flatMap(jobSummary => jobSummary.diagnosisSummaries);

  return {
    age,
    bmi,
    jobSummaries,
    diagnosisSummaries,
    anyFlagged: diagnosisSummaries.some(summary => summary.flagItems.length > 0),
  };
}

function isDiagnosisAssessmentComplete(diag) {
  if (!diag.confirmedRight || !diag.assessmentRight) return false;
  if (diag.assessmentRight === 'low' && !(diag.reasonRight || []).length) return false;
  return true;
}

export function isCervicalAssessmentComplete(patientData) {
  const shared = patientData.shared || {};
  const jobs = shared.jobs || [];
  const synced = syncCervicalModuleData(patientData.module || {}, jobs, shared.diagnoses || []);
  const calc = computeCervicalCalc({ shared, module: synced.moduleData });

  if (synced.cervicalDiagnoses.length === 0) return false;
  if (jobs.length === 0) return false;

  const diagnosisComplete = synced.cervicalDiagnoses.every(diag => isDiagnosisAssessmentComplete(diag));
  if (!diagnosisComplete) return false;

  return calc.jobSummaries.every(jobSummary =>
    jobSummary.diagnosisSummaries.every(summary => summary.missingFields.length === 0)
  );
}
