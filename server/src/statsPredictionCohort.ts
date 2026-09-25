// PR4-B2 — 예측(prediction) 분석 코호트 키·fold 배정·자료 단계(S0/S1/S2)·공개통제
// 카운트·비추정(non_estimable) 사유 판정(계획서 §3단계). 3-4단계 실행 순서(request
// 억제 → 공개통제 게이트 → 비추정 판정 → 엔진)의 앞 세 단계를 이 파일이 담당한다 —
// 네 번째(엔진 실행)만 statsEngine.ts/Python 쪽 책임이다.
import { createHash } from 'crypto';
import { canonicalDigest } from './canonicalSerializer';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { StatsAnalysisRecipe, StatsFilter, PredictionNonEstimableReason } from '@wr/contracts';
import { PREDICTION_POLICY } from './statsPolicy';
import type { DatasetRow } from './statsDatasetBuilder';
import { checkPredictorVariance } from './statsRegressionDesign';
import { buildPredictionDesignMatrix, type PredictionDesignMatrix } from './statsPredictionDesign';
import { isSmallCell } from './statsSmallCell';
import { isGroupBreakdownDisclosable } from './statsBivariateDisclosureGate';

// cohortDigest는 예측변수(predictor 선택)와 무관해야 한다(3차 리뷰 #3-1 — 그래야
// predictor를 추가/제거해도 fold 배정이 흔들리지 않는다) — grain·필터·outcome·
// eventLevel·샘플러 시드만 입력으로 쓴다. filters는 정규 정렬(key→operator→값의
// canonical 직렬화 순)해서 넣는다 — canonicalSerialize는 배열을 재정렬하지 않으므로
// 호출자가 순서를 고정해야 같은 필터 집합이 요청 순서와 무관하게 같은 digest를 낸다.
function sortFiltersCanonically(filters: readonly StatsFilter[]): StatsFilter[] {
  return [...filters].sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    if (a.operator !== b.operator) return a.operator < b.operator ? -1 : 1;
    const av = JSON.stringify(a.value ?? null);
    const bv = JSON.stringify(b.value ?? null);
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
}

export function computePredictionCohortDigest(recipe: StatsAnalysisRecipe): string {
  if (recipe.analysisMode !== 'prediction' || !recipe.prediction) {
    throw new Error('computePredictionCohortDigest: analysisMode가 prediction이 아니거나 prediction 객체가 없다');
  }
  return canonicalDigest({
    grain: recipe.grain,
    filters: sortFiltersCanonically(recipe.filters).map((f) => ({ key: f.key, operator: f.operator, value: f.value ?? null })),
    outcomeKey: recipe.prediction.outcomeKey,
    eventLevel: recipe.prediction.eventLevel,
    samplerSeed: PREDICTION_POLICY.samplerSeed,
  });
}

// 정렬 키 — sha256(cohortDigest‖repeat‖cohortPersonKey)의 앞 16 hex 자리를 BigInt로
// 해석해 정렬한다(3-4단계 "fold 배정" 절, samplerVersion='sha256-rr-v1'). 16자리면
// 64비트라 정렬 충돌 확률이 무시할 수준이면서도 BigInt 전체 해시보다 비교가 저렴하다.
function sortKey(cohortDigest: string, repeat: number, cohortPersonKey: string): bigint {
  const hex = createHash('sha256').update(`${cohortDigest}\u0000${repeat}\u0000${cohortPersonKey}`).digest('hex');
  return BigInt(`0x${hex.slice(0, 16)}`);
}

export type PredictionStratum = 0 | 1;

// outerFold[repeat][cohortPersonKey] = foldIndex. 층(사건/비사건 person, S1 기준 —
// 호출자가 미리 계산해서 넘긴다)별로 정렬 후 round-robin 배정한다 — 그래야 각 fold의
// 사건 비율이 비슷하게 유지된다(grouped *stratified* K-fold). 같은 person은 반복마다
// 다른 fold에 배정될 수 있다(repeat마다 정렬 시드가 다르므로 의도된 동작 — 계획서
// "반복 grouped K-fold CV").
export function assignPredictionOuterFolds(
  personStrata: ReadonlyMap<string, PredictionStratum>,
  repeats: number,
  outerFolds: number,
  cohortDigest: string,
): Map<number, Map<string, number>> {
  const byRepeat = new Map<number, Map<string, number>>();
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const foldOfPerson = new Map<string, number>();
    for (const stratum of [0, 1] as const) {
      const members = Array.from(personStrata.entries())
        .filter(([, s]) => s === stratum)
        .map(([key]) => key)
        .sort((a, b) => {
          const ka = sortKey(cohortDigest, repeat, a);
          const kb = sortKey(cohortDigest, repeat, b);
          return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
      members.forEach((key, i) => {
        foldOfPerson.set(key, i % outerFolds);
      });
    }
    byRepeat.set(repeat, foldOfPerson);
  }
  return byRepeat;
}

// ============================================================================
// 3-1단계 키 누락 방어 — prediction 경로에서 cohortPersonKey가 하나라도 없으면
// 즉시 내부 입력 오류로 처리한다. personClusterKey로 fallback하거나 undefined끼리
// 한 group으로 묶는 것 둘 다 금지(계획서 §3-1단계 ⑥) — 고정 분할 보장이 깨진다.
// ============================================================================
export class PredictionCohortKeyMissingError extends Error {}

function requireCohortPersonKeys(rows: readonly DatasetRow[]): void {
  for (const row of rows) {
    if (row.cohortPersonKey === undefined) {
      throw new PredictionCohortKeyMissingError(
        `computePredictionDataStages: case "${row.caseId}"에 cohortPersonKey가 없다 — buildDataset()에 opts.cohortDigest를 넘기지 않았거나 배선이 깨졌다`,
      );
    }
  }
}

// boolean outcome 값(true/false)과 categorical outcome 값(문자열)을 같은 기준으로
// eventLevel과 비교하기 위한 정규화. PREDICTION_OUTCOME_SPECS의 레벨은 전부 문자열
// ('true'/'false' 포함)이다.
export function stringifyOutcomeValue(value: unknown): string {
  return typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
}

// ============================================================================
// 3-2단계 — 자료 단계 S0(=입력 rows, 필터 적용 완료·변수 선택과 무관) → S1(기준
// 코호트, outcome 관측) → S2(최종 완전사례, predictor까지 전부 관측).
// ============================================================================
export interface PredictionDataStages {
  s1Rows: DatasetRow[];
  s2Rows: DatasetRow[];
  // S0 → S2 전체 제외 "행" 수(공개 가능 — association과 같은 관례).
  excludedRowCount: number;
  // 제외 "person" 집합 — 절대 결과에 개수를 노출하지 않는다(내부 공개통제 게이트
  // 전용, 4차 리뷰 #1). E=제외 행을 하나라도 가진 person, F=S0엔 있지만 S2엔 전혀
  // 없는 person(완전 제외), B=E∩persons(S2)(부분 제외 — 포함·제외 양쪽에 걸침).
  excludedPersonSets: { E: Set<string>; F: Set<string>; B: Set<string> };
}

function personsOf(rows: readonly DatasetRow[]): Set<string> {
  return new Set(rows.map((r) => r.cohortPersonKey!));
}

export function computePredictionDataStages(
  s0Rows: DatasetRow[],
  outcomeKey: string,
  predictorKeys: readonly string[],
): PredictionDataStages {
  requireCohortPersonKeys(s0Rows);

  const s1Rows = s0Rows.filter((r) => r.values[outcomeKey]?.missing === null);
  const s2Rows = s1Rows.filter((r) => predictorKeys.every((k) => r.values[k]?.missing === null));

  const s2RowSet = new Set(s2Rows);
  const excludedRows = s0Rows.filter((r) => !s2RowSet.has(r));
  const excludedRowCount = excludedRows.length;

  const personsS0 = personsOf(s0Rows);
  const personsS2 = personsOf(s2Rows);
  const E = new Set(excludedRows.map((r) => r.cohortPersonKey!));
  const F = new Set([...personsS0].filter((p) => !personsS2.has(p)));
  const B = new Set([...E].filter((p) => personsS2.has(p)));

  return { s1Rows, s2Rows, excludedRowCount, excludedPersonSets: { E, F, B } };
}

// ============================================================================
// 3-3단계 — 공개통제 카운트. P⁺(y=eventLevel 행을 하나라도 보유)/P⁻(그 외 레벨
// 행을 하나라도 보유)/M=P⁺∩P⁻(둘 다 보유). "서로소 사건/비사건 person"은 이
// pPlus/pMinus에서 파생한다(사건=pPlus 그대로, 비사건=해당 rows의 전체 person
// 중 pPlus에 없는 나머지 — "전부 y=0"과 동치, pMinus\pPlus와 같다).
// ============================================================================
export interface EventNonEventPersonSets {
  pPlus: Set<string>;
  pMinus: Set<string>;
}

export function computeEventNonEventPersonSets(
  rows: readonly DatasetRow[],
  outcomeKey: string,
  eventLevel: string,
): EventNonEventPersonSets {
  const pPlus = new Set<string>();
  const pMinus = new Set<string>();
  for (const row of rows) {
    const key = row.cohortPersonKey!;
    const extracted = row.values[outcomeKey];
    if (!extracted || extracted.missing !== null) continue;
    if (stringifyOutcomeValue(extracted.value) === eventLevel) pPlus.add(key);
    else pMinus.add(key);
  }
  return { pPlus, pMinus };
}

export interface PredictionLevelSummary {
  variableKey: string;
  level: string;
  personCount: number;
}

/** predictor별(categorical/ordinal/boolean) 레벨-person 요약, cohortPersonKey
 * 기준(계획서 §3-3단계 "S2 predictor 레벨별 person"). continuous는 레벨 개념이
 * 없어 대상이 아니다 — 그 분산은 checkPredictorVariance(ZERO_VARIANCE_PREDICTOR)가
 * 별도로 커버한다. statsRegressionDataset.ts의 computeRegressionLevelSummaries와
 * 쌍둥이 구조이지만 person 키 축(cohortPersonKey vs personClusterKey)이 달라
 * 공유하지 않는다(association 동작 불변 원칙 — 그 함수는 손대지 않는다).
 */
export function computePredictionLevelSummaries(
  rows: readonly DatasetRow[],
  predictorKeys: readonly string[],
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
): PredictionLevelSummary[] {
  const summaries: PredictionLevelSummary[] = [];
  for (const key of predictorKeys) {
    const variable = catalogByKey.get(key);
    if (!variable || (variable.type !== 'categorical' && variable.type !== 'ordinal' && variable.type !== 'boolean')) continue;
    const personsByLevel = new Map<string, Set<string>>();
    for (const row of rows) {
      const raw = row.values[key]?.value;
      if (raw === undefined) continue;
      const level = variable.type === 'boolean' ? (raw === true ? 'true' : 'false') : String(raw);
      if (!personsByLevel.has(level)) personsByLevel.set(level, new Set());
      personsByLevel.get(level)!.add(row.cohortPersonKey!);
    }
    for (const [level, persons] of personsByLevel) {
      summaries.push({ variableKey: key, level, personCount: persons.size });
    }
  }
  return summaries;
}

// ============================================================================
// 3-4단계 ② — 공개통제 게이트. 아래 전부가 0 또는 ≥MINIMUM_COHORT여야 통과한다.
// 하나라도 소수셀이면 구체 사유 없이 suppressed:MIN_COHORT_NOT_MET만 반환한다
// (association/회귀와 같은 관례 — 레벨별/사유별 세분화는 그 자체로 소수셀 정보다).
// ============================================================================
export interface PredictionDisclosureInput {
  s1EventNonEvent: EventNonEventPersonSets;
  s2EventNonEvent: EventNonEventPersonSets;
  s2PersonCount: number;
  s2LevelSummaries: readonly PredictionLevelSummary[];
  excludedPersonSets: { E: Set<string>; F: Set<string>; B: Set<string> };
}

export interface PredictionDisclosureResult {
  disclose: boolean;
  reasonCode: 'MIN_COHORT_NOT_MET' | null;
}

export function evaluatePredictionDisclosure(input: PredictionDisclosureInput): PredictionDisclosureResult {
  const { s1EventNonEvent, s2EventNonEvent, excludedPersonSets } = input;
  const s1M = new Set([...s1EventNonEvent.pPlus].filter((p) => s1EventNonEvent.pMinus.has(p))).size;
  const s2M = new Set([...s2EventNonEvent.pPlus].filter((p) => s2EventNonEvent.pMinus.has(p))).size;
  // 서로소 사건/비사건(S2) — 사건=pPlus 그대로, 비사건="전부 y=0"이므로 pMinus 중
  // pPlus에 없는 person(=이 S2 rows의 person 전체 중 pPlus를 뺀 나머지와 동치).
  const s2DisjointEventCount = input.s2EventNonEvent.pPlus.size;
  const s2DisjointNonEventCount = input.s2PersonCount - s2DisjointEventCount;

  const suppressed =
    isSmallCell(s1EventNonEvent.pPlus.size) || isSmallCell(s1EventNonEvent.pMinus.size) || isSmallCell(s1M) ||
    isSmallCell(s2DisjointEventCount) || isSmallCell(s2DisjointNonEventCount) ||
    isSmallCell(s2EventNonEvent.pPlus.size) || isSmallCell(s2EventNonEvent.pMinus.size) || isSmallCell(s2M) ||
    !isGroupBreakdownDisclosable(input.s2LevelSummaries) ||
    isSmallCell(input.s2PersonCount) ||
    isSmallCell(excludedPersonSets.E.size) || isSmallCell(excludedPersonSets.F.size) || isSmallCell(excludedPersonSets.B.size);

  return { disclose: !suppressed, reasonCode: suppressed ? 'MIN_COHORT_NOT_MET' : null };
}

// ============================================================================
// 3-4단계 ③ — 구조적 추정불가(non_estimable) 순서표 1~10(11=NOT_CONVERGED는
// 엔진 전용이라 이 함수 밖, statsEngine.ts/Python 쪽 책임). 처음 걸리는 사유
// 하나만 반환한다 — 이 순서 자체가 PredictionNonEstimableReasonSchema의 정의다.
// ============================================================================
export interface PredictionNonEstimableCheckInput {
  s1Rows: readonly DatasetRow[];
  s2Rows: readonly DatasetRow[];
  outcomeKey: string;
  eventLevel: string;
  s1EventNonEvent: EventNonEventPersonSets;
  s2EventNonEvent: EventNonEventPersonSets;
  s2PersonCount: number;
  predictorKeys: readonly string[]; // recipe(variableKeys) 순서 그대로
  catalogByKey: Map<string, AnalyticsVariableMetadata>;
  outerFoldAssignment: ReadonlyMap<number, ReadonlyMap<string, number>>;
  outerFolds: number;
}

export interface PredictionNonEstimableCheckResult {
  reason: PredictionNonEstimableReason | null;
  // reason이 1~6이면 null, 7~10 또는 통과(null)면 값(계획서 §3-4단계 사유별 null 필드 표).
  columnCount: number | null;
  parameterCount: number | null;
  design: PredictionDesignMatrix | null;
}

export function computePredictionNonEstimableReason(
  input: PredictionNonEstimableCheckInput,
): PredictionNonEstimableCheckResult {
  const fail = (reason: PredictionNonEstimableReason): PredictionNonEstimableCheckResult =>
    ({ reason, columnCount: null, parameterCount: null, design: null });

  // 1~3 — S1 기준. 레벨이 비어 있는 경우는 "어느 쪽이 비었는지"로 구분한다.
  if (input.s1Rows.length === 0) return fail('OUTCOME_NOT_OBSERVED');
  if (input.s1EventNonEvent.pPlus.size === 0) return fail('EVENT_LEVEL_NOT_OBSERVED');
  if (input.s1EventNonEvent.pMinus.size === 0) return fail('NON_EVENT_LEVEL_NOT_OBSERVED');

  // 4~5 — S2 기준 인원.
  if (input.s2PersonCount < PREDICTION_POLICY.minPersons) return fail('INSUFFICIENT_PERSONS');
  const eventPersonCount = input.s2EventNonEvent.pPlus.size;
  const nonEventPersonCount = input.s2PersonCount - eventPersonCount;
  if (eventPersonCount < PREDICTION_POLICY.minEventPersons || nonEventPersonCount < PREDICTION_POLICY.minNonEventPersons) {
    return fail('INSUFFICIENT_EVENT_PERSONS');
  }

  // 6 — predictor 사전검사, recipe 순서대로 처음 실패한 predictor의 코드.
  for (const key of input.predictorKeys) {
    const variable = input.catalogByKey.get(key);
    if (!variable) continue; // UNKNOWN_VARIABLE로 이미 statsRecipeValidation.ts가 거부
    const check = checkPredictorVariance(key, variable, input.s2Rows as DatasetRow[], PREDICTION_POLICY.maxLevels);
    if (!check.ok) return fail(check.reason);
  }

  // 7~9 — 설계행렬 크기·EPV(이 지점부터 columnCount/parameterCount가 값을 갖는다).
  const design = buildPredictionDesignMatrix(input.s2Rows as DatasetRow[], input.predictorKeys as string[], input.catalogByKey);
  if (design.columnCount > PREDICTION_POLICY.maxColumns) {
    return { reason: 'TOO_MANY_COLUMNS', columnCount: design.columnCount, parameterCount: design.parameterCount, design: null };
  }
  if (design.parameterCount > PREDICTION_POLICY.maxParameters) {
    return { reason: 'TOO_MANY_PARAMETERS', columnCount: design.columnCount, parameterCount: design.parameterCount, design: null };
  }
  const epv = Math.min(eventPersonCount, nonEventPersonCount) / design.parameterCount;
  if (epv < PREDICTION_POLICY.minEventsPerParameter) {
    return { reason: 'INSUFFICIENT_EVENTS_PER_PARAMETER', columnCount: design.columnCount, parameterCount: design.parameterCount, design: null };
  }

  // 10 — 외부 fold마다 S2에 y=0/y=1 행이 모두 있어야 한다(행 단위 판정 — person이
  // fold를 정하고, 그 person 소속 행 각각의 실제 y값으로 클래스를 센다).
  for (const foldOfPerson of input.outerFoldAssignment.values()) {
    const hasEvent = new Array<boolean>(input.outerFolds).fill(false);
    const hasNonEvent = new Array<boolean>(input.outerFolds).fill(false);
    for (const row of input.s2Rows) {
      const fold = foldOfPerson.get(row.cohortPersonKey!);
      if (fold === undefined) continue; // 있을 수 없지만(모든 S2 person은 층화 대상) 방어적으로 skip
      const extracted = row.values[input.outcomeKey];
      if (!extracted || extracted.missing !== null) continue;
      if (stringifyOutcomeValue(extracted.value) === input.eventLevel) hasEvent[fold] = true;
      else hasNonEvent[fold] = true;
    }
    for (let k = 0; k < input.outerFolds; k++) {
      if (!hasEvent[k] || !hasNonEvent[k]) {
        return { reason: 'FOLD_CLASS_MISSING', columnCount: design.columnCount, parameterCount: design.parameterCount, design: null };
      }
    }
  }

  return { reason: null, columnCount: design.columnCount, parameterCount: design.parameterCount, design };
}
