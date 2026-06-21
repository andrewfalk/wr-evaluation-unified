// ---------------------------------------------------------------------------
// apply provenance recipe 검증 게이트 (6.0-9, §8.11) — 순수 함수(DB 미접근, 단위테스트 가능).
//
// 신뢰 경계: 환자 기록에 들어가는 appliedInputs[].recipe를 클라가 보낸 대로 믿지 않는다.
// 서버 저장 job recipe(source of truth)·서버 상수와 대조해 통과한 것만 영속한다(payload 무수정).
//   ① suffix diff — 이번 apply에서 새로 추가된 entry만 검증(기존 이력 불변):
//        newLen === oldLen + appliedInputsCount, prefix(canonical) 변조 시 거부.
//   ② exact-set — union(new entries[].analysisJobIds) === unique(sourceAnalysisJobIds).
//   ③ 서버-기원 sub-field(onnxSha256·modelVersion·preprocessConfigHash·featureConfig·commit·status)
//        를 저장 job recipe와 대조. 다중 source가 상이하면 aggregate bundle 문자열로 대조.
//   ④ 클라-기원(mapping/viewpoint 버전)은 서버 상수와 대조 — 구버전/오염 클라 차단.
//   ⑤ unverified recipe는 fail-closed(allowUnverified env에서만 통과).
// ---------------------------------------------------------------------------
import {
  VIDEO_MAPPING_CONFIG_VERSION,
  VIDEO_VIEWPOINT_CONFIG_VERSION,
  AnalysisRecipeSchema,
  buildAnalysisBundleVersion,
  aggregateBundleVersions,
  RECIPE_SERVER_FIELDS,
  type AnalysisRecipe,
} from '@wr/contracts';

export interface RecipeValidationFailure {
  code: string;
  error: string;
}

interface AppliedInputLike {
  analysisJobIds?: string[];
  analysisBundleVersion?: string;
  recipe?: unknown;
}

// 키 정렬 canonical 직렬화 — prefix 불변 비교가 키 순서·undefined에 흔들리지 않게.
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        if (obj[k] !== undefined) acc[k] = canonicalize(obj[k]);
        return acc;
      }, {});
  }
  return v;
}
export function canonicalJson(v: unknown): string {
  return JSON.stringify(canonicalize(v));
}

function serverFieldsKey(r: AnalysisRecipe): string {
  return RECIPE_SERVER_FIELDS.map((f) => String(r[f])).join('|');
}

/**
 * 새로 추가된 appliedInputs의 recipe를 서버 저장 recipe·상수와 대조한다.
 * @returns 실패면 { code, error }, 통과면 null.
 */
export function validateAppliedRecipes(params: {
  oldAppliedInputs: unknown[];
  newAppliedInputs: unknown[];
  appliedInputsCount: number | undefined;
  sourceAnalysisJobIds: string[];
  sourceRecipes: Map<string, AnalysisRecipe | null>;
  allowUnverified: boolean;
}): RecipeValidationFailure | null {
  const { oldAppliedInputs, newAppliedInputs, appliedInputsCount, sourceAnalysisJobIds, sourceRecipes, allowUnverified } = params;
  const oldLen = oldAppliedInputs.length;
  const newLen = newAppliedInputs.length;

  // 이력은 늘기만 한다(append-only). 줄어들면 과거 provenance 삭제 시도 → 거부.
  if (newLen < oldLen) {
    return { code: 'APPLIED_INPUTS_HISTORY_SHRUNK', error: `appliedInputs cannot shrink (${oldLen} → ${newLen})` };
  }
  // ① count 일관성(제공된 경우).
  if (appliedInputsCount !== undefined && newLen !== oldLen + appliedInputsCount) {
    return { code: 'APPLIED_INPUTS_COUNT_MISMATCH', error: `expected ${oldLen}+${appliedInputsCount} appliedInputs, got ${newLen}` };
  }
  // ① prefix 불변(기존 이력 변조 금지).
  for (let i = 0; i < oldLen; i++) {
    if (canonicalJson(newAppliedInputs[i]) !== canonicalJson(oldAppliedInputs[i])) {
      return { code: 'APPLIED_INPUTS_PREFIX_MODIFIED', error: `existing appliedInputs[${i}] must not change` };
    }
  }

  const suffix = newAppliedInputs.slice(oldLen) as AppliedInputLike[];

  // ② exact-set: 새 entry들의 analysisJobIds 합집합 === sourceAnalysisJobIds 유니크.
  const unionIds = new Set<string>();
  for (const e of suffix) for (const id of e.analysisJobIds ?? []) unionIds.add(id);
  const uniqueSrc = new Set(sourceAnalysisJobIds);
  if (unionIds.size !== uniqueSrc.size || [...unionIds].some((id) => !uniqueSrc.has(id))) {
    return { code: 'SOURCE_JOBS_MISMATCH', error: 'union of new appliedInputs analysisJobIds must equal sourceAnalysisJobIds' };
  }

  // ③④⑤ per-entry recipe 검증.
  for (let k = 0; k < suffix.length; k++) {
    const e = suffix[k];
    const idx = oldLen + k;
    const jobIds = e.analysisJobIds ?? [];
    // 운영: 모든 video appliedInput은 source 분석 job(provenance)을 가져야 한다. 없으면 거부 —
    // provenance 없는 새 entry가 recipe 검증을 우회해 저장되는 것을 막는다(M4 핵심 목적). dev/mock만 허용.
    if (jobIds.length === 0) {
      if (allowUnverified) continue;
      return { code: 'PROVENANCE_REQUIRED', error: `appliedInputs[${idx}] has no analysisJobIds (provenance required)` };
    }

    const recipes: AnalysisRecipe[] = [];
    let anyMissing = false;
    for (const id of jobIds) {
      const r = sourceRecipes.get(id) ?? null;
      if (r) recipes.push(r);
      else anyMissing = true;
    }
    // 실분석 recipe 누락 — dev/mock 허용 env에서만 통과(fail-closed).
    if (anyMissing) {
      if (allowUnverified) continue;
      return { code: 'RECIPE_MISSING', error: `source job recipe missing for appliedInputs[${idx}]` };
    }
    // ⑤ unverified가 하나라도 있으면 fail-closed.
    if (recipes.some((r) => r.status === 'unverified') && !allowUnverified) {
      return { code: 'RECIPE_UNVERIFIED', error: `recipe unverified for appliedInputs[${idx}]` };
    }

    // ③ 서버-기원 distinct source recipe. 다중 상이는 단일 구조로 표현 불가 → aggregate 문자열로 대조.
    const distinct = [...new Map(recipes.map((r) => [serverFieldsKey(r), r])).values()];
    if (distinct.length > 1) {
      const expected = aggregateBundleVersions(distinct.map((r) => buildAnalysisBundleVersion(r)));
      if (e.analysisBundleVersion !== expected) {
        return { code: 'RECIPE_AGGREGATE_MISMATCH', error: `appliedInputs[${idx}].analysisBundleVersion != aggregate of source recipes` };
      }
      continue;
    }

    // 단일 distinct → 구조적 recipe field 대조. entry.recipe 파싱(누락 — allowUnverified면 통과, 아니면 거부).
    const parsed = AnalysisRecipeSchema.safeParse(e.recipe);
    if (!parsed.success) {
      if (allowUnverified) continue;
      return { code: 'RECIPE_INVALID', error: `appliedInputs[${idx}].recipe is missing/invalid` };
    }
    const entryRecipe = parsed.data;
    // ④ 클라-기원: mapping/viewpoint 버전 == 서버 상수(구버전/오염 클라 차단).
    if (entryRecipe.mappingConfigVersion !== VIDEO_MAPPING_CONFIG_VERSION || entryRecipe.viewpointConfigVersion !== VIDEO_VIEWPOINT_CONFIG_VERSION) {
      return { code: 'RECIPE_CONFIG_VERSION_MISMATCH', error: `appliedInputs[${idx}].recipe mapping/viewpoint version mismatch (stale client?)` };
    }
    // ③ 서버-기원 field 대조.
    const src = distinct[0];
    for (const f of RECIPE_SERVER_FIELDS) {
      if (entryRecipe[f] !== src[f]) {
        return { code: 'RECIPE_FIELD_MISMATCH', error: `appliedInputs[${idx}].recipe.${f} != source job recipe` };
      }
    }
  }
  return null;
}
