import { describe, expect, it, vi } from 'vitest';

// html2pdf.js UMD는 node 환경에서 ReferenceError — 모듈 index.js import용 모킹(batchImportConfig.test.js와 동일).
vi.mock('html2pdf.js', () => ({ default: () => ({}) }));

import '../../../modules/spine';
import '../../../modules/elbow';
import { isPatientComplete } from '../patientCompletion.js';
import { migratePatient } from '../data.js';
import { verifyAllModulesComplete } from '@analytics-core/completion';

const job = (id, flag) => ({ id, jobName: id, presetId: null, startDate: '2010-01-01', endDate: '2015-01-01', workPeriodOverride: '', workDaysPerYear: 250, excludeFromAnalysis: flag });
const spineDx = { id: 'dx-1', code: 'M51', moduleId: 'spine', side: '', confirmedRight: 'confirmed', assessmentRight: 'high' };

const patient = (flag, spineModule) => ({
  id: 'p1',
  createdAt: '2024-01-01T00:00:00.000Z',
  phase: 'evaluation',
  data: { shared: { jobs: [job('a', flag), job('b', flag)], diagnoses: [spineDx] }, modules: { spine: spineModule }, activeModules: ['spine'] },
});

const serverView = (p) => verifyAllModulesComplete({ shared: p.data.shared, modules: p.data.modules, activeModules: p.data.activeModules });

describe('클라이언트 isPatientComplete와 서버 verifyAllModulesComplete가 같은 판정 — 신체부담평가 미포함', () => {
  it('레거시 없음 + 전부 미포함: 둘 다 완료', () => {
    const p = patient(true, {});
    expect(isPatientComplete(p)).toBe(true);
    expect(serverView(p).allComplete).toBe(true);
  });

  it('레거시 없음 + 미포함 없음: 둘 다 미완료 (MDDM/진동 미평가)', () => {
    const p = patient(false, {});
    expect(isPatientComplete(p)).toBe(false);
    expect(serverView(p).allComplete).toBe(false);
  });

  it.each([
    ['jobName', { jobName: '구형' }],
    ['careerMonths', { careerMonths: 3 }],
    ['careerYears', { careerYears: 5 }],
    ['workDaysPerYear', { workDaysPerYear: 250 }],
  ])('혼재(spine.%s 잔존) + 전부 미포함: 둘 다 미완료이고 플래그 없는 환자와 같다', (_name, legacy) => {
    const flagged = patient(true, legacy);
    const unflagged = patient(false, legacy);
    expect(isPatientComplete(flagged)).toBe(isPatientComplete(unflagged));
    expect(serverView(flagged).allComplete).toBe(serverView(unflagged).allComplete);
    expect(isPatientComplete(flagged)).toBe(serverView(flagged).allComplete);
  });
});

describe('migratePatient — 레거시 혼재 환자의 미포함 플래그 무력화', () => {
  it('구형 spine 필드가 남은 환자는 로드 시 모든 직력의 플래그가 false가 된다', () => {
    const migrated = migratePatient(patient(true, { jobName: '구형' }));
    expect(migrated.data.shared.jobs.map((j) => j.excludeFromAnalysis)).toEqual([false, false]);
  });

  it('레거시가 없으면 플래그를 보존한다', () => {
    const migrated = migratePatient(patient(true, {}));
    expect(migrated.data.shared.jobs.map((j) => j.excludeFromAnalysis)).toEqual([true, true]);
  });

  it('입력 환자 객체를 변경하지 않는다', () => {
    const input = patient(true, { jobName: '구형' });
    migratePatient(input);
    expect(input.data.shared.jobs[0].excludeFromAnalysis).toBe(true);
  });
});
