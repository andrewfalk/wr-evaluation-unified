// Video analysis request schemas (clip, target, job, apply).
// Split out of routes/videoAnalysis.ts (S5 P1-30); handler bodies unchanged.
import { z } from 'zod';
import { CompletionReportFields, requireCompletionVersions } from '../../completionTracking';

export const CreateClipBody = z.object({
  patientId: z.string().uuid(),
  // job-scope 집계는 특정 공정이 없어 null을 보낸다(컬럼도 nullable). null/undefined 모두 허용.
  processId: z.string().nullable().optional(),
  // clip 출처 명시(M3-7a): analysis_upload(실 업로드 대기) | apply_shell(추론 없는 적용 셸) | fixture(dev).
  purpose: z.enum(['analysis_upload', 'apply_shell', 'fixture']),
  // dev-only fixture 입력(fixtureMode일 때만). 여기서 resolve→upload_path 저장(sample-detect가 그 전 단계, PR D2b).
  fixtureClipName: z.string().optional(),
}).superRefine((v, ctx) => {
  // purpose↔fixtureClipName 조합 강제(잘못된 조합 차단).
  if (v.purpose === 'fixture' && !v.fixtureClipName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fixture purpose requires fixtureClipName', path: ['fixtureClipName'] });
  }
  if (v.purpose !== 'fixture' && v.fixtureClipName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fixtureClipName is only allowed with fixture purpose', path: ['fixtureClipName'] });
  }
});
export const SelectTargetBody = z.object({ targetPersonId: z.string().min(1) });
export const CreateJobBody = z.object({
  clipId: z.string().uuid(),
  // job-scope 집계 제안은 process_id 없이 null로 들어온다(여러 공정 집계, 추적은 appliedInputs.processIds).
  processId: z.string().nullable().optional(),
  analysisProfile: z.string().nullable().optional(),
  requestedFeatures: z.array(z.string()).optional(),
  // fixtureClipName은 createClip으로 이관(PR D2b) — 큐 결정은 clip.upload_path로 일원화.
});
// apply: 클라가 applyFeatureToModule로 계산한 환자 data + 멱등 해시.
export const ApplyBody = z.object({
  data: z.object({}).passthrough(),
  appliedInputsHash: z.string().min(1),
  appliedInputsCount: z.number().int().nonnegative().optional(),
  // 이 적용이 소비한 원본 분석 job id(추론 출처 추적·consumed 전이). 셸 적용 job과 구분(PR D1).
  sourceAnalysisJobIds: z.array(z.string().uuid()).default([]),
  // PR0-A: apply도 patient_records.payload를 직접 갱신하는 경로라 patients.ts의 PATCH/POST와
  // 동일한 완료 보고 계약을 따른다 — 안 그러면 영상분석 적용으로 완료된 환자가 'draft'로 남는다.
  ...CompletionReportFields,
}).superRefine(requireCompletionVersions);
