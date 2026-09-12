// PR3-B — 상관행렬 pair별 disclosure 판정을 위한 데이터셋 유틸(계획서 §4/§8).
//
// (코드리뷰 수정 1차, 2026-09-11) 처음엔 2변수 전용 buildPairedDataset()을 모든
// C(k,2) 조합에 그대로 재사용했는데, 그 함수는 판정에 쓰지도 않는 원시 행 배열
// (PairedRow[] — caseId/personClusterKey/x/y)까지 pair마다 통째로 만들어 Map에
// 담아뒀다. 실측: k=20/rows=1,000이면 190쌍×1,000행=190,000개 PairedRow 객체가
// 요청 하나의 context 안에 동시에 쌓이고, rows=17,500(§8의 "두 상한 이내 최대
// 입력")이면 332만 5천 개까지 늘어난다. 정작 statsCorrelationMatrixSuppression.ts가
// pair마다 읽는 건 includedPersonCount/excludedPersonCount/includedCaseCount
// 세 숫자뿐(evaluateBivariateDisclosure/evaluateInferenceGate 둘 다 원시 행을
// 안 봄) — 그래서 summarizeCorrelationMatrixPair()로 원시 배열을 아예 만들지
// 않고 Set 2개(포함/제외 person)로만 세게 바꿨다(메모리는 O(rows)가 아니라
// O(고유 person 수)).
//
// (코드리뷰 수정 2차, 2026-09-11) 1차 수정 때는 "값 개수(변수 수×행 수)"만 O(1)로
// 먼저 확인했는데, 리뷰가 반례를 지적: 3변수×60,000행처럼 총 값개수(180,000)는
// MAX_TOTAL_VALUES(350,000) 이내라도 행 수 자체(60,000)가 변수당 상한
// (MAX_VALUES_PER_VARIABLE=50,000)을 넘는 입력은 여전히 이 O(k²×rows) 순회를
// 통과한 뒤 Python payload 조립 시점에야 거부됐다. 바이트 길이 상한도 마찬가지로
// 순회 이후에만 검사됐다. evaluateCorrelationMatrixInputLimits()가 이제 세
// 상한(변수당 개수 O(1) → 총 개수 O(1) → 직렬화 바이트 O(k×rows))을 전부
// C(k,2) 순회 시작 *전에* 순서대로 확인하고, 통과 시 만들어둔 변수별 값 배열을
// 그대로 반환해 statsCorrelationMatrixSuppression.ts가 Python 요청 조립 시
// 재사용한다(같은 O(k×rows) 작업을 두 번 하지 않음).
import type { DatasetRow } from './statsDatasetBuilder';
import { MAX_TOTAL_VALUES, MAX_VALUES_PER_VARIABLE } from './statsEngineLimits';
import config from './config';

export function pairMapKey(xKey: string, yKey: string): string {
  return `${xKey}::${yKey}`;
}

export interface CorrelationMatrixPairKey {
  xKey: string;
  yKey: string;
}

/** 요청된 변수 키 배열의 모든 i<j 조합(대각선 제외·대칭 중복 제외). */
export function allCorrelationMatrixPairs(keys: string[]): CorrelationMatrixPairKey[] {
  const pairs: CorrelationMatrixPairKey[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      pairs.push({ xKey: keys[i], yKey: keys[j] });
    }
  }
  return pairs;
}

/** statsBivariateDisclosureGate/statsInferenceGate 판정에 필요한 카운트만 담은
 * 경량 요약 — 원시 pair 행 배열은 절대 보관하지 않는다. */
export interface CorrelationMatrixPairSummary {
  includedCaseCount: number;
  includedPersonCount: number;
  excludedPersonCount: number;
}

/** Python에 보낼 변수별 값 배열(method 제외 — method는 preview 시점엔 없을 수도
 * 있다). statsCorrelationMatrixSuppression.ts가 그대로 CorrelationMatrixEngineRequest.variables로
 * 사용한다 — 이 함수가 값 추출의 단일 진실원. */
export interface CorrelationMatrixVariable {
  key: string;
  values: Array<number | null>;
}

export function buildCorrelationMatrixVariables(rows: DatasetRow[], keys: string[]): CorrelationMatrixVariable[] {
  return keys.map((key) => ({
    key,
    values: rows.map((row) => {
      const extracted = row.values[key];
      if (!extracted || extracted.missing !== null || typeof extracted.value !== 'number') return null;
      return extracted.value;
    }),
  }));
}

export type CorrelationMatrixInputLimitViolation =
  | 'VALUES_PER_VARIABLE_EXCEEDED'
  | 'TOTAL_VALUES_EXCEEDED'
  | 'SERIALIZED_BYTES_EXCEEDED';

export type CorrelationMatrixInputLimitCheck =
  | { ok: true; variables: CorrelationMatrixVariable[] }
  | { ok: false; violation: CorrelationMatrixInputLimitViolation };

// 코드리뷰 수정 3차(2026-09-11) — "method/protocolVersion 래퍼는 수 바이트뿐이라
// 무시해도 영향 없다"는 1~2차 수정의 판단은 틀렸다. 리뷰가 정확한 경계값으로
// 실측: {variables}만 직렬화하면 2,097,152B(정확히 상한)인데, 실제 Python
// payload({protocolVersion:3, correlationMatrix:{method, variables}})는
// 2,097,225B — 73바이트 차이로 선검사는 통과하고 최종 wrapper 검사(Python spawn
// 직전)에서만 거부되는 경계 구간이 실재했다. "몇 바이트라 무시 가능"이라는 판단은
// 평균적인 경우 얘기지 상한 검사처럼 정확히 경계에서 동작해야 하는 로직에는
// 적용할 수 없다는 게 핵심 교훈 — 지금은 실제 전송될 envelope과 바이트 단위로
// 동일한 문자열을 만들어 측정한다(assertCorrelationMatrixWithinLimits의
// `{ protocolVersion: 3, correlationMatrix: request }` 그대로 재현).
const SUPPORTED_CORRELATION_METHODS = ['pearson_correlation', 'spearman_correlation'] as const;
// preview 시점엔 requestedMethod가 아직 선택 안 됐을 수 있다(§"preview는
// 관대하다") — 그럴 땐 두 method 중 문자열이 더 긴 쪽(spearman_correlation)을
// 가정해 측정한다. 실제 method가 무엇이든 그보다 짧거나 같으므로, 이 선검사가
// 통과하면 실제 요청도 반드시 상한 이내다(과대평가만 하지 과소평가는 안 함 —
// false negative 방지가 목적이라 안전한 방향으로만 치우친다).
const WORST_CASE_METHOD_FOR_BYTE_ESTIMATE = 'spearman_correlation' as const;

/** §8 "상한 검사는 C(k,2) 순회 시작 전에" — 세 상한(변수당 개수/총 개수/직렬화
 * 바이트)을 전부 buildCorrelationMatrixPairedDatasets() 호출 전에 확인한다.
 * 검사 순서는 statsEngine.ts의 assertCorrelationMatrixWithinLimits()와 동일
 * (변수당 → 총합 → 바이트) — 그쪽은 실제 Python spawn 직전의 최종 안전망으로
 * 그대로 남겨두고, 이 함수는 preview까지 포함해 훨씬 이른 시점에 같은 상한을
 * 선제 적용한다. 통과 시 만들어둔 variables를 반환해 호출자가 재사용하게 한다
 * (같은 O(k×rows) 추출을 두 번 하지 않기 위함). `method`는 recipe.requestedMethod
 * 그대로 전달(preview에서 미선택이면 undefined) — 최악 경우로 대체해 측정한다. */
export function evaluateCorrelationMatrixInputLimits(
  rows: DatasetRow[],
  keys: string[],
  method: (typeof SUPPORTED_CORRELATION_METHODS)[number] | undefined,
): CorrelationMatrixInputLimitCheck {
  // 상관행렬은 모든 변수가 같은 dataset.rows에서 뽑히므로 "변수당 값 개수"는
  // 항상 rows.length와 같다(변수마다 다르지 않음) — 곱셈보다도 먼저 O(1)로 확인.
  if (rows.length > MAX_VALUES_PER_VARIABLE) {
    return { ok: false, violation: 'VALUES_PER_VARIABLE_EXCEEDED' };
  }
  if (keys.length * rows.length > MAX_TOTAL_VALUES) {
    return { ok: false, violation: 'TOTAL_VALUES_EXCEEDED' };
  }
  const variables = buildCorrelationMatrixVariables(rows, keys);
  const envelopeMethod = method ?? WORST_CASE_METHOD_FOR_BYTE_ESTIMATE;
  const byteLength = Buffer.byteLength(
    JSON.stringify({ protocolVersion: 3, correlationMatrix: { method: envelopeMethod, variables } }),
    'utf8',
  );
  if (byteLength > config.stats.maxInputBytes) {
    return { ok: false, violation: 'SERIALIZED_BYTES_EXCEEDED' };
  }
  return { ok: true, variables };
}

function summarizeCorrelationMatrixPair(rows: DatasetRow[], keyX: string, keyY: string): CorrelationMatrixPairSummary {
  const includedPersons = new Set<string>();
  const excludedPersons = new Set<string>();
  let includedCaseCount = 0;

  for (const row of rows) {
    const x = row.values[keyX];
    const y = row.values[keyY];
    const xMissing = !x || x.missing !== null;
    const yMissing = !y || y.missing !== null;

    if (!xMissing && !yMissing) {
      includedCaseCount += 1;
      includedPersons.add(row.personClusterKey);
    } else {
      excludedPersons.add(row.personClusterKey);
    }
  }

  return {
    includedCaseCount,
    includedPersonCount: includedPersons.size,
    excludedPersonCount: excludedPersons.size,
  };
}

/** pair마다 disclosure 판정에 필요한 카운트 요약만 계산한다(원시 행 배열 없음).
 * key는 pairMapKey(xKey,yKey) — 항상 i<j 순서로 생성. */
export function buildCorrelationMatrixPairedDatasets(
  rows: DatasetRow[],
  keys: string[],
): Map<string, CorrelationMatrixPairSummary> {
  const result = new Map<string, CorrelationMatrixPairSummary>();
  for (const { xKey, yKey } of allCorrelationMatrixPairs(keys)) {
    result.set(pairMapKey(xKey, yKey), summarizeCorrelationMatrixPair(rows, xKey, yKey));
  }
  return result;
}
