import { describe, it, expect } from 'vitest';
import { getFullVariableCatalog, computeVariableValue, computeRepeatedVariableValue, CATALOG_VERSION } from '../catalog';
import { deterministicMigrate } from '../migration/deterministicMigrate';

const FALLBACK = '2024-01-01T00:00:00.000Z';

function migrate(payload: unknown, caseId = 'case-1') {
  return deterministicMigrate(payload, { caseId, createdAtFallbackIso: FALLBACK });
}

describe('getFullVariableCatalog', () => {
  // PR0-B3 Part A는 vibration_interval grain 2개, Part B는 diagnosis_side grain 4개 +
  // case grain 2개(spine.diagnosis.*)를 추가했다 — "전부 case grain"이던 회귀 방지 고정이
  // 이미 Part A에서 깨졌다. case grain 9개는 그대로 non_sensitive를 유지하는지만 계속
  // 고정하고, 반복 grain 변수는 별도로 grain 값만 확인한다. vibration_interval 변수가
  // 2개인 이유(계약 증명 1개로는 부족) — "변수 추가/제거해도 엔터티 모집단이 불변"이라는
  // 계약을 실제로 검증하려면 같은 grain에 변수가 최소 2개 필요하다
  // (statsDatasetBuilder.repeatedGrain.test.ts).
  // PR0-B3 Part C — job.rollup.longestTenureJobNameNormalized(case grain)가 처음으로
  // sensitivity:quasi_identifier인 case grain 변수라 "case grain 전부 non_sensitive"
  // 고정이 여기서 깨진다 — 그 변수만 제외하고 나머지 9개는 계속 고정한다.
  // Part C-2 — task grain 2개(spine.task.*) + diagnosis_side grain 1개(diagnosis.identity.
  // moduleGroup)를 추가해 18→21개. 둘 다 case grain이 아니라 caseVariables 개수는 그대로다.
  it('21개 변수를 반환하고, case grain 10개 중 9개는 sensitivity:non_sensitive다(회귀 방지 고정)', () => {
    const catalog = getFullVariableCatalog();
    expect(catalog).toHaveLength(21);
    const caseVariables = catalog.filter((v) => v.grain === 'case');
    expect(caseVariables).toHaveLength(10);
    const nonSensitiveCaseVariables = caseVariables.filter((v) => v.key !== 'job.rollup.longestTenureJobNameNormalized');
    expect(nonSensitiveCaseVariables).toHaveLength(9);
    for (const variable of nonSensitiveCaseVariables) {
      expect(variable.sensitivity).toBe('non_sensitive');
    }
    const rollup = caseVariables.find((v) => v.key === 'job.rollup.longestTenureJobNameNormalized');
    expect(rollup?.sensitivity).toBe('quasi_identifier');
  });

  it('spine.vibration.intervalA8Max/intervalExposureHours는 grain:vibration_interval로 등록돼 있다', () => {
    const catalog = getFullVariableCatalog();
    for (const key of ['spine.vibration.intervalA8Max', 'spine.vibration.intervalExposureHours']) {
      const variable = catalog.find((v) => v.key === key);
      expect(variable, `key=${key}`).toBeDefined();
      expect(variable!.grain).toBe('vibration_interval');
    }
  });

  it('knee.diagnosisSide.*/shoulder.diagnosisSide.ellmanClass는 grain:diagnosis_side로 등록돼 있다', () => {
    const catalog = getFullVariableCatalog();
    for (const key of [
      'knee.diagnosisSide.klGrade',
      'knee.diagnosisSide.confirmedStatus',
      'knee.diagnosisSide.appliedConfirmedMismatch',
      'shoulder.diagnosisSide.ellmanClass',
    ]) {
      const variable = catalog.find((v) => v.key === key);
      expect(variable, `key=${key}`).toBeDefined();
      expect(variable!.grain).toBe('diagnosis_side');
    }
  });

  it('키 목록이 정확히 21개 대표 변수와 일치한다', () => {
    const keys = getFullVariableCatalog().map((v) => v.key).sort();
    expect(keys).toEqual(
      [
        'cervical.case.maxJobCumulativeKgHours',
        'elbow.assessment.burdenGradeMax',
        'knee.relatedness.max',
        'knee.diagnosisSide.klGrade',
        'knee.diagnosisSide.confirmedStatus',
        'knee.diagnosisSide.appliedConfirmedMismatch',
        'shoulder.exposure.anyExceeded',
        'shoulder.diagnosisSide.ellmanClass',
        'spine.mddm.lifetimeDoseMNh',
        'spine.vibration.dvMax',
        'spine.vibration.intervalA8Max',
        'spine.vibration.intervalExposureHours',
        'spine.diagnosis.verticalDistribution',
        'spine.diagnosis.concomitantSpondylosis',
        'wrist.assessment.burdenGradeMax',
        'job.identity.jobNameNormalized',
        'job.identity.tenureYears',
        'job.rollup.longestTenureJobNameNormalized',
        'spine.task.weightKg',
        'spine.task.frequencyPerDay',
        'diagnosis.identity.moduleGroup',
      ].sort(),
    );
  });

  it('job.identity.*는 grain:job, job.rollup.longestTenureJobNameNormalized는 grain:case로 등록돼 있다', () => {
    const catalog = getFullVariableCatalog();
    for (const key of ['job.identity.jobNameNormalized', 'job.identity.tenureYears']) {
      const variable = catalog.find((v) => v.key === key);
      expect(variable, `key=${key}`).toBeDefined();
      expect(variable!.grain).toBe('job');
    }
    const rollup = catalog.find((v) => v.key === 'job.rollup.longestTenureJobNameNormalized');
    expect(rollup?.grain).toBe('case');
  });

  it('spine.task.*는 grain:task, diagnosis.identity.moduleGroup는 grain:diagnosis_side로 등록돼 있다', () => {
    const catalog = getFullVariableCatalog();
    for (const key of ['spine.task.weightKg', 'spine.task.frequencyPerDay']) {
      const variable = catalog.find((v) => v.key === key);
      expect(variable, `key=${key}`).toBeDefined();
      expect(variable!.grain).toBe('task');
    }
    const moduleGroup = catalog.find((v) => v.key === 'diagnosis.identity.moduleGroup');
    expect(moduleGroup?.grain).toBe('diagnosis_side');
  });

  it('CATALOG_VERSION은 비어있지 않은 문자열이다', () => {
    expect(typeof CATALOG_VERSION).toBe('string');
    expect(CATALOG_VERSION.length).toBeGreaterThan(0);
  });
});

describe('computeVariableValue', () => {
  it('미등록 key는 undefined를 반환한다', () => {
    const mr = migrate({ data: { shared: {}, modules: {}, activeModules: [] } });
    expect(computeVariableValue('not.a.real.key', mr)).toBeUndefined();
  });

  // §0-3/§1E — spine.mddm.lifetimeDoseMNh의 formulaPolicy 배선이 실제로 결과를 바꾸는지
  // 실측한다(배선 자체가 no-op이 되는 회귀를 막는 핵심 테스트).
  it('spine.mddm.lifetimeDoseMNh — formulaPolicy가 legacy formulaVersion 보유 fixture에서 실제로 다른 값을 낸다', () => {
    const payload = {
      data: {
        shared: { jobs: [], gender: 'male' },
        modules: {
          spine: {
            formulaVersion: 'legacy',
            careerYears: 5,
            careerMonths: 0,
            workDaysPerYear: 250,
            // weight=100 → G1 공식(b=800,m=45)으로 force=800+45*100=5300N(>=4000, high-force
            // task) → hasHighForceTask=true가 되어 dailyDose 임계값 미달 여부와 무관하게
            // excluded=false로 강제된다(mddm.ts calculateLifetimeDose:194) — legacy/v513
            // 공식이 서로 다른 정규화를 쓰므로 이 상태에서 두 정책의 결과값이 실제로 갈린다.
            tasks: [
              { posture: 'G1', weight: 100, correctionFactor: 1, timeValue: 60, timeUnit: 'sec', frequency: 10 },
            ],
          },
        },
        activeModules: ['spine'],
      },
    };
    const mr = migrate(payload);

    const recorded = computeVariableValue('spine.mddm.lifetimeDoseMNh', mr, {
      formulaPolicy: 'recompute_recorded_version',
    });
    const current = computeVariableValue('spine.mddm.lifetimeDoseMNh', mr, {
      formulaPolicy: 'recompute_current',
    });

    expect(recorded).toBeDefined();
    expect(current).toBeDefined();
    // 둘 다 정상 계산돼야(missing===null) 이 fixture가 "값 비교"에 유효하다.
    expect(recorded!.missing).toBeNull();
    expect(current!.missing).toBeNull();
    // legacy formulaVersion(구형 공식) vs recompute_current(강제 최신 SPINE_FORMULA_V513)가
    // 실제로 다른 공식을 타 다른 값을 낸다 — 배선이 no-op이면 이 값이 같아진다.
    expect(recorded!.value).not.toEqual(current!.value);
  });

  // §3라운드 지적 — 이중 캐스트의 안전성은 "존재 검사"이지 "시그니처 검사"가 아니다.
  // 카탈로그의 case grain 키 전부를 순회하며 반환값이 ExtractedValue shape을 만족하는지
  // 실측한다. PR0-B3 Part A — 반복 grain 키는 스칼라 API로 호출하면 안 되므로(grain 가드가
  // throw 한다) 이 루프에서 제외하고 아래 별도 테스트로 검증한다.
  it('카탈로그 case grain 키 전부에서 이중 캐스트 호출이 ExtractedValue shape을 만족한다', () => {
    const emptyMr = migrate({
      data: {
        shared: {},
        modules: {},
        activeModules: ['knee', 'shoulder', 'elbow', 'wrist', 'cervical', 'spine'],
      },
    });

    // PR0-B3 Part B — spine.diagnosis.verticalDistribution/concomitantSpondylosis는
    // modules.spine이 아니라 shared.diagnoses[]에만 의존한다 — "모듈 비활성" 검사가 아니라
    // "이 case에 spine 진단이 없음" 검사라 missing 사유가 다르다(not_applicable). PR0-B3
    // Part C — job.rollup.longestTenureJobNameNormalized도 마찬가지로 modules.* 전혀
    // 읽지 않고 shared.jobs[]에만 의존한다(job은 activeModules로 게이트되지 않는 공유
    // 개념) — "유효한 근속기간을 가진 job이 없음"이라 missing 사유가 not_entered다. 그래서
    // 아래 "전부 structural_missing" 회귀 고정 루프에서는 이 셋을 제외하고 별도로 검증한다.
    const NON_STRUCTURAL_CASE_KEYS = new Set([
      'spine.diagnosis.verticalDistribution',
      'spine.diagnosis.concomitantSpondylosis',
      'job.rollup.longestTenureJobNameNormalized',
    ]);
    const caseVariables = getFullVariableCatalog().filter((v) => v.grain === 'case' && !NON_STRUCTURAL_CASE_KEYS.has(v.key));
    expect(caseVariables).toHaveLength(7); // 회귀 방지 — 이 루프가 조용히 텅 비지 않게

    for (const variable of caseVariables) {
      const result = computeVariableValue(variable.key, emptyMr);
      expect(result, `key=${variable.key}`).toBeDefined();
      expect(result).toHaveProperty('value');
      expect(result).toHaveProperty('missing');
      expect(result).toHaveProperty('qualityFlags');
      expect(Array.isArray(result!.qualityFlags)).toBe(true);
      // 모듈 데이터가 전부 비어 있으므로(§공통 0단계) structural_missing이어야 한다.
      expect(result!.missing).toBe('structural_missing');
      expect(result!.value).toBeNull();
    }
  });

  // PR0-B3 Part B — spine.diagnosis.*는 shared.diagnoses[]가 비어 있으면(spine 진단 자체가
  // 없음) not_applicable이다 — 위 루프의 "모듈 데이터 비어있음→structural_missing"과는
  // 다른 판정 경로임을 별도로 고정한다.
  it('spine.diagnosis.verticalDistribution/concomitantSpondylosis — spine 진단이 없으면 not_applicable', () => {
    const emptyMr = migrate({
      data: { shared: {}, modules: {}, activeModules: ['spine'] },
    });
    for (const key of ['spine.diagnosis.verticalDistribution', 'spine.diagnosis.concomitantSpondylosis']) {
      const result = computeVariableValue(key, emptyMr);
      expect(result, `key=${key}`).toBeDefined();
      expect(result!.missing).toBe('not_applicable');
      expect(result!.value).toBeNull();
    }
  });

  // PR0-B3 Part C — job.rollup.longestTenureJobNameNormalized는 shared.jobs[] 자체가
  // 없으면(유효 근속기간 후보 0건) not_entered다.
  it('job.rollup.longestTenureJobNameNormalized — 직력이 없으면 not_entered', () => {
    const emptyMr = migrate({ data: { shared: {}, modules: {}, activeModules: [] } });
    const result = computeVariableValue('job.rollup.longestTenureJobNameNormalized', emptyMr);
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('반복 grain 키를 스칼라 API로 호출하면 명확히 throw한다', () => {
    const emptyMr = migrate({ data: { shared: {}, modules: {}, activeModules: [] } });
    expect(() => computeVariableValue('spine.vibration.intervalA8Max', emptyMr)).toThrow(/반복 grain/);
  });
});

describe('computeRepeatedVariableValue', () => {
  it('미등록 key는 undefined를 반환한다', () => {
    const mr = migrate({ data: { shared: {}, modules: {}, activeModules: [] } });
    expect(computeRepeatedVariableValue('not.a.real.key', mr)).toBeUndefined();
  });

  it('case grain 키를 반복 API로 호출하면 명확히 throw한다', () => {
    const mr = migrate({ data: { shared: {}, modules: {}, activeModules: [] } });
    expect(() => computeRepeatedVariableValue('spine.vibration.dvMax', mr)).toThrow(/스칼라 grain/);
  });

  // 카탈로그의 반복 grain 키 전부를 순회하며 배열(빈 배열 포함)을 반환하는지 실측한다 —
  // computeVariableValue 루프 테스트와 대칭. PR0-B3 Part B — diagnosis_side grain 4개
  // 추가로 2→6개(vibration_interval 2 + diagnosis_side 4). Part C-1 — job grain 2개
  // 추가로 6→8개. Part C-2 — task grain 2개 + diagnosis_side grain 1개 추가로 8→11개.
  it('카탈로그 반복 grain 키 전부에서 배열을 반환한다(모듈 비활성/진단·직력 없음이면 빈 배열)', () => {
    const emptyMr = migrate({ data: { shared: {}, modules: {}, activeModules: [] } });
    const repeatedVariables = getFullVariableCatalog().filter((v) => v.grain !== 'case' && v.grain !== 'person');
    expect(repeatedVariables).toHaveLength(11); // 회귀 방지 — 이 루프가 조용히 텅 비지 않게

    for (const variable of repeatedVariables) {
      const result = computeRepeatedVariableValue(variable.key, emptyMr);
      expect(result, `key=${variable.key}`).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      // 모듈이 비활성이므로(activeModules: []) 이 grain에서 관측 행이 0개다.
      expect(result).toHaveLength(0);
    }
  });
});
