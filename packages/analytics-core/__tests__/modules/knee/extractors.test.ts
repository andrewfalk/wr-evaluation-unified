import { describe, it, expect } from 'vitest';
import {
  classifyKneeJob,
  isBlank,
  parseNonNegativeNumber,
  extractKneeRelatednessMax,
  extractKneeDiagnosisSideKlGrade,
  extractKneeDiagnosisSideConfirmedStatus,
  extractKneeDiagnosisSideAppliedConfirmedMismatch,
} from '../../../modules/knee/extractors';
import { deterministicMigrate } from '../../../migration/deterministicMigrate';
import type { KneeCalculationJob } from '../../../modules/knee/derived';

const FALLBACK = '2024-01-01T00:00:00.000Z';

function migrate(payload: unknown, caseId = 'case-1') {
  return deterministicMigrate(payload, { caseId, createdAtFallbackIso: FALLBACK });
}

function baseCase(overrides: {
  birthDate?: string;
  injuryDate?: string;
  jobs?: unknown[];
  activeModules?: string[];
  includeKneeModule?: boolean;
}) {
  const {
    birthDate = '1980-01-01',
    injuryDate = '2020-01-01',
    jobs = [],
    activeModules = ['knee'],
    includeKneeModule = true,
  } = overrides;
  return {
    data: {
      shared: { birthDate, injuryDate, jobs: [] },
      modules: includeKneeModule ? { knee: { jobs, jobExtras: [] } } : {},
      activeModules,
    },
  };
}

describe('isBlank / parseNonNegativeNumber', () => {
  it('isBlank treats null/undefined/empty/whitespace-only as blank', () => {
    expect(isBlank(null)).toBe(true);
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank('')).toBe(true);
    expect(isBlank('   ')).toBe(true);
    expect(isBlank(0)).toBe(false);
    expect(isBlank('0')).toBe(false);
  });

  it('parseNonNegativeNumber rejects negative numbers and numeric-prefix strings ("12kg")', () => {
    expect(parseNonNegativeNumber('10')).toBe(10);
    expect(parseNonNegativeNumber('-10')).toBeNull();
    expect(parseNonNegativeNumber('12kg')).toBeNull(); // Number('12kg') is NaN, unlike parseFloat
    expect(parseNonNegativeNumber('')).toBeNull();
    expect(parseNonNegativeNumber(null)).toBeNull();
  });
});

describe('classifyKneeJob — §4.2 job 10 fixtures', () => {
  const complete: KneeCalculationJob = {
    startDate: '2000-01-01',
    endDate: '2010-01-01',
    weight: '3000',
    squatting: '120',
  };

  it('1. complete job (all fields valid)', () => {
    expect(classifyKneeJob(complete)).toBe('complete');
  });

  it('2/4. startDate only, everything else blank -> partial', () => {
    expect(classifyKneeJob({ startDate: '2000-01-01' })).toBe('partial');
  });

  it('3. all fields blank -> empty', () => {
    expect(classifyKneeJob({})).toBe('empty');
    expect(classifyKneeJob({ startDate: '', endDate: '', workPeriodOverride: '', weight: '', squatting: '' })).toBe(
      'empty',
    );
  });

  it('5. endDate earlier than startDate -> partial', () => {
    expect(
      classifyKneeJob({ startDate: '2010-01-01', endDate: '2000-01-01', weight: '100', squatting: '50' }),
    ).toBe('partial');
  });

  it('6. workPeriodOverride is non-numeric text ("abc") -> partial', () => {
    expect(classifyKneeJob({ workPeriodOverride: 'abc', weight: '100', squatting: '50' })).toBe('partial');
  });

  it('7. startDate === endDate (zero-length period) -> partial', () => {
    expect(
      classifyKneeJob({ startDate: '2010-01-01', endDate: '2010-01-01', weight: '100', squatting: '50' }),
    ).toBe('partial');
  });

  it('8. weight/squatting are null/undefined (legacy non-string values)', () => {
    expect(
      classifyKneeJob({ startDate: '2000-01-01', endDate: '2010-01-01', weight: null, squatting: undefined }),
    ).toBe('partial'); // period present -> not empty; numbers blank -> not complete
  });

  it('9. only weight/squatting present, no period fields -> partial', () => {
    expect(classifyKneeJob({ weight: '100', squatting: '50' })).toBe('partial');
  });

  it('10. negative weight ("-10") or unit-suffixed string ("12kg") with valid period -> partial', () => {
    expect(
      classifyKneeJob({ startDate: '2000-01-01', endDate: '2010-01-01', weight: '-10', squatting: '50' }),
    ).toBe('partial');
    expect(
      classifyKneeJob({ startDate: '2000-01-01', endDate: '2010-01-01', weight: '12kg', squatting: '50' }),
    ).toBe('partial');
  });

  it('workPeriodOverride takes precedence over start/end dates and can alone make a job complete', () => {
    expect(classifyKneeJob({ workPeriodOverride: '5년', weight: '100', squatting: '50' })).toBe('complete');
  });
});

describe('extractKneeRelatednessMax — §4.3 결측 우선순위', () => {
  it('순서 1: unsupported_legacy_spine_jobs issue short-circuits to not_assessed/legacy_unknown, ignoring payload', () => {
    const migrated = migrate({
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01' }, // shared.jobs absent -> full migration path runs
        modules: {
          knee: {
            jobs: [{ startDate: '2000-01-01', endDate: '2010-01-01', weight: '3000', squatting: '120' }],
          },
          spine: { jobName: '용접공', careerYears: 10 },
        },
        activeModules: ['knee', 'spine'],
      },
    });
    expect(migrated.issues).toEqual([{ code: 'unsupported_legacy_spine_jobs' }]);
    expect(extractKneeRelatednessMax(migrated)).toEqual({
      value: null,
      missing: 'not_assessed',
      qualityFlags: ['legacy_unknown'],
    });
  });

  it('순서 2a: knee가 activeModules에 없으면 structural_missing', () => {
    const migrated = migrate(baseCase({ activeModules: ['spine'] }));
    expect(extractKneeRelatednessMax(migrated)).toEqual({
      value: null,
      missing: 'structural_missing',
      qualityFlags: [],
    });
  });

  it('순서 2b: data.modules.knee 자체가 없으면 structural_missing', () => {
    const migrated = migrate(baseCase({ includeKneeModule: false, activeModules: ['knee'] }));
    expect(extractKneeRelatednessMax(migrated)).toEqual({
      value: null,
      missing: 'structural_missing',
      qualityFlags: [],
    });
  });

  it('순서 3a: birthDate/injuryDate가 아예 없으면 not_entered(무플래그)', () => {
    const migrated = migrate(baseCase({ birthDate: '', injuryDate: '' }));
    expect(extractKneeRelatednessMax(migrated)).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 3b: 형식이 있었으나 파싱 실패(비정형 날짜)면 not_entered + invalid', () => {
    const migrated = migrate(baseCase({ birthDate: '1980-13-99', injuryDate: '2020-01-01' }));
    expect(extractKneeRelatednessMax(migrated)).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });

  it('순서 3c: 음수 나이(injuryDate가 birthDate보다 이름)도 not_entered + invalid', () => {
    const migrated = migrate(baseCase({ birthDate: '2020-01-01', injuryDate: '1980-01-01' }));
    expect(extractKneeRelatednessMax(migrated)).toEqual({
      value: null,
      missing: 'not_entered',
      qualityFlags: ['invalid'],
    });
  });

  it('순서 4: age<=30이면 not_applicable(경계 fixture: 정확히 30세)', () => {
    const migrated = migrate(baseCase({ birthDate: '1990-03-01', injuryDate: '2020-03-01' }));
    expect(extractKneeRelatednessMax(migrated)).toEqual({
      value: null,
      missing: 'not_applicable',
      qualityFlags: [],
    });
  });

  it('순서 4 경계 확인: age===31(30 초과)이면 계산을 시도한다', () => {
    const migrated = migrate(
      baseCase({
        birthDate: '1989-03-01',
        injuryDate: '2020-03-01',
        jobs: [{ startDate: '2000-01-01', endDate: '2010-01-01', weight: '3000', squatting: '120' }],
      }),
    );
    const result = extractKneeRelatednessMax(migrated);
    expect(result.missing).toBeNull();
    expect(result.value).toBeGreaterThan(0);
  });

  it('순서 5: partial job이 하나라도 있으면(완전한 job과 섞여 있어도) 전체 not_entered', () => {
    const migrated = migrate(
      baseCase({
        jobs: [
          { startDate: '2000-01-01', endDate: '2010-01-01', weight: '3000', squatting: '120' }, // complete
          { startDate: '2011-01-01' }, // partial(§4.2 fixture 2/4)
        ],
      }),
    );
    expect(extractKneeRelatednessMax(migrated)).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 6: complete job이 0개(전부 empty/placeholder)면 not_entered', () => {
    const migrated = migrate(baseCase({ jobs: [] })); // §5.1 규칙 5의 placeholder만 생김
    expect(extractKneeRelatednessMax(migrated)).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 3+6 조합: complete job과 empty job이 섞여 있으면 empty는 무시하고 정상 계산한다(§4.2 fixture 3)', () => {
    const withEmpty = migrate(
      baseCase({
        jobs: [
          { startDate: '2000-01-01', endDate: '2010-01-01', weight: '3000', squatting: '120' },
          {}, // empty
        ],
      }),
    );
    const withoutEmpty = migrate(
      baseCase({ jobs: [{ startDate: '2000-01-01', endDate: '2010-01-01', weight: '3000', squatting: '120' }] }),
      'case-2',
    );
    const a = extractKneeRelatednessMax(withEmpty);
    const b = extractKneeRelatednessMax(withoutEmpty);
    expect(a.missing).toBeNull();
    expect(a.value).toBe(b.value);
  });

  it('순서 7: 정상 계산 시 value는 항상 number(computeKneeCalc의 toFixed 문자열을 강제 변환)', () => {
    const migrated = migrate(
      baseCase({ jobs: [{ startDate: '2000-01-01', endDate: '2010-01-01', weight: '3000', squatting: '120' }] }),
    );
    const result = extractKneeRelatednessMax(migrated);
    expect(typeof result.value).toBe('number');
    expect(result.missing).toBeNull();
  });

  it('레거시 modules.knee.jobs(§3.1 mod.jobs 분기)로도 정상 계산된다 — resolveKneeCalculationJobs가 동일 배열을 본다', () => {
    const migrated = migrate(
      baseCase({ jobs: [{ startDate: '2000-01-01', endDate: '2010-01-01', weight: '3000', squatting: '120' }] }),
    );
    const result = extractKneeRelatednessMax(migrated);
    expect(result.missing).toBeNull();
    expect(result.value).toBeGreaterThan(0);
  });
});

// PR0-B3 Part B — diagnosis_side grain 3종. shared.diagnoses[]만 필요하다(knee 모듈
// 활성 여부와 무관 — resolveDiagnosisModule이 code/name 패턴으로 knee를 판정한다).
function diagnosesMigration(diagnoses: unknown[]) {
  return migrate({ data: { shared: { diagnoses }, modules: {}, activeModules: [] } });
}

describe('extractKneeDiagnosisSideKlGrade — diagnosis_side grain', () => {
  it('무릎 진단이 아니면(예: 요추) not_applicable', () => {
    const dx = { id: 'dx-1', code: 'M51.1', name: '요추간판장애', side: 'right' };
    const result = extractKneeDiagnosisSideKlGrade(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('무릎 진단이지만 supportsKlGrade가 false면(예: 비관절증 코드) not_applicable', () => {
    const dx = { id: 'dx-1', code: 'S83.1', name: '무릎 인대손상', side: 'right' }; // knee ICD지만 관절증 아님
    const result = extractKneeDiagnosisSideKlGrade(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('side가 unspecified면 klgRight/klgLeft 중 무엇을 읽을지 알 수 없어 not_entered', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: '', klgRight: '2' };
    const result = extractKneeDiagnosisSideKlGrade(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  it('klgRight/klgLeft가 공백이면 not_entered(무플래그)', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right', klgRight: '' };
    const result = extractKneeDiagnosisSideKlGrade(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  it('"N/A"(해당없음)는 등급이 아니라 not_applicable — 순서에 끼워넣지 않는다', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right', klgRight: 'N/A' };
    const result = extractKneeDiagnosisSideKlGrade(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('정상 입력 — side==="both"면 klgRight/klgLeft를 각각 읽어 두 행으로 반환한다', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'both', klgRight: '2', klgLeft: '3' };
    const result = extractKneeDiagnosisSideKlGrade(diagnosesMigration([dx]));
    expect(result).toEqual([
      { entityKey: ['dx-1', 'right'], value: '2', missing: null, qualityFlags: [] },
      { entityKey: ['dx-1', 'left'], value: '3', missing: null, qualityFlags: [] },
    ]);
  });

  // 3차 리뷰 P1 — KLG_OPTIONS가 실제로 제공하는 값(''·'N/A'·1~4)이 아닌데도 String(raw)로
  // 그대로 통과시키면, 이변량의 groupPairsByLevel()이 KNEE_KLG_ORDER 밖 값을 조용히 버려서
  // 기술통계(별도 범주로 집계)와 이변량(제외)의 유효 관측 수가 달라진다. 공백·N/A 외의 모든
  // 값은 not_entered + invalid여야 한다.
  it.each([
    ['범위 밖 숫자 문자열', '5'],
    ['파싱 불가 문자열', 'bad'],
    ['boolean', true],
    ['object', { x: 1 }],
    ['트레일링 공백이 붙은 유효값', '2 '],
  ])('klgRight가 %s(%j)이면 not_entered + invalid — 정상 등급으로 새지 않는다', (_label, klgRight) => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right', klgRight };
    const result = extractKneeDiagnosisSideKlGrade(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });
});

describe('extractKneeDiagnosisSideConfirmedStatus — diagnosis_side grain', () => {
  it('무릎 진단이 아니면 not_applicable', () => {
    const dx = { id: 'dx-1', code: 'M51.1', name: '요추간판장애', side: 'right', confirmedRight: 'confirmed' };
    const result = extractKneeDiagnosisSideConfirmedStatus(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('side가 unspecified면 not_entered', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: '', confirmedRight: 'confirmed' };
    const result = extractKneeDiagnosisSideConfirmedStatus(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  it('confirmedRight/Left가 공백이면 not_entered', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right' };
    const result = extractKneeDiagnosisSideConfirmedStatus(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  it('"confirmed"→true, "unconfirmed"→false', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'both', confirmedRight: 'confirmed', confirmedLeft: 'unconfirmed' };
    const result = extractKneeDiagnosisSideConfirmedStatus(diagnosesMigration([dx]));
    expect(result).toEqual([
      { entityKey: ['dx-1', 'right'], value: true, missing: null, qualityFlags: [] },
      { entityKey: ['dx-1', 'left'], value: false, missing: null, qualityFlags: [] },
    ]);
  });

  it('confirmed/unconfirmed가 아닌 값(손상 데이터)은 not_entered + invalid', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right', confirmedRight: 'garbage' };
    const result = extractKneeDiagnosisSideConfirmedStatus(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });
});

describe('extractKneeDiagnosisSideAppliedConfirmedMismatch — diagnosis_side grain', () => {
  it('무릎 진단이 아니면 not_applicable', () => {
    const dx = { id: 'dx-1', code: 'M51.1', name: '요추간판장애', side: 'right', confirmedCode: 'M51.1', confirmedName: '요추간판장애' };
    const result = extractKneeDiagnosisSideAppliedConfirmedMismatch(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('확정상병(confirmedCode/confirmedName)이 아직 입력되지 않으면 not_entered(비교 대상 없음)', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right' };
    const result = extractKneeDiagnosisSideAppliedConfirmedMismatch(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  it('신청상병과 확정상병이 같으면 false', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right', confirmedCode: 'M17.1', confirmedName: '무릎관절증' };
    const result = extractKneeDiagnosisSideAppliedConfirmedMismatch(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: false, missing: null, qualityFlags: [] }]);
  });

  it('신청상병과 확정상병(code 또는 name)이 다르면 true', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right', confirmedCode: 'M17.2', confirmedName: '무릎관절증' };
    const result = extractKneeDiagnosisSideAppliedConfirmedMismatch(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: true, missing: null, qualityFlags: [] }]);
  });

  it('side와 무관한 진단 레벨 값이라 both explode된 두 행에 동일한 값이 반복된다', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'both', confirmedCode: 'M17.2', confirmedName: '무릎관절증' };
    const result = extractKneeDiagnosisSideAppliedConfirmedMismatch(diagnosesMigration([dx]));
    expect(result).toEqual([
      { entityKey: ['dx-1', 'right'], value: true, missing: null, qualityFlags: [] },
      { entityKey: ['dx-1', 'left'], value: true, missing: null, qualityFlags: [] },
    ]);
  });
});
