import { formulaDB } from './formulaDB';
import { thresholds } from './thresholds';
import { getEffectiveWorkPeriod } from '../../../core/utils/workPeriod';
import { getDiagnosisModuleHint } from '../../../core/utils/diagnosisMapping';

// F = b + m * L
export function calculateCompressiveForce(postureCode, weight, correctionFactor = 1.0) {
  const formula = formulaDB[postureCode];
  if (!formula) return null;
  const m_corrected = formula.applyCorrectionFactor ? formula.m * correctionFactor : formula.m;
  const force = formula.b + m_corrected * weight;
  return {
    force: Math.round(force),
    b: formula.b,
    m: formula.m,
    m_corrected,
    correctionFactor: formula.applyCorrectionFactor ? correctionFactor : 1.0,
    formula: `${formula.b} + ${m_corrected.toFixed(1)} \u00D7 ${weight} = ${Math.round(force)} N`
  };
}

export function convertTimeToSeconds(value, unit) {
  switch (unit) {
    case 'min': return value * 60;
    case 'hr': return value * 3600;
    default: return value;
  }
}

// D = sqrt(sum(F^2 * t)) / 1000 / 60
export function calculateDailyDose(tasks, gender) {
  const threshold = thresholds.singleForce[gender];
  let sumFSquaredT = 0;
  let includedCount = 0;

  tasks.forEach(task => {
    if (task.force >= threshold) {
      const timeSeconds = convertTimeToSeconds(task.timeValue, task.timeUnit);
      const totalTime = timeSeconds * task.frequency;
      sumFSquaredT += task.force * task.force * totalTime;
      includedCount++;
    }
  });

  const dailyDoseNs = Math.sqrt(sumFSquaredT);
  const dailyDoseKNh = dailyDoseNs / 1000 / 60;
  return { sumFSquaredT, dailyDoseNs, dailyDoseKNh, includedCount };
}

export function calculateLifetimeDose(dailyDoseKNh, workDaysPerYear, careerYears, careerMonths, gender) {
  const dailyThreshold = thresholds.dailyDose[gender];
  if (dailyDoseKNh < dailyThreshold) {
    return { lifetimeDoseKNh: 0, lifetimeDoseMNh: 0, excluded: true };
  }
  const totalYears = careerYears + careerMonths / 12;
  const lifetimeDoseKNh = dailyDoseKNh * workDaysPerYear * totalYears;
  const lifetimeDoseMNh = lifetimeDoseKNh / 1000;
  return { lifetimeDoseKNh, lifetimeDoseMNh, excluded: false, totalYears };
}

export function compareThresholds(lifetimeDoseMNh, gender) {
  const limits = thresholds.lifetimeDose;
  return {
    mddm: {
      limit: limits.mddm[gender],
      percent: (lifetimeDoseMNh / limits.mddm[gender]) * 100,
      status: lifetimeDoseMNh <= limits.mddm[gender] ? 'safe' : 'danger'
    },
    court: {
      limit: limits.court[gender],
      percent: (lifetimeDoseMNh / limits.court[gender]) * 100,
      status: lifetimeDoseMNh <= limits.court[gender] ? 'safe' : (lifetimeDoseMNh <= limits.court[gender] * 1.2 ? 'warning' : 'danger')
    },
    dws2: {
      limit: limits.dws2[gender],
      percent: (lifetimeDoseMNh / limits.dws2[gender]) * 100,
      status: lifetimeDoseMNh <= limits.dws2[gender] ? 'safe' : (lifetimeDoseMNh <= limits.dws2[gender] * 1.2 ? 'warning' : 'danger')
    }
  };
}

export function assessRisk(comparison) {
  const dangerCount = [comparison.mddm, comparison.court, comparison.dws2].filter(c => c.status === 'danger').length;
  const warningCount = [comparison.mddm, comparison.court, comparison.dws2].filter(c => c.status === 'warning').length;
  if (dangerCount >= 2) return { level: 'danger', text: '즉각적인 개선 필요', description: '다수 기준 초과' };
  if (dangerCount >= 1 || warningCount >= 2) return { level: 'warning', text: '작업 환경 개선 권고', description: '일부 기준 초과' };
  return { level: 'safe', text: '현재 수준 유지', description: '모든 기준 충족' };
}

export function assessWorkRelatedness(lifetimeDoseMNh, gender) {
  const dws2Limit = gender === 'male' ? 7.0 : 3.0;
  const courtLimit = gender === 'male' ? 12.5 : 8.5;
  const mddmLimit = gender === 'male' ? 25 : 17;
  const mddmHalfLimit = mddmLimit * 0.5;

  let result = { level: '', grade: '', description: '', detail: '', recommendation: '', workContribution: 0, personalContribution: 100 };

  if (lifetimeDoseMNh >= dws2Limit) {
    result = { ...result, level: 'high', grade: '높음', description: '업무관련성 높음',
      detail: `DWS2 연구 기준(${dws2Limit} MN\xB7h)을 초과하여, 직업적 요인이 질병 발생의 주요 원인으로 추정됩니다.`,
      recommendation: '산재보험 요양급여 신청을 적극 권고합니다.' };
  } else if (lifetimeDoseMNh >= courtLimit) {
    result = { ...result, level: 'medium', grade: '중등도', description: '업무관련성 중등도',
      detail: `독일 법원 기준(${courtLimit} MN\xB7h)을 초과하여, 직업적 요인의 상당한 기여가 인정될 수 있습니다.`,
      recommendation: '산재 신청 가능성이 있습니다.' };
  } else if (lifetimeDoseMNh >= mddmHalfLimit) {
    result = { ...result, level: 'low', grade: '낮음', description: '업무관련성 낮음',
      detail: `MDDM 기준의 50%(${mddmHalfLimit.toFixed(1)} MN\xB7h) 이상이나, 법원 기준 미만입니다.`,
      recommendation: '업무 외 요인의 영향을 함께 평가할 필요가 있습니다.' };
  } else {
    result = { ...result, level: 'insufficient', grade: '불충분', description: '업무관련성 불충분',
      detail: `현재 누적 노출량(${lifetimeDoseMNh.toFixed(2)} MN\xB7h)이 MDDM 기준의 50% 미만입니다.`,
      recommendation: '현재 노출 수준으로는 업무상 질병 인정이 어렵습니다.' };
  }

  const contributionPercent = Math.min(100, (lifetimeDoseMNh / dws2Limit) * 100);
  result.workContribution = Math.round(contributionPercent);
  result.personalContribution = 100 - result.workContribution;
  return result;
}

// shared.jobs에서 직업력 정보 추출
function getCareerFromSharedJobs(shared) {
  const jobs = shared.jobs || [];
  if (jobs.length === 0) return { careerYears: 0, careerMonths: 0, workDaysPerYear: 250 };

  // 모든 직종의 근무기간 합산
  let totalYears = 0;
  for (const job of jobs) {
    totalYears += getEffectiveWorkPeriod(job);
  }
  const careerYears = Math.floor(totalYears);
  const careerMonths = Math.round((totalYears - careerYears) * 12);
  const workDaysPerYear = jobs[0]?.workDaysPerYear || 250;

  return { careerYears, careerMonths, workDaysPerYear, totalYears };
}

// 전체 계산 결과 산출 (모듈 레벨)
export function computeSpineCalc(patientData) {
  const shared = patientData.shared || {};
  const mod = patientData.module || {};
  const gender = shared.gender || 'male';
  const tasks = (mod.tasks || []).map(t => {
    const result = calculateCompressiveForce(t.posture, t.weight, t.correctionFactor);
    return { ...t, force: result ? result.force : 0 };
  });

  // 구형식 호환: mod에 직업 필드가 있으면 그대로 사용, 없으면 shared.jobs에서 추출
  const hasLegacyFields = mod.careerYears !== undefined || mod.workDaysPerYear !== undefined;
  const career = hasLegacyFields
    ? { careerYears: mod.careerYears || 0, careerMonths: mod.careerMonths || 0, workDaysPerYear: mod.workDaysPerYear || 250 }
    : getCareerFromSharedJobs(shared);

  const dailyDose = calculateDailyDose(tasks, gender);
  const lifetimeDose = calculateLifetimeDose(
    dailyDose.dailyDoseKNh,
    career.workDaysPerYear,
    career.careerYears,
    career.careerMonths,
    gender
  );
  const comparison = compareThresholds(lifetimeDose.lifetimeDoseMNh, gender);
  const risk = assessRisk(comparison);
  const workRelatedness = assessWorkRelatedness(lifetimeDose.lifetimeDoseMNh, gender);
  const maxForce = tasks.length > 0 ? Math.max(...tasks.map(t => t.force)) : 0;

  return { tasks, dailyDose, lifetimeDose, comparison, risk, workRelatedness, maxForce, gender };
}

// 완료 판정
export function isSpineAssessmentComplete(patientData) {
  const mod = patientData.module || {};
  const shared = patientData.shared || {};
  const hasTasks = (mod.tasks || []).length > 0;

  // 구형식 호환
  if (mod.careerYears !== undefined) {
    if (!(hasTasks && (mod.careerYears > 0 || mod.careerMonths > 0))) return false;
  } else {
    // 신형식: shared.jobs에 유효한 기간이 있는지
    const hasCareer = (shared.jobs || []).some(j => getEffectiveWorkPeriod(j) > 0);
    if (!(hasTasks && hasCareer)) return false;
  }

  // 종합소견: 척추 상병의 상병 상태 + 업무관련성 체크
  const diagnoses = shared.diagnoses || [];
  const spineDiags = diagnoses.filter(dx => {
    const hint = getDiagnosisModuleHint(dx);
    return hint?.moduleId === 'spine';
  });
  if (spineDiags.length === 0) return true;
  return spineDiags.every(dx => {
    if (!dx.confirmedRight || !dx.assessmentRight) return false;
    if (dx.assessmentRight === 'low' && (!dx.reasonRight?.length)) return false;
    return true;
  });
}
