// PR3-B §9 — 캐시-권한 드리프트 방지. limited_row 등급 필드(boxplot outlierValues·
// scatter 원시 points)는 stats_runs.result(캐시 저장 대상)에 절대 포함되지 않는다
// — 이 모듈은 /analyze 응답을 실제로 클라이언트에 보내기 직전(신규계산·캐시hit·
// in-flight조인 3경로 전부 공통) 단 한 곳에서 호출돼, 공유되는 aggregate 객체를
// mutate하지 않고 새 객체를 조립해 반환한다. 상관행렬 셀(r/pValue/n/adjustedP)은
// 전부 집계 통계량이라 이 메커니즘이 적용되지 않는다(계획서 §4.5/§6).
import type { AnalyzeResult } from '@wr/contracts';
import type { AnalysisContext } from './statsAnalysisContext';
import type { DatasetRow } from './statsDatasetBuilder';
import type { PairedRow } from './statsBivariateDataset';
import { computeOutlierValues } from './statsChartDisclosure';
import { sampleScatterPoints } from './statsScatterGrid';
import { resolveGroupComparisonGroups } from './statsBivariateSuppression';

function datasetValueOf(rows: DatasetRow[], key: string) {
  return (row: DatasetRow): number | null => {
    const extracted = row.values[key];
    if (!extracted || extracted.missing !== null) return null;
    return typeof extracted.value === 'number' ? extracted.value : null;
  };
}

export interface AttachLimitedRowFieldsOutcome {
  result: AnalyzeResult;
  attached: boolean;
}

/**
 * hasAccess가 false면 항상 no-op(원본 그대로, attached:false) — 호출자는 이
 * 경우 신규 감사 단계(§9)를 건너뛰어도 된다.
 */
export function attachLimitedRowFields(
  ctx: AnalysisContext,
  result: AnalyzeResult,
  hasAccess: boolean,
): AttachLimitedRowFieldsOutcome {
  if (!hasAccess) return { result, attached: false };

  let attached = false;

  const continuous = result.continuous.map((c) => {
    if (c.suppressed) return c;
    if (!c.boxplot || c.boxplot.outlierCount === undefined) return c;
    const outlierValues = computeOutlierValues(
      ctx.dataset.rows,
      { q1: c.boxplot.q1, q3: c.boxplot.q3 },
      datasetValueOf(ctx.dataset.rows, c.variableKey),
    );
    attached = true;
    return { ...c, boxplot: { ...c.boxplot, outlierValues } };
  });

  let bivariate = result.bivariate;
  if (bivariate && !bivariate.suppressed) {
    let next = bivariate;

    if (bivariate.groupBreakdown && ctx.paired) {
      const [keyX, keyY] = ctx.recipe.variableKeys;
      const { valueRoleKey, groupedPairs } = resolveGroupComparisonGroups(ctx.paired.pairs, ctx.catalogByKey, keyX, keyY);
      const groupValueOf = (row: PairedRow): number | null => {
        const v = row[valueRoleKey];
        return typeof v === 'number' ? v : null;
      };
      const groupBreakdown = bivariate.groupBreakdown.map((g) => {
        if (!g.boxplot || g.boxplot.outlierCount === undefined) return g;
        const pairedRowsForGroup = groupedPairs.get(g.label) ?? [];
        const outlierValues = computeOutlierValues(
          pairedRowsForGroup,
          { q1: g.boxplot.q1, q3: g.boxplot.q3 },
          groupValueOf,
        );
        attached = true;
        return { ...g, boxplot: { ...g.boxplot, outlierValues } };
      });
      next = { ...next, groupBreakdown };
    }

    if (bivariate.scatter && ctx.paired) {
      const points = sampleScatterPoints(
        ctx.paired.pairs,
        (p) => p.x as number,
        (p) => p.y as number,
        ctx.recipeDigest,
      );
      attached = true;
      next = {
        ...next,
        scatter: { ...next.scatter!, displayedCount: points.displayedCount, points: points.points },
      };
    }

    bivariate = next;
  }

  // 코드리뷰로 발견(2026-09-11) — `{ ...result, continuous, bivariate }`처럼 항상
  // bivariate 키를 단축 표기로 넣으면, descriptive/correlation_matrix 모드처럼
  // 원래 result에 bivariate 필드 자체가 없던 경우에도 값이 `bivariate: undefined`인
  // 키가 새로 생긴다. canonicalDigest(finalizeAnalyzeResponse가 attached:true일 때
  // 호출)는 `Object.entries`로 모든 키를 순회해 undefined 값을 만나면 그 자리에서
  // throw한다(JSON.stringify처럼 undefined 키를 조용히 생략하지 않음) — 즉
  // descriptive 모드에서 boxplot outlierCount가 있고 사용자가 limited_row 권한을
  // 가진 요청은 지금까지 전부 500이었을 것(HTTP 레벨에서 이 조합을 테스트한 적이
  // 없어 발견되지 못했던 잠재 결함). 원래 없던 필드는 아예 키 자체를 만들지 않는다.
  const patched: AnalyzeResult = { ...result, continuous };
  if (bivariate !== undefined) patched.bivariate = bivariate;
  return { result: patched, attached };
}
