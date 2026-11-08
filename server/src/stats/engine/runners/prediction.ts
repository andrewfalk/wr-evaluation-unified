// Prediction engine call: request builder, semantic checks and runPredictionStatsEngine.
// Split out of stats/engine/index.ts (S6 P1-34); handler bodies unchanged.
import { z } from 'zod';
import { PREDICTION_POLICY, computePredictionLambdaGrid } from '../../policy/policy';
import { ENGINE_PROTOCOL_VERSION, PredictionEngineRequest } from '../protocol';
import { _PREDICTION_METRIC_NAMES, StatsEnginePredictionRawResultSchema, StatsEnginePredictionRawResult } from '../responseSchemas';
import { StatsEngineResultInvalidError } from '../errors';
import { assertPredictionWithinLimits } from '../limits';
import { runEngineProcess, EngineRunOpts } from '../subprocess';

export interface BuildPredictionEngineRequestInput {
  y: number[];
  x: number[][];
  columnNames: string[];
  // S2 rows 순서와 정확히 같은 cohortPersonKey 배열(§3-1단계 — Python엔 이
  // 키만 간다, 원 person ID는 절대 넘기지 않는다).
  groups: string[];
  // repeat(1-based) → cohortPersonKey → fold. assignPredictionOuterFolds의
  // 출력을 그대로 받는다.
  outerFoldAssignment: ReadonlyMap<number, ReadonlyMap<string, number>>;
  outerFoldCount: number;
}

/** 사전검사(preview의 candidateParameterCount 등)와 실제 실행(analyze)이
 * 공유하는 순수 빌더 — PREDICTION_POLICY를 여기서 한 번만 읽어 request shape로
 * 굳힌다(계획서 §5단계 "사전검사와 실행이 공유"). */
export function buildPredictionEngineRequest(input: BuildPredictionEngineRequestInput): PredictionEngineRequest {
  const repeats = input.outerFoldAssignment.size;
  const outerFolds: number[][] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const foldOfPerson = input.outerFoldAssignment.get(repeat);
    if (!foldOfPerson) {
      throw new Error(`buildPredictionEngineRequest: outerFoldAssignment에 repeat ${repeat}가 없다(1..${repeats} 연속이어야 함)`);
    }
    outerFolds.push(input.groups.map((g) => {
      const fold = foldOfPerson.get(g);
      if (fold === undefined) {
        throw new Error(`buildPredictionEngineRequest: person "${g}"의 repeat ${repeat} fold 배정이 없다`);
      }
      return fold;
    }));
  }

  return {
    y: input.y,
    X: input.x,
    columnNames: input.columnNames,
    groups: input.groups,
    outerFoldCount: input.outerFoldCount,
    outerFolds,
    config: {
      innerFolds: PREDICTION_POLICY.innerFolds,
      lambdaGrid: computePredictionLambdaGrid(),
      bootstrapReplicates: PREDICTION_POLICY.bootstrapReplicates,
      bootstrapMinValidRate: PREDICTION_POLICY.bootstrapMinValidRate,
      cvMinValidRepeats: PREDICTION_POLICY.cvMinValidRepeats,
      aucCiReplicates: PREDICTION_POLICY.aucCiReplicates,
      samplerSeed: PREDICTION_POLICY.samplerSeed,
      representativeRepeat: PREDICTION_POLICY.representativeRepeat,
    },
  };
}

/** raw 엔진 응답 검증 — non_estimable/ok 상태별 null 필드 짝, oofRepresentative
 * 길이(N과 동일), coefficients 길이(columnCount와 동일), metrics가 5개 지표를
 * 전부 갖는지(§4단계 응답 계약, shared/contracts의 상태 불변식과 대응). */
function validatePredictionSemantics(
  request: PredictionEngineRequest,
  raw: z.infer<typeof StatsEnginePredictionRawResultSchema>,
): void {
  const p = raw.prediction;
  const n = request.y.length;
  const columnCount = request.columnNames.length;

  const metricKeys = Object.keys(p.metrics);
  if (metricKeys.length !== _PREDICTION_METRIC_NAMES.length || !_PREDICTION_METRIC_NAMES.every((name) => name in p.metrics)) {
    throw new StatsEngineResultInvalidError(`metrics가 5개 지표(${_PREDICTION_METRIC_NAMES.join(', ')})를 전부 갖지 않는다: ${metricKeys.join(', ')}`);
  }

  if (p.estimation === 'non_estimable') {
    if (p.nonEstimableReason === null) {
      throw new StatsEngineResultInvalidError('non_estimable 응답인데 nonEstimableReason이 없다');
    }
    if (p.lambdaSelected !== null) {
      throw new StatsEngineResultInvalidError('non_estimable 응답인데 lambdaSelected가 null이 아니다');
    }
    if (p.oofRepresentative !== null) {
      throw new StatsEngineResultInvalidError('non_estimable 응답인데 oofRepresentative가 null이 아니다');
    }
    if (p.coefficients !== null) {
      throw new StatsEngineResultInvalidError('non_estimable 응답인데 coefficients가 null이 아니다');
    }
    if (p.aucCi !== null) {
      throw new StatsEngineResultInvalidError('non_estimable 응답인데 aucCi가 null이 아니다');
    }
    return;
  }

  if (p.nonEstimableReason !== null) {
    throw new StatsEngineResultInvalidError('estimation="ok"인데 nonEstimableReason이 null이 아니다');
  }
  if (p.lambdaSelected === null) {
    throw new StatsEngineResultInvalidError('estimation="ok"인데 lambdaSelected가 null이다');
  }
  if (p.coefficients === null) {
    throw new StatsEngineResultInvalidError('estimation="ok"인데 coefficients가 null이다');
  }
  if (p.coefficients.length !== columnCount) {
    throw new StatsEngineResultInvalidError(`coefficients 길이 불일치: 요청 열 ${columnCount}개, 응답 ${p.coefficients.length}개`);
  }
  if (p.intercept === null) {
    throw new StatsEngineResultInvalidError('estimation="ok"인데 intercept가 null이다');
  }
  if (p.oofRepresentative === null) {
    throw new StatsEngineResultInvalidError('estimation="ok"인데 oofRepresentative가 null이다');
  }
  if (p.oofRepresentative.length !== n) {
    throw new StatsEngineResultInvalidError(`oofRepresentative 길이 불일치: 요청 행 ${n}개, 응답 ${p.oofRepresentative.length}개`);
  }
  // 코드리뷰(2026-09-25) — 길이만 맞아도 row 인덱스가 중복되거나 범위를
  // 벗어나면 이후 y[point.row]/groups[point.row] 매핑(stats/disclosure/predictionSuppression.ts)과
  // 곡선 공개통제의 전제(row가 0..N-1의 정확한 순열)가 깨진다. 확률값도 [0,1]
  // 밖이면 calibration/ROC 구간화가 무의미해진다 — 둘 다 zod shape 통과만으로는
  // 못 잡는 프로토콜 방어 검증이다.
  const seenOofRows = new Set<number>();
  for (const point of p.oofRepresentative) {
    if (point.row < 0 || point.row >= n) {
      throw new StatsEngineResultInvalidError(`oofRepresentative row 인덱스 범위 초과: ${point.row}(허용 0..${n - 1})`);
    }
    if (seenOofRows.has(point.row)) {
      throw new StatsEngineResultInvalidError(`oofRepresentative row 인덱스 중복: ${point.row}`);
    }
    seenOofRows.add(point.row);
    if (point.p < 0 || point.p > 1) {
      throw new StatsEngineResultInvalidError(`oofRepresentative 확률값이 [0,1] 범위를 벗어남: row=${point.row}, p=${point.p}`);
    }
  }
  const rocAuc = p.metrics.roc_auc;
  if (p.aucCi !== null && (!rocAuc || rocAuc.cv.status !== 'ok')) {
    throw new StatsEngineResultInvalidError('aucCi가 있는데 roc_auc.cv.status가 ok가 아니다');
  }
}


// PR4-B2 — 예측 엔진 호출. timeoutMs는 호출부(stats/queue/runsQueue.ts)가
// computePredictionEngineTimeoutMs(S2 행 수)로 계산해 opts로 넘긴다 — 여기서는
// 다른 run*StatsEngine과 동일하게 opts를 그대로 전달할 뿐 정책값을 모른다.
export async function runPredictionStatsEngine(
  request: PredictionEngineRequest,
  opts?: EngineRunOpts,
): Promise<StatsEnginePredictionRawResult> {
  return runEngineProcess<StatsEnginePredictionRawResult>({
    assertLimits: () => assertPredictionWithinLimits(request),
    buildStdinPayload: () => ({ protocolVersion: ENGINE_PROTOCOL_VERSION, prediction: request }),
    parseSuccess: (parsed) => {
      const shapeResult = StatsEnginePredictionRawResultSchema.safeParse(parsed);
      if (!shapeResult.success) {
        throw new StatsEngineResultInvalidError(`결과 schema 재검증 실패: ${shapeResult.error.message}`);
      }
      validatePredictionSemantics(request, shapeResult.data);
      return shapeResult.data.prediction;
    },
    ...opts,
  });
}
