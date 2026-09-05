// src/modules/cervical/utils/calculations.js에서 계산 함수를 이동(로직 무변경). narrative
// 생성(generateJobNarrative 등)도 계산 결과의 일부라 함께 이관한다(elbow/wrist와 동일 범위).
// UI 라벨 매핑 함수는 cervical calculations.js에 원래 없다(getSideText 등은 knee 것을 재사용
// 하는 구조 — src/core/utils/emrReport.js:6 참고) — 이관 대상 아님.

import { calculateAge, calculateBMI } from '../../common';
import { getEffectiveWorkPeriod, type JobLike } from '../../workPeriod';
import type { CompletionContext } from '../../analyticsRegistry';
import {
  normalizeCervicalModuleData,
  isCervicalDiagnosis,
  type CervicalDiagnosis,
  type CervicalJobLike,
  type CervicalModuleShape,
  type CervicalTask,
} from './legacyNormalize';

export type { CervicalDiagnosis, CervicalJobLike, CervicalModuleShape, CervicalTask } from './legacyNormalize';
export { isCervicalDiagnosis, normalizeCervicalModuleData, EXPOSURE_TYPE_OPTIONS, EXPOSURE_TYPE_LABELS } from './legacyNormalize';

const YES_NO_LABELS: Record<string, string> = { yes: '예', no: '아니오' };

const FIELD_LABELS: Record<string, string> = {
  name: '작업명',
  exposure_types: '노출 유형',
  load_weight_kg: '하중',
  carry_hours_per_shift: '한 작업 교대(shift)당 노출 시간',
  forced_neck_posture: '운반 시 목의 부자연스러운 자세(굴곡, 신전, 꺾임 20도 초과)가 강제됨',
  neck_nonneutral_hours_per_day: '굴곡/신전/회전/측굴을 모두 포함한 비중립 정적 자세 수행 시간',
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

const BK2109_REFERENCE_KG_HOURS = 44000;
const RISK_FACTOR_FLAGS = new Set([
  'heavy_load_present',
  'carry_time_supported',
  'forced_neck_posture_present',
  'cumulative_load_supported',
]);

export interface FlagMeta {
  label: string;
  description: string;
  tone: string;
}

export const FLAG_META: Record<string, FlagMeta> = {
  heavy_load_present: {
    label: '무거운 하중 기준 충족',
    description: '어깨에 올려 운반하는 하중이 40kg 이상인 작업이 있습니다.',
    tone: 'warning',
  },
  carry_time_supported: {
    label: '운반시간 기준 충족',
    description: '한 작업 교대당 운반 시간이 0.5시간 이상인 작업이 있습니다.',
    tone: 'warning',
  },
  forced_neck_posture_present: {
    label: '운반 시 부자연스러운 목 자세 강제',
    description: '하중 운반 중 목의 부자연스러운 자세가 강제되는 작업이 있습니다.',
    tone: 'warning',
  },
  cumulative_load_supported: {
    label: '누적 총부하 기준 충족',
    description: '작업별 누적 총부하량 합계가 44,000 kg·h 이상입니다.',
    tone: 'warning',
  },
  bk2109_pattern_supported: {
    label: 'BK2109형 패턴 지지',
    description: '동일 직업 내 작업 합산 기준으로 독일 BK2109 정량 패턴이 지지됩니다.',
    tone: 'positive',
  },
  daily_share_high: {
    label: '일일 노출량 높음',
    description: '작업별 운반시간과 비중립 정적 자세 시간을 합산한 대표 노출 시간이 하루 3.5시간 이상입니다.',
    tone: 'positive',
  },
  daily_share_moderate: {
    label: '일일 노출량 중간',
    description: '작업별 운반시간과 비중립 정적 자세 시간을 합산한 대표 노출 시간이 하루 2.5시간 이상 3.5시간 미만입니다.',
    tone: 'info',
  },
  awkward_static_neck_supported: {
    label: '비중립·정적 목 부하',
    description: '비중립 정적 목 자세 노출이 작업 합산 기준으로 의미 있게 확인됩니다.',
    tone: 'positive',
  },
  mechanical_cervical_load_dominant: {
    label: '기계적 경추 부담 우세',
    description: '기계적 경추 부담 노출이 우세하게 확인됩니다.',
    tone: 'positive',
  },
};

function toNumber(value: unknown): number {
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== '' && value !== null && value !== undefined;
}

function labelValue(value: unknown, map: Record<string, string>): string {
  if (!value) return '-';
  const key = String(value);
  return map[key] || key;
}

function formatPositiveFlags(flags: Record<string, boolean> = {}): string[] {
  return FLAG_ORDER.filter((flagName) => flags[flagName]);
}

export interface FlagItem extends FlagMeta {
  key: string;
}

function buildFlagItems(flags: Record<string, boolean> = {}): FlagItem[] {
  return formatPositiveFlags(flags).map((key) => ({
    key,
    ...(FLAG_META[key] || { label: key, description: key, tone: 'neutral' }),
  }));
}

function buildRiskFactorItems(flags: Record<string, boolean> = {}): FlagItem[] {
  return formatPositiveFlags(flags)
    .filter((key) => RISK_FACTOR_FLAGS.has(key))
    .map((key) => ({
      key,
      ...(FLAG_META[key] || { label: key, description: key, tone: 'neutral' }),
    }));
}

function getTaskRequiredFields(task: CervicalTask = {}): string[] {
  const required = ['name', 'exposure_types'];
  const exposureTypes = task.exposure_types || [];

  if (exposureTypes.includes('shoulder_heavy_load')) {
    required.push('load_weight_kg', 'carry_hours_per_shift', 'forced_neck_posture');
  }

  if (exposureTypes.includes('awkward_static_neck_load')) {
    required.push('neck_nonneutral_hours_per_day', 'combined_flexion_rotation_posture', 'precision_work');
  }

  return required;
}

function getTaskMissingFields(task: CervicalTask = {}): string[] {
  return getTaskRequiredFields(task)
    .filter((field) => !hasValue(task[field]))
    .map((field) => FIELD_LABELS[field] || field);
}

function getTaskCumulativeKgHours(task: CervicalTask = {}, job: CervicalJobLike = {}): number {
  const loadWeightKg = toNumber(task.load_weight_kg);
  const carryHoursPerShift = toNumber(task.carry_hours_per_shift);
  const workDaysPerYear = Number(job.workDaysPerYear) || 0;
  const yearsExposed = getEffectiveWorkPeriod(job as JobLike);

  return loadWeightKg * carryHoursPerShift * workDaysPerYear * yearsExposed;
}

function getTaskRepresentativeHours(task: CervicalTask = {}): number {
  return toNumber(task.carry_hours_per_shift) + toNumber(task.neck_nonneutral_hours_per_day);
}

function formatNumber(value: unknown, digits = 0): string {
  return Number(value || 0).toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatHours(value: unknown): string {
  if (!hasValue(value)) return '-';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  if (Number.isInteger(numeric)) return `${numeric}시간`;
  return `${numeric.toLocaleString('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}시간`;
}

export interface TaskSignals {
  heavy_load_present: boolean;
  carry_time_supported: boolean;
  forced_neck_posture_present: boolean;
  bk2109CoreTask: boolean;
  awkward_supportive_task: boolean;
  cumulativeKgHours: number;
  awkwardHours: number;
  representativeHours: number;
}

function computeTaskSignals(task: CervicalTask = {}, job: CervicalJobLike = {}): TaskSignals {
  const exposureTypes = task.exposure_types || [];
  const awkwardHours = toNumber(task.neck_nonneutral_hours_per_day);
  const representativeHours = getTaskRepresentativeHours(task);

  const heavy_load_present = exposureTypes.includes('shoulder_heavy_load') && toNumber(task.load_weight_kg) >= 40;
  const carry_time_supported = exposureTypes.includes('shoulder_heavy_load') && toNumber(task.carry_hours_per_shift) >= 0.5;
  const forced_neck_posture_present = exposureTypes.includes('shoulder_heavy_load') && task.forced_neck_posture === 'yes';
  const bk2109CoreTask = heavy_load_present && carry_time_supported && forced_neck_posture_present;
  const cumulativeKgHours = bk2109CoreTask ? getTaskCumulativeKgHours(task, job) : 0;
  const awkward_supportive_task =
    exposureTypes.includes('awkward_static_neck_load') &&
    awkwardHours >= 1.5 &&
    (task.combined_flexion_rotation_posture === 'yes' || task.precision_work === 'yes');

  return {
    heavy_load_present,
    carry_time_supported,
    forced_neck_posture_present,
    bk2109CoreTask,
    awkward_supportive_task,
    cumulativeKgHours,
    awkwardHours,
    representativeHours,
  };
}

export interface TaskSummary extends CervicalTask {
  displayName: string;
  missingFields: string[];
  cumulativeKgHours: number;
  awkwardHours: number;
  representativeHours: number;
  signals: TaskSignals;
}

function buildTaskSummary(task: CervicalTask = {}, job: CervicalJobLike = {}, index = 0): TaskSummary {
  const signals = computeTaskSignals(task, job);
  const missingFields = getTaskMissingFields(task);

  return {
    ...task,
    displayName: task.name || `작업 ${index + 1}`,
    missingFields,
    cumulativeKgHours: signals.cumulativeKgHours,
    awkwardHours: signals.awkwardHours,
    representativeHours: signals.representativeHours,
    signals,
  };
}

export function getCervicalBurdenGrade(flags: Record<string, boolean> = {}): string {
  if (flags.bk2109_pattern_supported) return 'high_bk2109';
  if (flags.awkward_static_neck_supported || flags.daily_share_high || flags.daily_share_moderate) {
    return 'present';
  }
  return 'low';
}

export function getCervicalConclusionText(burdenGrade: string): string {
  if (burdenGrade === 'high_bk2109') {
    return '어깨에 무거운 하중 운반 작업의 정량 조건과 작업 합산 누적 총부하 기준이 확인되어 독일 BK2109(어깨에 무거운 하중 올려 운반)형 경추 부담 노출이 강하게 지지됩니다.';
  }
  if (burdenGrade === 'present') {
    return '장시간 비중립·정적 목 부하 작업이 확인되어 경추 부담 노출은 있으나, 독일 BK2109(어깨에 무거운 하중 올려 운반) 정량 요건 지지는 제한적입니다.';
  }
  return '현재 입력된 작업 기반 노출정보만으로는 경추 부담 노출을 뚜렷하게 지지하기 어렵습니다.';
}

function generateJobNarrative({
  taskSummaries,
  aggregate,
}: {
  taskSummaries: TaskSummary[];
  aggregate: { cumulativeKgHours: number; representativeHours: number; totalAwkwardHours: number };
}): string {
  if (taskSummaries.length === 0) return '경추부담 작업 없음';

  const referenceRatio = aggregate.cumulativeKgHours > 0 ? (aggregate.cumulativeKgHours / BK2109_REFERENCE_KG_HOURS) * 100 : 0;
  const lines: string[] = [];

  taskSummaries.forEach((taskSummary, index) => {
    const exposureTypes = taskSummary.exposure_types || [];
    const typeLabels: string[] = [];
    if (exposureTypes.includes('shoulder_heavy_load')) typeLabels.push('어깨에 무거운 하중 올려서 운반');
    if (exposureTypes.includes('awkward_static_neck_load')) typeLabels.push('비중립·정적 목 부하');
    const typeSuffix = typeLabels.length > 0 ? ` (${typeLabels.join(' / ')})` : '';
    lines.push(`작업 ${index + 1}: ${taskSummary.displayName}${typeSuffix}`);

    if (exposureTypes.includes('shoulder_heavy_load')) {
      lines.push(` - 하중 : ${hasValue(taskSummary.load_weight_kg) ? `${formatNumber(taskSummary.load_weight_kg)}kg` : '-'}`);
      lines.push(` - 한 작업 교대(shift)당 노출 시간 : ${formatHours(taskSummary.carry_hours_per_shift)}`);
      lines.push(` - 운반 시 목의 부자연스러운 자세가 강제 : ${labelValue(taskSummary.forced_neck_posture, YES_NO_LABELS)}`);
      lines.push(
        taskSummary.signals.bk2109CoreTask
          ? ` - 작업별 누적 총부하량 : ${formatNumber(taskSummary.cumulativeKgHours)} kg·h`
          : ' - 작업별 누적 총부하량 : BK2109 핵심 3요건 미충족으로 미산정',
      );
    }

    if (exposureTypes.includes('awkward_static_neck_load')) {
      lines.push(` - 수행 시간 : ${formatHours(taskSummary.neck_nonneutral_hours_per_day)}`);
      lines.push(` - 굴곡/신전과 회전/측굴이 동시에 발생 : ${labelValue(taskSummary.combined_flexion_rotation_posture, YES_NO_LABELS)}`);
      lines.push(` - 고도의 정밀(precision) 작업 : ${labelValue(taskSummary.precision_work, YES_NO_LABELS)}`);
    }

    if (taskSummary.notes) {
      lines.push(`메모: ${taskSummary.notes}`);
    }
  });

  lines.push('직업 합산');
  lines.push(
    ` - BK2109 누적 총부하량 합계 : ${formatNumber(aggregate.cumulativeKgHours)} kg·h (참고치 ${formatNumber(BK2109_REFERENCE_KG_HOURS)} kg·h, 참고치 대비 ${formatNumber(referenceRatio, 1)}%)`,
  );
  lines.push(` - 일일 대표 노출시간 합계 : ${formatHours(aggregate.representativeHours)}`);
  lines.push(` - 비중립 정적 자세 시간 합계 : ${formatHours(aggregate.totalAwkwardHours)}`);

  return lines.join('\n');
}

export interface JobSummary {
  sharedJobId: string;
  jobName: string;
  diagnoses: CervicalDiagnosis[];
  diagnosisText: string;
  taskSummaries: TaskSummary[];
  totalTaskCount: number;
  completedTaskCount: number;
  missingFields: string[];
  flags: Record<string, boolean | number>;
  flagItems: FlagItem[];
  riskFactorItems: FlagItem[];
  riskFactorCount: number;
  burdenGrade: string;
  narrative: string;
  conclusionText: string;
  cumulativeKgHours: number;
  representativeHours: number;
  totalAwkwardHours: number;
  workDaysPerYear: number;
  yearsExposed: number;
  hasBk2109CoreTask: boolean;
}

function buildJobSummary({
  job,
  diagnoses,
  tasks,
}: {
  job: CervicalJobLike;
  diagnoses: CervicalDiagnosis[];
  tasks: CervicalTask[];
}): JobSummary {
  const taskSummaries = (tasks || []).map((task, index) => buildTaskSummary(task, job, index));
  const cumulativeKgHours = taskSummaries.reduce((sum, task) => sum + task.cumulativeKgHours, 0);
  const representativeHours = taskSummaries.reduce((sum, task) => sum + task.representativeHours, 0);
  const totalAwkwardHours = taskSummaries.reduce((sum, task) => sum + task.awkwardHours, 0);

  const flags: Record<string, boolean> = {};
  if (taskSummaries.some((task) => task.signals.heavy_load_present)) flags.heavy_load_present = true;
  if (taskSummaries.some((task) => task.signals.carry_time_supported)) flags.carry_time_supported = true;
  if (taskSummaries.some((task) => task.signals.forced_neck_posture_present)) flags.forced_neck_posture_present = true;
  if (cumulativeKgHours >= BK2109_REFERENCE_KG_HOURS) flags.cumulative_load_supported = true;

  const hasBk2109CoreTask = taskSummaries.some(
    (task) => task.signals.heavy_load_present && task.signals.carry_time_supported && task.signals.forced_neck_posture_present,
  );
  if (hasBk2109CoreTask && flags.cumulative_load_supported) {
    flags.bk2109_pattern_supported = true;
  }

  if (representativeHours >= 3.5) {
    flags.daily_share_high = true;
  } else if (representativeHours >= 2.5) {
    flags.daily_share_moderate = true;
  }

  const hasAwkwardSupportiveTask = taskSummaries.some((task) => task.signals.awkward_supportive_task);
  if (totalAwkwardHours >= 2 || hasAwkwardSupportiveTask) {
    flags.awkward_static_neck_supported = true;
  }

  if (flags.awkward_static_neck_supported || flags.daily_share_high || flags.bk2109_pattern_supported) {
    flags.mechanical_cervical_load_dominant = true;
  }

  const burdenGrade = getCervicalBurdenGrade(flags);
  const riskFactorItems = buildRiskFactorItems(flags);
  const completedTaskCount = taskSummaries.filter((task) => task.missingFields.length === 0).length;
  // 작업이 하나도 없는 것은 "경추 부담 작업 없음"이라는 유효한 상태이지, 입력 누락이 아니다 —
  // 실제로 작업이 있는데 필드가 비어있는 경우에만 입력 누락으로 표시한다.
  const missingFields = taskSummaries
    .filter((task) => task.missingFields.length > 0)
    .map((task) => `${task.displayName}: ${task.missingFields.join(', ')}`);

  const aggregate = { cumulativeKgHours, representativeHours, totalAwkwardHours };

  return {
    sharedJobId: job?.id || '',
    jobName: job?.jobName || '',
    diagnoses: diagnoses || [],
    diagnosisText: (diagnoses || []).map((diag) => `${diag.code || ''} ${diag.name || ''}`.trim()).filter(Boolean).join(', '),
    taskSummaries,
    totalTaskCount: taskSummaries.length,
    completedTaskCount,
    missingFields,
    flags: { ...flags, cumulativeKgHours, representativeHours, totalAwkwardHours },
    flagItems: buildFlagItems(flags),
    riskFactorItems,
    riskFactorCount: riskFactorItems.length,
    burdenGrade,
    narrative: generateJobNarrative({ taskSummaries, aggregate }),
    conclusionText: getCervicalConclusionText(burdenGrade),
    cumulativeKgHours,
    representativeHours,
    totalAwkwardHours,
    workDaysPerYear: Number(job?.workDaysPerYear) || 0,
    yearsExposed: getEffectiveWorkPeriod(job as JobLike),
    hasBk2109CoreTask,
  };
}

export interface CervicalCalcResult {
  age: number;
  bmi: string | number;
  jobSummaries: JobSummary[];
  anyFlagged: boolean;
  overallBurdenGrade: string;
  overallConclusionText: string;
  overallCumulativeKgHours: number;
}

// 전체 계산 — 원본과 동일 로직. `patientData.module`은 원본 syncCervicalModuleData 대신
// normalizeCervicalModuleData(legacyNormalize.ts, 이 패키지 전용 독립 구현)로 정규화한다.
export function computeCervicalCalc(patientData: {
  shared?: Record<string, unknown> & { jobs?: CervicalJobLike[]; diagnoses?: CervicalDiagnosis[]; birthDate?: unknown; injuryDate?: unknown; height?: unknown; weight?: unknown };
  module?: CervicalModuleShape;
  activeModules?: string[];
}): CervicalCalcResult {
  const shared = patientData.shared || {};
  const jobs = shared.jobs || [];
  const synced = normalizeCervicalModuleData(patientData.module || {}, jobs);
  const activeModules = patientData.activeModules || [];
  const cervicalDiagnoses = (shared.diagnoses || []).filter((diag) => isCervicalDiagnosis(diag, activeModules));
  const age = calculateAge(shared.birthDate as string, shared.injuryDate as string);
  const bmi = calculateBMI(shared.height as string | number, shared.weight as string | number);

  const jobSummaries = jobs.map((job) =>
    buildJobSummary({
      job,
      diagnoses: cervicalDiagnoses,
      tasks: (synced.moduleData.tasks || []).filter((task) => task.sharedJobId === job.id),
    }),
  );

  // 전체 직업 합산 종합평가 (직업 2개 이상인 경우만 의미 있음)
  const totalYears = jobSummaries.reduce((sum, js) => sum + (js.yearsExposed || 0), 0);
  const overallCumulativeKgHours = jobSummaries.reduce((sum, js) => sum + (js.cumulativeKgHours || 0), 0);
  const overallRepresentativeHours =
    totalYears > 0
      ? jobSummaries.reduce((sum, js) => sum + (js.representativeHours || 0) * (js.yearsExposed || 0), 0) / totalYears
      : Math.max(...jobSummaries.map((js) => js.representativeHours || 0), 0);
  const overallAwkwardHours =
    totalYears > 0
      ? jobSummaries.reduce((sum, js) => sum + (js.totalAwkwardHours || 0) * (js.yearsExposed || 0), 0) / totalYears
      : Math.max(...jobSummaries.map((js) => js.totalAwkwardHours || 0), 0);

  const overallFlags: Record<string, boolean> = {};
  overallFlags.heavy_load_present = jobSummaries.some((js) => js.flags?.heavy_load_present === true);
  overallFlags.carry_time_supported = jobSummaries.some((js) => js.flags?.carry_time_supported === true);
  overallFlags.forced_neck_posture_present = jobSummaries.some((js) => js.flags?.forced_neck_posture_present === true);
  overallFlags.cumulative_load_supported = overallCumulativeKgHours >= BK2109_REFERENCE_KG_HOURS;
  const hasCoreJob = jobSummaries.some((js) => js.hasBk2109CoreTask);
  overallFlags.bk2109_pattern_supported = overallFlags.cumulative_load_supported && hasCoreJob;
  overallFlags.daily_share_high = overallRepresentativeHours >= 3.5;
  overallFlags.daily_share_moderate = !overallFlags.daily_share_high && overallRepresentativeHours >= 2.5;
  overallFlags.awkward_static_neck_supported =
    overallAwkwardHours >= 2 || jobSummaries.some((js) => js.flags?.awkward_static_neck_supported === true);

  const overallBurdenGrade = getCervicalBurdenGrade(overallFlags);
  const overallConclusionText = getCervicalConclusionText(overallBurdenGrade);

  return {
    age,
    bmi,
    jobSummaries,
    anyFlagged: jobSummaries.some((summary) => summary.flagItems.length > 0),
    overallBurdenGrade,
    overallConclusionText,
    overallCumulativeKgHours,
  };
}

function isDiagnosisAssessmentComplete(diag: CervicalDiagnosis): boolean {
  // 원본 그대로 이관 — side 분기 없이 Right 필드만 검사하는 비대칭 판정(수정 범위 아님,
  // 계획서 §1-3 "isCervicalAssessmentComplete의 Right 필드만 보는 비대칭 판정" 참고).
  if (!diag.confirmedRight || !diag.assessmentRight) return false;
  if (diag.assessmentRight === 'low' && !(diag.reasonRight || []).length) return false;
  return true;
}

/** 종합소견 완료 여부 판정 — 원본과 동일 로직. CompletionContext로 파라미터 타입 통일. */
export function isCervicalAssessmentComplete(ctx: CompletionContext): boolean {
  const shared = ctx.shared as { jobs?: CervicalJobLike[]; diagnoses?: CervicalDiagnosis[] };
  const jobs = shared.jobs || [];
  const activeModules = ctx.activeModules || [];
  const cervicalDiagnoses = (shared.diagnoses || []).filter((diag) => isCervicalDiagnosis(diag, activeModules));
  const calc = computeCervicalCalc({ shared, module: ctx.module as CervicalModuleShape, activeModules });

  if (cervicalDiagnoses.length === 0) return false;
  if (jobs.length === 0) return false;

  const diagnosisComplete = cervicalDiagnoses.every((diag) => isDiagnosisAssessmentComplete(diag));
  if (!diagnosisComplete) return false;

  // 작업이 0건인 것은 "경추부담 작업 없음"이라는 유효한 상태이지 미완료가 아니다 —
  // buildJobSummary의 missingFields 판정과 동일한 기준(0건은 입력 누락에서 제외)을 따른다.
  const jobsWithTasks = calc.jobSummaries.filter((jobSummary) => jobSummary.totalTaskCount > 0);
  return jobsWithTasks.every((jobSummary) => jobSummary.missingFields.length === 0);
}
