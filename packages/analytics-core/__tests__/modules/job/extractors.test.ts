import { describe, it, expect } from 'vitest';
import {
  extractJobIdentityJobNameNormalized,
  extractJobIdentityTenureYears,
  extractJobRollupLongestTenureJobNameNormalized,
} from '../../../modules/job/extractors';
import { deterministicMigrate } from '../../../migration/deterministicMigrate';

const FALLBACK = '2024-01-01T00:00:00.000Z';

function migrate(payload: unknown, caseId = 'case-1') {
  return deterministicMigrate(payload, { caseId, createdAtFallbackIso: FALLBACK });
}

function jobsMigration(jobs: unknown[]) {
  return migrate({ data: { shared: { jobs }, modules: {}, activeModules: [] } });
}

describe('extractJobIdentityJobNameNormalized — job grain', () => {
  it('jobName이 공백이면 not_entered(무플래그)', () => {
    const job = { id: 'job-1', jobName: '', startDate: '2020-01-01', endDate: '2021-01-01' };
    const result = extractJobIdentityJobNameNormalized(jobsMigration([job]));
    expect(result).toEqual([{ entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  it('정상 입력 — 그대로 반환한다(변형 없음)', () => {
    const job = { id: 'job-1', jobName: '용접공' };
    const result = extractJobIdentityJobNameNormalized(jobsMigration([job]));
    expect(result).toEqual([{ entityKey: ['job-1'], value: '용접공', missing: null, qualityFlags: [] }]);
  });

  // §5.5 ① 계획 규칙 — NFC + 앞뒤공백 제거 + 내부공백 축약 + 전각/반각 통일 + 소문자화.
  it('앞뒤 공백·내부 연속 공백을 정리한다', () => {
    const job = { id: 'job-1', jobName: '  건설  현장   배근공  ' };
    const result = extractJobIdentityJobNameNormalized(jobsMigration([job]));
    expect(result[0].value).toBe('건설 현장 배근공');
  });

  it('전각 영숫자를 반각으로 통일하고 영문을 소문자화한다', () => {
    const job = { id: 'job-1', jobName: 'ＡＢ Ｃ１２３' }; // 전각 A B, 공백, C, 1 2 3
    const result = extractJobIdentityJobNameNormalized(jobsMigration([job]));
    expect(result[0].value).toBe('ab c123');
  });

  it('boolean·object 등 원본이 문자열이 아니면 not_entered + invalid', () => {
    const job = { id: 'job-1', jobName: true as unknown };
    const result = extractJobIdentityJobNameNormalized(jobsMigration([job]));
    expect(result).toEqual([{ entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  it('직력이 여러 개면 1:1로 매핑한다 — 행을 빼거나 더하지 않는다', () => {
    const a = { id: 'job-1', jobName: '용접공' };
    const b = { id: 'job-2', jobName: '' }; // 이름 공백이지만 startDate로 엔터티는 유지됨
    const bWithDates = { ...b, startDate: '2020-01-01', endDate: '2021-01-01' };
    const result = extractJobIdentityJobNameNormalized(jobsMigration([a, bWithDates]));
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.entityKey[0])).toEqual(['job-1', 'job-2']);
  });
});

describe('extractJobIdentityTenureYears — job grain', () => {
  it('직력이 전부 공백(이름·기간 다 없음)이면 이 job은 애초에 엔터티가 아니다 — placeholder 제외 확인', () => {
    const placeholder = { id: 'job-1', jobName: '', startDate: '', endDate: '', workPeriodOverride: '' };
    const result = extractJobIdentityTenureYears(jobsMigration([placeholder]));
    expect(result).toEqual([]);
  });

  it('기간이 전혀 입력되지 않았지만 이름은 있는 job — not_entered(무플래그)', () => {
    const job = { id: 'job-1', jobName: '용접공', startDate: '', endDate: '', workPeriodOverride: '' };
    const result = extractJobIdentityTenureYears(jobsMigration([job]));
    expect(result).toEqual([{ entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  it('startDate/endDate만으로 정상 계산한다', () => {
    const job = { id: 'job-1', jobName: '용접공', startDate: '2015-01-01', endDate: '2020-01-01' };
    const result = extractJobIdentityTenureYears(jobsMigration([job]));
    expect(result).toHaveLength(1);
    expect(result[0].missing).toBeNull();
    expect(result[0].value).toBeCloseTo(5, 1);
  });

  it('workPeriodOverride가 있으면 날짜보다 우선한다', () => {
    const job = { id: 'job-1', jobName: '용접공', startDate: '2015-01-01', endDate: '2020-01-01', workPeriodOverride: '3년' };
    const result = extractJobIdentityTenureYears(jobsMigration([job]));
    expect(result[0].value).toBeCloseTo(3, 1);
  });

  it('workPeriodOverride가 있는데 파싱 결과가 0년 이하면(형식 불일치) not_entered + invalid', () => {
    const job = { id: 'job-1', jobName: '용접공', workPeriodOverride: '오년' }; // "N년"/"N개월" 정규식에 안 걸림
    const result = extractJobIdentityTenureYears(jobsMigration([job]));
    expect(result).toEqual([{ entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  // 4차 리뷰 P2 재현 — parseWorkPeriodOverride(공유 함수)의 부분일치 방식이 배열
  // 강제변환·음수·소수를 그대로 통과시켰다. 엄격 형식 검사(isStrictWorkPeriodOverride)가
  // 이 셋을 전부 거부하는지 직접 확인한다.
  it.each([
    ['배열로 감싼 유효값', ['10년']],
    ['음수', '-10년'],
    ['소수', '1.5년'],
  ])('workPeriodOverride가 %s(%j)면 강제변환으로 통과시키지 않고 not_entered + invalid로 처리한다', (_label, workPeriodOverride) => {
    const job = { id: 'job-1', jobName: '용접공', workPeriodOverride };
    const result = extractJobIdentityTenureYears(jobsMigration([job]));
    expect(result).toEqual([{ entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  it('workPeriodOverride가 "N년 M개월" 형식이면(공백 포함) 정상 계산한다(엄격 검사가 정상 형식을 막지 않는지 확인)', () => {
    const job = { id: 'job-1', jobName: '용접공', workPeriodOverride: '3년 6개월' };
    const result = extractJobIdentityTenureYears(jobsMigration([job]));
    expect(result[0].missing).toBeNull();
    expect(result[0].value).toBeCloseTo(3.5, 3);
  });

  // startDate/endDate도 배열 강제변환으로 우연히 유효한 형식이 될 수 있다(K-L Grade에서
  // 이미 확립한 결함 계열과 동일) — String(['2020-01-01'])==='2020-01-01'.
  it('startDate가 배열로 감싼 유효 날짜여도 강제변환으로 통과시키지 않는다', () => {
    const job = { id: 'job-1', jobName: '용접공', startDate: ['2015-01-01'], endDate: '2020-01-01' };
    const result = extractJobIdentityTenureYears(jobsMigration([job]));
    expect(result).toEqual([{ entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  it('startDate만 있고 endDate가 없으면(불완전 입력) not_entered + invalid', () => {
    const job = { id: 'job-1', jobName: '용접공', startDate: '2015-01-01', endDate: '' };
    const result = extractJobIdentityTenureYears(jobsMigration([job]));
    expect(result).toEqual([{ entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  it('endDate가 startDate보다 이르면(역순) not_entered + invalid', () => {
    const job = { id: 'job-1', jobName: '용접공', startDate: '2020-01-01', endDate: '2015-01-01' };
    const result = extractJobIdentityTenureYears(jobsMigration([job]));
    expect(result).toEqual([{ entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  it('날짜 형식이 비정형이면(예: "2020/01/01") not_entered + invalid', () => {
    const job = { id: 'job-1', jobName: '용접공', startDate: '2020/01/01', endDate: '2021-01-01' };
    const result = extractJobIdentityTenureYears(jobsMigration([job]));
    expect(result).toEqual([{ entityKey: ['job-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  // PR0-B3 Part A "변수 추가/제거해도 모집단 불변" 계약 — jobNameNormalized만 요청·
  // tenureYears만 요청해도 행 개수·entityKey가 같아야 한다(이 파일에서는 각 extractor를
  // 직접 호출해 그 계약이 이 grain에도 성립함을 실측한다. buildDataset 레벨 검증은 서버
  // 쪽 statsDatasetBuilder.job.test.ts에서 한다).
  it('이름 없이 기간만 있는 job — jobNameNormalized는 not_entered인데 tenureYears는 정상 계산된다(결측 조건이 서로 다르다)', () => {
    const job = { id: 'job-1', jobName: '', startDate: '2015-01-01', endDate: '2020-01-01' };
    const name = extractJobIdentityJobNameNormalized(jobsMigration([job]));
    const tenure = extractJobIdentityTenureYears(jobsMigration([job]));
    expect(name[0].missing).toBe('not_entered');
    expect(tenure[0].missing).toBeNull();
  });
});

describe('extractJobRollupLongestTenureJobNameNormalized — case grain(§2.1 최초 roll-up)', () => {
  it('직력이 없으면 not_entered', () => {
    const result = extractJobRollupLongestTenureJobNameNormalized(jobsMigration([]));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('유효한 근속기간을 가진 job이 하나도 없으면(전부 결측/무효) not_entered', () => {
    const a = { id: 'job-1', jobName: '용접공A' }; // 기간 전혀 없음
    const b = { id: 'job-2', jobName: '용접공B', startDate: '2020-01-01', endDate: '2015-01-01' }; // 역순(무효)
    const result = extractJobRollupLongestTenureJobNameNormalized(jobsMigration([a, b]));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('근속기간이 가장 긴 job의 직종명을 대표값으로 반환한다', () => {
    const longer = { id: 'job-1', jobName: '용접공', startDate: '2010-01-01', endDate: '2020-01-01' }; // 10년
    const shorter = { id: 'job-2', jobName: '조립공', startDate: '2020-01-01', endDate: '2021-01-01' }; // 1년
    const result = extractJobRollupLongestTenureJobNameNormalized(jobsMigration([shorter, longer]));
    expect(result).toEqual({ value: '용접공', missing: null, qualityFlags: [] });
  });

  // workPeriodOverride는 "N년"/"N개월" 파싱 결과가 유리수라 두 job이 정확히 같은 값을
  // 낼 수 있다(날짜 기간은 윤년 분포 차이로 5년 구간끼리도 부동소수 오차가 생겨 진짜
  // 동률 재현에 부적합 — 실측으로 확인된 것을 반영).
  it('근속기간이 동률이면 시작일이 이른 job을 대표로 선택한다', () => {
    const earlier = { id: 'job-1', jobName: '용접공', workPeriodOverride: '5년', startDate: '2010-01-01' };
    const later = { id: 'job-2', jobName: '조립공', workPeriodOverride: '5년', startDate: '2016-01-01' };
    const result = extractJobRollupLongestTenureJobNameNormalized(jobsMigration([later, earlier]));
    expect(result?.value).toBe('용접공');
  });

  it('근속기간·시작일까지 동률이면 jobId 사전순으로 결정적 tie-break한다', () => {
    const a = { id: 'job-a', jobName: '용접공', workPeriodOverride: '5년', startDate: '2010-01-01' };
    const b = { id: 'job-b', jobName: '조립공', workPeriodOverride: '5년', startDate: '2010-01-01' };
    const result = extractJobRollupLongestTenureJobNameNormalized(jobsMigration([b, a]));
    expect(result?.value).toBe('용접공'); // 'job-a' < 'job-b'
  });

  // 4차 리뷰 P2 재현 — override로 계산된 근속은 startDate를 아예 안 읽는다. 이 후보의
  // startDate가 비어있는데 문자열 비교(''가 사전순 최상단)로 tie-break하면 "시작일
  // 미입력"이 "시작일이 가장 이름"으로 둔갑해 실제 시작일이 있는 후보를 이긴다 —
  // tryParseStrictDate 기반 비교(유효 날짜 우선)가 이를 막는지 직접 확인한다.
  it('동률 근속기간에서 startDate 미입력 job이 실제 startDate가 있는 job보다 우선되지 않는다', () => {
    const noStartDate = { id: 'job-a', jobName: '시작일없음', workPeriodOverride: '5년' }; // startDate 없음
    const withStartDate = { id: 'job-b', jobName: '시작일있음', workPeriodOverride: '5년', startDate: '2010-01-01' };
    const result = extractJobRollupLongestTenureJobNameNormalized(jobsMigration([noStartDate, withStartDate]));
    expect(result?.value).toBe('시작일있음');
  });

  it('동률 근속기간에서 startDate가 빈 문자열인 job도 실제 startDate가 있는 job보다 우선되지 않는다', () => {
    const blankStartDate = { id: 'job-a', jobName: '시작일공백', workPeriodOverride: '5년', startDate: '' };
    const withStartDate = { id: 'job-b', jobName: '시작일있음', workPeriodOverride: '5년', startDate: '2010-01-01' };
    const result = extractJobRollupLongestTenureJobNameNormalized(jobsMigration([blankStartDate, withStartDate]));
    expect(result?.value).toBe('시작일있음');
  });

  it('무효한 근속기간을 가진 job은 후보에서 제외되고, 유효한 다른 job이 대표가 된다', () => {
    const invalid = { id: 'job-1', jobName: '이상직력', workPeriodOverride: '오년' }; // 파싱 불가
    const valid = { id: 'job-2', jobName: '정상직력', startDate: '2018-01-01', endDate: '2020-01-01' };
    const result = extractJobRollupLongestTenureJobNameNormalized(jobsMigration([invalid, valid]));
    expect(result).toEqual({ value: '정상직력', missing: null, qualityFlags: [] });
  });

  it('결정성 — 동일 payload로 두 번 추출해도 byte-identical 결과', () => {
    const payload = { data: { shared: { jobs: [{ id: 'job-1', jobName: '용접공', startDate: '2010-01-01', endDate: '2020-01-01' }] }, modules: {}, activeModules: [] } };
    const first = extractJobRollupLongestTenureJobNameNormalized(migrate(payload));
    const second = extractJobRollupLongestTenureJobNameNormalized(migrate(payload));
    expect(first).toEqual(second);
  });
});
