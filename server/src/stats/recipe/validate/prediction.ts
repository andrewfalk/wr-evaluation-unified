// Recipe checks for prediction: grain, method, outcome role and event level, predictors, filter leakage.
// Split out of stats/recipe/validation.ts (S6 P1-35); check bodies unchanged.
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import { PREDICTION_OUTCOME_SPECS } from '@wr/analytics-core/catalog';
import { REGISTERED_AT_KEY } from '../../dataset/snapshotColumnVariables';
import { PREDICTION_SUPPORTED_GRAINS } from '../grains';
import type { RecipeCheckInput } from '.';

// PR4-B2 — 예측 1종. predictor 허용 타입은 회귀와 같다(계획서 §2단계 "predictor
// 타입은 continuous·boolean·categorical·ordinal(one-hot)이다"). 카탈로그 배선이 이미
// 이 타입만 predictionRole:'predictor'로 부여했지만(§0단계 허용표), API를 직접
// 호출하는 우회를 막기 위해 여기서도 다시 강제한다(회귀 REGRESSION_PREDICTOR_ALLOWED_
// TYPES와 동일 원칙).
const PREDICTION_METHODS = new Set(['l2_logistic']);
const PREDICTION_PREDICTOR_ALLOWED_TYPES: ReadonlySet<AnalyticsVariableMetadata['type']> =
  new Set(['continuous', 'categorical', 'ordinal', 'boolean']);

export function checkPrediction(input: RecipeCheckInput): void {
  const { recipe, catalogByKey, errors } = input;
  // PR4-B2 — 예측(prediction) 역할·명세·grain·필터 검증. zod superRefine(shared/
  // contracts/stats.ts)은 구조검사만(≥2개 변수·중복 금지·outcome이 variableKeys 안에
  // 있는지·eventLevel 비어있지 않음) 했다 — 여기서 카탈로그가 필요한 의미검증을 한다.
  // context 구분 없이 항상 엄격하다(association 모드들과 달리 prediction은 방법이
  // l2_logistic 1종뿐이라 "미선택 상태의 관대한 preview"가 의미가 없다).
  if (recipe.analysisMode === 'prediction' && recipe.prediction) {
    const { outcomeKey, eventLevel } = recipe.prediction;
    const outcomeVar = catalogByKey.get(outcomeKey);
    const predictorKeys = recipe.variableKeys.filter((k) => k !== outcomeKey);

    // grain — case/disease만 지원(job 제외). VARIABLE_GRAIN_MISMATCH(§A-2 아래, 이미
    // 위에서 검사됨)와 별개 축이다 — 그건 "변수가 이 grain과 호환되는가", 이건
    // "이 grain 자체가 예측을 지원하는가".
    if (!PREDICTION_SUPPORTED_GRAINS.has(recipe.grain)) {
      errors.push({
        code: 'PREDICTION_GRAIN_NOT_SUPPORTED',
        path: 'grain',
        message: `예측 분석은 grain "${recipe.grain}"을 지원하지 않는다(지원: ${Array.from(PREDICTION_SUPPORTED_GRAINS).join(', ')})`,
      });
    }

    if (recipe.requestedMethod && !PREDICTION_METHODS.has(recipe.requestedMethod)) {
      errors.push({
        code: 'PREDICTION_METHOD_NOT_SUPPORTED',
        path: 'requestedMethod',
        message: `예측은 l2_logistic만 지원한다(요청: ${recipe.requestedMethod})`,
      });
    }

    // outcome 역할 — predictionRole==='outcome'이 아닌 변수를 outcome으로 쓸 수 없다
    // (예: predictor 역할 변수도 allowedAnalysisPurposes엔 'prediction'이 있어 §A-4
    // PURPOSE_NOT_ALLOWED만으로는 걸러지지 않는다 — 역할 축이 별도로 필요한 이유).
    if (outcomeVar && outcomeVar.predictionRole !== 'outcome') {
      errors.push({
        code: 'PREDICTION_OUTCOME_INVALID_ROLE',
        path: 'prediction.outcomeKey',
        message: `${outcomeKey}는 predictionRole이 'outcome'이 아니다 — 예측 outcome으로 쓸 수 없다`,
      });
    } else if (outcomeVar) {
      // eventLevel — PREDICTION_OUTCOME_SPECS(서버·클라이언트 공유 단일 진실원)의
      // 허용값 중 하나여야 한다. boolean outcome은 클라이언트가 'true'로 고정해 보낸다
      // (계획서 §1단계 — 데이터와 무관한 400이라 카탈로그 검사와 별개로 여기서 확정).
      const spec = PREDICTION_OUTCOME_SPECS[outcomeKey];
      if (!spec || !spec.eventLevels.includes(eventLevel)) {
        errors.push({
          code: 'PREDICTION_EVENT_LEVEL_NOT_ALLOWED',
          path: 'prediction.eventLevel',
          message: `eventLevel "${eventLevel}"은 ${outcomeKey}의 허용값(${(spec?.eventLevels ?? []).join(', ')})에 없다`,
        });
      }
    }

    // predictor 역할·타입 — outcome 역할 변수를 predictor로 섞어 쓰거나, predictor가
    // 아닌 타입(date·high_cardinality 등)을 쓰면 거부한다.
    for (const key of predictorKeys) {
      const variable = catalogByKey.get(key);
      if (!variable) continue; // UNKNOWN_VARIABLE로 이미 보고됨
      if (variable.predictionRole !== 'predictor') {
        errors.push({
          code: 'PREDICTION_PREDICTOR_INVALID_ROLE',
          path: key,
          message: `${key}는 predictionRole이 'predictor'가 아니다 — 예측 predictor로 쓸 수 없다`,
        });
        continue;
      }
      if (!PREDICTION_PREDICTOR_ALLOWED_TYPES.has(variable.type)) {
        errors.push({
          code: 'PREDICTION_PREDICTOR_TYPE_UNSUPPORTED',
          path: key,
          message: `${key}는 type=${variable.type}이라 예측 predictor로 쓸 수 없다(date·high_cardinality 미지원)`,
        });
      }
    }

    // PREDICTION_FILTER_LEAKAGE — 필터는 predictor 역할 변수, 또는 판정 이전 DB컬럼
    // 중 명시 허용된 등록일(REGISTERED_AT_KEY)만 허용한다(계획서 §0단계 "필터" 절).
    // outcome·다른 filter_only 변수(생년월일·재해일자·버전 등)는 필터로도 쓸 수 없다.
    recipe.filters.forEach((filter, index) => {
      const variable = catalogByKey.get(filter.key);
      if (!variable) return; // UNKNOWN_VARIABLE로 이미 보고됨
      const allowed = variable.predictionRole === 'predictor' || filter.key === REGISTERED_AT_KEY;
      if (!allowed) {
        errors.push({
          code: 'PREDICTION_FILTER_LEAKAGE',
          path: `filters[${index}]`,
          message: `${filter.key}는 예측 필터로 쓸 수 없다 — predictor 역할 변수 또는 등록일만 허용된다`,
        });
      }
    });
  }
}
