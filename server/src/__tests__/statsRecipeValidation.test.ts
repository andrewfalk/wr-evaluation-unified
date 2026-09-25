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
  // grain 단순화 개정(PR0-B4, person grain 삭제 후속) — StatsAnalysisRecipe['grain']
  // 타입 자체가 이제 case/job/disease 3개뿐이라 "타입은 유효한데 미지원인 grain"을
  // 리터럴로 만들 수 없다. job_diagnosis/task/cervical_task/vibration_interval처럼
  // 실제로 삭제된(=한때 유효했던) grain 문자열과, person(한때 활성화됐다가 다시 삭제된
  // grain — case와 실질적으로 구분되지 않아 제거)이 여전히 SUPPORTED_GRAINS 런타임 Set
  // 체크에서 거부되는지로 대체한다 — 오래된 캐시된 요청이나 클라이언트 재배포 지연으로
  // 이런 값이 실제로 올 수 있다.
  it('삭제된 grain(job_diagnosis/task/cervical_task/vibration_interval/person)은 GRAIN_NOT_YET_SUPPORTED 하나만 반환한다', () => {
    for (const removedGrain of ['job_diagnosis', 'task', 'cervical_task', 'vibration_interval', 'person']) {
      const result = validateRecipe(
        baseRecipe({ grain: removedGrain as StatsAnalysisRecipe['grain'] }),
        'analyze',
      );
      expect(result.valid, removedGrain).toBe(false);
      if (!result.valid) {
        expect(result.errors, removedGrain).toHaveLength(1);
        expect(result.errors[0].code, removedGrain).toBe('GRAIN_NOT_YET_SUPPORTED');
      }
    }
  });

  it('disease grain(구 diagnosis_side)은 GRAIN_NOT_YET_SUPPORTED로 거부되지 않는다', () => {
    const result = validateRecipe(
      baseRecipe({ grain: 'disease', variableKeys: ['knee.diagnosisSide.klGrade'] }),
      'analyze',
    );
    if (!result.valid) {
      expect(result.errors.some((e) => e.code === 'GRAIN_NOT_YET_SUPPORTED')).toBe(false);
    }
  });
});

// PR0-B3 Part C — 필터 전용 변수 계약. 등록일(case.meta.registeredAt)은 filter_only다.
// 2026-09-12 리뷰 재현 — Date.parse()는 '2024/01/15'·'2024-01-15T00:00:00Z' 등도 통과시켰지만
// 실제 데이터셋 값(statsSnapshotColumnVariables.ts)은 항상 'YYYY-MM-DD'라 검증 통과와 실제
// 매치가 어긋났다(검증은 통과하는데 대상 사례가 조용히 0건이 됨). 이제 이 형식만 허용한다.
describe('validateRecipe — 등록일(date) 필터 값 형식', () => {
  it.each([
    ['YYYY-MM-DD'],
  ])('%s 형식은 통과한다', () => {
    const result = validateRecipe(
      baseRecipe({
        variableKeys: ['knee.relatedness.max'],
        filters: [{ key: 'case.meta.registeredAt', operator: 'eq', value: '2024-01-15' }],
      }),
      'analyze',
    );
    expect(result.valid, !result.valid ? JSON.stringify(result.errors) : '').toBe(true);
  });

  it.each([
    ['슬래시 구분(2024/01/15)', '2024/01/15'],
    ['ISO 타임스탬프(2024-01-15T00:00:00Z)', '2024-01-15T00:00:00Z'],
    ['존재하지 않는 달력 날짜(2024-02-30)', '2024-02-30'],
    ['월 두 자리 아님(2024-1-15)', '2024-1-15'],
  ])('%s는 INVALID_FILTER_VALUE로 거부된다(데이터셋과 형식이 어긋나 조용히 0건이 되는 것을 막는다)', (_label, value) => {
    const result = validateRecipe(
      baseRecipe({
        variableKeys: ['knee.relatedness.max'],
        filters: [{ key: 'case.meta.registeredAt', operator: 'eq', value } ],
      }),
      'analyze',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'INVALID_FILTER_VALUE')).toBe(true);
  });

  it('between도 두 값 모두 엄격한 YYYY-MM-DD여야 한다', () => {
    const ok = validateRecipe(
      baseRecipe({
        variableKeys: ['knee.relatedness.max'],
        filters: [{ key: 'case.meta.registeredAt', operator: 'between', value: ['2024-01-01', '2024-12-31'] }],
      }),
      'analyze',
    );
    expect(ok.valid, !ok.valid ? JSON.stringify(ok.errors) : '').toBe(true);

    const bad = validateRecipe(
      baseRecipe({
        variableKeys: ['knee.relatedness.max'],
        filters: [{ key: 'case.meta.registeredAt', operator: 'between', value: ['2024/01/01', '2024-12-31'] }],
      }),
      'analyze',
    );
    expect(bad.valid).toBe(false);
  });
});

describe('validateRecipe — 필터 전용 변수 계약(analysisRole)', () => {
  it('filter_only 변수를 variableKeys에 넣으면 FILTER_ONLY_VARIABLE_NOT_ANALYZABLE로 거부한다', () => {
    const result = validateRecipe(
      baseRecipe({ variableKeys: ['case.meta.registeredAt'] }),
      'analyze',
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.code === 'FILTER_ONLY_VARIABLE_NOT_ANALYZABLE')).toBe(true);
    }
  });

  it('filter_only 변수를 filters[]에 넣는 것은 허용한다(등록일로 거르기)', () => {
    const result = validateRecipe(
      baseRecipe({
        variableKeys: ['knee.relatedness.max'],
        filters: [{ key: 'case.meta.registeredAt', operator: 'gte', value: '2024-01-01' }],
      }),
      'analyze',
    );
    expect(result.valid, !result.valid ? JSON.stringify(result.errors) : '').toBe(true);
  });

  it('담당의(analyzable)는 variableKeys에 넣어도 거부되지 않는다', () => {
    const result = validateRecipe(
      baseRecipe({ variableKeys: ['case.staff.assignedDoctorUserId'] }),
      'analyze',
    );
    if (!result.valid) {
      expect(result.errors.some((e) => e.code === 'FILTER_ONLY_VARIABLE_NOT_ANALYZABLE')).toBe(false);
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

// PR4-B2 — 예측(prediction) 역할·grain·eventLevel·필터 매트릭스. 위 §실측 테스트(7개
// 공식점수 변수 전부 prediction 불허)는 그대로 유지한다 — 여전히 참인 사실이다(공식점수는
// predictionRole 자체가 없다). 여기서는 실제로 predictionRole이 배선된 변수들로 새
// 검증 분기(statsRecipeValidation.ts의 'prediction' 브랜치)를 확인한다.
function predictionRecipe(overrides: Partial<StatsAnalysisRecipe> = {}): StatsAnalysisRecipe {
  return baseRecipe({
    grain: 'case',
    variableKeys: ['diagnosis.rollup.anyHighRelatedness', 'patient.identity.gender'],
    analysisPurpose: 'prediction',
    analysisMode: 'prediction',
    prediction: { outcomeKey: 'diagnosis.rollup.anyHighRelatedness', eventLevel: 'true' },
    ...overrides,
  });
}

describe('validateRecipe — 예측(prediction) 역할·grain·eventLevel·필터', () => {
  it('case grain(boolean outcome + 공통 predictor)을 허용한다', () => {
    const result = validateRecipe(predictionRecipe(), 'analyze');
    expect(result.valid, !result.valid ? JSON.stringify(result.errors) : '').toBe(true);
  });

  it('disease grain(categorical outcome + disease 전용 predictor)을 허용한다', () => {
    const result = validateRecipe(predictionRecipe({
      grain: 'disease',
      variableKeys: ['diagnosis.assessment.status', 'knee.diagnosisSide.klGrade'],
      prediction: { outcomeKey: 'diagnosis.assessment.status', eventLevel: 'high' },
    }), 'analyze');
    expect(result.valid, !result.valid ? JSON.stringify(result.errors) : '').toBe(true);
  });

  it('job grain은 PREDICTION_GRAIN_NOT_SUPPORTED로 거부한다', () => {
    const result = validateRecipe(predictionRecipe({
      grain: 'job',
      variableKeys: ['diagnosis.rollup.anyHighRelatedness', 'job.identity.tenureYears'],
    }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'PREDICTION_GRAIN_NOT_SUPPORTED')).toBe(true);
  });

  it('outcomeKey가 predictor 역할 변수면 PREDICTION_OUTCOME_INVALID_ROLE로 거부한다', () => {
    const result = validateRecipe(predictionRecipe({
      variableKeys: ['patient.identity.gender', 'patient.identity.bmi'],
      prediction: { outcomeKey: 'patient.identity.gender', eventLevel: 'true' },
    }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'PREDICTION_OUTCOME_INVALID_ROLE')).toBe(true);
  });

  it('predictor 자리에 outcome 역할 변수를 섞으면 PREDICTION_PREDICTOR_INVALID_ROLE로 거부한다', () => {
    const result = validateRecipe(predictionRecipe({
      variableKeys: ['diagnosis.rollup.anyHighRelatedness', 'diagnosis.assessment.status'],
    }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'PREDICTION_PREDICTOR_INVALID_ROLE')).toBe(true);
  });

  it('eventLevel이 명세 밖이면 PREDICTION_EVENT_LEVEL_NOT_ALLOWED로 거부한다(boolean outcome은 "true"만 허용)', () => {
    const result = validateRecipe(predictionRecipe({
      prediction: { outcomeKey: 'diagnosis.rollup.anyHighRelatedness', eventLevel: 'false' },
    }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'PREDICTION_EVENT_LEVEL_NOT_ALLOWED')).toBe(true);
  });

  it('disease 전용 predictor(K-L Grade)를 case grain에서 쓰면 VARIABLE_GRAIN_MISMATCH로 거부한다', () => {
    const result = validateRecipe(predictionRecipe({
      variableKeys: ['diagnosis.rollup.anyHighRelatedness', 'knee.diagnosisSide.klGrade'],
    }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'VARIABLE_GRAIN_MISMATCH')).toBe(true);
  });

  it('필터가 predictor 역할 변수면 허용한다', () => {
    const result = validateRecipe(predictionRecipe({
      filters: [{ key: 'patient.identity.gender', operator: 'eq', value: 'male' }],
    }), 'analyze');
    expect(result.valid, !result.valid ? JSON.stringify(result.errors) : '').toBe(true);
  });

  it('필터가 등록일(case.meta.registeredAt)이면 허용한다', () => {
    const result = validateRecipe(predictionRecipe({
      filters: [{ key: 'case.meta.registeredAt', operator: 'not_missing' }],
    }), 'analyze');
    expect(result.valid, !result.valid ? JSON.stringify(result.errors) : '').toBe(true);
  });

  it('필터가 predictor도 등록일도 아니면(공식점수) PREDICTION_FILTER_LEAKAGE로 거부한다', () => {
    const result = validateRecipe(predictionRecipe({
      filters: [{ key: 'knee.relatedness.max', operator: 'not_missing' }],
    }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'PREDICTION_FILTER_LEAKAGE')).toBe(true);
  });

  it('필터가 outcome 변수 자체여도 PREDICTION_FILTER_LEAKAGE로 거부한다', () => {
    const result = validateRecipe(predictionRecipe({
      filters: [{ key: 'diagnosis.rollup.anyHighRelatedness', operator: 'eq', value: true }],
    }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'PREDICTION_FILTER_LEAKAGE')).toBe(true);
  });

  it('필터가 다른 filter_only 변수(생년월일)여도 PREDICTION_FILTER_LEAKAGE로 거부한다', () => {
    const result = validateRecipe(predictionRecipe({
      filters: [{ key: 'patient.identity.birthDate', operator: 'not_missing' }],
    }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'PREDICTION_FILTER_LEAKAGE')).toBe(true);
  });

  it('requestedMethod가 l2_logistic이 아니면 PREDICTION_METHOD_NOT_SUPPORTED로 거부한다', () => {
    const result = validateRecipe(predictionRecipe({ requestedMethod: 'ols_linear' }), 'analyze');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.code === 'PREDICTION_METHOD_NOT_SUPPORTED')).toBe(true);
  });
  // PURPOSE_MODE_MISMATCH는 zod superRefine(shared/contracts/stats.ts) 책임이다 — 이
  // 함수는 이미 파싱된(=구조적으로 일관된) StatsAnalysisRecipe를 받으므로 여기서
  // 재현할 수 없다. shared/contracts/__tests__/statsPrediction.test.ts에서 검증한다.
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

  // PR0-B3 Part B — grain:disease(구 diagnosis_side)에서도 이변량이 그대로 동작하는지
  // (§B 판정은 카탈로그 type/grain 메타데이터만 보는 순수 정적 검사라 grain-agnostic이어야
  // 한다). K-L Grade(ordinal)×확정상병상태(boolean) 조합은 elbow×wrist(ordinal×ordinal)
  // 테스트로는 못 잡는, 지금까지 카탈로그에 없던 새 타입쌍이라 별도로 검증한다.
  it('analyze 컨텍스트는 disease grain의 ordinal(K-L Grade)×boolean(확정상병상태)에 chi_square를 허용한다', () => {
    const result = validateRecipe(
      baseRecipe({
        grain: 'disease',
        analysisMode: 'bivariate',
        variableKeys: ['knee.diagnosisSide.klGrade', 'knee.diagnosisSide.confirmedStatus'],
        requestedMethod: 'chi_square',
      }),
      'analyze',
    );
    expect(result.valid).toBe(true);
  });
});
