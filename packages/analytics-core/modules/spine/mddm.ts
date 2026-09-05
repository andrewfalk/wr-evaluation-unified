// src/modules/spine/utils/calculations.js의 MDDM(요추 압박력) 엔진만 이동(로직 무변경).
// WBV(전신진동)는 vibration.ts로 별도 분리(원본 vibrationCalc.js와 대응) — 계획서 §1-3
// spine 항목의 "derived/mddm.ts + derived/vibration.ts 분리" 지침을 따른다.

import { formulaDB, thresholds, SPINE_FORMULA_V513, convertTimeToSeconds } from './constants';
import { getEffectiveWorkPeriod, type JobLike } from '../../workPeriod';
import type { SpineJobLike, SpineModuleShape } from './types';

export interface SpineTask {
  id?: string | number;
  sharedJobId?: string;
  name?: string;
  posture?: string;
  weight?: string | number;
  frequency?: string | number;
  timeValue?: string | number;
  timeUnit?: string;
  correctionFactor?: string | number;
  force?: number;
  [key: string]: unknown;
}

export interface CompressiveForceResult {
  force: number;
  b: number;
  m: number;
  m_corrected: number;
  correctionFactor: number;
  formula: string;
}

// MDDM 평가 상태 3단계 해석 (하위호환 포함).
// 'unknown'(미평가) | 'none'(해당없음) | 'present'(평가함).
export function resolveMddmStatus(mod: SpineModuleShape): string {
  if (mod.mddmStatus) return mod.mddmStatus;
  if (mod.evalMethod === 'wbv') return 'unknown'; // 1차 WBV 환자: 기본 task 있어도 MDDM 미평가
  return (mod.tasks?.length ?? 0) > 0 ? 'present' : 'unknown'; // 기존 MDDM 환자(작업 배열 있으면)→present
}

// F = b + m * L
export function calculateCompressiveForce(
  postureCode: string | undefined,
  weight: unknown,
  correctionFactor: unknown = 1.0,
): CompressiveForceResult | null {
  const formula = postureCode ? formulaDB[postureCode] : undefined;
  if (!formula) return null;
  const m_corrected = formula.applyCorrectionFactor ? formula.m * (correctionFactor as number) : formula.m;
  const force = formula.b + m_corrected * (weight as number);
  return {
    force: Math.round(force),
    b: formula.b,
    m: formula.m,
    m_corrected,
    correctionFactor: formula.applyCorrectionFactor ? (correctionFactor as number) : 1.0,
    formula: `${formula.b} + ${m_corrected.toFixed(1)} × ${weight} = ${Math.round(force)} N`,
  };
}

export interface DailyDoseResult {
  sumF2T_hour?: number;
  sumFSquaredT?: number;
  dailyDoseNh?: number;
  dailyDoseNs?: number;
  dailyDoseKNh: number;
  includedCount: number;
  hasHighForceTask: boolean;
}

// v5.1.3 정정 공식: D_r = sqrt(Σ F_i^2 · t_i / 8h) · 8h
function calculateDailyDoseV513(tasks: SpineTask[]): DailyDoseResult {
  const threshold = thresholds.singleForce;
  const REFERENCE_HOURS = 8;
  let sumF2T_hour = 0;
  let includedCount = 0;
  let hasHighForceTask = false;

  tasks.forEach((task) => {
    const force = task.force ?? 0;
    if (force >= threshold) {
      const timeSeconds = convertTimeToSeconds(task.timeValue as number, task.timeUnit as string);
      const totalTimeHours = (timeSeconds * (task.frequency as number)) / 3600;
      sumF2T_hour += force * force * totalTimeHours;
      includedCount++;
    }
    if (force >= 4000) {
      hasHighForceTask = true;
    }
  });

  const dailyDoseNh = Math.sqrt(sumF2T_hour / REFERENCE_HOURS) * REFERENCE_HOURS;
  const dailyDoseKNh = dailyDoseNh / 1000;
  return { sumF2T_hour, dailyDoseNh, dailyDoseKNh, includedCount, hasHighForceTask };
}

// legacy 공식(v5.1.2 이전): sqrt(Σ F^2 · t_초) / 1000 / 60. 기존 환자 결과 보존을 위해 그대로 유지.
function calculateDailyDoseLegacy(tasks: SpineTask[]): DailyDoseResult {
  const threshold = thresholds.singleForce;
  let sumFSquaredT = 0;
  let includedCount = 0;
  let hasHighForceTask = false;

  tasks.forEach((task) => {
    const force = task.force ?? 0;
    if (force >= threshold) {
      const timeSeconds = convertTimeToSeconds(task.timeValue as number, task.timeUnit as string);
      const totalTime = timeSeconds * (task.frequency as number);
      sumFSquaredT += force * force * totalTime;
      includedCount++;
    }
    if (force >= 4000) {
      hasHighForceTask = true;
    }
  });

  const dailyDoseNs = Math.sqrt(sumFSquaredT);
  const dailyDoseKNh = dailyDoseNs / 1000 / 60;
  return { sumFSquaredT, dailyDoseNs, dailyDoseKNh, includedCount, hasHighForceTask };
}

export function calculateDailyDose(tasks: SpineTask[], formulaVersion: string | undefined): DailyDoseResult {
  if (formulaVersion === SPINE_FORMULA_V513) return calculateDailyDoseV513(tasks);
  return calculateDailyDoseLegacy(tasks);
}

// 작업별 일일 기여도. legacy/V513 정책이 다르다(합 무결성 차이, 원본 주석 그대로).
export function getSpineTaskDoses(tasksInJob: SpineTask[] | undefined, formulaVersion: string | undefined): number[] {
  const list = Array.isArray(tasksInJob) ? tasksInJob : [];
  if (list.length === 0) return [];
  const threshold = thresholds.singleForce;

  if (formulaVersion === SPINE_FORMULA_V513) {
    const weights = list.map((task) => {
      const force = Number(task.force) || 0;
      if (force < threshold) return 0;
      const totalSeconds = convertTimeToSeconds(task.timeValue as number, task.timeUnit as string) * (Number(task.frequency) || 0);
      return force * force * totalSeconds;
    });
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    if (totalWeight === 0) return list.map(() => 0);
    const { dailyDoseKNh } = calculateDailyDoseV513(list);
    return weights.map((w) => dailyDoseKNh * (w / totalWeight));
  }

  return list.map((task) => {
    const force = Number(task.force) || 0;
    if (force < threshold) return 0;
    const totalSeconds = convertTimeToSeconds(task.timeValue as number, task.timeUnit as string) * (Number(task.frequency) || 0);
    return (force * Math.sqrt(totalSeconds)) / 1000 / 60;
  });
}

export function getSpineTaskDose(task: SpineTask, tasksInJob: SpineTask[], formulaVersion: string | undefined): number {
  const contributions = getSpineTaskDoses(tasksInJob, formulaVersion);
  const idx = (tasksInJob || []).indexOf(task);
  if (idx < 0) return 0;
  return contributions[idx];
}

// 중증도 4단계 분류. 남녀 기준이 분리되어 있다.
export function classifySpineSeverity(dailyKNh: unknown, maxForce: unknown, gender: string): string {
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

export interface LifetimeDoseResult {
  lifetimeDoseKNh: number;
  lifetimeDoseMNh: number;
  excluded: boolean;
  totalYears?: number;
}

export function calculateLifetimeDose(
  dailyDoseKNh: number,
  workDaysPerYear: string | number,
  careerYears: string | number,
  careerMonths: string | number,
  gender: string,
  hasHighForceTask = false,
  formulaVersion: string | undefined,
): LifetimeDoseResult {
  const versionKey = formulaVersion === SPINE_FORMULA_V513 ? 'v513' : 'legacy';
  const dailyThreshold = thresholds.dailyDose[versionKey][gender as 'male' | 'female'];
  if (dailyDoseKNh < dailyThreshold && !hasHighForceTask) {
    return { lifetimeDoseKNh: 0, lifetimeDoseMNh: 0, excluded: true };
  }
  // 원본은 careerYears/careerMonths/workDaysPerYear를 Number()로 강제 변환하지 않고 그대로
  // 산술에 흘려보낸다 — 문자열이면 JS의 암묵적 강제변환(+는 문자열 연결, *는 ToNumber)에
  // 그대로 노출되어 NaN이 나올 수 있다(계획서 §1-1a 6라운드 spine 보완). 여기서 Number()를
  // 추가하면 실제 계산과 달라지므로(shoulder 리뷰에서 확립된 원칙) 타입만 단언하고 원본과
  // 동일한 산술을 재현한다.
  const totalYears = (careerYears as number) + (careerMonths as number) / 12;
  const lifetimeDoseKNh = dailyDoseKNh * (workDaysPerYear as number) * (totalYears as number);
  const lifetimeDoseMNh = lifetimeDoseKNh / 1000;
  return { lifetimeDoseKNh, lifetimeDoseMNh, excluded: false, totalYears: totalYears as number };
}

export function compareThresholds(lifetimeDoseMNh: number, gender: string) {
  const limits = thresholds.lifetimeDose;
  const g = gender as 'male' | 'female';
  return {
    mddm: {
      limit: limits.mddm[g],
      percent: (lifetimeDoseMNh / limits.mddm[g]) * 100,
      status: lifetimeDoseMNh <= limits.mddm[g] ? 'safe' : 'danger',
    },
    court: {
      limit: limits.court[g],
      percent: (lifetimeDoseMNh / limits.court[g]) * 100,
      status: lifetimeDoseMNh <= limits.court[g] ? 'safe' : lifetimeDoseMNh <= limits.court[g] * 1.2 ? 'warning' : 'danger',
    },
  };
}

export function assessRisk(comparison: ReturnType<typeof compareThresholds>) {
  const pct = comparison.court.percent;
  if (pct > 100) return { level: 'danger', text: '즉각적인 개선 필요', description: '독일 법원(BSG) 기준 초과' };
  if (pct >= 80) return { level: 'warning', text: '작업 환경 개선 권고', description: '독일 법원(BSG) 기준 근접' };
  return { level: 'safe', text: '현재 수준 유지', description: '독일 법원(BSG) 기준 충족' };
}

export function assessWorkRelatedness(lifetimeDoseMNh: number, gender: string) {
  const courtLimit = gender === 'male' ? 12.5 : 8.5;
  const courtHalf = courtLimit * 0.5;

  let result = {
    level: '',
    grade: '',
    description: '',
    detail: '',
    recommendation: '',
    workContribution: 0,
    personalContribution: 100,
  };

  if (lifetimeDoseMNh > courtLimit) {
    result = {
      ...result,
      level: 'high',
      grade: '높음',
      description: '업무관련성 높음',
      detail: `독일 법원(BSG) 기준(${courtLimit} MN\xB7h)을 초과하여, 직업적 요인이 질병 발생의 주요 원인으로 추정됩니다.`,
      recommendation: '산재보험 요양급여 신청을 적극 권고합니다.',
    };
  } else if (lifetimeDoseMNh >= courtHalf) {
    result = {
      ...result,
      level: 'medium',
      grade: '불충분',
      description: '업무관련성 불충분(다른 요건 고려)',
      detail: `독일 법원(BSG) 기준의 50%(${courtHalf.toFixed(1)} MN\xB7h) 이상이나, 기준(${courtLimit} MN\xB7h)을 초과하지는 않습니다. 누적 노출만으로는 충분치 않으므로, 다른 직업적·임상적 요건을 함께 고려해야 합니다.`,
      recommendation: '업무 외 요인 및 추가 임상 소견과 함께 종합 판단이 필요합니다.',
    };
  } else {
    result = {
      ...result,
      level: 'low',
      grade: '낮음',
      description: '업무관련성 낮음',
      detail: `현재 누적 노출량(${lifetimeDoseMNh.toFixed(2)} MN\xB7h)이 독일 법원(BSG) 기준의 50%(${courtHalf.toFixed(1)} MN\xB7h) 미만입니다.`,
      recommendation: '현재 노출 수준으로는 업무상 질병 인정이 어렵습니다.',
    };
  }

  const contributionPercent = Math.min(100, (lifetimeDoseMNh / courtLimit) * 100);
  result.workContribution = Math.round(contributionPercent);
  result.personalContribution = 100 - result.workContribution;
  return result;
}

interface SpineCareer {
  // getCareerFromSharedJobs는 항상 진짜 number를 만들지만(Math.floor/Math.round), legacy
  // 분기(mod.careerYears || 0)는 원본처럼 Number() 강제변환 없이 raw 값을 그대로 통과시켜
  // 문자열일 수 있다 — 두 분기를 하나의 타입으로 묶으려면 정직하게 string | number여야 한다.
  careerYears: string | number;
  careerMonths: string | number;
  workDaysPerYear: string | number;
  totalYears: number | undefined;
}

// shared.jobs에서 직업력 정보 추출 (합산 — 하위호환용)
function getCareerFromSharedJobs(shared: { jobs?: SpineJobLike[] }): SpineCareer {
  const jobs = shared.jobs || [];
  if (jobs.length === 0) return { careerYears: 0, careerMonths: 0, workDaysPerYear: 250, totalYears: undefined };

  let totalYears = 0;
  for (const job of jobs) {
    totalYears += getEffectiveWorkPeriod(job as JobLike);
  }
  const careerYears = Math.floor(totalYears);
  const careerMonths = Math.round((totalYears - careerYears) * 12);
  // 원본은 Number()로 강제변환하지 않고 job.workDaysPerYear를 그대로 쓴다(shoulder 리뷰에서
  // 확립된 함정과 동일 — Number()를 추가하면 '250days' 같은 값의 계산 결과가 달라진다).
  const workDaysPerYear = jobs[0]?.workDaysPerYear || 250;

  return { careerYears, careerMonths, workDaysPerYear, totalYears };
}

// 직업별 task 그룹핑 (sharedJobId가 없는 task는 첫 번째 job에 귀속)
function groupTasksByJob(tasks: SpineTask[], jobs: SpineJobLike[]): Map<string, SpineTask[]> {
  const firstJobId = jobs.length > 0 ? jobs[0].id || '' : '';
  const groups = new Map<string, SpineTask[]>();
  for (const job of jobs) {
    groups.set(job.id || '', []);
  }
  for (const task of tasks) {
    const jobId = task.sharedJobId || firstJobId;
    if (groups.has(jobId)) {
      groups.get(jobId)!.push(task);
    } else if (firstJobId && groups.has(firstJobId)) {
      groups.get(firstJobId)!.push(task);
    }
  }
  return groups;
}

export interface MddmJobResult {
  jobId: string;
  jobName: string;
  periodYears: number;
  workDaysPerYear: string | number;
  tasks: SpineTask[];
  dailyDose: DailyDoseResult;
  lifetimeDose: LifetimeDoseResult;
}

export interface MddmCalcResult {
  tasks: SpineTask[];
  jobResults: MddmJobResult[];
  dailyDose: DailyDoseResult;
  lifetimeDose: LifetimeDoseResult;
  comparison: ReturnType<typeof compareThresholds>;
  risk: ReturnType<typeof assessRisk>;
  workRelatedness: ReturnType<typeof assessWorkRelatedness>;
  maxForce: number;
  gender: string;
  weightedDailyDose?: { value: number; aboveThreshold: boolean };
  formulaVersion: string | undefined;
}

export type MddmFormulaPolicy = 'recompute_recorded_version' | 'recompute_current';

// 계획서 §2.3 formulaPolicy 디스패처 — recompute_recorded_version(저장된 mod.formulaVersion
// 그대로, 기존 calculateDailyDose(tasks, mod.formulaVersion)와 동일 동작)과
// recompute_current(항상 SPINE_FORMULA_V513으로 강제)를 분기한다. extractor는 이번 PR에서
// recipe가 없으므로 기본값(recompute_recorded_version)만 호출한다.
export function resolveMddmFormulaVersion(
  mod: { formulaVersion?: string },
  policy: MddmFormulaPolicy = 'recompute_recorded_version',
): string | undefined {
  return policy === 'recompute_current' ? SPINE_FORMULA_V513 : mod.formulaVersion;
}

// MDDM 전체 계산 — 원본과 동일 로직(formulaPolicy 분기만 추가, §2.3).
export function computeMddmCalc(
  patientData: { shared?: { jobs?: SpineJobLike[]; gender?: string }; module?: SpineModuleShape },
  opts: { formulaPolicy?: MddmFormulaPolicy } = {},
): MddmCalcResult {
  const shared = patientData.shared || {};
  const mod = patientData.module || {};
  const gender = shared.gender || 'male';
  const formulaVersion = resolveMddmFormulaVersion(mod, opts.formulaPolicy ?? 'recompute_recorded_version');
  const tasks: SpineTask[] = ((mod.tasks as SpineTask[]) || []).map((t) => {
    const result = calculateCompressiveForce(t.posture, t.weight, t.correctionFactor);
    return { ...t, force: result ? result.force : 0 };
  });

  // 구형식 호환
  const hasLegacyFields = mod.careerYears !== undefined || mod.workDaysPerYear !== undefined;
  const jobs = shared.jobs || [];

  const jobResults: MddmJobResult[] = [];
  let totalLifetimeDoseKNh = 0;
  let totalLifetimeDoseMNh = 0;
  let anyExcluded = true;

  if (!hasLegacyFields && jobs.length > 0) {
    const taskGroups = groupTasksByJob(tasks, jobs);

    for (const job of jobs) {
      const jobTasks = taskGroups.get(job.id || '') || [];
      const periodYears = getEffectiveWorkPeriod(job as JobLike);
      const periodYearsInt = Math.floor(periodYears);
      const periodMonths = Math.round((periodYears - periodYearsInt) * 12);
      // 원본은 job.workDaysPerYear를 Number()로 강제변환하지 않는다(shoulder 리뷰 원칙과 동일).
      const workDaysPerYear = job.workDaysPerYear || 250;

      const jobDailyDose = calculateDailyDose(jobTasks, formulaVersion);
      const jobLifetimeDose = calculateLifetimeDose(
        jobDailyDose.dailyDoseKNh,
        workDaysPerYear,
        periodYearsInt,
        periodMonths,
        gender,
        jobDailyDose.hasHighForceTask,
        formulaVersion,
      );

      if (!jobLifetimeDose.excluded) {
        totalLifetimeDoseKNh += jobLifetimeDose.lifetimeDoseKNh;
        totalLifetimeDoseMNh += jobLifetimeDose.lifetimeDoseMNh;
        anyExcluded = false;
      }

      jobResults.push({
        jobId: job.id || '',
        jobName: job.jobName || '(미입력)',
        periodYears,
        workDaysPerYear,
        tasks: jobTasks,
        dailyDose: jobDailyDose,
        lifetimeDose: jobLifetimeDose,
      });
    }
  } else {
    // 원본은 mod.careerYears/careerMonths/workDaysPerYear를 Number()로 강제변환하지 않는다
    // (shoulder 리뷰 원칙과 동일 — 문자열이면 raw 그대로 산술에 흘러가 NaN 위험이 있다).
    const career: SpineCareer = hasLegacyFields
      ? { careerYears: mod.careerYears || 0, careerMonths: mod.careerMonths || 0, workDaysPerYear: mod.workDaysPerYear || 250, totalYears: undefined }
      : getCareerFromSharedJobs(shared);

    const legacyDailyDose = calculateDailyDose(tasks, formulaVersion);
    const legacyLifetimeDose = calculateLifetimeDose(
      legacyDailyDose.dailyDoseKNh,
      career.workDaysPerYear,
      career.careerYears,
      career.careerMonths,
      gender,
      legacyDailyDose.hasHighForceTask,
      formulaVersion,
    );
    totalLifetimeDoseKNh = legacyLifetimeDose.lifetimeDoseKNh;
    totalLifetimeDoseMNh = legacyLifetimeDose.lifetimeDoseMNh;
    anyExcluded = legacyLifetimeDose.excluded;
  }

  const dailyDose = calculateDailyDose(tasks, formulaVersion);
  const career: Pick<SpineCareer, 'careerYears' | 'careerMonths' | 'totalYears'> = hasLegacyFields
    ? { careerYears: mod.careerYears || 0, careerMonths: mod.careerMonths || 0, totalYears: undefined }
    : getCareerFromSharedJobs(shared);
  // 원본과 동일하게 Number() 없이 그대로 더한다(문자열이면 +는 문자열 연결이 되어 하류에서
  // NaN을 만들 수 있다 — 계획서 §1-1a 6라운드 spine 보완이 지적한 바로 그 경로).
  const totalYears =
    career.totalYears !== undefined ? career.totalYears : (career.careerYears as number) + (career.careerMonths as number) / 12;

  const lifetimeDose: LifetimeDoseResult = {
    lifetimeDoseKNh: totalLifetimeDoseKNh,
    lifetimeDoseMNh: totalLifetimeDoseMNh,
    excluded: anyExcluded,
    totalYears,
  };

  let weightedDailyDose: { value: number; aboveThreshold: boolean } | undefined;
  if (jobResults.length > 1) {
    const qualifying = jobResults.filter((jr) => !jr.lifetimeDose.excluded);
    if (qualifying.length > 0) {
      const sumWeighted = qualifying.reduce((s, jr) => s + jr.dailyDose.dailyDoseKNh * jr.periodYears, 0);
      const sumYears = qualifying.reduce((s, jr) => s + jr.periodYears, 0);
      weightedDailyDose = { value: sumYears > 0 ? sumWeighted / sumYears : 0, aboveThreshold: true };
    } else {
      const maxVal = Math.max(...jobResults.map((jr) => jr.dailyDose.dailyDoseKNh));
      weightedDailyDose = { value: maxVal, aboveThreshold: false };
    }
  }

  const comparison = compareThresholds(lifetimeDose.lifetimeDoseMNh, gender);
  const risk = assessRisk(comparison);
  const workRelatedness = assessWorkRelatedness(lifetimeDose.lifetimeDoseMNh, gender);
  const maxForce = tasks.length > 0 ? Math.max(...tasks.map((t) => t.force ?? 0)) : 0;

  return { tasks, jobResults, dailyDose, lifetimeDose, comparison, risk, workRelatedness, maxForce, gender, weightedDailyDose, formulaVersion };
}

// MDDM portion 완료: 'none'(해당없음)이면 OK, 'present'면 작업+유효 근속, 'unknown'이면 false.
export function isMddmComplete(patientData: { shared?: { jobs?: SpineJobLike[] }; module?: SpineModuleShape }): boolean {
  const mod = patientData.module || {};
  const shared = patientData.shared || {};
  const status = resolveMddmStatus(mod);
  if (status === 'unknown') return false;
  if (status === 'none') return true;

  const hasTasks = ((mod.tasks as SpineTask[]) || []).length > 0;
  if (mod.careerYears !== undefined) {
    // 원본 그대로 — 관계 연산자(>)는 양쪽을 ToNumber로 강제변환하므로 Number()를 따로
    // 씌우지 않아도 결과가 같다(shoulder류 `||` 기본값 대입과는 다른 경우).
    return hasTasks && ((mod.careerYears as number) > 0 || (mod.careerMonths as number) > 0);
  }
  const hasCareer = (shared.jobs || []).some((j) => getEffectiveWorkPeriod(j as JobLike) > 0);
  return hasTasks && hasCareer;
}
