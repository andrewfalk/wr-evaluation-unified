// Descriptive engine call: semantic checks of the raw result and runStatsEngine.
// Split out of stats/engine/index.ts (S6 P1-34); handler bodies unchanged.
import { z } from 'zod';
import { ENGINE_PROTOCOL_VERSION, StatsEngineVariableKind, StatsEngineRequest } from '../protocol';
import { StatsEngineRawResultSchema, StatsEngineRawResult } from '../responseSchemas';
import { StatsEngineResultInvalidError } from '../errors';
import { assertWithinLimits } from '../limits';
import { runEngineProcess, EngineRunOpts } from '../subprocess';

/** §2.2 — zod shape 통과 후 추가 의미 검증. 위반 시 StatsEngineResultInvalidError. */
function validateSemantics(request: StatsEngineRequest, raw: z.infer<typeof StatsEngineRawResultSchema>): void {
  const requestedByKind = new Map<string, StatsEngineVariableKind>();
  const requestedLength = new Map<string, number>();
  for (const v of request.variables) {
    requestedByKind.set(v.key, v.kind);
    requestedLength.set(v.key, v.values.length);
  }

  // 7차 검토 필수 수정 — seen.add()만 하고 has() 검사가 없으면 같은 변수 결과가 두 번
  // 와도 최종 집합 크기(size)만 비교하는 아래 검사를 우회한다(중복 2개=1개로 뭉개짐).
  const seen = new Set<string>();
  for (const c of raw.continuous) {
    if (requestedByKind.get(c.variableKey) !== 'continuous') {
      throw new StatsEngineResultInvalidError(`unexpected or kind-mismatched key in continuous result: ${c.variableKey}`);
    }
    if (seen.has(c.variableKey)) {
      throw new StatsEngineResultInvalidError(`duplicate result for variable: ${c.variableKey}`);
    }
    if (c.n !== requestedLength.get(c.variableKey)) {
      throw new StatsEngineResultInvalidError(`n mismatch for ${c.variableKey}: expected ${requestedLength.get(c.variableKey)}, got ${c.n}`);
    }
    seen.add(c.variableKey);
  }
  for (const d of raw.discrete) {
    if (requestedByKind.get(d.variableKey) !== 'discrete') {
      throw new StatsEngineResultInvalidError(`unexpected or kind-mismatched key in discrete result: ${d.variableKey}`);
    }
    if (seen.has(d.variableKey)) {
      throw new StatsEngineResultInvalidError(`duplicate result for variable: ${d.variableKey}`);
    }
    if (d.n !== requestedLength.get(d.variableKey)) {
      throw new StatsEngineResultInvalidError(`n mismatch for ${d.variableKey}: expected ${requestedLength.get(d.variableKey)}, got ${d.n}`);
    }
    const levelKeys = new Set<string>();
    let sum = 0;
    for (const lvl of d.levels) {
      const levelKey = `${typeof lvl.level}:${String(lvl.level)}`;
      if (levelKeys.has(levelKey)) {
        throw new StatsEngineResultInvalidError(`duplicate level for ${d.variableKey}: ${String(lvl.level)}`);
      }
      levelKeys.add(levelKey);
      sum += lvl.count;
    }
    if (sum !== d.n) {
      throw new StatsEngineResultInvalidError(`levels count sum (${sum}) !== n (${d.n}) for ${d.variableKey}`);
    }
    seen.add(d.variableKey);
  }

  if (seen.size !== requestedByKind.size) {
    const missing = [...requestedByKind.keys()].filter((k) => !seen.has(k));
    throw new StatsEngineResultInvalidError(`missing variable(s) in result: ${missing.join(', ')}`);
  }
}


export async function runStatsEngine(request: StatsEngineRequest, opts?: EngineRunOpts): Promise<StatsEngineRawResult> {
  return runEngineProcess<StatsEngineRawResult>({
    assertLimits: () => assertWithinLimits(request),
    buildStdinPayload: () => ({ protocolVersion: ENGINE_PROTOCOL_VERSION, variables: request.variables }),
    parseSuccess: (parsed) => {
      const shapeResult = StatsEngineRawResultSchema.safeParse(parsed);
      if (!shapeResult.success) {
        throw new StatsEngineResultInvalidError(`결과 schema 재검증 실패: ${shapeResult.error.message}`);
      }
      validateSemantics(request, shapeResult.data);
      return { continuous: shapeResult.data.continuous, discrete: shapeResult.data.discrete };
    },
    ...opts,
  });
}
