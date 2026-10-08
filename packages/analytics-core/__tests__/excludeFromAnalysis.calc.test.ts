// 직력별 "신체부담평가 미포함"(shared.jobs[].excludeFromAnalysis)이 6개 모듈 계산·완료 판정·
// 입력 경계 정규화에 미치는 영향. 핵심 불변식:
//  · 미포함 직력은 계산 결과·합산·완료 판정에서만 빠지고, 모듈 데이터(jobEvaluations/task/interval)는 지워지지 않는다.
//  · 귀속(sharedJobId 없는 항목 → 첫 직력)은 필터 전 전체 jobs 기준이다.
//  · 직력 0개 fallback·레거시 분기는 기존 동작 그대로.
import { describe, it, expect } from 'vitest';
import { computeKneeCalc } from '../modules/knee/derived';
import { computeShoulderCalc } from '../modules/shoulder/derived';
import { computeElbowCalc, isElbowAssessmentComplete } from '../modules/elbow/derived';
import { computeWristCalc, isWristAssessmentComplete } from '../modules/wrist/derived';
import { computeCervicalCalc, isCervicalAssessmentComplete } from '../modules/cervical/derived';
import { computeMddmCalc, isMddmComplete } from '../modules/spine/mddm';
import { computeVibrationCalc, isVibrationComplete } from '../modules/spine/vibration';
import { computeSpineCalc, isSpineAssessmentComplete } from '../modules/spine/derived';
import { normalizeElbowModuleData } from '../modules/elbow/legacyNormalize';
import { normalizeCervicalModuleData } from '../modules/cervical/legacyNormalize';
import { verifyAllModulesComplete } from '../completion';
import { deterministicMigrate } from '../migration/deterministicMigrate';

const dates = { startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 250 };
const J1 = { id: 'job-1', jobName: '철근공', ...dates };
const J2 = { id: 'job-2', jobName: '용접공', ...dates };
const X = (job: Record<string, unknown>) => ({ ...job, excludeFromAnalysis: true });

// ── knee ────────────────────────────────────────────────────────────────────
describe('knee — computeKneeCalc', () => {
  const shared = (jobs: unknown[]) => ({ birthDate: '1970-01-01', injuryDate: '2020-01-01', jobs });
  const mod = { jobExtras: [{ sharedJobId: 'job-1', weight: '5000', squatting: '200' }, { sharedJobId: 'job-2', weight: '0', squatting: '0' }] };

  it('미포함 직력은 jobBurdens·업무관련성 합산에서 빠진다', () => {
    const all = computeKneeCalc({ shared: shared([J1, J2]), module: mod });
    const without = computeKneeCalc({ shared: shared([J1, X(J2)]), module: mod });
    expect(all.jobBurdens.map((j) => j.id)).toEqual(['job-1', 'job-2']);
    expect(without.jobBurdens.map((j) => j.id)).toEqual(['job-1']);
    expect(without.noEvaluableJobs).toBe(false);
  });

  it('미포함 직력의 jobExtras 입력값은 계산이 끝나도 module에 그대로 있다', () => {
    const m = { jobExtras: mod.jobExtras.map((e) => ({ ...e })) };
    computeKneeCalc({ shared: shared([J1, X(J2)]), module: m });
    expect(m.jobExtras).toEqual(mod.jobExtras);
  });

  it('전부 미포함이면 jobBurdens가 비고 noEvaluableJobs=true', () => {
    const r = computeKneeCalc({ shared: shared([X(J1), X(J2)]), module: mod });
    expect(r.jobBurdens).toEqual([]);
    expect(r.noEvaluableJobs).toBe(true);
  });

  it('플래그가 없는 구데이터는 변경 전과 같은 결과(회귀)', () => {
    const r = computeKneeCalc({ shared: shared([J1, J2]), module: mod });
    expect(r.jobBurdens).toHaveLength(2);
    expect(r.noEvaluableJobs).toBe(false);
  });

  it('레거시 module.jobs 분기는 필터하지 않는다 (직력 연결이 없음)', () => {
    const r = computeKneeCalc({ shared: shared([X(J1)]), module: { jobs: [{ id: 'old', weight: '100', squatting: '10' }] } });
    expect(r.jobBurdens.map((j) => j.id)).toEqual(['old']);
    expect(r.noEvaluableJobs).toBe(false);
  });
});

// ── shoulder ────────────────────────────────────────────────────────────────
describe('shoulder — computeShoulderCalc', () => {
  const extras = [
    { sharedJobId: 'job-1', overheadHours: '2' },
    { sharedJobId: 'job-2', overheadHours: '4' },
  ];
  it('미포함 직력의 누적 노출이 totals에서 빠진다', () => {
    const all = computeShoulderCalc({ shared: { jobs: [J1, J2] }, module: { jobExtras: extras } });
    const part = computeShoulderCalc({ shared: { jobs: [J1, X(J2)] }, module: { jobExtras: extras } });
    const total = (r: any) => r.totals.find((t: any) => t.key === 'overhead').totalHours;
    expect(total(part)).toBeLessThan(total(all));
    expect(part.jobBurdens.map((j) => j.id)).toEqual(['job-1']);
  });
  it('전부 미포함이면 totals가 0이고 noEvaluableJobs=true (소비처가 "불충분"을 만들면 안 됨)', () => {
    const r = computeShoulderCalc({ shared: { jobs: [X(J1), X(J2)] }, module: { jobExtras: extras } });
    expect(r.jobBurdens).toEqual([]);
    expect(r.totals.every((t) => t.totalHours === 0)).toBe(true);
    expect(r.noEvaluableJobs).toBe(true);
  });
});

// ── elbow / wrist ───────────────────────────────────────────────────────────
describe.each([
  ['elbow', 'M77.0', computeElbowCalc, isElbowAssessmentComplete],
  ['wrist', 'G56.0', computeWristCalc, isWristAssessmentComplete],
] as const)('%s — 직력 요약·완료 판정', (moduleId, code, compute, isComplete) => {
  const diag = (extra: Record<string, unknown> = {}) => ({
    id: 'dx-1', code, moduleId, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high', ...extra,
  });
  const evaluations = [
    { sharedJobId: 'job-1', diagnosisEntries: [{ diagnosisId: 'dx-1' }] },
    { sharedJobId: 'job-2', diagnosisEntries: [{ diagnosisId: 'dx-1' }] },
  ];
  const data = (jobs: unknown[], diagnoses = [diag()]) => ({
    shared: { jobs, diagnoses },
    module: { jobEvaluations: evaluations.map((e) => ({ ...e })) },
    activeModules: [moduleId],
  });

  it('미포함 직력의 요약은 jobSummaries에서 빠진다', () => {
    const r: any = compute(data([J1, X(J2)]) as any);
    expect(r.jobSummaries.map((s: any) => s.sharedJobId)).toEqual(['job-1']);
    expect(r.noEvaluableJobs).toBe(false);
  });

  it('전부 미포함이면 요약이 비고 noEvaluableJobs=true', () => {
    const r: any = compute(data([X(J1), X(J2)]) as any);
    expect(r.jobSummaries).toEqual([]);
    expect(r.noEvaluableJobs).toBe(true);
  });

  it('상병 평가 완료 + 공통 노출 항목 미입력 + 전부 미포함 → 완료', () => {
    const d: any = data([X(J1), X(J2)]);
    expect((compute(d) as any).missingCommonFields.length).toBeGreaterThan(0); // 공통 항목은 비어 있다
    expect(isComplete(d)).toBe(true);
  });

  it('상병 평가 미완료 + 전부 미포함 → 미완료', () => {
    const d: any = data([X(J1), X(J2)], [diag({ confirmedRight: '' })]);
    expect(isComplete(d)).toBe(false);
  });

  it('직력 0개는 전부 미포함과 달리 기존대로 미완료', () => {
    expect(isComplete(data([]) as any)).toBe(false);
  });

  it('일부 미포함 + 포함 직력의 공통 항목 미입력이면 여전히 미완료', () => {
    expect(isComplete(data([J1, X(J2)]) as any)).toBe(false);
  });
});

describe('elbow — 미포함 직력의 입력값이 sync/normalize로 삭제되지 않는다', () => {
  it('전체 jobs로 normalize하면 jobEvaluations가 두 직력 모두 남는다 (미포함이어도)', () => {
    const jobs = [J1, X(J2)];
    const module = {
      jobEvaluations: [
        { sharedJobId: 'job-1', diagnosisEntries: [{ diagnosisId: 'dx-1', daily_exposure_hours: '3' }] },
        { sharedJobId: 'job-2', diagnosisEntries: [{ diagnosisId: 'dx-1', daily_exposure_hours: '5' }] },
      ],
    };
    const dx = [{ id: 'dx-1', code: 'M77.0', moduleId: 'elbow', side: 'right' }];
    const out = normalizeElbowModuleData(module as any, jobs as any, dx as any, ['elbow']);
    expect(out.moduleData.jobEvaluations.map((e: any) => e.sharedJobId)).toEqual(['job-1', 'job-2']);
    const kept = out.moduleData.jobEvaluations[1].diagnosisEntries.find((e: any) => e.diagnosisId === 'dx-1');
    expect((kept as any).daily_exposure_hours).toBe('5');
  });
});

// ── cervical ────────────────────────────────────────────────────────────────
describe('cervical', () => {
  const tasks = [
    { name: '귀속 없음(→첫 직력)', exposure_types: [] },
    { sharedJobId: 'job-2', name: '용접 작업', exposure_types: [] },
  ];
  const diag = { id: 'dx-1', code: 'M50.1', moduleId: 'cervical', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' };

  it('첫 직력이 미포함이어도 sharedJobId 없는 task는 다음 직력으로 재귀속되지 않는다', () => {
    const r = computeCervicalCalc({ shared: { jobs: [X(J1), J2], diagnoses: [diag] }, module: { tasks: tasks.map((t) => ({ ...t })) }, activeModules: ['cervical'] });
    expect(r.jobSummaries.map((s) => s.sharedJobId)).toEqual(['job-2']);
    expect(r.jobSummaries[0].totalTaskCount).toBe(1); // job-2 자기 task 1개뿐 (첫 직력 task는 job-1에 남아 계산에서만 빠짐)
  });

  it('전체 jobs로 normalize하면 미포함 직력의 task도 모듈 데이터에 그대로 남는다', () => {
    const out = normalizeCervicalModuleData({ tasks: tasks.map((t) => ({ ...t })) } as any, [X(J1), J2] as any);
    expect(out.moduleData.tasks).toHaveLength(2);
    expect(out.moduleData.tasks![0].sharedJobId).toBe('job-1');
  });

  it('전부 미포함이면 요약이 비고 상병 평가 완료 시 완료, 직력 0개는 미완료', () => {
    const base = { module: { tasks: [] }, activeModules: ['cervical'] };
    const allX: any = { shared: { jobs: [X(J1), X(J2)], diagnoses: [diag] }, ...base };
    expect(computeCervicalCalc(allX).noEvaluableJobs).toBe(true);
    expect(computeCervicalCalc(allX).jobSummaries).toEqual([]);
    expect(isCervicalAssessmentComplete(allX)).toBe(true);
    expect(isCervicalAssessmentComplete({ shared: { jobs: [], diagnoses: [diag] }, ...base } as any)).toBe(false);
    expect(isCervicalAssessmentComplete({ shared: { jobs: [X(J1), X(J2)], diagnoses: [{ ...diag, confirmedRight: '' }] }, ...base } as any)).toBe(false);
  });
});

// ── spine ───────────────────────────────────────────────────────────────────
describe('spine MDDM', () => {
  const task = (extra: Record<string, unknown> = {}) => ({ posture: 'G3', weight: 30, frequency: 80, timeValue: 5, timeUnit: 'sec', correctionFactor: 1, ...extra });
  const mod = (tasks: unknown[]) => ({ mddmStatus: 'present', tasks });

  it('첫 직력이 미포함이면: sharedJobId 없는 task(→첫 직력)와 그 직력의 task가 합산에서 빠진다', () => {
    const tasks = [task({ name: 'none' }), task({ sharedJobId: 'job-1', name: 'own1' }), task({ sharedJobId: 'job-2', name: 'own2', weight: 10 })];
    const r = computeMddmCalc({ shared: { jobs: [X(J1), J2], gender: 'male' }, module: mod(tasks) });
    expect(r.jobResults.map((j) => j.jobId)).toEqual(['job-2']);
    expect(r.tasks.map((t: any) => t.name)).toEqual(['own2']);
    // 일일 노출량·최대 압박력은 포함 직력의 task만으로 계산된다
    const only = computeMddmCalc({ shared: { jobs: [J2], gender: 'male' }, module: mod([task({ sharedJobId: 'job-2', name: 'own2', weight: 10 })]) });
    expect(r.dailyDose.dailyDoseKNh).toBeCloseTo(only.dailyDose.dailyDoseKNh, 10);
    expect(r.maxForce).toBe(only.maxForce);
    expect(r.noEvaluableJobs).toBe(false);
  });

  it('전부 미포함이면 task·jobResults·maxForce가 비고 noEvaluableJobs=true', () => {
    const r = computeMddmCalc({ shared: { jobs: [X(J1), X(J2)], gender: 'male' }, module: mod([task({ sharedJobId: 'job-1' })]) });
    expect(r.tasks).toEqual([]);
    expect(r.jobResults).toEqual([]);
    expect(r.maxForce).toBe(0);
    expect(r.noEvaluableJobs).toBe(true);
  });

  it('직력 0개 + 레거시 필드 없음 + task 존재 + 플래그 없음: 기존 작업 목록·산출값 유지 (fallback 경로 보존)', () => {
    const tasks = [task({ name: 'a' }), task({ name: 'b', weight: 20 })];
    const r = computeMddmCalc({ shared: { jobs: [], gender: 'male' }, module: mod(tasks) });
    expect(r.tasks.map((t: any) => t.name)).toEqual(['a', 'b']);
    expect(r.dailyDose.includedCount).toBe(2);
    expect(r.maxForce).toBeGreaterThan(0);
    expect(r.noEvaluableJobs).toBe(false);
  });

  it('레거시 필드(careerYears) 분기는 직력 플래그가 있어도 원본 task를 그대로 쓴다', () => {
    const tasks = [task({ sharedJobId: 'job-1' }), task({ sharedJobId: 'job-2' })];
    const r = computeMddmCalc({ shared: { jobs: [X(J1), X(J2)], gender: 'male' }, module: { ...mod(tasks), careerYears: 10, workDaysPerYear: 250 } });
    expect(r.tasks).toHaveLength(2);
    expect(r.noEvaluableJobs).toBe(false);
  });

  it('isMddmComplete: 포함 직력에는 task가 없고 미포함 직력에만 있으면 미완료 (계산에서 빠지는 task로 통과하지 않음)', () => {
    const only = { shared: { jobs: [J1, X(J2)] }, module: mod([task({ sharedJobId: 'job-2' })]) };
    expect(isMddmComplete(only as any)).toBe(false);
    const has = { shared: { jobs: [J1, X(J2)] }, module: mod([task({ sharedJobId: 'job-1' })]) };
    expect(isMddmComplete(has as any)).toBe(true);
  });

  it('포함 직력은 있지만 task는 0개인 경우: 직력 기반 분기를 유지한다 (결과 jobResults에 포함 직력이 남는다)', () => {
    const r = computeMddmCalc({ shared: { jobs: [J1, X(J2)], gender: 'male' }, module: mod([task({ sharedJobId: 'job-2' })]) });
    expect(r.jobResults.map((j) => j.jobId)).toEqual(['job-1']);
    expect(r.tasks).toEqual([]);
  });
});

describe('spine 진동', () => {
  const iv = (extra: Record<string, unknown> = {}) => ({ awMin: 0.5, awMax: 0.8, timeValue: 4, timeUnit: 'hr', ...extra });
  const mod = (intervals: unknown[]) => ({ vibrationExposureStatus: 'present', vibrationIntervals: intervals });

  it('미포함 직력의 잘못된 구간이 검증 메시지·반환 intervals에 남지 않는다', () => {
    const bad = iv({ sharedJobId: 'job-1', awMin: 2, awMax: 1 }); // awMin > awMax: invalid
    const good = iv({ sharedJobId: 'job-2' });
    const r = computeVibrationCalc({ shared: { jobs: [X(J1), J2], gender: 'male' }, module: mod([bad, good]) });
    expect(r.validation.hasInvalidIntervals).toBe(false);
    expect(r.validation.messages).toEqual([]);
    expect(r.intervals).toHaveLength(1);
    expect(r.jobResults.map((j) => j.jobId)).toEqual(['job-2']);
  });

  it('미포함 직력에만 유효 구간이 있으면 계산 대상 구간이 없는 것으로 본다', () => {
    const r = computeVibrationCalc({ shared: { jobs: [X(J1), J2], gender: 'male' }, module: mod([iv({ sharedJobId: 'job-1' })]) });
    expect(r.intervals).toEqual([]);
    expect(isVibrationComplete({ shared: { jobs: [X(J1), J2] }, module: mod([iv({ sharedJobId: 'job-1' })]) } as any)).toBe(false);
  });

  it('sharedJobId 없는 구간은 첫 직력(미포함)에 귀속되어 빠진다', () => {
    const r = computeVibrationCalc({ shared: { jobs: [X(J1), J2], gender: 'male' }, module: mod([iv()]) });
    expect(r.intervals).toEqual([]);
  });

  it('전부 미포함이면 noEvaluableJobs=true', () => {
    expect(computeVibrationCalc({ shared: { jobs: [X(J1)], gender: 'male' }, module: mod([iv({ sharedJobId: 'job-1' })]) }).noEvaluableJobs).toBe(true);
  });

  it('직력 0개이면 구간을 그대로 쓴다 (fallback 보존)', () => {
    const r = computeVibrationCalc({ shared: { jobs: [], gender: 'male' }, module: mod([iv()]) });
    expect(r.intervals).toHaveLength(1);
  });
});

describe('spine 완료 판정 — 전부 미포함', () => {
  const dx = (extra: Record<string, unknown> = {}) => ({ id: 'dx-1', code: 'M51', moduleId: 'spine', confirmedRight: 'confirmed', assessmentRight: 'high', ...extra });

  it('상병 평가 완료 + MDDM·진동 모두 unknown + 전부 미포함 → 완료', () => {
    const ctx: any = { shared: { jobs: [X(J1), X(J2)], diagnoses: [dx()] }, module: {}, activeModules: ['spine'] };
    expect(isSpineAssessmentComplete(ctx)).toBe(true);
  });
  it('상병 평가 미완료 + 전부 미포함 → 미완료', () => {
    const ctx: any = { shared: { jobs: [X(J1)], diagnoses: [dx({ confirmedRight: '' })] }, module: {}, activeModules: ['spine'] };
    expect(isSpineAssessmentComplete(ctx)).toBe(false);
  });
  it('일부만 미포함이면 기존 MDDM/진동 판정을 따른다 (unknown → 미완료)', () => {
    const ctx: any = { shared: { jobs: [J1, X(J2)], diagnoses: [dx()] }, module: {}, activeModules: ['spine'] };
    expect(isSpineAssessmentComplete(ctx)).toBe(false);
  });
  it('computeSpineCalc가 mddm/vibration 양쪽 noEvaluableJobs를 노출한다', () => {
    const r = computeSpineCalc({ shared: { jobs: [X(J1)], diagnoses: [] }, module: { mddmStatus: 'present', tasks: [] }, activeModules: ['spine'] });
    expect(r.noEvaluableJobs).toBe(true);
  });
});

// ── 입력 경계: 레거시 혼재 환자는 플래그가 무력화되고, 서버 완료 검증이 클라이언트와 같은 결과를 낸다 ──
describe('레거시 혼재 환자 — 입력 경계 정규화', () => {
  const dxSpine = { id: 'dx-1', code: 'M51', moduleId: 'spine', confirmedRight: 'confirmed', assessmentRight: 'high' };
  const mixed = (flag: boolean) => ({
    shared: { jobs: [{ ...J1, excludeFromAnalysis: flag }, { ...J2, excludeFromAnalysis: flag }], diagnoses: [dxSpine] },
    modules: { spine: { jobName: '구형 직무' } }, // 합집합 감지: jobName만 남아도 레거시 혼재
    activeModules: ['spine'],
  });

  it('verifyAllModulesComplete: 구형 필드가 남은 환자는 모든 직력이 미포함이어도 "평가 대상 없음 완료"로 통과하지 않는다', () => {
    const withFlags = verifyAllModulesComplete(mixed(true) as any);
    const withoutFlags = verifyAllModulesComplete(mixed(false) as any);
    expect(withFlags.allComplete).toBe(false);
    expect(withFlags).toEqual(withoutFlags);
  });

  it('레거시가 없으면 전부 미포함 → 서버 재검증도 완료(클라이언트 isComplete와 같은 규칙)', () => {
    const clean: any = { ...mixed(true), modules: { spine: {} } };
    expect(verifyAllModulesComplete(clean).allComplete).toBe(true);
  });

  it('deterministicMigrate: 혼재 환자의 플래그가 무력화되고 unsupported_legacy_spine_jobs issue는 그대로 남는다', () => {
    const res = deterministicMigrate({ data: mixed(true) }, { caseId: 'case-1', createdAtFallbackIso: '2024-01-01T00:00:00Z' });
    const jobs = (res.payload.data.shared as any).jobs;
    expect(jobs.every((j: any) => j.excludeFromAnalysis === false)).toBe(true);
    expect(res.issues.some((i) => i.code === 'unsupported_legacy_spine_jobs')).toBe(true);
  });

  it('deterministicMigrate: 레거시가 없으면 플래그를 보존한다', () => {
    const clean = { ...mixed(true), modules: { spine: {} } };
    const res = deterministicMigrate({ data: clean }, { caseId: 'case-1', createdAtFallbackIso: '2024-01-01T00:00:00Z' });
    expect((res.payload.data.shared as any).jobs.every((j: any) => j.excludeFromAnalysis === true)).toBe(true);
  });
});
