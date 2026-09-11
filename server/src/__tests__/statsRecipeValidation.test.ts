import { describe, it, expect } from 'vitest';
import { validateRecipe } from '../statsRecipeValidation';
import type { StatsAnalysisRecipe } from '@wr/contracts';

const CATALOG_KEYS = [
  'knee.relatedness.max',
  'shoulder.exposure.anyExceeded',
  'elbow.assessment.burdenGradeMax',
  'wrist.assessment.burdenGradeMax',
  'cervical.case.maxJobCumulativeKgHours',
  'spine.mddm.lifetimeDoseMNh',
  'spine.vibration.dvMax',
];

function baseRecipe(overrides: Partial<StatsAnalysisRecipe> = {}): StatsAnalysisRecipe {
  return {
    grain: 'case',
    variableKeys: ['knee.relatedness.max'],
    filters: [],
    analysisPurpose: 'association',
    formulaPolicies: {},
    analysisMode: 'descriptive',
    ...overrides,
  };
}

describe('validateRecipe — grain', () => {
  it('case가 아니면 GRAIN_NOT_YET_SUPPORTED 하나만 반환한다', () => {
    const result = validateRecipe(baseRecipe({ grain: 'person' }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('GRAIN_NOT_YET_SUPPORTED');
    }
  });
});

// spine.mddm.lifetimeDoseMNh는 formulaFamily가 정책 2개를 지원해 formulaPolicies 명시가
// 필수다(다른 6개는 단일 정책이라 생략 가능) — 일반 루프 테스트에서 이 변수만 예외 처리.
function formulaPoliciesFor(key: string): StatsAnalysisRecipe['formulaPolicies'] {
  return key === 'spine.mddm.lifetimeDoseMNh' ? { spine_mddm: 'recompute_current' } : {};
}

describe('validateRecipe — 카탈로그 키 존재', () => {
  it('7개 변수 전부 유효한 grain=case 레시피를 통과시킨다', () => {
    for (const key of CATALOG_KEYS) {
      const result = validateRecipe(baseRecipe({ variableKeys: [key], formulaPolicies: formulaPoliciesFor(key) }), 'analyze');
      expect(result.valid, `key=${key}: ${!result.valid ? JSON.stringify(result.errors) : ''}`).toBe(true);
    }
  });

  it('존재하지 않는 키는 UNKNOWN_VARIABLE로 거부한다', () => {
    const result = validateRecipe(baseRecipe({ variableKeys: ['not.a.real.key'] }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'UNKNOWN_VARIABLE')).toBe(true);
  });
});

describe('validateRecipe — 분석 목적(§실측: 7개 변수 전부 prediction 불허)', () => {
  it.each(CATALOG_KEYS)('%s는 analysisPurpose=prediction을 항상 거부한다', (key) => {
    const result = validateRecipe(baseRecipe({ variableKeys: [key], analysisPurpose: 'prediction' }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'PURPOSE_NOT_ALLOWED')).toBe(true);
  });

  it('association/formula_audit는 7개 변수 전부 허용한다', () => {
    for (const key of CATALOG_KEYS) {
      for (const purpose of ['association', 'formula_audit'] as const) {
        const result = validateRecipe(
          baseRecipe({ variableKeys: [key], analysisPurpose: purpose, formulaPolicies: formulaPoliciesFor(key) }),
          'analyze',
        );
        expect(result.valid, `key=${key} purpose=${purpose}`).toBe(true);
      }
    }
  });
});

describe('validateRecipe — formulaPolicy', () => {
  it('spine.mddm.lifetimeDoseMNh는 formulaPolicies.spine_mddm 없이는 거부된다(정책 혼재)', () => {
    const result = validateRecipe(baseRecipe({ variableKeys: ['spine.mddm.lifetimeDoseMNh'] }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'FORMULA_POLICY_REQUIRED')).toBe(true);
  });

  it('spine.mddm.lifetimeDoseMNh에 stratify_by_version을 주면 UNSUPPORTED_FORMULA_POLICY(실제 지원은 2개뿐)', () => {
    const result = validateRecipe(
      baseRecipe({
        variableKeys: ['spine.mddm.lifetimeDoseMNh'],
        formulaPolicies: { spine_mddm: 'stratify_by_version' },
      }),
      'analyze',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'UNSUPPORTED_FORMULA_POLICY')).toBe(true);
  });

  it('spine.mddm.lifetimeDoseMNh에 recompute_current를 주면 통과한다', () => {
    const result = validateRecipe(
      baseRecipe({
        variableKeys: ['spine.mddm.lifetimeDoseMNh'],
        formulaPolicies: { spine_mddm: 'recompute_current' },
      }),
      'analyze',
    );
    expect(result.valid).toBe(true);
  });

  it('단일 정책 family(knee_relatedness)는 정책을 생략해도 통과한다', () => {
    const result = validateRecipe(baseRecipe({ variableKeys: ['knee.relatedness.max'] }), 'analyze');
    expect(result.valid).toBe(true);
  });
});

describe('validateRecipe — 필터 연산자/값 형태', () => {
  it('ordinal 변수(elbow.assessment.burdenGradeMax)에 gt 연산자는 거부된다(문자열 순위 비교 버그 방지)', () => {
    const result = validateRecipe(
      baseRecipe({
        variableKeys: ['elbow.assessment.burdenGradeMax'],
        filters: [{ key: 'elbow.assessment.burdenGradeMax', operator: 'gt', value: '경도' }],
      }),
      'analyze',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'OPERATOR_NOT_ALLOWED')).toBe(true);
  });

  it('boolean 변수(shoulder.exposure.anyExceeded)에 문자열 "false"를 주면 거부된다', () => {
    const result = validateRecipe(
      baseRecipe({
        variableKeys: ['shoulder.exposure.anyExceeded'],
        filters: [{ key: 'shoulder.exposure.anyExceeded', operator: 'eq', value: 'false' }],
      }),
      'analyze',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'INVALID_FILTER_VALUE')).toBe(true);
  });

  it('boolean 변수에 실제 boolean 값을 주면 통과한다', () => {
    const result = validateRecipe(
      baseRecipe({
        variableKeys: ['shoulder.exposure.anyExceeded'],
        filters: [{ key: 'shoulder.exposure.anyExceeded', operator: 'eq', value: false }],
      }),
      'analyze',
    );
    expect(result.valid).toBe(true);
  });

  it('between은 2개 원소 배열이어야 하고 하한>상한이면 거부된다', () => {
    const tooFew = validateRecipe(
      baseRecipe({
        variableKeys: ['knee.relatedness.max'],
        filters: [{ key: 'knee.relatedness.max', operator: 'between', value: [10] }],
      }),
      'analyze',
    );
    expect(tooFew.valid).toBe(false);

    const reversed = validateRecipe(
      baseRecipe({
        variableKeys: ['knee.relatedness.max'],
        filters: [{ key: 'knee.relatedness.max', operator: 'between', value: [10, 5] }],
      }),
      'analyze',
    );
    expect(reversed.valid).toBe(false);
    if (!reversed.valid) expect(reversed.errors.some((e) => e.code === 'INVALID_FILTER_RANGE')).toBe(true);

    const ok = validateRecipe(
      baseRecipe({
        variableKeys: ['knee.relatedness.max'],
        filters: [{ key: 'knee.relatedness.max', operator: 'between', value: [5, 10] }],
      }),
      'analyze',
    );
    expect(ok.valid).toBe(true);
  });

  it('in은 비어있지 않은 배열이어야 한다', () => {
    const result = validateRecipe(
      baseRecipe({
        variableKeys: ['elbow.assessment.burdenGradeMax'],
        filters: [{ key: 'elbow.assessment.burdenGradeMax', operator: 'in', value: [] }],
      }),
      'analyze',
    );
    expect(result.valid).toBe(false);
  });

  it('is_missing/not_missing에 value가 있으면 거부된다', () => {
    const result = validateRecipe(
      baseRecipe({
        variableKeys: ['knee.relatedness.max'],
        filters: [{ key: 'knee.relatedness.max', operator: 'is_missing', value: 1 }],
      }),
      'analyze',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'UNEXPECTED_FILTER_VALUE')).toBe(true);
  });

  it('is_missing에 value가 없으면 통과한다', () => {
    const result = validateRecipe(
      baseRecipe({
        variableKeys: ['knee.relatedness.max'],
        filters: [{ key: 'knee.relatedness.max', operator: 'is_missing' }],
      }),
      'analyze',
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PR3-A §B — 이변량 타입정합성·paired영구거부·method필수여부·context별 관대함
// ---------------------------------------------------------------------------

function bivariateRecipe(overrides: Partial<StatsAnalysisRecipe> = {}): StatsAnalysisRecipe {
  return baseRecipe({
    analysisMode: 'bivariate',
    variableKeys: ['shoulder.exposure.anyExceeded', 'spine.mddm.lifetimeDoseMNh'],
    formulaPolicies: { spine_mddm: 'recompute_current' },
    ...overrides,
  });
}

describe('validateRecipe — PR3-A 이변량(§B)', () => {
  it('preview 컨텍스트는 requestedMethod 미지정이어도 통과한다(관대함)', () => {
    const result = validateRecipe(bivariateRecipe(), 'preview');
    expect(result.valid).toBe(true);
  });

  it('analyze 컨텍스트는 requestedMethod 미지정이면 BIVARIATE_REQUIRES_METHOD로 거부한다', () => {
    const result = validateRecipe(bivariateRecipe(), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'BIVARIATE_REQUIRES_METHOD')).toBe(true);
  });

  it('preview 컨텍스트는 타입 불일치 requestedMethod가 있어도 거부하지 않는다(관대함)', () => {
    const result = validateRecipe(bivariateRecipe({ requestedMethod: 'pearson_correlation' }), 'preview');
    expect(result.valid).toBe(true);
  });

  it('analyze 컨텍스트는 boolean×continuous에 pearson_correlation을 METHOD_TYPE_MISMATCH로 거부한다', () => {
    const result = validateRecipe(bivariateRecipe({ requestedMethod: 'pearson_correlation' }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'METHOD_TYPE_MISMATCH')).toBe(true);
  });

  it('analyze 컨텍스트는 boolean×continuous에 welch_t를 허용한다', () => {
    const result = validateRecipe(bivariateRecipe({ requestedMethod: 'welch_t' }), 'analyze');
    expect(result.valid).toBe(true);
  });

  it('analyze 컨텍스트는 continuous×continuous에 pearson_correlation을 허용한다', () => {
    const result = validateRecipe(
      bivariateRecipe({
        variableKeys: ['spine.mddm.lifetimeDoseMNh', 'spine.vibration.dvMax'],
        requestedMethod: 'pearson_correlation',
      }),
      'analyze',
    );
    expect(result.valid).toBe(true);
  });

  it('analyze 컨텍스트는 ordinal×ordinal에 chi_square를 허용한다', () => {
    const result = validateRecipe(
      bivariateRecipe({
        variableKeys: ['elbow.assessment.burdenGradeMax', 'wrist.assessment.burdenGradeMax'],
        requestedMethod: 'chi_square',
      }),
      'analyze',
    );
    expect(result.valid).toBe(true);
  });

  it('대응검정(paired_t)은 카탈로그 기준 항상 PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING으로 거부된다', () => {
    const result = validateRecipe(bivariateRecipe({ requestedMethod: 'paired_t' }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING')).toBe(true);
  });

  it('대응검정(wilcoxon_signed_rank)도 카탈로그 기준 항상 거부된다', () => {
    const result = validateRecipe(bivariateRecipe({ requestedMethod: 'wilcoxon_signed_rank' }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING')).toBe(true);
  });

  it('descriptive 모드는 requestedMethod가 있어도 §B 검사를 건너뛴다', () => {
    const result = validateRecipe(
      baseRecipe({ variableKeys: ['knee.relatedness.max'], requestedMethod: 'welch_t' }),
      'analyze',
    );
    expect(result.valid).toBe(true);
  });
});
