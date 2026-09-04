import { describe, it, expect } from 'vitest';
import { extractShoulderExposureAnyExceeded } from '../../../modules/shoulder/extractors';
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
});
