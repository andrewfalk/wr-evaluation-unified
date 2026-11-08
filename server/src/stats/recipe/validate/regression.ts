// Recipe checks for regression: method and outcome type, predictor types, reference levels, splines.
// Split out of stats/recipe/validation.ts (S6 P1-35); check bodies unchanged.
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import { getOrdinalOrder, getCategoricalOrder } from '../ordinalOrder';
import type { RecipeCheckInput } from '.';

// PR4-A1 — 회귀 2종. outcome 타입이 method를 자동 결정하지만 requestedMethod로도
// 명시 가능(§6.5). date·high_cardinality는 predictor로 쓸 수 없다(계획 §2 ④ 표) —
// categorical/ordinal/boolean/continuous만 허용.
const REGRESSION_METHODS = new Set(['ols_linear', 'binary_logistic']);
const REGRESSION_PREDICTOR_ALLOWED_TYPES: ReadonlySet<AnalyticsVariableMetadata['type']> =
  new Set(['continuous', 'categorical', 'ordinal', 'boolean']);

export function checkRegression(input: RecipeCheckInput): void {
  const { recipe, context, catalogByKey, errors } = input;
  // PR4-A1 — 회귀 타입정합성·predictor 적격성·기준 레벨 사전검증. zod superRefine
  // (shared/contracts/stats.ts)은 구조검사만(≥2개 변수·중복 금지·outcome이 variableKeys
  // 안에 있는지) 했다 — 여기서 카탈로그가 필요한 의미검증을 한다. context==='analyze'
  // 일 때만 requestedMethod 필수(리뷰 #1 — preview는 관대해야 최초 방법 미선택 상태의
  // /preview도 통과한다).
  if (recipe.analysisMode === 'regression' && recipe.regression) {
    const { outcomeKey, referenceLevels } = recipe.regression;
    const outcomeVar = catalogByKey.get(outcomeKey);
    const predictorKeys = recipe.variableKeys.filter((k) => k !== outcomeKey);

    // method 존재 여부·유효성·outcome 타입 정합성은 전부 context==='analyze'
    // 일 때만 검사한다(bivariate/correlation_matrix와 동일한 관례 — preview는
    // requestedMethod가 아직 없거나 이후 바뀔 스테일 값이어도 항상 관대해야
    // 한다. 불일치는 availableMethods의 METHOD_TYPE_MISMATCH로 이미 드러난다).
    if (context === 'analyze') {
      if (!recipe.requestedMethod) {
        errors.push({
          code: 'REGRESSION_REQUIRES_METHOD',
          path: 'requestedMethod',
          message: '회귀 모드에서는 requestedMethod를 지정해야 한다',
        });
      } else if (!REGRESSION_METHODS.has(recipe.requestedMethod)) {
        errors.push({
          code: 'REGRESSION_METHOD_NOT_SUPPORTED',
          path: 'requestedMethod',
          message: `회귀는 ols_linear/binary_logistic만 지원한다(요청: ${recipe.requestedMethod})`,
        });
      } else if (outcomeVar) {
        // outcome 타입 ↔ method 정합성. PR4-A2 — categorical outcome도 binary_logistic에
        // 허용한다(선언 타입만 본다 — 완전사례 관측 레벨이 정확히 2개인지는 카탈로그로
        // 알 수 없어 stats/dataset/regressionDesign.ts(④, 데이터 필요)에서 최종 판정한다).
        const outcomeTypeOk =
          (recipe.requestedMethod === 'ols_linear' && outcomeVar.type === 'continuous') ||
          (recipe.requestedMethod === 'binary_logistic' &&
            (outcomeVar.type === 'boolean' || outcomeVar.type === 'categorical'));
        if (!outcomeTypeOk) {
          errors.push({
            code: 'METHOD_TYPE_MISMATCH',
            path: 'regression.outcomeKey',
            message: `${recipe.requestedMethod}는 outcome 타입(${outcomeVar.type})에 쓸 수 없다 — ols_linear는 continuous, binary_logistic은 boolean·categorical(2레벨)만 v1에서 지원한다`,
          });
        }
      }
      // outcomeVar가 undefined면 UNKNOWN_VARIABLE로 이미 보고됨 — 중복 보고 방지.
    }

    for (const key of predictorKeys) {
      const variable = catalogByKey.get(key);
      if (variable && !REGRESSION_PREDICTOR_ALLOWED_TYPES.has(variable.type)) {
        errors.push({
          code: 'REGRESSION_PREDICTOR_TYPE_UNSUPPORTED',
          path: key,
          message: `${key}는 type=${variable.type}이라 회귀 predictor로 쓸 수 없다(date·high_cardinality 미지원)`,
        });
      }
    }

    // 기준 레벨 값 검증(계획 §2 ④ "기준 레벨 검증") — 카탈로그에 순서가 선언된
    // 변수만 여기서 검증한다. 선언이 없는 동적 categorical은 완전사례 관측 레벨
    // 기준으로만 판정 가능해 stats/dataset/regressionDesign.ts(4단계, 데이터 필요)로 미룬다.
    for (const [refKey, refValue] of Object.entries(referenceLevels ?? {})) {
      if (!predictorKeys.includes(refKey)) {
        errors.push({
          code: 'REGRESSION_REFERENCE_LEVEL_UNKNOWN_PREDICTOR',
          path: `regression.referenceLevels.${refKey}`,
          message: `${refKey}는 predictor 집합에 없다`,
        });
        continue;
      }
      const variable = catalogByKey.get(refKey);
      if (!variable) continue; // UNKNOWN_VARIABLE로 이미 보고됨
      const declared = getOrdinalOrder(refKey) ?? getCategoricalOrder(refKey);
      if (declared && !declared.includes(refValue)) {
        errors.push({
          code: 'REGRESSION_REFERENCE_LEVEL_NOT_DECLARED',
          path: `regression.referenceLevels.${refKey}`,
          message: `${refKey}의 선언된 레벨(${declared.join(', ')})에 "${refValue}"가 없다`,
        });
      }
    }

    // PR4-A2 — spline은 continuous만, eventLevel은 categorical outcome만. 일반
    // predictor 적격성 검사(REGRESSION_PREDICTOR_ALLOWED_TYPES, 위)는 continuous/
    // categorical/ordinal/boolean을 전부 허용하므로 이 제약을 대신하지 못한다.
    // UI가 선택을 막아도 API를 직접 호출하면 우회되므로 여기서 다시 강제한다.
    for (const key of recipe.regression.splineKeys) {
      const variable = catalogByKey.get(key);
      if (variable && variable.type !== 'continuous') {
        errors.push({
          code: 'SPLINE_PREDICTOR_MUST_BE_CONTINUOUS',
          path: `regression.splineKeys.${key}`,
          message: `${key}는 type=${variable.type}이라 spline 대상이 될 수 없다(continuous만 지원)`,
        });
      }
    }
    if (recipe.regression.eventLevel !== undefined && outcomeVar && outcomeVar.type !== 'categorical') {
      errors.push({
        code: 'EVENT_LEVEL_REQUIRES_CATEGORICAL_OUTCOME',
        path: 'regression.eventLevel',
        message: `eventLevel은 categorical outcome에만 지정할 수 있다(outcome 타입: ${outcomeVar.type})`,
      });
    }
  }
}
