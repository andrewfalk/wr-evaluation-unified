import { describe, it, expect } from 'vitest';
import {
  AnalyzeRegressionResultSchema,
  StatsAnalysisRecipeSchema,
  AnalyzeResultSchema,
} from '../stats';

// PR4-A1 — 계획서(pr4-a-lexical-reddy.md) §1 "결과 스키마 — 상태 4종" / "상태 불변식"
// 표를 그대로 테스트로 고정한다. 리뷰 #15가 잡은 "discriminatedUnion 선택지 객체에
// .superRefine()을 붙이면 스키마 생성 단계에서 죽는다"는 zod 3 함정이 재발하지
// 않는지를 확인하는 것이 이 파일의 1차 목적이다(모듈 import 자체가 그 회귀 테스트).

const okPayload = {
  suppressed: false as const,
  estimation: 'ok' as const,
  method: 'ols_linear' as const,
  outcomeKey: 'x',
  eventLevel: null,
  referenceLevelsUsed: {},
  covariance: 'hc3' as const,
  inferenceDistribution: 't' as const,
  inferenceDf: 38,
  residualDf: 38,
  n: 40,
  personCount: 40,
  clusterCount: null,
  maxClusterShare: null,
  terms: [{
    name: 'x1', label: 'x1', variableKey: 'x1', level: null,
    estimate: 1.2, se: 0.3, statistic: 4.0, pValue: 0.001,
    ciLower: 0.6, ciUpper: 1.8, exponentiated: null,
  }],
  fit: { r2: 0.5, adjR2: 0.48, logLik: null, aic: null, pseudoR2: null },
  nonEstimableReason: null,
  inferenceWithheldReason: null,
  excludedRowCount: 0,
  qualityFlags: [],
  analysisUnitNote: 'note',
};

describe('AnalyzeRegressionResultSchema — 스키마 생성 smoke (리뷰 #15)', () => {
  it('모듈 import·스키마 생성이 던지지 않는다', () => {
    expect(AnalyzeRegressionResultSchema).toBeDefined();
  });
});

describe('AnalyzeRegressionResultSchema — suppressed 상태', () => {
  it('suppressed:true + MIN_COHORT_NOT_MET을 허용한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({ suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' });
    expect(r.success).toBe(true);
  });

  it('suppressed:true에 다른 필드가 섞이면 거부한다(strict)', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET', n: 10,
    });
    expect(r.success).toBe(false);
  });
});

describe('AnalyzeRegressionResultSchema — estimation:"ok"', () => {
  it('정상 계수(유한 SE>0, 유한 p/CI)를 허용한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse(okPayload);
    expect(r.success).toBe(true);
  });

  it('terms가 비어 있으면 거부한다(리뷰 #9 — ok는 항상 계수를 낸다)', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({ ...okPayload, terms: [] });
    expect(r.success).toBe(false);
  });

  it('fit이 null이면 거부한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({ ...okPayload, fit: null });
    expect(r.success).toBe(false);
  });

  it('se===0(완전적합)을 거부한다(리뷰 #16/#19)', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...okPayload,
      terms: [{ ...okPayload.terms[0], se: 0, statistic: Infinity, pValue: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it('se가 음수이면 거부한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...okPayload,
      terms: [{ ...okPayload.terms[0], se: -0.1 }],
    });
    expect(r.success).toBe(false);
  });

  it('pValue가 비유한(NaN 등)이면 거부한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...okPayload,
      terms: [{ ...okPayload.terms[0], pValue: NaN }],
    });
    expect(r.success).toBe(false);
  });

  it('ok인데 inferenceWithheldReason이 세팅돼 있으면 거부한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...okPayload,
      inferenceWithheldReason: 'TOO_FEW_CLUSTERS',
    });
    expect(r.success).toBe(false);
  });

  it('ok인데 nonEstimableReason이 세팅돼 있으면 거부한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...okPayload,
      nonEstimableReason: 'RANK_DEFICIENT',
    });
    expect(r.success).toBe(false);
  });
});

describe('AnalyzeRegressionResultSchema — estimation:"inference_withheld" (클러스터 사유)', () => {
  const withheldClusterPayload = {
    ...okPayload,
    estimation: 'inference_withheld' as const,
    covariance: 'person_cluster_cr1' as const,
    inferenceWithheldReason: 'TOO_FEW_CLUSTERS' as const,
    clusterCount: 12,
    maxClusterShare: 0.3,
    terms: [{
      name: 'x1', label: 'x1', variableKey: 'x1', level: null,
      estimate: 1.2, se: 0.3, statistic: null, pValue: null,
      ciLower: null, ciUpper: null, exponentiated: null,
    }],
  };

  it('계수·SE는 유지하고 p/CI/statistic은 null인 상태를 허용한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse(withheldClusterPayload);
    expect(r.success).toBe(true);
  });

  it('CLUSTER_IMBALANCE 사유도 같은 shape으로 허용한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...withheldClusterPayload,
      inferenceWithheldReason: 'CLUSTER_IMBALANCE',
    });
    expect(r.success).toBe(true);
  });

  it('se가 null이면 거부한다(클러스터 사유는 SE가 유한해야 한다 — 리뷰 #17 불변식)', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...withheldClusterPayload,
      terms: [{ ...withheldClusterPayload.terms[0], se: null }],
    });
    expect(r.success).toBe(false);
  });

  it('pValue가 non-null이면 거부한다(추론 필드는 전부 null이어야 함)', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...withheldClusterPayload,
      terms: [{ ...withheldClusterPayload.terms[0], pValue: 0.04 }],
    });
    expect(r.success).toBe(false);
  });

  it('inferenceWithheldReason 없이 inference_withheld면 거부한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...withheldClusterPayload,
      inferenceWithheldReason: null,
    });
    expect(r.success).toBe(false);
  });
});

describe('AnalyzeRegressionResultSchema — estimation:"inference_withheld" (covariance 불능 사유, 리뷰 #17 복합 실패)', () => {
  const withheldCovPayload = {
    ...okPayload,
    estimation: 'inference_withheld' as const,
    inferenceWithheldReason: 'COVARIANCE_NOT_COMPUTABLE' as const,
    terms: [{
      name: 'x1', label: 'x1', variableKey: 'x1', level: null,
      estimate: 1.2, se: null, statistic: null, pValue: null,
      ciLower: null, ciUpper: null, exponentiated: null,
    }],
  };

  it('COVARIANCE_NOT_COMPUTABLE은 se까지 null인 상태를 허용한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse(withheldCovPayload);
    expect(r.success).toBe(true);
  });

  it('DEGENERATE_COVARIANCE도 같은 shape을 허용한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...withheldCovPayload,
      inferenceWithheldReason: 'DEGENERATE_COVARIANCE',
    });
    expect(r.success).toBe(true);
  });

  it('COVARIANCE_NOT_COMPUTABLE인데 se가 non-null이면 거부한다(우선순위 사슬 — 클러스터 사유가 덮어쓰면 안 됨)', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...withheldCovPayload,
      terms: [{ ...withheldCovPayload.terms[0], se: 0.3 }],
    });
    expect(r.success).toBe(false);
  });

  it('복합 실패(클러스터도 부족+covariance도 실패)에서 covariance 사유가 유지된 형태를 허용한다', () => {
    // Node의 클러스터 게이트가 이 상태를 TOO_FEW_CLUSTERS로 덮어써 se를 요구하면
    // 안 된다는 것을 계약 수준에서 고정 — 우선순위 사슬의 최종 형태만 검증한다.
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...withheldCovPayload,
      clusterCount: 5,        // 클러스터도 부족하지만
      maxClusterShare: 0.9,   // 쏠림도 크지만
      inferenceWithheldReason: 'COVARIANCE_NOT_COMPUTABLE', // covariance 사유가 최종 상태
    });
    expect(r.success).toBe(true);
  });
});

describe('AnalyzeRegressionResultSchema — estimation:"non_estimable"', () => {
  const nonEstimablePayload = {
    suppressed: false as const,
    estimation: 'non_estimable' as const,
    method: 'ols_linear' as const,
    outcomeKey: 'x',
    eventLevel: null,
    referenceLevelsUsed: {},
    covariance: 'hc3' as const,
    inferenceDistribution: null,
    inferenceDf: null,
    residualDf: 38,
    n: 40,
    personCount: 40,
    clusterCount: null,
    maxClusterShare: null,
    terms: [],
    fit: null,
    nonEstimableReason: 'RANK_DEFICIENT' as const,
    inferenceWithheldReason: null,
    excludedRowCount: 0,
    qualityFlags: [],
    analysisUnitNote: 'note',
  };

  it('terms:[] + fit:null + 사유 코드를 허용한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse(nonEstimablePayload);
    expect(r.success).toBe(true);
  });

  it.each([
    'INSUFFICIENT_COMPLETE_ROWS', 'TOO_MANY_LEVELS', 'TOO_MANY_PARAMETERS',
    'INSUFFICIENT_EVENTS_PER_PARAMETER', 'CONSTANT_OUTCOME', 'ZERO_VARIANCE_PREDICTOR',
    'RANK_DEFICIENT', 'SEPARATION_DETECTED', 'SEPARATION_CHECK_FAILED', 'NOT_CONVERGED',
  ] as const)('게이트 매핑표의 모든 사유(%s)를 허용한다', (reason) => {
    const r = AnalyzeRegressionResultSchema.safeParse({ ...nonEstimablePayload, nonEstimableReason: reason });
    expect(r.success).toBe(true);
  });

  it('terms가 비어있지 않으면 거부한다(리뷰 #9 — 엔진 오류로 오인 방지의 역방향 계약)', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...nonEstimablePayload,
      terms: [okPayload.terms[0]],
    });
    expect(r.success).toBe(false);
  });

  it('fit이 non-null이면 거부한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...nonEstimablePayload,
      fit: okPayload.fit,
    });
    expect(r.success).toBe(false);
  });

  it('nonEstimableReason이 없으면 거부한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...nonEstimablePayload,
      nonEstimableReason: null,
    });
    expect(r.success).toBe(false);
  });

  it('inferenceWithheldReason이 함께 세팅되면 거부한다', () => {
    const r = AnalyzeRegressionResultSchema.safeParse({
      ...nonEstimablePayload,
      inferenceWithheldReason: 'TOO_FEW_CLUSTERS',
    });
    expect(r.success).toBe(false);
  });
});

describe('AnalyzeResultSchema — regression 필드 연결 (리뷰 #14)', () => {
  it('regression 필드가 있으면 그대로 보존된다(zod strip으로 사라지지 않음)', () => {
    const r = AnalyzeResultSchema.safeParse({
      continuous: [],
      discrete: [],
      regression: { suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.regression).toEqual({ suppressed: true, reasonCode: 'MIN_COHORT_NOT_MET' });
    }
  });

  it('regression 필드가 없어도(구버전 재파싱) 통과한다', () => {
    const r = AnalyzeResultSchema.safeParse({ continuous: [], discrete: [] });
    expect(r.success).toBe(true);
  });
});

describe('StatsAnalysisRecipeSchema — analysisMode:"regression" (리뷰 #1)', () => {
  it('requestedMethod 없이(방법 미선택 최초 preview)도 통과한다', () => {
    const r = StatsAnalysisRecipeSchema.safeParse({
      grain: 'case',
      variableKeys: ['age', 'outcomeVar'],
      analysisPurpose: 'association',
      analysisMode: 'regression',
      regression: { outcomeKey: 'outcomeVar' },
    });
    expect(r.success).toBe(true);
  });

  it('regression 객체가 없으면 거부한다', () => {
    const r = StatsAnalysisRecipeSchema.safeParse({
      grain: 'case',
      variableKeys: ['age', 'outcomeVar'],
      analysisPurpose: 'association',
      analysisMode: 'regression',
    });
    expect(r.success).toBe(false);
  });

  it('outcomeKey가 variableKeys에 없으면 거부한다', () => {
    const r = StatsAnalysisRecipeSchema.safeParse({
      grain: 'case',
      variableKeys: ['age', 'outcomeVar'],
      analysisPurpose: 'association',
      analysisMode: 'regression',
      regression: { outcomeKey: 'notInList' },
    });
    expect(r.success).toBe(false);
  });

  it('variableKeys가 2개 미만이면 거부한다', () => {
    const r = StatsAnalysisRecipeSchema.safeParse({
      grain: 'case',
      variableKeys: ['outcomeVar'],
      analysisPurpose: 'association',
      analysisMode: 'regression',
      regression: { outcomeKey: 'outcomeVar' },
    });
    expect(r.success).toBe(false);
  });

  it('중복 변수가 있으면 거부한다', () => {
    const r = StatsAnalysisRecipeSchema.safeParse({
      grain: 'case',
      variableKeys: ['outcomeVar', 'outcomeVar'],
      analysisPurpose: 'association',
      analysisMode: 'regression',
      regression: { outcomeKey: 'outcomeVar' },
    });
    expect(r.success).toBe(false);
  });

  it('referenceLevels 기본값은 빈 객체다', () => {
    const r = StatsAnalysisRecipeSchema.safeParse({
      grain: 'case',
      variableKeys: ['age', 'outcomeVar'],
      analysisPurpose: 'association',
      analysisMode: 'regression',
      regression: { outcomeKey: 'outcomeVar' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.regression?.referenceLevels).toEqual({});
    }
  });
});
