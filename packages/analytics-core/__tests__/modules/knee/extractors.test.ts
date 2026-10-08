import { describe, it, expect } from 'vitest';
import {
  classifyKneeJob,
  isBlank,
  parseNonNegativeNumber,
  extractKneeRelatednessMax,
  extractKneeDiagnosisSideKlGrade,
  extractKneeDiagnosisSideConfirmedStatus,
  extractKneeJobWeight,
  extractKneeJobSquatting,
  extractKneeJobStairs,
  extractKneeCaseWeightedSquattingMinutesPerDay,
  extractKneeCaseCumulativeSquattingHours,
  extractKneeCaseWeightedDailyLoadKg,
  extractKneeCaseCumulativeLoadTon,
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

// PR0-B4 Slice 4 — coverage 잔여 필드(매핑표 §2). enumerateJobEntities(shared.jobs[] 기준)
// + modules.knee.jobExtras[] 투영 — 위 relatedness.max 테스트의 baseCase(레거시
// modules.knee.jobs[] 기반)와 데이터 소스가 다르므로 별도 헬퍼를 쓴다.
function jobExtrasCase(overrides: { jobs?: unknown[]; jobExtras?: unknown[]; activeModules?: string[] }) {
  const { jobs = [{ id: 'job-1', jobName: '용접공' }], jobExtras = [], activeModules = ['knee'] } = overrides;
  return { data: { shared: { jobs }, modules: { knee: { jobExtras } }, activeModules } };
}

describe('extractKneeJobWeight/Stairs — job grain(jobExtras 원시값 투영)', () => {
  it('knee 모듈이 비활성이면 structural_missing', () => {
    const result = extractKneeJobWeight(migrate(jobExtrasCase({ activeModules: [] })));
    expect(result).toEqual([{ entityKey: ['job-1'], value: null, missing: 'structural_missing', qualityFlags: [] }]);
  });

  it('jobExtras 매칭 레코드가 없으면 not_entered', () => {
    const result = extractKneeJobWeight(migrate(jobExtrasCase({})));
    expect(result).toEqual([{ entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  it('weight — 정상 입력 통과, 레거시 modules.knee.jobs[]는 안 본다(제외 결정)', () => {
    const result = extractKneeJobWeight(migrate(jobExtrasCase({ jobExtras: [{ sharedJobId: 'job-1', weight: 30 }] })));
    expect(result).toEqual([{ entityKey: ['job-1'], value: 30, missing: null, qualityFlags: [] }]);
  });

  // 8차 검토 P2 재현 — parseNonNegativeNumber는 내부적으로 String(x)를 거쳐 배열도
  // 우연히 숫자로 통과시킨다(String([30]) === '30'). typeof 사전 검증이 이를 막는지 확인.
  it('배열로 감싼 유효 숫자여도 강제변환으로 통과시키지 않는다 — not_entered + invalid', () => {
    const result = extractKneeJobWeight(migrate(jobExtrasCase({ jobExtras: [{ sharedJobId: 'job-1', weight: [30] }] })));
    expect(result).toEqual([{ entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  // 9차 검토 P2 재현 — isBlank(전역 exported)는 String(x)로 감싸 String([])===''·
  // String([null])===''가 돼 typeof 검사보다 먼저 "빈 값"으로 오인했다. 빈 값 판정을
  // null·undefined·공백 문자열로 한정했는지 직접 확인한다(무플래그 not_entered가 아니라
  // invalid가 붙어야 손상값 구분이 산다).
  it('빈 배열·[null] 등 String() 강제변환으로 빈 문자열이 되는 배열은 빈 값이 아니라 손상값으로 처리한다 — invalid', () => {
    expect(extractKneeJobWeight(migrate(jobExtrasCase({ jobExtras: [{ sharedJobId: 'job-1', weight: [] }] })))).toEqual([
      { entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] },
    ]);
    expect(extractKneeJobWeight(migrate(jobExtrasCase({ jobExtras: [{ sharedJobId: 'job-1', weight: [null] }] })))).toEqual([
      { entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] },
    ]);
  });

  it('stairs — 체크박스라 undefined는 not_entered, boolean은 그대로, 손상 타입만 invalid', () => {
    expect(extractKneeJobStairs(migrate(jobExtrasCase({ jobExtras: [{ sharedJobId: 'job-1' }] })))).toEqual([
      { entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: [] },
    ]);
    expect(extractKneeJobStairs(migrate(jobExtrasCase({ jobExtras: [{ sharedJobId: 'job-1', stairs: true }] })))).toEqual([
      { entityKey: ['job-1'], value: true, missing: null, qualityFlags: [] },
    ]);
    expect(extractKneeJobStairs(migrate(jobExtrasCase({ jobExtras: [{ sharedJobId: 'job-1', stairs: false }] })))).toEqual([
      { entityKey: ['job-1'], value: false, missing: null, qualityFlags: [] },
    ]);
    expect(extractKneeJobStairs(migrate(jobExtrasCase({ jobExtras: [{ sharedJobId: 'job-1', stairs: 'yes' }] })))).toEqual([
      { entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] },
    ]);
  });
});

// 사용자 요청(2026-10-08·09) — 쪼그려앉기(분/일)·중량물(kg/일) case 변수: 직력 기간 가중평균 · 누적(시간/톤).
// 구 단순합(sumSquattingMinutesPerDay·sumDailyLoadKg)은 삭제됐다.
// 기간은 workPeriodOverride("N년")로 정확한 연수를 만든다(날짜 기반 연수는 365.25 환산이라 소수).
describe('무릎 case 노출 변수 — 가중평균/누적', () => {
  const job = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    jobName: id,
    workPeriodOverride: '2년',
    workDaysPerYear: 250,
    ...extra,
  });
  const twoJobs = [job('job-1'), job('job-2', { workPeriodOverride: '8년' })];
  const NOT_ENTERED = { value: null, missing: 'not_entered', qualityFlags: [] };
  const INVALID = { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  const NOT_APPLICABLE = { value: null, missing: 'not_applicable', qualityFlags: [] };
  const ok = (value: number) => ({ value, missing: null, qualityFlags: [] });

  describe.each([
    { name: 'extractKneeCaseWeightedSquattingMinutesPerDay', fn: extractKneeCaseWeightedSquattingMinutesPerDay, field: 'squatting' },
    { name: 'extractKneeCaseCumulativeSquattingHours', fn: extractKneeCaseCumulativeSquattingHours, field: 'squatting' },
    { name: 'extractKneeCaseWeightedDailyLoadKg', fn: extractKneeCaseWeightedDailyLoadKg, field: 'weight' },
    { name: 'extractKneeCaseCumulativeLoadTon', fn: extractKneeCaseCumulativeLoadTon, field: 'weight' },
  ])('$name — 공통 결측·대상 직력 규칙', ({ fn, field }) => {
    const run = (jobExtras: unknown[], jobs: unknown[] = twoJobs) => fn(migrate(jobExtrasCase({ jobs, jobExtras })));

    it('knee 모듈 비활성이면 structural_missing, shared.jobs가 비면 not_entered', () => {
      expect(fn(migrate(jobExtrasCase({ jobs: twoJobs, activeModules: [] })))).toEqual({
        value: null,
        missing: 'structural_missing',
        qualityFlags: [],
      });
      expect(run([{ sharedJobId: 'job-1', [field]: '60' }], [])).toEqual(NOT_ENTERED);
    });

    it('전 직업 노출값 blank면 not_entered(0 아님)', () => {
      expect(run([])).toEqual(NOT_ENTERED);
      expect(run([{ sharedJobId: 'job-1', [field]: '' }, { sharedJobId: 'job-2', [field]: '  ' }])).toEqual(NOT_ENTERED);
    });

    it.each([
      ['숫자 접두부 문자열', '45min'],
      ['음수', -1],
      ['배열', [60]],
      ['boolean', true],
    ])('노출값 손상값(%s)이 하나라도 있으면 정상 직력이 섞여 있어도 부분값 없이 not_entered + invalid', (_l, bad) => {
      expect(run([{ sharedJobId: 'job-1', [field]: '60' }, { sharedJobId: 'job-2', [field]: bad }])).toEqual(INVALID);
    });

    it('노출값를 입력한 직력의 기간이 blank면 가중/누적 불가라 not_entered(flag 없음)', () => {
      const jobs = [job('job-1', { workPeriodOverride: '' })];
      expect(run([{ sharedJobId: 'job-1', [field]: '60' }], jobs)).toEqual(NOT_ENTERED);
    });

    it('기간이 invalid(종료일이 시작일보다 빠름·형식 오류 override)면 not_entered + invalid', () => {
      const reversed = [job('job-1', { workPeriodOverride: '', startDate: '2020-01-01', endDate: '2010-01-01' })];
      expect(run([{ sharedJobId: 'job-1', [field]: '60' }], reversed)).toEqual(INVALID);
      const badOverride = [job('job-1', { workPeriodOverride: '-3년' })];
      expect(run([{ sharedJobId: 'job-1', [field]: '60' }], badOverride)).toEqual(INVALID);
    });

    it('노출값 blank인 직력은 기간이 invalid여도 건너뛴다(대상이 아님)', () => {
      const jobs = [job('job-1', { workPeriodOverride: '-3년' }), job('job-2')];
      const r = run([{ sharedJobId: 'job-2', [field]: '60' }], jobs);
      expect(r.missing).toBeNull();
      expect(r.qualityFlags).toEqual([]);
    });

    it('기간은 날짜(시작·종료일)로도 계산한다', () => {
      const dated = [job('job-1', { workPeriodOverride: '', startDate: '2010-01-01', endDate: '2020-01-01' })];
      const r = run([{ sharedJobId: 'job-1', [field]: '60' }], dated);
      expect(r.missing).toBeNull();
      expect(r.value).toBeGreaterThan(0);
    });

    it('신체부담평가 미포함 직력은 분자·분모에서 모두 빠지고, 전부 미포함이면 not_applicable', () => {
      const excludedFirst = [job('job-1', { excludeFromAnalysis: true }), job('job-2', { workPeriodOverride: '8년' })];
      const onlyJob2 = [job('job-2', { workPeriodOverride: '8년' })];
      const extras = [{ sharedJobId: 'job-1', [field]: '600' }, { sharedJobId: 'job-2', [field]: '120' }];
      expect(run(extras, excludedFirst)).toEqual(run(extras, onlyJob2));

      const allExcluded = twoJobs.map((j) => ({ ...j, excludeFromAnalysis: true }));
      expect(run(extras, allExcluded)).toEqual(NOT_APPLICABLE);
    });

    it('미포함 직력의 손상값은 계산에 영향을 주지 않는다', () => {
      const jobs = [job('job-1', { excludeFromAnalysis: true, workPeriodOverride: '-3년' }), job('job-2')];
      const r = run([{ sharedJobId: 'job-1', [field]: 'abc' }, { sharedJobId: 'job-2', [field]: '60' }], jobs);
      expect(r.missing).toBeNull();
    });

    it('shared.jobs에 없는 orphan extras는 대상이 아니다', () => {
      expect(run([{ sharedJobId: 'deleted', [field]: '60' }])).toEqual(NOT_ENTERED);
    });

    it('직종·기간이 전부 빈 기본(placeholder) 행에 노출값만 있으면 가중 불가라 not_entered', () => {
      expect(run([{ sharedJobId: 'job-1', [field]: '60' }], [{ id: 'job-1' }])).toEqual(NOT_ENTERED);
    });

    it('합산 overflow는 not_entered + invalid', () => {
      expect(run([{ sharedJobId: 'job-1', [field]: '1e308' }, { sharedJobId: 'job-2', [field]: '1e308' }])).toEqual(INVALID);
    });

    it('extras 배열 순서를 바꿔도 ID 연결 결과는 같다', () => {
      const extras = [{ sharedJobId: 'job-1', [field]: '30' }, { sharedJobId: 'job-2', [field]: '45' }];
      expect(run(extras)).toEqual(run([...extras].reverse()));
    });

    it('plain object가 아닌 jobs·extras 항목은 무시한다', () => {
      const real = run([{ sharedJobId: 'job-1', [field]: '30' }], [job('job-1')]);
      expect(real.missing).toBeNull();
      expect(run([null, 'x', { sharedJobId: 'job-1', [field]: '30' }], [null, 7, job('job-1')])).toEqual(real);
    });

    it('orphan extras의 손상값은 대상이 아니므로 invalid로 번지지 않는다', () => {
      const r = run([{ sharedJobId: 'job-1', [field]: '30' }, { sharedJobId: 'deleted-job', [field]: 'abc' }], [job('job-1')]);
      expect(r.missing).toBeNull();
      expect(r.qualityFlags).toEqual([]);
    });

    // 추출기는 레거시 modules.knee.jobs[]를 직접 읽지 않는다 — 원본에 shared.jobs가 없을 때
    // deterministicMigrate가 변환한 결과만 반영된다.
    it('레거시: 원본에 shared.jobs가 이미 있으면 modules.knee.jobs[]는 무시한다', () => {
      const payload = {
        data: {
          shared: { jobs: [job('job-1')] },
          modules: { knee: { jobExtras: [{ sharedJobId: 'job-1', [field]: '10' }], jobs: [{ id: 'legacy-1', [field]: '999' }] } },
          activeModules: ['knee'],
        },
      };
      expect(fn(migrate(payload))).toEqual(run([{ sharedJobId: 'job-1', [field]: '10' }], [job('job-1')]));
    });

    it('레거시: shared.jobs가 없으면 modules.knee.jobs[]가 변환되어 집계된다', () => {
      const payload = {
        data: {
          shared: {},
          modules: { knee: { jobs: [{ id: 'legacy-1', jobName: '용접공', workPeriodOverride: '2년', [field]: '10' }] } },
          activeModules: ['knee'],
        },
      };
      const r = fn(migrate(payload));
      expect(r.missing).toBeNull();
      expect(r.value).toBeGreaterThan(0);
    });

    // 현재 동작 기록(변경 아님): deterministicMigrate가 `weight || ''`·`squatting || ''`로 변환하므로
    // 레거시 숫자 0은 blank가 되고, 문자열 '0'은 유지된다. 마이그레이션 수정은 범위 밖.
    it('레거시 경계 기록: 숫자 0은 변환 시 blank가 되고 문자열 "0"은 정상 0으로 남는다', () => {
      const legacyWith = (value: unknown) => ({
        data: {
          shared: {},
          modules: { knee: { jobs: [{ id: 'legacy-1', jobName: '용접공', workPeriodOverride: '2년', [field]: value }] } },
          activeModules: ['knee'],
        },
      });
      expect(fn(migrate(legacyWith(0)))).toEqual(NOT_ENTERED);
      expect(fn(migrate(legacyWith('0')))).toEqual(ok(0));
    });
  });

  describe('extractKneeCaseWeightedSquattingMinutesPerDay — 직력 기간 가중평균', () => {
    const run = (jobExtras: unknown[], jobs: unknown[] = twoJobs) =>
      extractKneeCaseWeightedSquattingMinutesPerDay(migrate(jobExtrasCase({ jobs, jobExtras })));

    it('기간으로 가중평균한다 — (60×2 + 120×8) / 10 = 108 (단순합 180이 아님)', () => {
      expect(run([{ sharedJobId: 'job-1', squatting: '60' }, { sharedJobId: 'job-2', squatting: 120 }])).toEqual(ok(108));
    });

    it('직력이 하나면 그 직력의 값이다', () => {
      expect(run([{ sharedJobId: 'job-1', squatting: '45' }])).toEqual(ok(45));
    });

    it('쪼그려앉기 blank 직력은 분모(기간)에도 넣지 않는다', () => {
      expect(run([{ sharedJobId: 'job-1', squatting: '' }, { sharedJobId: 'job-2', squatting: '120' }])).toEqual(ok(120));
    });

    it('입력한 0은 정상 0이며 분모에 포함된다 — (0×2 + 100×8) / 10 = 80', () => {
      expect(run([{ sharedJobId: 'job-1', squatting: 0 }, { sharedJobId: 'job-2', squatting: '100' }])).toEqual(ok(80));
      expect(run([{ sharedJobId: 'job-1', squatting: '0' }])).toEqual(ok(0));
    });

    it('연간 근무일은 가중평균에 쓰이지 않는다(근무일이 비어 있어도 값이 나온다)', () => {
      const jobs = [job('job-1', { workDaysPerYear: '' })];
      expect(run([{ sharedJobId: 'job-1', squatting: '60' }], jobs)).toEqual(ok(60));
    });
  });

  describe('extractKneeCaseCumulativeSquattingHours — 누적(시간)', () => {
    const run = (jobExtras: unknown[], jobs: unknown[] = twoJobs) =>
      extractKneeCaseCumulativeSquattingHours(migrate(jobExtrasCase({ jobs, jobExtras })));

    it('Σ(분/일÷60 × 연간 근무일 × 연수) — 60/60×250×2 + 120/60×250×8 = 4500시간', () => {
      expect(run([{ sharedJobId: 'job-1', squatting: '60' }, { sharedJobId: 'job-2', squatting: 120 }])).toEqual(ok(4500));
    });

    it('저장된 근무일을 그대로 쓴다(250 대체 없음) — 60/60×200×2 = 400', () => {
      const jobs = [job('job-1', { workDaysPerYear: 200 })];
      expect(run([{ sharedJobId: 'job-1', squatting: '60' }], jobs)).toEqual(ok(400));
    });

    it('쪼그려앉기 blank 직력은 근무일이 비어 있어도 건너뛴다', () => {
      const jobs = [job('job-1', { workDaysPerYear: '' }), job('job-2', { workPeriodOverride: '8년' })];
      expect(run([{ sharedJobId: 'job-2', squatting: '120' }], jobs)).toEqual(ok(4000));
    });

    it('근무일 0은 정상 0이다', () => {
      expect(run([{ sharedJobId: 'job-1', squatting: '60' }], [job('job-1', { workDaysPerYear: 0 })])).toEqual(ok(0));
    });

    it('쪼그려앉기를 입력한 직력의 근무일이 blank면 not_entered(flag 없음)', () => {
      expect(run([{ sharedJobId: 'job-1', squatting: '60' }], [job('job-1', { workDaysPerYear: '' })])).toEqual(NOT_ENTERED);
      expect(run([{ sharedJobId: 'job-1', squatting: '60' }], [job('job-1', { workDaysPerYear: undefined })])).toEqual(NOT_ENTERED);
    });

    it.each([
      ['음수', -5],
      ['문자', 'abc'],
      ['숫자 접두부', '250일'],
      ['배열', [250]],
    ])('근무일 손상값(%s)은 not_entered + invalid', (_l, bad) => {
      expect(run([{ sharedJobId: 'job-1', squatting: '60' }], [job('job-1', { workDaysPerYear: bad })])).toEqual(INVALID);
    });

    // 알려진 한계 기록(의도된 정책 — 사용자 결정 2026-10-08 "저장된 값 그대로 사용"): 앱은 모든 직력에 근무일
    // 250을 기본으로 채우고 구형 무릎 마이그레이션도 250을 백필하므로, 직접 입력한 250과 구분되지 않는다.
    // 이 테스트가 바뀌면 입력 여부 추적을 도입하는 정책 변경이므로 의도를 다시 확인할 것.
    it('알려진 한계: 구형 modules.knee.jobs[] 마이그레이션이 백필한 근무일 250으로도 누적이 계산된다', () => {
      const legacy = {
        data: {
          shared: {},
          modules: { knee: { jobs: [{ id: 'legacy-1', jobName: '용접공', workPeriodOverride: '2년', squatting: '60' }] } },
          activeModules: ['knee'],
        },
      };
      expect(extractKneeCaseCumulativeSquattingHours(migrate(legacy))).toEqual(ok(500));
      expect(extractKneeCaseWeightedSquattingMinutesPerDay(migrate(legacy))).toEqual(ok(60));
    });
  });
  describe('중량물 — 가중평균/누적(톤)', () => {
    const loadJobs = [job('job-1'), job('job-2', { workPeriodOverride: '8년' })];
    const runWeighted = (jobExtras: unknown[], jobs: unknown[] = loadJobs) =>
      extractKneeCaseWeightedDailyLoadKg(migrate(jobExtrasCase({ jobs, jobExtras })));
    const runCumulative = (jobExtras: unknown[], jobs: unknown[] = loadJobs) =>
      extractKneeCaseCumulativeLoadTon(migrate(jobExtrasCase({ jobs, jobExtras })));
    const extras = [{ sharedJobId: 'job-1', weight: '3000' }, { sharedJobId: 'job-2', weight: 2000 }];

    it('가중평균 — (3000×2 + 2000×8) / 10 = 2200 kg/일 (단순합 5000이 아님)', () => {
      expect(runWeighted(extras)).toEqual(ok(2200));
    });

    it('누적 — 3000/1000×250×2 + 2000/1000×250×8 = 1500 + 4000 = 5500 톤', () => {
      expect(runCumulative(extras)).toEqual(ok(5500));
    });

    it('직력이 하나면 가중평균은 그 값, 누적은 kg/일÷1000×근무일×연수', () => {
      expect(runWeighted([{ sharedJobId: 'job-1', weight: '3000' }])).toEqual(ok(3000));
      expect(runCumulative([{ sharedJobId: 'job-1', weight: '3000' }])).toEqual(ok(1500));
    });

    it('쪼그려앉기 입력은 중량물 집계에 섞이지 않는다', () => {
      const mixed = [
        { sharedJobId: 'job-1', weight: '3000', squatting: '999' },
        { sharedJobId: 'job-2', weight: '2000', squatting: '999' },
      ];
      expect(runWeighted(mixed)).toEqual(ok(2200));
      expect(runCumulative(mixed)).toEqual(ok(5500));
    });

    it('중량물이 blank인 직력은 근무일·기간이 비어 있어도 건너뛴다', () => {
      const jobs = [job('job-1', { workDaysPerYear: '', workPeriodOverride: '' }), job('job-2', { workPeriodOverride: '8년' })];
      expect(runWeighted([{ sharedJobId: 'job-2', weight: '2000' }], jobs)).toEqual(ok(2000));
      expect(runCumulative([{ sharedJobId: 'job-2', weight: '2000' }], jobs)).toEqual(ok(4000));
    });
  });
});
