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
  // ── §0. 기존 카탈로그 17개(전부 완료, grain 단순화 개정으로 vibration_interval 2개 제외) ──
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
  existing('spine.diagnosis.verticalDistribution'),
  existing('spine.diagnosis.concomitantSpondylosis'),
  existing('job.identity.jobNameNormalized'),
  existing('job.identity.tenureYears'),
  existing('job.rollup.longestTenureJobNameNormalized'),
  existing('diagnosis.identity.moduleGroup'),

  // ── §1. spine 잔여 (Slice 1) — 완료 ─────────────────────────────────────────
  done('spine.case.mddmStatus', '1'),
  done('spine.case.vibrationExposureStatus', '1'),
  done('spine.case.formulaVersion', '1'),
  done('spine.case.workDaysPerYear', '1'),

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
  // grain 단순화 개정 — gender/heightCm/weightKg/birthDate/highBloodPressure/diabetes는
  // case→person으로 재배치(키 자체는 불변). bmi 신규 추가.
  done('patient.identity.gender', '5'),
  done('patient.identity.heightCm', '5'),
  done('patient.identity.weightKg', '5'),
  done('patient.identity.birthDate', '5'),
  done('patient.identity.injuryDate', '5'),
  done('patient.identity.evaluationDate', '5'),
  done('patient.identity.highBloodPressure', '5'),
  done('patient.identity.diabetes', '5'),
  done('patient.identity.bmi', 'grain-simplification'),

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

  // ── §6/§7. elbow/wrist temporal (Slice 8a, case grain — 살아남음) ───────────
  done('elbow.temporal.recentTaskChange', '8a'),
  done('elbow.temporal.taskChangeDate', '8a'),
  done('elbow.temporal.symptomOnsetInterval', '8a'),
  done('elbow.temporal.improvesWithRest', '8a'),
  done('wrist.temporal.recentTaskChange', '8a'),
  done('wrist.temporal.taskChangeDate', '8a'),
  done('wrist.temporal.symptomOnsetInterval', '8a'),
  done('wrist.temporal.improvesWithRest', '8a'),

  // grain 단순화 개정(PR0-B4) — cervical_task grain 신설(Slice 7), elbow/wrist
  // job_diagnosis 공통 필드·BK유형별 세부(Slice 8b/8c) 108개는 job_diagnosis/task/
  // cervical_task/vibration_interval grain 자체와 함께 소스코드까지 완전 삭제됐다.
];
