// src/modules/spine/utils/vibrationCalc.js에서 WBV(전신진동, BK2110) 엔진 이동(로직 무변경).
// MDDM은 mddm.ts로 별도 분리 — 계획서 §1-3 spine 항목의 파일 분리 지침을 따른다.

import { convertTimeToSeconds, vibrationThresholds, WBV_FORMULA_V1 } from './constants';
import { getEffectiveWorkPeriod, type JobLike } from '../../workPeriod';
import type { SpineJobLike, SpineModuleShape } from './types';

const REFERENCE_HOURS = 8;

export interface SpineVibrationInterval {
  id?: string | number;
  sharedJobId?: string;
  name?: string;
  awMin?: string | number;
  awMax?: string | number;
  timeValue?: string | number;
  timeUnit?: string;
  [key: string]: unknown;
}

// 전신진동 평가 상태 3단계 해석 (하위호환 포함).
// 'unknown'(미평가) | 'none'(노출없음) | 'present'(노출있음/평가함).
export function resolveVibrationStatus(mod: SpineModuleShape): string {
  if (mod.vibrationExposureStatus) return mod.vibrationExposureStatus;
  if (mod.evalMethod === 'wbv' && (mod.vibrationIntervals as unknown[] | undefined)?.length) return 'present'; // 1차 WBV 환자 보존
  return 'unknown';
}

// 구간 유효성: awMin>=0 && awMax>0 && awMax>=awMin && time>0
export function isIntervalValid(interval: SpineVibrationInterval): boolean {
  const awMin = Number(interval.awMin);
  const awMax = Number(interval.awMax);
  const tHours = convertTimeToSeconds(interval.timeValue as number, interval.timeUnit as string) / 3600;
  return Number.isFinite(awMin) && Number.isFinite(awMax) && awMin >= 0 && awMax > 0 && awMax >= awMin && tHours > 0;
}

// invalid 사유 텍스트 (사용자 경고용)
function invalidReason(interval: SpineVibrationInterval): string {
  const awMin = Number(interval.awMin);
  const awMax = Number(interval.awMax);
  const tHours = convertTimeToSeconds(interval.timeValue as number, interval.timeUnit as string) / 3600;
  if (!(awMax > 0)) return 'aw 상한이 0보다 커야 합니다';
  if (!(awMin >= 0)) return 'aw 하한은 0 이상이어야 합니다';
  if (!(awMax >= awMin)) return 'aw 상한이 하한보다 작습니다';
  if (!(tHours > 0)) return '노출시간이 0보다 커야 합니다';
  return '입력값이 유효하지 않습니다';
}

// 단일 구간의 A(8) — 주어진 aw에 대해.
export function intervalA8(aw: unknown, timeValue: unknown, timeUnit: unknown): number {
  const a = Number(aw) || 0;
  const tHours = convertTimeToSeconds(timeValue as number, timeUnit as string) / 3600;
  if (a <= 0 || tHours <= 0) return 0;
  return a * Math.sqrt(tHours / REFERENCE_HOURS);
}

// 한 직업의 구간들을 에너지합해 A(8) 산출. bound: 'min' | 'max'
export function combineA8(intervals: SpineVibrationInterval[], bound: 'min' | 'max'): number {
  let sum = 0;
  for (const iv of intervals) {
    const aw = bound === 'max' ? Number(iv.awMax) || 0 : Number(iv.awMin) || 0;
    const tHours = convertTimeToSeconds(iv.timeValue as number, iv.timeUnit as string) / 3600;
    if (aw > 0 && tHours > 0) sum += aw * aw * tHours;
  }
  return Math.sqrt(sum / REFERENCE_HOURS);
}

// 직업별 평생 DV. 0.63 게이트 미만이면 0. 원본은 workDaysPerYear를 Number()로 강제변환하지
// 않는다(shoulder 리뷰 원칙과 동일) — 타입만 정직하게 string|number로 열어둔다.
export function jobDV(amax8: number, workDaysPerYear: string | number, careerYears: number): number {
  if (amax8 < vibrationThresholds.dailyAmax) return 0;
  return amax8 * amax8 * (workDaysPerYear as number) * careerYears;
}

// 구간을 직업별로 그룹핑 (sharedJobId가 없는 구간은 첫 직업에 귀속).
function groupIntervalsByJob(intervals: SpineVibrationInterval[], jobs: SpineJobLike[]): Map<string, SpineVibrationInterval[]> {
  const firstJobId = jobs.length > 0 ? jobs[0].id || '' : '';
  const groups = new Map<string, SpineVibrationInterval[]>();
  for (const job of jobs) {
    groups.set(job.id || '', []);
  }
  for (const iv of intervals) {
    const jobId = iv.sharedJobId || firstJobId;
    if (groups.has(jobId)) {
      groups.get(jobId)!.push(iv);
    } else if (firstJobId && groups.has(firstJobId)) {
      groups.get(firstJobId)!.push(iv);
    }
  }
  return groups;
}

// 범위 인지 status. 경계는 이상(>=).
function rangeStatus(min: number, max: number, threshold: number): 'danger' | 'warning' | 'safe' {
  if (min >= threshold) return 'danger';
  if (max >= threshold) return 'warning';
  return 'safe';
}

function pct(value: number, threshold: number): number {
  return threshold > 0 ? (value / threshold) * 100 : 0;
}

export interface VibrationJobResult {
  jobId: string;
  jobName: string;
  periodYears: number;
  workDaysPerYear: string | number;
  intervals: SpineVibrationInterval[];
  amax8: { min: number; max: number };
  dv: { min: number; max: number };
}

export interface VibrationValidation {
  hasInvalidIntervals: boolean;
  invalidIntervals: Array<{ id?: string | number; name?: string; reason: string }>;
  messages: string[];
}

export interface VibrationCalcResult {
  evalMethod: 'wbv';
  noExposure?: boolean;
  exposureStatus: string;
  intervals: SpineVibrationInterval[];
  jobResults: VibrationJobResult[];
  amax8: { min: number; max: number };
  dv: { min: number; max: number };
  comparison: {
    daily: { threshold: number; percent: { min: number; max: number }; status: string };
    lifetime: { threshold: number; percent: { min: number; max: number }; status: string };
  };
  validation: VibrationValidation;
  risk: { level: string; text: string; description: string };
  actionValue: number;
  limitZ: number;
  gender: string;
  formulaVersion: string;
}

// 'present'가 아닐 때(unknown/none) 반환할 safe-default. 모든 consumer가 destructure하는
// 필드를 빠짐없이 채워 크래시를 방지하고, exposureStatus로 미평가/노출없음을 구분한다.
function vibrationNoExposureCalc(status: string, gender: string): VibrationCalcResult {
  const noneText = status === 'none';
  return {
    evalMethod: 'wbv',
    noExposure: true,
    exposureStatus: status,
    intervals: [],
    jobResults: [],
    amax8: { min: 0, max: 0 },
    dv: { min: 0, max: 0 },
    comparison: {
      daily: { threshold: vibrationThresholds.dailyAmax, percent: { min: 0, max: 0 }, status: 'safe' },
      lifetime: { threshold: vibrationThresholds.lifetimeDV, percent: { min: 0, max: 0 }, status: 'safe' },
    },
    validation: { hasInvalidIntervals: false, invalidIntervals: [], messages: [] },
    risk: {
      level: 'safe',
      text: noneText ? '전신진동 노출 없음' : '전신진동 미평가',
      description: noneText ? '전신진동 노출 없음으로 평가함' : '전신진동 평가 미실시',
    },
    actionValue: vibrationThresholds.actionValue,
    limitZ: vibrationThresholds.limitZ,
    gender,
    formulaVersion: WBV_FORMULA_V1,
  };
}

export function computeVibrationCalc(patientData: {
  shared?: { jobs?: SpineJobLike[]; gender?: string };
  module?: SpineModuleShape;
}): VibrationCalcResult {
  const shared = patientData.shared || {};
  const mod = patientData.module || {};
  const gender = shared.gender || 'male';
  const jobs = shared.jobs || [];

  // 3상태: 'present'가 아니면 결과 계산 없이 safe-default 반환.
  const status = resolveVibrationStatus(mod);
  if (status !== 'present') return vibrationNoExposureCalc(status, gender);

  const allIntervals = (mod.vibrationIntervals as SpineVibrationInterval[]) || [];

  const invalidIntervals: Array<{ id?: string | number; name?: string; reason: string }> = [];
  const validIntervals: SpineVibrationInterval[] = [];
  for (const iv of allIntervals) {
    if (isIntervalValid(iv)) {
      validIntervals.push(iv);
    } else {
      invalidIntervals.push({ id: iv.id, name: iv.name, reason: invalidReason(iv) });
    }
  }
  const messages = invalidIntervals.length
    ? [`유효하지 않은 진동작업 구간 ${invalidIntervals.length}개가 계산에서 제외되었습니다 (평가를 완료할 수 없습니다).`]
    : [];
  const validation: VibrationValidation = {
    hasInvalidIntervals: invalidIntervals.length > 0,
    invalidIntervals,
    messages,
  };

  const groups = groupIntervalsByJob(validIntervals, jobs);

  const jobResults: VibrationJobResult[] = [];
  let dvMinTotal = 0;
  let dvMaxTotal = 0;
  let amaxMinMax = 0;
  let amaxMaxMax = 0;

  for (const job of jobs) {
    const jobIntervals = groups.get(job.id || '') || [];
    const periodYears = getEffectiveWorkPeriod(job as JobLike);
    // 원본은 job.workDaysPerYear를 Number()로 강제변환하지 않는다.
    const workDaysPerYear = job.workDaysPerYear || 250;

    const amax8Min = combineA8(jobIntervals, 'min');
    const amax8Max = combineA8(jobIntervals, 'max');
    const dvMin = jobDV(amax8Min, workDaysPerYear, periodYears);
    const dvMax = jobDV(amax8Max, workDaysPerYear, periodYears);

    dvMinTotal += dvMin;
    dvMaxTotal += dvMax;
    amaxMinMax = Math.max(amaxMinMax, amax8Min);
    amaxMaxMax = Math.max(amaxMaxMax, amax8Max);

    jobResults.push({
      jobId: job.id || '',
      jobName: job.jobName || '(미입력)',
      periodYears,
      workDaysPerYear,
      intervals: jobIntervals,
      amax8: { min: amax8Min, max: amax8Max },
      dv: { min: dvMin, max: dvMax },
    });
  }

  const amax8 = { min: amaxMinMax, max: amaxMaxMax };
  const dv = { min: dvMinTotal, max: dvMaxTotal };

  const dailyThreshold = vibrationThresholds.dailyAmax;
  const lifetimeThreshold = vibrationThresholds.lifetimeDV;

  const comparison = {
    daily: {
      threshold: dailyThreshold,
      percent: { min: pct(amax8.min, dailyThreshold), max: pct(amax8.max, dailyThreshold) },
      status: rangeStatus(amax8.min, amax8.max, dailyThreshold),
    },
    lifetime: {
      threshold: lifetimeThreshold,
      percent: { min: pct(dv.min, lifetimeThreshold), max: pct(dv.max, lifetimeThreshold) },
      status: rangeStatus(dv.min, dv.max, lifetimeThreshold),
    },
  };

  const risk = assessVibrationRisk(comparison);

  return {
    evalMethod: 'wbv',
    exposureStatus: 'present',
    intervals: validIntervals,
    jobResults,
    amax8,
    dv,
    comparison,
    validation,
    risk,
    actionValue: vibrationThresholds.actionValue,
    limitZ: vibrationThresholds.limitZ,
    gender,
    formulaVersion: WBV_FORMULA_V1,
  };
}

// risk는 평생 DV(BK2110 인정요건의 핵심)를 기준으로 한다.
// daily는 DV 산입 게이트일 뿐 위험도 기준이 아니다.
export function assessVibrationRisk(comparison: VibrationCalcResult['comparison']): { level: string; text: string; description: string } {
  const lifetime = comparison.lifetime.status;
  const daily = comparison.daily.status;

  if (lifetime === 'danger') {
    return { level: 'danger', text: '즉각적인 개선 필요', description: 'BK2110 생애누적 기준(DV 1400 (m/s²)²) 도달/초과 가능' };
  }
  if (lifetime === 'warning') {
    return { level: 'warning', text: '작업 환경 개선 권고', description: '생애누적 기준(DV 1400)을 노출 구간이 걸침' };
  }
  if (daily === 'warning' || daily === 'danger') {
    return { level: 'safe', text: '현재 수준 유지', description: '일일 기준(0.63 m/s²) 도달 가능 구간은 있으나 생애누적 기준 미달' };
  }
  return { level: 'safe', text: '현재 수준 유지', description: 'BK2110 기준 미달' };
}

// 전신진동 완료 판정(상병 체크는 호출부 합성):
//  'unknown'(미평가)→false, 'none'(노출없음)→true, 'present'→유효구간≥1 + invalid 0 + 유효 근속.
export function isVibrationComplete(patientData: { shared?: { jobs?: SpineJobLike[] }; module?: SpineModuleShape }): boolean {
  const mod = patientData.module || {};
  const shared = patientData.shared || {};
  const status = resolveVibrationStatus(mod);
  if (status === 'unknown') return false;
  if (status === 'none') return true;

  const intervals = (mod.vibrationIntervals as SpineVibrationInterval[]) || [];
  const validCount = intervals.filter(isIntervalValid).length;
  const hasInvalid = intervals.some((iv) => !isIntervalValid(iv));
  if (validCount < 1 || hasInvalid) return false;

  const hasCareer = (shared.jobs || []).some((j) => getEffectiveWorkPeriod(j as JobLike) > 0);
  return hasCareer;
}
