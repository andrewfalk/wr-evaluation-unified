// Regression diagnostics engine call: semantic checks and runRegressionDiagnosticsEngine.
// Split out of stats/engine/index.ts (S6 P1-34); handler bodies unchanged.
import { z } from 'zod';
import { ENGINE_PROTOCOL_VERSION, RegressionDiagnosticsEngineRequest } from '../protocol';
import { StatsEngineRegressionDiagnosticsRawResultSchema, StatsEngineRegressionDiagnosticsRawResult } from '../responseSchemas';
import { StatsEngineResultInvalidError } from '../errors';
import { assertRegressionDiagnosticsWithinLimits } from '../limits';
import { runEngineProcess } from '../subprocess';

/** raw 진단 응답 검증 — points가 요청 sampledRowIndices와 정확히 같은 개수·
 * 순서인지, rowIndex가 요청한 인덱스와 일치하는지(엔진이 다른 행을 잘못
 * 돌려주는 결함을 조기에 잡는다). */
function validateRegressionDiagnosticsSemantics(
  request: RegressionDiagnosticsEngineRequest,
  raw: z.infer<typeof StatsEngineRegressionDiagnosticsRawResultSchema>,
): void {
  const rd = raw.regressionDiagnostics;
  if (!rd.pointDiagnosticsSupported) {
    if (rd.points.length !== 0) {
      throw new StatsEngineResultInvalidError('pointDiagnosticsSupported=false인데 points가 비어있지 않다');
    }
    return;
  }
  if (rd.points.length !== request.sampledRowIndices.length) {
    throw new StatsEngineResultInvalidError(
      `points 수 불일치: 요청 ${request.sampledRowIndices.length}개, 응답 ${rd.points.length}개`,
    );
  }
  request.sampledRowIndices.forEach((idx, i) => {
    if (rd.points[i].rowIndex !== idx) {
      throw new StatsEngineResultInvalidError(`points[${i}].rowIndex 불일치: 요청 ${idx}, 응답 ${rd.points[i].rowIndex}`);
    }
  });
}


// PR4-A2 — limited_row 진단 전용 경량 엔진 호출(재적합 없음). 캐시 hit/miss와
// 완전히 독립적인 (X,y,β)만의 순수 함수라 stats/disclosure/limitedRowMerge.ts가 매 요청마다
// hasAccess일 때만 호출한다(계획서 §4 "limited_row 진단값").
export async function runRegressionDiagnosticsEngine(
  request: RegressionDiagnosticsEngineRequest,
): Promise<StatsEngineRegressionDiagnosticsRawResult> {
  return runEngineProcess<StatsEngineRegressionDiagnosticsRawResult>({
    assertLimits: () => assertRegressionDiagnosticsWithinLimits(request),
    buildStdinPayload: () => ({ protocolVersion: ENGINE_PROTOCOL_VERSION, regressionDiagnostics: request }),
    parseSuccess: (parsed) => {
      const shapeResult = StatsEngineRegressionDiagnosticsRawResultSchema.safeParse(parsed);
      if (!shapeResult.success) {
        throw new StatsEngineResultInvalidError(`결과 schema 재검증 실패: ${shapeResult.error.message}`);
      }
      validateRegressionDiagnosticsSemantics(request, shapeResult.data);
      return shapeResult.data.regressionDiagnostics;
    },
  });
}
