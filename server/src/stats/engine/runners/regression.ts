// Regression engine call: semantic checks and runRegressionStatsEngine.
// Split out of stats/engine/index.ts (S6 P1-34); handler bodies unchanged.
import { z } from 'zod';
import { ENGINE_PROTOCOL_VERSION, RegressionEngineRequest } from '../protocol';
import { StatsEngineRegressionRawResultSchema, StatsEngineRegressionRawResult } from '../responseSchemas';
import { StatsEngineResultInvalidError } from '../errors';
import { assertRegressionWithinLimits } from '../limits';
import { runEngineProcess, EngineRunOpts } from '../subprocess';

/** raw 엔진 응답 검증 규칙(계획서 §1) — 상태별로 다르게 건다. "계수 수==열 수"를
 * 무조건 요구하면 정상적인 non_estimable 응답(terms=[])이 엔진 오류로 거부된다. */
function validateRegressionSemantics(
  request: RegressionEngineRequest,
  raw: z.infer<typeof StatsEngineRegressionRawResultSchema>,
): void {
  const r = raw.regression;

  if (r.estimation === 'non_estimable') {
    if (r.terms.length !== 0) {
      throw new StatsEngineResultInvalidError('non_estimable 응답인데 terms가 비어있지 않다');
    }
    if (r.fit !== null) {
      throw new StatsEngineResultInvalidError('non_estimable 응답인데 fit이 null이 아니다');
    }
    if (r.nonEstimableReason === null) {
      throw new StatsEngineResultInvalidError('non_estimable 응답인데 nonEstimableReason이 없다');
    }
    // PR4-A2 — β가 없으므로 진단·spline도 없어야 한다(shared/contracts 상태 불변식과 대응).
    if (r.diagnostics !== null) {
      throw new StatsEngineResultInvalidError('non_estimable 응답인데 diagnostics가 null이 아니다');
    }
    if (r.splinePartialEffects !== null) {
      throw new StatsEngineResultInvalidError('non_estimable 응답인데 splinePartialEffects가 null이 아니다');
    }
    return;
  }

  if (r.terms.length !== request.columnNames.length) {
    throw new StatsEngineResultInvalidError(
      `terms 수 불일치: 요청 열 ${request.columnNames.length}개, 응답 ${r.terms.length}개`,
    );
  }
  request.columnNames.forEach((name, i) => {
    if (r.terms[i].name !== name) {
      throw new StatsEngineResultInvalidError(`terms[${i}].name 불일치: 요청 "${name}", 응답 "${r.terms[i].name}"`);
    }
  });
  if (r.fit === null) {
    throw new StatsEngineResultInvalidError(`estimation="${r.estimation}" 응답인데 fit이 null이다`);
  }

  // PR4-A2 — β는 존재하므로(ok/inference_withheld 공통) diagnostics 객체
  // 자체는 항상 있어야 한다(개별 집계값은 계산 실패 시 null 허용 — 스키마가
  // 이미 nullable로 표현). vif 배열 길이는 절편 제외 열 수와 같아야 한다.
  if (r.diagnostics === null) {
    throw new StatsEngineResultInvalidError(`estimation="${r.estimation}" 응답인데 diagnostics가 null이다`);
  }
  const expectedVifCount = request.columnNames.length - 1;
  if (r.diagnostics.vif.length !== expectedVifCount) {
    throw new StatsEngineResultInvalidError(
      `diagnostics.vif 길이 불일치: 기대 ${expectedVifCount}개(절편 제외), 응답 ${r.diagnostics.vif.length}개`,
    );
  }
  if (r.splinePartialEffects === null) {
    throw new StatsEngineResultInvalidError(`estimation="${r.estimation}" 응답인데 splinePartialEffects가 null이다`);
  }
  if (r.splinePartialEffects.length !== request.splineContrasts.length) {
    throw new StatsEngineResultInvalidError(
      `splinePartialEffects 개수 불일치: 요청 ${request.splineContrasts.length}개, 응답 ${r.splinePartialEffects.length}개`,
    );
  }
  request.splineContrasts.forEach((contrast, i) => {
    const points = r.splinePartialEffects![i]?.points;
    if (!points || points.length !== contrast.contrastMatrix.length) {
      throw new StatsEngineResultInvalidError(
        `splinePartialEffects[${i}].points 개수가 요청 contrastMatrix 행 수와 다르다`,
      );
    }
  });
  // inference_withheld면 spline CI를 전부 null로 강제한다(계수표의 nullifyInference와
  // 같은 원칙 — Python 자체가 withheld를 리턴할 때 cov=None으로 이미 이렇게 낸다).
  if (r.estimation === 'inference_withheld') {
    for (const effect of r.splinePartialEffects) {
      for (const point of effect.points) {
        if (point.ciLower !== null || point.ciUpper !== null) {
          throw new StatsEngineResultInvalidError('inference_withheld인데 splinePartialEffects의 CI가 null이 아니다');
        }
      }
    }
  }

  const seShouldBeNull = r.inferenceIssue === 'COVARIANCE_NOT_COMPUTABLE' || r.inferenceIssue === 'DEGENERATE_COVARIANCE';
  for (const term of r.terms) {
    if (seShouldBeNull) {
      if (term.se !== null) {
        throw new StatsEngineResultInvalidError(`inferenceIssue="${r.inferenceIssue}"인데 term "${term.name}"의 se가 null이 아니다`);
      }
    } else if (term.se === null || term.se <= 0) {
      throw new StatsEngineResultInvalidError(`term "${term.name}"의 se가 유한하고 0보다 커야 한다`);
    }
    if (r.estimation === 'ok') {
      if (term.pValue === null || term.statistic === null || term.ciLower === null || term.ciUpper === null) {
        throw new StatsEngineResultInvalidError(`estimation="ok"인데 term "${term.name}"의 추론 필드가 null이다`);
      }
    } else if (term.pValue !== null || term.statistic !== null || term.ciLower !== null || term.ciUpper !== null) {
      throw new StatsEngineResultInvalidError(`inference_withheld인데 term "${term.name}"의 추론 필드가 null이 아니다`);
    }
  }
}


export async function runRegressionStatsEngine(
  request: RegressionEngineRequest,
  opts?: EngineRunOpts,
): Promise<StatsEngineRegressionRawResult> {
  return runEngineProcess<StatsEngineRegressionRawResult>({
    assertLimits: () => assertRegressionWithinLimits(request),
    buildStdinPayload: () => ({ protocolVersion: ENGINE_PROTOCOL_VERSION, regression: request }),
    parseSuccess: (parsed) => {
      const shapeResult = StatsEngineRegressionRawResultSchema.safeParse(parsed);
      if (!shapeResult.success) {
        throw new StatsEngineResultInvalidError(`결과 schema 재검증 실패: ${shapeResult.error.message}`);
      }
      validateRegressionSemantics(request, shapeResult.data);
      return shapeResult.data.regression;
    },
    ...opts,
  });
}
