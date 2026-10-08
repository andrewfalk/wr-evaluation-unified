// 통계 extractor의 "신체부담평가 미포함"(shared.jobs[].excludeFromAnalysis) 처리 — 신체부담 변수만 제외한다.
//  · job grain 변수: 미포함 직력의 엔터티(행)는 유지하고 값만 not_applicable로 반환한다(관측 생략 금지).
//  · case 집계: 포함 직력만 합산·검증한다. 전부 미포함이면 not_applicable(미입력 not_entered와 구분).
//  · 직업력 정보 변수(job.identity.*)는 미포함 직력도 그대로 집계한다.
import { describe, it, expect } from 'vitest';
import { deterministicMigrate } from '../migration/deterministicMigrate';
import {
  extractKneeRelatednessMax,
  extractKneeJobWeight,
  extractKneeJobStairs,
  extractKneeCaseSumDailyLoadKg,
  extractKneeCaseSumSquattingMinutesPerDay,
} from '../modules/knee/extractors';
import {
  extractShoulderExposureAnyExceeded,
  extractShoulderJobOverheadHours,
  extractShoulderCaseSumOverheadHours,
} from '../modules/shoulder/extractors';
import { extractCervicalCaseMaxJobCumulativeKgHours, extractCervicalCaseTotalNonNeutralHoursPerDay } from '../modules/cervical/extractors';
import { extractElbowBurdenGradeMax } from '../modules/elbow/extractors';
import { extractWristBurdenGradeMax } from '../modules/wrist/extractors';
import { extractSpineMddmLifetimeDoseMNh, extractSpineVibrationDvMax } from '../modules/spine/extractors';
import { extractJobIdentityTenureYears } from '../modules/job/extractors';

const FALLBACK = '2024-01-01T00:00:00.000Z';
const migrate = (payload: unknown) => deterministicMigrate(payload, { caseId: 'case-1', createdAtFallbackIso: FALLBACK });

const dates = { startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 250 };
const job = (id: string, flag?: boolean) => ({ id, jobName: id, ...dates, ...(flag === undefined ? {} : { excludeFromAnalysis: flag }) });
const NA = { value: null, missing: 'not_applicable', qualityFlags: [] };

function payload(modules: Record<string, unknown>, jobs: unknown[], extraShared: Record<string, unknown> = {}) {
  return {
    data: {
      shared: { birthDate: '1970-01-01', injuryDate: '2020-01-01', gender: 'male', diagnoses: [], jobs, ...extraShared },
      modules,
      activeModules: Object.keys(modules),
    },
  };
}

// ── knee ───────────────────────────────────────────────────────────────────
describe('knee extractors', () => {
  const extras = [
    { sharedJobId: 'a', weight: '5000', squatting: '200', stairs: true },
    { sharedJobId: 'b', weight: '10', squatting: '5', stairs: false },
  ];
  const knee = { jobExtras: extras };

  it('relatedness.max: 미포함 직력을 뺀 값은 그 직력이 처음부터 없는 환자와 같다', () => {
    const withExcluded = extractKneeRelatednessMax(migrate(payload({ knee }, [job('a'), job('b', true)])));
    const withoutJob = extractKneeRelatednessMax(migrate(payload({ knee: { jobExtras: [extras[0]] } }, [job('a')])));
    expect(withExcluded.missing).toBeNull();
    expect(withExcluded.value).toBeCloseTo(withoutJob.value as number, 10);
    const included = extractKneeRelatednessMax(migrate(payload({ knee }, [job('a'), job('b')])));
    expect(included.value).not.toBeCloseTo(withExcluded.value as number, 6);
  });

  it('relatedness.max: 전부 미포함이면 날짜 입력 상태와 무관하게 not_applicable', () => {
    expect(extractKneeRelatednessMax(migrate(payload({ knee }, [job('a', true), job('b', true)])))).toEqual(NA);
    expect(extractKneeRelatednessMax(migrate(payload({ knee }, [job('a', true)], { birthDate: '', injuryDate: '' })))).toEqual(NA);
  });

  it('job grain 변수: 엔터티 수는 그대로이고 미포함 직력만 not_applicable', () => {
    const obs = extractKneeJobWeight(migrate(payload({ knee }, [job('a'), job('b', true)])));
    expect(obs).toHaveLength(2);
    expect(obs[0]).toMatchObject({ entityKey: ['a'], value: 5000, missing: null });
    expect(obs[1]).toMatchObject({ entityKey: ['b'], value: null, missing: 'not_applicable' });
    const stairs = extractKneeJobStairs(migrate(payload({ knee }, [job('a'), job('b', true)])));
    expect(stairs.map((o) => o.missing)).toEqual([null, 'not_applicable']);
  });

  it('job grain 변수: 모듈이 비활성이면 미포함과 무관하게 structural_missing이 우선', () => {
    const obs = extractKneeJobWeight(migrate({ data: { shared: { jobs: [job('a', true)] }, modules: {}, activeModules: [] } }));
    expect(obs.map((o) => o.missing)).toEqual(['structural_missing']);
  });

  it('case 합계: 포함 직력만 합산하고 전부 미포함이면 not_applicable', () => {
    expect(extractKneeCaseSumDailyLoadKg(migrate(payload({ knee }, [job('a'), job('b', true)])))).toMatchObject({ value: 5000, missing: null });
    expect(extractKneeCaseSumDailyLoadKg(migrate(payload({ knee }, [job('a'), job('b')])))).toMatchObject({ value: 5010 });
    expect(extractKneeCaseSumSquattingMinutesPerDay(migrate(payload({ knee }, [job('a', true), job('b', true)])))).toEqual(NA);
  });

  it('case 합계: 미포함 직력의 손상값은 포함 직력의 합계를 invalid로 만들지 않는다', () => {
    const bad = { jobExtras: [extras[0], { sharedJobId: 'b', weight: 'abc' }] };
    expect(extractKneeCaseSumDailyLoadKg(migrate(payload({ knee: bad }, [job('a'), job('b', true)])))).toMatchObject({ value: 5000, qualityFlags: [] });
    expect(extractKneeCaseSumDailyLoadKg(migrate(payload({ knee: bad }, [job('a'), job('b')])))).toMatchObject({ value: null, qualityFlags: ['invalid'] });
  });
});

// ── shoulder ────────────────────────────────────────────────────────────────
describe('shoulder extractors', () => {
  const shoulder = (a: Record<string, unknown>, b: Record<string, unknown>) => ({
    jobExtras: [{ sharedJobId: 'a', ...a }, { sharedJobId: 'b', ...b }],
  });

  it('anyExceeded: 기준을 초과하는 노출이 미포함 직력에만 있으면 초과로 보지 않는다', () => {
    const mod = shoulder({ overheadHours: '1' }, { overheadHours: '8' });
    expect(extractShoulderExposureAnyExceeded(migrate(payload({ shoulder: mod }, [job('a'), job('b')]))).value).toBe(true);
    expect(extractShoulderExposureAnyExceeded(migrate(payload({ shoulder: mod }, [job('a'), job('b', true)]))).value).toBe(false);
  });

  it('anyExceeded: 미포함 직력의 손상값은 invalid 플래그를 만들지 않는다', () => {
    const mod = shoulder({ overheadHours: '1' }, { overheadHours: 'abc' });
    expect(extractShoulderExposureAnyExceeded(migrate(payload({ shoulder: mod }, [job('a'), job('b')]))).qualityFlags).toContain('invalid');
    expect(extractShoulderExposureAnyExceeded(migrate(payload({ shoulder: mod }, [job('a'), job('b', true)]))).qualityFlags).toEqual([]);
  });

  it('anyExceeded: 전부 미포함이면 not_applicable', () => {
    const mod = shoulder({ overheadHours: '8' }, { overheadHours: '8' });
    expect(extractShoulderExposureAnyExceeded(migrate(payload({ shoulder: mod }, [job('a', true), job('b', true)])))).toEqual(NA);
  });

  it('job grain: 엔터티 유지 + 미포함 직력 not_applicable / case 합계: 포함 직력만', () => {
    const mod = shoulder({ overheadHours: '2' }, { overheadHours: '3' });
    const obs = extractShoulderJobOverheadHours(migrate(payload({ shoulder: mod }, [job('a'), job('b', true)])));
    expect(obs.map((o) => [o.value, o.missing])).toEqual([[2, null], [null, 'not_applicable']]);
    expect(extractShoulderCaseSumOverheadHours(migrate(payload({ shoulder: mod }, [job('a'), job('b', true)])))).toMatchObject({ value: 2 });
    expect(extractShoulderCaseSumOverheadHours(migrate(payload({ shoulder: mod }, [job('a', true), job('b', true)])))).toEqual(NA);
  });
});

// ── cervical ────────────────────────────────────────────────────────────────
describe('cervical extractors', () => {
  const heavy = (extra: Record<string, unknown> = {}) => ({
    name: '박스 운반', exposure_types: ['shoulder_heavy_load'], load_weight_kg: '45', carry_hours_per_shift: '2', forced_neck_posture: 'yes', ...extra,
  });
  const neck = (extra: Record<string, unknown> = {}) => ({
    name: '모니터', exposure_types: ['awkward_static_neck_load'], neck_nonneutral_hours_per_day: '3', ...extra,
  });

  it('첫 직력이 미포함이면 sharedJobId 없는 task는 다음 직력으로 재귀속되지 않고 제외된다', () => {
    const tasks = [neck({ name: '귀속 없음', neck_nonneutral_hours_per_day: '5' }), neck({ sharedJobId: 'b', neck_nonneutral_hours_per_day: '3' })];
    const r = extractCervicalCaseTotalNonNeutralHoursPerDay(migrate(payload({ cervical: { tasks } }, [job('a', true), job('b')])));
    expect(r).toMatchObject({ value: 3, missing: null });
    const included = extractCervicalCaseTotalNonNeutralHoursPerDay(migrate(payload({ cervical: { tasks } }, [job('a'), job('b')])));
    expect(included).toMatchObject({ value: 8 });
  });

  it('미포함 직력 task의 손상된 exposure_types는 포함 직력의 통계를 invalid로 만들지 않는다', () => {
    const tasks = [neck({ sharedJobId: 'a', exposure_types: ['unknown_type'] }), neck({ sharedJobId: 'b' })];
    expect(extractCervicalCaseTotalNonNeutralHoursPerDay(migrate(payload({ cervical: { tasks } }, [job('a', true), job('b')])))).toMatchObject({ value: 3, missing: null });
    expect(extractCervicalCaseTotalNonNeutralHoursPerDay(migrate(payload({ cervical: { tasks } }, [job('a'), job('b')])))).toMatchObject({ missing: 'not_entered', qualityFlags: ['invalid'] });
  });

  it('누적 총부하량: 미포함 직력의 부하는 합산되지 않는다', () => {
    const tasks = [heavy({ sharedJobId: 'a' }), heavy({ sharedJobId: 'b', load_weight_kg: '50' })];
    const both = extractCervicalCaseMaxJobCumulativeKgHours(migrate(payload({ cervical: { tasks } }, [job('a'), job('b')])));
    const onlyB = extractCervicalCaseMaxJobCumulativeKgHours(migrate(payload({ cervical: { tasks } }, [job('a', true), job('b')])));
    expect(both.missing).toBeNull();
    expect(onlyB.missing).toBeNull();
    expect(onlyB.value as number).toBeLessThan(both.value as number);
    expect(onlyB.value as number).toBeGreaterThan(0);
  });

  it('전부 미포함이면 not_applicable (직력 정보 없음 not_entered와 구분)', () => {
    const tasks = [neck({ sharedJobId: 'a' })];
    expect(extractCervicalCaseTotalNonNeutralHoursPerDay(migrate(payload({ cervical: { tasks } }, [job('a', true)])))).toEqual(NA);
    expect(extractCervicalCaseMaxJobCumulativeKgHours(migrate(payload({ cervical: { tasks } }, [job('a', true)])))).toEqual(NA);
    expect(extractCervicalCaseTotalNonNeutralHoursPerDay(migrate(payload({ cervical: { tasks } }, [])))).toMatchObject({ missing: 'not_entered' });
  });
});

// ── elbow / wrist ───────────────────────────────────────────────────────────
describe.each([
  ['elbow', extractElbowBurdenGradeMax],
  ['wrist', extractWristBurdenGradeMax],
] as const)('%s burdenGradeMax', (moduleId, extract) => {
  it('전부 미포함이면 not_applicable, 모듈 비활성이면 structural_missing이 우선', () => {
    expect(extract(migrate(payload({ [moduleId]: {} }, [job('a', true), job('b', true)])))).toEqual(NA);
    expect(extract(migrate({ data: { shared: { jobs: [job('a', true)] }, modules: {}, activeModules: [] } })).missing).toBe('structural_missing');
  });
});

// ── spine ───────────────────────────────────────────────────────────────────
describe('spine extractors', () => {
  const task = (extra: Record<string, unknown> = {}) => ({ posture: 'G3', weight: 30, frequency: 80, timeValue: 5, timeUnit: 'sec', correctionFactor: 1.0, ...extra });

  it('MDDM: 전부 미포함이면 노출 상태가 unknown이어도 not_assessed가 아니라 not_applicable', () => {
    expect(extractSpineMddmLifetimeDoseMNh(migrate(payload({ spine: {} }, [job('a', true)])))).toEqual(NA);
    // 대조군: 미포함이 없으면 기존대로 not_assessed
    expect(extractSpineMddmLifetimeDoseMNh(migrate(payload({ spine: {} }, [job('a')])))).toEqual({ value: null, missing: 'not_assessed', qualityFlags: [] });
  });

  it('MDDM: 미포함 직력 task의 손상값이 포함 직력의 통계에 invalid로 남지 않는다', () => {
    const tasks = [task({ sharedJobId: 'a', name: '정상' }), task({ sharedJobId: 'b', name: '손상', weight: 'abc' })];
    const spine = { mddmStatus: 'present', tasks };
    const excluded = extractSpineMddmLifetimeDoseMNh(migrate(payload({ spine }, [job('a'), job('b', true)])));
    const included = extractSpineMddmLifetimeDoseMNh(migrate(payload({ spine }, [job('a'), job('b')])));
    expect(excluded.qualityFlags).not.toContain('invalid');
    expect(included.qualityFlags).toContain('invalid');
  });

  it('MDDM: 포함 직력은 있지만 task가 없으면 직력 기반 분기를 유지한다 (not_entered)', () => {
    const spine = { mddmStatus: 'present', tasks: [task({ sharedJobId: 'b' })] };
    const r = extractSpineMddmLifetimeDoseMNh(migrate(payload({ spine }, [job('a'), job('b', true)])));
    expect(r.missing).not.toBeNull();
    expect(r.value).toBeNull();
  });

  it('진동: 전부 미포함이면 not_applicable, 미포함 직력의 잘못된 구간은 invalid를 만들지 않는다', () => {
    const goodIv = { sharedJobId: 'a', awMin: 0.9, awMax: 1.2, timeValue: 6, timeUnit: 'hr' };
    const badIv = { sharedJobId: 'b', awMin: 3, awMax: 1, timeValue: 4, timeUnit: 'hr' };
    const spine = { vibrationExposureStatus: 'present', vibrationIntervals: [goodIv, badIv] };
    expect(extractSpineVibrationDvMax(migrate(payload({ spine }, [job('a', true), job('b', true)])))).toEqual(NA);
    const part = extractSpineVibrationDvMax(migrate(payload({ spine }, [job('a'), job('b', true)])));
    expect(part.missing).toBeNull();
    expect(part.qualityFlags).not.toContain('invalid');
    const all = extractSpineVibrationDvMax(migrate(payload({ spine }, [job('a'), job('b')])));
    expect(all.qualityFlags).toContain('invalid');
  });
});

// ── job.identity.*는 미포함 직력도 그대로 집계 ───────────────────────────────
describe('직업력 정보 변수는 미포함 직력도 포함한다', () => {
  it('job.identity.tenureYears: 미포함 직력의 근속도 값이 나온다', () => {
    const obs = extractJobIdentityTenureYears(migrate(payload({ knee: {} }, [job('a'), job('b', true)])));
    expect(obs).toHaveLength(2);
    expect(obs.every((o) => o.missing === null && (o.value as number) > 9)).toBe(true);
  });
});
