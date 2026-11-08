// Bivariate engine call: semantic checks of the raw result and runBivariateStatsEngine.
// Split out of stats/engine/index.ts (S6 P1-34); handler bodies unchanged.
import { z } from 'zod';
import { ENGINE_PROTOCOL_VERSION, BivariateEngineRequest } from '../protocol';
import { StatsEngineBivariateRawResultSchema, StatsEngineBivariateRawResult } from '../responseSchemas';
import { StatsEngineResultInvalidError } from '../errors';
import { assertBivariateWithinLimits } from '../limits';
import { runEngineProcess, EngineRunOpts } from '../subprocess';

/** §Python엔진 의미검증(descriptive의 validateSemantics와 대칭) — method/n이
 * 요청과 일치하는지, 그룹/셀 합계가 요청과 일치하는지 확인한다. */
function validateBivariateSemantics(
  request: BivariateEngineRequest,
  raw: z.infer<typeof StatsEngineBivariateRawResultSchema>,
): void {
  const b = raw.bivariate;
  if (b.method !== request.method) {
    throw new StatsEngineResultInvalidError(`method mismatch: requested ${request.method}, got ${b.method}`);
  }
  let expectedN: number;
  if ('groups' in request) {
    expectedN = request.groups.reduce((sum, g) => sum + g.values.length, 0);
  } else if ('table' in request) {
    expectedN = request.table.reduce((sum, row) => sum + row.reduce((s, c) => s + c, 0), 0);
  } else {
    expectedN = request.x.length;
  }
  if (b.n !== expectedN) {
    throw new StatsEngineResultInvalidError(`n mismatch: expected ${expectedN}, got ${b.n}`);
  }
}


export async function runBivariateStatsEngine(
  request: BivariateEngineRequest,
  opts?: EngineRunOpts,
): Promise<StatsEngineBivariateRawResult> {
  return runEngineProcess<StatsEngineBivariateRawResult>({
    assertLimits: () => assertBivariateWithinLimits(request),
    buildStdinPayload: () => ({ protocolVersion: ENGINE_PROTOCOL_VERSION, bivariate: request }),
    parseSuccess: (parsed) => {
      const shapeResult = StatsEngineBivariateRawResultSchema.safeParse(parsed);
      if (!shapeResult.success) {
        throw new StatsEngineResultInvalidError(`결과 schema 재검증 실패: ${shapeResult.error.message}`);
      }
      validateBivariateSemantics(request, shapeResult.data);
      return shapeResult.data.bivariate;
    },
    ...opts,
  });
}
