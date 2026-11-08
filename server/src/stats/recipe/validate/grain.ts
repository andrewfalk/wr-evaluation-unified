// Recipe checks: supported grain (§A-1) and variable/grain compatibility.
// Split out of stats/recipe/validation.ts (S6 P1-35); check bodies unchanged.
import { isGrainCompatible } from '@wr/analytics-core';
import type { StatsAnalysisRecipe } from '@wr/contracts';
import { SUPPORTED_GRAINS } from '../grains';
import type { RecipeCheckInput, RecipeValidationResult } from '.';

/** An unsupported grain ends validation at once (later checks assume a supported grain). */
export function unsupportedGrainResult(recipe: StatsAnalysisRecipe): RecipeValidationResult | null {
  // §A-1 grain — 미지원 grain이면 조기 반환(이후 검증은 지원 grain을 전제하므로 의미가 없다).
  if (!SUPPORTED_GRAINS.has(recipe.grain)) {
    return {
      valid: false,
      errors: [{
        code: 'GRAIN_NOT_YET_SUPPORTED',
        path: 'grain',
        message: `grain "${recipe.grain}"은 아직 지원하지 않는다 — 지원: ${Array.from(SUPPORTED_GRAINS).join(', ')}`,
      }],
    };
  }
  return null;
}

export function checkGrainCompatibility(input: RecipeCheckInput): void {
  const { recipe, catalogByKey, neededKeys, errors } = input;
  // VARIABLE_GRAIN_MISMATCH: 분석 변수뿐 아니라 필터 키도 대상이다(neededKeys는
  // variableKeys ∪ filters[].key 합집합, §A-2와 동일 대상). 원칙은 "한 recipe는 한
  // grain만 다룬다"지만, case의 브로드캐스트 안전 변수는 job/disease에도 그대로 복제
  // 가능하므로 isGrainCompatible(analytics-core/common.ts, 클라이언트 CatalogPanel.jsx/
  // RecipePanel.jsx와 동일 규칙 공유)로 판정한다 — 세부 grain(job/disease) 변수를
  // case에 쓰는 역방향, 그리고 job↔disease는 여전히 거부된다.
  for (const key of neededKeys) {
    const variable = catalogByKey.get(key);
    if (variable && !isGrainCompatible(variable, recipe.grain)) {
      errors.push({
        code: 'VARIABLE_GRAIN_MISMATCH',
        path: key,
        message: `${key}는 grain "${variable.grain}"인데 recipe.grain은 "${recipe.grain}"이다`,
      });
    }
  }
}
