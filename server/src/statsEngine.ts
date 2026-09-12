// PR1 — Python subprocess worker spawn wrapper. 계획서(pr1-giggly-treehouse.md) §2 참고.
// 6차례 검토를 거친 프로세스 생명주기 설계를 그대로 구현한다 — 핵심 불변식:
//   1) 완료 판정은 오직 'close' 이벤트에서만 한다(stdout 유실 방지, exit는 쓰지 않음).
//   2) 모든 종료 시도는 requestTermination() 하나로 모은다(kill() 재귀 방지).
//   3) 세마포어 슬롯 반환은 오직 'close'(정상) 또는 최종 안전 타이머(비정상, 미반환)에서만.
//   4) requestSettled(호출자에게 확정 알림)와 processClosed(OS가 실제 종료 확인)를 분리한다.
import { spawn } from 'child_process';
import path from 'path';
import { z } from 'zod';
import config from './config';
import { MAX_STRING_LENGTH, MAX_TOTAL_VALUES, MAX_VALUES_PER_VARIABLE } from './statsEngineLimits';

export type StatsEngineVariableKind = 'continuous' | 'discrete';

export interface StatsEngineVariable {
  key: string;
  kind: StatsEngineVariableKind;
  values: Array<number | string | boolean>;
}

export interface StatsEngineRequest {
  variables: StatsEngineVariable[];
}

// PR3-A — 이변량 3-shape 요청(계획서 §"Node→Python 3-shape"). Node가 그룹핑/
// 교차집계까지 전부 끝낸 뒤 보낸다 — Python은 카탈로그를 모른다는 기존 원칙 확장.
export type BivariateMethodId =
  | 'welch_t' | 'mann_whitney' | 'anova' | 'kruskal_wallis'
  | 'chi_square' | 'fisher_exact'
  | 'pearson_correlation' | 'spearman_correlation';
  // paired_t/wilcoxon_signed_rank는 이 엔진에 절대 보내지 않는다 — Node의
  // statsMethodCatalog A-사유(PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING)가 항상
  // 사전에 막는다(현재 카탈로그에 대응 메타데이터가 없음).

export interface BivariateGroupsRequest {
  method: 'welch_t' | 'mann_whitney' | 'anova' | 'kruskal_wallis';
  groups: Array<{ label: string | boolean; values: number[] }>;
}
export interface BivariateTableRequest {
  method: 'chi_square' | 'fisher_exact';
  table: number[][];
  rowLabels: Array<string | boolean>;
  colLabels: Array<string | boolean>;
}
export interface BivariateCorrelationRequest {
  method: 'pearson_correlation' | 'spearman_correlation';
  x: number[];
  y: number[];
}
export type BivariateEngineRequest = BivariateGroupsRequest | BivariateTableRequest | BivariateCorrelationRequest;

// PR3-B — 상관행렬 3-shape 추가(계획서 §4). row-aligned 배열을 변수당 1개씩만
// 보낸다 — pair마다 복제 전송하지 않는다(payload O(k·n), 복제 시 O(k²·n)이 되는
// 것을 피함). Python이 pair마다 pairwise-complete 필터링을 수행한다.
export interface CorrelationMatrixEngineVariable {
  key: string;
  values: Array<number | null>;
}
export interface CorrelationMatrixEngineRequest {
  method: 'pearson_correlation' | 'spearman_correlation';
  variables: CorrelationMatrixEngineVariable[];
}

const StatsEngineNullReasonSchema = z.enum(['insufficient_data', 'undefined_zero_variance', 'non_finite_result']);
// PR3-A — bivariate.py의 nullReasons는 기존 3종 + 이변량 전용 2종(계획서 §Python엔진).
const StatsEngineBivariateNullReasonSchema = z.enum([
  'insufficient_data', 'undefined_zero_variance', 'non_finite_result',
  'constant_variable', 'insufficient_group_data',
]);

// 7차 검토 필수 수정 — .finite()가 빠져 있으면 JSON.parse('1e400') 같은 값이 Infinity로
// 파싱돼 z.number()를 그대로 통과한다(typeof Infinity === 'number'). 이후 canonicalDigest가
// NaN/Infinity에서 throw하는데 그 지점이 실패 분류 try/catch 밖이라 감사·failed 기록이
// 누락되는 경로로 이어졌다 — 여기서 막아 정상적으로 RESULT_SCHEMA_INVALID로 분류되게 한다.
const finiteNullable = () => z.number().finite().nullable();

// PR3-B — 히스토그램/박스플롯(계획서 §2/§3). Python은 person을 모른 채 정직하게
// 전부 계산해 반환한다 — 소수셀 판정(person 단위)은 statsChartDisclosure.ts가
// 이 원시 결과를 받은 뒤 별도로 수행한다. n=0(계산 불가)이면 Python이 둘 다
// null로 반환하므로 nullable(optional 아님 — 키는 항상 존재).
const StatsEngineHistogramBinSchema = z.object({
  lower: z.number().finite(),
  upper: z.number().finite(),
  count: z.number().int().nonnegative(),
});
const StatsEngineHistogramSchema = z.object({
  bins: z.array(StatsEngineHistogramBinSchema),
});
const StatsEngineBoxplotSchema = z.object({
  q1: z.number().finite(),
  median: z.number().finite(),
  q3: z.number().finite(),
  lowerWhisker: z.number().finite(),
  upperWhisker: z.number().finite(),
  lowerFence: z.number().finite(),
  upperFence: z.number().finite(),
  outlierCount: z.number().int().nonnegative(),
  outlierValues: z.array(z.number().finite()),
});

const StatsEngineContinuousResultSchema = z.object({
  variableKey: z.string(),
  n: z.number().int().nonnegative(),
  mean: finiteNullable(),
  sd: finiteNullable(),
  median: finiteNullable(),
  q1: finiteNullable(),
  q3: finiteNullable(),
  iqr: finiteNullable(),
  skewness: finiteNullable(),
  kurtosis: finiteNullable(),
  min: finiteNullable(),
  max: finiteNullable(),
  nullReasons: z.record(z.string(), StatsEngineNullReasonSchema),
  histogram: StatsEngineHistogramSchema.nullable(),
  boxplot: StatsEngineBoxplotSchema.nullable(),
});

const StatsEngineDiscreteLevelSchema = z.object({
  level: z.union([z.string(), z.boolean()]),
  count: z.number().int().nonnegative(),
});

const StatsEngineDiscreteResultSchema = z.object({
  variableKey: z.string(),
  n: z.number().int().nonnegative(),
  levels: z.array(StatsEngineDiscreteLevelSchema),
});

const StatsEngineRawResultSchema = z.object({
  protocolVersion: z.literal(3),
  continuous: z.array(StatsEngineContinuousResultSchema),
  discrete: z.array(StatsEngineDiscreteResultSchema),
}).strict();

export type StatsEngineContinuousResult = z.infer<typeof StatsEngineContinuousResultSchema>;
export type StatsEngineDiscreteResult   = z.infer<typeof StatsEngineDiscreteResultSchema>;
export interface StatsEngineRawResult {
  continuous: StatsEngineContinuousResult[];
  discrete: StatsEngineDiscreteResult[];
}

// PR3-A — bivariate.py의 공통 envelope(계획서 §Python엔진 "공통 결과 envelope").
// 원시 x/y·caseId·personClusterKey 필드는 이 스키마 어디에도 선언하지 않는다 —
// Python이 실수로 그런 필드를 되돌려도 구조적으로 통과할 수 없다(defense-in-depth,
// 계획서 §"새 프로토콜의 입력상한·의미검증" "결과" 행).
const StatsEngineEffectSizeSchema = z.object({
  name: z.string(),
  value: z.number().finite().nullable(),
  ci: z.tuple([z.number().finite(), z.number().finite()]).nullable(),
  ciUnavailableReason: z.enum(['not_supported_v1', 'undefined_at_n', 'perfect_correlation']).nullable(),
});

const StatsEngineBivariateRawResultSchema = z.object({
  protocolVersion: z.literal(3),
  bivariate: z.object({
    method: z.enum([
      'welch_t', 'mann_whitney', 'anova', 'kruskal_wallis',
      'chi_square', 'fisher_exact',
      'pearson_correlation', 'spearman_correlation',
    ]),
    n: z.number().int().nonnegative(),
    statistic: z.number().finite().nullable(),
    df: z.union([
      z.number().finite(),
      z.object({ numerator: z.number().finite(), denominator: z.number().finite() }).strict(),
    ]).nullable(),
    pValue: z.number().finite().nullable(),
    effectSizes: z.array(StatsEngineEffectSizeSchema),
    nullReasons: z.record(z.string(), StatsEngineBivariateNullReasonSchema),
    multipleTesting: z.object({
      method: z.literal('none'),
      adjustedP: z.number().finite().nullable(),
    }).strict(),
    qualityFlags: z.array(z.enum(['low_expected_count', 'haldane_anscombe_applied'])),
    extra: z.record(z.string(), StatsEngineEffectSizeSchema),
    // PR3-B — pearson_correlation/spearman_correlation만 이 키를 채운다(형제
    // 필드, extra 안이 아님 — extra는 효과크기 shape 전용). 다른 6개 method는
    // 이 키 자체를 안 만들므로 optional(부재 허용, .strict()와 충돌 안 함).
    regressionLine: z.object({
      slope: z.number().finite(),
      intercept: z.number().finite(),
    }).nullable().optional(),
    // PR3-B — 그룹비교 4개 method(welch_t/mann_whitney/anova/kruskal_wallis)만
    // 이 키를 채운다(계획서 §5). 억제 여부와 무관하게 Python은 항상 정직하게
    // 계산 — 노출은 statsBivariateSuppression.ts가 기존 그룹 게이트로 결정한다.
    groupBoxplots: z.array(z.object({
      label: z.union([z.string(), z.boolean()]),
      boxplot: StatsEngineBoxplotSchema.nullable(),
    })).optional(),
  }).strict(),
}).strict();

export type StatsEngineEffectSize = z.infer<typeof StatsEngineEffectSizeSchema>;
export type StatsEngineBivariateRawResult = z.infer<typeof StatsEngineBivariateRawResultSchema>['bivariate'];

export class StatsEngineBusyError extends Error {
  constructor() { super('stats engine worker slot is busy'); this.name = 'StatsEngineBusyError'; }
}
export class StatsEngineTimeoutError extends Error {
  constructor() { super('stats engine process timed out'); this.name = 'StatsEngineTimeoutError'; }
}
export class StatsEngineOutputTooLargeError extends Error {
  constructor() { super('stats engine process output exceeded size limit'); this.name = 'StatsEngineOutputTooLargeError'; }
}
export class StatsEngineProcessError extends Error {
  public code: 'PROCESS_ERROR' | 'INVALID_OUTPUT';
  constructor(code: 'PROCESS_ERROR' | 'INVALID_OUTPUT', message: string) {
    super(message);
    this.name = 'StatsEngineProcessError';
    this.code = code;
  }
}
export class StatsEngineResultInvalidError extends Error {
  constructor(message: string) { super(message); this.name = 'StatsEngineResultInvalidError'; }
}
// §2.1 최종 안전 타이머가 발동한 뒤 — 엔진 상태가 불확실해 신뢰 회복까지(서버 재시작)
// 신규 작업을 받지 않는다. 자동 복구는 PR1 범위 밖(PR2 검토 대상).
export class StatsEngineDegradedError extends Error {
  constructor() { super('stats engine is degraded — process termination could not be confirmed'); this.name = 'StatsEngineDegradedError'; }
}
// §7.4 — spawn 전 입력 상한 위반(변수당/총합/문자열길이/전체 바이트). 세마포어를 건드리지
// 않는 순수 입력 검증 실패라 §5 표의 INPUT_TOO_LARGE(감사만, stats_runs 행 없음)로 매핑된다.
export class StatsEngineInputTooLargeError extends Error {
  constructor(message: string) { super(message); this.name = 'StatsEngineInputTooLargeError'; }
}

function assertWithinLimits(request: StatsEngineRequest): void {
  let total = 0;
  for (const v of request.variables) {
    if (v.values.length > MAX_VALUES_PER_VARIABLE) {
      throw new StatsEngineInputTooLargeError(
        `variable '${v.key}' has ${v.values.length} values, exceeds MAX_VALUES_PER_VARIABLE(${MAX_VALUES_PER_VARIABLE})`,
      );
    }
    for (const value of v.values) {
      if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
        throw new StatsEngineInputTooLargeError(
          `variable '${v.key}' has a string value exceeding MAX_STRING_LENGTH(${MAX_STRING_LENGTH})`,
        );
      }
    }
    total += v.values.length;
  }
  if (total > MAX_TOTAL_VALUES) {
    throw new StatsEngineInputTooLargeError(`total values (${total}) exceeds MAX_TOTAL_VALUES(${MAX_TOTAL_VALUES})`);
  }
  const byteLength = Buffer.byteLength(JSON.stringify({ protocolVersion: 3, variables: request.variables }), 'utf8');
  if (byteLength > config.stats.maxInputBytes) {
    throw new StatsEngineInputTooLargeError(`serialized input (${byteLength} bytes) exceeds maxInputBytes(${config.stats.maxInputBytes})`);
  }
}

// PR3-A — 계획서 §"새 프로토콜의 입력상한·의미검증" 표를 그대로 구현. groups는
// "그룹 전체 합"(그룹당이 아님 — 이변량은 그룹들 합쳐서 변수 하나 취급),
// table은 "sum(모든 셀)"에 같은 상한을 적용(작은 JSON으로 큰 관측수를 표현할 수
// 있어 상한 자체가 필요, 정합성 검사와는 별개).
function assertBivariateWithinLimits(request: BivariateEngineRequest): void {
  const byteLength = Buffer.byteLength(JSON.stringify({ protocolVersion: 3, bivariate: request }), 'utf8');
  if (byteLength > config.stats.maxInputBytes) {
    throw new StatsEngineInputTooLargeError(`serialized input (${byteLength} bytes) exceeds maxInputBytes(${config.stats.maxInputBytes})`);
  }

  if ('groups' in request) {
    const total = request.groups.reduce((sum, g) => sum + g.values.length, 0);
    if (total > MAX_VALUES_PER_VARIABLE) {
      throw new StatsEngineInputTooLargeError(
        `groups 전체 값 개수 합(${total})이 상한(${MAX_VALUES_PER_VARIABLE})을 초과`,
      );
    }
    return;
  }
  if ('table' in request) {
    const cellSum = request.table.reduce((sum, row) => sum + row.reduce((s, c) => s + c, 0), 0);
    if (cellSum > MAX_VALUES_PER_VARIABLE) {
      throw new StatsEngineInputTooLargeError(
        `table 셀 합계(${cellSum})가 상한(${MAX_VALUES_PER_VARIABLE})을 초과`,
      );
    }
    return;
  }
  // x/y(상관) — 길이가 이미 같다는 전제는 호출자(buildBivariateEngineRequest)가 보장.
  if (request.x.length > MAX_VALUES_PER_VARIABLE) {
    throw new StatsEngineInputTooLargeError(
      `x/y 값 개수(${request.x.length})가 상한(${MAX_VALUES_PER_VARIABLE})을 초과`,
    );
  }
}

// PR3-B — 상관행렬 입력상한(계획서 §8). 값 개수 상한은 기존 "variables" shape과
// 동일한 MAX_TOTAL_VALUES를 재사용한다(상관행렬 전용 새 상수를 두지 않는다).
// 바이트 길이 상한(config.stats.maxInputBytes)은 그것과 완전히 별개로 항상
// 이중 검사한다 — 20변수×17,500행처럼 값 개수 상한은 통과해도 직렬화 바이트가
// 기본 2MiB를 넘는 조합이 실제로 있다(리뷰로 확인). 검사 순서는 기존
// assertWithinLimits와 동일하게 값 개수 → 바이트 길이.
function assertCorrelationMatrixWithinLimits(request: CorrelationMatrixEngineRequest): void {
  let total = 0;
  for (const v of request.variables) {
    if (v.values.length > MAX_VALUES_PER_VARIABLE) {
      throw new StatsEngineInputTooLargeError(
        `variable '${v.key}' has ${v.values.length} values, exceeds MAX_VALUES_PER_VARIABLE(${MAX_VALUES_PER_VARIABLE})`,
      );
    }
    total += v.values.length;
  }
  if (total > MAX_TOTAL_VALUES) {
    throw new StatsEngineInputTooLargeError(`total values (${total}) exceeds MAX_TOTAL_VALUES(${MAX_TOTAL_VALUES})`);
  }
  const byteLength = Buffer.byteLength(JSON.stringify({ protocolVersion: 3, correlationMatrix: request }), 'utf8');
  if (byteLength > config.stats.maxInputBytes) {
    throw new StatsEngineInputTooLargeError(`serialized input (${byteLength} bytes) exceeds maxInputBytes(${config.stats.maxInputBytes})`);
  }
}

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

// PR3-B — 상관행렬 결과(계획서 §4, 4차 코드리뷰로 단순화). r/pValue/adjustedP는
// Python이 계산 불가(상수·표본부족)면 null — 이 raw 스키마 단계에서는 아직
// disclosure(소수셀·§6.1 반복측정 게이트) 적용 전이다. statsCorrelationMatrixSuppression.ts
// 가 이 raw 결과를 받아 공개 여부를 최종 결정한다.
const StatsEngineCorrelationMatrixCellSchema = z.object({
  xKey: z.string(),
  yKey: z.string(),
  n: z.number().int().nonnegative(),
  r: z.number().finite().nullable(),
  pValue: z.number().finite().nullable(),
  adjustedP: z.number().finite().nullable(),
});
const StatsEngineCorrelationMatrixRawResultSchema = z.object({
  protocolVersion: z.literal(3),
  correlationMatrix: z.object({
    method: z.enum(['pearson_correlation', 'spearman_correlation']),
    cells: z.array(StatsEngineCorrelationMatrixCellSchema),
  }).strict(),
}).strict();

export type StatsEngineCorrelationMatrixCell = z.infer<typeof StatsEngineCorrelationMatrixCellSchema>;
export type StatsEngineCorrelationMatrixRawResult = z.infer<typeof StatsEngineCorrelationMatrixRawResultSchema>['correlationMatrix'];

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

// ---------------------------------------------------------------------------
// 모듈 레벨 상태(가드C 세마포어 + degraded 플래그) — 의도적으로 프로세스 전역이다.
// ---------------------------------------------------------------------------
let inFlightCount = 0;
let engineDegraded = false;

/** 테스트 전용 — 모듈 상태를 초기화한다. */
export function __resetStatsEngineForTests(): void {
  inFlightCount = 0;
  engineDegraded = false;
}

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

interface RecordedOutcome {
  kind: 'spawn_error' | 'stdin_error' | 'timeout' | 'output_too_large';
  detail?: string;
}

// PR3-A — descriptive/bivariate 두 경로가 spawn·타이머·세마포어·listener 생명주기를
// 전부 동일하게 공유한다(6차례 검토를 거친 로직, 변경 없음). 달라지는 3가지(입력상한
// 검사·stdin payload·stdout 성공 파싱)만 파라미터로 뺀다 — 로직을 복제하면 한쪽만
// 고치는 버그가 생기기 쉽다.
interface EngineRunConfig<T> {
  assertLimits: () => void;
  buildStdinPayload: () => unknown;
  /** zod shape + 의미검증까지 끝내고 최종 반환값을 만든다. 실패 시 throw
   * (StatsEngineResultInvalidError 권장 — 그대로 reject된다). */
  parseSuccess: (parsed: unknown) => T;
}

async function runEngineProcess<T>(cfg: EngineRunConfig<T>): Promise<T> {
  cfg.assertLimits();
  if (engineDegraded) {
    throw new StatsEngineDegradedError();
  }
  if (inFlightCount >= config.stats.maxConcurrency) {
    throw new StatsEngineBusyError();
  }
  inFlightCount += 1;

  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    inFlightCount = Math.max(0, inFlightCount - 1);
  };

  return new Promise<T>((resolve, reject) => {
    const scriptPath = path.join(config.stats.scriptsDir, 'analyze.py');
    const env = {
      ...process.env,
      OMP_NUM_THREADS: '1',
      OPENBLAS_NUM_THREADS: '1',
      MKL_NUM_THREADS: '1',
      NUMEXPR_NUM_THREADS: '1',
      VECLIB_MAXIMUM_THREADS: '1',
    };

    // 7차 검토 필수 수정 — spawn() 자체가 동기적으로 throw할 수 있다(예: 잘못된 옵션,
    // 플랫폼별 ENOENT가 비동기 'error' 대신 동기 예외로 오는 경우). 이 시점엔 아직 아무
    // 리스너도 등록 전이라 'close'가 절대 오지 않으므로, 여기서 못 잡으면 슬롯이 영구
    // 누수되고 이후 모든 요청이 StatsEngineBusyError로 막힌다(실제 재현됨).
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(config.stats.python, [scriptPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      releaseSlot();
      reject(new StatsEngineProcessError('PROCESS_ERROR', err instanceof Error ? err.message : 'spawn 실패'));
      return;
    }

    let recordedOutcome: RecordedOutcome | null = null;
    let requestSettled = false;
    let processClosed = false;
    let terminationRequested = false;
    let graceTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let safetyTimer: NodeJS.Timeout | null = null;

    let stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrChunks: Buffer[] = [];
    let stderrBytes = 0;

    const clearAllTimers = () => {
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    };

    const removeAllListeners = () => {
      child.removeAllListeners();
      child.stdin?.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
    };

    // §2.1 — 모든 종료 시도의 단일 진입점. terminationRequested를 kill() 호출 '전에'
    // 세워 재귀(kill 실패로 인한 동기 'error' 재발생 포함)를 끊는다.
    function requestTermination(signal: 'SIGTERM' | 'SIGKILL') {
      if (terminationRequested) return;
      terminationRequested = true;
      try { child.kill(signal); } catch { /* 동기 throw 무시 — 별도 기록 불필요 */ }
      graceTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 무시 */ }
      }, config.stats.killGraceMs);
    }

    // 정상 확정(오직 'close'에서만 호출) — recordedOutcome/exitCode로 분기.
    function finish(exitCode: number | null) {
      requestSettled = true;
      clearAllTimers();
      releaseSlot();
      removeAllListeners();

      if (recordedOutcome) {
        switch (recordedOutcome.kind) {
          case 'timeout':
            reject(new StatsEngineTimeoutError());
            return;
          case 'output_too_large':
            reject(new StatsEngineOutputTooLargeError());
            return;
          case 'spawn_error':
          case 'stdin_error':
            reject(new StatsEngineProcessError('PROCESS_ERROR', recordedOutcome.detail ?? recordedOutcome.kind));
            return;
        }
      }

      if (exitCode === 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8'));
        } catch {
          reject(new StatsEngineProcessError('INVALID_OUTPUT', 'stdout이 유효한 JSON이 아님'));
          return;
        }
        try {
          resolve(cfg.parseSuccess(parsed));
        } catch (err) {
          reject(err instanceof Error ? err : new StatsEngineResultInvalidError(String(err)));
        }
        return;
      }

      // 비정상 종료 — stderr의 STATS_ENGINE_ERROR 마커를 파싱(진단용 detail은 서버
      // 로그로만 남기고 이 에러 객체를 통해 호출자에게 원문을 노출하지 않는다).
      const stderrText = Buffer.concat(stderrChunks).toString('utf8');
      const markerMatch = stderrText.match(/STATS_ENGINE_ERROR (\{.*\})/);
      if (markerMatch) {
        console.error('[stats-engine] process error marker:', markerMatch[1]);
      } else if (stderrText) {
        console.error('[stats-engine] process exited non-zero with stderr:', stderrText.slice(0, 2000));
      }
      reject(new StatsEngineProcessError('PROCESS_ERROR', `stats-engine 프로세스가 code ${exitCode}로 종료됨`));
    }

    child.on('error', (err) => {
      recordedOutcome ??= { kind: 'spawn_error', detail: err.message };
      requestTermination('SIGTERM');
    });

    child.stdin?.on('error', (err) => {
      recordedOutcome ??= { kind: 'stdin_error', detail: err.message };
      requestTermination('SIGTERM');
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (recordedOutcome?.kind === 'output_too_large') return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > config.stats.stdoutMaxBytes) {
        recordedOutcome ??= { kind: 'output_too_large' };
        stdoutChunks = [];
        requestTermination('SIGTERM');
        return;
      }
      stdoutChunks.push(chunk);
    });

    // 7차 검토 필수 수정 — 이전 판은 상한 초과 시 조용히 버리기만 하고 종료를 시도하지
    // 않아, stderr를 계속 흘려보내는 프로세스가 stdout만 정상이면 그대로 성공 처리됐다
    // (kill 없이 성공하는 게 실제 재현됨). stdout과 동일하게 kill+output_too_large로
    // 승격한다. 또한 문턱을 넘기는 그 chunk 자체를 통째로 저장하지 않는다 — 이전 판은
    // "누적 전 체크"라 문턱을 막 넘긴 큰 chunk가 그대로 들어가 실제 보관량이 상한을
    // 크게 초과할 수 있었다.
    child.stderr?.on('data', (chunk: Buffer) => {
      if (recordedOutcome?.kind === 'output_too_large') return;
      stderrBytes += chunk.length;
      if (stderrBytes > config.stats.stderrMaxBytes) {
        recordedOutcome ??= { kind: 'output_too_large' };
        stderrChunks = [];
        requestTermination('SIGTERM');
        return;
      }
      stderrChunks.push(chunk);
    });

    timeoutTimer = setTimeout(() => {
      recordedOutcome ??= { kind: 'timeout' };
      requestTermination('SIGTERM');
    }, config.stats.timeoutMs);

    // §2.1 최종 안전 타이머 — 'close'가 끝내 안 오면 요청을 실패로 1회 확정하되 슬롯은
    // 반환하지 않는다(프로세스가 실제로 끝났는지 모르므로) — 대신 엔진 전체를 격리한다.
    safetyTimer = setTimeout(() => {
      if (processClosed) return;
      requestSettled = true;
      clearAllTimers();
      engineDegraded = true;
      // 슬롯은 의도적으로 반환하지 않는다 — releaseSlot() 호출 없음.
      reject(new StatsEngineProcessError('PROCESS_ERROR', '프로세스 종료를 확인하지 못함(안전 타이머 발동)'));
      // 리스너는 해제하지 않는다 — 늦게 오는 'close'를 계속 듣고 아래에서 정리한다.
    }, config.stats.timeoutMs + config.stats.killGraceMs + 5000);

    child.once('close', (code) => {
      processClosed = true;
      if (requestSettled) {
        // 안전 타이머가 이미 확정한 뒤 늦게 온 close — Promise·슬롯·DB 저장은 다시
        // 만들지 않되 정리 작업(타이머·리스너)은 반드시 수행한다.
        clearAllTimers();
        console.warn('[stats-engine] degraded 유발 프로세스가 뒤늦게 실제로 종료됨(late close), engineDegraded는 유지됨');
        removeAllListeners();
        return;
      }
      finish(code);
    });

    try {
      const payload = JSON.stringify(cfg.buildStdinPayload());
      child.stdin?.end(payload, 'utf8');
    } catch (err) {
      recordedOutcome ??= { kind: 'stdin_error', detail: err instanceof Error ? err.message : String(err) };
      requestTermination('SIGTERM');
    }
  });
}

export async function runStatsEngine(request: StatsEngineRequest): Promise<StatsEngineRawResult> {
  return runEngineProcess<StatsEngineRawResult>({
    assertLimits: () => assertWithinLimits(request),
    buildStdinPayload: () => ({ protocolVersion: 3, variables: request.variables }),
    parseSuccess: (parsed) => {
      const shapeResult = StatsEngineRawResultSchema.safeParse(parsed);
      if (!shapeResult.success) {
        throw new StatsEngineResultInvalidError(`결과 schema 재검증 실패: ${shapeResult.error.message}`);
      }
      validateSemantics(request, shapeResult.data);
      return { continuous: shapeResult.data.continuous, discrete: shapeResult.data.discrete };
    },
  });
}

export async function runBivariateStatsEngine(request: BivariateEngineRequest): Promise<StatsEngineBivariateRawResult> {
  return runEngineProcess<StatsEngineBivariateRawResult>({
    assertLimits: () => assertBivariateWithinLimits(request),
    buildStdinPayload: () => ({ protocolVersion: 3, bivariate: request }),
    parseSuccess: (parsed) => {
      const shapeResult = StatsEngineBivariateRawResultSchema.safeParse(parsed);
      if (!shapeResult.success) {
        throw new StatsEngineResultInvalidError(`결과 schema 재검증 실패: ${shapeResult.error.message}`);
      }
      validateBivariateSemantics(request, shapeResult.data);
      return shapeResult.data.bivariate;
    },
  });
}

export async function runCorrelationMatrixStatsEngine(
  request: CorrelationMatrixEngineRequest,
): Promise<StatsEngineCorrelationMatrixRawResult> {
  return runEngineProcess<StatsEngineCorrelationMatrixRawResult>({
    assertLimits: () => assertCorrelationMatrixWithinLimits(request),
    buildStdinPayload: () => ({ protocolVersion: 3, correlationMatrix: request }),
    parseSuccess: (parsed) => {
      const shapeResult = StatsEngineCorrelationMatrixRawResultSchema.safeParse(parsed);
      if (!shapeResult.success) {
        throw new StatsEngineResultInvalidError(`결과 schema 재검증 실패: ${shapeResult.error.message}`);
      }
      validateCorrelationMatrixSemantics(request, shapeResult.data);
      return shapeResult.data.correlationMatrix;
    },
  });
}
