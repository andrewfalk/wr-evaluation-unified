import { describe, expect, it, vi } from 'vitest';
import { computeExecutionDigest } from '../statsExecutionDigest';
import * as canonicalSerializer from '../canonicalSerializer';
import { PREDICTION_POLICY } from '../statsPolicy';

const base = {
  organizationId: 'org-1',
  requestedBy: 'user-1',
  recipeDigest: 'recipe-digest-1',
  sourceDigest: 'source-digest-1',
};

describe('computeExecutionDigest', () => {
  it('is deterministic for the same input', () => {
    expect(computeExecutionDigest(base)).toBe(computeExecutionDigest({ ...base }));
  });

  it('changes when organizationId changes', () => {
    expect(computeExecutionDigest(base)).not.toBe(computeExecutionDigest({ ...base, organizationId: 'org-2' }));
  });

  it('changes when requestedBy changes (v1: no cross-user cache sharing)', () => {
    expect(computeExecutionDigest(base)).not.toBe(computeExecutionDigest({ ...base, requestedBy: 'user-2' }));
  });

  it('changes when recipeDigest changes', () => {
    expect(computeExecutionDigest(base)).not.toBe(computeExecutionDigest({ ...base, recipeDigest: 'recipe-digest-2' }));
  });

  it('changes when sourceDigest changes', () => {
    expect(computeExecutionDigest(base)).not.toBe(computeExecutionDigest({ ...base, sourceDigest: 'source-digest-2' }));
  });
});

// PR0-B3 Part C — 계획 "통합 카탈로그" 절 "확인 필요" 3번: 서버 전용
// SERVER_CATALOG_EXTENSION_VERSION(statsCatalogVersion.ts)만 바뀌어도(analytics-core의
// CATALOG_VERSION은 그대로여도) execution digest가 달라져야 한다 — 안 그러면 서버 전용
// SnapshotColumn 로직만 고쳤을 때 옛 캐시가 그대로 재사용된다. 모듈을 모킹해 실제로
// 값이 바뀌는지 실측한다(정적 코드 읽기가 아니라 런타임 digest 비교).
describe('computeExecutionDigest — 서버 확장 버전 단독 변경 시 캐시 무효화', () => {
  it('INTEGRATED_CATALOG_VERSION(=CATALOG_VERSION+SERVER_CATALOG_EXTENSION_VERSION)만 달라져도 digest가 달라진다', async () => {
    vi.resetModules();
    const original = await import('../statsExecutionDigest');
    const originalDigest = original.computeExecutionDigest(base);

    vi.doMock('../statsCatalogVersion', () => ({
      INTEGRATED_CATALOG_VERSION: 'v5-task-grain-diagnosis-module-group+v2-snapshot-columns-changed-for-test',
    }));
    vi.resetModules();
    const patched = await import('../statsExecutionDigest');
    const patchedDigest = patched.computeExecutionDigest(base);

    expect(patchedDigest).not.toBe(originalDigest);

    vi.doUnmock('../statsCatalogVersion');
    vi.resetModules();
  });
});

// PR3-B 후속(A안) — histogram.py의 bin 개수 계산 기준을 행 수→personCount로 바꿨다.
// 통신 규격(protocolVersion)은 안 바뀌었지만 엔진 계산 결과 자체는 바뀌므로, 이 버전
// 상수만 단독으로 바뀌어도 digest가 달라져야 한다 — 안 그러면 옛 bin 개수 기준으로
// 계산된 histogram이 stats_runs 캐시에서 그대로 재사용된다(1차 리뷰 지적).
describe('computeExecutionDigest — STATS_ENGINE_VERSION 단독 변경 시 캐시 무효화', () => {
  it('STATS_ENGINE_VERSION만 달라져도 digest가 달라진다', async () => {
    vi.resetModules();
    const original = await import('../statsExecutionDigest');
    const originalDigest = original.computeExecutionDigest(base);

    vi.doMock('../statsRunManifest', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../statsRunManifest')>()),
      STATS_ENGINE_VERSION: 'v-changed-for-test',
    }));
    vi.resetModules();
    const patched = await import('../statsExecutionDigest');
    const patchedDigest = patched.computeExecutionDigest(base);

    expect(patchedDigest).not.toBe(originalDigest);

    vi.doUnmock('../statsRunManifest');
    vi.resetModules();
  });
});

// B안 — chartDisclosurePolicyVersion(다른 모듈 상수)/suppressionRuleVersion/
// resultSchemaVersion(둘 다 statsExecutionDigest.ts 자기 자신의 상수) 세 개를 올렸다.
// 뒤의 두 개는 STATS_ENGINE_VERSION 때 썼던 "다른 모듈을 모킹 → 현재 모듈 재import"
// 패턴이 안 통한다 — 같은 모듈을 통째로 모킹하면 테스트 대상인 진짜
// computeExecutionDigest 자체가 사라져버리기 때문이다(2차 리뷰 지적). 대신
// computeExecutionDigest가 실제로 호출하는 canonicalDigest를 스파이해서 검증한다.
//
// 주의 — "캡처한 해시 입력이 지금 export된 상수 값과 같다"는 비교만으로는 범프를
// 아예 빠뜨린 경우를 못 잡는다(안 올렸어도 캡처값과 export값이 똑같이 옛 값이라
// 그 비교가 그대로 통과해버림). 그래서 (1) 기대하는 새 리터럴 문자열을 여기 직접
// 하드코딩해 비교하고, (2) 그 필드만 옛 값으로 되돌린 입력으로 실제
// canonicalDigest 구현을 다시 호출해 현재 digest와 실제로 달라지는지까지 확인한다.
describe('computeExecutionDigest — B안 버전 상수 3개(같은 모듈 상수 포함) 캐시 무효화', () => {
  it('chartDisclosurePolicyVersion/suppressionRuleVersion/resultSchemaVersion이 새 값으로 올라갔고, 각각 실제로 digest에 영향을 준다', () => {
    // 3차 리뷰 지적 — mockRestore()가 맨 끝에만 있으면 그 전 assertion이 실패했을 때
    // 스파이가 복원되지 않은 채로 다음 테스트로 넘어간다. try/finally로 감싼다.
    const spy = vi.spyOn(canonicalSerializer, 'canonicalDigest');
    try {
      const currentDigest = computeExecutionDigest(base);
      // PR4-B2 — predictionPolicyDigest:canonicalDigest(PREDICTION_POLICY)가 해시
      // 입력 객체 리터럴 안에서 먼저 평가되므로(자바스크립트 프로퍼티 값 평가
      // 순서), 실제 전체 입력을 넘기는 바깥쪽 호출은 두 번째(마지막) 호출이다.
      expect(spy).toHaveBeenCalledTimes(2);
      const capturedInput = spy.mock.calls[1][0] as Record<string, unknown>;

      // (1) export된 값을 다시 읽어와 자기 자신과 비교하지 않는다 — 정답을 하드코딩.
      expect(capturedInput.chartDisclosurePolicyVersion).toBe('v2-histogram-adaptive-resolution');
      expect(capturedInput.suppressionRuleVersion).toBe('v5-histogram-adaptive-resolution');
      // PR4-A1 — AnalyzeResult.regression 필드가 추가돼 v4-histogram-merge-fields →
      // v5-regression으로 범프됐다. PR4-A2 — diagnostics/spline 필드 추가로
      // v6-regression-diagnostics-spline으로 범프됐다. PR4-B2 — AnalyzeResult.
      // prediction 필드가 추가돼 v7-prediction으로 다시 범프됐다.
      expect(capturedInput.resultSchemaVersion).toBe('v7-prediction');

      // (2) 각 필드를 범프 전 값으로 되돌리면 실제로 다른 digest가 나오는지(=이
      // 필드들이 죽은 값이 아니라 실제로 해시에 반영되는지) 확인한다. 스파이는
      // 원래 구현을 그대로 호출(call-through)하므로 이 직접 호출도 진짜 해시다.
      const OLD_VALUES: Record<string, string> = {
        chartDisclosurePolicyVersion: 'v1-outlier-partition-gate',
        suppressionRuleVersion: 'v4-chart-outlier-partition-gate',
        resultSchemaVersion: 'v5-regression',
      };
      for (const key of Object.keys(OLD_VALUES)) {
        const staleInput = { ...capturedInput, [key]: OLD_VALUES[key] };
        const staleDigest = canonicalSerializer.canonicalDigest(staleInput);
        expect(staleDigest).not.toBe(currentDigest);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

// PR4-A1 — 회귀 설계행렬 게이트(REGRESSION_POLICY)가 신설되며 methodPolicyVersion·
// estimabilityPolicyVersion이 범프됐고, 새 필드 regressionPolicyVersion이 해시
// 입력에 추가됐다. 위 블록과 같은 이유로 "캡처값==export값" 자기비교가 아니라
// 리터럴을 하드코딩하고, 옛 값으로 되돌리면 실제로 digest가 달라지는지까지 검증한다.
describe('computeExecutionDigest — PR4-A1 회귀 정책 버전 3개 캐시 무효화', () => {
  it('methodPolicyVersion/estimabilityPolicyVersion/regressionPolicyVersion이 새 값으로 올라갔고, 각각 실제로 digest에 영향을 준다', () => {
    const spy = vi.spyOn(canonicalSerializer, 'canonicalDigest');
    try {
      const currentDigest = computeExecutionDigest(base);
      // PR4-B2 — predictionPolicyDigest 계산이 먼저 canonicalDigest를 한 번 더
      // 호출하므로 바깥쪽 진짜 입력은 마지막 호출이다(위 B안 블록과 동일 이유).
      const capturedInput = spy.mock.calls[spy.mock.calls.length - 1][0] as Record<string, unknown>;

      // PR4-B2 — methodPolicyVersion은 prediction 추가로 v3-regression-categorical-outcome
      // → v4-prediction-l2-logistic으로 다시 범프됐다.
      expect(capturedInput.methodPolicyVersion).toBe('v4-prediction-l2-logistic');
      expect(capturedInput.estimabilityPolicyVersion).toBe('v1-regression-design');
      expect(capturedInput.regressionPolicyVersion).toBe('v2-diagnostics-spline');

      const OLD_VALUES: Record<string, string> = {
        methodPolicyVersion: 'v1-bivariate',
        estimabilityPolicyVersion: 'v0-preview-counts',
        // PR4-A1 이전엔 이 필드 자체가 해시 입력에 없었다 — undefined였던 것과
        // 다른 문자열을 명시적으로 담는 것만으로도 digest가 달라져야 한다.
        regressionPolicyVersion: 'v0-not-present',
        // rank 판정을 Gram 행렬 기반에서 one-sided Jacobi SVD로 교체했을 때
        // 실제로 범프했던 값(v1-association → v2-association-svd-rank) —
        // "옛 리터럴로 되돌리면 digest가 달라지는지"를 이 구체적인 값으로도
        // 고정해 다음 정책 수정 때 범프 누락을 잡는다.
        regressionPolicyVersionRankFixPrevious: 'v1-association',
        // PR4-A2 — 진단·spline·interaction·표준화·categorical outcome 추가로
        // v2-association-svd-rank → v2-diagnostics-spline으로 다시 범프됐다.
        regressionPolicyVersionDiagnosticsPrevious: 'v2-association-svd-rank',
        // PR4-A2 — binary_logistic이 categorical outcome도 허용하도록 바뀌어
        // v2-regression → v3-regression-categorical-outcome으로 다시 범프됐다.
        methodPolicyVersionPrevious: 'v2-regression',
        // PR4-B2 — computePredictionAvailableMethods(l2_logistic) 추가로
        // v3-regression-categorical-outcome → v4-prediction-l2-logistic으로
        // 다시 범프됐다.
        methodPolicyVersionPredictionPrevious: 'v3-regression-categorical-outcome',
      };
      const FIELD_ALIASES: Record<string, string> = {
        regressionPolicyVersionRankFixPrevious: 'regressionPolicyVersion',
        regressionPolicyVersionDiagnosticsPrevious: 'regressionPolicyVersion',
        methodPolicyVersionPrevious: 'methodPolicyVersion',
        methodPolicyVersionPredictionPrevious: 'methodPolicyVersion',
      };
      for (const key of Object.keys(OLD_VALUES)) {
        const staleKey = FIELD_ALIASES[key] ?? key;
        const staleInput = { ...capturedInput, [staleKey]: OLD_VALUES[key] };
        const staleDigest = canonicalSerializer.canonicalDigest(staleInput);
        expect(staleDigest).not.toBe(currentDigest);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

// PR4-B2 — PREDICTION_POLICY는 다른 정책처럼 손으로 관리하는 버전 문자열 하나가
// 아니라 canonicalDigest(PREDICTION_POLICY) 전체를 해시 입력에 담는다(위 §설계
// 의도 주석 참고) — λ 격자·fold 수처럼 결과에 직접 영향을 주는 상수가 버전
// 문자열을 안 바꾸고도 조용히 바뀌면 캐시가 무효화되지 않기 때문이다. 이 값이
// 실제로 해시에 반영되는지(죽은 필드가 아닌지) 직접 확인한다.
describe('computeExecutionDigest — PREDICTION_POLICY 전체 해시 캐시 무효화', () => {
  it('predictionPolicyDigest가 PREDICTION_POLICY 내용을 반영하고, 값이 바뀌면 digest도 바뀐다', () => {
    const spy = vi.spyOn(canonicalSerializer, 'canonicalDigest');
    try {
      const currentDigest = computeExecutionDigest(base);
      expect(spy).toHaveBeenCalledTimes(2);
      // 첫 호출이 predictionPolicyDigest 계산 자체(canonicalDigest(PREDICTION_POLICY)).
      expect(spy.mock.calls[0][0]).toEqual(PREDICTION_POLICY);
      const capturedInput = spy.mock.calls[1][0] as Record<string, unknown>;
      expect(typeof capturedInput.predictionPolicyDigest).toBe('string');

      const staleInput = { ...capturedInput, predictionPolicyDigest: canonicalSerializer.canonicalDigest({ ...PREDICTION_POLICY, maxRows: 999 }) };
      const staleDigest = canonicalSerializer.canonicalDigest(staleInput);
      expect(staleDigest).not.toBe(currentDigest);
    } finally {
      spy.mockRestore();
    }
  });
});
