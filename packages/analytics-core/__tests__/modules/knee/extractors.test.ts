import { describe, it, expect } from 'vitest';
import { classifyKneeJob, isBlank, parseNonNegativeNumber, extractKneeRelatednessMax } from '../../../modules/knee/extractors';
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
