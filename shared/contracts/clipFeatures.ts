import { z } from 'zod';
import { FeatureKeySchema, FeatureUnitSchema } from './videoAnalysis';

// ---------------------------------------------------------------------------
// clipFeatures 계약 (6.0-6a, PR C). feature 계산기(services/pose-inference/feature_calc.py)가
// keypoints.json에서 산출하는 **intrinsic 클립 feature** — 영상이 실제 측정 가능한 것만 담는다.
//   posture_ratio: 클립 시간 중 해당 자세 비율(0~1)
//   peak_angle/mean_angle: 각도(degrees)
//   cycles_per_minute / seconds_per_cycle: 반복(후속)
// per-day 환산(hours_per_day·minutes_per_day·cyclesPerDay)은 공정 활동시간(수기)과 결합하는
// 별도 단계(PR D1) — 여기서는 환산하지 않는다(PRD §8.10.2-1).
// canonical: services/pose-inference/schema/clip_features.schema.json (zod 미러).
// ---------------------------------------------------------------------------

export const ClipFeatureMetricSchema = z.enum([
  'posture_ratio',
  'peak_angle',
  'mean_angle',
  'cycles_per_minute',
  'seconds_per_cycle',
]);

export const ClipFeatureSegmentSchema = z.object({
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
}).strict().refine((s) => s.endMs >= s.startMs, { message: 'endMs must be >= startMs', path: ['endMs'] });

const NumericClipFeature = z.object({
  kind: z.literal('numeric'),
  metric: ClipFeatureMetricSchema,
  value: z.number(),
  unit: FeatureUnitSchema,
  confidence: z.number().min(0).max(1),
  segments: z.array(ClipFeatureSegmentSchema).default([]),
  warnings: z.array(z.string()).default([]),
}).strict();

const BooleanClipFeature = z.object({
  kind: z.literal('boolean'),
  value: z.boolean(),
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()).default([]),
}).strict();

const CategoricalClipFeature = z.object({
  kind: z.literal('categorical'),
  value: z.string(),
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()).default([]),
}).strict();

export const ClipFeatureValueSchema = z.discriminatedUnion('kind', [
  NumericClipFeature,
  BooleanClipFeature,
  CategoricalClipFeature,
]);

export const ClipFeatureMapSchema = z.record(FeatureKeySchema, ClipFeatureValueSchema);

// 대상자 트래킹 요약(PR D2a, §8.7). 트랙이 있을 때만 산출 — PR C(트래킹 전) 출력 하위호환 위해 optional.
export const ClipTrackingSchema = z.object({
  targetTrackId: z.string().nullable(),
  presenceRatio: z.number().min(0).max(1),  // 대상 등장 프레임 비율(track-loss 표면화)
  trackCount: z.number().int().nonnegative(),
}).strict();

export const ClipFeatureSetSchema = z.object({
  schemaVersion: z.literal(1),
  featureConfigVersion: z.string().min(1),  // feature_config.json version — 재현성
  clipRef: z.string().min(1),
  clipDurationMs: z.number().nonnegative(),
  analyzedFrames: z.number().int().nonnegative(),
  features: ClipFeatureMapSchema,
  tracking: ClipTrackingSchema.optional(),
}).strict().superRefine((doc, ctx) => {
  // posture_ratio는 비율(0~1) — 계약 수준에서 강제(후속 per-day 환산 이상값 방지).
  for (const [key, f] of Object.entries(doc.features)) {
    if (f.kind === 'numeric' && f.metric === 'posture_ratio' && (f.value < 0 || f.value > 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['features', key, 'value'],
        message: `posture_ratio must be within 0..1, got ${f.value}`,
      });
    }
  }
});

export type ClipFeatureMetric = z.infer<typeof ClipFeatureMetricSchema>;
export type ClipFeatureSegment = z.infer<typeof ClipFeatureSegmentSchema>;
export type ClipFeatureValue = z.infer<typeof ClipFeatureValueSchema>;
export type ClipFeatureMap = z.infer<typeof ClipFeatureMapSchema>;
export type ClipTracking = z.infer<typeof ClipTrackingSchema>;
export type ClipFeatureSet = z.infer<typeof ClipFeatureSetSchema>;
