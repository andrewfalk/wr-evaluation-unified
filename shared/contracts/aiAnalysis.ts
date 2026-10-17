import { z } from 'zod';

// ---------------------------------------------------------------------------
// AI 분석 입력 계약 — 외부 AI(서버 external · Vercel · Electron 독립형)로 보내는 "비식별 구조화 입력".
//
// 원칙: 이 스키마에는 자유 문자열 입력 필드가 없다. 값은 number(유한·절댓값 상한)·boolean·z.enum·그 nullable뿐이고
// 모든 객체가 .strict()라 이름·생년월일·등록번호·병원·의사·직종명·상병명·특이사항·메모 같은 키가 끼어들면 파싱이 실패한다.
// 상병 코드만 문자열인데 ICD 형식 정규식으로 제한한다(사용자가 코드 칸에 자유문을 넣어도 통과하지 못한다).
// 직력·상병은 id 대신 배열 index로 서로 연결한다(jobIndex, diagnosisRefs).
//
// 열거형 키 목록이 모듈 원본(FLAG_META, EXPOSURE_LIMITS, AUX_LABELS, formulaDB …)과 어긋나는지는
// 클라이언트 쪽 드리프트 테스트(src/core/utils/__tests__/aiInput.test.js, hf7-2)가 잡는다.
// ---------------------------------------------------------------------------

// ── 열거형 키 ────────────────────────────────────────────────────────────
export const AI_MODULE_IDS = ['knee', 'shoulder', 'elbow', 'wrist', 'spine', 'cervical'] as const;
/** 신체부담 4단계(무릎 신체부담정도 · 척추 중증도 공용): 고도 / 중등도상 / 중등도하 / 경도 */
export const AI_BURDEN_LEVELS = ['high', 'upperModerate', 'lowerModerate', 'low'] as const;
/** 업무관련성 "낮음" 사유(knee/shoulder LOW_REASON_OPTIONS의 value) */
export const LOW_REASON_KEYS = ['unrelated', 'unconfirmed', 'ageMild', 'delayed', 'lowBurden', 'belowThreshold', 'other'] as const;
export const KNEE_AUX_KEYS = ['stairs', 'kneeTwist', 'startStop', 'tightSpace', 'kneeContact', 'jumpDown'] as const;
export const KLG_VALUES = ['N/A', '1', '2', '3', '4'] as const;
export const ELLMAN_VALUES = ['N/A', 'Grade 1', 'Grade 2', 'Grade 3', 'Full'] as const;
export const SHOULDER_EXPOSURE_KEYS = ['overhead', 'repetitiveMedium', 'repetitiveFast', 'heavyLoad', 'vibration'] as const;
export const SPINE_POSTURES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11'] as const;
export const ELBOW_BK_TYPES = ['BK2101', 'BK2103', 'BK2105', 'BK2106'] as const;
export const WRIST_BK_TYPES = ['BK2113', 'BK2101', 'BK2103', 'BK2106'] as const;
export const RECENT_TASK_CHANGE_VALUES = ['none', 'increased_load', 'process_change', 'new_task'] as const;
export const TEMPORAL_FLAG_KEYS = ['temporal_fit_high', 'temporal_fit_unclear'] as const;
export const BK_BURDEN_GRADES = ['none', 'mild', 'moderate', 'high'] as const;
export const CERVICAL_EXPOSURE_TYPES = ['shoulder_heavy_load', 'awkward_static_neck_load'] as const;
export const CERVICAL_BURDEN_GRADES = ['high_bk2109', 'present', 'low'] as const;

/** packages/analytics-core/modules/elbow/derived.ts FLAG_META 키(17) */
export const ELBOW_FLAG_KEYS = [
  'core_exposure_present', 'core_exposure_unclear', 'daily_share_high', 'daily_share_moderate', 'daily_share_low',
  'rest_unfavorable', 'mechanical_load_dominant', 'pressure_load_dominant', 'vibration_present',
  'bk2101_pattern_supported', 'bk2105_pattern_supported', 'bk2106_pattern_supported', 'bk2103_pattern_supported',
  'bk2103_transmission_amplifier_present', 'temporal_fit_high', 'temporal_fit_unclear', 'bk2101_high_freq_example',
] as const;

/** packages/analytics-core/modules/wrist/derived.ts FLAG_META 키(18) */
export const WRIST_FLAG_KEYS = [
  'core_exposure_present', 'core_exposure_unclear', 'daily_share_high', 'daily_share_moderate', 'daily_share_low',
  'rest_unfavorable', 'mechanical_load_dominant', 'pressure_load_dominant', 'vibration_present',
  'bk2101_high_freq_example', 'bk2101_pattern_supported', 'bk2103_pattern_supported',
  'bk2103_transmission_amplifier_present', 'bk2106_pattern_supported', 'bk2113_pattern_supported',
  'bk2113_combined_exposure_present', 'temporal_fit_high', 'temporal_fit_unclear',
] as const;

/** packages/analytics-core/modules/cervical/derived.ts FLAG_META 키(9) */
export const CERVICAL_FLAG_KEYS = [
  'heavy_load_present', 'carry_time_supported', 'forced_neck_posture_present', 'cumulative_load_supported',
  'bk2109_pattern_supported', 'daily_share_high', 'daily_share_moderate', 'awkward_static_neck_supported',
  'mechanical_cervical_load_dominant',
] as const;

// ── 공통 조각 ────────────────────────────────────────────────────────────
const NUMBER_LIMIT = 1e9;
const num = z.number().finite().min(-NUMBER_LIMIT).max(NUMBER_LIMIT);
const numOrNull = num.nullable();
const index = z.number().int().min(0).max(1000);
const count = z.number().int().min(0).max(1_000_000);
const bool = z.boolean();
const yesNo = z.enum(['yes', 'no']).nullable();
const confirmed = z.enum(['confirmed', 'unconfirmed']).nullable();
const burdenLevel = z.enum(AI_BURDEN_LEVELS);

/** 키마다 같은 스키마를 갖는 strict 객체(예: 어깨 5개 노출 항목). */
function keyedObject<K extends string, S extends z.ZodTypeAny>(keys: readonly K[], schema: S) {
  return z.object(Object.fromEntries(keys.map((key) => [key, schema])) as Record<K, S>).strict();
}

// ── 인구학 · 상병 · 직력 ───────────────────────────────────────────────────
const DemographicsSchema = z
  .object({
    ageYears: z.number().int().min(0).max(120).nullable(),
    gender: z.enum(['male', 'female']).nullable(),
    heightCm: numOrNull,
    weightKg: numOrNull,
    bmi: numOrNull,
    hypertension: bool.nullable(),
    diabetes: bool.nullable(),
  })
  .strict();

/** 평가 단위 하나 — 좌/우 슬롯, 축성(척추·경추)은 side 값과 무관하게 'axial' 단일 슬롯(assessmentGroups.js unitsForDiagnosis). */
const DiagnosisUnitSchema = z
  .object({
    side: z.enum(['right', 'left', 'axial']),
    confirmed,
    assessment: z.enum(['high', 'low']).nullable(),
    reasons: z.array(z.enum(LOW_REASON_KEYS)).max(LOW_REASON_KEYS.length),
    klg: z.enum(KLG_VALUES).nullable(),
    ellman: z.enum(ELLMAN_VALUES).nullable(),
  })
  .strict();

const DiagnosisSchema = z
  .object({
    // 사용자가 입력하는 칸이라 자유문이 들어올 수 있다 → ICD 형식(예: M17.1)이 아니면 거부한다. 상병명은 보내지 않는다.
    code: z.string().regex(/^[A-Z]\d{2}(\.\d{1,2})?$/).nullable(),
    moduleId: z.enum(AI_MODULE_IDS).nullable(),
    side: z.enum(['right', 'left', 'both']).nullable(),
    units: z.array(DiagnosisUnitSchema).max(2),
    verticalDistribution: confirmed,
    concomitantSpondylosis: confirmed,
  })
  .strict();

const JobSchema = z
  .object({
    durationYears: numOrNull,
    workDaysPerYear: z.number().int().min(0).max(366).nullable(),
    excludedFromAnalysis: bool,
  })
  .strict();

// ── 모듈별 ───────────────────────────────────────────────────────────────
const KneeSchema = z
  .object({
    noEvaluableJobs: bool,
    relatedness: z.object({ minPct: numOrNull, maxPct: numOrNull, avgPct: numOrNull }).strict().nullable(),
    cumulativeBurdenSufficient: bool,
    jobs: z
      .array(
        z
          .object({
            jobIndex: index,
            weightKgPerDay: numOrNull,
            squattingMinPerDay: numOrNull,
            aux: keyedObject(KNEE_AUX_KEYS, bool),
            burdenLevel: burdenLevel.nullable(),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();

const ShoulderSchema = z
  .object({
    noEvaluableJobs: bool,
    totals: keyedObject(
      SHOULDER_EXPOSURE_KEYS,
      z.object({ hours: num, limitHours: num, ratio: num, exceeded: bool }).strict(),
    ).nullable(),
    interpretation: z.enum(['exceeded', 'combinedSufficient', 'insufficient']).nullable(),
    jobs: z
      .array(
        z
          .object({
            jobIndex: index,
            periodYears: numOrNull,
            exposures: keyedObject(
              SHOULDER_EXPOSURE_KEYS,
              z.object({ dailyHours: numOrNull, cumulativeHours: numOrNull }).strict(),
            ),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();

/** z.enum은 변경 가능한 튜플을 요구한다 — 단언은 값의 리터럴 유니온(T[number])을 유지해 공개 타입이 string으로 넓어지지 않게 한다. */
const literalEnum = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values as unknown as [T[number], ...T[number][]]);

/** 팔꿈치·손목은 같은 구조(BK 유형 목록과 위험요인 키 목록만 다르다). */
function bkModuleSchema<B extends readonly [string, ...string[]], F extends readonly [string, ...string[]]>(
  bkTypes: B,
  flagKeys: F,
) {
  return z
    .object({
      noEvaluableJobs: bool,
      temporal: z
        .object({
          recentTaskChange: z.enum(RECENT_TASK_CHANGE_VALUES).nullable(),
          improvesWithRest: yesNo,
          flags: z.array(z.enum(TEMPORAL_FLAG_KEYS)).max(TEMPORAL_FLAG_KEYS.length),
          hasMissingCommonFields: bool,
        })
        .strict(),
      jobs: z
        .array(
          z
            .object({
              jobIndex: index,
              groups: z
                .array(
                  z
                    .object({
                      bkType: literalEnum(bkTypes).nullable(),
                      diagnosisRefs: z.array(index).max(20),
                      riskFactorKeys: z.array(literalEnum(flagKeys)).max(flagKeys.length),
                      riskFactorCount: count,
                      burdenGrade: z.enum(BK_BURDEN_GRADES),
                      hasMissingFields: bool,
                    })
                    .strict(),
                )
                .max(10),
            })
            .strict(),
        )
        .max(30),
    })
    .strict();
}

const CervicalSchema = z
  .object({
    noEvaluableJobs: bool,
    overallBurdenGrade: z.enum(CERVICAL_BURDEN_GRADES).nullable(),
    overallCumulativeKgHours: numOrNull,
    jobs: z
      .array(
        z
          .object({
            jobIndex: index,
            burdenGrade: z.enum(CERVICAL_BURDEN_GRADES),
            flagKeys: z.array(z.enum(CERVICAL_FLAG_KEYS)).max(CERVICAL_FLAG_KEYS.length),
            riskFactorCount: count,
            cumulativeKgHours: numOrNull,
            representativeHours: numOrNull,
            totalAwkwardHours: numOrNull,
            yearsExposed: numOrNull,
            taskCount: count,
            completedTaskCount: count,
            hasBk2109CoreTask: bool,
            tasks: z
              .array(
                z
                  .object({
                    exposureTypes: z.array(z.enum(CERVICAL_EXPOSURE_TYPES)).max(CERVICAL_EXPOSURE_TYPES.length),
                    loadWeightKg: numOrNull,
                    carryHoursPerShift: numOrNull,
                    neckNonNeutralHoursPerDay: numOrNull,
                    forcedNeckPosture: yesNo,
                    combinedFlexionRotation: yesNo,
                    precisionWork: yesNo,
                  })
                  .strict(),
              )
              .max(30),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();

// 상태 값의 의미는 비교마다 다르다(spine/mddm.ts compareThresholds, vibration.ts rangeStatus). 라벨을 섞지 않도록 스키마도 나눈다.
//  - MDDM 기준: 한도 이하 safe / 초과 danger (warning 없음)
//  - 법원(BSG) 기준: 한도 이하 safe / 한도 초과~120% warning / 120% 초과 danger  ← warning은 "근접"이 아니라 이미 초과다
//  - 전신진동 범위: 최대값이 기준 미만 safe / 범위가 기준에 걸침(최소<기준≤최대) warning / 최소값이 기준 이상 danger
const MddmComparisonSchema = z.object({ limit: num, percent: num, status: z.enum(['safe', 'danger']) }).strict();
const CourtComparisonSchema = z.object({ limit: num, percent: num, status: z.enum(['safe', 'warning', 'danger']) }).strict();
const VibrationRangeSchema = z
  .object({ percentMin: num, percentMax: num, status: z.enum(['safe', 'warning', 'danger']) })
  .strict();

const SpineMddmSchema = z
  .object({
    formulaVersion: z.enum(['v5.1.3', 'legacy']),
    dailyDoseKNh: numOrNull,
    lifetimeDoseMNh: numOrNull,
    totalYears: numOrNull,
    excluded: bool,
    weightedDailyDoseKNh: numOrNull,
    comparison: z.object({ mddm: MddmComparisonSchema, court: CourtComparisonSchema }).strict(),
    workRelatedness: z
      .object({ level: z.enum(['high', 'medium', 'low']), workContributionPct: numOrNull, personalContributionPct: numOrNull })
      .strict(),
    severity: burdenLevel,
    jobs: z
      .array(
        z
          .object({
            jobIndex: index,
            periodYears: numOrNull,
            workDaysPerYear: numOrNull,
            dailyDoseKNh: numOrNull,
            lifetimeDoseMNh: numOrNull,
            tasks: z
              .array(
                z
                  .object({
                    posture: z.enum(SPINE_POSTURES).nullable(),
                    weightKg: numOrNull,
                    frequencyPerDay: numOrNull,
                    timeValue: numOrNull,
                    timeUnit: z.enum(['sec', 'min', 'hr']).nullable(),
                    correctionFactor: numOrNull,
                    forceN: numOrNull,
                    included: bool,
                  })
                  .strict(),
              )
              .max(30),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();

const SpineVibrationSchema = z
  .object({
    exposureStatus: z.enum(['unknown', 'none', 'present']),
    amax8Min: numOrNull,
    amax8Max: numOrNull,
    dvMin: numOrNull,
    dvMax: numOrNull,
    daily: VibrationRangeSchema.nullable(),
    lifetime: VibrationRangeSchema.nullable(),
    hasInvalidIntervals: bool,
    jobs: z
      .array(
        z
          .object({
            jobIndex: index,
            periodYears: numOrNull,
            workDaysPerYear: numOrNull,
            intervals: z
              .array(
                z
                  .object({
                    awMin: numOrNull,
                    awMax: numOrNull,
                    timeValue: numOrNull,
                    timeUnit: z.enum(['sec', 'min', 'hr']).nullable(),
                  })
                  .strict(),
              )
              .max(30),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();

const SpineSchema = z
  .object({
    noEvaluableJobs: bool,
    mddmStatus: z.enum(['unknown', 'none', 'present']),
    mddm: SpineMddmSchema.optional(),
    vibration: SpineVibrationSchema.optional(),
  })
  .strict();

// ── 최상위 ───────────────────────────────────────────────────────────────
export const AiAnalysisInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    demographics: DemographicsSchema,
    diagnoses: z.array(DiagnosisSchema).max(20),
    jobs: z.array(JobSchema).max(30),
    modules: z
      .object({
        knee: KneeSchema.optional(),
        shoulder: ShoulderSchema.optional(),
        elbow: bkModuleSchema(ELBOW_BK_TYPES, ELBOW_FLAG_KEYS).optional(),
        wrist: bkModuleSchema(WRIST_BK_TYPES, WRIST_FLAG_KEYS).optional(),
        spine: SpineSchema.optional(),
        cervical: CervicalSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type AiAnalysisInput = z.infer<typeof AiAnalysisInputSchema>;

/** 내부 LLM 경로: 구조화 입력 + (선택) 현행 보고서 전문. */
export const AiAnalysisRequestSchema = z
  .object({
    input: AiAnalysisInputSchema,
    fullReport: z.string().max(60000).optional(),
    model: z.string().max(100).optional(),
  })
  .strict();

/** 외부 경로(서버 external · Vercel · Electron): fullReport 필드가 존재하는 것 자체를 거부한다. */
export const AiAnalysisExternalRequestSchema = AiAnalysisRequestSchema.omit({ fullReport: true }).strict();

export type AiAnalysisRequest = z.infer<typeof AiAnalysisRequestSchema>;
export type AiAnalysisExternalRequest = z.infer<typeof AiAnalysisExternalRequestSchema>;
