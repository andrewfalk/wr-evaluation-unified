// PR1 계획서 §4.2/§9-item5 — 소수 셀 "변수 전체 연결 억제" 실측 검증. 사용자가 1차
// 검토에서 제시한 두 시나리오(boolean 100/96/4, continuous 100/97/3)를 그대로 재현한다.
import { describe, expect, it } from 'vitest';
import type { AnalyticsVariableMetadata, ExtractedValue } from '@wr/analytics-core';
import type { DatasetRow } from '../statsDatasetBuilder';
import { computeDescriptiveSuppression, buildStatsEngineRequest } from '../statsDescriptiveSuppression';
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
    // "값이 있지만 histogram/boxplot 자체가 Python에서 null로 온" 경우를 재현한다.
    const presentEntries = Array.from({ length: 15 }, () => ({ value: 5 }));
    const raw: StatsEngineRawResult = {
      continuous: [{
        variableKey: key, n: 15, mean: 5, sd: 0, median: 5, q1: 5, q3: 5, iqr: 0,
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
});
