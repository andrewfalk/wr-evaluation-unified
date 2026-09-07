import { describe, it, expect } from 'vitest';
import { getFullVariableCatalog, computeVariableValue, CATALOG_VERSION } from '../catalog';
import { deterministicMigrate } from '../migration/deterministicMigrate';

const FALLBACK = '2024-01-01T00:00:00.000Z';

function migrate(payload: unknown, caseId = 'case-1') {
  return deterministicMigrate(payload, { caseId, createdAtFallbackIso: FALLBACK });
}

describe('getFullVariableCatalog', () => {
  it('7개 변수 전부 반환하고, 전부 grain:case·sensitivity:non_sensitive다(회귀 방지 고정)', () => {
    const catalog = getFullVariableCatalog();
    expect(catalog).toHaveLength(7);
    for (const variable of catalog) {
      expect(variable.grain).toBe('case');
      expect(variable.sensitivity).toBe('non_sensitive');
    }
  });

  it('키 목록이 정확히 7개 대표 변수와 일치한다', () => {
    const keys = getFullVariableCatalog().map((v) => v.key).sort();
    expect(keys).toEqual(
      [
        'cervical.case.maxJobCumulativeKgHours',
        'elbow.assessment.burdenGradeMax',
        'knee.relatedness.max',
        'shoulder.exposure.anyExceeded',
        'spine.mddm.lifetimeDoseMNh',
        'spine.vibration.dvMax',
        'wrist.assessment.burdenGradeMax',
      ].sort(),
    );
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
  // 카탈로그 7개 키 전부를 순회하며 반환값이 ExtractedValue shape을 만족하는지 실측한다.
  it('카탈로그 7개 키 전부에서 이중 캐스트 호출이 ExtractedValue shape을 만족한다', () => {
    const emptyMr = migrate({
      data: {
        shared: {},
        modules: {},
        activeModules: ['knee', 'shoulder', 'elbow', 'wrist', 'cervical', 'spine'],
      },
    });

    for (const variable of getFullVariableCatalog()) {
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
});
