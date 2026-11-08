// Correlation matrix engine call: semantic checks and runCorrelationMatrixStatsEngine.
// Split out of stats/engine/index.ts (S6 P1-34); handler bodies unchanged.
import { z } from 'zod';
import { ENGINE_PROTOCOL_VERSION, CorrelationMatrixEngineRequest } from '../protocol';
import { StatsEngineCorrelationMatrixRawResultSchema, StatsEngineCorrelationMatrixRawResult } from '../responseSchemas';
import { StatsEngineResultInvalidError } from '../errors';
import { assertCorrelationMatrixWithinLimits } from '../limits';
import { runEngineProcess, EngineRunOpts } from '../subprocess';

/** Node-Python 연결계층 의미검증(계획서 §4/§7) — protocol.py의 구조/의미 분리
 * 패턴과 대칭. Python 응답이 요청한 모든 쌍과 정확히 1:1 대응하는지(누락·중복·
 * 미요청 없음), 각 셀의 n이 Node가 독립적으로 계산한 pairwise-complete count와
 * 일치하는지(Python 버그를 Node가 교차검증), r/pValue 범위가 유효한지 검사한다. */
function validateCorrelationMatrixSemantics(
  request: CorrelationMatrixEngineRequest,
  raw: z.infer<typeof StatsEngineCorrelationMatrixRawResultSchema>,
): void {
  const cm = raw.correlationMatrix;
  if (cm.method !== request.method) {
    throw new StatsEngineResultInvalidError(`method mismatch: requested ${request.method}, got ${cm.method}`);
  }

  const keys = request.variables.map((v) => v.key);
  const expectedPairs = new Set<string>();
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      expectedPairs.add(`${keys[i]}::${keys[j]}`);
    }
  }
  const valuesByKey = new Map(request.variables.map((v) => [v.key, v.values] as const));

  const seenPairs = new Set<string>();
  for (const cell of cm.cells) {
    const pairKey = `${cell.xKey}::${cell.yKey}`;
    if (!expectedPairs.has(pairKey)) {
      throw new StatsEngineResultInvalidError(`unexpected pair in correlation matrix result: ${cell.xKey}/${cell.yKey}`);
    }
    if (seenPairs.has(pairKey)) {
      throw new StatsEngineResultInvalidError(`duplicate pair in correlation matrix result: ${cell.xKey}/${cell.yKey}`);
    }
    seenPairs.add(pairKey);

    const xValues = valuesByKey.get(cell.xKey)!;
    const yValues = valuesByKey.get(cell.yKey)!;
    let expectedN = 0;
    for (let i = 0; i < xValues.length; i += 1) {
      if (xValues[i] !== null && yValues[i] !== null) expectedN += 1;
    }
    if (cell.n !== expectedN) {
      throw new StatsEngineResultInvalidError(`n mismatch for pair ${cell.xKey}/${cell.yKey}: expected ${expectedN}, got ${cell.n}`);
    }
    if (cell.r !== null && (cell.r < -1.0000001 || cell.r > 1.0000001)) {
      throw new StatsEngineResultInvalidError(`r out of range for pair ${cell.xKey}/${cell.yKey}: ${cell.r}`);
    }
    if (cell.pValue !== null && (cell.pValue < 0 || cell.pValue > 1)) {
      throw new StatsEngineResultInvalidError(`pValue out of range for pair ${cell.xKey}/${cell.yKey}: ${cell.pValue}`);
    }
  }
  if (seenPairs.size !== expectedPairs.size) {
    throw new StatsEngineResultInvalidError('missing pair(s) in correlation matrix result');
  }
}


export async function runCorrelationMatrixStatsEngine(
  request: CorrelationMatrixEngineRequest,
  opts?: EngineRunOpts,
): Promise<StatsEngineCorrelationMatrixRawResult> {
  return runEngineProcess<StatsEngineCorrelationMatrixRawResult>({
    assertLimits: () => assertCorrelationMatrixWithinLimits(request),
    buildStdinPayload: () => ({ protocolVersion: ENGINE_PROTOCOL_VERSION, correlationMatrix: request }),
    parseSuccess: (parsed) => {
      const shapeResult = StatsEngineCorrelationMatrixRawResultSchema.safeParse(parsed);
      if (!shapeResult.success) {
        throw new StatsEngineResultInvalidError(`결과 schema 재검증 실패: ${shapeResult.error.message}`);
      }
      validateCorrelationMatrixSemantics(request, shapeResult.data);
      return shapeResult.data.correlationMatrix;
    },
    ...opts,
  });
}
