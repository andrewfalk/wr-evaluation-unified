import { z } from 'zod';

// ---------------------------------------------------------------------------
// 포즈 추정 keypoints 시계열 계약 (6.0-5, PR B).
// canonical source of truth = services/pose-inference/schema/keypoints.schema.json.
// 이 zod는 그 JSON Schema를 미러링하며, Python 추론 산출(keypoints.json)이 계약과
// 어긋나지 않는지 검증하는 데 쓴다(PR C/D의 입력 계약). drift 방지:
//   - Node: 이 스키마로 fixture/산출물 parse (CI)
//   - Python: schema/keypoints.schema.json으로 산출물 검증(validate_keypoints.py, opt-in)
// ---------------------------------------------------------------------------

// wholebody133-trimmed(59점) = body17 + hand42 — face68·feet6은 추출 후 drop(privacy + 손목분석 무용, 6.0-10).
export const KeypointConventionSchema = z.enum(['coco17', 'wholebody133', 'wholebody133-trimmed']);
export const CoordinateSpaceSchema = z.enum(['pixel', 'normalized']);

// 영상 품질 메타 (6.0-6b, PR D3a, §8.8). infer_clip.py가 프레임 읽기 단계에서 산출.
//   blurMetric: Laplacian variance 분포 요약(raw metric — threshold 무관, 항상 산출)
//   dropRatio: 실제 sampledFps/timestamp 간격 기준 frame-drop 비율
//   blurThreshold/blurRatio/usableFrameRatio: threshold 파생값 — threshold 설정 시에만(기본 비활성).
//     usableFrameRatio는 정보용(B2 전까지 overall·게이팅에 미입력).
export const BlurMetricSchema = z.object({
  mean: z.number(),
  p10: z.number(),
  median: z.number(),
}).strict();

export const FrameQualitySchema = z.object({
  blurMetric: BlurMetricSchema,
  dropRatio: z.number().min(0).max(1),
  sampledFps: z.number().positive(),
  blurThreshold: z.number().optional(),
  blurRatio: z.number().min(0).max(1).optional(),
  usableFrameRatio: z.number().min(0).max(1).optional(),
}).strict();

// [x, y, score] — score(3번째)는 confidence 0~1.
export const KeypointSchema = z.tuple([z.number(), z.number(), z.number().min(0).max(1)]);

// .strict()로 extra field 거부 — canonical JSON Schema의 additionalProperties:false와 정합.
export const PersonPoseSchema = z.object({
  trackId: z.string().nullable(),                       // PoC(PR B)는 null, tracking은 PR D2
  bbox: z.array(z.number()).length(4).nullable(),       // [x, y, w, h] | null
  score: z.number().min(0).max(1),                      // 평균 confidence
  keypoints: z.array(KeypointSchema),
}).strict();

export const FramePoseSchema = z.object({
  frameIndex: z.number().int().nonnegative(),
  timestampMs: z.number().nonnegative(),
  persons: z.array(PersonPoseSchema),
}).strict();

// 가중치 .onnx sha256(recipe 재현성, 6.0-9). 미반입(PoC/dev)이면 null, 반입 시 소문자 64-hex.
export const Sha256OrNullSchema = z.union([z.null(), z.string().regex(/^[0-9a-f]{64}$/)]);

// model 메타 — recipe(§8.11)의 모델 component source. verified면 두 sha 필수(거짓 verified 방지).
export const PoseModelSchema = z.object({
  detector: z.string().min(1),
  pose: z.string().min(1),
  inputSize: z.array(z.number().int()).length(2),
  modelName: z.string().min(1),
  modelVersion: z.string().min(1),
  detectorSha256: Sha256OrNullSchema,
  poseSha256: Sha256OrNullSchema,
  weightsComplete: z.boolean(),
  preprocessConfigHash: z.string().min(1),
  // 추론 디바이스(6.0-12). 신규 artifact는 항상 포함, 구 artifact 하위호환 위해 optional.
  // (JSON Schema keypoints.schema.json의 model 필드와 미러 — 둘 다 갱신해야 overlay safeParse 통과.)
  requestedDevice: z.enum(['auto', 'cpu', 'cuda']).optional(),
  deviceUsed: z.enum(['cpu', 'cuda']).optional(),
  deviceFallback: z.boolean().optional(),
  fallbackReason: z.string().nullable().optional(),
}).strict().superRefine((m, ctx) => {
  // weightsComplete=true(verified)면 두 가중치 sha가 모두 64-hex여야 한다(null 금지).
  if (m.weightsComplete) {
    if (m.detectorSha256 === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['detectorSha256'], message: 'weightsComplete=true requires non-null detectorSha256' });
    }
    if (m.poseSha256 === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['poseSha256'], message: 'weightsComplete=true requires non-null poseSha256' });
    }
  }
});

// 저장 keypoint 개수(=superRefine 강제값). wholebody133-trimmed는 body17(17)+hand42(42)=59.
export const KEYPOINT_COUNT = { coco17: 17, wholebody133: 133, 'wholebody133-trimmed': 59 };

export const PoseKeypointsSchema = z.object({
  schemaVersion: z.literal(1),
  keypointConvention: KeypointConventionSchema,
  coordinateSpace: CoordinateSpaceSchema,
  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),
  requestedFps: z.number().positive(),
  sampledFps: z.number().positive(),  // 실제 샘플링 fps(= originalFps / step)
  source: z.object({
    clipRef: z.string().min(1),
    originalFps: z.number().positive(),
    totalFrames: z.number().int().nonnegative(),
  }).strict(),
  model: PoseModelSchema,
  quality: FrameQualitySchema.optional(),  // PR D3a — PR B/C/D2 산출 하위호환 위해 optional
  frames: z.array(FramePoseSchema),
}).strict().superRefine((doc, ctx) => {
  // convention에 맞는 keypoint 개수 강제(coco17=17) — 잘못된 모델/후처리 조기 검출.
  const expected = KEYPOINT_COUNT[doc.keypointConvention];
  if (!expected) return;
  doc.frames.forEach((f, fi) => {
    f.persons.forEach((p, pi) => {
      if (p.keypoints.length !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['frames', fi, 'persons', pi, 'keypoints'],
          message: `expected ${expected} keypoints for ${doc.keypointConvention}, got ${p.keypoints.length}`,
        });
      }
    });
  });
});

export type BlurMetric = z.infer<typeof BlurMetricSchema>;
export type FrameQuality = z.infer<typeof FrameQualitySchema>;
export type KeypointConvention = z.infer<typeof KeypointConventionSchema>;
export type CoordinateSpace = z.infer<typeof CoordinateSpaceSchema>;
export type Keypoint = z.infer<typeof KeypointSchema>;
export type PersonPose = z.infer<typeof PersonPoseSchema>;
export type FramePose = z.infer<typeof FramePoseSchema>;
export type PoseModel = z.infer<typeof PoseModelSchema>;
export type PoseKeypoints = z.infer<typeof PoseKeypointsSchema>;
