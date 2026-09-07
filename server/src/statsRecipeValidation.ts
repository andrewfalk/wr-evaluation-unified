// PR0-C §A — 레시피 검증. variableKeys ∪ filters[].key 전체를 대상으로 카탈로그 존재·
// 식별자 제한·분석 목적·필터 연산자/값 형태/타입 일치·formulaPolicy 유효성을 검사한다.
// zod(shared/contracts/stats.ts)는 구조만 검사하고, 여기서는 카탈로그 메타데이터를
// 참조해야 하는 동적 검사(변수 type별 허용 연산자·값 타입 등)를 한다.
import { getFullVariableCatalog } from '@wr/analytics-core/catalog';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { StatsAnalysisRecipe, StatsFilter, StatsFilterOperator } from '@wr/contracts';

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

function isValueOfType(type: AnalyticsVariableMetadata['type'], value: unknown): boolean {
  switch (type) {
    case 'continuous':
      return typeof value === 'number' && Number.isFinite(value);
    case 'date':
      // §A-5 date 캐비엇 — Date.parse 성공만으로는 형식·타임존을 고정하지 못한다. 현재
      // 카탈로그에 date 타입 변수가 0개라 이 분기는 실행되지 않는 죽은 코드다. 실제로
      // date 변수가 추가되기 전에 엄격한 날짜 계약(고정 포맷·명시적 타임존)을 먼저
      // 정의해야 한다.
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
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

export function validateRecipe(recipe: StatsAnalysisRecipe): RecipeValidationResult {
  const errors: RecipeValidationError[] = [];

  // §A-1 grain — case 아니면 조기 반환(이후 검증은 case grain을 전제하므로 의미가 없다).
  if (recipe.grain !== 'case') {
    return {
      valid: false,
      errors: [{ code: 'GRAIN_NOT_YET_SUPPORTED', path: 'grain', message: `grain "${recipe.grain}"은 아직 지원하지 않는다 — 지원: case` }],
    };
  }

  const catalog = getFullVariableCatalog();
  const catalogByKey = new Map(catalog.map((v) => [v.key, v]));

  const filterKeys = recipe.filters.map((f) => f.key);
  const neededKeys = Array.from(new Set([...recipe.variableKeys, ...filterKeys]));

  // §A-2 키 존재
  for (const key of neededKeys) {
    if (!catalogByKey.has(key)) {
      errors.push({ code: 'UNKNOWN_VARIABLE', path: key, message: `카탈로그에 없는 변수 key: ${key}` });
    }
  }

  // §A-3 식별자 제한(방어적 — 현재 카탈로그엔 direct_identifier가 0건)
  for (const key of neededKeys) {
    const variable = catalogByKey.get(key);
    if (variable && variable.sensitivity === 'direct_identifier') {
      errors.push({ code: 'IDENTIFIER_NOT_ALLOWED', path: key, message: `직접식별자 변수는 어떤 grain에서도 사용할 수 없다: ${key}` });
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

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, catalogByKey };
}
