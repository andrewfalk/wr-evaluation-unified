import { z } from 'zod';
import { AnalysisRecipeSchema } from './videoRecipe';

// ---------------------------------------------------------------------------
// 작업 영상 인간공학 분석 (RTMPose) — Feature 표준 스키마·단위·신뢰도 계약
// PRD §8.4 / §8.8 / §8.10.2-1 / §8.11. 코드의 첫 산출물(schema-first).
// 모든 추출값은 단위·신뢰도·자동제안 가능 여부를 포함하는 표준 객체로 흐른다.
// ---------------------------------------------------------------------------

// 단위 — 계약 단계에서 고정해 시간 단위 혼동(분/시)·비율 오해석을 막는다(§8.4).
export const FeatureUnitSchema = z.enum([
  'minutes_per_day',
  'hours_per_day',
  'cycles_per_minute',
  'cycles_per_day',
  'seconds_per_cycle',
  'ratio',
  'degrees',
]);

// feature를 키로 식별 — requestedFeatures와 반환 feature의 대응 검증 가능(§8.4).
export const FeatureKeySchema = z.enum([
  'squatDuration',
  'overheadHours',
  'repetitiveMediumHours',
  'repetitiveFastHours',
  'cyclesPerDay',
  'cycleSeconds',
  'trunkPostureG',
  'trunkFlexionOver45Duration',
  'neckFlexionOver20HoursPerDay',
  'neckForcedFlexion',
  'neckCombinedFlexRot',
  'vibrationToolUseDurationCandidate',
  'suspectedKneeTwist',
  'shoulderRepetitionRate', // 6.0-11: 상완거상 반복(cycles/min) candidate
  'elbowRepetitionRate', // 6.0-11: 팔꿈치 굴곡 반복(cycles/min) candidate
]);

// JSONB 저장 가능 값으로 제한 — candidate.value는 unknown 금지(§8.4).
type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };
const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    JsonPrimitiveSchema,
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

// FeatureBase — 모든 feature 공통(§8.4).
export const FeatureBaseSchema = z.object({
  confidence: z.number().min(0).max(1), // 0~1, §8.8의 overall
  autoSuggestAllowed: z.boolean(), // false면 모듈 자동 제안 금지(참고만)
  requiresManualReview: z.boolean(), // true면 적용 시 수기 확인 강제
  warnings: z.array(z.string()), // 예: 'LOW_VIEWPOINT_CONFIDENCE','PARTIAL_OCCLUSION'
});

export const NumericFeatureValueSchema = FeatureBaseSchema.extend({
  kind: z.literal('numeric'),
  value: z.number(),
  unit: FeatureUnitSchema,
});

export const BooleanFeatureValueSchema = FeatureBaseSchema.extend({
  kind: z.literal('boolean'),
  value: z.boolean(),
});

export const CategoricalFeatureValueSchema = FeatureBaseSchema.extend({
  kind: z.literal('categorical'),
  value: z.string(),
  allowedValues: z.array(z.string()).optional(),
});

// candidate(진동공구 후보·회전 성분 등): 모듈 필드에 직접 쓰지 않고 후보로만 표시(§8.4 원자값 원칙).
// autoSuggestAllowed/requiresManualReview는 스키마 수준에서 고정(literal) — 단순 union으로는 강제 불가.
export const CandidateFeatureValueSchema = FeatureBaseSchema.extend({
  kind: z.literal('candidate'),
  value: JsonValueSchema,
  reason: z.string(),
  autoSuggestAllowed: z.literal(false), // 항상 고정
  requiresManualReview: z.literal(true), // 항상 고정
});

export const VideoFeatureValueSchema = z.discriminatedUnion('kind', [
  NumericFeatureValueSchema,
  BooleanFeatureValueSchema,
  CategoricalFeatureValueSchema,
  CandidateFeatureValueSchema,
]);

// featureKey → VideoFeatureValue. 한 클립에서 여러 부위 변수를 동시에 뽑을 수 있다(§8.4).
// (zod record는 모든 키를 허용하지 않으므로 부분 맵으로 다룬다 — 타입은 Partial.)
export const VideoFeatureMapSchema = z.record(FeatureKeySchema, VideoFeatureValueSchema);

// analysisProfile (변수별 fps — 고정 5~10fps 금지, §8.5).
export const AnalysisProfileSchema = z.enum([
  'posture-basic', // 5~10fps: 쪼그려앉기·체간 전굴·오버헤드 자세시간
  'repetition-upper-limb', // 10~15fps: 어깨·팔꿈치 반복 빈도
  'hand-wrist', // 15~30fps: 손목·손가락 반복, SI 보조
]);

export const AnalysisRequestSchema = z.object({
  analysisProfile: AnalysisProfileSchema,
  requestedFeatures: z.array(FeatureKeySchema),
});

// Job 상태 전이 (업로드와 본 분석 분리, §8.5).
// processing 완료 후 review_pending(분석 성공·미검토), done은 적용/폐기로 검수 종료.
export const VideoJobStatusSchema = z.enum([
  'uploaded',
  'sample_detecting',
  'awaiting_target_selection',
  'target_selected',
  'queued',
  'processing',
  'review_pending',
  'done',
  'error',
  'expired',
  'cancelled',
]);

// 신뢰도 세분(§8.8). 첫 구현은 실제 산출 가능한 것부터 — overall만 필수, 나머지는 점진 확장(optional).
export const ConfidenceSchema = z.object({
  overall: z.number().min(0).max(1),
  keypoint: z.number().min(0).max(1).optional(), // RTMPose per-keypoint score
  visibility: z.number().min(0).max(1).optional(), // 관절 가림 비율
  tracking: z.number().min(0).max(1).optional(), // 대상자 추적 안정성
  viewpoint: z.number().min(0).max(1).optional(), // 각도와 시점 적합성
  usableFrameRatio: z.number().min(0).max(1).optional(), // motion blur·frame drop 제외 비율
  warnings: z.array(z.string()).default([]),
});

// provenance — 모듈 입력에 적용된 영상 제안의 출처(§8.11).
// 기존 입력 필드는 객체로 바꾸지 않고 숫자/원자값을 유지하며, 출처는 여기에 분리 저장.
const AtomicValueSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);
export const AppliedInputSchema = z.object({
  moduleId: z.string(),
  targetPath: z.string(), // 예: 'modules.shoulder.jobExtras[sharedJobId=...].overheadHours'
  suggestedValue: AtomicValueSchema, // 영상 원제안
  appliedValue: AtomicValueSchema, // 전문의 확정값
  previousValue: AtomicValueSchema, // 적용 전 값(되돌리기용)
  editReason: z.string().optional(), // 수정 시
  unit: FeatureUnitSchema.nullable(),
  source: z.literal('video'),
  processIds: z.array(z.string()).default([]),
  clipIds: z.array(z.string()).default([]),
  // 이 제안을 만든 원본 분석 job id(추론 출처 추적). 적용은 별도 셸 job을 쓰므로 audit jobId와 구분(§8.11/PR D1).
  analysisJobIds: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  analysisBundleVersion: z.string(), // = recipe 요약 문자열 (§8.11)
  // 구조적 recipe(6.0-9). 서버 apply 검증 게이트가 저장 job recipe·서버 상수와 대조한다.
  // 하위호환: 구 클라/구 데이터는 미포함(string analysisBundleVersion만) → optional.
  recipe: AnalysisRecipeSchema.optional(),
  appliedAt: z.string(),
  appliedBy: z.string(),
});

// 자동입력 금지 후보(진동·회전 등) — 모듈 필드에 안 쓰고 여기 또는 제안 UI에만 표시(§8.4 원자값 원칙).
export const CandidateFeatureEntrySchema = CandidateFeatureValueSchema.extend({
  featureKey: FeatureKeySchema,
  processIds: z.array(z.string()).default([]),
  clipIds: z.array(z.string()).default([]),
});

// 공정 메타(name, shiftSharePercent 등) — 구조가 PR3에서 확장되므로 passthrough(§8.3/§8.11).
export const VideoProcessSchema = z
  .object({
    id: z.string(),
    sharedJobId: z.string(),
    name: z.string(),
    shiftSharePercent: z.number().min(0).max(100).default(0), // 시간 점유율(직업 집계 가중치)
    // 공정활동분/일(수기). intrinsic posture_ratio → per-day 환산 입력(PRD §8.10.2-1). null/미입력=모름.
    activeMinutesPerDay: z.number().nonnegative().max(1440).nullable().optional(),
  })
  .passthrough();

// 클립 메타데이터만 — 파일 경로 저장 금지(§8.11). 임시파일 경로는 서버 job 테이블에만.
export const VideoClipSchema = z
  .object({
    id: z.string(),
    processId: z.string(),
    viewpoint: z.enum(['sagittal', 'frontal', 'other']),
    analysisProfile: AnalysisProfileSchema.optional(),
  })
  .passthrough();

// sample-detect 결과(§8.7, PR D2b) — 대표 프레임 person box 후보. 원본 이미지 없이 bbox 좌표만(privacy_first).
// bbox = xywh 픽셀(keypoints/워커 IoU와 동일 좌표계). DB JSONB로 저장되므로 신뢰 경계 — 저장/읽기 시 검증.
export const SampleDetectPersonSchema = z
  .object({
    id: z.string().min(1),
    // bbox = xywh 픽셀. Python에서 음수 clamp 후 산출 → 신뢰 경계에서 nonnegative 강제(퇴화/위조 박스 차단).
    bbox: z.tuple([
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
    ]),
    score: z.number().min(0).max(1),
  })
  .strict();
export const SampleDetectResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    frameIndex: z.number().int().nonnegative(),
    timestampMs: z.number().nonnegative(),
    frameWidth: z.number().int().positive(),
    frameHeight: z.number().int().positive(),
    persons: z.array(SampleDetectPersonSchema),
  })
  .strict();

// 공정 단위 fused feature(VideoFeatureMap, §8.6.1 시점 융합 결과).
export const ProcessFeaturesSchema = z.object({
  processId: z.string(),
  // 이 공정 결과를 산출한 분석 job id(서버 실분석 시). provenance로 운반; mock/로컬 모드는 생략.
  // D3b 시점 융합: 한 공정이 여러 시점 클립(여러 job)을 융합 → analysisJobIds[]로 운반.
  // jobId는 단일 시점 하위호환용 deprecated(읽기 폴백: analysisJobIds ?? [jobId]). M3에서 제거.
  jobId: z.string().optional(),
  analysisJobIds: z.array(z.string()).optional(),
  features: VideoFeatureMapSchema,
});

// processFeatures의 분석 job id 목록을 정규화(D3b). 빈 배열/undefined jobId에 [undefined] 생성 방지.
export function resolveAnalysisJobIds(pf: { analysisJobIds?: string[]; jobId?: string } | null | undefined): string[] {
  if (!pf) return [];
  if (pf.analysisJobIds && pf.analysisJobIds.length > 0) return pf.analysisJobIds;
  return pf.jobId ? [pf.jobId] : [];
}

// 직업 단위 집계(파생값 — 필요 시 재계산 가능, §8.6.2).
export const JobFeaturesSchema = z.object({
  sharedJobId: z.string(),
  features: VideoFeatureMapSchema,
});

// 검수 보존 정책(§8.12). privacy_first 기본.
export const RetentionModeSchema = z.enum(['privacy_first', 'review_fidelity']);

// 환자 JSONB(영구·UI용) 구조(§8.11). 임시파일 경로는 절대 포함하지 않는다.
export const VideoAnalysisDataSchema = z.object({
  processes: z.array(VideoProcessSchema).default([]),
  clips: z.array(VideoClipSchema).default([]),
  processFeatures: z.array(ProcessFeaturesSchema).default([]),
  jobFeatures: z.array(JobFeaturesSchema).default([]),
  candidateFeatures: z.array(CandidateFeatureEntrySchema).default([]),
  appliedInputs: z.array(AppliedInputSchema).default([]),
  settings: z
    .object({ retentionMode: RetentionModeSchema.default('privacy_first') })
    .default({ retentionMode: 'privacy_first' }),
});

// ---------------------------------------------------------------------------
// 매핑 타깃 계약 (featureKey → targetPath → unit, §8.10.2-1)
// targetPath는 appliedInputs[].targetPath에 그대로 들어가며 모듈 필드에 원자값으로 적용된다.
// "타입은 코드가 진실" — 실제 모듈 data.js의 필드/타입과 어긋나면 코드를 우선(§8.10.2-1).
// mode: auto=검증 통과 시 자동제안 / auto-review=자동제안+수기확인 / candidate=모듈 미기입(후보만).
// ---------------------------------------------------------------------------
export type FeatureMappingMode = 'auto' | 'auto-review' | 'candidate';
export type FeatureMappingTarget = {
  moduleId: 'knee' | 'shoulder' | 'spine' | 'cervical' | 'elbow';
  targetField: string | null; // null = 모듈 필드 미기입(candidate)
  unit: z.infer<typeof FeatureUnitSchema> | null;
  mode: FeatureMappingMode;
};

export const VIDEO_FEATURE_TARGETS: Record<
  z.infer<typeof FeatureKeySchema>,
  FeatureMappingTarget
> = {
  // 무릎 (knee.jobExtras[sharedJobId]) — squatting은 문자열 저장, 단위 분/일
  squatDuration: { moduleId: 'knee', targetField: 'squatting', unit: 'minutes_per_day', mode: 'auto' },
  suspectedKneeTwist: { moduleId: 'knee', targetField: null, unit: null, mode: 'candidate' },
  // 어깨 (shoulder.jobExtras[sharedJobId]) — *_Hours는 dailyHours, 문자열 저장
  overheadHours: { moduleId: 'shoulder', targetField: 'overheadHours', unit: 'hours_per_day', mode: 'auto' },
  repetitiveMediumHours: { moduleId: 'shoulder', targetField: 'repetitiveMediumHours', unit: 'hours_per_day', mode: 'auto' },
  repetitiveFastHours: { moduleId: 'shoulder', targetField: 'repetitiveFastHours', unit: 'hours_per_day', mode: 'auto' },
  vibrationToolUseDurationCandidate: { moduleId: 'shoulder', targetField: null, unit: 'hours_per_day', mode: 'candidate' },
  // 6.0-11 어깨·팔꿈치 반복빈도(cycles/min) — 영상이 직접 재는 intrinsic 값, 모듈 자동입력 없이 candidate.
  // 팔꿈치 모듈은 videoMappingConfig가 없어 flat "참고 후보"로 표시(elbow targetField=null).
  shoulderRepetitionRate: { moduleId: 'shoulder', targetField: null, unit: 'cycles_per_minute', mode: 'candidate' },
  elbowRepetitionRate: { moduleId: 'elbow', targetField: null, unit: 'cycles_per_minute', mode: 'candidate' },
  // 척추 MDDM (spine.tasks[*], 공정 1개 = task 1개) — frequency/timeValue는 숫자 저장
  cyclesPerDay: { moduleId: 'spine', targetField: 'frequency', unit: 'cycles_per_day', mode: 'auto-review' },
  cycleSeconds: { moduleId: 'spine', targetField: 'timeValue', unit: 'seconds_per_cycle', mode: 'auto-review' },
  trunkPostureG: { moduleId: 'spine', targetField: null, unit: null, mode: 'candidate' },
  // 척추 45°↑ 굴곡 시간(작업별 관찰값). candidate라 spine 필드 미기입; value는 비율(posture_ratio),
  // 분/일 표시는 클라가 ratio×activeMinutesPerDay로 계산(unit은 그 표시 단위 — UI는 raw value+unit 미출력).
  trunkFlexionOver45Duration: { moduleId: 'spine', targetField: null, unit: 'minutes_per_day', mode: 'candidate' },
  // 경추 (cervical.tasks[*], 공정 1개 = task 1개) — neck_* 문자열 저장
  neckFlexionOver20HoursPerDay: { moduleId: 'cervical', targetField: 'neck_nonneutral_hours_per_day', unit: 'hours_per_day', mode: 'auto' },
  neckForcedFlexion: { moduleId: 'cervical', targetField: 'forced_neck_posture', unit: null, mode: 'auto-review' },
  neckCombinedFlexRot: { moduleId: 'cervical', targetField: null, unit: null, mode: 'candidate' },
};

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------
export type FeatureUnit = z.infer<typeof FeatureUnitSchema>;
export type FeatureKey = z.infer<typeof FeatureKeySchema>;
export type FeatureBase = z.infer<typeof FeatureBaseSchema>;
export type NumericFeatureValue = z.infer<typeof NumericFeatureValueSchema>;
export type BooleanFeatureValue = z.infer<typeof BooleanFeatureValueSchema>;
export type CategoricalFeatureValue = z.infer<typeof CategoricalFeatureValueSchema>;
export type CandidateFeatureValue = z.infer<typeof CandidateFeatureValueSchema>;
export type VideoFeatureValue = z.infer<typeof VideoFeatureValueSchema>;
export type VideoFeatureMap = Partial<Record<FeatureKey, VideoFeatureValue>>;
export type AnalysisProfile = z.infer<typeof AnalysisProfileSchema>;
export type AnalysisRequest = z.infer<typeof AnalysisRequestSchema>;
export type VideoJobStatus = z.infer<typeof VideoJobStatusSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type AppliedInput = z.infer<typeof AppliedInputSchema>;
export type CandidateFeatureEntry = z.infer<typeof CandidateFeatureEntrySchema>;
export type VideoProcess = z.infer<typeof VideoProcessSchema>;
export type VideoClip = z.infer<typeof VideoClipSchema>;
export type SampleDetectPerson = z.infer<typeof SampleDetectPersonSchema>;
export type SampleDetectResult = z.infer<typeof SampleDetectResultSchema>;
export type ProcessFeatures = z.infer<typeof ProcessFeaturesSchema>;
export type JobFeatures = z.infer<typeof JobFeaturesSchema>;
export type RetentionMode = z.infer<typeof RetentionModeSchema>;
export type VideoAnalysisData = z.infer<typeof VideoAnalysisDataSchema>;
