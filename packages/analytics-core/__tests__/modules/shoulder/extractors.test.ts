import { describe, it, expect } from 'vitest';
import { extractShoulderExposureAnyExceeded, extractShoulderDiagnosisSideEllmanClass } from '../../../modules/shoulder/extractors';
import { deterministicMigrate } from '../../../migration/deterministicMigrate';

const FALLBACK = '2024-01-01T00:00:00.000Z';

function migrate(payload: unknown, caseId = 'case-1') {
  return deterministicMigrate(payload, { caseId, createdAtFallbackIso: FALLBACK });
}

function baseCase(overrides: {
  jobs?: unknown[];
  jobExtras?: unknown[];
  activeModules?: string[];
  includeShoulderModule?: boolean;
}) {
  const {
    jobs = [{ id: 'job-1', startDate: '2015-01-01', endDate: '2020-01-01' }],
    jobExtras = [],
    activeModules = ['shoulder'],
    includeShoulderModule = true,
  } = overrides;
  return {
    data: {
      shared: { jobs },
      modules: includeShoulderModule ? { shoulder: { jobExtras } } : {},
      activeModules,
    },
  };
}

describe('extractShoulderExposureAnyExceeded — 우선순위 사슬(§1-1a)', () => {
  it('순서 1: 모듈이 activeModules에 없으면 structural_missing', () => {
    const result = extractShoulderExposureAnyExceeded(
      migrate(baseCase({ activeModules: [] })),
    );
    expect(result).toEqual({ value: null, missing: 'structural_missing', qualityFlags: [] });
  });

  it('순서 1: activeModules엔 있는데 data.modules.shoulder가 plain object가 아니면 structural_missing', () => {
    const result = extractShoulderExposureAnyExceeded(
      migrate(baseCase({ includeShoulderModule: false })),
    );
    expect(result).toEqual({ value: null, missing: 'structural_missing', qualityFlags: [] });
  });

  it('순서 2: shared.jobs가 비어있으면 not_entered', () => {
    const result = extractShoulderExposureAnyExceeded(migrate(baseCase({ jobs: [] })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 3: 원본 문자열이 비어있지 않은데 파싱 실패면 invalid qualityFlag(값은 그대로 0으로 계산)', () => {
    const result = extractShoulderExposureAnyExceeded(
      migrate(
        baseCase({
          jobExtras: [{ sharedJobId: 'job-1', overheadHours: 'abc' }],
        }),
      ),
    );
    expect(result.missing).toBeNull();
    expect(result.value).toBe(false); // 'abc' -> parseFloat NaN -> ||0 -> 한도 미달
    expect(result.qualityFlags).toEqual(['invalid']);
  });

  it('순서 3: 빈 문자열은 invalid로 잡지 않는다(그냥 0)', () => {
    const result = extractShoulderExposureAnyExceeded(
      migrate(baseCase({ jobExtras: [{ sharedJobId: 'job-1', overheadHours: '' }] })),
    );
    expect(result.qualityFlags).toEqual([]);
  });

  it('순서 4: 정상 입력 — 한도를 넘으면 value: true', () => {
    // overhead 한도 3600시간, 5년 * 250일 * 3시간/일 = 3750시간 > 3600.
    const result = extractShoulderExposureAnyExceeded(
      migrate(
        baseCase({
          jobs: [{ id: 'job-1', startDate: '2015-01-01', endDate: '2020-01-01', workDaysPerYear: 250 }],
          jobExtras: [{ sharedJobId: 'job-1', overheadHours: '3' }],
        }),
      ),
    );
    expect(result).toEqual({ value: true, missing: null, qualityFlags: [] });
  });

  it('순서 4: 정상 입력 — 한도 미달이면 value: false', () => {
    const result = extractShoulderExposureAnyExceeded(
      migrate(
        baseCase({
          jobs: [{ id: 'job-1', startDate: '2019-06-01', endDate: '2020-01-01' }],
          jobExtras: [{ sharedJobId: 'job-1', overheadHours: '0.1' }],
        }),
      ),
    );
    expect(result).toEqual({ value: false, missing: null, qualityFlags: [] });
  });

  it('순서 3.5: 매칭된 직력에 노출값 6종이 전부 비어있으면 not_entered(미평가를 미초과로 오집계 금지)', () => {
    const result = extractShoulderExposureAnyExceeded(
      migrate(baseCase({ jobExtras: [{ sharedJobId: 'job-1' }] })),
    );
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 3.5: jobExtras 자체가 빈 배열이어도(매칭 없음) not_entered', () => {
    const result = extractShoulderExposureAnyExceeded(migrate(baseCase({ jobExtras: [] })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 3.5: 명시적 "0"은 정상 입력으로 취급 — 다른 필드가 전부 비어있어도 계산으로 진행', () => {
    const result = extractShoulderExposureAnyExceeded(
      migrate(baseCase({ jobExtras: [{ sharedJobId: 'job-1', overheadHours: '0' }] })),
    );
    expect(result).toEqual({ value: false, missing: null, qualityFlags: [] });
  });

  it('배열 원소 방어: shared.jobs에 null이 섞여 있어도 예외를 던지지 않는다', () => {
    expect(() =>
      extractShoulderExposureAnyExceeded(
        migrate(
          baseCase({
            jobs: [null, { id: 'job-1', startDate: '2015-01-01', endDate: '2020-01-01' }] as unknown[],
            jobExtras: [{ sharedJobId: 'job-1', overheadHours: '3' }],
          }),
        ),
      ),
    ).not.toThrow();
  });

  it('순서 3: 노출은 입력됐는데 workDaysPerYear가 비숫자 문자열이면 invalid qualityFlag(값은 NaN→0으로 계산되어 미초과)', () => {
    // 10년 * 8시간/일 — workDaysPerYear가 정상(250)이면 10*250*8=20000h > 3600h(초과)여야
    // 하지만 'abc'는 원본(§리뷰 지적)처럼 산술에서 NaN이 되어 누적 0h로 조용히 계산된다.
    const result = extractShoulderExposureAnyExceeded(
      migrate(
        baseCase({
          jobs: [{ id: 'job-1', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 'abc' }],
          jobExtras: [{ sharedJobId: 'job-1', overheadHours: '8' }],
        }),
      ),
    );
    expect(result).toEqual({ value: false, missing: null, qualityFlags: ['invalid'] });
  });

  it('순서 3: startDate가 파싱 불가능한 문자열이면(NaN 기간) invalid qualityFlag — <=0 비교로는 NaN을 못 잡는다', () => {
    // new Date('abc')는 Invalid Date(NaN) → calculateWorkPeriod가 NaN을 반환한다.
    // NaN <= 0은 항상 false라서 이 케이스를 놓쳤었다(리뷰 지적) — periodYears > 0 부정으로 수정.
    const result = extractShoulderExposureAnyExceeded(
      migrate(
        baseCase({
          jobs: [{ id: 'job-1', startDate: 'abc', endDate: '2020-01-01' }],
          jobExtras: [{ sharedJobId: 'job-1', overheadHours: '8' }],
        }),
      ),
    );
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual(['invalid']);
  });

  it('순서 3: workDaysPerYear="250days"는 parseFloat로는 250(유효)처럼 보이지만 실제 산술(Number())에서 NaN이라 invalid', () => {
    // parseFloat('250days')는 250을 반환해 파싱에 성공한 것처럼 보이지만, 실제 계산기는
    // parseFloat이 아니라 `workDaysPerYear || 250`을 그대로 곱셈에 넣는다 — 곱셈의 ToNumber
    // 변환(Number('250days'))은 NaN이라 실제로는 계산이 깨진다(리뷰 지적).
    const result = extractShoulderExposureAnyExceeded(
      migrate(
        baseCase({
          jobs: [{ id: 'job-1', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: '250days' }],
          jobExtras: [{ sharedJobId: 'job-1', overheadHours: '8' }],
        }),
      ),
    );
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual(['invalid']);
  });

  it('순서 3: 노출은 입력됐는데 근무기간(startDate/endDate/workPeriodOverride)이 전부 없으면 invalid qualityFlag', () => {
    const result = extractShoulderExposureAnyExceeded(
      migrate(
        baseCase({
          jobs: [{ id: 'job-1' }], // startDate/endDate/workPeriodOverride 전부 없음
          jobExtras: [{ sharedJobId: 'job-1', overheadHours: '8' }],
        }),
      ),
    );
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual(['invalid']);
  });

  it('순서 3: 근무기간이 없어도 노출값 자체가 미입력이면(3.5 우선) invalid 플래그 없이 not_entered', () => {
    const result = extractShoulderExposureAnyExceeded(
      migrate(baseCase({ jobs: [{ id: 'job-1' }], jobExtras: [{ sharedJobId: 'job-1' }] })),
    );
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('배열 원소 방어: shoulder.jobExtras에 null이 섞여 있어도 예외를 던지지 않는다', () => {
    expect(() =>
      extractShoulderExposureAnyExceeded(
        migrate(
          baseCase({
            jobExtras: [null, { sharedJobId: 'job-1', overheadHours: '3' }] as unknown[],
          }),
        ),
      ),
    ).not.toThrow();
  });
});

// PR0-B3 Part B — diagnosis_side grain. knee.diagnosisSide.klGrade와 완전히 동일한 패턴
// (packages/analytics-core/__tests__/modules/knee/extractors.test.ts 참고).
function diagnosesMigration(diagnoses: unknown[]) {
  return migrate({ data: { shared: { diagnoses }, modules: {}, activeModules: [] } });
}

describe('extractShoulderDiagnosisSideEllmanClass — diagnosis_side grain', () => {
  it('어깨 진단이 아니면 not_applicable', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right' };
    const result = extractShoulderDiagnosisSideEllmanClass(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('어깨 진단이지만 회전근개 파열이 아니면(supportsEllmanClass=false) not_applicable', () => {
    const dx = { id: 'dx-1', code: 'M75', name: '어깨 충돌증후군', side: 'right' }; // shoulder지만 회전근개 아님
    const result = extractShoulderDiagnosisSideEllmanClass(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('side가 unspecified면 not_entered', () => {
    const dx = { id: 'dx-1', code: 'M751', name: '회전근개 증후군', side: '', ellmanRight: 'Grade 2' };
    const result = extractShoulderDiagnosisSideEllmanClass(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  it('ellmanRight/Left가 공백이면 not_entered', () => {
    const dx = { id: 'dx-1', code: 'M751', name: '회전근개 증후군', side: 'right' };
    const result = extractShoulderDiagnosisSideEllmanClass(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  it('"N/A"는 등급이 아니라 not_applicable', () => {
    const dx = { id: 'dx-1', code: 'M751', name: '회전근개 증후군', side: 'right', ellmanRight: 'N/A' };
    const result = extractShoulderDiagnosisSideEllmanClass(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('정상 입력 — side==="both"면 ellmanRight/Left를 각각 읽어 두 행으로 반환한다', () => {
    const dx = { id: 'dx-1', code: 'M751', name: '회전근개 증후군', side: 'both', ellmanRight: 'Grade 2', ellmanLeft: 'Full' };
    const result = extractShoulderDiagnosisSideEllmanClass(diagnosesMigration([dx]));
    expect(result).toEqual([
      { entityKey: ['dx-1', 'right'], value: 'Grade 2', missing: null, qualityFlags: [] },
      { entityKey: ['dx-1', 'left'], value: 'Full', missing: null, qualityFlags: [] },
    ]);
  });

  // 3차 리뷰 P1 — knee.diagnosisSide.klGrade와 동일한 결함 재현. ELLMAN_OPTIONS가 실제로
  // 제공하는 값(''·'N/A'·SHOULDER_ELLMAN_ORDER)이 아니면 not_entered + invalid여야 한다.
  it.each([
    ['파싱 불가 문자열', 'bad'],
    ['boolean', true],
  ])('ellmanRight가 %s(%j)이면 not_entered + invalid — 정상 등급으로 새지 않는다', (_label, ellmanRight) => {
    const dx = { id: 'dx-1', code: 'M751', name: '회전근개 증후군', side: 'right', ellmanRight };
    const result = extractShoulderDiagnosisSideEllmanClass(diagnosesMigration([dx]));
    expect(result).toEqual([{ entityKey: ['dx-1', 'right'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });
});
