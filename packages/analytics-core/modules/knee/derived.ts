// src/modules/knee/utils/calculations.js에서 계산 함수만 이동(로직 무변경). UI 라벨 매핑 함수
// (getSideText/getStatusText/getKlgText/getReasonText)는 이동하지 않음 — 옛 파일에 잔류.

import { calculateAge, calculateBMI } from '../../common';
import { getEffectiveWorkPeriod, getEffectiveWorkPeriodText, type JobLike } from '../../workPeriod';
import { resolveDiagnosisModule, type DiagnosisLike } from '../../diagnosisMapping';

export interface KneeJobExtras {
  sharedJobId?: string;
  weight?: string | number;
  squatting?: string | number;
  evidenceSources?: unknown[];
  stairs?: boolean;
  kneeTwist?: boolean;
  startStop?: boolean;
  tightSpace?: boolean;
  kneeContact?: boolean;
  jumpDown?: boolean;
  [key: string]: unknown;
}

export interface KneeCalculationJob extends JobLike {
  id?: string;
  // extractor의 isBlank()가 null/undefined/빈 문자열을 모두 blank로 취급하므로(§4.2),
  // 레거시 데이터가 실제로 null을 담아 올 수 있는 이 두 필드는 타입도 그 가능성을 반영한다.
  weight?: string | number | null;
  squatting?: string | number | null;
  [key: string]: unknown;
}

export interface KneeModuleShape {
  jobs?: KneeCalculationJob[]; // 구형식(legacy)
  jobExtras?: KneeJobExtras[];
  [key: string]: unknown;
}

export interface SharedShape {
  jobs?: KneeCalculationJob[];
  birthDate?: string;
  injuryDate?: string;
  height?: string | number;
  weight?: string | number;
  diagnoses?: DiagnosisLike[];
  [key: string]: unknown;
}

export interface PhysicalBurden {
  level: string;
  minScore: number;
  maxScore: number;
}

/** 신체부담정도 계산 — 원본과 동일 로직. */
export function calculatePhysicalBurden(w: unknown, t: unknown): PhysicalBurden {
  const W = parseFloat(String(w)) || 0;
  const T = parseFloat(String(t)) || 0;

  if ((W >= 3000 && T >= 120) || (W >= 2000 && T >= 180)) {
    return { level: '고도', minScore: 6.0, maxScore: 9.0 };
  }
  if ((W >= 3000 && T >= 60) || T >= 120) {
    return { level: '중등도상', minScore: 3.0, maxScore: 6.0 };
  }
  if ((W >= 2000 && T < 120) || (W < 2000 && T >= 60)) {
    return { level: '중등도하', minScore: 2.0, maxScore: 4.0 };
  }
  return { level: '경도', minScore: 1.0, maxScore: 2.0 };
}

export interface Relatedness {
  min: number | string;
  max: number | string;
}

/** 업무관련성 계산 — 원본과 동일 로직(30세 이하는 명시적 조기 반환). */
export function calculateWorkRelatedness(jobs: KneeCalculationJob[] | undefined, age: number): Relatedness {
  if (!jobs?.length || age <= 30) return { min: 0, max: 0 };
  let sumMin = 0;
  let sumMax = 0;
  jobs.forEach((j) => {
    const b = calculatePhysicalBurden(j.weight, j.squatting);
    const p = getEffectiveWorkPeriod(j);
    sumMin += (b.minScore - 1) * p;
    sumMax += (b.maxScore - 1) * p;
  });
  const af = age - 30;
  return {
    min: Math.max(0, (sumMin / (af + sumMin)) * 100).toFixed(1),
    max: Math.max(0, (sumMax / (af + sumMax)) * 100).toFixed(1),
  };
}

export function evaluateCumulativeBurden(min: unknown, max: unknown): string {
  return (parseFloat(String(min)) + parseFloat(String(max))) / 2 >= 50 ? '충분함' : '불충분함';
}

/** shared.jobs + knee.jobExtras를 합성하여 계산용 job 배열 생성. */
export function mergeJobsWithExtras(
  sharedJobs: KneeCalculationJob[] | undefined,
  kneeExtras: KneeJobExtras[] | undefined,
): KneeCalculationJob[] {
  return (sharedJobs || []).map((sj) => {
    const extra = (kneeExtras || []).find((e) => e.sharedJobId === sj.id) || ({} as KneeJobExtras);
    return {
      ...sj,
      weight: extra.weight || '',
      squatting: extra.squatting || '',
      evidenceSources: extra.evidenceSources || [],
      stairs: extra.stairs || false,
      kneeTwist: extra.kneeTwist || false,
      startStop: extra.startStop || false,
      tightSpace: extra.tightSpace || false,
      kneeContact: extra.kneeContact || false,
      jumpDown: extra.jumpDown || false,
    };
  });
}

/**
 * `computeKneeCalc`가 실제로 계산에 쓰는 job 배열을 결정한다 — 구형식(`module.jobs`)이면
 * 그대로, 아니면 `shared.jobs`+`module.jobExtras`를 병합한 결과. `computeKneeCalc`와
 * extractor(§4.2)가 이 함수 하나를 공유해야, `shared.jobs: []` + 레거시 `modules.knee.jobs`가
 * 함께 있는 케이스에서 서로 다른 배열을 보는 사고가 나지 않는다.
 */
export function resolveKneeCalculationJobs(
  shared: SharedShape,
  moduleData: KneeModuleShape,
): KneeCalculationJob[] {
  return moduleData.jobs ? moduleData.jobs : mergeJobsWithExtras(shared.jobs, moduleData.jobExtras);
}

export interface KneeDiagnosis extends DiagnosisLike {
  side?: string;
  confirmedRight?: string;
  confirmedLeft?: string;
  assessmentRight?: string;
  assessmentLeft?: string;
  reasonRight?: unknown[];
  reasonLeft?: unknown[];
}

/** 종합소견 완료 여부 판정(무릎 상병만 체크) — 원본과 동일 로직. */
export function isKneeAssessmentComplete(patientData: {
  shared?: { diagnoses?: KneeDiagnosis[] };
  activeModules?: string[];
}): boolean {
  const diagnoses = patientData.shared?.diagnoses || [];
  if (!diagnoses.length) return false;
  const kneeDiags = diagnoses.filter(
    (dx) => resolveDiagnosisModule(dx, patientData.activeModules || [])?.moduleId === 'knee',
  );
  if (!kneeDiags.length) return false;
  return kneeDiags.every((dx) => {
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

export interface KneeJobBurden extends KneeCalculationJob {
  burden: PhysicalBurden;
  period: string;
}

export interface KneeCalcResult {
  age: number;
  bmi: string | number;
  relatedness: Relatedness;
  cumulativeBurden: string;
  jobBurdens: KneeJobBurden[];
}

/** 환자 데이터로부터 전체 계산 결과 산출 — 원본과 동일 로직(입력 shape 그대로). */
export function computeKneeCalc(patientData: { shared?: SharedShape; module?: KneeModuleShape }): KneeCalcResult {
  const shared = patientData.shared || {};
  const mod = patientData.module || {};
  const age = calculateAge(shared.birthDate, shared.injuryDate);
  const bmi = calculateBMI(shared.height, shared.weight);

  const jobs = resolveKneeCalculationJobs(shared, mod);

  const relatedness = calculateWorkRelatedness(jobs, age);
  const cumulativeBurden = evaluateCumulativeBurden(relatedness.min, relatedness.max);
  const jobBurdens: KneeJobBurden[] = jobs.map((j) => ({
    ...j,
    burden: calculatePhysicalBurden(j.weight, j.squatting),
    period: getEffectiveWorkPeriodText(j),
  }));
  return { age, bmi, relatedness, cumulativeBurden, jobBurdens };
}
