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
import { buildOriginalHistogram, resolveDisclosableHistogram, isOutlierCountDisclosable } from './statsChartDisclosure';
import type { StatsEngineRawResult, StatsEngineRequest, StatsEngineVariableKind } from './statsEngine';

// PR0-B3 Part C — high_cardinality(job.identity.jobNameNormalized 등) 추가. Python
// 엔진 입장에서는 categorical과 동일하게 레벨별 빈도만 세면 되므로(계획 §5.5 ① —
// "기술통계·필터 용도로만" 카탈로그에 올린다, 회귀 predictor로서의 maxLevels 상한은
// estimability gate가 아직 없는 PR4-A 전용 범위) 'discrete'로 합류한다 — 수준이 많다는
// 사실 자체가 계산 kind를 바꾸지는 않는다. date는 여전히 미지원(카탈로그에 date 타입
// 변수가 아직 0개 — statsRecipeValidation.ts:45-48의 동일한 "죽은 코드" 캐비엇 참고).
function mapCatalogTypeToKind(type: AnalyticsVariableMetadata['type'] | undefined, key: string): StatsEngineVariableKind {
  if (type === 'continuous') return 'continuous';
  if (type === 'boolean' || type === 'ordinal' || type === 'categorical' || type === 'high_cardinality') return 'discrete';
  throw new Error(`variable '${key}' has type '${type ?? 'unknown'}' — PR1 기술통계는 continuous/boolean/ordinal/categorical/high_cardinality만 지원한다`);
}

// Table1 — statsDescriptiveStratify.ts가 그룹별 인원 판정에 같은 함수를 재사용한다.
export function distinctPersons(rows: DatasetRow[]): number {
  return new Set(rows.map((r) => r.personClusterKey)).size;
}

// §4.2 — mode 동점 처리: ordinal은 심각도 순서에서 더 낮은(경한) 레벨, 그 외는 값의
// 문자열 표현 오름차순(boolean은 false<true) — 결정성 고정.
// 비교는 localeCompare가 아니라 코드유닛 기준 `<`/`>`이다 — localeCompare는 서버 로케일·ICU
// 버전에 따라 결과가 달라지고(예: ko-KR에서는 "가"<"A", en-US에서는 "A"<"가"), 같은 값을
// 클라이언트(src/core/components/charts/discreteLevels.js pickModeFromLevels)가 원본 표시 때
// 다시 고를 때 브라우저 언어와도 어긋난다. statsBivariateRoles.ts sortDeterministic과 같은
// 원칙이며, 두 구현이 같은 규칙인지는 양쪽 테스트가 같은 반례("a" vs "B", "A" vs "가")로 고정한다.
function pickMode(levels: AnalyzeDiscreteLevel[], variableKey: string): string | boolean | null {
  if (levels.length === 0) return null;
  const maxCount = Math.max(...levels.map((l) => l.count));
  const tied = levels.filter((l) => l.count === maxCount);
  if (tied.length === 1) return tied[0].level;

  const order = getOrdinalOrder(variableKey);
  const sorted = [...tied].sort((a, b) => {
    if (order) return order.indexOf(String(a.level)) - order.indexOf(String(b.level));
    const sa = String(a.level);
    const sb = String(b.level);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  return sorted[0].level;
}

// §4.2 — 결측사유 분포는 discrete와 같은 연결 억제 규칙을 그 변수의 "결측 하위집합"에
// 적용한다: reasonCode 중 하나라도 소수 셀이면 분포 전체를 생략한다(missingCount 자체는
// 이미 n을 통해 암묵적으로 공개되므로 유지 — 부분억제 재도입 방지, 1차 검토 결함 수정).
function buildMissingPatterns(
  missingRows: DatasetRow[],
  key: string,
  unrestricted = false,
): AnalyzeMissingPatternEntry[] | null {
  const groups = new Map<string, { count: number; personSet: Set<string> }>();
  for (const row of missingRows) {
    const reasonCode = row.values[key]?.missing;
    if (!reasonCode) continue;
    let g = groups.get(reasonCode);
    if (!g) { g = { count: 0, personSet: new Set() }; groups.set(reasonCode, g); }
    g.count += 1;
    g.personSet.add(row.personClusterKey);
  }
  const anySmall = !unrestricted && [...groups.values()].some((g) => isSmallCell(g.personSet.size));
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
    const personKeys = new Set<string>();
    for (const row of rows) {
      const extracted = row.values[key];
      if (!extracted || extracted.missing !== null || extracted.value === null) continue;
      values.push(normalizeForCompare(extracted.value) as number | string | boolean);
      personKeys.add(row.personClusterKey);
    }
    // job/disease grain 브로드캐스트 변수는 같은 사람의 값이 여러 행(entityKey)에 그대로
    // 복제된다 — values.length(행 수)를 그대로 histogram bin 개수 계산에 쓰면 실제 인원보다
    // bin이 잘게 쪼개져 소수 셀 억제(person 단위)에 과도하게 자주 걸린다. continuous에서만
    // 의미가 있으므로(histogram은 continuous 전용, PR3-B) discrete에는 채우지 않는다.
    return kind === 'continuous' ? { key, kind, values, personCount: personKeys.size } : { key, kind, values };
  });
  return { variables };
}

// Python 원시 결과 + DatasetRow(person 신원을 아는 쪽) → 최종 공개 가능한 AnalyzeResult.
export function computeDescriptiveSuppression(
  rows: DatasetRow[],
  variableKeys: string[],
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
  raw: StatsEngineRawResult,
  options?: ComputeDescriptiveSuppressionOptions,
): AnalyzeResult {
  const rawContinuousByKey = new Map(raw.continuous.map((c) => [c.variableKey, c] as const));
  const rawDiscreteByKey = new Map(raw.discrete.map((d) => [d.variableKey, d] as const));
  // 제한데이터 권한자 응답 전용(statsDescriptiveUnrestricted.ts) — 소수 셀 판정을 전부 끈다.
  // 결과는 stats_runs.result 캐시에 저장하면 안 된다(집계 등급과 섞이면 권한 없는 조회자에게 샌다).
  const unrestricted = options?.unrestricted === true;
  const isSmall = (personCount: number): boolean => !unrestricted && isSmallCell(personCount);

  const continuous: AnalyzeContinuousResult[] = [];
  const discrete: AnalyzeDiscreteResult[] = [];

  for (const key of variableKeys) {
    const kind = mapCatalogTypeToKind(catalogByKey.get(key)?.type, key);
    const presentRows = rows.filter((r) => r.values[key]?.missing === null);
    const missingRows = rows.filter((r) => r.values[key] !== undefined && r.values[key]!.missing !== null);
    const presentPersonCount = distinctPersons(presentRows);
    const missingPersonCount = distinctPersons(missingRows);

    if (kind === 'continuous') {
      const linkedSuppressed = isSmall(presentPersonCount) || isSmall(missingPersonCount);
      if (linkedSuppressed) {
        continuous.push({ variableKey: key, kind: 'continuous', suppressed: true });
        continue;
      }
      const rawStat = rawContinuousByKey.get(key);
      if (!rawStat) throw new Error(`missing continuous engine result for '${key}'`);

      // 원본 bin은 Python 결과(rawStat.histogram)가 아니라 Node의 기준 구현
      // (buildOriginalHistogram, numpy와 경계까지 같음)으로 만든다. 이 경로는 공개 판정용이고,
      // 권한자 원본(rawHistogram)은 별도의 buildNiceHistogram(보기 좋은 경계)이라 같은 변수라도
      // 공개용과 경계가 다를 수 있다. 위 원본으로 resolveDisclosableHistogram이 해상도별 "그대로 → 끝 구간 병합"을
      // 시도해 공개 가능한 가장 세밀한 것을 채택한다. 히스토그램을 만들 조건은
      // Python(analyze.py)과 같다(q1/q3/median이 계산 가능할 때만). 원본은
      // 만들었는데 후보를 전부 시도해도 실패하면 histogramReasonCode를 채운다
      // (애초에 히스토그램이 없던 n=0과 구분).
      const valueOf = (row: DatasetRow): number | null => {
        const extracted = row.values[key];
        if (!extracted || extracted.missing !== null) return null;
        return typeof extracted.value === 'number' ? extracted.value : null;
      };
      const originalBins = rawStat.q1 !== null && rawStat.q3 !== null && rawStat.median !== null
        ? buildOriginalHistogram(presentRows, valueOf, rawStat.q1, rawStat.q3)
        : null;
      // 해제 모드는 해상도 축소·끝 구간 병합 없이 원본 bin을 그대로 쓴다.
      const resolvedHistogram = originalBins
        ? (unrestricted
          ? { bins: originalBins, merged: false }
          : resolveDisclosableHistogram(presentRows, originalBins, valueOf))
        : null;
      const histogram = resolvedHistogram ? { bins: resolvedHistogram.bins, merged: resolvedHistogram.merged } : null;
      const histogramReasonCode: 'INSUFFICIENT_DISCLOSABLE_RESOLUTION' | null =
        !resolvedHistogram && originalBins ? 'INSUFFICIENT_DISCLOSABLE_RESOLUTION' : null;

      // PR3-B §1 — 박스플롯의 q1/median/q3/lowerWhisker/upperWhisker는 histogram과
      // 같은 부모 게이트(linkedSuppressed)만 통과하면 그대로 노출(범위값 자체는
      // 집단 크기를 드러내지 않음). outlierCount는 **완전히 별개의** 독립 게이트
      // (이상치·비이상치 양쪽 partition의 person 고유 인원)를 추가로 통과해야
      // 한다 — histogram 게이트를 전부 통과해도 이상치가 소수집단일 수 있다
      // (계획서 §1 반례로 확인됨). outlierValues(정확한 좌표)는 여기서 절대
      // 만들지 않는다 — limited_row라 응답시점에만 별도로 merge된다(§9).
      const boxplot = rawStat.boxplot === null ? null : {
        q1: rawStat.boxplot.q1,
        median: rawStat.boxplot.median,
        q3: rawStat.boxplot.q3,
        lowerWhisker: rawStat.boxplot.lowerWhisker,
        upperWhisker: rawStat.boxplot.upperWhisker,
        ...(unrestricted || isOutlierCountDisclosable(presentRows, rawStat.boxplot, valueOf)
          ? { outlierCount: rawStat.boxplot.outlierCount }
          : {}),
      };

      continuous.push({
        variableKey: key,
        kind: 'continuous',
        suppressed: false,
        n: rawStat.n,
        missingCount: missingRows.length,
        missingPatterns: buildMissingPatterns(missingRows, key, unrestricted),
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
        histogram,
        histogramReasonCode,
        boxplot,
      });
      continue;
    }

    // discrete — level별 person count는 Python이 모르므로 Node가 DatasetRow로 재계산.
    const levelPersonSets = new Map<string, Set<string>>();
    const levelRowCounts = new Map<string, number>();
    for (const row of presentRows) {
      const value = normalizeForCompare(row.values[key]!.value);
      const levelKey = discreteLevelKey(value);
      let set = levelPersonSets.get(levelKey);
      if (!set) { set = new Set(); levelPersonSets.set(levelKey, set); }
      set.add(row.personClusterKey);
      levelRowCounts.set(levelKey, (levelRowCounts.get(levelKey) ?? 0) + 1);
    }
    const anySmallLevel = [...levelPersonSets.values()].some((set) => isSmall(set.size));

    // 소수 범주 "기타" 병합 — 아래 조건을 전부 만족할 때만 한다. 하나라도 어기면 지금처럼
    // 변수 전체 연결 억제다.
    //   - 호출부가 옵션을 켰음(일반 기술통계 경로만. Table1 층화는 그룹·전체 차감 역산을
    //     따로 검토해야 해서 이번 범위 밖).
    //   - ordinal이 아님(등급 순서가 깨지므로).
    //   - 요청 변수가 이 변수 하나뿐임. 같은 응답의 다른 변수가 값이나 결측 분할로 "기타"
    //     안을 쪼개 보여 주면 한 응답만으로 소수 범주가 역산된다(상병 코드+부위군,
    //     mddmStatus+lifetimeDoseMNh 반례). 변수 사이의 종속은 모듈마다 달라 하나씩
    //     판정하면 빠뜨리기 쉬우므로 변수 개수로 구조적으로 막는다.
    //   - 결측 인원이 소수셀이 아님(결측 쪽은 병합 대상이 아니다).
    const canMerge = options?.mergeSmallLevels === true
      && catalogByKey.get(key)?.type !== 'ordinal'
      && variableKeys.length === 1
      && !isSmallCell(missingPersonCount);

    let mergePlan: SmallLevelMergePlan | null = null;
    if (anySmallLevel && canMerge) {
      mergePlan = planSmallLevelMerge(levelPersonSets, levelRowCounts);
    }
    if (isSmall(missingPersonCount) || (anySmallLevel && !mergePlan)) {
      discrete.push({ variableKey: key, kind: 'discrete', suppressed: true });
      continue;
    }
    const rawStat = rawDiscreteByKey.get(key);
    if (!rawStat) throw new Error(`missing discrete engine result for '${key}'`);
    const n = rawStat.n;
    const keptEngineLevels = mergePlan
      ? rawStat.levels.filter((lvl) => !mergePlan!.otherKeys.has(discreteLevelKey(lvl.level)))
      : rawStat.levels;
    const levels: AnalyzeDiscreteLevel[] = keptEngineLevels.map((lvl) => ({
      level: lvl.level,
      count: lvl.count,
      proportion: n > 0 ? lvl.count / n : 0,
    }));
    const otherCount = mergePlan
      ? rawStat.levels
        .filter((lvl) => mergePlan!.otherKeys.has(discreteLevelKey(lvl.level)))
        .reduce((sum, lvl) => sum + lvl.count, 0)
      : 0;
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
      missingPatterns: buildMissingPatterns(missingRows, key, unrestricted),
      levels,
      // mode는 남은 실제 범주만으로 고른다 — "기타"는 범주가 아니다.
      ...(mergePlan ? { other: { count: otherCount, proportion: n > 0 ? otherCount / n : 0 } } : {}),
      mode: pickMode(levels, key),
    });
  }

  return { continuous, discrete };
}

export interface ComputeDescriptiveSuppressionOptions {
  /** 소수 범주(1~9명)를 "기타"로 합쳐 공개한다. 기본 false(= 하나라도 소수면 변수 전체 억제). */
  mergeSmallLevels?: boolean;
  /**
   * 소수 셀(1~9명) 판정을 전부 끈다 — 변수 연결 억제·범주 병합·결측 분포 생략·히스토그램
   * 해상도 축소·이상치 건수 게이트 모두 해당. stats.export_limited_rows 권한자의 응답 시점
   * 전용이며 결과를 캐시(stats_runs.result)에 저장하면 안 된다.
   */
  unrestricted?: boolean;
}

// 이산형 범주 키 — Python compute_discrete의 (타입명, 값) 그룹 키와 같은 분할이다.
function discreteLevelKey(value: unknown): string {
  return `${typeof value}:${String(value)}`;
}

interface SmallLevelMergePlan {
  /** "기타"로 합쳐지는 범주 키(원래 소수 범주 + 10명을 채우려고 끌어온 범주). */
  otherKeys: Set<string>;
}

// 소수 범주 병합 계획. 소수 범주(1~9명)를 전부 "기타" 후보에 넣고 인원은 person 합집합으로
// 센다(같은 사람이 두 범주에 걸쳐도 1명). 합친 "기타"도 소수셀(1~9명)이면 남은 공개 범주
// 중 고유 인원이 가장 적은 것부터 끌어와 10명 이상이 되게 한다(동률은 행 수, 그다음
// 범주 키 문자열 순서로 결정적으로 정한다). 이름 붙은 범주가 2개 미만으로 남으면 null
// (= 병합해도 의미 있는 분포가 아니므로 변수 전체 억제).
//
// 안전성: 공개되는 모든 셀(각 범주·"기타"·결측)이 0명이거나 10명 이상이다. "기타" 건수는
// n − 공개 합계로 어차피 계산되는 값이고 10명 이상이라 소수 셀이 아니다.
function planSmallLevelMerge(
  levelPersonSets: Map<string, Set<string>>,
  levelRowCounts: Map<string, number>,
): SmallLevelMergePlan | null {
  const otherKeys = new Set<string>();
  const otherPersons = new Set<string>();
  const kept: string[] = [];
  for (const [levelKey, persons] of levelPersonSets) {
    if (isSmallCell(persons.size)) {
      otherKeys.add(levelKey);
      for (const p of persons) otherPersons.add(p);
    } else {
      kept.push(levelKey);
    }
  }

  kept.sort((a, b) => {
    const bySize = levelPersonSets.get(a)!.size - levelPersonSets.get(b)!.size;
    if (bySize !== 0) return bySize;
    const byRows = (levelRowCounts.get(a) ?? 0) - (levelRowCounts.get(b) ?? 0);
    if (byRows !== 0) return byRows;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  while (isSmallCell(otherPersons.size) && kept.length > 0) {
    const pulled = kept.shift()!;
    otherKeys.add(pulled);
    for (const p of levelPersonSets.get(pulled)!) otherPersons.add(p);
  }
  if (isSmallCell(otherPersons.size) || kept.length < 2) return null;
  return { otherKeys };
}

// 권한자 원본 범주 빈도(rawLevels) — 범주별 소수셀 게이트·"기타" 병합을 거치지 않은 원본.
// 변수 수준 조건만 본다: 유효값 고유 인원과 결측 고유 인원이 각각 0명이거나 ≥10명이어야
// 한다(연속형 rawHistogram과 같은 원칙). 그래서 공개 판정에서 억제된 변수(직종명 등)에도
// 붙을 수 있다. 호출부(statsLimitedRowMerge.ts)는 stats.export_limited_rows 권한을 확인한
// 뒤에만 불러야 하고, 결과를 stats_runs.result 캐시에 저장하면 안 된다.
// 건수는 Python 요청 조립(buildStatsEngineRequest)과 같은 필터(missing===null, 값 not null)로
// 센다. 순서는 공개 경로와 같다(첫 등장 순서, 순서형이면 심각도 순서).
export function computeRawDiscreteLevels(
  rows: DatasetRow[],
  key: string,
): AnalyzeDiscreteLevel[] | null {
  const presentRows = rows.filter((r) => r.values[key]?.missing === null);
  const missingRows = rows.filter((r) => r.values[key] !== undefined && r.values[key]!.missing !== null);
  if (isSmallCell(distinctPersons(presentRows)) || isSmallCell(distinctPersons(missingRows))) return null;

  const order: string[] = [];
  const counts = new Map<string, number>();
  const representative = new Map<string, string | boolean>();
  let total = 0;
  for (const row of presentRows) {
    const extracted = row.values[key]!;
    if (extracted.value === null) continue;
    const value = normalizeForCompare(extracted.value) as string | boolean;
    const levelKey = discreteLevelKey(value);
    if (!counts.has(levelKey)) {
      counts.set(levelKey, 0);
      representative.set(levelKey, value);
      order.push(levelKey);
    }
    counts.set(levelKey, counts.get(levelKey)! + 1);
    total += 1;
  }
  if (total === 0) return null;

  const levels: AnalyzeDiscreteLevel[] = order.map((levelKey) => ({
    level: representative.get(levelKey)!,
    count: counts.get(levelKey)!,
    proportion: counts.get(levelKey)! / total,
  }));
  const ordinalOrder = getOrdinalOrder(key);
  if (ordinalOrder) {
    levels.sort((a, b) => ordinalOrder.indexOf(String(a.level)) - ordinalOrder.indexOf(String(b.level)));
  }
  return levels;
}
