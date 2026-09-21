// PR4-A1 — 연관성 회귀 ①입력상한 선검사 + ②완전사례 판정 + 레벨·event 요약.
// 계획서(pr4-a-lexical-reddy.md) §2 "실행 순서" ①② 담당. ③(공개통제)은
// statsRegressionDisclosureGate.ts, ④(설계행렬)는 statsRegressionDesign.ts.
//
// 상한 선검사는 statsCorrelationMatrixDataset.ts의 evaluateCorrelationMatrixInputLimits
// 패턴을 그대로 복제한다 — 값을 실제로 만들기 *전에* rows×cols와 직렬화 바이트를
// 재서, Python payload 조립 시점(assertRegressionWithinLimits)까지 상한 초과
// 입력이 O(rows×cols) 순회를 전부 통과하지 않게 한다.
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { DatasetRow } from './statsDatasetBuilder';
import { MAX_TOTAL_VALUES, MAX_VALUES_PER_VARIABLE } from './statsEngineLimits';

function distinctPersons(rows: ReadonlyArray<{ personClusterKey: string }>): number {
  return new Set(rows.map((r) => r.personClusterKey)).size;
}

export type RegressionInputLimitViolation =
  | 'VALUES_PER_VARIABLE_EXCEEDED'
  | 'TOTAL_VALUES_EXCEEDED'
  | 'SERIALIZED_BYTES_EXCEEDED';

export type RegressionInputLimitCheck =
  | { ok: true }
  | { ok: false; violation: RegressionInputLimitViolation };

// 회귀는 outcome 1개 + predictor N개(더미 확장 전 기준)가 전부 같은 rows에서
// 뽑히므로 "변수당 값 개수"는 항상 rows.length다(상관행렬과 동일한 성질).
// 더미 확장 후 실제 열 수는 §2 ④(설계행렬)에서만 알 수 있으므로, 이 선검사는
// 더미 확장 전 변수 개수(outcome+predictor 원본 개수)로 보수적으로 측정한다 —
// 더미 확장은 열을 늘릴 뿐 행을 늘리지 않으므로 바이트 추정만 실제보다 작을 수
// 있다. 그 결정적 초과는 §2 ④ TOO_MANY_PARAMETERS가 별도로 잡는다.
export function evaluateRegressionInputLimits(
  rowCount: number,
  rawVariableCount: number,
): RegressionInputLimitCheck {
  if (rowCount > MAX_VALUES_PER_VARIABLE) {
    return { ok: false, violation: 'VALUES_PER_VARIABLE_EXCEEDED' };
  }
  if (rawVariableCount * rowCount > MAX_TOTAL_VALUES) {
    return { ok: false, violation: 'TOTAL_VALUES_EXCEEDED' };
  }
  // 바이트 추정은 실제 설계행렬(더미 확장 후) 조립 시점에 한다 — 값 형태가
  // 아직 정해지지 않은 이 단계에서 정확한 바이트 수를 알 수 없다. §2 ④에서
  // 실제 payload 크기를 config.stats.maxInputBytes와 다시 대조하고, 마지막
  // 안전망은 statsEngine.ts의 assertRegressionWithinLimits(Python spawn 직전).
  return { ok: true };
}

export interface RegressionCompleteCaseResult {
  completeRows: DatasetRow[];
  incompleteRows: DatasetRow[];
  includedPersonCount: number;
  excludedPersonCount: number;
  excludedRowCount: number;
}

/** §6.2 complete-case — outcome + 모든 predictor가 non-missing인 행만 남긴다
 * (평균대치 없음). 포함/제외 person 수는 statsRegressionDisclosureGate.ts의
 * 대칭 소수셀 검사(리뷰 #3)에 직접 쓰인다. */
export function computeRegressionCompleteCase(
  rows: DatasetRow[],
  outcomeKey: string,
  predictorKeys: string[],
): RegressionCompleteCaseResult {
  const isComplete = (row: DatasetRow): boolean => {
    const outcome = row.values[outcomeKey];
    if (!outcome || outcome.missing !== null) return false;
    for (const key of predictorKeys) {
      const v = row.values[key];
      if (!v || v.missing !== null) return false;
    }
    return true;
  };
  const completeRows: DatasetRow[] = [];
  const incompleteRows: DatasetRow[] = [];
  for (const row of rows) {
    (isComplete(row) ? completeRows : incompleteRows).push(row);
  }
  return {
    completeRows,
    incompleteRows,
    includedPersonCount: distinctPersons(completeRows),
    excludedPersonCount: distinctPersons(incompleteRows),
    excludedRowCount: incompleteRows.length,
  };
}

export interface RegressionLevelSummary {
  variableKey: string;
  level: string;
  personCount: number;
}

/** predictor별(categorical/ordinal만) 레벨-person 요약 — 공개통제(③)의
 * isGroupBreakdownDisclosable 재사용 대상. boolean/continuous predictor는
 * 여기 대상이 아니다(boolean은 0/1 직접 인코딩, continuous는 레벨 개념 없음 —
 * 둘 다 §2 ④의 ZERO_VARIANCE_PREDICTOR 검사로 별도 커버). */
export function computeRegressionLevelSummaries(
  completeRows: DatasetRow[],
  predictorKeys: string[],
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
): RegressionLevelSummary[] {
  const summaries: RegressionLevelSummary[] = [];
  for (const key of predictorKeys) {
    const variable = catalogByKey.get(key);
    if (!variable || (variable.type !== 'categorical' && variable.type !== 'ordinal')) continue;
    const personsByLevel = new Map<string, Set<string>>();
    for (const row of completeRows) {
      const raw = row.values[key]?.value;
      const level = String(raw);
      if (!personsByLevel.has(level)) personsByLevel.set(level, new Set());
      personsByLevel.get(level)!.add(row.personClusterKey);
    }
    for (const [level, persons] of personsByLevel) {
      summaries.push({ variableKey: key, level, personCount: persons.size });
    }
  }
  return summaries;
}

export interface RegressionEventSummary {
  eventPersonCount: number;
  nonEventPersonCount: number;
}

/** boolean outcome 전용 — event(true)/non-event(false) person 요약. outcome
 * 타입이 boolean이 아니면 null(호출자가 이분 로지스틱 여부로 분기). */
export function computeRegressionEventSummary(
  completeRows: DatasetRow[],
  outcomeKey: string,
  outcomeType: AnalyticsVariableMetadata['type'] | undefined,
): RegressionEventSummary | null {
  if (outcomeType !== 'boolean') return null;
  const eventPersons = new Set<string>();
  const nonEventPersons = new Set<string>();
  for (const row of completeRows) {
    const v = row.values[outcomeKey]?.value;
    if (v === true) eventPersons.add(row.personClusterKey);
    else if (v === false) nonEventPersons.add(row.personClusterKey);
  }
  return { eventPersonCount: eventPersons.size, nonEventPersonCount: nonEventPersons.size };
}
