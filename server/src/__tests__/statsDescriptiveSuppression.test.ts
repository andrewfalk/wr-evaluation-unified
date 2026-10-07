// PR1 계획서 §4.2/§9-item5 — 소수 셀 "변수 전체 연결 억제" 실측 검증. 사용자가 1차
// 검토에서 제시한 두 시나리오(boolean 100/96/4, continuous 100/97/3)를 그대로 재현한다.
import { describe, expect, it } from 'vitest';
import type { AnalyticsVariableMetadata, ExtractedValue } from '@wr/analytics-core';
import type { DatasetRow } from '../statsDatasetBuilder';
import { computeDescriptiveSuppression, computeRawDiscreteLevels, buildStatsEngineRequest } from '../statsDescriptiveSuppression';
import type { StatsEngineRawResult } from '../statsEngine';

function meta(key: string, type: AnalyticsVariableMetadata['type']): AnalyticsVariableMetadata {
  return {
    key, label: key, group: 'test', moduleId: 'test', grain: 'case', type,
    provenance: 'derived', dependsOn: [], availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: ['association'], sensitivity: 'non_sensitive',
    formulaFamily: 'test', supportedFormulaPolicies: ['recompute_current'],
  };
}

function extracted<T>(value: T | null, missing: ExtractedValue<T>['missing'] = null): ExtractedValue<T> {
  return { value, missing, qualityFlags: [] };
}

function rows(key: string, entries: Array<{ value: unknown; missing?: ExtractedValue<unknown>['missing'] }>): DatasetRow[] {
  return entries.map((e, i) => ({
    caseId: `case-${i}`,
    personClusterKey: `person-${i}`, // 1:1 person:case — 시나리오 단순화
    values: { [key]: extracted(e.missing ? null : e.value, e.missing ?? null) },
  }));
}

const emptyRaw: StatsEngineRawResult = { continuous: [], discrete: [] };

describe('computeDescriptiveSuppression — 변수 전체 연결 억제', () => {
  it('boolean 100건 true=96/false=4/missing=0 — false뿐 아니라 true도 함께 억제된다', () => {
    const key = 'shoulder.exposure.anyExceeded';
    const entries = [
      ...Array.from({ length: 96 }, () => ({ value: true })),
      ...Array.from({ length: 4 }, () => ({ value: false })),
    ];
    const catalogByKey = new Map([[key, meta(key, 'boolean')]]);
    const result = computeDescriptiveSuppression(rows(key, entries), [key], catalogByKey, emptyRaw);

    expect(result.discrete).toHaveLength(1);
    const d = result.discrete[0];
    expect(d.suppressed).toBe(true);
    // 억제된 응답은 variableKey/kind/suppressed 외 아무 필드도 없어야 한다(정보 누설 방지).
    expect(Object.keys(d)).toEqual(['variableKey', 'kind', 'suppressed']);
  });

  it('continuous 100건 valid=97/missing=3 — 변수 전체(mean/sd/n 포함)가 억제된다', () => {
    const key = 'cervical.case.maxJobCumulativeKgHours';
    const entries = [
      ...Array.from({ length: 97 }, (_, i) => ({ value: 10 + i })),
      ...Array.from({ length: 3 }, () => ({ value: null, missing: 'not_entered' as const })),
    ];
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    const result = computeDescriptiveSuppression(rows(key, entries), [key], catalogByKey, emptyRaw);

    expect(result.continuous).toHaveLength(1);
    const c = result.continuous[0];
    expect(c.suppressed).toBe(true);
    expect(Object.keys(c)).toEqual(['variableKey', 'kind', 'suppressed']);
  });

  it('/preview 총 카운트(공개)와 나란히 놓아도 억제된 셀이 역산되지 않는다', () => {
    // continuous 시나리오: 전체 caseCount=100(=/preview가 이미 공개)은 알아도, 변수 자체가
    // 통째로 억제되므로 validN=97이 노출되지 않아 missing=3을 100-97로 역산할 수 없다.
    const key = 'cervical.case.maxJobCumulativeKgHours';
    const entries = [
      ...Array.from({ length: 97 }, (_, i) => ({ value: 10 + i })),
      ...Array.from({ length: 3 }, () => ({ value: null, missing: 'not_entered' as const })),
    ];
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    const result = computeDescriptiveSuppression(rows(key, entries), [key], catalogByKey, emptyRaw);
    const c = result.continuous[0];
    expect('n' in c).toBe(false);
    expect('missingCount' in c).toBe(false);
  });

  it('결측사유 분포도 부분억제 없이 전체 생략된다(결측 20건 중 A=17/B=3)', () => {
    const key = 'spine.mddm.lifetimeDoseMNh';
    const entries = [
      ...Array.from({ length: 80 }, (_, i) => ({ value: 10 + i })),
      ...Array.from({ length: 17 }, () => ({ value: null, missing: 'not_entered' as const })),
      ...Array.from({ length: 3 }, () => ({ value: null, missing: 'not_assessed' as const })),
    ];
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    const raw: StatsEngineRawResult = {
      continuous: [{
        variableKey: key, n: 80, mean: 50, sd: 10, median: 50, q1: 40, q3: 60, iqr: 20,
        skewness: 0, kurtosis: 0, min: 10, max: 89, nullReasons: {},
        histogram: null, boxplot: null,
      }],
      discrete: [],
    };
    const result = computeDescriptiveSuppression(rows(key, entries), [key], catalogByKey, raw);
    const c = result.continuous[0];
    expect(c.suppressed).toBe(false);
    if (!c.suppressed) {
      expect(c.missingCount).toBe(20);
      // 사유 A(17)/B(3) 둘 다 10명 이상이 아니므로(B=3<10) 분포 전체가 생략돼야 한다 —
      // A만 남기고 B만 가리면 20-17=3으로 역산되므로 부분억제는 절대 금지.
      expect(c.missingPatterns).toBeNull();
    }
  });
});

describe('computeDescriptiveSuppression — PR3-B 히스토그램/박스플롯 배선', () => {
  it('§1 반례 — 히스토그램은 공개되지만 outlierCount/outlierValues는 억제된다', () => {
    const key = 'spine.mddm.lifetimeDoseMNh';
    const values = [
      ...Array.from({ length: 50 }, () => 0),
      ...Array.from({ length: 26 }, () => 1),
      ...Array.from({ length: 23 }, () => 2.49),
      2.51,
    ];
    const entries = values.map((value) => ({ value }));
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    const w = 2.51 / 6;
    const edges = [0, w, 2 * w, 3 * w, 4 * w, 5 * w, 2.51];
    const raw: StatsEngineRawResult = {
      continuous: [{
        variableKey: key, n: 100, mean: 1, sd: 1, median: 0.5, q1: 0, q3: 1, iqr: 1,
        skewness: 0, kurtosis: 0, min: 0, max: 2.51, nullReasons: {},
        histogram: {
          bins: [
            { lower: edges[0], upper: edges[1], count: 50 },
            { lower: edges[1], upper: edges[2], count: 0 },
            { lower: edges[2], upper: edges[3], count: 26 },
            { lower: edges[3], upper: edges[4], count: 0 },
            { lower: edges[4], upper: edges[5], count: 0 },
            { lower: edges[5], upper: edges[6], count: 24 },
          ],
        },
        boxplot: {
          q1: 0, median: 0.5, q3: 1, lowerWhisker: 0, upperWhisker: 2.49,
          lowerFence: -1.5, upperFence: 2.5, outlierCount: 1, outlierValues: [2.51],
        },
      }],
      discrete: [],
    };
    const result = computeDescriptiveSuppression(rows(key, entries), [key], catalogByKey, raw);
    const c = result.continuous[0];
    expect(c.suppressed).toBe(false);
    if (c.suppressed) return;
    // 히스토그램 게이트는 전부 통과(bin 빈도 50/0/26/0/0/24, 전부 0 또는 ≥10명).
    expect(c.histogram?.bins).toHaveLength(6);
    expect(c.histogram?.bins.reduce((s, b) => s + b.count, 0)).toBe(100);
    // 박스플롯 범위값은 그대로 노출.
    expect(c.boxplot?.q1).toBe(0);
    expect(c.boxplot?.upperWhisker).toBe(2.49);
    // 이상치 게이트는 실패(이상치 1명) — outlierCount/outlierValues 키 자체가 없어야 한다.
    expect(c.boxplot && 'outlierCount' in c.boxplot).toBe(false);
    expect(c.boxplot && 'outlierValues' in c.boxplot).toBe(false);
  });

  it('n=0(변수 자체가 계산 불가)이면 histogram/boxplot 둘 다 null', () => {
    const key = 'spine.mddm.lifetimeDoseMNh';
    const entries = Array.from({ length: 20 }, () => ({ value: null, missing: 'not_entered' as const }));
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    // 전부 결측이면 애초에 linkedSuppressed(presentPersonCount=0은 isSmallCell 통과,
    // missingPersonCount=20은 통과)라 변수 전체가 억제되는 경로를 타므로, 대신
    // "값이 있지만 엔진이 q1/q3/median을 null로 준"(analyze.py가 histogram/boxplot을
    // 만들지 않는 조건) 경우를 재현한다. 원본 bin은 이제 Node가 만들므로(끝 구간 병합
    // PR) 히스토그램 생성 여부도 Python의 histogram이 아니라 이 분위수 조건으로 정해진다.
    const presentEntries = Array.from({ length: 15 }, () => ({ value: 5 }));
    const raw: StatsEngineRawResult = {
      continuous: [{
        variableKey: key, n: 15, mean: 5, sd: 0, median: null, q1: null, q3: null, iqr: null,
        skewness: null, kurtosis: null, min: 5, max: 5, nullReasons: {},
        histogram: null, boxplot: null,
      }],
      discrete: [],
    };
    const result = computeDescriptiveSuppression(
      [...rows(key, presentEntries), ...rows(key, entries.slice(0, 15))],
      [key], catalogByKey, raw,
    );
    const c = result.continuous[0];
    expect(c.suppressed).toBe(false);
    if (c.suppressed) return;
    expect(c.histogram).toBeNull();
    expect(c.boxplot).toBeNull();
    // B안 — rawStat.histogram이 애초에 없던 경우(위 시나리오)와 재분할까지 실패한
    // 경우를 구분해야 하므로, 전자는 histogramReasonCode도 채워지지 않아야 한다.
    expect(c.histogramReasonCode).toBeNull();
  });

  it('B안 — 재분할 후보를 전부 시도해도 실패하면 histogram은 null, histogramReasonCode가 채워진다', () => {
    const key = 'spine.mddm.lifetimeDoseMNh';
    // 9명이 lo(0)에 고립, 91명이 반대쪽 끝(250)에 몰려 있어 몇 개로 재분할하든
    // (하한 3개까지) lo쪽 구간엔 그 9명만 남는다(statsChartDisclosure.test.ts의
    // 동일 시나리오를 실제 배선 경로로 재확인).
    const entries = [
      ...Array.from({ length: 9 }, () => ({ value: 0 })),
      ...Array.from({ length: 91 }, () => ({ value: 250 })),
    ];
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    const raw: StatsEngineRawResult = {
      continuous: [{
        variableKey: key, n: 100, mean: 227.5, sd: 75, median: 250, q1: 250, q3: 250, iqr: 0,
        skewness: null, kurtosis: null, min: 0, max: 250, nullReasons: {},
        histogram: {
          bins: [
            { lower: 0, upper: 75, count: 9 },
            { lower: 75, upper: 150, count: 0 },
            { lower: 150, upper: 225, count: 0 },
            { lower: 225, upper: 300, count: 91 },
          ],
        },
        boxplot: null,
      }],
      discrete: [],
    };
    const result = computeDescriptiveSuppression(rows(key, entries), [key], catalogByKey, raw);
    const c = result.continuous[0];
    expect(c.suppressed).toBe(false);
    if (c.suppressed) return;
    expect(c.histogram).toBeNull();
    expect(c.histogramReasonCode).toBe('INSUFFICIENT_DISCLOSABLE_RESOLUTION');
  });

  it('끝 구간 병합 — 원본은 오른쪽 끝 소수셀 때문에 실패해도 원본 해상도의 끝 병합으로 노출되고(tailMerged) histogramReasonCode는 null이다', () => {
    const key = 'spine.mddm.lifetimeDoseMNh';
    // 실제 배선 경로 — 원본 bin은 Python 결과(여기선 일부러 null)가 아니라 Node
    // buildOriginalHistogram이 rows와 엔진 q1/q3로 만든다. lo=35·hi=385, q1=60·q3=165
    // (IQR 105, 60명) → FD h≈53.6 → ceil(350/53.6)=7개(폭 50) → 원본 인원
    // [13,18,12,10,4,0,3](335·385는 마지막 두 bin에 각각 2·1명이지만 경계 포함 규칙상
    // 같은 마지막 bin [335,385]에 3명). 오른쪽 끝 3명 → 0 → 4 → 10명 bin까지 흡수.
    const at = (value: number, n: number) => Array.from({ length: n }, () => ({ value }));
    const entries = [...at(35, 13), ...at(85, 18), ...at(135, 12), ...at(185, 10), ...at(235, 4), ...at(335, 2), ...at(385, 1)];
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    const raw: StatsEngineRawResult = {
      continuous: [{
        variableKey: key, n: 60, mean: 120, sd: 80, median: 85, q1: 60, q3: 165, iqr: 105,
        skewness: 1, kurtosis: 1, min: 35, max: 385, nullReasons: {},
        histogram: null, // Node는 더 이상 Python 히스토그램을 쓰지 않는다
        boxplot: null,
      }],
      discrete: [],
    };
    const result = computeDescriptiveSuppression(rows(key, entries), [key], catalogByKey, raw);
    const c = result.continuous[0];
    expect(c.suppressed).toBe(false);
    if (c.suppressed) return;
    expect(c.histogramReasonCode).toBeNull();
    expect(c.histogram?.merged).toBe(false); // 재분할 아님 — 원본 해상도 그대로
    const bins = c.histogram!.bins;
    // 오른쪽 끝 3개 bin(4·0·3명)이 그 안쪽 10명 bin까지 흡수해 17명 하나로 합쳐진다.
    expect(bins.map((b) => b.count)).toEqual([13, 18, 12, 17]);
    expect(bins.map((b) => b.tailMerged === true)).toEqual([false, false, false, true]);
    expect(bins[0].lower).toBe(35);
    expect(bins[bins.length - 1].upper).toBe(385);
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(60);
  });
});

// 비명목 동점 최빈값은 localeCompare가 아니라 코드유닛 순서다 — 서버 로케일·ICU에 따라 결과가
// 달라지면 클라이언트가 원본 표시 때 다시 고르는 값(discreteLevels.js pickModeFromLevels, 같은
// 반례로 테스트)과 어긋난다. ko-KR 로케일에서 localeCompare는 "가"<"A"이므로 이 PC에서도 옛 구현은 실패한다.
describe('computeDescriptiveSuppression — 비순서형 동점 최빈값은 로케일 무관 코드유닛 순서', () => {
  const key = 'job.identity.jobNameNormalized';
  const catalogByKey = new Map([[key, meta(key, 'high_cardinality')]]);
  const tieMode = (a: string, b: string) => {
    const entries = [
      ...Array.from({ length: 12 }, () => ({ value: a })),
      ...Array.from({ length: 12 }, () => ({ value: b })),
    ];
    const raw: StatsEngineRawResult = {
      continuous: [],
      discrete: [{ variableKey: key, n: 24, levels: [{ level: a, count: 12 }, { level: b, count: 12 }] }],
    };
    const d = computeDescriptiveSuppression(rows(key, entries), [key], catalogByKey, raw).discrete[0];
    if (d.suppressed) throw new Error('unexpected suppressed');
    return d.mode;
  };

  it('"A" vs "가" 동점이면 "A"(코드유닛 65 < 44032) — 한국어 로케일의 localeCompare는 "가"를 고른다', () => {
    expect(tieMode('A', '가')).toBe('A');
    expect(tieMode('가', 'A')).toBe('A'); // 입력 순서와 무관
  });

  it('"a" vs "B" 동점이면 "B"(대문자 66 < 소문자 97) — localeCompare는 로케일과 무관하게 "a"를 고른다', () => {
    expect(tieMode('a', 'B')).toBe('B');
  });

  it('같은 문자 체계 안에서는 사전순이다(가 < 나)', () => {
    expect(tieMode('나', '가')).toBe('가');
  });
});

describe('computeDescriptiveSuppression — mode·ordinal 순서(억제 안 됐을 때)', () => {
  it('elbow burdenGradeMax 동점이면 더 낮은(경한) 등급을 mode로 채택한다', () => {
    const key = 'elbow.assessment.burdenGradeMax';
    const entries = [
      ...Array.from({ length: 12 }, () => ({ value: '중등도' })),
      ...Array.from({ length: 12 }, () => ({ value: '경도' })),
    ];
    const catalogByKey = new Map([[key, meta(key, 'ordinal')]]);
    const raw: StatsEngineRawResult = {
      continuous: [],
      discrete: [{
        variableKey: key, n: 24,
        levels: [{ level: '중등도', count: 12 }, { level: '경도', count: 12 }],
      }],
    };
    const result = computeDescriptiveSuppression(rows(key, entries), [key], catalogByKey, raw);
    const d = result.discrete[0];
    expect(d.suppressed).toBe(false);
    if (!d.suppressed) {
      expect(d.mode).toBe('경도');
    }
  });

  it('ordinal 변수는 공개 levels[] 자체도 심각도 순서로 정렬된다(8차 검토 §5 핵심 — mode 동점 처리뿐 아니라 전체 배열)', () => {
    const key = 'elbow.assessment.burdenGradeMax';
    // 입력 등장 순서를 일부러 심각도 역순으로 구성 — "고도"가 먼저, "경도"가 나중.
    const entries = [
      ...Array.from({ length: 15 }, () => ({ value: '고도' })),
      ...Array.from({ length: 15 }, () => ({ value: '경도' })),
      ...Array.from({ length: 15 }, () => ({ value: '중등도' })),
    ];
    const catalogByKey = new Map([[key, meta(key, 'ordinal')]]);
    const raw: StatsEngineRawResult = {
      continuous: [],
      discrete: [{
        variableKey: key, n: 45,
        // Python은 첫 등장 순서 그대로 반환 — 고도, 경도, 중등도 순(입력 순서).
        levels: [{ level: '고도', count: 15 }, { level: '경도', count: 15 }, { level: '중등도', count: 15 }],
      }],
    };
    const result = computeDescriptiveSuppression(rows(key, entries), [key], catalogByKey, raw);
    const d = result.discrete[0];
    expect(d.suppressed).toBe(false);
    if (!d.suppressed) {
      // ELBOW_BURDEN_GRADE_ORDER = ['부담 작업 아님','경도','중등도','고도'] — 공개
      // levels[]는 Python의 입력순서(고도,경도,중등도)가 아니라 이 순서로 재정렬돼야 한다.
      expect(d.levels.map((l) => l.level)).toEqual(['경도', '중등도', '고도']);
    }
  });
});

// 범주형 소수 범주 "기타" 병합 — 옵션({mergeSmallLevels:true})을 켜고, 그 범주형 변수 하나만
// 요청했으며, ordinal이 아닐 때만 1~9명 범주를 합쳐 공개한다. 하나라도 어기면 기존 all-or-nothing.
describe('computeDescriptiveSuppression — 소수 범주 "기타" 병합', () => {
  const key = 'job.identity.jobNameNormalized';
  const catalogByKey = new Map([[key, meta(key, 'high_cardinality')]]);
  const mergeOpts = { mergeSmallLevels: true };

  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_v, i) => `${prefix}${i}`);

  // groups[i].persons의 각 원소가 한 행 — 같은 사람 ID를 반복하면 한 사람의 여러 행이다.
  function fixture(groups: Array<{ value: string | boolean; persons: string[] }>, variableKey = key) {
    const dataRows: DatasetRow[] = [];
    let i = 0;
    for (const g of groups) {
      for (const p of g.persons) {
        dataRows.push({ caseId: `case-${i++}`, personClusterKey: p, values: { [variableKey]: extracted(g.value) } });
      }
    }
    const raw: StatsEngineRawResult = {
      continuous: [],
      discrete: [{
        variableKey, n: dataRows.length,
        levels: groups.map((g) => ({ level: g.value, count: g.persons.length })),
      }],
    };
    return { dataRows, raw };
  }

  function run(groups: Array<{ value: string | boolean; persons: string[] }>, options: { mergeSmallLevels?: boolean } | undefined = mergeOpts) {
    const { dataRows, raw } = fixture(groups);
    return computeDescriptiveSuppression(dataRows, [key], catalogByKey, raw, options).discrete[0];
  }

  it('소수 범주(1명·3명)가 "기타"로 모이고, 합쳐도 4명(<10)이라 가장 작은 공개 범주(12명)를 끌어와 10명 이상으로 채운다', () => {
    const d = run([
      { value: 'A', persons: ids('a', 40) }, { value: 'B', persons: ids('b', 20) },
      { value: 'C', persons: ids('c', 12) }, { value: 'D', persons: ids('d', 1) }, { value: 'E', persons: ids('e', 3) },
    ]);
    expect(d.suppressed).toBe(false);
    if (d.suppressed) return;
    expect(d.levels.map((l) => l.level)).toEqual(['A', 'B']);
    expect(d.other).toEqual({ count: 12 + 1 + 3, proportion: 16 / 76 });
    expect(d.n).toBe(76);
    // 공개되는 모든 셀(범주·기타)의 건수 합이 n과 정확히 같다 — 숨겨진 값이 없다.
    expect(d.levels.reduce((s, l) => s + l.count, 0) + d.other!.count).toBe(d.n);
  });

  it('소수 범주만으로 이미 10명 이상(5+6=11명)이면 더 끌어오지 않는다', () => {
    const d = run([
      { value: 'A', persons: ids('a', 40) }, { value: 'B', persons: ids('b', 20) },
      { value: 'D', persons: ids('d', 6) }, { value: 'E', persons: ids('e', 5) },
    ]);
    expect(d.suppressed).toBe(false);
    if (d.suppressed) return;
    expect(d.levels.map((l) => l.level)).toEqual(['A', 'B']);
    expect(d.other!.count).toBe(11);
  });

  it('"기타"의 인원은 합산이 아니라 person 합집합이다 — 같은 6명이 두 소수 범주에 걸치면 12가 아니라 6명이라 더 끌어온다', () => {
    const same = ids('x', 6);
    const d = run([
      { value: 'A', persons: ids('a', 40) }, { value: 'B', persons: ids('b', 20) }, { value: 'C', persons: ids('c', 12) },
      { value: 'D', persons: same }, { value: 'E', persons: same },
    ]);
    expect(d.suppressed).toBe(false);
    if (d.suppressed) return;
    // 합산(6+6=12≥10)으로 잘못 판정하면 C가 남지만, 합집합(6명)이면 C(12명)를 끌어와 "기타"=18명.
    expect(d.levels.map((l) => l.level)).toEqual(['A', 'B']);
    expect(d.other!.count).toBe(6 + 6 + 12);
  });

  it('끌어올 범주가 동률이면 건수, 그다음 범주 키 문자열 순서로 결정적으로 고른다', () => {
    const d = run([
      { value: 'A', persons: ids('a', 40) }, { value: 'B', persons: ids('b', 12) },
      { value: 'C', persons: ids('c', 12) }, { value: 'D', persons: ids('d', 3) },
    ]);
    expect(d.suppressed).toBe(false);
    if (d.suppressed) return;
    expect(d.levels.map((l) => l.level)).toEqual(['A', 'C']); // 'string:B'가 먼저 끌려간다
    expect(d.other!.count).toBe(12 + 3);
  });

  it('남은 이름 붙은 범주가 2개 미만이면 변수 전체를 억제한다(boolean 96/4, 범주 A 50 + 소수)', () => {
    expect(run([{ value: true, persons: ids('t', 96) }, { value: false, persons: ids('f', 4) }]).suppressed).toBe(true);
    expect(run([{ value: 'A', persons: ids('a', 50) }, { value: 'D', persons: ids('d', 3) }]).suppressed).toBe(true);
    // A 50 + B 20 + 소수 3: 3명 "기타"를 채우려 B를 끌어오면 이름 붙은 범주가 A 하나뿐.
    expect(run([
      { value: 'A', persons: ids('a', 50) }, { value: 'B', persons: ids('b', 20) }, { value: 'D', persons: ids('d', 3) },
    ]).suppressed).toBe(true);
  });

  it('소수 범주가 없으면 지금과 똑같이 공개되고 other 키가 아예 없다', () => {
    const d = run([{ value: 'A', persons: ids('a', 30) }, { value: 'B', persons: ids('b', 25) }]);
    expect(d.suppressed).toBe(false);
    if (d.suppressed) return;
    expect('other' in d).toBe(false);
    expect(d.levels.map((l) => l.count)).toEqual([30, 25]);
  });

  it('옵션이 없으면(Table1 층화 경로) 소수 범주가 있을 때 기존처럼 전체 억제된다', () => {
    const groups = [{ value: 'A', persons: ids('a', 40) }, { value: 'B', persons: ids('b', 20) }, { value: 'D', persons: ids('d', 3) }];
    expect(run(groups, undefined).suppressed).toBe(true);
    expect(run(groups, { mergeSmallLevels: false }).suppressed).toBe(true);
  });

  it('최빈값은 "기타"를 제외한 실제 범주에서만 고른다(기타 40건이 어느 범주보다 커도)', () => {
    // D·E는 각 5명이지만 한 사람이 4행씩이라 행 수는 20 — "기타"=40건 > A=12건.
    const heavy = (prefix: string) => ids(prefix, 5).flatMap((p) => [p, p, p, p]);
    const d = run([
      { value: 'A', persons: ids('a', 12) }, { value: 'B', persons: ids('b', 11) },
      { value: 'D', persons: heavy('d') }, { value: 'E', persons: heavy('e') },
    ]);
    expect(d.suppressed).toBe(false);
    if (d.suppressed) return;
    expect(d.other!.count).toBe(40);
    expect(d.mode).toBe('A');
  });

  it('ordinal 변수는 옵션을 켜도 소수 등급이 있으면 기존처럼 전체 억제한다(등급 순서가 깨지므로)', () => {
    const ordKey = 'elbow.assessment.burdenGradeMax';
    // 같은 데이터를 categorical로 보면 병합이 성립한다(이름 붙은 범주 2개 이상 남음) —
    // ordinal 가드가 있어야만 억제되는지 확인하려는 대조군이다.
    const { dataRows, raw } = fixture([
      { value: '경도', persons: ids('a', 30) }, { value: '중등도', persons: ids('b', 25) },
      { value: '부담 작업 아님', persons: ids('c', 20) }, { value: '고도', persons: ids('d', 3) },
    ], ordKey);
    const asCategorical = computeDescriptiveSuppression(dataRows, [ordKey], new Map([[ordKey, meta(ordKey, 'categorical')]]), raw, mergeOpts).discrete[0];
    expect(asCategorical.suppressed).toBe(false);
    const asOrdinal = computeDescriptiveSuppression(dataRows, [ordKey], new Map([[ordKey, meta(ordKey, 'ordinal')]]), raw, mergeOpts).discrete[0];
    expect(asOrdinal.suppressed).toBe(true);
  });

  it('결측 인원이 1~9명이면 병합 옵션을 켜도 전체 억제한다', () => {
    const { dataRows, raw } = fixture([{ value: 'A', persons: ids('a', 30) }, { value: 'B', persons: ids('b', 25) }]);
    const missingRows: DatasetRow[] = ids('m', 5).map((p, i) => ({
      caseId: `m-${i}`, personClusterKey: p, values: { [key]: extracted(null, 'not_entered') },
    }));
    const d = computeDescriptiveSuppression([...dataRows, ...missingRows], [key], catalogByKey, raw, mergeOpts).discrete[0];
    expect(d.suppressed).toBe(true);
  });

  // 같은 응답의 다른 변수가 값이나 결측 분할로 "기타" 안을 쪼개 보여 주면 한 응답만으로 소수
  // 범주가 역산된다(Codex 리뷰 2·3회차 반례). 변수 사이 종속은 모듈마다 달라 변수 개수로 막는다.
  describe('변수가 2개 이상이면 병합하지 않는다(단일 응답 역산 반례)', () => {
    const groups = [
      { value: 'A', persons: ids('a', 20) }, { value: 'B', persons: ids('b', 20) },
      { value: 'D', persons: ids('d', 1) }, { value: 'E', persons: ids('e', 9) },
    ];

    it('상병 코드 + 부위군 반례: 범주형 두 변수를 함께 요청하면 코드 변수는 억제되고 단독이면 병합된다', () => {
      const codeKey = 'disease.identity.diagnosisCode';
      const groupKey = 'disease.identity.bodyRegionGroup';
      const { dataRows, raw } = fixture(groups, codeKey);
      // 부위군(무릎=21, 어깨=29)은 소수 셀이 없어 그 자체로는 공개 가능한 변수다.
      for (const [i, r] of dataRows.entries()) r.values[groupKey] = extracted(i < 21 ? '무릎' : '어깨');
      raw.discrete.push({ variableKey: groupKey, n: dataRows.length, levels: [{ level: '무릎', count: 21 }, { level: '어깨', count: dataRows.length - 21 }] });
      const catalog = new Map([[codeKey, meta(codeKey, 'categorical')], [groupKey, meta(groupKey, 'categorical')]]);

      const together = computeDescriptiveSuppression(dataRows, [codeKey, groupKey], catalog, raw, mergeOpts);
      expect(together.discrete.find((d) => d.variableKey === codeKey)!.suppressed).toBe(true);

      const alone = computeDescriptiveSuppression(dataRows, [codeKey], catalog, raw, mergeOpts);
      expect(alone.discrete[0].suppressed).toBe(false);
    });

    it('mddmStatus + lifetimeDoseMNh 반례: 결측으로 "기타"를 쪼갤 수 있는 연속형과 함께 요청해도 억제된다', () => {
      const statusKey = 'spine.case.mddmStatus';
      const doseKey = 'spine.mddm.lifetimeDoseMNh';
      const { dataRows, raw } = fixture(groups, statusKey);
      for (const [i, r] of dataRows.entries()) {
        // D(1명)가 결측 사유가 되는 분할 — 결측 21 = D 1 + 나머지 20.
        r.values[doseKey] = i < 21 ? extracted(null, 'not_entered') : extracted(10 + i);
      }
      raw.continuous.push({
        variableKey: doseKey, n: dataRows.length - 21, mean: 50, sd: 10, median: null, q1: null, q3: null, iqr: null,
        skewness: null, kurtosis: null, min: 10, max: 90, nullReasons: {}, histogram: null, boxplot: null,
      });
      const catalog = new Map([[statusKey, meta(statusKey, 'categorical')], [doseKey, meta(doseKey, 'continuous')]]);
      const together = computeDescriptiveSuppression(dataRows, [statusKey, doseKey], catalog, raw, mergeOpts);
      expect(together.discrete[0].suppressed).toBe(true);
    });

    it('범주형 + 아무 연속형이나 조합해도 병합하지 않고, 같은 범주형을 단독으로 요청하면 병합한다', () => {
      const { dataRows, raw } = fixture(groups);
      const contKey = 'knee.relatedness.max';
      for (const r of dataRows) r.values[contKey] = extracted(5);
      raw.continuous.push({
        variableKey: contKey, n: dataRows.length, mean: 5, sd: 0, median: null, q1: null, q3: null, iqr: null,
        skewness: null, kurtosis: null, min: 5, max: 5, nullReasons: {}, histogram: null, boxplot: null,
      });
      const catalog = new Map([[key, meta(key, 'high_cardinality')], [contKey, meta(contKey, 'continuous')]]);
      expect(computeDescriptiveSuppression(dataRows, [key, contKey], catalog, raw, mergeOpts).discrete[0].suppressed).toBe(true);
      const alone = computeDescriptiveSuppression(dataRows, [key], catalog, raw, mergeOpts).discrete[0];
      expect(alone.suppressed).toBe(false);
    });
  });
});

describe('computeRawDiscreteLevels — 권한자 원본 범주 빈도', () => {
  const key = 'job.identity.jobNameNormalized';
  const dRow = (i: number, person: string, value: unknown, missing: ExtractedValue<unknown>['missing'] = null): DatasetRow => ({
    caseId: `c${i}`, personClusterKey: person, values: { [key]: extracted(missing ? null : value, missing) },
  });

  it('범주별 소수셀 게이트 없이 1명 범주까지 원본 그대로 센다(첫 등장 순서, 합=유효 행 수)', () => {
    const entries = [
      ...Array.from({ length: 30 }, (_v, i) => dRow(i, `a${i}`, '용접공')),
      dRow(100, 'z1', '잠수부'),
      ...Array.from({ length: 12 }, (_v, i) => dRow(200 + i, `b${i}`, '간호사')),
    ];
    const levels = computeRawDiscreteLevels(entries, key)!;
    expect(levels.map((l) => [l.level, l.count])).toEqual([['용접공', 30], ['잠수부', 1], ['간호사', 12]]);
    expect(levels.reduce((s, l) => s + l.proportion, 0)).toBeCloseTo(1, 10);
  });

  it('유효값 인원이 1~9명이면 null(변수 수준 게이트)', () => {
    const entries = Array.from({ length: 5 }, (_v, i) => dRow(i, `a${i}`, '용접공'));
    expect(computeRawDiscreteLevels(entries, key)).toBeNull();
  });

  it('결측 인원이 1~9명이면 null', () => {
    const entries = [
      ...Array.from({ length: 30 }, (_v, i) => dRow(i, `a${i}`, '용접공')),
      ...Array.from({ length: 4 }, (_v, i) => dRow(50 + i, `m${i}`, null, 'not_entered')),
    ];
    expect(computeRawDiscreteLevels(entries, key)).toBeNull();
  });

  it('유효값이 하나도 없으면 null', () => {
    expect(computeRawDiscreteLevels([], key)).toBeNull();
  });

  it('공개 경로의 범주 건수와 정확히 같다(소수 범주가 없는 변수)', () => {
    const entries = [
      ...Array.from({ length: 30 }, (_v, i) => dRow(i, `a${i}`, 'A')),
      ...Array.from({ length: 25 }, (_v, i) => dRow(100 + i, `b${i}`, 'B')),
    ];
    const raw: StatsEngineRawResult = { continuous: [], discrete: [{ variableKey: key, n: 55, levels: [{ level: 'A', count: 30 }, { level: 'B', count: 25 }] }] };
    const pub = computeDescriptiveSuppression(entries, [key], new Map([[key, meta(key, 'categorical')]]), raw).discrete[0];
    if (pub.suppressed) throw new Error('unexpected suppressed');
    expect(computeRawDiscreteLevels(entries, key)).toEqual(pub.levels);
  });

  it('ordinal 변수는 심각도 순서로 정렬한다', () => {
    const ordKey = 'elbow.assessment.burdenGradeMax';
    const entries: DatasetRow[] = [
      ...Array.from({ length: 12 }, (_v, i) => ({ caseId: `h${i}`, personClusterKey: `h${i}`, values: { [ordKey]: extracted('고도') } })),
      ...Array.from({ length: 12 }, (_v, i) => ({ caseId: `l${i}`, personClusterKey: `l${i}`, values: { [ordKey]: extracted('경도') } })),
    ];
    expect(computeRawDiscreteLevels(entries, ordKey)!.map((l) => l.level)).toEqual(['경도', '고도']);
  });
});

describe('buildStatsEngineRequest', () => {
  it('결측이 아닌 값만, NFC 정규화된 상태로 변수별 flat 배열을 만든다', () => {
    const key = 'elbow.assessment.burdenGradeMax';
    const data = rows(key, [{ value: '고도' }, { value: null, missing: 'not_entered' }, { value: '경도' }]);
    const catalogByKey = new Map([[key, meta(key, 'ordinal')]]);
    const request = buildStatsEngineRequest(data, [key], catalogByKey);
    expect(request.variables).toHaveLength(1);
    expect(request.variables[0].kind).toBe('discrete');
    expect(request.variables[0].values).toEqual(['고도', '경도']);
  });

  it('continuous 카탈로그 타입은 kind: continuous로 매핑된다', () => {
    const key = 'spine.vibration.dvMax';
    const data = rows(key, [{ value: 1.5 }, { value: 2.5 }]);
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    const request = buildStatsEngineRequest(data, [key], catalogByKey);
    expect(request.variables[0].kind).toBe('continuous');
    expect(request.variables[0].values).toEqual([1.5, 2.5]);
  });

  // A안 — histogram bin 개수를 행 수가 아니라 실제 인원 수 기준으로 계산하기 위한
  // personCount 힌트. discrete는 histogram이 없으므로 채우지 않는다(불필요한 필드 방지).
  it('continuous 변수는 결측 아닌 행의 고유 personClusterKey 수를 personCount로 함께 보낸다', () => {
    const key = 'spine.vibration.dvMax';
    const data = rows(key, [{ value: 1.5 }, { value: 2.5 }, { value: null, missing: 'not_entered' }]);
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    const request = buildStatsEngineRequest(data, [key], catalogByKey);
    expect(request.variables[0].personCount).toBe(2);
  });

  it('브로드캐스트로 같은 사람이 여러 행을 차지해도 personCount는 중복 없이 세어진다', () => {
    const key = 'knee.relatedness.max';
    const data: DatasetRow[] = [
      { caseId: 'case-1', personClusterKey: 'person-1', values: { [key]: extracted(70) } },
      { caseId: 'case-1', personClusterKey: 'person-1', values: { [key]: extracted(70) } },
      { caseId: 'case-2', personClusterKey: 'person-2', values: { [key]: extracted(55) } },
    ];
    const catalogByKey = new Map([[key, meta(key, 'continuous')]]);
    const request = buildStatsEngineRequest(data, [key], catalogByKey);
    expect(request.variables[0].values).toHaveLength(3);
    expect(request.variables[0].personCount).toBe(2);
  });

  it('discrete 변수에는 personCount를 채우지 않는다(histogram이 없으므로 불필요)', () => {
    const key = 'elbow.assessment.burdenGradeMax';
    const data = rows(key, [{ value: '고도' }]);
    const catalogByKey = new Map([[key, meta(key, 'ordinal')]]);
    const request = buildStatsEngineRequest(data, [key], catalogByKey);
    expect(request.variables[0].personCount).toBeUndefined();
  });
});
