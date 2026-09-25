// PR0-B3 Part A — 통합 카탈로그 접근자. `getFullVariableCatalog()`(analytics-core 전용)를
// `statsRecipeValidation.ts`/`routes/stats.ts`가 직접 호출하던 것을 이 함수 하나로 정리한다.
// Part C — SNAPSHOT_COLUMN_VARIABLES(담당의·등록일, payload가 아니라 SnapshotRow에서 오는
// 변수)를 여기서 병합한다(계획 "통합 카탈로그" 절이 예고한 유일한 합류 지점).
// `statsDatasetBuilder.ts`는 이 함수를 호출하지 않는다 — 검증 단계(statsRecipeValidation.ts)가
// 만든 catalogByKey를 그대로 전달받는 기존 구조를 유지한다.
import { getFullVariableCatalog, PREDICTION_OUTCOME_SPECS, PREDICTION_REVIEWED_DERIVED_PREDICTORS } from '@wr/analytics-core/catalog';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import { SNAPSHOT_COLUMN_VARIABLES } from './statsSnapshotColumnVariables';

// PR4-B2 — 기동 시 throw하는 카탈로그 검사 4종(계획서 §2단계). 요청 처리 시점이 아니라
// 서버가 뜰 때 한 번 실행돼야 한다 — 잘못 배선된 카탈로그가 런타임까지 살아남으면 안 된다.
export function assertPredictionCatalogInvariants(catalog: AnalyticsVariableMetadata[]): void {
  for (const v of catalog) {
    const allowsPrediction = v.allowedAnalysisPurposes.includes('prediction');

    // 1) 'prediction'을 허용하면 predictionRole이 필수다.
    if (allowsPrediction && !v.predictionRole) {
      throw new Error(`assertPredictionCatalogInvariants: "${v.key}"는 allowedAnalysisPurposes에 'prediction'이 있지만 predictionRole이 없다`);
    }
    if (!allowsPrediction && v.predictionRole) {
      throw new Error(`assertPredictionCatalogInvariants: "${v.key}"는 predictionRole이 있지만 allowedAnalysisPurposes에 'prediction'이 없다`);
    }
    if (!v.predictionRole) continue;

    // 2) predictor는 post_decision이면 안 된다(판정 이전 정보만 입력으로 허용).
    if (v.predictionRole === 'predictor' && v.availableAt === 'post_decision') {
      throw new Error(`assertPredictionCatalogInvariants: predictor "${v.key}"의 availableAt이 'post_decision'이다 — 판정 이전 정보만 predictor로 허용된다`);
    }

    // 3) outcome은 boolean 또는 categorical이면서 outcome 명세가 있어야 한다.
    if (v.predictionRole === 'outcome') {
      if (v.type !== 'boolean' && v.type !== 'categorical') {
        throw new Error(`assertPredictionCatalogInvariants: outcome "${v.key}"의 type이 "${v.type}"이다 — boolean 또는 categorical만 허용된다`);
      }
      if (!PREDICTION_OUTCOME_SPECS[v.key]) {
        throw new Error(`assertPredictionCatalogInvariants: outcome "${v.key}"에 PREDICTION_OUTCOME_SPECS 명세가 없다`);
      }
    }

    // 4) derived predictor는 검토 목록(PREDICTION_REVIEWED_DERIVED_PREDICTORS)에 있어야 한다.
    if (v.predictionRole === 'predictor' && v.provenance === 'derived' && !PREDICTION_REVIEWED_DERIVED_PREDICTORS.has(v.key)) {
      throw new Error(`assertPredictionCatalogInvariants: derived predictor "${v.key}"가 PREDICTION_REVIEWED_DERIVED_PREDICTORS 검토목록에 없다`);
    }
  }
}

export function getIntegratedCatalog(): AnalyticsVariableMetadata[] {
  const analyticsCoreCatalog = getFullVariableCatalog();
  const analyticsCoreKeys = new Set(analyticsCoreCatalog.map((v) => v.key));
  for (const v of SNAPSHOT_COLUMN_VARIABLES) {
    if (analyticsCoreKeys.has(v.key)) {
      throw new Error(`getIntegratedCatalog: 카탈로그 key 충돌 — "${v.key}"가 analytics-core와 SNAPSHOT_COLUMN_VARIABLES 양쪽에 있다`);
    }
  }
  const catalog = [...analyticsCoreCatalog, ...SNAPSHOT_COLUMN_VARIABLES];
  assertPredictionCatalogInvariants(catalog);
  return catalog;
}
