// Recipe checks for bivariate methods and the correlation matrix, and the type helpers they share.
// Split out of stats/recipe/validation.ts (S6 P1-35); check bodies unchanged.
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { RecipeCheckInput } from '.';

// PR3-A §B — 이변량 method별 허용 타입쌍. 카탈로그 metadata만 참조하는 정적
// 판정(관측 데이터 불필요) — statsMethodCatalog(A-2, 브레이크다운 청결도 판정)과
// 다른 계층이다(계획서 §"방법 가용성 판정" A-1: METHOD_TYPE_MISMATCH는 항상
// 안전하게 노출 가능한 사유).
const GROUP_COMPARISON_METHODS = new Set(['welch_t', 'mann_whitney', 'anova', 'kruskal_wallis']);
const CONTINGENCY_METHODS = new Set(['chi_square', 'fisher_exact']);
const CORRELATION_METHODS = new Set(['pearson_correlation', 'spearman_correlation']);
const PAIRED_METHODS = new Set(['paired_t', 'wilcoxon_signed_rank']);

export function isContinuousType(type: AnalyticsVariableMetadata['type']): boolean {
  return type === 'continuous';
}
export function isGroupingType(type: AnalyticsVariableMetadata['type']): boolean {
  return type === 'boolean' || type === 'ordinal' || type === 'categorical';
}

function isMethodTypeCompatible(
  method: string,
  typeA: AnalyticsVariableMetadata['type'],
  typeB: AnalyticsVariableMetadata['type'],
): boolean {
  if (GROUP_COMPARISON_METHODS.has(method)) {
    return (isContinuousType(typeA) && isGroupingType(typeB)) || (isContinuousType(typeB) && isGroupingType(typeA));
  }
  if (CONTINGENCY_METHODS.has(method)) {
    return isGroupingType(typeA) && isGroupingType(typeB);
  }
  if (CORRELATION_METHODS.has(method)) {
    return isContinuousType(typeA) && isContinuousType(typeB);
  }
  return false;
}

export function checkBivariate(input: RecipeCheckInput): void {
  const { recipe, context, catalogByKey, errors } = input;
  // PR3-A §B — 이변량 타입정합성·paired영구거부·method필수여부. 전부 카탈로그
  // 메타데이터만 참조(관측 데이터 불필요, statsMethodCatalog의 A-2와는 다른 계층).
  // context==='analyze'일 때만 엄격하게 검사한다(preview는 관대함, 위 함수 주석 참고).
  if (recipe.analysisMode === 'bivariate' && context === 'analyze') {
    if (!recipe.requestedMethod) {
      errors.push({
        code: 'BIVARIATE_REQUIRES_METHOD',
        path: 'requestedMethod',
        message: '이변량 모드에서는 requestedMethod를 지정해야 한다',
      });
    } else if (PAIRED_METHODS.has(recipe.requestedMethod)) {
      errors.push({
        code: 'PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING',
        path: 'requestedMethod',
        message: `${recipe.requestedMethod}는 카탈로그에 대응(좌우 짝) 메타데이터가 있는 변수가 생기기 전까지 지원하지 않는다`,
      });
    } else {
      // zod superRefine이 이미 variableKeys.length===2와 서로 다른 변수임을 보장한다.
      const [keyA, keyB] = recipe.variableKeys;
      const varA = catalogByKey.get(keyA);
      const varB = catalogByKey.get(keyB);
      // varA/varB가 undefined면 UNKNOWN_VARIABLE로 이미 보고됨 — 중복 보고 방지.
      if (varA && varB && !isMethodTypeCompatible(recipe.requestedMethod, varA.type, varB.type)) {
        errors.push({
          code: 'METHOD_TYPE_MISMATCH',
          path: 'requestedMethod',
          message: `${recipe.requestedMethod}는 선택된 변수 타입(${varA.type}, ${varB.type}) 조합에 쓸 수 없다`,
        });
      }
    }
  }
}

export function checkCorrelationMatrix(input: RecipeCheckInput): void {
  const { recipe, context, catalogByKey, errors } = input;
  // PR3-B §4/§7 — 상관행렬 타입정합성(전부 continuous)·method필수여부. zod
  // superRefine(shared/contracts/stats.ts)은 variableKeys 개수·중복만 구조적으로
  // 검사한다 — "전부 continuous"는 카탈로그 조회가 필요해 여기(의미 계층)의
  // 책임이다. context==='analyze'일 때만 엄격하게 검사(preview는 관대함).
  if (recipe.analysisMode === 'correlation_matrix' && context === 'analyze') {
    if (!recipe.requestedMethod) {
      errors.push({
        code: 'CORRELATION_MATRIX_REQUIRES_METHOD',
        path: 'requestedMethod',
        message: '상관행렬 모드에서는 requestedMethod를 지정해야 한다',
      });
    } else if (!CORRELATION_METHODS.has(recipe.requestedMethod)) {
      errors.push({
        code: 'CORRELATION_MATRIX_METHOD_NOT_SUPPORTED',
        path: 'requestedMethod',
        message: `상관행렬은 pearson_correlation/spearman_correlation만 지원한다(요청: ${recipe.requestedMethod})`,
      });
    }
    for (const key of recipe.variableKeys) {
      const variable = catalogByKey.get(key);
      // variable이 undefined면 UNKNOWN_VARIABLE로 이미 보고됨 — 중복 보고 방지.
      if (variable && !isContinuousType(variable.type)) {
        errors.push({
          code: 'METHOD_TYPE_MISMATCH',
          path: key,
          message: `상관행렬은 연속형 변수만 지원한다(${key}는 type=${variable.type})`,
        });
      }
    }
  }
}
