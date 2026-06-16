import { z } from 'zod';
import { FeatureKeySchema, FeatureUnitSchema } from './videoAnalysis';

// ---------------------------------------------------------------------------
// gold-standard 수기 annotation 계약 (§8.9, 6.0-3.5).
// 전문의·평가자가 영상에서 판정한 ground truth. 영상 추출값(VideoFeatureMap)과
// 같은 FeatureKey 공간을 쓰되 confidence는 없다(사람 판정 = 정답 기준).
// 실제 검증셋 구축·임계값 결정은 6.0-B2(M3). 여기서는 포맷·계약만 고정한다.
// ---------------------------------------------------------------------------

// 층화(§8.9) — 검증셋이 실제 촬영 조건(거리·각도·가림 등)을 반영하도록.
export const AnnotationStratificationSchema = z.object({
  viewpoint: z.enum(['sagittal', 'frontal', 'other']).optional(),
  occlusionLevel: z.enum(['none', 'partial', 'heavy']).optional(),
  multiplePeople: z.boolean().optional(),
  clothing: z.enum(['light', 'heavy', 'ppe']).optional(),
  cameraHeight: z.enum(['low', 'eye', 'high']).optional(),
  workType: z.string().optional(),
});

// gold 값 — 사람 판정. VideoFeatureValue와 달리 confidence/autoSuggest 없음.
const NumericAnnotationValue = z.object({ kind: z.literal('numeric'), value: z.number(), unit: FeatureUnitSchema });
const BooleanAnnotationValue = z.object({ kind: z.literal('boolean'), value: z.boolean() });
const CategoricalAnnotationValue = z.object({ kind: z.literal('categorical'), value: z.string() });
export const AnnotationValueSchema = z.discriminatedUnion('kind', [
  NumericAnnotationValue,
  BooleanAnnotationValue,
  CategoricalAnnotationValue,
]);

export const AnnotationFeatureMapSchema = z.record(FeatureKeySchema, AnnotationValueSchema);

// segments/events — feature별 최종값뿐 아니라 "어느 구간에서"를 기록(Codex).
// duration/repetition 오차가 어느 시간대에서 났는지 디버깅 추적용.
export const AnnotationSegmentSchema = z.object({
  featureKey: FeatureKeySchema,
  kind: z.enum(['posture', 'repetition_cycle', 'event']).default('event'),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  note: z.string().optional(),
}).refine((s) => s.endMs >= s.startMs, { message: 'endMs must be >= startMs', path: ['endMs'] });

export const GoldStandardAnnotationSchema = z.object({
  id: z.string().min(1),
  videoRef: z.string().min(1),  // 비식별 참조 — 파일 경로/PHI 금지(§8.13)
  annotator: z.string().min(1),
  annotatedAt: z.string().datetime(), // 추적성 — ISO 8601 datetime 필수
  stratification: AnnotationStratificationSchema.default({}),
  features: AnnotationFeatureMapSchema,
  segments: z.array(AnnotationSegmentSchema).default([]),
  notes: z.string().optional(),
});

export const AnnotationSetSchema = z.object({
  version: z.literal(1),
  annotations: z.array(GoldStandardAnnotationSchema),
});

export type AnnotationStratification = z.infer<typeof AnnotationStratificationSchema>;
export type AnnotationValue = z.infer<typeof AnnotationValueSchema>;
export type AnnotationFeatureMap = z.infer<typeof AnnotationFeatureMapSchema>;
export type AnnotationSegment = z.infer<typeof AnnotationSegmentSchema>;
export type GoldStandardAnnotation = z.infer<typeof GoldStandardAnnotationSchema>;
export type AnnotationSet = z.infer<typeof AnnotationSetSchema>;
