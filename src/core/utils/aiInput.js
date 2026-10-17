import {
  AiAnalysisInputSchema,
  AI_MODULE_IDS,
  LOW_REASON_KEYS,
  KLG_VALUES,
  ELLMAN_VALUES,
  ELBOW_BK_TYPES,
  WRIST_BK_TYPES,
  ELBOW_FLAG_KEYS,
  WRIST_FLAG_KEYS,
  CERVICAL_FLAG_KEYS,
  KNEE_AUX_KEYS,
  SHOULDER_EXPOSURE_KEYS,
  SPINE_POSTURES,
  RECENT_TASK_CHANGE_VALUES,
  TEMPORAL_FLAG_KEYS,
  CERVICAL_EXPOSURE_TYPES,
  CERVICAL_BURDEN_GRADES,
} from '@contracts/aiAnalysis';
import { isJobExcludedFromAnalysis } from '@analytics-core/jobScope';
import { getModule } from '../moduleRegistry';
import { calculateBMI } from './common';
import { computeAgeAt } from './dashboardStats';
import { getEffectiveWorkPeriod } from './workPeriod';
import { buildAssessmentUnits } from './assessmentGroups';
import { resolveDiagnosisModule } from './diagnosisMapping';
import { classifySpineSeverity } from '../../modules/spine/utils/calculations';
import { thresholds } from '../../modules/spine/utils/thresholds';
import { SPINE_FORMULA_V513 } from '../../modules/spine/utils/formulaVersion';
import { groupSummariesByBkType as groupElbow, mergeBkGroupSummaries as mergeElbow, getElbowBurdenGrade } from '../../modules/elbow/utils/calculations';
import { groupSummariesByBkType as groupWrist, mergeBkGroupSummaries as mergeWrist, getWristBurdenGrade } from '../../modules/wrist/utils/calculations';

// ---------------------------------------------------------------------------
// 환자 → AI 비식별 구조화 입력(AiAnalysisInput). 외부 AI로 나가는 유일한 입력이다.
//
// 원칙
//  - 계산 결과 객체를 spread하지 않고 필요한 값만 필드별로 뽑는다. 계산 결과 안에는 직종명·상병명·작업명·메모·narrative가 들어 있다.
//  - 자유 입력 문자열은 키/열거형으로만 옮긴다. 표 밖의 값(일괄 import가 임의 문자열을 넣을 수 있다)은 null/제외.
//  - 상태·등급은 원본 계산 함수의 판정을 그대로 옮기고 다시 해석하지 않는다(라벨 의미는 계약의 aiPrompt가 정한다).
//  - 마지막에 AiAnalysisInputSchema로 자기 검증한다. 통과하지 못하면 null을 돌려주고 호출부는 분석을 막는다.
// ---------------------------------------------------------------------------

const NUMBER_LIMIT = 1e9;
const MAX_JOBS = 30;
const MAX_TASKS = 30;

const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && Math.abs(n) <= NUMBER_LIMIT ? n : null;
};
const finiteOr0 = (value) => finite(value) ?? 0;
const intOrNull = (value) => {
  const n = finite(value);
  return n === null ? null : Math.trunc(n);
};
const oneOf = (allowed, value) => (typeof value === 'string' && allowed.includes(value) ? value : null);
const listOf = (allowed, values) => {
  if (!Array.isArray(values)) return [];
  const picked = values.filter((v) => typeof v === 'string' && allowed.includes(v));
  return picked.filter((v, i) => picked.indexOf(v) === i);
};
const yesNo = (value) => oneOf(['yes', 'no'], value);

// 원본 계산 함수가 돌려주는 한글 등급 → 계약의 키. 같은 4단계(무릎 신체부담정도 · 척추 중증도)가 공유한다.
const BURDEN_LEVEL_KEYS = { 고도: 'high', 중등도상: 'upperModerate', 중등도하: 'lowerModerate', 경도: 'low' };
const BK_GRADE_KEYS = { '부담 작업 아님': 'none', 경도: 'mild', 중등도: 'moderate', 고도: 'high' };

const ICD_CODE = /^[A-Z]\d{2}(\.\d{1,2})?$/;
function normalizeIcdCode(raw) {
  const code = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const dotted = /^[A-Z]\d{3,4}$/.test(code) ? `${code.slice(0, 3)}.${code.slice(3)}` : code; // M171 → M17.1
  return ICD_CODE.test(dotted) ? dotted : null;
}

// ── 인구학 · 상병 · 직력 ───────────────────────────────────────────────────
function buildDemographics(shared) {
  const age = computeAgeAt(shared.birthDate, shared.injuryDate);
  const yesNoToBool = (v) => (v === '유' ? true : v === '무' ? false : null);
  return {
    ageYears: Number.isInteger(age) ? age : null,
    gender: oneOf(['male', 'female'], shared.gender),
    heightCm: finite(shared.height),
    weightKg: finite(shared.weight),
    bmi: finite(calculateBMI(shared.height, shared.weight)),
    hypertension: yesNoToBool(shared.highBloodPressure),
    diabetes: yesNoToBool(shared.diabetes),
  };
}

function buildDiagnoses(shared, activeModules) {
  const all = Array.isArray(shared.diagnoses) ? shared.diagnoses : [];
  const units = buildAssessmentUnits(all, activeModules);
  const refByDiagnosisId = new Map(); // 원본 진단 id → 출력 배열 위치(모듈의 diagnosisRefs가 가리킨다)
  const out = [];

  all.forEach((diag, diagIndex) => {
    if (!diag || (!diag.code && !diag.name) || out.length >= 20) return; // 보고서와 같이 코드·이름이 모두 빈 행은 뺀다
    refByDiagnosisId.set(diag.id, out.length);
    out.push({
      code: normalizeIcdCode(diag.code),
      moduleId: oneOf(AI_MODULE_IDS, resolveDiagnosisModule(diag, activeModules)?.moduleId),
      side: oneOf(['right', 'left', 'both'], diag.side),
      units: units
        .filter((unit) => unit.diagIndex === diagIndex)
        .map((unit) => ({
          side: unit.side,
          confirmed: oneOf(['confirmed', 'unconfirmed'], diag[unit.confirmedKey]),
          assessment: oneOf(['high', 'low'], diag[unit.assessmentKey]),
          reasons: listOf(LOW_REASON_KEYS, diag[unit.reasonKey]),
          klg: unit.side === 'right' ? oneOf(KLG_VALUES, diag.klgRight) : unit.side === 'left' ? oneOf(KLG_VALUES, diag.klgLeft) : null,
          ellman: unit.side === 'right' ? oneOf(ELLMAN_VALUES, diag.ellmanRight) : unit.side === 'left' ? oneOf(ELLMAN_VALUES, diag.ellmanLeft) : null,
        })),
      verticalDistribution: oneOf(['confirmed', 'unconfirmed'], diag.verticalDistribution),
      concomitantSpondylosis: oneOf(['confirmed', 'unconfirmed'], diag.concomitantSpondylosis),
    });
  });
  return { diagnoses: out, refByDiagnosisId };
}

function buildJobs(jobs) {
  return jobs.slice(0, MAX_JOBS).map((job) => {
    const workDays = intOrNull(job?.workDaysPerYear);
    return {
      durationYears: finite(getEffectiveWorkPeriod(job || {})),
      workDaysPerYear: workDays !== null && workDays >= 0 && workDays <= 366 ? workDays : null,
      excludedFromAnalysis: isJobExcludedFromAnalysis(job),
    };
  });
}

// ── 모듈별 ───────────────────────────────────────────────────────────────
function buildKnee(calc, jobIndexOf) {
  const min = finite(calc.relatedness?.min);
  const max = finite(calc.relatedness?.max);
  return {
    noEvaluableJobs: calc.noEvaluableJobs === true,
    relatedness: calc.relatedness
      ? { minPct: min, maxPct: max, avgPct: min !== null && max !== null ? Math.round(((min + max) / 2) * 10) / 10 : null }
      : null,
    cumulativeBurdenSufficient: calc.cumulativeBurden === '충분함',
    jobs: (calc.jobBurdens || []).slice(0, MAX_JOBS).map((job, i) => ({
      jobIndex: jobIndexOf(job.id, i),
      weightKgPerDay: finite(job.weight),
      squattingMinPerDay: finite(job.squatting),
      aux: Object.fromEntries(KNEE_AUX_KEYS.map((key) => [key, job[key] === true])),
      burdenLevel: BURDEN_LEVEL_KEYS[job.burden?.level] ?? null,
    })),
  };
}

// 보고서(reportGenerator.getShoulderInterpretation)와 같은 규칙: 초과 항목 → 복합 노출(50% 이상 3개 또는 75% 이상 2개) → 미달.
export function classifyShoulderInterpretation(totals) {
  if (totals.some((t) => t.exceeded)) return 'exceeded';
  const over75 = totals.filter((t) => t.ratio >= 0.75).length;
  const over50 = totals.filter((t) => t.ratio >= 0.5).length;
  return over50 >= 3 || over75 >= 2 ? 'combinedSufficient' : 'insufficient';
}

function buildShoulder(calc, jobIndexOf) {
  const totals = Array.isArray(calc.totals) ? calc.totals : [];
  const byKey = (list, key) => list.find((item) => item.key === key);
  const complete = SHOULDER_EXPOSURE_KEYS.every((key) => byKey(totals, key));
  return {
    noEvaluableJobs: calc.noEvaluableJobs === true,
    totals: complete
      ? Object.fromEntries(
          SHOULDER_EXPOSURE_KEYS.map((key) => {
            const t = byKey(totals, key);
            return [key, { hours: finiteOr0(t.totalHours), limitHours: finiteOr0(t.limit), ratio: finiteOr0(t.ratio), exceeded: t.exceeded === true }];
          }),
        )
      : null,
    interpretation: complete && calc.noEvaluableJobs !== true ? classifyShoulderInterpretation(totals) : null,
    jobs: (calc.jobBurdens || []).slice(0, MAX_JOBS).map((job, i) => ({
      jobIndex: jobIndexOf(job.id, i),
      periodYears: finite(job.periodYears),
      exposures: Object.fromEntries(
        SHOULDER_EXPOSURE_KEYS.map((key) => {
          const e = byKey(job.exposures || [], key);
          return [key, { dailyHours: finite(e?.dailyHours), cumulativeHours: finite(e?.cumulativeHours) }];
        }),
      ),
    })),
  };
}

// 팔꿈치·손목 공통. 같은 BK 유형끼리 묶어 합친 뒤(보고서와 동일) 부담 등급은 합쳐진 위험요인으로 다시 계산한다 —
// mergeBkGroupSummaries는 위험요인 목록·개수는 합치지만 burdenGrade는 대표 항목의 옛 값을 그대로 둔다.
function buildBk(calc, { bkTypes, flagKeys, groupFn, mergeFn, gradeFn }, jobIndexOf, diagnosisRefOf) {
  const temporal = calc.temporalSequence || {};
  return {
    noEvaluableJobs: calc.noEvaluableJobs === true,
    temporal: {
      recentTaskChange: oneOf(RECENT_TASK_CHANGE_VALUES, temporal.recent_task_change),
      improvesWithRest: yesNo(temporal.improves_with_rest),
      flags: listOf(TEMPORAL_FLAG_KEYS, (calc.temporalFlagItems || []).map((item) => item.key)),
      hasMissingCommonFields: (calc.missingCommonFields || []).length > 0,
    },
    jobs: (calc.jobSummaries || []).slice(0, MAX_JOBS).map((jobSummary, i) => ({
      jobIndex: jobIndexOf(jobSummary.sharedJobId, i),
      groups: groupFn(jobSummary.diagnosisSummaries || [])
        .slice(0, 10)
        .map((group) => {
          const merged = mergeFn(group.summaries);
          const riskFactorKeys = listOf(flagKeys, (merged.riskFactorItems || []).map((item) => item.key));
          const flags = Object.fromEntries(riskFactorKeys.map((key) => [key, true]));
          const count = Math.max(0, intOrNull(merged.riskFactorCount) ?? 0);
          return {
            bkType: oneOf(bkTypes, group.bkType),
            diagnosisRefs: group.summaries
              .map((s) => diagnosisRefOf(s.diagnosis?.id ?? s.diagnosisId))
              .filter((ref) => ref !== undefined)
              .slice(0, 20),
            riskFactorKeys,
            riskFactorCount: count,
            burdenGrade: BK_GRADE_KEYS[gradeFn(count, flags)] ?? 'none',
            hasMissingFields: (merged.missingFields || []).length > 0,
          };
        }),
    })),
  };
}

function buildCervical(calc, jobIndexOf) {
  return {
    noEvaluableJobs: calc.noEvaluableJobs === true,
    overallBurdenGrade: oneOf(CERVICAL_BURDEN_GRADES, calc.overallBurdenGrade),
    overallCumulativeKgHours: finite(calc.overallCumulativeKgHours),
    jobs: (calc.jobSummaries || []).slice(0, MAX_JOBS).map((js, i) => ({
      jobIndex: jobIndexOf(js.sharedJobId, i),
      burdenGrade: oneOf(CERVICAL_BURDEN_GRADES, js.burdenGrade) ?? 'low',
      flagKeys: listOf(CERVICAL_FLAG_KEYS, (js.flagItems || []).map((item) => item.key)),
      riskFactorCount: Math.max(0, intOrNull(js.riskFactorCount) ?? 0),
      cumulativeKgHours: finite(js.cumulativeKgHours),
      representativeHours: finite(js.representativeHours),
      totalAwkwardHours: finite(js.totalAwkwardHours),
      yearsExposed: finite(js.yearsExposed),
      taskCount: Math.max(0, intOrNull(js.totalTaskCount) ?? 0),
      completedTaskCount: Math.max(0, intOrNull(js.completedTaskCount) ?? 0),
      hasBk2109CoreTask: js.hasBk2109CoreTask === true,
      tasks: (js.taskSummaries || []).slice(0, MAX_TASKS).map((task) => ({
        exposureTypes: listOf(CERVICAL_EXPOSURE_TYPES, task.exposure_types),
        loadWeightKg: finite(task.load_weight_kg),
        carryHoursPerShift: finite(task.carry_hours_per_shift),
        neckNonNeutralHoursPerDay: finite(task.neck_nonneutral_hours_per_day),
        forcedNeckPosture: yesNo(task.forced_neck_posture),
        combinedFlexionRotation: yesNo(task.combined_flexion_rotation_posture),
        precisionWork: yesNo(task.precision_work),
      })),
    })),
  };
}

const TIME_UNITS = ['sec', 'min', 'hr'];
const COMPARISON_STATUS = ['safe', 'warning', 'danger'];

function buildSpineMddm(calc, jobIndexOf) {
  const mddm = calc.comparison?.mddm;
  const court = calc.comparison?.court;
  if (!mddm || !court) return undefined;
  // 보고서(sectionText)와 같은 입력: 가중 일일 용량이 있으면 그것, 없으면 일일 용량.
  const dailyKNh = calc.weightedDailyDose?.value ?? calc.dailyDose?.dailyDoseKNh ?? 0;
  return {
    formulaVersion: calc.formulaVersion === SPINE_FORMULA_V513 ? 'v5.1.3' : 'legacy',
    dailyDoseKNh: finite(calc.dailyDose?.dailyDoseKNh),
    lifetimeDoseMNh: finite(calc.lifetimeDose?.lifetimeDoseMNh),
    totalYears: finite(calc.lifetimeDose?.totalYears),
    excluded: calc.lifetimeDose?.excluded === true,
    weightedDailyDoseKNh: calc.weightedDailyDose ? finite(calc.weightedDailyDose.value) : null,
    comparison: {
      mddm: { limit: finiteOr0(mddm.limit), percent: finiteOr0(mddm.percent), status: mddm.status },
      court: { limit: finiteOr0(court.limit), percent: finiteOr0(court.percent), status: court.status },
    },
    workRelatedness: {
      level: calc.workRelatedness?.level,
      workContributionPct: finite(calc.workRelatedness?.workContribution),
      personalContributionPct: finite(calc.workRelatedness?.personalContribution),
    },
    severity: BURDEN_LEVEL_KEYS[classifySpineSeverity(dailyKNh, calc.maxForce || 0, calc.gender)] ?? 'low',
    jobs: (calc.jobResults || []).slice(0, MAX_JOBS).map((jr, i) => ({
      jobIndex: jobIndexOf(jr.jobId, i),
      periodYears: finite(jr.periodYears),
      workDaysPerYear: finite(jr.workDaysPerYear),
      dailyDoseKNh: finite(jr.dailyDose?.dailyDoseKNh),
      lifetimeDoseMNh: finite(jr.lifetimeDose?.lifetimeDoseMNh),
      lifetimeExcluded: jr.lifetimeDose?.excluded === true,
      tasks: (jr.tasks || []).slice(0, MAX_TASKS).map((task) => ({
        posture: oneOf(SPINE_POSTURES, task.posture),
        weightKg: finite(task.weight),
        frequencyPerDay: finite(task.frequency),
        timeValue: finite(task.timeValue),
        timeUnit: oneOf(TIME_UNITS, task.timeUnit),
        correctionFactor: finite(task.correctionFactor),
        forceN: finite(task.force),
        included: (Number(task.force) || 0) >= thresholds.singleForce, // calculateDailyDose의 포함 기준과 같다
      })),
    })),
  };
}

function buildSpineVibration(v, jobIndexOf) {
  const present = v.exposureStatus === 'present';
  const range = (c) => (present && c ? { percentMin: finiteOr0(c.percent?.min), percentMax: finiteOr0(c.percent?.max), status: oneOf(COMPARISON_STATUS, c.status) ?? 'safe' } : null);
  return {
    exposureStatus: oneOf(['unknown', 'none', 'present'], v.exposureStatus) ?? 'unknown',
    amax8Min: present ? finite(v.amax8?.min) : null,
    amax8Max: present ? finite(v.amax8?.max) : null,
    dvMin: present ? finite(v.dv?.min) : null,
    dvMax: present ? finite(v.dv?.max) : null,
    daily: range(v.comparison?.daily),
    lifetime: range(v.comparison?.lifetime),
    hasInvalidIntervals: v.validation?.hasInvalidIntervals === true,
    jobs: present
      ? (v.jobResults || []).slice(0, MAX_JOBS).map((jr, i) => ({
          jobIndex: jobIndexOf(jr.jobId, i),
          periodYears: finite(jr.periodYears),
          workDaysPerYear: finite(jr.workDaysPerYear),
          intervals: (jr.intervals || []).slice(0, MAX_TASKS).map((iv) => ({
            awMin: finite(iv.awMin),
            awMax: finite(iv.awMax),
            timeValue: finite(iv.timeValue),
            timeUnit: oneOf(TIME_UNITS, iv.timeUnit),
          })),
        }))
      : [],
  };
}

function buildSpine(calc, jobIndexOf) {
  const mddmStatus = oneOf(['unknown', 'none', 'present'], calc.mddmStatus) ?? 'unknown';
  const result = { noEvaluableJobs: calc.noEvaluableJobs === true, mddmStatus };
  if (mddmStatus === 'present') {
    const mddm = buildSpineMddm(calc, jobIndexOf);
    if (mddm) result.mddm = mddm;
  }
  if (calc.vibration) result.vibration = buildSpineVibration(calc.vibration, jobIndexOf);
  return result;
}

// ── 조립 ─────────────────────────────────────────────────────────────────
function buildModules(patientData, shared, diagnosisRefOf) {
  const activeModules = patientData.activeModules || [];
  const jobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const indexById = new Map(jobs.map((job, index) => [job?.id, index]));
  // 계산 결과의 직력은 id로 shared.jobs 위치에 연결한다. id가 없는 구형식(module.jobs)은 결과 안의 순서를 쓴다.
  const jobIndexOf = (id, fallback) => (indexById.has(id) ? indexById.get(id) : fallback);

  const bkConfigs = {
    elbow: { bkTypes: ELBOW_BK_TYPES, flagKeys: ELBOW_FLAG_KEYS, groupFn: groupElbow, mergeFn: mergeElbow, gradeFn: getElbowBurdenGrade },
    wrist: { bkTypes: WRIST_BK_TYPES, flagKeys: WRIST_FLAG_KEYS, groupFn: groupWrist, mergeFn: mergeWrist, gradeFn: getWristBurdenGrade },
  };

  const modules = {};
  activeModules.forEach((moduleId) => {
    if (!AI_MODULE_IDS.includes(moduleId) || modules[moduleId]) return;
    const manifest = getModule(moduleId);
    if (!manifest?.computeCalc) return;
    const calc = manifest.computeCalc({ shared, module: (patientData.modules || {})[moduleId] || {} });
    if (moduleId === 'knee') modules.knee = buildKnee(calc, jobIndexOf);
    else if (moduleId === 'shoulder') modules.shoulder = buildShoulder(calc, jobIndexOf);
    else if (moduleId === 'elbow' || moduleId === 'wrist') modules[moduleId] = buildBk(calc, bkConfigs[moduleId], jobIndexOf, diagnosisRefOf);
    else if (moduleId === 'spine') modules.spine = buildSpine(calc, jobIndexOf);
    else if (moduleId === 'cervical') modules.cervical = buildCervical(calc, jobIndexOf);
  });
  return modules;
}

/** 검증 전 원시 입력. 테스트와 buildAiInput이 쓴다. */
export function buildRawAiInput(patient) {
  const data = patient?.data || {};
  const shared = data.shared || {};
  const activeModules = data.activeModules || [];
  const { diagnoses, refByDiagnosisId } = buildDiagnoses(shared, activeModules);
  return {
    schemaVersion: 1,
    demographics: buildDemographics(shared),
    diagnoses,
    jobs: buildJobs(Array.isArray(shared.jobs) ? shared.jobs : []),
    modules: buildModules(data, shared, (id) => refByDiagnosisId.get(id)),
  };
}

/**
 * 환자 → 검증을 통과한 AI 입력. 스키마를 통과하지 못하면 null — 호출부는 분석을 막아야 한다.
 * 콘솔에는 오류 경로와 코드만 남긴다(값은 환자 정보일 수 있어 기록하지 않는다).
 */
export function buildAiInput(patient) {
  const parsed = AiAnalysisInputSchema.safeParse(buildRawAiInput(patient));
  if (parsed.success) return parsed.data;
  console.error('[ai] 분석 입력을 만들 수 없습니다', parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.')}: ${issue.code}`));
  return null;
}
