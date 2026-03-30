import { calculateAge, calculateBMI } from '../../../core/utils/common';
import { getEffectiveWorkPeriod } from '../../../core/utils/workPeriod';
import { getDiagnosisModuleHint } from '../../../core/utils/diagnosisMapping';

export { calculateAge, calculateBMI };

// BK2117 임계값 (평생 누적 시간)
export const EXPOSURE_LIMITS = {
  overhead:          { limit: 3600,  unit: '시간', label: '오버헤드/어깨높이 이상 작업' },
  repetitiveMedium:  { limit: 38000, unit: '시간', label: '반복동작 중간속도 (4~14회/분)' },
  repetitiveFast:    { limit: 9400,  unit: '시간', label: '반복동작 고도 (≥15회/분)' },
  heavyLoad:         { limit: 200,   unit: '시간', label: '중량물(≥20kg) 취급 시간' },
  vibration:         { limit: 5300,  unit: '시간', label: '손-팔 진동 (≥3 m/s²)' },
};

// 단일 변수 초과 여부
export function checkExposureLimit(cumulativeHours, limit) {
  if (!cumulativeHours || cumulativeHours === 0) return { ratio: 0, exceeded: false };
  const ratio = cumulativeHours / limit;
  return { ratio, exceeded: ratio >= 1.0 };
}

// 직력 1개에 대한 각 변수별 누적 기여 계산
export function computeJobExposures(extras, periodYears, workDaysPerYear) {
  const wdpy = workDaysPerYear || 250;
  const years = periodYears || 0;

  const heavyLoadCount   = parseFloat(extras.heavyLoadCount) || 0;
  const heavyLoadSeconds = parseFloat(extras.heavyLoadSeconds) || 0;
  const heavyLoadHoursPerDay = (heavyLoadCount * heavyLoadSeconds) / 3600;

  const fields = [
    { key: 'overhead',         value: parseFloat(extras.overheadHours) || 0 },
    { key: 'repetitiveMedium', value: parseFloat(extras.repetitiveMediumHours) || 0 },
    { key: 'repetitiveFast',   value: parseFloat(extras.repetitiveFastHours) || 0 },
    { key: 'heavyLoad',        value: heavyLoadHoursPerDay },
    { key: 'vibration',        value: parseFloat(extras.vibrationHours) || 0 },
  ];

  return fields.map(({ key, value }) => {
    const def = EXPOSURE_LIMITS[key];
    const cumulativeHours = value * wdpy * years;
    return {
      key,
      label: def.label,
      dailyHours: value,
      cumulativeHours,
      limit: def.limit,
      unit: def.unit,
    };
  });
}

// shared.jobs + shoulder.jobExtras 합성
function mergeJobsWithExtras(sharedJobs, shoulderExtras) {
  return (sharedJobs || []).map(sj => {
    const extra = (shoulderExtras || []).find(e => e.sharedJobId === sj.id) || {};
    return {
      ...sj,
      overheadHours:        extra.overheadHours || '',
      repetitiveMediumHours: extra.repetitiveMediumHours || '',
      repetitiveFastHours:  extra.repetitiveFastHours || '',
      heavyLoadCount:       extra.heavyLoadCount || '',
      heavyLoadSeconds:     extra.heavyLoadSeconds || '',
      vibrationHours:       extra.vibrationHours || '',
      evidenceSources:      extra.evidenceSources || [],
    };
  });
}

// 종합소견 완료 여부 판정
export function isShoulderAssessmentComplete(patientData) {
  const diagnoses = patientData.shared?.diagnoses || [];
  if (!diagnoses.length) return false;
  const shoulderDiags = diagnoses.filter(dx => {
    const hint = getDiagnosisModuleHint(dx);
    return !hint || hint.moduleId === 'shoulder';
  });
  if (!shoulderDiags.length) return true;
  return shoulderDiags.every(dx => {
    if (!dx.side) return false;
    const needRight = dx.side === 'right' || dx.side === 'both';
    const needLeft  = dx.side === 'left'  || dx.side === 'both';
    if (needRight) {
      if (!dx.confirmedRight || !dx.assessmentRight) return false;
      if (dx.assessmentRight === 'low' && (!dx.reasonRight?.length)) return false;
    }
    if (needLeft) {
      if (!dx.confirmedLeft || !dx.assessmentLeft) return false;
      if (dx.assessmentLeft === 'low' && (!dx.reasonLeft?.length)) return false;
    }
    return true;
  });
}

// 전체 계산
export function computeShoulderCalc(patientData) {
  const shared = patientData.shared || {};
  const mod    = patientData.module || {};
  const age    = calculateAge(shared.birthDate, shared.injuryDate);
  const bmi    = calculateBMI(shared.height, shared.weight);

  const jobs = mergeJobsWithExtras(shared.jobs, mod.jobExtras);

  // 직력별 상세
  const jobBurdens = jobs.map(j => {
    const periodYears    = getEffectiveWorkPeriod(j);
    const workDaysPerYear = j.workDaysPerYear || 250;
    const exposures = computeJobExposures(j, periodYears, workDaysPerYear);
    return { ...j, periodYears, workDaysPerYear, exposures };
  });

  // 전체 합산
  const keys = Object.keys(EXPOSURE_LIMITS);
  const totals = keys.map(key => {
    const def = EXPOSURE_LIMITS[key];
    const totalHours = jobBurdens.reduce((sum, jb) => {
      const exp = jb.exposures.find(e => e.key === key);
      return sum + (exp?.cumulativeHours || 0);
    }, 0);
    const { ratio, exceeded } = checkExposureLimit(totalHours, def.limit);
    return { key, label: def.label, totalHours, limit: def.limit, unit: def.unit, ratio, exceeded };
  });

  // 반복동작 OR 조건
  const repMedium = totals.find(t => t.key === 'repetitiveMedium');
  const repFast   = totals.find(t => t.key === 'repetitiveFast');
  const anyRepetitiveExceeded = !!(repMedium?.exceeded || repFast?.exceeded);

  const anyExceeded = totals.some(t => t.exceeded);

  return { age, bmi, jobBurdens, totals, anyExceeded, anyRepetitiveExceeded };
}

// 텍스트 헬퍼
export const getSideText = (side) =>
  side === 'right' ? '우측' : side === 'left' ? '좌측' : side === 'both' ? '양측' : '-';

export const getStatusText = (status) =>
  status === 'confirmed' ? '확인' : status === 'unconfirmed' ? '미확인' : '-';

export const getEllmanText = (ellman) =>
  ellman === 'N/A' ? '해당없음' : ellman || '-';

export const getReasonText = (reasons, other) => {
  if (typeof reasons === 'string') reasons = reasons ? [reasons] : [];
  if (!reasons || reasons.length === 0) return '-';
  const reasonMap = {
    unrelated: '신체부담과 관련없는 상병',
    mild:      '상병 미확인/연령대비 경미',
    delayed:   '업무중단 후 상당기간 경과',
    lowBurden: '누적 신체부담 낮음',
    other:     `기타 (${other || ''})`,
  };
  return reasons.map(r => reasonMap[r] || r).join('\n');
};
