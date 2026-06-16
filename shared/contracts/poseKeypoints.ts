import { z } from 'zod';

// ---------------------------------------------------------------------------
// 포즈 추정 keypoints 시계열 계약 (6.0-5, PR B).
// canonical source of truth = services/pose-inference/schema/keypoints.schema.json.
// 이 zod는 그 JSON Schema를 미러링하며, Python 추론 산출(keypoints.json)이 계약과
// 어긋나지 않는지 검증하는 데 쓴다(PR C/D의 입력 계약). drift 방지:
//   - Node: 이 스키마로 fixture/산출물 parse (CI)
//   - Python: schema/keypoints.schema.json으로 산출물 검증(validate_keypoints.py, opt-in)
// ---------------------------------------------------------------------------

export const KeypointConventionSchema = z.enum(['coco17', 'wholebody133']);
export const CoordinateSpaceSchema = z.enum(['pixel', 'normalized']);

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

const KEYPOINT_COUNT = { coco17: 17, wholebody133: 133 };

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
  model: z.object({
    detector: z.string().min(1),
    pose: z.string().min(1),
    inputSize: z.array(z.number().int()).length(2),
    modelName: z.string().min(1),
    modelVersion: z.string().min(1),
    preprocessConfigHash: z.string().min(1),
  }).strict(),
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

export type KeypointConvention = z.infer<typeof KeypointConventionSchema>;
export type CoordinateSpace = z.infer<typeof CoordinateSpaceSchema>;
export type Keypoint = z.infer<typeof KeypointSchema>;
export type PersonPose = z.infer<typeof PersonPoseSchema>;
export type FramePose = z.infer<typeof FramePoseSchema>;
export type PoseKeypoints = z.infer<typeof PoseKeypointsSchema>;
