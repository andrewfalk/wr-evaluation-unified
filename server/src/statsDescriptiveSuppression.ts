// PR1 §4.2 — Python 결과를 그대로 노출하지 않는다. 소수 셀 억제는 "변수 전체 연결
// 억제"다(레벨/방향 단위 부분 마스킹 금지, statsEstimability.ts의 boolean 원칙을
// continuous(present/missing 연결)·discrete(모든 level+missing 연결)·결측사유 분포까지
// 일반화한다). mode 계산·ordinal 순서 재배열도 여기서 한다(Python은 카탈로그를 모른다).
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import { getOrdinalOrder } from './statsOrdinalOrder';
import type {
  AnalyzeContinuousResult,
  AnalyzeDiscreteLevel,
  AnalyzeDiscreteResult,
  AnalyzeMissingPatternEntry,
  AnalyzeResult,
} from '@wr/contracts';
import type { DatasetRow } from './statsDatasetBuilder';
import { normalizeForCompare } from './statsDatasetBuilder';
import { isSmallCell } from './statsSmallCell';
import type { StatsEngineRawResult, StatsEngineRequest, StatsEngineVariableKind } from './statsEngine';

function mapCatalogTypeToKind(type: AnalyticsVariableMetadata['type'] | undefined, key: string): StatsEngineVariableKind {
  if (type === 'continuous') return 'continuous';
  if (type === 'boolean' || type === 'ordinal' || type === 'categorical') return 'discrete';
  throw new Error(`variable '${key}' has type '${type ?? 'unknown'}' — PR1 기술통계는 continuous/boolean/ordinal/categorical만 지원한다`);
}

function distinctPersons(rows: DatasetRow[]): number {
  return new Set(rows.map((r) => r.personClusterKey)).size;
}

// §4.2 — mode 동점 처리: ordinal은 심각도 순서에서 더 낮은(경한) 레벨, 그 외는 값의
// 문자열 표현 오름차순(boolean은 false<true) — 결정성 고정.
function pickMode(levels: AnalyzeDiscreteLevel[], variableKey: string): string | boolean | null {
  if (levels.length === 0) return null;
  const maxCount = Math.max(...levels.map((l) => l.count));
  const tied = levels.filter((l) => l.count === maxCount);
  if (tied.length === 1) return tied[0].level;

  const order = getOrdinalOrder(variableKey);
  const sorted = [...tied].sort((a, b) => {
    if (order) return order.indexOf(String(a.level)) - order.indexOf(String(b.level));
    return String(a.level).localeCompare(String(b.level));
  });
  return sorted[0].level;
}

// §4.2 — 결측사유 분포는 discrete와 같은 연결 억제 규칙을 그 변수의 "결측 하위집합"에
// 적용한다: reasonCode 중 하나라도 소수 셀이면 분포 전체를 생략한다(missingCount 자체는
// 이미 n을 통해 암묵적으로 공개되므로 유지 — 부분억제 재도입 방지, 1차 검토 결함 수정).
function buildMissingPatterns(missingRows: DatasetRow[], key: string): AnalyzeMissingPatternEntry[] | null {
  const groups = new Map<string, { count: number; personSet: Set<string> }>();
  for (const row of missingRows) {
    const reasonCode = row.values[key]?.missing;
    if (!reasonCode) continue;
    let g = groups.get(reasonCode);
    if (!g) { g = { count: 0, personSet: new Set() }; groups.set(reasonCode, g); }
    g.count += 1;
    g.personSet.add(row.personClusterKey);
  }
  const anySmall = [...groups.values()].some((g) => isSmallCell(g.personSet.size));
  if (anySmall) return null;
  return [...groups.entries()].map(([reasonCode, g]) => ({
    reasonCode: reasonCode as AnalyzeMissingPatternEntry['reasonCode'],
    count: g.count,
  }));
}

// Python에 보낼 요청 조립 — 결측 아닌 값만, NFC 정규화까지 끝낸 상태로 변수별 flat 배열을
// 만든다(행 구조·caseId·personClusterKey·missing 마커 전부 제거, §1.1).
export function buildStatsEngineRequest(
  rows: DatasetRow[],
  variableKeys: string[],
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
): StatsEngineRequest {
  const variables = variableKeys.map((key) => {
    const kind = mapCatalogTypeToKind(catalogByKey.get(key)?.type, key);
    const values: Array<number | string | boolean> = [];
    for (const row of rows) {
      const extracted = row.values[key];
      if (!extracted || extracted.missing !== null || extracted.value === null) continue;
      values.push(normalizeForCompare(extracted.value) as number | string | boolean);
    }
    return { key, kind, values };
  });
  return { variables };
}

// Python 원시 결과 + DatasetRow(person 신원을 아는 쪽) → 최종 공개 가능한 AnalyzeResult.
export function computeDescriptiveSuppression(
  rows: DatasetRow[],
  variableKeys: string[],
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
  raw: StatsEngineRawResult,
): AnalyzeResult {
  const rawContinuousByKey = new Map(raw.continuous.map((c) => [c.variableKey, c] as const));
  const rawDiscreteByKey = new Map(raw.discrete.map((d) => [d.variableKey, d] as const));

  const continuous: AnalyzeContinuousResult[] = [];
  const discrete: AnalyzeDiscreteResult[] = [];

  for (const key of variableKeys) {
    const kind = mapCatalogTypeToKind(catalogByKey.get(key)?.type, key);
    const presentRows = rows.filter((r) => r.values[key]?.missing === null);
    const missingRows = rows.filter((r) => r.values[key] !== undefined && r.values[key]!.missing !== null);
    const presentPersonCount = distinctPersons(presentRows);
    const missingPersonCount = distinctPersons(missingRows);

    if (kind === 'continuous') {
      const linkedSuppressed = isSmallCell(presentPersonCount) || isSmallCell(missingPersonCount);
      if (linkedSuppressed) {
        continuous.push({ variableKey: key, kind: 'continuous', suppressed: true });
        continue;
      }
      const rawStat = rawContinuousByKey.get(key);
      if (!rawStat) throw new Error(`missing continuous engine result for '${key}'`);
      continuous.push({
        variableKey: key,
        kind: 'continuous',
        suppressed: false,
        n: rawStat.n,
        missingCount: missingRows.length,
        missingPatterns: buildMissingPatterns(missingRows, key),
        mean: rawStat.mean,
        sd: rawStat.sd,
        median: rawStat.median,
        q1: rawStat.q1,
        q3: rawStat.q3,
        iqr: rawStat.iqr,
        skewness: rawStat.skewness,
        kurtosis: rawStat.kurtosis,
        min: rawStat.min,
        max: rawStat.max,
        nullReasons: rawStat.nullReasons,
      });
      continue;
    }

    // discrete — level별 person count는 Python이 모르므로 Node가 DatasetRow로 재계산.
    const levelPersonSets = new Map<string, Set<string>>();
    for (const row of presentRows) {
      const value = normalizeForCompare(row.values[key]!.value);
      const levelKey = `${typeof value}:${String(value)}`;
      let set = levelPersonSets.get(levelKey);
      if (!set) { set = new Set(); levelPersonSets.set(levelKey, set); }
      set.add(row.personClusterKey);
    }
    const anySmallLevel = [...levelPersonSets.values()].some((set) => isSmallCell(set.size));
    const anySmall = anySmallLevel || isSmallCell(missingPersonCount);
    if (anySmall) {
      discrete.push({ variableKey: key, kind: 'discrete', suppressed: true });
      continue;
    }
    const rawStat = rawDiscreteByKey.get(key);
    if (!rawStat) throw new Error(`missing discrete engine result for '${key}'`);
    const n = rawStat.n;
    const levels: AnalyzeDiscreteLevel[] = rawStat.levels.map((lvl) => ({
      level: lvl.level,
      count: lvl.count,
      proportion: n > 0 ? lvl.count / n : 0,
    }));
    // 7차 검토 필수 수정 — 이전 판은 심각도 순서를 mode 동점 처리(tied 부분집합)에만
    // 썼고, 공개되는 levels[] 전체는 Python이 돌려준 "입력 첫 등장 순서" 그대로였다.
    // ordinal 변수는 levels[] 자체도 심각도 순서로 정렬한다(데이터 등장 순서에 따라
    // "고도"가 "경도"보다 앞에 나오는 비결정적 출력 방지). 비-ordinal(boolean/categorical)
    // 은 원래 설계대로 첫 등장 순서를 유지한다(의미 있는 전역 순서가 없음).
    const ordinalOrder = getOrdinalOrder(key);
    if (ordinalOrder) {
      levels.sort((a, b) => ordinalOrder.indexOf(String(a.level)) - ordinalOrder.indexOf(String(b.level)));
    }
    discrete.push({
      variableKey: key,
      kind: 'discrete',
      suppressed: false,
      n,
      missingCount: missingRows.length,
      missingPatterns: buildMissingPatterns(missingRows, key),
      levels,
      mode: pickMode(levels, key),
    });
  }

  return { continuous, discrete };
}
