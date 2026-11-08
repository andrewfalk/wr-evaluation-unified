// Recipe checks on filters (§A-5): operator per variable type, value shape and type.
// Split out of stats/recipe/validation.ts (S6 P1-35); check bodies unchanged.
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { StatsFilter, StatsFilterOperator } from '@wr/contracts';
import type { RecipeCheckInput, RecipeValidationError } from '.';

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
// 등 여러 형식을 느슨하게 통과시키는데, 실제 데이터셋 값(stats/dataset/snapshotColumnVariables.ts의
// toIsoDateOnly)은 항상 'YYYY-MM-DD'다. 검증과 실제 비교(stats/dataset/builder.ts의
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

export function checkFilters(input: RecipeCheckInput): void {
  const { recipe, catalogByKey, errors } = input;
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
}
