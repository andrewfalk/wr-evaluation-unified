import { describe, it, expect } from 'vitest';
import { deterministicMigrate } from '../../migration/deterministicMigrate';
import { stableStringify } from '../../common';

const FALLBACK = '2024-01-01T00:00:00.000Z';
const OPTS = { caseId: 'case-1', createdAtFallbackIso: FALLBACK };

describe('deterministicMigrate — 입력 계약 위반은 throw', () => {
  it('caseId가 없으면 throw', () => {
    expect(() => deterministicMigrate({}, { caseId: '', createdAtFallbackIso: FALLBACK })).toThrow(/caseId/);
  });

  it('createdAtFallbackIso가 RFC3339 형식이 아니면 throw', () => {
    expect(() => deterministicMigrate({}, { caseId: 'x', createdAtFallbackIso: '2024-01-01' })).toThrow(
      /createdAtFallbackIso/,
    );
    expect(() =>
      deterministicMigrate({}, { caseId: 'x', createdAtFallbackIso: '2026-99-99T99:99:99+99:99' }),
    ).toThrow(/createdAtFallbackIso/);
  });
});

describe('createdAt 우선순위 3단계', () => {
  it('patient.createdAt이 있으면 그대로 쓴다', () => {
    const { payload } = deterministicMigrate({ createdAt: '2019-01-01T00:00:00.000Z', data: {} }, OPTS);
    expect(payload.createdAt).toBe('2019-01-01T00:00:00.000Z');
  });

  it('createdAt이 없으면 shared.evaluationDate를 쓴다', () => {
    const { payload } = deterministicMigrate(
      { data: { shared: { evaluationDate: '2018-05-05' } } },
      OPTS,
    );
    expect(payload.createdAt).toBe('2018-05-05');
  });

  it('createdAt도 evaluationDate도 없으면 폴백을 쓴다(Date.now() 없이)', () => {
    const { payload } = deterministicMigrate({ data: {} }, OPTS);
    expect(payload.createdAt).toBe(FALLBACK);
  });
});

describe('형태 판별 3-way(구형식 moduleId+data.module 정규화 복원)', () => {
  it('구형식 patient.moduleId + data.module을 modules/activeModules로 정규화한다', () => {
    const { payload } = deterministicMigrate(
      { moduleId: 'knee', data: { shared: { birthDate: '1980-01-01' }, module: { jobExtras: [] } } },
      OPTS,
    );
    expect(payload.data.activeModules).toEqual(['knee']);
    expect(payload.data.modules.knee).toEqual({ jobExtras: [] });
  });

  it('신형식(modules+activeModules)은 그대로 통과한다', () => {
    const { payload } = deterministicMigrate(
      { data: { shared: {}, modules: { knee: {} }, activeModules: ['knee'] } },
      OPTS,
    );
    expect(payload.data.activeModules).toEqual(['knee']);
  });
});

describe('shared.jobs 조기 반환 함정(빈 배열 포함) — 그대로 재현', () => {
  it('shared.jobs가 빈 배열이면 modules.knee.jobs(레거시)가 있어도 손대지 않는다', () => {
    const { payload } = deterministicMigrate(
      {
        data: {
          shared: { jobs: [] },
          modules: { knee: { jobs: [{ id: 'legacy-1', weight: '100' }] } },
          activeModules: ['knee'],
        },
      },
      OPTS,
    );
    expect(payload.data.shared.jobs).toEqual([]);
    expect(payload.data.modules.knee!.jobs).toEqual([{ id: 'legacy-1', weight: '100' }]); // 그대로 남음
    expect(payload.data.modules.knee!.jobExtras).toBeUndefined(); // 백필 안 됨
  });
});

describe('레거시 modules.knee.jobs 백필', () => {
  it('shared.jobs가 없으면 modules.knee.jobs를 shared.jobs+jobExtras로 백필한다', () => {
    const { payload } = deterministicMigrate(
      {
        data: {
          shared: {},
          modules: { knee: { jobs: [{ jobName: 'A', weight: '3000', squatting: '120' }] } },
          activeModules: ['knee'],
        },
      },
      OPTS,
    );
    expect(payload.data.shared.jobs).toHaveLength(1);
    expect(payload.data.shared.jobs![0].jobName).toBe('A');
    expect(payload.data.modules.knee!.jobExtras).toEqual([
      expect.objectContaining({ sharedJobId: payload.data.shared.jobs![0].id, weight: '3000', squatting: '120' }),
    ]);
    expect(payload.data.modules.knee!.jobs).toBeUndefined(); // 옛 필드는 제거됨
  });

  it('기존 kneeJob.id가 있으면(비-UUID 레거시 값이어도) 그대로 보존한다', () => {
    const { payload } = deterministicMigrate(
      {
        data: {
          shared: {},
          modules: { knee: { jobs: [{ id: 'legacy-non-uuid-id', weight: '100', squatting: '50' }] } },
          activeModules: ['knee'],
        },
      },
      OPTS,
    );
    expect(payload.data.shared.jobs![0].id).toBe('legacy-non-uuid-id');
    expect(payload.data.modules.knee!.jobExtras![0].sharedJobId).toBe('legacy-non-uuid-id');
  });

  it('id가 없는 레거시 job은 결정적 UUID를 합성한다', () => {
    const { payload } = deterministicMigrate(
      { data: { shared: {}, modules: { knee: { jobs: [{ weight: '100', squatting: '50' }] } }, activeModules: ['knee'] } },
      OPTS,
    );
    expect(payload.data.shared.jobs![0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('shared.jobs가 없고 legacy knee.jobs도 없으면 빈 필드 job 1개를 보장한다', () => {
    const { payload } = deterministicMigrate(
      { data: { shared: {}, modules: {}, activeModules: [] } },
      OPTS,
    );
    expect(payload.data.shared.jobs).toHaveLength(1);
    expect(payload.data.shared.jobs![0].jobName).toBe('');
  });
});

describe('modules.spine 레거시 감지 — unsupported_legacy_spine_jobs issue', () => {
  it('spine 레거시 직업 필드가 있으면 issue만 남기고 spine job 주입은 구현하지 않는다', () => {
    const { issues } = deterministicMigrate(
      {
        data: {
          shared: {},
          modules: { spine: { jobName: '용접공', careerYears: 5 } },
          activeModules: ['spine'],
        },
      },
      OPTS,
    );
    expect(issues).toEqual([{ code: 'unsupported_legacy_spine_jobs' }]);
  });

  it('spine 모듈이 있어도 레거시 직업 필드가 없으면 issue가 없다', () => {
    const { issues } = deterministicMigrate(
      { data: { shared: {}, modules: { spine: { someOtherField: 1 } }, activeModules: ['spine'] } },
      OPTS,
    );
    expect(issues).toEqual([]);
  });
});

describe('결정성 · 멱등성 · 비변이', () => {
  const fixture = {
    createdAt: '2020-01-01T00:00:00.000Z',
    data: {
      shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [] },
      modules: { knee: { jobExtras: [{ sharedJobId: 'x', weight: '100' }] } },
      activeModules: ['knee'],
    },
  };

  it('결정성: 구조적으로 동일한 별개 객체 2회 실행 → byte-identical', () => {
    const clone1 = JSON.parse(JSON.stringify(fixture));
    const clone2 = JSON.parse(JSON.stringify(fixture));
    const a = deterministicMigrate(clone1, OPTS);
    const b = deterministicMigrate(clone2, OPTS);
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('멱등성: migrate(migrate(x).payload) === migrate(x)', () => {
    const first = deterministicMigrate(JSON.parse(JSON.stringify(fixture)), OPTS);
    const second = deterministicMigrate(JSON.parse(JSON.stringify(first.payload)), OPTS);
    expect(stableStringify(second)).toBe(stableStringify(first));
  });

  it('비변이: 입력을 deep-freeze해도 예외 없이 실행되고 원본은 그대로 남는다', () => {
    function deepFreeze(obj: any) {
      Object.getOwnPropertyNames(obj).forEach((key) => {
        const value = obj[key];
        if (value && typeof value === 'object') deepFreeze(value);
      });
      return Object.freeze(obj);
    }
    const frozen = deepFreeze(JSON.parse(JSON.stringify(fixture)));
    const before = JSON.stringify(frozen);
    expect(() => deterministicMigrate(frozen, OPTS)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(before); // 입력이 변경되지 않았음
  });
});

describe('unsupported_legacy_spine_jobs가 extractor까지 정확한 타입으로 전달된다', () => {
  it('issues 배열의 shape이 { code, detail? }다', () => {
    const { issues } = deterministicMigrate(
      { data: { shared: {}, modules: { spine: { jobName: 'x' } }, activeModules: ['spine'] } },
      OPTS,
    );
    expect(issues[0]).toHaveProperty('code', 'unsupported_legacy_spine_jobs');
  });
});
