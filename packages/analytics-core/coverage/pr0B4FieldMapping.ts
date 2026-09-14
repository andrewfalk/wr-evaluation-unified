// Slice -1/Slice 0 산출물 — PR0-B4-field-mapping.md(4차 개정)의 "목표 카탈로그 키" 컬럼을
// 기계가 읽을 수 있는 형태로 옮긴 것. 이 파일이 `__tests__/catalog.test.ts`의 누적 검증
// fixture다 — 매핑표(.md)와 항상 같이 갱신할 것(.md가 사람이 읽는 근거, 이 파일이 테스트가
// 참조하는 진실원).
//
// scope: 'existing'(이미 PR0-B3까지 등록 완료) | 'planned'(PR0-B4 신규등록 대상, 아직 미등록).
// done: 이 키가 실제로 `getFullVariableCatalog()`에 존재해야 하는지 여부 — 슬라이스가
// 구현을 마칠 때마다 해당 항목을 true로 갱신한다. existing은 처음부터 전부 true(§0).
// slice: 담당 슬라이스 번호(매핑표 §1~§7과 동일 표기).
//
// 여기 없는 원본 필드(제외/보류로 분류된 것)는 카탈로그 키 자체가 없으므로 이 fixture의
// 대상이 아니다 — 매핑표.md의 "제외"/"보류" 행 참고.

export interface FieldMappingEntry {
  key: string;
  scope: 'existing' | 'planned';
  slice: string;
  done: boolean;
}

const existing = (key: string): FieldMappingEntry => ({ key, scope: 'existing', slice: 'PR0-B3', done: true });
const planned = (key: string, slice: string): FieldMappingEntry => ({ key, scope: 'planned', slice, done: false });
// Slice 완료 시 여기서 done:true로 승격한다(예: done('key', '1')). planned()는 항상 미완료다.
const done = (key: string, slice: string): FieldMappingEntry => ({ key, scope: 'planned', slice, done: true });

export const PR0_B4_FIELD_MAPPING: readonly FieldMappingEntry[] = [
  // ── §0. 기존 카탈로그 21개(전부 완료) ──────────────────────────────────────────
  existing('knee.relatedness.max'),
  existing('knee.diagnosisSide.klGrade'),
  existing('knee.diagnosisSide.confirmedStatus'),
  existing('knee.diagnosisSide.appliedConfirmedMismatch'),
  existing('shoulder.exposure.anyExceeded'),
  existing('shoulder.diagnosisSide.ellmanClass'),
  existing('elbow.assessment.burdenGradeMax'),
  existing('wrist.assessment.burdenGradeMax'),
  existing('cervical.case.maxJobCumulativeKgHours'),
  existing('spine.mddm.lifetimeDoseMNh'),
  existing('spine.vibration.dvMax'),
  existing('spine.vibration.intervalA8Max'),
  existing('spine.vibration.intervalExposureHours'),
  existing('spine.diagnosis.verticalDistribution'),
  existing('spine.diagnosis.concomitantSpondylosis'),
  existing('spine.task.weightKg'),
  existing('spine.task.frequencyPerDay'),
  existing('job.identity.jobNameNormalized'),
  existing('job.identity.tenureYears'),
  existing('job.rollup.longestTenureJobNameNormalized'),
  existing('diagnosis.identity.moduleGroup'),

  // ── §1. spine 잔여 (Slice 1) — 완료 ─────────────────────────────────────────
  done('spine.case.mddmStatus', '1'),
  done('spine.case.vibrationExposureStatus', '1'),
  done('spine.case.formulaVersion', '1'),
  done('spine.case.evalMethod', '1'),
  done('spine.case.careerYears', '1'),
  done('spine.case.careerMonths', '1'),
  done('spine.case.workDaysPerYear', '1'),
  done('spine.task.posture', '1'),
  done('spine.task.timeValue', '1'),
  done('spine.task.timeUnit', '1'),
  done('spine.task.correctionFactor', '1'),
  done('spine.vibration.intervalAwMin', '1'),
  done('spine.vibration.intervalAwMax', '1'),
  done('spine.vibration.intervalTimeValue', '1'),
  done('spine.vibration.intervalTimeUnit', '1'),

  // ── §1(shared). job 잔여 (Slice 2) ──────────────────────────────────────────
  done('job.raw.startDate', '2'),
  done('job.raw.endDate', '2'),
  done('job.raw.workDaysPerYear', '2'),

  // ── §3. shoulder jobExtras (Slice 3) ────────────────────────────────────────
  done('shoulder.job.overheadHours', '3'),
  done('shoulder.job.repetitiveMediumHours', '3'),
  done('shoulder.job.repetitiveFastHours', '3'),
  done('shoulder.job.heavyLoadCount', '3'),
  done('shoulder.job.heavyLoadSeconds', '3'),
  done('shoulder.job.vibrationHours', '3'),

  // ── §2. knee jobExtras + DEFERRED 6개 (Slice 4) ─────────────────────────────
  done('knee.job.squattingMinutesPerDay', '4'),
  done('knee.job.dailyLoadKg', '4'),
  done('knee.job.stairs', '4'),
  done('knee.job.kneeTwist', '4'),
  done('knee.job.startStop', '4'),
  done('knee.job.tightSpace', '4'),
  done('knee.job.kneeContact', '4'),
  done('knee.job.jumpDown', '4'),

  // ── §1(shared). patient pseudo-module (Slice 5) ─────────────────────────────
  done('patient.identity.gender', '5'),
  done('patient.identity.heightCm', '5'),
  done('patient.identity.weightKg', '5'),
  done('patient.identity.birthDate', '5'),
  done('patient.identity.injuryDate', '5'),
  done('patient.identity.evaluationDate', '5'),
  done('patient.identity.highBloodPressure', '5'),
  done('patient.identity.diabetes', '5'),

  // ── §1(shared)+diagnosis 잔여 (Slice 6) ──────────────────────────────────────
  done('diagnosis.identity.code', '6'),
  done('diagnosis.identity.name', '6'),
  done('diagnosis.assessment.status', '6'),
  done('diagnosis.assessment.lowReason.unrelated', '6'),
  done('diagnosis.assessment.lowReason.unconfirmed', '6'),
  done('diagnosis.assessment.lowReason.ageMild', '6'),
  done('diagnosis.assessment.lowReason.delayed', '6'),
  done('diagnosis.assessment.lowReason.lowBurden', '6'),
  done('diagnosis.assessment.lowReason.belowThreshold', '6'),
  done('diagnosis.assessment.lowReason.other', '6'),

  // ── §5. cervical_task grain 신설 (Slice 7) ──────────────────────────────────
  done('cervical.task.name', '7'),
  done('cervical.task.exposureType.shoulderHeavyLoad', '7'),
  done('cervical.task.exposureType.awkwardStaticNeckLoad', '7'),
  done('cervical.task.loadWeightKg', '7'),
  done('cervical.task.carryHoursPerShift', '7'),
  done('cervical.task.forcedNeckPosture', '7'),
  done('cervical.task.neckNonneutralHoursPerDay', '7'),
  done('cervical.task.combinedFlexionRotationPosture', '7'),
  done('cervical.task.precisionWork', '7'),

  // ── §6/§7. elbow/wrist temporal (Slice 8a) ──────────────────────────────────
  done('elbow.temporal.recentTaskChange', '8a'),
  done('elbow.temporal.taskChangeDate', '8a'),
  done('elbow.temporal.symptomOnsetInterval', '8a'),
  done('elbow.temporal.improvesWithRest', '8a'),
  done('wrist.temporal.recentTaskChange', '8a'),
  done('wrist.temporal.taskChangeDate', '8a'),
  done('wrist.temporal.symptomOnsetInterval', '8a'),
  done('wrist.temporal.improvesWithRest', '8a'),

  // ── §6. elbow job_diagnosis 공통 필드 (Slice 8b) ────────────────────────────
  done('elbow.jobDiagnosis.selectedBkType', '8b'),
  done('elbow.jobDiagnosis.mainTaskName', '8b'),
  done('elbow.jobDiagnosis.directAnatomicLink', '8b'),
  done('elbow.jobDiagnosis.exposureType.repetition', '8b'),
  done('elbow.jobDiagnosis.exposureType.force', '8b'),
  done('elbow.jobDiagnosis.exposureType.awkwardPosture', '8b'),
  done('elbow.jobDiagnosis.repetitionLevel', '8b'),
  done('elbow.jobDiagnosis.forceLevel', '8b'),
  done('elbow.jobDiagnosis.awkwardPostureLevel', '8b'),
  done('elbow.jobDiagnosis.workPattern', '8b'),
  done('elbow.jobDiagnosis.restDistribution', '8b'),
  done('elbow.jobDiagnosis.dailyExposureHours', '8b'),
  done('elbow.jobDiagnosis.shiftSharePercent', '8b'),
  done('elbow.jobDiagnosis.daysPerWeek', '8b'),

  // ── §7. wrist job_diagnosis 공통 필드 (Slice 8b) ────────────────────────────
  done('wrist.jobDiagnosis.selectedBkType', '8b'),
  done('wrist.jobDiagnosis.mainTaskName', '8b'),
  done('wrist.jobDiagnosis.directAnatomicLink', '8b'),
  done('wrist.jobDiagnosis.exposureType.repetition', '8b'),
  done('wrist.jobDiagnosis.exposureType.force', '8b'),
  done('wrist.jobDiagnosis.exposureType.awkwardPosture', '8b'),
  done('wrist.jobDiagnosis.repetitionLevel', '8b'),
  done('wrist.jobDiagnosis.forceLevel', '8b'),
  done('wrist.jobDiagnosis.awkwardPostureLevel', '8b'),
  done('wrist.jobDiagnosis.workPattern', '8b'),
  done('wrist.jobDiagnosis.restDistribution', '8b'),
  done('wrist.jobDiagnosis.dailyExposureHours', '8b'),
  done('wrist.jobDiagnosis.shiftSharePercent', '8b'),
  done('wrist.jobDiagnosis.daysPerWeek', '8b'),

  // ── §6. elbow BK유형별 세부 (Slice 8c) ───────────────────────────────────────
  done('elbow.jobDiagnosis.staticHoldingLevel', '8c'),
  done('elbow.jobDiagnosis.directPressureLevel', '8c'),
  done('elbow.jobDiagnosis.vibrationExposure', '8c'),
  done('elbow.jobDiagnosis.bk2101CycleSeconds', '8c'),
  done('elbow.jobDiagnosis.bk2101RepetitionPerHour', '8c'),
  done('elbow.jobDiagnosis.bk2101Monotony', '8c'),
  done('elbow.jobDiagnosis.bk2101ForcedDorsalExtension', '8c'),
  done('elbow.jobDiagnosis.bk2101Prosupination', '8c'),
  done('elbow.jobDiagnosis.bk2105ElbowLeaning', '8c'),
  done('elbow.jobDiagnosis.bk2105PressureSource.hardSurface', '8c'),
  done('elbow.jobDiagnosis.bk2105PressureSource.toolEdge', '8c'),
  done('elbow.jobDiagnosis.bk2105PressureSource.groundContact', '8c'),
  done('elbow.jobDiagnosis.bk2105PressureSource.carryingContact', '8c'),
  done('elbow.jobDiagnosis.bk2105PressureSource.other', '8c'),
  done('elbow.jobDiagnosis.bk2106PressureSource.hardSurface', '8c'),
  done('elbow.jobDiagnosis.bk2106PressureSource.toolEdge', '8c'),
  done('elbow.jobDiagnosis.bk2106PressureSource.groundContact', '8c'),
  done('elbow.jobDiagnosis.bk2106PressureSource.carryingContact', '8c'),
  done('elbow.jobDiagnosis.bk2106PressureSource.other', '8c'),
  done('elbow.jobDiagnosis.bk2103VibrationToolType.grinder', '8c'),
  done('elbow.jobDiagnosis.bk2103VibrationToolType.jackhammer', '8c'),
  done('elbow.jobDiagnosis.bk2103VibrationToolType.demolitionHammer', '8c'),
  done('elbow.jobDiagnosis.bk2103VibrationToolType.chippingHammer', '8c'),
  done('elbow.jobDiagnosis.bk2103VibrationToolType.tampingMachine', '8c'),
  done('elbow.jobDiagnosis.bk2103VibrationToolType.rotaryHammer', '8c'),
  done('elbow.jobDiagnosis.bk2103VibrationToolType.compactor', '8c'),
  done('elbow.jobDiagnosis.bk2103VibrationToolType.reciprocatingSaw', '8c'),
  done('elbow.jobDiagnosis.bk2103VibrationToolType.rivetHammer', '8c'),
  done('elbow.jobDiagnosis.bk2103VibrationToolType.rustHammer', '8c'),
  done('elbow.jobDiagnosis.bk2103VibrationToolType.powderActuatedTool', '8c'),
  done('elbow.jobDiagnosis.bk2103VibrationToolType.forgingHammer', '8c'),
  done('elbow.jobDiagnosis.bk2103VibrationToolType.other', '8c'),
  done('elbow.jobDiagnosis.bk2103DailyVibrationHours', '8c'),
  done('elbow.jobDiagnosis.bk2103ToolPressing', '8c'),
  done('elbow.jobDiagnosis.bk2103FrequentHighForceGrip', '8c'),

  // ── §7. wrist BK유형별 세부 (Slice 8c) ───────────────────────────────────────
  done('wrist.jobDiagnosis.staticHoldingLevel', '8c'),
  done('wrist.jobDiagnosis.directPressureLevel', '8c'),
  done('wrist.jobDiagnosis.vibrationExposure', '8c'),
  done('wrist.jobDiagnosis.bk2101CycleSeconds', '8c'),
  done('wrist.jobDiagnosis.bk2101RepetitionPerHour', '8c'),
  done('wrist.jobDiagnosis.bk2101Monotony', '8c'),
  done('wrist.jobDiagnosis.bk2101ForcedDorsalExtension', '8c'),
  done('wrist.jobDiagnosis.bk2101Prosupination', '8c'),
  done('wrist.jobDiagnosis.bk2106PressureSource.hardSurface', '8c'),
  done('wrist.jobDiagnosis.bk2106PressureSource.toolEdge', '8c'),
  done('wrist.jobDiagnosis.bk2106PressureSource.palmContact', '8c'),
  done('wrist.jobDiagnosis.bk2106PressureSource.carryingContact', '8c'),
  done('wrist.jobDiagnosis.bk2106PressureSource.other', '8c'),
  done('wrist.jobDiagnosis.bk2103VibrationToolType.grinder', '8c'),
  done('wrist.jobDiagnosis.bk2103VibrationToolType.impactWrench', '8c'),
  done('wrist.jobDiagnosis.bk2103VibrationToolType.hammerDrill', '8c'),
  done('wrist.jobDiagnosis.bk2103VibrationToolType.jackhammer', '8c'),
  done('wrist.jobDiagnosis.bk2103VibrationToolType.polisher', '8c'),
  done('wrist.jobDiagnosis.bk2103VibrationToolType.sander', '8c'),
  done('wrist.jobDiagnosis.bk2103VibrationToolType.other', '8c'),
  done('wrist.jobDiagnosis.bk2103DailyVibrationHours', '8c'),
  done('wrist.jobDiagnosis.bk2103ToolPressing', '8c'),
  done('wrist.jobDiagnosis.bk2103FrequentHighForceGrip', '8c'),
  done('wrist.jobDiagnosis.bk2113RepetitiveWristMotion', '8c'),
];
