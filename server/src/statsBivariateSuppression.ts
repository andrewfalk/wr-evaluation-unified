// PR3-A — B-처리(그룹/셀 소수셀·값상수·제외사유 소수셀). 계획서 § "방법 가용성
// 판정" B: 절대 별도 reasonCode를 만들지 않는다 — 캐시미스 분기에서만 호출되고
// (캐시 hit는 이미 저장된 결과를 그대로 반환, B 재실행 없음), 그룹/셀이 소수셀이면
// Python을 아예 호출하지 않고 곧바로 {method,suppressed:true}를 만든다. 값상수는
// Python이 계산 도중 발견(statistic===null)하면 그 결과도 동일하게 불투명 처리한다
// — "인원수라 막힘"과 "값이 상수라 막힘"을 관찰자가 구분할 수 없어야 한다.
//
// person count 근사에 대하여 — groups[].values.length(또는 table 셀의 case 수)를
// person count로 취급해도 안전하다: statsMethodCatalog.ts가 이 method를 available/
// conditional로 판정했다는 것 자체가 §6.1 게이트(personCount===caseCount)를 이미
// 통과했다는 뜻이고, 전체가 1:1이면 어떤 부분집합(그룹/셀)도 1:1이기 때문이다.
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { AnalyzeBivariateResult, StatsMethodId } from '@wr/contracts';
import type { BivariateEngineRequest } from './statsEngine';
import { runBivariateStatsEngine } from './statsEngine';
import { isSmallCell } from './statsSmallCell';
import type { AnalysisContext } from './statsAnalysisContext';
import type { PairedDatasetResult, PairedRow } from './statsBivariateDataset';
import { groupPairsByLevel } from './statsBivariateDataset';
import { resolveGroupComparisonRoles, resolveLevelOrder } from './statsBivariateRoles';

const GROUP_COMPARISON_METHODS = new Set<StatsMethodId>(['welch_t', 'mann_whitney', 'anova', 'kruskal_wallis']);
const CONTINGENCY_METHODS = new Set<StatsMethodId>(['chi_square', 'fisher_exact']);

/** groups/table/x,y 3-shape 중 method에 맞는 하나를 조립한다. statsMethodCatalog.ts의
 * A-2 판정과 정확히 같은 role-resolution 로직(statsBivariateRoles.ts)을 재사용해
 * "availableMethods가 말한 것"과 "실제로 실행하는 것"이 갈리지 않게 한다. */
export function buildBivariateEngineRequest(
  method: StatsMethodId,
  pairs: PairedRow[],
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
  keyX: string,
  keyY: string,
): BivariateEngineRequest {
  const typeX = catalogByKey.get(keyX)?.type;
  const typeY = catalogByKey.get(keyY)?.type;

  if (GROUP_COMPARISON_METHODS.has(method)) {
    const roles = resolveGroupComparisonRoles(typeX, typeY, keyX, keyY);
    if (!roles) throw new Error(`buildBivariateEngineRequest: ${method}에 맞는 그룹/값 역할을 찾을 수 없음`);
    const order = resolveLevelOrder(roles.groupType, roles.groupKey);
    if (order === null) throw new Error(`buildBivariateEngineRequest: ${roles.groupKey}의 레벨 순서를 알 수 없음(GROUP_ORDER_UNDEFINED)`);
    const valueRoleKey: 'x' | 'y' = roles.groupRoleKey === 'x' ? 'y' : 'x';
    const { groups } = groupPairsByLevel(pairs, roles.groupRoleKey, order);
    return {
      method: method as 'welch_t' | 'mann_whitney' | 'anova' | 'kruskal_wallis',
      groups: [...groups.entries()].map(([label, rows]) => ({
        label,
        values: rows.map((r) => r[valueRoleKey] as number),
      })),
    };
  }

  if (CONTINGENCY_METHODS.has(method)) {
    const xOrder = resolveLevelOrder(typeX, keyX);
    const yOrder = resolveLevelOrder(typeY, keyY);
    if (xOrder === null || yOrder === null) throw new Error(`buildBivariateEngineRequest: ${method}의 축 순서를 알 수 없음(GROUP_ORDER_UNDEFINED)`);
    const { groups: xGroups } = groupPairsByLevel(pairs, 'x', xOrder);
    const { groups: yGroups } = groupPairsByLevel(pairs, 'y', yOrder);
    const rowLabels = [...xGroups.keys()];
    const colLabels = [...yGroups.keys()];
    const table = rowLabels.map((rowLevel) => {
      const rowsForX = xGroups.get(rowLevel) ?? [];
      return colLabels.map((colLevel) => rowsForX.filter((p) => p.y === colLevel).length);
    });
    return { method: method as 'chi_square' | 'fisher_exact', table, rowLabels, colLabels };
  }

  // 상관(pearson/spearman) — 대칭이라 역할 판정 불필요, row-aligned 그대로.
  return {
    method: method as 'pearson_correlation' | 'spearman_correlation',
    x: pairs.map((p) => p.x as number),
    y: pairs.map((p) => p.y as number),
  };
}

/** B-1 사전검사 — groups/table 값 개수(§6.1 게이트 통과 후엔 person count와 동일,
 * 파일 상단 주석 참고)로 판정 가능한 소수셀. true면 Python을 호출하지 않는다. */
function hasSmallCellInRequest(request: BivariateEngineRequest): boolean {
  if ('groups' in request) {
    return request.groups.some((g) => isSmallCell(g.values.length));
  }
  if ('table' in request) {
    return request.table.some((row) => row.some((cell) => isSmallCell(cell)));
  }
  return false; // 상관(x/y) — 쌍 전체 person count는 레이어1이 이미 확인함.
}

/** §B-2 — 사유 중 하나라도 소수셀이면 상세 전부 생략(기존 buildMissingPatterns
 * 패턴과 동일한 원칙), 합계(excludedCaseCount)는 별도로 항상 유지된다. */
function computeExclusionsForResponse(
  paired: PairedDatasetResult,
): Array<{ reasonCode: 'x_missing' | 'y_missing' | 'both_missing'; count: number }> | null {
  const anySmall = paired.exclusions.some((e) => isSmallCell(e.personCount));
  if (anySmall) return null;
  return paired.exclusions.map((e) => ({ reasonCode: e.reasonCode, count: e.count }));
}

/** computeAndPersist의 캐시-미스 분기 전용 진입점(계획서 §"파이프라인" — 캐시 hit면
 * 이 함수는 아예 호출되지 않는다). */
export async function computeBivariateAnalyzeResult(ctx: AnalysisContext): Promise<AnalyzeBivariateResult> {
  const method = ctx.recipe.requestedMethod!; // validateRecipe(analyze)가 이미 보장
  const paired = ctx.paired as PairedDatasetResult;
  const [keyX, keyY] = ctx.recipe.variableKeys;

  const request = buildBivariateEngineRequest(method, paired.pairs, ctx.catalogByKey, keyX, keyY);
  const exclusions = computeExclusionsForResponse(paired);
  const excludedCaseCount = paired.excludedCaseCount;

  if (hasSmallCellInRequest(request)) {
    return { method, suppressed: true };
  }

  const raw = await runBivariateStatsEngine(request);

  // Python이 계산 도중 발견한 값상수(또는 다른 계산불능 사유)도 동일하게 불투명
  // 처리한다 — statistic===null이면 nullReasons를 응답에 노출하지 않고 침묵 억제.
  if (raw.statistic === null && raw.pValue === null && raw.effectSizes.length === 0) {
    return { method, suppressed: true };
  }

  return {
    method,
    suppressed: false,
    n: raw.n,
    statistic: raw.statistic,
    df: raw.df,
    pValue: raw.pValue,
    effectSizes: raw.effectSizes,
    nullReasons: raw.nullReasons,
    multipleTesting: raw.multipleTesting,
    qualityFlags: raw.qualityFlags,
    extra: raw.extra.cramersV ? { cramersV: raw.extra.cramersV } : {},
    excludedCaseCount,
    exclusions,
  };
}
