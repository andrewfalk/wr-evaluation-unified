// ---------------------------------------------------------------------------
// 분석 recipe(provenance analysisBundleVersion) 버전 상수·조립 헬퍼 (6.0-9, §8.11).
//
// 단일 source of truth — 클라(per-day 환산·viewpoint 융합)와 서버(apply 검증 게이트)가
// 같은 상수·같은 조립 규칙을 쓰도록 shared/contracts에 둔다. 서버가 클라가 보낸 recipe의
// mapping/viewpoint 버전을 "아는 값"과 대조하려면 이 상수가 서버에서도 import 가능해야 한다
// (구버전/오염 클라가 잘못된 버전을 보내면 거부 — 형식만 확인하면 약함).
//
// 클라 측 src/core/services/videoPerDayConversion.js·videoViewpointConfig.js는 이 값을
// re-export 한다(단일 정의 → drift 불가).
// ---------------------------------------------------------------------------
import { z } from 'zod';

// per-day 환산 규칙 버전(featureConfig.json version과 함께 recipe를 이룬다).
// pday-1.1.0: 6.0-10 손목 candidate 3종(wristRepetitionRate·wristFlexion/DeviationPeakAngle) VIDEO_FEATURE_TARGETS 추가.
export const VIDEO_MAPPING_CONFIG_VERSION = 'pday-1.1.0';

// 시점 융합 정책 버전(preferredViewpoint·viewpoint 성분이 다중 시점 산출 선택에 영향 → 재현성).
export const VIDEO_VIEWPOINT_CONFIG_VERSION = 'vvc-0.1.0';

// recipe 요약 문자열(클라-기원 component: featureConfig + mapping + viewpoint) — 하위호환 유지.
// 서버-기원 component(model weight sha·preprocessConfigHash·commit)는 analysis_recipe 구조에 별도.
export function buildRecipeVersion(featureConfigVersion: string): string {
  return `fc:${featureConfigVersion}+map:${VIDEO_MAPPING_CONFIG_VERSION}+vp:${VIDEO_VIEWPOINT_CONFIG_VERSION}`;
}

// ---------------------------------------------------------------------------
// 구조적 recipe(§8.11) — 서버 job analysis_recipe의 형태 + appliedInputs[].recipe(apply 검증 대상).
//   서버-기원(저장 job recipe와 대조): modelVersion·detectorSha256·poseSha256·preprocessConfigHash·
//     featureConfigVersion·codeCommit·status
//   클라-기원(서버 상수와 대조 — 구버전/오염 클라 차단): mappingConfigVersion·viewpointConfigVersion
// ---------------------------------------------------------------------------

export const RecipeStatusSchema = z.enum(['verified', 'unverified']);

// 가중치 sha는 미반입이면 null, 반입 시 소문자 64-hex(poseKeypoints의 model sha와 동일 규칙).
const RecipeShaSchema = z.union([z.null(), z.string().regex(/^[0-9a-f]{64}$/)]);

export const AnalysisRecipeSchema = z
  .object({
    status: RecipeStatusSchema,
    modelVersion: z.string(),
    detectorSha256: RecipeShaSchema,
    poseSha256: RecipeShaSchema,
    preprocessConfigHash: z.string().nullable(),
    featureConfigVersion: z.string(),
    mappingConfigVersion: z.string(),
    viewpointConfigVersion: z.string(),
    codeCommit: z.string(),
  })
  .strict()
  .superRefine((r, ctx) => {
    // verified면 두 가중치 sha가 모두 non-null(64-hex)이어야 한다 — 거짓 verified 차단.
    if (r.status === 'verified') {
      if (r.detectorSha256 === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['detectorSha256'], message: "status 'verified' requires non-null detectorSha256" });
      }
      if (r.poseSha256 === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['poseSha256'], message: "status 'verified' requires non-null poseSha256" });
      }
    }
  });

export type RecipeStatus = z.infer<typeof RecipeStatusSchema>;
export type AnalysisRecipe = z.infer<typeof AnalysisRecipeSchema>;

// recipe의 서버-기원 sub-field(저장 job recipe와 field 대조하는 대상). 클라-기원(map/vp)은 제외.
export const RECIPE_SERVER_FIELDS = [
  'status',
  'modelVersion',
  'detectorSha256',
  'poseSha256',
  'preprocessConfigHash',
  'featureConfigVersion',
  'codeCommit',
] as const;

const sha8 = (s: string | null): string => (s ? s.slice(0, 8) : 'none');

// recipe → 결정적 요약 문자열(appliedInputs.analysisBundleVersion). 사람이 읽을 수 있는 단일 식별자.
export function buildAnalysisBundleVersion(r: AnalysisRecipe): string {
  return [
    `fc:${r.featureConfigVersion}`,
    `map:${r.mappingConfigVersion}`,
    `vp:${r.viewpointConfigVersion}`,
    `mdl:${r.modelVersion}`,
    `w:${sha8(r.detectorSha256)}/${sha8(r.poseSha256)}`,
    `c:${(r.codeCommit || 'unknown').slice(0, 8)}`,
    `s:${r.status}`,
  ].join('+');
}

// 다중 source job recipe 결합(§8.11). 동일하면 단일 bundle, 다르면 정렬 결합(결정적 — crypto 불요).
export function aggregateBundleVersions(bundles: string[]): string {
  const distinct = [...new Set(bundles)].sort();
  if (distinct.length === 0) return '';
  if (distinct.length === 1) return distinct[0];
  return `agg(${distinct.join('|')})`;
}

function serverFieldsKey(r: AnalysisRecipe): string {
  return RECIPE_SERVER_FIELDS.map((f) => String(r[f])).join('|');
}

// 클라가 source job들의 서버 recipe로 appliedInputs[].recipe·analysisBundleVersion을 만든다(§8.11, 6.0-9).
// map/vp는 **클라 번들 상수로 덮어쓴다** — 구버전 클라면 서버 상수와 달라 서버 검증 게이트가 거부(stale 탐지).
// 서버-기원 fields가 단일/동일이면 구조적 recipe, 다르면 null(서버는 aggregate 문자열로만 대조).
export function buildAppliedRecipe(
  sourceRecipes: (AnalysisRecipe | null | undefined)[],
): { recipe: AnalysisRecipe | null; analysisBundleVersion: string } {
  const valid = sourceRecipes.filter((r): r is AnalysisRecipe => !!r);
  if (valid.length === 0) return { recipe: null, analysisBundleVersion: '' };
  const overlaid = valid.map((r) => ({
    ...r,
    mappingConfigVersion: VIDEO_MAPPING_CONFIG_VERSION,
    viewpointConfigVersion: VIDEO_VIEWPOINT_CONFIG_VERSION,
  }));
  const distinct = [...new Map(overlaid.map((r) => [serverFieldsKey(r), r])).values()];
  if (distinct.length === 1) {
    return { recipe: distinct[0], analysisBundleVersion: buildAnalysisBundleVersion(distinct[0]) };
  }
  return { recipe: null, analysisBundleVersion: aggregateBundleVersions(distinct.map(buildAnalysisBundleVersion)) };
}
