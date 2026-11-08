// PR0-C §A — 레시피 검증. variableKeys ∪ filters[].key 전체를 대상으로 카탈로그 존재·
// 식별자 제한·분석 목적·필터 연산자/값 형태/타입 일치·formulaPolicy 유효성을 검사한다.
// zod(shared/contracts/stats.ts)는 구조만 검사하고, 여기서는 카탈로그 메타데이터를
// 참조해야 하는 동적 검사(변수 type별 허용 연산자·값 타입 등)를 한다.
// S6 P1-35 — the checks live in one file per area (grain, variables, filters, methods, regression,
// prediction); this file keeps the types and runs them in the original order, so the errors and
// their order are unchanged.
import { getIntegratedCatalog } from '../../catalog/catalog';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { StatsAnalysisRecipe } from '@wr/contracts';
import { unsupportedGrainResult, checkGrainCompatibility } from './grain';
import { checkKeysExist, checkVariableRules, checkFormulaPolicies } from './variables';
import { checkFilters } from './filters';
import { checkBivariate, checkCorrelationMatrix } from './methods';
import { checkRegression } from './regression';
import { checkPrediction } from './prediction';

export interface RecipeValidationError {
  code: string;
  path: string;
  message: string;
}

export type RecipeValidationResult =
  | { valid: true; catalogByKey: Map<string, AnalyticsVariableMetadata> }
  | { valid: false; errors: RecipeValidationError[] };

// What every check reads: the recipe and the catalog, plus the key lists built once below; checks
// only append to errors.
export interface RecipeCheckInput {
  recipe: StatsAnalysisRecipe;
  context: 'preview' | 'analyze';
  catalogByKey: Map<string, AnalyticsVariableMetadata>;
  neededKeys: string[];
  stratifyByKey: string | undefined;
  errors: RecipeValidationError[];
}

// PR3-A — context 인자 추가(계획서 §"파이프라인" — validateRecipe는 기존 책임을
// 전부 그대로 유지하고 이변량 구조/타입/paired 검사만 추가했다, 축소가 아니다).
// 'preview'는 관대하다 — requestedMethod 필수 여부·타입정합성·paired영구거부를
// 검사하지 않는다(방법을 아직 안 고른 최초 /preview도 정상 응답해야 함). 'analyze'
// 에서만 엄격하게 검사한다.
export function validateRecipe(
  recipe: StatsAnalysisRecipe,
  context: 'preview' | 'analyze',
): RecipeValidationResult {
  const errors: RecipeValidationError[] = [];

  const unsupported = unsupportedGrainResult(recipe);
  if (unsupported) return unsupported;

  const catalog = getIntegratedCatalog();
  const catalogByKey = new Map(catalog.map((v) => [v.key, v]));

  const filterKeys = recipe.filters.map((f) => f.key);
  // Table1 — stratifyByKey도 neededKeys에 포함시킨다. 이 리스트가 아래 §A-2(존재)·
  // VARIABLE_GRAIN_MISMATCH·§A-3(직접식별자 금지)·§A-8(산식정책)을 전부 담당하므로,
  // 여기 한 번만 추가하면 그 네 검사가 stratifyByKey에도 자동으로 적용된다
  // (server/src/stats/dataset/builder.ts의 neededKeys와는 별개 리스트 — 그쪽은 실제
  // 값을 채우는 쪽, 여기는 검증하는 쪽).
  const stratifyByKey = recipe.analysisMode === 'descriptive' ? recipe.descriptive?.stratifyByKey : undefined;
  const neededKeys = Array.from(new Set([
    ...recipe.variableKeys,
    ...filterKeys,
    ...(stratifyByKey ? [stratifyByKey] : []),
  ]));

  const input: RecipeCheckInput = { recipe, context, catalogByKey, neededKeys, stratifyByKey, errors };
  checkKeysExist(input);
  checkGrainCompatibility(input);
  checkVariableRules(input);
  checkFilters(input);
  checkFormulaPolicies(input);
  checkBivariate(input);
  checkCorrelationMatrix(input);
  checkRegression(input);
  checkPrediction(input);

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, catalogByKey };
}
