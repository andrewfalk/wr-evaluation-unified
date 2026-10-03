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
  extractKneeCaseSumSquattingMinutesPerDay,
  extractKneeCaseSumDailyLoadKg,
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

// 사용자 요청(2026-10-03) — 무릎 case grain 합계(직업력 단순합). 어깨 extractShoulderCaseSum* 테스트와
// 같은 정책을 두 변수(쪼그려앉기 분/일, 중량물 kg/일)에 각각 적용한다.
describe.each([
  { name: 'extractKneeCaseSumSquattingMinutesPerDay', fn: extractKneeCaseSumSquattingMinutesPerDay, field: 'squatting', other: 'weight' },
  { name: 'extractKneeCaseSumDailyLoadKg', fn: extractKneeCaseSumDailyLoadKg, field: 'weight', other: 'squatting' },
])('$name — case grain 합계', ({ fn, field, other }) => {
  const twoJobs = [
    { id: 'job-1', jobName: '용접공', startDate: '2015-01-01', endDate: '2020-01-01' },
    { id: 'job-2', jobName: '배관공', startDate: '2020-01-01', endDate: '2022-01-01' },
  ];
  const sumOf = (jobExtras: unknown[], jobs: unknown[] = twoJobs) => fn(migrate(jobExtrasCase({ jobs, jobExtras })));
  const NOT_ENTERED = { value: null, missing: 'not_entered', qualityFlags: [] };
  const INVALID = { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };

  it('knee 모듈이 비활성이면 structural_missing', () => {
    expect(fn(migrate(jobExtrasCase({ jobs: twoJobs, activeModules: [] })))).toEqual({
      value: null,
      missing: 'structural_missing',
      qualityFlags: [],
    });
  });

  it('activeModules엔 있는데 data.modules.knee가 plain object가 아니면 structural_missing', () => {
    const payload = { data: { shared: { jobs: twoJobs }, modules: {}, activeModules: ['knee'] } };
    expect(fn(migrate(payload))).toEqual({ value: null, missing: 'structural_missing', qualityFlags: [] });
  });

  it('shared.jobs가 비어 있으면 not_entered', () => {
    expect(sumOf([{ sharedJobId: 'job-1', [field]: '10' }], [])).toEqual(NOT_ENTERED);
  });

  it('2개 직업의 값을 합산한다(문자열·number 혼합)', () => {
    expect(sumOf([{ sharedJobId: 'job-1', [field]: '30' }, { sharedJobId: 'job-2', [field]: 45 }])).toEqual({
      value: 75,
      missing: null,
      qualityFlags: [],
    });
  });

  it('다른 필드(other)의 값은 합산에 섞이지 않는다', () => {
    expect(
      sumOf([
        { sharedJobId: 'job-1', [field]: '30', [other]: '999' },
        { sharedJobId: 'job-2', [field]: '10', [other]: '999' },
      ]),
    ).toEqual({ value: 40, missing: null, qualityFlags: [] });
  });

  it('전 직업 blank(미입력·빈 문자열·공백·extras 없음)이면 0이 아니라 not_entered', () => {
    expect(sumOf([])).toEqual(NOT_ENTERED);
    expect(sumOf([{ sharedJobId: 'job-1', [field]: '' }, { sharedJobId: 'job-2', [field]: '   ' }])).toEqual(NOT_ENTERED);
    expect(sumOf([{ sharedJobId: 'job-1' }, { sharedJobId: 'job-2', [field]: null }])).toEqual(NOT_ENTERED);
  });

  it('일부 직업만 blank면 그 직업은 건너뛰고 나머지의 합', () => {
    expect(sumOf([{ sharedJobId: 'job-1', [field]: '' }, { sharedJobId: 'job-2', [field]: '25' }])).toEqual({
      value: 25,
      missing: null,
      qualityFlags: [],
    });
  });

  // 입력한 0은 blank가 아니라 정상 0이다(마이그레이션 이후 jobExtras 직접 입력 기준 — 레거시 변환은 아래 별도 테스트).
  it('0·"0"은 blank가 아닌 정상 0이다 — 전 직업이 0이면 value 0', () => {
    expect(sumOf([{ sharedJobId: 'job-1', [field]: 0 }, { sharedJobId: 'job-2', [field]: '0' }])).toEqual({
      value: 0,
      missing: null,
      qualityFlags: [],
    });
    expect(sumOf([{ sharedJobId: 'job-1', [field]: '0' }, { sharedJobId: 'job-2', [field]: '' }])).toEqual({
      value: 0,
      missing: null,
      qualityFlags: [],
    });
  });

  it.each([
    ['숫자 접두부 문자열', '45kg'],
    ['문자열', 'abc'],
    ['음수', -1],
    ['음수 문자열', '-5'],
    ['배열로 감싼 유효 숫자', [45]],
    ['빈 배열', []],
    ['[null]', [null]],
    ['객체', {}],
    ['boolean', true],
  ])('손상값(%s)이 하나라도 있으면 정상 직업이 섞여 있어도 부분합 없이 not_entered + invalid', (_label, bad) => {
    expect(sumOf([{ sharedJobId: 'job-1', [field]: '30' }, { sharedJobId: 'job-2', [field]: bad }])).toEqual(INVALID);
    expect(sumOf([{ sharedJobId: 'job-1', [field]: bad }])).toEqual(INVALID);
  });

  it('손상값과 blank가 섞여 있어도 invalid가 blank 판정(전 직업 blank → not_entered)보다 먼저다', () => {
    expect(sumOf([{ sharedJobId: 'job-1', [field]: '' }, { sharedJobId: 'job-2', [field]: 'abc' }])).toEqual(INVALID);
  });

  it('합산 overflow(비유한 합)는 not_entered + invalid', () => {
    expect(sumOf([{ sharedJobId: 'job-1', [field]: '1e308' }, { sharedJobId: 'job-2', [field]: '1e308' }])).toEqual(INVALID);
  });

  it('shared.jobs에 없는 orphan extras는 합산에서 제외한다', () => {
    expect(sumOf([{ sharedJobId: 'job-1', [field]: '30' }, { sharedJobId: 'deleted-job', [field]: '500' }])).toEqual({
      value: 30,
      missing: null,
      qualityFlags: [],
    });
    // orphan에만 값이 있으면 합산 대상이 없으므로 not_entered
    expect(sumOf([{ sharedJobId: 'deleted-job', [field]: '500' }])).toEqual(NOT_ENTERED);
  });

  it('orphan extras의 손상값은 합산 대상이 아니므로 invalid로 번지지 않는다', () => {
    expect(sumOf([{ sharedJobId: 'job-1', [field]: '30' }, { sharedJobId: 'deleted-job', [field]: 'abc' }])).toEqual({
      value: 30,
      missing: null,
      qualityFlags: [],
    });
  });

  it('extras 배열 순서를 바꿔도 ID 연결 결과는 같다', () => {
    const extras = [
      { sharedJobId: 'job-1', [field]: '30' },
      { sharedJobId: 'job-2', [field]: '45' },
    ];
    expect(sumOf(extras)).toEqual(sumOf([...extras].reverse()));
  });

  it('plain object가 아닌 jobs·extras 항목은 무시한다', () => {
    expect(sumOf([null, 'x', { sharedJobId: 'job-1', [field]: '30' }], [null, 7, ...twoJobs])).toEqual({
      value: 30,
      missing: null,
      qualityFlags: [],
    });
  });

  // 경계 명시: 직종·시작·종료·override가 전부 빈 기본(placeholder) 행은 job grain에서는 엔터티가 아니지만
  // (enumerateJobEntities가 제외), 합계는 연결된 노출값이 있으면 포함한다(어깨 합계와 같은 선례).
  it('기본(placeholder) 직업 행에 연결된 노출값도 합산한다 — 같은 케이스에서 job grain은 0행', () => {
    const placeholderCase = jobExtrasCase({
      jobs: [{ id: 'job-1' }],
      jobExtras: [{ sharedJobId: 'job-1', [field]: '40' }],
    });
    expect(fn(migrate(placeholderCase))).toEqual({ value: 40, missing: null, qualityFlags: [] });
    expect(extractKneeJobWeight(migrate(placeholderCase))).toEqual([]);
    expect(extractKneeJobSquatting(migrate(placeholderCase))).toEqual([]);
  });

  it('일반 케이스(기본 행 없음)에서는 job grain 값의 합과 일치한다', () => {
    const generalCase = jobExtrasCase({
      jobs: twoJobs,
      jobExtras: [{ sharedJobId: 'job-1', [field]: '30' }, { sharedJobId: 'job-2', [field]: '45' }],
    });
    const jobGrain = field === 'weight' ? extractKneeJobWeight(migrate(generalCase)) : extractKneeJobSquatting(migrate(generalCase));
    const jobGrainSum = jobGrain.reduce((acc, row) => acc + (row.value ?? 0), 0);
    expect(fn(migrate(generalCase))).toEqual({ value: jobGrainSum, missing: null, qualityFlags: [] });
  });

  // 추출기는 레거시 modules.knee.jobs[]를 직접 읽지 않는다 — 원본에 shared.jobs가 없을 때
  // deterministicMigrate가 변환한 결과만 반영된다(deterministicMigrate.ts 4단계).
  it('레거시: 원본에 shared.jobs가 이미 있으면 modules.knee.jobs[]는 무시한다', () => {
    const payload = {
      data: {
        shared: { jobs: [{ id: 'job-1', jobName: '용접공' }] },
        modules: {
          knee: {
            jobExtras: [{ sharedJobId: 'job-1', [field]: '10' }],
            jobs: [{ id: 'legacy-1', [field]: '999' }],
          },
        },
        activeModules: ['knee'],
      },
    };
    expect(fn(migrate(payload))).toEqual({ value: 10, missing: null, qualityFlags: [] });
  });

  it('레거시: shared.jobs가 없으면 modules.knee.jobs[]가 shared.jobs+jobExtras로 변환되어 합산된다', () => {
    const payload = {
      data: {
        shared: {},
        modules: {
          knee: {
            jobs: [
              { id: 'legacy-1', jobName: '용접공', [field]: '10' },
              { id: 'legacy-2', jobName: '배관공', [field]: '25' },
            ],
          },
        },
        activeModules: ['knee'],
      },
    };
    expect(fn(migrate(payload))).toEqual({ value: 35, missing: null, qualityFlags: [] });
  });

  // 현재 동작 기록(변경 아님): deterministicMigrate가 `weight || ''`·`squatting || ''`로 변환하므로
  // 레거시 숫자 0은 blank가 되고, 문자열 '0'은 유지된다. 마이그레이션 수정은 기존 변수에도 영향을
  // 주므로 이번 범위가 아니다.
  it('레거시 경계 기록: 숫자 0은 변환 시 blank가 되고 문자열 "0"은 정상 0으로 남는다', () => {
    const legacyWith = (value: unknown) => ({
      data: {
        shared: {},
        modules: { knee: { jobs: [{ id: 'legacy-1', jobName: '용접공', [field]: value }] } },
        activeModules: ['knee'],
      },
    });
    expect(fn(migrate(legacyWith(0)))).toEqual(NOT_ENTERED);
    expect(fn(migrate(legacyWith('0')))).toEqual({ value: 0, missing: null, qualityFlags: [] });
  });
});
