// PR3-B §9 — 캐시-권한 드리프트 방지. limited_row 등급 필드(boxplot outlierValues·
// scatter 원시 points)는 stats_runs.result(캐시 저장 대상)에 절대 포함되지 않는다
// — 이 모듈은 /analyze 응답을 실제로 클라이언트에 보내기 직전(신규계산·캐시hit·
// in-flight조인 3경로 전부 공통) 단 한 곳에서 호출돼, 공유되는 aggregate 객체를
// mutate하지 않고 새 객체를 조립해 반환한다. 상관행렬 셀(r/pValue/n/adjustedP)은
// 전부 집계 통계량이라 이 메커니즘이 적용되지 않는다(계획서 §4.5/§6).
//
// PR4-A2 — 회귀 진단(잔차·leverage·Cook's D)도 이 지점에서 채운다. 다른 분기와
// 달리 (X,y,β)만의 순수 함수인 경량 엔진 호출이 필요해 이 함수 전체가 비동기로
// 바뀐다(계획서 §4 "limited_row 진단값" — 캐시 hit/miss와 완전히 독립적).
import type { AnalyzeResult, AnalyzeRegressionResult } from '@wr/contracts';
import type { AnalysisContext } from './statsAnalysisContext';
import type { DatasetRow } from './statsDatasetBuilder';
import type { PairedRow } from './statsBivariateDataset';
import { computeOutlierValues } from './statsChartDisclosure';
import { sampleScatterPoints, sampleRegressionDiagnosticsRowIndices } from './statsScatterGrid';
import { resolveGroupComparisonGroups } from './statsBivariateSuppression';
import { runRegressionDiagnosticsEngine, StatsEngineBusyError } from './statsEngine';

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
 * PR4-A2 — regression.diagnostics.pointDiagnostics를 채운다(또는 채우지 못하는
 * 이유에 맞게 pointDiagnosticsStatus를 확정한다). statsRegressionSuppression.ts가
 * 이미 세워둔 초기값(모형이 미지원이면 'unavailable_model', 지원하면
 * 'not_requested')을 여기서 최종 상태로 전환한다 — **모형 지원 여부(추론 상태와
 * 무관하게 (X,y,β)로 직접 판정됨)와 권한 여부(hasAccess)는 서로 다른 축**이라
 * 순서대로 검사한다.
 */
async function resolveRegressionPointDiagnostics(
  ctx: AnalysisContext,
  regression: AnalyzeRegressionResult,
  hasAccess: boolean,
): Promise<{ regression: AnalyzeRegressionResult; attached: boolean }> {
  if (regression.suppressed || regression.estimation === 'non_estimable' || !regression.diagnostics) {
    return { regression, attached: false };
  }

  // 권한 없음 — 엔진을 절대 호출하지 않는다.
  if (!hasAccess) {
    return {
      regression: { ...regression, diagnostics: { ...regression.diagnostics, pointDiagnosticsStatus: 'unavailable_no_access' } },
      attached: false,
    };
  }

  // 모형 자체가 미지원 — statsRegressionSuppression.ts가 이미 'unavailable_model'로
  // 세워뒀다. 엔진을 호출할 이유가 없다(어차피 결과가 전부 null일 것).
  if (!regression.diagnostics.pointDiagnosticsSupported) {
    return { regression, attached: false };
  }

  const design = ctx.regressionDesign;
  if (!design || !design.ok) {
    // 이론상 도달 불가(diagnostics가 채워졌다는 것은 ④가 성공했다는 뜻) — 방어적으로
    // 계산 실패와 동일하게 처리한다.
    return {
      regression: { ...regression, diagnostics: { ...regression.diagnostics, pointDiagnosticsStatus: 'unavailable_computation_failed' } },
      attached: false,
    };
  }

  const { rowIndices, displayedCount, totalCount } = sampleRegressionDiagnosticsRowIndices(
    design.design.caseIds,
    ctx.recipeDigest,
  );

  // β 재구성 — ctx.regressionDesign.columns(결정적 순서)를 terms와 name으로
  // 매칭한다. 배열 인덱스 일치를 가정하지 않는다(계획서 §4 "β 재구성").
  const termByName = new Map(regression.terms.map((t) => [t.name, t] as const));
  const beta = design.design.columns.map((col) => termByName.get(col.name)?.estimate);
  if (beta.some((v) => v === undefined || !Number.isFinite(v))) {
    return {
      regression: { ...regression, diagnostics: { ...regression.diagnostics, pointDiagnosticsStatus: 'unavailable_computation_failed' } },
      attached: false,
    };
  }

  const family = design.design.method === 'ols_linear' ? 'gaussian' : 'binomial';

  try {
    const raw = await runRegressionDiagnosticsEngine({
      family,
      y: design.design.y,
      X: design.design.x,
      columnNames: design.design.columns.map((c) => c.name),
      beta: beta as number[],
      sampledRowIndices: rowIndices,
    });

    if (!raw.pointDiagnosticsSupported) {
      // 최초 적합 시점과 다른 판정이 나올 이유는 없지만(같은 X,y,β), 방어적으로
      // 처리한다 — 계산 실패와 동일하게 다룬다.
      return {
        regression: { ...regression, diagnostics: { ...regression.diagnostics, pointDiagnosticsStatus: 'unavailable_computation_failed' } },
        attached: false,
      };
    }

    return {
      regression: {
        ...regression,
        diagnostics: {
          ...regression.diagnostics,
          pointDiagnosticsStatus: 'available',
          displayedPointCount: displayedCount,
          totalPointCount: totalCount,
          pointDiagnostics: raw.points,
        },
      },
      attached: true,
    };
  } catch (err) {
    // PR4-B2 — 엔진 동시성 상한(1)은 prediction의 수 분 단위 실행과 이 경량
    // 진단 호출이 겹칠 수 있게 됐다. Busy는 "지금 다른 실행이 슬롯을 쓰고
    // 있을 뿐"이라 계산 실패(unavailable_computation_failed)와 구분한다 — 재시도
    // 하면 될 수 있다는 신호를 클라이언트에 남긴다.
    if (err instanceof StatsEngineBusyError) {
      return {
        regression: { ...regression, diagnostics: { ...regression.diagnostics, pointDiagnosticsStatus: 'unavailable_engine_busy' } },
        attached: false,
      };
    }
    // 그 외 엔진 호출 실패(타임아웃·크래시·비유한값) — 감사와 무관한 순수 계산
    // 실패다. 계수·적합도·VIF·spline은 이미 확정돼 있으므로 그대로 보존하고
    // 진단만 생략한다.
    return {
      regression: { ...regression, diagnostics: { ...regression.diagnostics, pointDiagnosticsStatus: 'unavailable_computation_failed' } },
      attached: false,
    };
  }
}

/**
 * hasAccess가 false여도 regression 분기는 pointDiagnosticsStatus를
 * 'unavailable_no_access'로 전환해야 하므로(값 자체를 붙이는 게 아니라 상태만
 * 바뀜 — attached는 false) boxplot/scatter처럼 완전한 no-op은 아니다. 다만
 * 그 갱신은 이 함수 안에서 이미 attached:false로 처리되므로, 호출자(§9 신규
 * 감사 단계)는 여전히 attached만 보고 판단하면 된다.
 */
export async function attachLimitedRowFields(
  ctx: AnalysisContext,
  result: AnalyzeResult,
  hasAccess: boolean,
): Promise<AttachLimitedRowFieldsOutcome> {
  let attached = false;

  let continuous = result.continuous;
  let bivariate = result.bivariate;
  let regression = result.regression;

  if (hasAccess) {
    continuous = result.continuous.map((c) => {
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
  }

  // PR4-A2 — regression 분기는 hasAccess===false일 때도 pointDiagnosticsStatus를
  // 'unavailable_no_access'로 전환해야 하므로 위 `if (hasAccess)` 블록 밖에서
  // 별도로 처리한다(resolveRegressionPointDiagnostics가 access 여부를 직접 본다).
  if (regression) {
    const outcome = await resolveRegressionPointDiagnostics(ctx, regression, hasAccess);
    regression = outcome.regression;
    if (outcome.attached) attached = true;
  }

  // PR4-A2 — regression 분기가 hasAccess===false여도(unavailable_no_access 전환)
  // 실행되므로, "아무것도 안 바뀌었으면 원본 참조를 그대로 반환한다"는 기존 no-op
  // 보장이 `if (!hasAccess) return { result, attached: false }` 조기 반환 하나로는
  // 더 이상 안 지켜진다(regression이 없는 요청은 이 분기 자체가 안 도니 continuous/
  // bivariate/regression 셋 다 원본과 참조가 같다 — 그 경우엔 새 객체를 만들지
  // 않는다).
  if (continuous === result.continuous && bivariate === result.bivariate && regression === result.regression) {
    return { result, attached };
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
  // PR4-A2 — regression도 같은 함정이 있어 동일하게 조건부 스프레드한다.
  const patched: AnalyzeResult = { ...result, continuous };
  if (bivariate !== undefined) patched.bivariate = bivariate;
  if (regression !== undefined) patched.regression = regression;
  return { result: patched, attached };
}
