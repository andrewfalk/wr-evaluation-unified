// PR3-B — 상관행렬 계산+공개통제(계획서 §4, 4차 코드리뷰로 확정된 3단계 순서).
//
//   1) Python: 요청된 모든 쌍에 대해 r/pValue를 계산(계산 불가면 null). Python
//      자신이 계산 가능했던 쌍만 대상으로 BH-FDR을 수행 — disclosure를 전혀
//      모른 채 정직하게만 계산한다(correlation_matrix.py 참고).
//   2) Node: pair마다 (a) 레이어1 소수셀 게이트 (b) §6.1 반복측정 게이트
//      (c) Python 자신의 계산불가(null) — 셋 중 하나라도 실패하면 suppressed:true
//      (기존 단일쌍 이변량과 완전히 동일한 정책 — statsBivariateSuppression.ts의
//      "계산불가=불투명 억제"를 그대로 재사용, 새 정책 발명 안 함).
//   3) Node: 최종 매트릭스에 suppressed:true 셀이 하나라도 있으면 남은 셀 전부의
//      adjustedP를 null로 덮고 adjustedPWithheld:true — Python의 BH 계산이 억제될
//      셀의 raw p값까지 포함해 이뤄졌으므로, 그 영향이 남은 adjustedP에 묻어있을
//      수 있기 때문(§4.1, 계산으로 실증됨: p=[0.04,0.05,0.9]에서 가운데를 숨겨도
//      adjustedP 0.075가 그 값의 흔적을 담고 있다).
//
// 저장(stats_runs.result)에는 이 3단계까지 전부 끝난 최종 결과만 들어간다 — 이미
// computeBivariateAnalyzeResult가 하는 것과 정확히 같은 패턴. 상관행렬 셀에는
// limited_row 필드가 전혀 없다(r/pValue/n/adjustedP 전부 집계 통계량) — §9(캐시-
// 권한 드리프트 방지, 응답시점 merge)는 상관행렬에 적용되지 않는다.
import type { AnalyzeCorrelationMatrixCell, AnalyzeCorrelationMatrixResult } from '@wr/contracts';
import type { AnalysisContext } from './statsAnalysisContext';
import { allCorrelationMatrixPairs, pairMapKey } from './statsCorrelationMatrixDataset';
import { evaluateBivariateDisclosure } from './statsBivariateDisclosureGate';
import { evaluateInferenceGate } from './statsInferenceGate';
import { runCorrelationMatrixStatsEngine, type CorrelationMatrixEngineRequest } from './statsEngine';

/** computeAndPersist의 캐시-미스 분기 전용 진입점(계획서 §"파이프라인"과 동일한
 * 원칙 — 캐시 hit면 이 함수는 아예 호출되지 않는다). */
export async function computeCorrelationMatrixAnalyzeResult(ctx: AnalysisContext): Promise<AnalyzeCorrelationMatrixResult> {
  const method = ctx.recipe.requestedMethod as 'pearson_correlation' | 'spearman_correlation';
  const variableKeys = ctx.recipe.variableKeys;
  const pairsMap = ctx.correlationMatrixPairs!;

  // 코드리뷰 2차 수정(2026-09-11) — 값 배열은 buildAnalysisContext()의 입력상한
  // 선검사(evaluateCorrelationMatrixInputLimits, statsCorrelationMatrixDataset.ts)가
  // 이미 만들어둔 것을 재사용한다(여기서 ctx.dataset.rows로부터 다시 추출하면
  // 같은 O(k×rows) 작업을 두 번 하게 됨).
  const request: CorrelationMatrixEngineRequest = { method, variables: ctx.correlationMatrixVariables! };
  const raw = await runCorrelationMatrixStatsEngine(request);
  const rawCellByPair = new Map(raw.cells.map((c) => [pairMapKey(c.xKey, c.yKey), c] as const));

  const cells: AnalyzeCorrelationMatrixCell[] = allCorrelationMatrixPairs(variableKeys).map(({ xKey, yKey }) => {
    const paired = pairsMap.get(pairMapKey(xKey, yKey))!;
    const layer1 = evaluateBivariateDisclosure(paired);
    const inferenceGate = evaluateInferenceGate(paired.includedPersonCount, paired.includedCaseCount);
    const rawCell = rawCellByPair.get(pairMapKey(xKey, yKey));
    const computable = rawCell != null && rawCell.r !== null && rawCell.pValue !== null;

    if (!layer1.disclose || !inferenceGate.allowed || !computable) {
      return { suppressed: true, xKey, yKey };
    }
    return {
      suppressed: false,
      xKey,
      yKey,
      n: rawCell!.n,
      r: rawCell!.r!,
      pValue: rawCell!.pValue!,
      adjustedP: rawCell!.adjustedP,
    };
  });

  // §4.1 — 매트릭스 안에 억제 셀이 하나라도 있으면 나머지 전부의 adjustedP를
  // 정책적으로 null 처리하고 플래그를 세운다(BH 누적계산이 억제 셀의 raw p값도
  // 반영했으므로 남은 값에 흔적이 남을 수 있음).
  const adjustedPWithheld = cells.some((c) => c.suppressed);
  const finalCells = adjustedPWithheld
    ? cells.map((c) => (c.suppressed ? c : { ...c, adjustedP: null }))
    : cells;

  return { method, variableKeys, cells: finalCells, adjustedPWithheld };
}
