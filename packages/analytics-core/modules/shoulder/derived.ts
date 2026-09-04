// src/modules/shoulder/utils/calculations.js에서 계산 함수만 이동(로직 무변경). UI 라벨 매핑
// 함수(getSideText/getStatusText/getEllmanText/getReasonText)는 이동하지 않음 — 옛 파일에 잔류.
// sync 함수 없음(§1-3) — ShoulderEvaluation.jsx의 useEffect(job extras 채움)는 UI 편의 동작.

import { calculateAge, calculateBMI } from '../../common';
import { getEffectiveWorkPeriod, type JobLike } from '../../workPeriod';
import { resolveDiagnosisModule, type DiagnosisLike } from '../../diagnosisMapping';
import type { CompletionContext } from '../../analyticsRegistry';

export interface ShoulderJobExtras {
  sharedJobId?: string;
  overheadHours?: string | number;
  repetitiveMediumHours?: string | number;
  repetitiveFastHours?: string | number;
  heavyLoadCount?: string | number;
  heavyLoadSeconds?: string | number;
  vibrationHours?: string | number;
  evidenceSources?: unknown[];
}

export interface ExposureLimitDef {
  limit: number;
  unit: string;
  label: string;
}

// BK2117 임계값 (평생 누적 시간)
export const EXPOSURE_LIMITS: Record<string, ExposureLimitDef> = {
  overhead: { limit: 3600, unit: '시간', label: '오버헤드/어깨높이 이상 작업' },
  repetitiveMedium: { limit: 38000, unit: '시간', label: '반복동작 중간속도 (4~14회/분)' },
  repetitiveFast: { limit: 9400, unit: '시간', label: '반복동작 고도 (≥15회/분)' },
  heavyLoad: { limit: 200, unit: '시간', label: '중량물(≥20kg) 취급 시간' },
  vibration: { limit: 5300, unit: '시간', label: '손-팔 진동 (≥3 m/s²)' },
};

export function checkExposureLimit(
  cumulativeHours: number,
  limit: number,
): { ratio: number; exceeded: boolean } {
  if (!cumulativeHours || cumulativeHours === 0) return { ratio: 0, exceeded: false };
  const ratio = cumulativeHours / limit;
  return { ratio, exceeded: ratio >= 1.0 };
}

export interface JobExposure {
  key: string;
  label: string;
  dailyHours: number;
  cumulativeHours: number;
  limit: number;
  unit: string;
}

// 직력 1개에 대한 각 변수별 누적 기여 계산
export function computeJobExposures(
  extras: ShoulderJobExtras,
  periodYears: number,
  workDaysPerYear: number,
): JobExposure[] {
  const wdpy = workDaysPerYear || 250;
  const years = periodYears || 0;

  const heavyLoadCount = parseFloat(String(extras.heavyLoadCount)) || 0;
  const heavyLoadSeconds = parseFloat(String(extras.heavyLoadSeconds)) || 0;
  const heavyLoadHoursPerDay = (heavyLoadCount * heavyLoadSeconds) / 3600;

  const fields: Array<{ key: string; value: number }> = [
    { key: 'overhead', value: parseFloat(String(extras.overheadHours)) || 0 },
    { key: 'repetitiveMedium', value: parseFloat(String(extras.repetitiveMediumHours)) || 0 },
    { key: 'repetitiveFast', value: parseFloat(String(extras.repetitiveFastHours)) || 0 },
    { key: 'heavyLoad', value: heavyLoadHoursPerDay },
    { key: 'vibration', value: parseFloat(String(extras.vibrationHours)) || 0 },
  ];

  return fields.map(({ key, value }) => {
    const def = EXPOSURE_LIMITS[key];
    const cumulativeHours = value * wdpy * years;
    return { key, label: def.label, dailyHours: value, cumulativeHours, limit: def.limit, unit: def.unit };
  });
}

// shared.jobs + shoulder.jobExtras 합성. knee의 mergeJobsWithExtras와 동형 패턴.
export function mergeJobsWithExtras(
  sharedJobs: JobLike[] | undefined,
  shoulderExtras: ShoulderJobExtras[] | undefined,
): Array<JobLike & ShoulderJobExtras> {
  return (sharedJobs || []).map((sj) => {
    const extra = (shoulderExtras || []).find((e) => e.sharedJobId === (sj as { id?: string }).id) || {};
    return {
      ...sj,
      overheadHours: extra.overheadHours || '',
      repetitiveMediumHours: extra.repetitiveMediumHours || '',
      repetitiveFastHours: extra.repetitiveFastHours || '',
      heavyLoadCount: extra.heavyLoadCount || '',
      heavyLoadSeconds: extra.heavyLoadSeconds || '',
      vibrationHours: extra.vibrationHours || '',
      evidenceSources: extra.evidenceSources || [],
    };
  });
}

export interface ShoulderDiagnosis extends DiagnosisLike {
  side?: string;
  confirmedRight?: string;
  confirmedLeft?: string;
  assessmentRight?: string;
  assessmentLeft?: string;
  reasonRight?: unknown[];
  reasonLeft?: unknown[];
}

/**
 * 종합소견 완료 여부 판정 — 원본과 동일 로직.
 * PR0-B2 §1-2: 파라미터 타입을 CompletionContext로 통일(strictFunctionTypes 대응). `module`은
 * 이 판정에서 쓰지 않으므로 무시한다(knee와 동일).
 */
export function isShoulderAssessmentComplete(patientData: CompletionContext): boolean {
  const diagnoses = (patientData.shared.diagnoses as ShoulderDiagnosis[] | undefined) ?? [];
  if (!diagnoses.length) return false;
  const shoulderDiags = diagnoses.filter(
    (dx) => resolveDiagnosisModule(dx, patientData.activeModules)?.moduleId === 'shoulder',
  );
  if (!shoulderDiags.length) return false;
  return shoulderDiags.every((dx) => {
    if (!dx.side) return false;
    const needRight = dx.side === 'right' || dx.side === 'both';
    const needLeft = dx.side === 'left' || dx.side === 'both';
    if (needRight) {
      if (!dx.confirmedRight || !dx.assessmentRight) return false;
      if (dx.assessmentRight === 'low' && !dx.reasonRight?.length) return false;
    }
    if (needLeft) {
      if (!dx.confirmedLeft || !dx.assessmentLeft) return false;
      if (dx.assessmentLeft === 'low' && !dx.reasonLeft?.length) return false;
    }
    return true;
  });
}

export interface ShoulderExposureTotal {
  key: string;
  label: string;
  totalHours: number;
  limit: number;
  unit: string;
  ratio: number;
  exceeded: boolean;
}

export interface ShoulderCalcResult {
  age: number;
  bmi: string | number;
  jobBurdens: Array<JobLike & ShoulderJobExtras & { periodYears: number; workDaysPerYear: number; exposures: JobExposure[] }>;
  totals: ShoulderExposureTotal[];
  anyExceeded: boolean;
  anyRepetitiveExceeded: boolean;
}

// 전체 계산 — 원본과 동일 로직.
export function computeShoulderCalc(patientData: {
  shared?: Record<string, unknown> & { jobs?: JobLike[]; birthDate?: unknown; injuryDate?: unknown; height?: unknown; weight?: unknown };
  module?: Record<string, unknown> & { jobExtras?: ShoulderJobExtras[] };
}): ShoulderCalcResult {
  const shared = patientData.shared || {};
  const mod = patientData.module || {};
  const age = calculateAge(shared.birthDate as string, shared.injuryDate as string);
  const bmi = calculateBMI(shared.height as string | number, shared.weight as string | number);

  const jobs = mergeJobsWithExtras(shared.jobs, mod.jobExtras);

  const jobBurdens = jobs.map((j) => {
    const periodYears = getEffectiveWorkPeriod(j);
    const workDaysPerYear = Number((j as { workDaysPerYear?: unknown }).workDaysPerYear) || 250;
    const exposures = computeJobExposures(j, periodYears, workDaysPerYear);
    return { ...j, periodYears, workDaysPerYear, exposures };
  });

  const keys = Object.keys(EXPOSURE_LIMITS);
  const totals: ShoulderExposureTotal[] = keys.map((key) => {
    const def = EXPOSURE_LIMITS[key];
    const totalHours = jobBurdens.reduce((sum, jb) => {
      const exp = jb.exposures.find((e) => e.key === key);
      return sum + (exp?.cumulativeHours || 0);
    }, 0);
    const { ratio, exceeded } = checkExposureLimit(totalHours, def.limit);
    return { key, label: def.label, totalHours, limit: def.limit, unit: def.unit, ratio, exceeded };
  });

  const repMedium = totals.find((t) => t.key === 'repetitiveMedium');
  const repFast = totals.find((t) => t.key === 'repetitiveFast');
  const anyRepetitiveExceeded = !!(repMedium?.exceeded || repFast?.exceeded);

  const anyExceeded = totals.some((t) => t.exceeded);

  return { age, bmi, jobBurdens, totals, anyExceeded, anyRepetitiveExceeded };
}
