// 요청 단위 억제(필터 후 인원 미달·쌍/회귀/예측 공개통제) 시 모드별로 항상 존재해야 하는 억제 스텁.
// 핸들러(조기 억제 즉답)와 워커(해제 적격 실행의 일반본)가 같은 스텁을 만든다 — 한 곳에서만 정의해 어긋나지 않게 한다.
import type { AnalyzeResult } from '@wr/contracts';
import type { AnalysisContext } from './statsAnalysisContext';
import { allCorrelationMatrixPairs } from './statsCorrelationMatrixDataset';

// PR3-A — analysisMode==='bivariate'면 continuous/discrete 대신 bivariate 스텁을
// 만든다(계획서 §"결과 계약 불변조건" — 조기억제 경로에서도 bivariate 필드가 항상
// 존재해야 함). requestedMethod는 이 시점에 항상 존재한다(validateRecipe(analyze)가
// analysisMode==='bivariate'일 때 이미 보장 — buildAnalysisContext가 그 전에 실패함).
export function buildSuppressedAnalyzeResult(ctx: AnalysisContext): AnalyzeResult {
  if (ctx.recipe.analysisMode === 'bivariate') {
    return { continuous: [], discrete: [], bivariate: { method: ctx.recipe.requestedMethod!, suppressed: true } };
  }
  if (ctx.recipe.analysisMode === 'correlation_matrix') {
    // PR3-B §4 — 요청 전체가 억제돼도 cells는 항상 C(k,2)개(전부 suppressed:true,
    // 절대 빈 배열이 아님 — "결과 계약 불변조건"을 상관행렬에도 동일하게 적용).
    const method = ctx.recipe.requestedMethod as 'pearson_correlation' | 'spearman_correlation';
    const cells = allCorrelationMatrixPairs(ctx.recipe.variableKeys).map(({ xKey, yKey }) => ({
      suppressed: true as const, xKey, yKey,
    }));
    return {
      continuous: [], discrete: [],
      correlationMatrix: { method, variableKeys: ctx.recipe.variableKeys, cells, adjustedPWithheld: true },
    };
  }
  if (ctx.recipe.analysisMode === 'regression') {
    // PR4-A1 §1 — 회귀 억제는 단일 사유(MIN_COHORT_NOT_MET)로 수렴하는
    // suppressed:true 스텁뿐이다(다른 필드 일절 없음 — 계약 strict).
    return {
      continuous: [], discrete: [],
      regression: { suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' },
    };
  }
  if (ctx.recipe.analysisMode === 'prediction') {
    // PR4-B2 — 예측 억제도 회귀와 동일 원칙: 단일 사유로 수렴하는 suppressed:true
    // 스텁뿐이다(계획서 §2단계 공개통제, 다른 필드 일절 없음 — 계약 strict).
    return {
      continuous: [], discrete: [],
      prediction: { suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' },
    };
  }
  if (ctx.recipe.analysisMode === 'descriptive' && ctx.recipe.descriptive) {
    // Table1 — descriptive는 bivariate/regression/prediction과 달리 모드 전용
    // disclosure 플래그가 없다(§ 아래 호출부) — 이 스텁은 오직 ctx.requestSuppressed
    // (=ctx.reasonCode가 채워진 경우)로만 도달하므로 실제 사유를 그대로 반영한다.
    return {
      continuous: [], discrete: [],
      descriptiveStratified: {
        suppressed: true,
        stratifyByKey: ctx.recipe.descriptive.stratifyByKey,
        reasonCode: ctx.reasonCode!,
      },
    };
  }
  return {
    continuous: ctx.recipe.variableKeys
      .filter((k) => ctx.catalogByKey.get(k)?.type === 'continuous')
      .map((k) => ({ variableKey: k, kind: 'continuous' as const, suppressed: true as const })),
    discrete: ctx.recipe.variableKeys
      .filter((k) => ctx.catalogByKey.get(k)?.type !== 'continuous')
      .map((k) => ({ variableKey: k, kind: 'discrete' as const, suppressed: true as const })),
  };
}
