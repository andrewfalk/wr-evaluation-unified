import { describe, it, expect } from 'vitest';
import {
  StatsAnalysisRecipeSchema,
  AnalyzeDescriptiveStratifiedResultSchema,
  AnalyzeResultSchema,
  type AnalyzeDescriptiveStratifiedResult,
} from '../stats';

function baseRecipe(overrides: Record<string, unknown> = {}) {
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

describe('StatsAnalysisRecipeSchema — Table1 descriptive.stratifyByKey', () => {
  it('descriptive 모드에서 stratifyByKey를 허용한다', () => {
    const parsed = StatsAnalysisRecipeSchema.safeParse(
      baseRecipe({ descriptive: { stratifyByKey: 'case.staff.assignedDoctorUserId' } }),
    );
    expect(parsed.success, !parsed.success ? JSON.stringify(parsed.error.issues) : '').toBe(true);
  });

  it('descriptive 필드 자체는 선택적이다(기존 요청과의 additive 호환)', () => {
    const parsed = StatsAnalysisRecipeSchema.safeParse(baseRecipe());
    expect(parsed.success).toBe(true);
  });

  it('다른 analysisMode에 descriptive가 붙으면 거부한다', () => {
    const parsed = StatsAnalysisRecipeSchema.safeParse(
      baseRecipe({
        analysisMode: 'bivariate',
        requestedMethod: 'welch_t',
        variableKeys: ['a', 'b'],
        descriptive: { stratifyByKey: 'case.staff.assignedDoctorUserId' },
      }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message === 'DESCRIPTIVE_OPTIONS_REQUIRE_DESCRIPTIVE_MODE')).toBe(true);
    }
  });

  it('stratifyByKey가 variableKeys에도 있으면 거부한다', () => {
    const parsed = StatsAnalysisRecipeSchema.safeParse(
      baseRecipe({
        variableKeys: ['case.staff.assignedDoctorUserId'],
        descriptive: { stratifyByKey: 'case.staff.assignedDoctorUserId' },
      }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message === 'STRATIFY_KEY_MUST_NOT_BE_A_ROW_VARIABLE')).toBe(true);
    }
  });

  it('descriptive 서브객체도 strict — 알 수 없는 필드는 거부된다', () => {
    const parsed = StatsAnalysisRecipeSchema.safeParse(
      baseRecipe({ descriptive: { stratifyByKey: 'x', extra: 1 } }),
    );
    expect(parsed.success).toBe(false);
  });
});

// 명시적으로 "공개(revealed)" 분기 타입을 지정한다 — 그냥 리터럴로 두면 mean:40
// 등 숫자 리터럴에서 number로 좁게 추론돼, 아래 nullable 테스트에서 null을
// 대입할 때(정상 케이스, 계산 불가) 타입 에러가 난다.
const revealedCell: Extract<AnalyzeDescriptiveStratifiedResult, { suppressed: false }> = {
  suppressed: false as const,
  stratifyByKey: 'case.staff.assignedDoctorUserId',
  groups: [
    { groupId: 'total', kind: 'total' as const, level: null },
    { groupId: 'g0', kind: 'level' as const, level: '김민준' },
    { groupId: 'other', kind: 'other' as const, level: null },
  ],
  byGroup: [
    {
      groupId: 'total',
      continuous: [{
        variableKey: 'knee.relatedness.max', kind: 'continuous' as const, suppressed: false as const,
        n: 30, missingCount: 0, mean: 40, sd: 5, median: 40, q1: 35, q3: 45, iqr: 10, min: 20, max: 60,
      }],
      discrete: [{
        variableKey: 'sex', kind: 'discrete' as const, suppressed: false as const,
        n: 30, missingCount: 0, levels: [{ level: 'M', count: 15, proportion: 0.5 }, { level: 'F', count: 15, proportion: 0.5 }],
        mode: null,
      }],
    },
    {
      groupId: 'g0',
      continuous: [{ variableKey: 'knee.relatedness.max', kind: 'continuous' as const, suppressed: true as const }],
      discrete: [{ variableKey: 'sex', kind: 'discrete' as const, suppressed: true as const }],
    },
    {
      groupId: 'other',
      continuous: [{ variableKey: 'knee.relatedness.max', kind: 'continuous' as const, suppressed: true as const }],
      discrete: [{ variableKey: 'sex', kind: 'discrete' as const, suppressed: true as const }],
    },
  ],
};

describe('AnalyzeDescriptiveStratifiedResultSchema', () => {
  it('공개(revealed) 형태를 파싱한다', () => {
    const parsed = AnalyzeDescriptiveStratifiedResultSchema.safeParse(revealedCell);
    expect(parsed.success, !parsed.success ? JSON.stringify(parsed.error.issues) : '').toBe(true);
  });

  it('억제(suppressed) 스텁 형태를 파싱한다', () => {
    const parsed = AnalyzeDescriptiveStratifiedResultSchema.safeParse({
      suppressed: true, stratifyByKey: 'x', reasonCode: 'MIN_COHORT_NOT_MET',
    });
    expect(parsed.success).toBe(true);
  });

  it('연속형 통계 필드는 nullable이다(계산 불가 — 그룹 안에서 변수가 전부 결측)', () => {
    const withNulls = structuredClone(revealedCell);
    withNulls.byGroup[0].continuous[0] = {
      variableKey: 'knee.relatedness.max', kind: 'continuous', suppressed: false,
      n: 0, missingCount: 30, mean: null, sd: null, median: null, q1: null, q3: null, iqr: null, min: null, max: null,
    };
    const parsed = AnalyzeDescriptiveStratifiedResultSchema.safeParse(withNulls);
    expect(parsed.success, !parsed.success ? JSON.stringify(parsed.error.issues) : '').toBe(true);
  });

  it('억제된 셀에 수치 필드가 남아 있으면(스프레드 잔존) strict가 거부한다', () => {
    const leaked = structuredClone(revealedCell) as typeof revealedCell & {
      byGroup: Array<{ continuous: Array<Record<string, unknown>> }>;
    };
    leaked.byGroup[1].continuous[0] = {
      variableKey: 'knee.relatedness.max', kind: 'continuous', suppressed: true, mean: 42,
    };
    const parsed = AnalyzeDescriptiveStratifiedResultSchema.safeParse(leaked);
    expect(parsed.success).toBe(false);
  });

  it('mergedLevels·excludedMissingStratify류의 필드는 계약에 존재하지 않는다(병합 원본 식별자 노출 금지)', () => {
    const withExtra = structuredClone(revealedCell) as typeof revealedCell & { mergedLevels?: unknown };
    withExtra.mergedLevels = ['doctorC', 'doctorD'];
    const parsed = AnalyzeDescriptiveStratifiedResultSchema.safeParse(withExtra);
    expect(parsed.success).toBe(false);
  });
});

describe('AnalyzeResultSchema — descriptiveStratified 필드', () => {
  it('descriptiveStratified가 있어도 파싱되고, 구버전(필드 없음) 결과도 여전히 파싱된다', () => {
    const withField = AnalyzeResultSchema.safeParse({
      continuous: [], discrete: [], descriptiveStratified: revealedCell,
    });
    expect(withField.success, !withField.success ? JSON.stringify(withField.error.issues) : '').toBe(true);

    const withoutField = AnalyzeResultSchema.safeParse({ continuous: [], discrete: [] });
    expect(withoutField.success).toBe(true);
  });
});
