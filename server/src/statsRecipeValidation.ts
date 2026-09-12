// PR0-C §A — 레시피 검증. variableKeys ∪ filters[].key 전체를 대상으로 카탈로그 존재·
// 식별자 제한·분석 목적·필터 연산자/값 형태/타입 일치·formulaPolicy 유효성을 검사한다.
// zod(shared/contracts/stats.ts)는 구조만 검사하고, 여기서는 카탈로그 메타데이터를
// 참조해야 하는 동적 검사(변수 type별 허용 연산자·값 타입 등)를 한다.
import { getIntegratedCatalog } from './statsCatalog';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { StatsAnalysisRecipe, StatsFilter, StatsFilterOperator } from '@wr/contracts';

// PR0-B3 Part A는 vibration_interval을, Part B는 diagnosis_side를, Part C는 job/task를
// 추가했다. job_diagnosis는 계획상 이번 확장에서 전부 제외한다(계획 pr0-b3-shimmying-magpie.md).
const SUPPORTED_GRAINS: ReadonlySet<StatsAnalysisRecipe['grain']> = new Set([
  'case',
  'vibration_interval',
  'diagnosis_side',
  'job',
  'task',
]);

export interface RecipeValidationError {
  code: string;
  path: string;
  message: string;
}

export type RecipeValidationResult =
  | { valid: true; catalogByKey: Map<string, AnalyticsVariableMetadata> }
  | { valid: false; errors: RecipeValidationError[] };

// §A-5 — 변수 type별 허용 연산자. ordinal은 categorical과 동일하게 취급한다 — 카탈로그에
// 순위 메타데이터 필드가 아직 없어(elbow/wrist의 burdenGradeMax 값은 한국어 문자열이라
// 일반 문자열 비교가 심각도 순서와 무관하다, §"코드 사실") 순위 비교 연산자(gt/gte/lt/lte)를
// 이번 PR에서 아예 허용하지 않는다.
const TYPE_ALLOWED_OPERATORS: Record<AnalyticsVariableMetadata['type'], StatsFilterOperator[]> = {
  continuous: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_missing', 'not_missing'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_missing', 'not_missing'],
  categorical: ['eq', 'neq', 'in', 'is_missing', 'not_missing'],
  ordinal: ['eq', 'neq', 'in', 'is_missing', 'not_missing'],
  high_cardinality: ['eq', 'neq', 'in', 'is_missing', 'not_missing'],
  boolean: ['eq', 'neq', 'is_missing', 'not_missing'],
};

// §A-5 date 계약(2026-09-12 리뷰 보완) — Date.parse는 '2024/01/15'·'2024-01-15T00:00:00Z'
// 등 여러 형식을 느슨하게 통과시키는데, 실제 데이터셋 값(statsSnapshotColumnVariables.ts의
// toIsoDateOnly)은 항상 'YYYY-MM-DD'다. 검증과 실제 비교(statsDatasetBuilder.ts의
// matchesFilter, 문자열 그대로 비교)가 서로 다른 형식 기준을 쓰면 검증은 통과했는데 실제
// 매치는 0건이 되는 조용한 오탐이 생긴다(제거해야 할 사례가 그대로 남거나, 있어야 할
// 결과가 사라짐) — 형식을 이 한 가지로 고정하고, 존재하지 않는 달력 날짜(예: 2024-02-30)
// 도 실제 날짜 왕복으로 걸러낸다.
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidIsoDateOnly(value: string): boolean {
  if (!ISO_DATE_ONLY_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isValueOfType(type: AnalyticsVariableMetadata['type'], value: unknown): boolean {
  switch (type) {
    case 'continuous':
      return typeof value === 'number' && Number.isFinite(value);
    case 'date':
      return typeof value === 'string' && isValidIsoDateOnly(value);
    case 'categorical':
    case 'ordinal':
    case 'high_cardinality':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

// PR3-A §B — 이변량 method별 허용 타입쌍. 카탈로그 metadata만 참조하는 정적
// 판정(관측 데이터 불필요) — statsMethodCatalog(A-2, 브레이크다운 청결도 판정)과
// 다른 계층이다(계획서 §"방법 가용성 판정" A-1: METHOD_TYPE_MISMATCH는 항상
// 안전하게 노출 가능한 사유).
const GROUP_COMPARISON_METHODS = new Set(['welch_t', 'mann_whitney', 'anova', 'kruskal_wallis']);
const CONTINGENCY_METHODS = new Set(['chi_square', 'fisher_exact']);
const CORRELATION_METHODS = new Set(['pearson_correlation', 'spearman_correlation']);
const PAIRED_METHODS = new Set(['paired_t', 'wilcoxon_signed_rank']);

function isContinuousType(type: AnalyticsVariableMetadata['type']): boolean {
  return type === 'continuous';
}
function isGroupingType(type: AnalyticsVariableMetadata['type']): boolean {
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

function validateFilterValue(
  variable: AnalyticsVariableMetadata,
  filter: StatsFilter,
  path: string,
  errors: RecipeValidationError[],
): void {
  const { operator, value } = filter;

  if (operator === 'is_missing' || operator === 'not_missing') {
    if (value !== undefined) {
      errors.push({
        code: 'UNEXPECTED_FILTER_VALUE',
        path,
        message: `${operator} 연산자는 value를 받지 않는다`,
      });
    }
    return;
  }

  if (value === undefined) {
    errors.push({ code: 'INVALID_FILTER_VALUE', path, message: `${operator} 연산자는 value가 필요하다` });
    return;
  }

  if (operator === 'between') {
    if (!Array.isArray(value) || value.length !== 2) {
      errors.push({ code: 'INVALID_FILTER_RANGE', path, message: 'between은 정확히 2개 원소 배열이어야 한다' });
      return;
    }
    const [lower, upper] = value;
    if (!isValueOfType(variable.type, lower) || !isValueOfType(variable.type, upper)) {
      errors.push({ code: 'INVALID_FILTER_VALUE', path, message: `between 값이 변수 type(${variable.type})과 맞지 않는다` });
      return;
    }
    const lowerOk = variable.type === 'date' ? Date.parse(lower as string) <= Date.parse(upper as string) : (lower as number) <= (upper as number);
    if (!lowerOk) {
      errors.push({ code: 'INVALID_FILTER_RANGE', path, message: '하한이 상한보다 클 수 없다' });
    }
    return;
  }

  if (operator === 'in') {
    if (!Array.isArray(value) || value.length === 0) {
      errors.push({ code: 'INVALID_FILTER_VALUE', path, message: 'in은 비어있지 않은 배열이어야 한다' });
      return;
    }
    for (const element of value) {
      if (!isValueOfType(variable.type, element)) {
        errors.push({ code: 'INVALID_FILTER_VALUE', path, message: `in 원소가 변수 type(${variable.type})과 맞지 않는다` });
        return;
      }
    }
    return;
  }

  // eq/neq/gt/gte/lt/lte
  if (Array.isArray(value)) {
    errors.push({ code: 'INVALID_FILTER_VALUE', path, message: `${operator} 연산자는 배열 값을 받지 않는다` });
    return;
  }
  if (!isValueOfType(variable.type, value)) {
    errors.push({ code: 'INVALID_FILTER_VALUE', path, message: `값이 변수 type(${variable.type})과 맞지 않는다` });
  }
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

  const catalog = getIntegratedCatalog();
  const catalogByKey = new Map(catalog.map((v) => [v.key, v]));

  const filterKeys = recipe.filters.map((f) => f.key);
  const neededKeys = Array.from(new Set([...recipe.variableKeys, ...filterKeys]));

  // §A-2 키 존재
  for (const key of neededKeys) {
    if (!catalogByKey.has(key)) {
      errors.push({ code: 'UNKNOWN_VARIABLE', path: key, message: `카탈로그에 없는 변수 key: ${key}` });
    }
  }

  // PR0-B3 Part A — VARIABLE_GRAIN_MISMATCH: 분석 변수뿐 아니라 필터 키도 grain이 다르면
  // 거절한다(neededKeys는 variableKeys ∪ filters[].key 합집합, §A-2와 동일 대상). 한
  // recipe는 한 grain만 다룬다 — 교차 grain은 §2.1 roll-up으로 올려서 참여해야 하며 이번
  // 범위 밖이다.
  for (const key of neededKeys) {
    const variable = catalogByKey.get(key);
    if (variable && variable.grain !== recipe.grain) {
      errors.push({
        code: 'VARIABLE_GRAIN_MISMATCH',
        path: key,
        message: `${key}는 grain "${variable.grain}"인데 recipe.grain은 "${recipe.grain}"이다`,
      });
    }
  }

  // §A-3 식별자 제한(방어적 — 현재 카탈로그엔 direct_identifier가 0건)
  for (const key of neededKeys) {
    const variable = catalogByKey.get(key);
    if (variable && variable.sensitivity === 'direct_identifier') {
      errors.push({ code: 'IDENTIFIER_NOT_ALLOWED', path: key, message: `직접식별자 변수는 어떤 grain에서도 사용할 수 없다: ${key}` });
    }
  }

  // PR0-B3 Part C — 필터 전용 변수 계약. filter_only 변수(예: 등록일)는 filters[]에서만
  // 쓸 수 있고 variableKeys(분석 대상)에는 올 수 없다 — grain 검사와 별개 축이라 위
  // VARIABLE_GRAIN_MISMATCH 검사와 독립적으로 검사한다.
  for (const key of recipe.variableKeys) {
    const variable = catalogByKey.get(key);
    if (variable && variable.analysisRole === 'filter_only') {
      errors.push({
        code: 'FILTER_ONLY_VARIABLE_NOT_ANALYZABLE',
        path: key,
        message: `${key}는 필터 전용 변수라 분석 변수(variableKeys)로 쓸 수 없다 — 필터로만 사용하라`,
      });
    }
  }

  // §A-4 분석 목적 — variableKeys만(필터는 대상이 아님)
  for (const key of recipe.variableKeys) {
    const variable = catalogByKey.get(key);
    if (variable && !variable.allowedAnalysisPurposes.includes(recipe.analysisPurpose)) {
      errors.push({
        code: 'PURPOSE_NOT_ALLOWED',
        path: key,
        message: `${key}는 analysisPurpose "${recipe.analysisPurpose}"를 허용하지 않는다(허용: ${variable.allowedAnalysisPurposes.join(', ')})`,
      });
    }
  }

  // §A-5 필터 연산자·값 형태·타입 일치
  recipe.filters.forEach((filter, index) => {
    const variable = catalogByKey.get(filter.key);
    if (!variable) return; // UNKNOWN_VARIABLE로 이미 보고됨
    const path = `filters[${index}]`;
    const allowedOperators = TYPE_ALLOWED_OPERATORS[variable.type];
    if (!allowedOperators.includes(filter.operator)) {
      errors.push({
        code: 'OPERATOR_NOT_ALLOWED',
        path,
        message: `${filter.key}(type=${variable.type})는 연산자 "${filter.operator}"를 허용하지 않는다(허용: ${allowedOperators.join(', ')})`,
      });
      return;
    }
    validateFilterValue(variable, filter, path, errors);
  });

  // §A-8 formulaPolicy 유효성 — family 단위로 한 번씩만 검사(중복 에러 방지).
  const checkedFamilies = new Set<string>();
  for (const key of neededKeys) {
    const variable = catalogByKey.get(key);
    if (!variable) continue;
    const { formulaFamily, supportedFormulaPolicies } = variable;
    if (checkedFamilies.has(formulaFamily)) continue;
    checkedFamilies.add(formulaFamily);

    const declaredPolicy = recipe.formulaPolicies[formulaFamily];
    if (supportedFormulaPolicies.length > 1) {
      if (declaredPolicy === undefined) {
        errors.push({
          code: 'FORMULA_POLICY_REQUIRED',
          path: `formulaPolicies.${formulaFamily}`,
          message: `formula family "${formulaFamily}"는 정책이 혼재하므로 formulaPolicies.${formulaFamily}를 명시해야 한다(가능: ${supportedFormulaPolicies.join(', ')})`,
        });
      } else if (!supportedFormulaPolicies.includes(declaredPolicy)) {
        errors.push({
          code: 'UNSUPPORTED_FORMULA_POLICY',
          path: `formulaPolicies.${formulaFamily}`,
          message: `formula family "${formulaFamily}"는 정책 "${declaredPolicy}"를 지원하지 않는다(가능: ${supportedFormulaPolicies.join(', ')})`,
        });
      }
    } else if (declaredPolicy !== undefined && !supportedFormulaPolicies.includes(declaredPolicy)) {
      errors.push({
        code: 'UNSUPPORTED_FORMULA_POLICY',
        path: `formulaPolicies.${formulaFamily}`,
        message: `formula family "${formulaFamily}"는 정책 "${declaredPolicy}"를 지원하지 않는다(가능: ${supportedFormulaPolicies.join(', ')})`,
      });
    }
  }

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

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, catalogByKey };
}
