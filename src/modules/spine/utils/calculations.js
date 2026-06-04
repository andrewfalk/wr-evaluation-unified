import { formulaDB } from './formulaDB';
import { thresholds } from './thresholds';
import { SPINE_FORMULA_V513 } from './formulaVersion';
import { getEffectiveWorkPeriod } from '../../../core/utils/workPeriod';
import { resolveDiagnosisModule } from '../../../core/utils/diagnosisMapping';
import { convertTimeToSeconds } from './time';
import { computeVibrationCalc, isVibrationComplete, resolveVibrationStatus } from './vibrationCalc';

// 기존 import 경로 하위호환: 다른 파일들이 calculations에서 convertTimeToSeconds를 가져온다.
export { convertTimeToSeconds };
// vibrationCalc의 상태 헬퍼를 calculations 경유로도 노출(UI에서 한 곳에서 import 가능).
export { resolveVibrationStatus };

// MDDM 평가 상태 3단계 해석 (하위호환 포함).
// 'unknown'(미평가) | 'none'(해당없음) | 'present'(평가함).
export function resolveMddmStatus(mod) {
  if (mod.mddmStatus) return mod.mddmStatus;
  if (mod.evalMethod === 'wbv') return 'unknown';      // 1차 WBV 환자: 기본 task 있어도 MDDM 미평가
  return mod.tasks?.length ? 'present' : 'unknown';    // 기존 MDDM 환자(작업 배열 있으면)→present
}

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


// v5.1.3 정정 공식: D_r = sqrt(Σ F_i^2 · t_i / 8h) · 8h
function calculateDailyDoseV513(tasks) {
  const threshold = thresholds.singleForce;
  const REFERENCE_HOURS = 8;
  let sumF2T_hour = 0;
  let includedCount = 0;
  let hasHighForceTask = false;

  tasks.forEach(task => {
    if (task.force >= threshold) {
      const timeSeconds = convertTimeToSeconds(task.timeValue, task.timeUnit);
      const totalTimeHours = (timeSeconds * task.frequency) / 3600;
      sumF2T_hour += task.force * task.force * totalTimeHours;
      includedCount++;
    }
    if (task.force >= 4000) {
      hasHighForceTask = true;
    }
  });

  const dailyDoseNh = Math.sqrt(sumF2T_hour / REFERENCE_HOURS) * REFERENCE_HOURS;
  const dailyDoseKNh = dailyDoseNh / 1000;
  return { sumF2T_hour, dailyDoseNh, dailyDoseKNh, includedCount, hasHighForceTask };
}

// legacy 공식(v5.1.2 이전): sqrt(Σ F^2 · t_초) / 1000 / 60.
// 기존 환자 결과 보존을 위해 그대로 유지한다.
function calculateDailyDoseLegacy(tasks) {
  const threshold = thresholds.singleForce;
  let sumFSquaredT = 0;
  let includedCount = 0;
  let hasHighForceTask = false;

  tasks.forEach(task => {
    if (task.force >= threshold) {
      const timeSeconds = convertTimeToSeconds(task.timeValue, task.timeUnit);
      const totalTime = timeSeconds * task.frequency;
      sumFSquaredT += task.force * task.force * totalTime;
      includedCount++;
    }
    if (task.force >= 4000) {
      hasHighForceTask = true;
    }
  });

  const dailyDoseNs = Math.sqrt(sumFSquaredT);
  const dailyDoseKNh = dailyDoseNs / 1000 / 60;
  return { sumFSquaredT, dailyDoseNs, dailyDoseKNh, includedCount, hasHighForceTask };
}

export function calculateDailyDose(tasks, formulaVersion) {
  if (formulaVersion === SPINE_FORMULA_V513) return calculateDailyDoseV513(tasks);
  return calculateDailyDoseLegacy(tasks);
}

// 작업별 일일 기여도. legacy/V513 정책이 다르다.
//  - legacy: 기존 단일 작업 공식 (F * sqrt(t_초)) / 60000 그대로. 합 != 총량이지만 v5.1.2 출력 보존.
//  - V513: 총량을 F²·t 비중대로 배분. 합 == 총량 (합산 무결성).
// 반환은 입력 tasksInJob과 동일 길이·순서의 배열. 호출부는 index로 꺼낸다.
export function getSpineTaskDoses(tasksInJob, formulaVersion) {
  const list = Array.isArray(tasksInJob) ? tasksInJob : [];
  if (list.length === 0) return [];
  const threshold = thresholds.singleForce;

  if (formulaVersion === SPINE_FORMULA_V513) {
    const weights = list.map(task => {
      const force = Number(task.force) || 0;
      if (force < threshold) return 0;
      const totalSeconds = convertTimeToSeconds(task.timeValue, task.timeUnit) * (Number(task.frequency) || 0);
      return force * force * totalSeconds;
    });
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    if (totalWeight === 0) return list.map(() => 0);
    const { dailyDoseKNh } = calculateDailyDoseV513(list);
    return weights.map(w => dailyDoseKNh * (w / totalWeight));
  }

  // legacy 분기: 단일 작업 공식 그대로
  return list.map(task => {
    const force = Number(task.force) || 0;
    if (force < threshold) return 0;
    const totalSeconds = convertTimeToSeconds(task.timeValue, task.timeUnit) * (Number(task.frequency) || 0);
    return (force * Math.sqrt(totalSeconds)) / 1000 / 60;
  });
}

// 단일 작업 wrapper. tasksInJob과 index를 받아 contributions[index]를 반환.
export function getSpineTaskDose(task, tasksInJob, formulaVersion) {
  const contributions = getSpineTaskDoses(tasksInJob, formulaVersion);
  const idx = (tasksInJob || []).indexOf(task);
  if (idx < 0) return 0;
  return contributions[idx];
}

// 중증도 4단계 분류. 남녀 기준이 분리되어 있다.
export function classifySpineSeverity(dailyKNh, maxForce, gender) {
  const mf = Number(maxForce) || 0;
  const d = Number(dailyKNh) || 0;
  if (gender === 'female') {
    if (d > 6.0 || mf >= 6000) return '고도';
    if (d > 4.5 || mf >= 5000) return '중등도상';
    if (d >= 3.0 || mf >= 4000) return '중등도하';
    return '경도';
  }
  if (d > 8.0 || mf >= 6000) return '고도';
  if (d > 6.0 || mf >= 5000) return '중등도상';
  if (d >= 4.0 || mf >= 4000) return '중등도하';
  return '경도';
}

export function calculateLifetimeDose(dailyDoseKNh, workDaysPerYear, careerYears, careerMonths, gender, hasHighForceTask = false, formulaVersion) {
  const versionKey = formulaVersion === SPINE_FORMULA_V513 ? 'v513' : 'legacy';
  const dailyThreshold = thresholds.dailyDose[versionKey][gender];
  if (dailyDoseKNh < dailyThreshold && !hasHighForceTask) {
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
    }
  };
}

export function assessRisk(comparison) {
  const pct = comparison.court.percent;
  if (pct > 100) return { level: 'danger',  text: '즉각적인 개선 필요',   description: '독일 법원(BSG) 기준 초과' };
  if (pct >= 80) return { level: 'warning', text: '작업 환경 개선 권고', description: '독일 법원(BSG) 기준 근접' };
  return                { level: 'safe',    text: '현재 수준 유지',     description: '독일 법원(BSG) 기준 충족' };
}

export function assessWorkRelatedness(lifetimeDoseMNh, gender) {
  const courtLimit = gender === 'male' ? 12.5 : 8.5;
  const courtHalf  = courtLimit * 0.5;

  let result = { level: '', grade: '', description: '', detail: '', recommendation: '', workContribution: 0, personalContribution: 100 };

  if (lifetimeDoseMNh > courtLimit) {
    result = { ...result, level: 'high', grade: '높음', description: '업무관련성 높음',
      detail: `독일 법원(BSG) 기준(${courtLimit} MN\xB7h)을 초과하여, 직업적 요인이 질병 발생의 주요 원인으로 추정됩니다.`,
      recommendation: '산재보험 요양급여 신청을 적극 권고합니다.' };
  } else if (lifetimeDoseMNh >= courtHalf) {
    result = { ...result, level: 'medium', grade: '불충분', description: '업무관련성 불충분(다른 요건 고려)',
      detail: `독일 법원(BSG) 기준의 50%(${courtHalf.toFixed(1)} MN\xB7h) 이상이나, 기준(${courtLimit} MN\xB7h)을 초과하지는 않습니다. 누적 노출만으로는 충분치 않으므로, 다른 직업적·임상적 요건을 함께 고려해야 합니다.`,
      recommendation: '업무 외 요인 및 추가 임상 소견과 함께 종합 판단이 필요합니다.' };
  } else {
    result = { ...result, level: 'low', grade: '낮음', description: '업무관련성 낮음',
      detail: `현재 누적 노출량(${lifetimeDoseMNh.toFixed(2)} MN\xB7h)이 독일 법원(BSG) 기준의 50%(${courtHalf.toFixed(1)} MN\xB7h) 미만입니다.`,
      recommendation: '현재 노출 수준으로는 업무상 질병 인정이 어렵습니다.' };
  }

  const contributionPercent = Math.min(100, (lifetimeDoseMNh / courtLimit) * 100);
  result.workContribution = Math.round(contributionPercent);
  result.personalContribution = 100 - result.workContribution;
  return result;
}

// shared.jobs에서 직업력 정보 추출 (합산 — 하위호환용)
function getCareerFromSharedJobs(shared) {
  const jobs = shared.jobs || [];
  if (jobs.length === 0) return { careerYears: 0, careerMonths: 0, workDaysPerYear: 250 };

  let totalYears = 0;
  for (const job of jobs) {
    totalYears += getEffectiveWorkPeriod(job);
  }
  const careerYears = Math.floor(totalYears);
  const careerMonths = Math.round((totalYears - careerYears) * 12);
  const workDaysPerYear = jobs[0]?.workDaysPerYear || 250;

  return { careerYears, careerMonths, workDaysPerYear, totalYears };
}

// 직업별 task 그룹핑 (sharedJobId가 없는 task는 첫 번째 job에 귀속)
function groupTasksByJob(tasks, jobs) {
  const firstJobId = jobs.length > 0 ? jobs[0].id : '';
  const groups = new Map();
  for (const job of jobs) {
    groups.set(job.id, []);
  }
  for (const task of tasks) {
    const jobId = task.sharedJobId || firstJobId;
    if (groups.has(jobId)) {
      groups.get(jobId).push(task);
    } else if (firstJobId && groups.has(firstJobId)) {
      groups.get(firstJobId).push(task);
    }
  }
  return groups;
}

// 전체 계산 결과 산출 (모듈 레벨)
// MDDM과 WBV를 공존시켜 반환. MDDM 평탄 필드는 top-level 유지(기존 consumer 무변경),
// WBV는 calc.vibration 서브키. mddmStatus도 top-level에 실어 출력/패널이 게이트한다.
export function computeSpineCalc(patientData) {
  const mod = patientData.module || {};
  const mddmStatus = resolveMddmStatus(mod);
  return {
    ...computeMddmCalc(patientData),
    mddmStatus,
    vibration: computeVibrationCalc(patientData),
  };
}

function computeMddmCalc(patientData) {
  const shared = patientData.shared || {};
  const mod = patientData.module || {};
  const gender = shared.gender || 'male';
  const formulaVersion = mod.formulaVersion;
  const tasks = (mod.tasks || []).map(t => {
    const result = calculateCompressiveForce(t.posture, t.weight, t.correctionFactor);
    return { ...t, force: result ? result.force : 0 };
  });

  // 구형식 호환
  const hasLegacyFields = mod.careerYears !== undefined || mod.workDaysPerYear !== undefined;
  const jobs = shared.jobs || [];

  // 직업별 계산
  const jobResults = [];
  let totalLifetimeDoseKNh = 0;
  let totalLifetimeDoseMNh = 0;
  let anyExcluded = true;

  if (!hasLegacyFields && jobs.length > 0) {
    const taskGroups = groupTasksByJob(tasks, jobs);

    for (const job of jobs) {
      const jobTasks = taskGroups.get(job.id) || [];
      const periodYears = getEffectiveWorkPeriod(job);
      const periodYearsInt = Math.floor(periodYears);
      const periodMonths = Math.round((periodYears - periodYearsInt) * 12);
      const workDaysPerYear = job.workDaysPerYear || 250;

      const jobDailyDose = calculateDailyDose(jobTasks, formulaVersion);
      const jobLifetimeDose = calculateLifetimeDose(
        jobDailyDose.dailyDoseKNh, workDaysPerYear, periodYearsInt, periodMonths, gender, jobDailyDose.hasHighForceTask, formulaVersion
      );

      if (!jobLifetimeDose.excluded) {
        totalLifetimeDoseKNh += jobLifetimeDose.lifetimeDoseKNh;
        totalLifetimeDoseMNh += jobLifetimeDose.lifetimeDoseMNh;
        anyExcluded = false;
      }

      jobResults.push({
        jobId: job.id,
        jobName: job.jobName || '(미입력)',
        periodYears,
        workDaysPerYear,
        tasks: jobTasks,
        dailyDose: jobDailyDose,
        lifetimeDose: jobLifetimeDose
      });
    }
  } else {
    // legacy 또는 job이 없는 경우: 기존 방식
    const career = hasLegacyFields
      ? { careerYears: mod.careerYears || 0, careerMonths: mod.careerMonths || 0, workDaysPerYear: mod.workDaysPerYear || 250 }
      : getCareerFromSharedJobs(shared);

    const legacyDailyDose = calculateDailyDose(tasks, formulaVersion);
    const legacyLifetimeDose = calculateLifetimeDose(
      legacyDailyDose.dailyDoseKNh, career.workDaysPerYear, career.careerYears, career.careerMonths, gender, legacyDailyDose.hasHighForceTask, formulaVersion
    );
    totalLifetimeDoseKNh = legacyLifetimeDose.lifetimeDoseKNh;
    totalLifetimeDoseMNh = legacyLifetimeDose.lifetimeDoseMNh;
    anyExcluded = legacyLifetimeDose.excluded;
  }

  // 전체 통합 결과
  const dailyDose = calculateDailyDose(tasks, formulaVersion);
  const career = hasLegacyFields
    ? { careerYears: mod.careerYears || 0, careerMonths: mod.careerMonths || 0 }
    : getCareerFromSharedJobs(shared);
  const totalYears = (career.totalYears !== undefined) ? career.totalYears : (career.careerYears + career.careerMonths / 12);

  const lifetimeDose = {
    lifetimeDoseKNh: totalLifetimeDoseKNh,
    lifetimeDoseMNh: totalLifetimeDoseMNh,
    excluded: anyExcluded,
    totalYears
  };

  // 다중 직업 통계: 임계치 초과 직업들의 근무기간 가중평균 일일선량
  let weightedDailyDose;
  if (jobResults.length > 1) {
    const qualifying = jobResults.filter(jr => !jr.lifetimeDose.excluded);
    if (qualifying.length > 0) {
      const sumWeighted = qualifying.reduce((s, jr) => s + jr.dailyDose.dailyDoseKNh * jr.periodYears, 0);
      const sumYears = qualifying.reduce((s, jr) => s + jr.periodYears, 0);
      weightedDailyDose = { value: sumYears > 0 ? sumWeighted / sumYears : 0, aboveThreshold: true };
    } else {
      const maxVal = Math.max(...jobResults.map(jr => jr.dailyDose.dailyDoseKNh));
      weightedDailyDose = { value: maxVal, aboveThreshold: false };
    }
  }

  const comparison = compareThresholds(lifetimeDose.lifetimeDoseMNh, gender);
  const risk = assessRisk(comparison);
  const workRelatedness = assessWorkRelatedness(lifetimeDose.lifetimeDoseMNh, gender);
  const maxForce = tasks.length > 0 ? Math.max(...tasks.map(t => t.force)) : 0;

  return { tasks, jobResults, dailyDose, lifetimeDose, comparison, risk, workRelatedness, maxForce, gender, weightedDailyDose, formulaVersion };
}

// 척추 상병 완료 체크 — MDDM/WBV 양 경로 공용.
export function isSpineDiagnosisComplete(patientData) {
  const shared = patientData.shared || {};
  const diagnoses = shared.diagnoses || [];
  const spineDiags = diagnoses.filter(dx =>
    resolveDiagnosisModule(dx, patientData.activeModules || [])?.moduleId === 'spine'
  );
  if (spineDiags.length === 0) return false;
  return spineDiags.every(dx => {
    if (!dx.confirmedRight || !dx.assessmentRight) return false;
    if (dx.assessmentRight === 'low' && (!dx.reasonRight?.length)) return false;
    return true;
  });
}

// MDDM portion 완료: 'none'(해당없음)이면 OK, 'present'면 작업+유효 근속, 'unknown'이면 false.
function isMddmComplete(patientData) {
  const mod = patientData.module || {};
  const shared = patientData.shared || {};
  const status = resolveMddmStatus(mod);
  if (status === 'unknown') return false;
  if (status === 'none') return true;

  const hasTasks = (mod.tasks || []).length > 0;
  // 구형식 호환
  if (mod.careerYears !== undefined) {
    return hasTasks && (mod.careerYears > 0 || mod.careerMonths > 0);
  }
  const hasCareer = (shared.jobs || []).some(j => getEffectiveWorkPeriod(j) > 0);
  return hasTasks && hasCareer;
}

// 완료 판정 — (MDDM 유효 || WBV 유효) && 상병. 둘 중 하나만 평가해도 완료 가능.
export function isSpineAssessmentComplete(patientData) {
  if (!isSpineDiagnosisComplete(patientData)) return false;
  return isMddmComplete(patientData) || isVibrationComplete(patientData);
}
