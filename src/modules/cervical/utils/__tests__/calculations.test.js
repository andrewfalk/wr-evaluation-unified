import { describe, expect, it } from 'vitest';
import { isCervicalAssessmentComplete } from '../calculations';

function makeDiag(overrides = {}) {
  return {
    id: 'd1', code: 'M50.1', name: '경추간판장애',
    confirmedRight: 'confirmed', assessmentRight: 'high', reasonRight: [],
    ...overrides,
  };
}

function makeJob(overrides = {}) {
  return { id: 'j1', jobName: '조립라인 작업자', startDate: '2015-01-01', workDaysPerYear: 250, ...overrides };
}

function makePatientData({ diagnoses = [makeDiag()], jobs = [makeJob()], tasks = [] } = {}) {
  return {
    shared: { diagnoses, jobs },
    module: { tasks },
    activeModules: ['cervical'],
  };
}

describe('isCervicalAssessmentComplete', () => {
  it('경추 상병이 없으면 미완료', () => {
    expect(isCervicalAssessmentComplete(makePatientData({ diagnoses: [] }))).toBe(false);
  });

  it('직업력이 없으면 미완료', () => {
    expect(isCervicalAssessmentComplete(makePatientData({ jobs: [] }))).toBe(false);
  });

  it('상병 상태/업무관련성 미입력이면 미완료', () => {
    const patientData = makePatientData({ diagnoses: [makeDiag({ confirmedRight: '', assessmentRight: '' })] });
    expect(isCervicalAssessmentComplete(patientData)).toBe(false);
  });

  it('작업을 하나도 입력하지 않아도(경추부담 작업 없음) 상병 평가만 채워져 있으면 완료로 처리한다', () => {
    const patientData = makePatientData({ tasks: [] });
    expect(isCervicalAssessmentComplete(patientData)).toBe(true);
  });

  it('일부 직업만 작업이 없고 나머지 직업의 작업이 완전하면 완료로 처리한다', () => {
    const patientData = makePatientData({
      jobs: [makeJob({ id: 'j1' }), makeJob({ id: 'j2', jobName: '포장 작업자' })],
      tasks: [{
        id: 't1', sharedJobId: 'j2', name: '작업1',
        exposure_types: ['shoulder_heavy_load'],
        load_weight_kg: 45, carry_hours_per_shift: 1, forced_neck_posture: 'yes',
      }],
    });
    expect(isCervicalAssessmentComplete(patientData)).toBe(true);
  });

  it('작업은 있지만 필수 필드가 비어있으면 미완료', () => {
    const patientData = makePatientData({
      tasks: [{ id: 't1', sharedJobId: 'j1', name: '작업1', exposure_types: ['shoulder_heavy_load'] }],
    });
    expect(isCervicalAssessmentComplete(patientData)).toBe(false);
  });

  it('작업이 있고 필수 필드가 모두 채워져 있으면 완료', () => {
    const patientData = makePatientData({
      tasks: [{
        id: 't1', sharedJobId: 'j1', name: '작업1',
        exposure_types: ['shoulder_heavy_load'],
        load_weight_kg: 45, carry_hours_per_shift: 1, forced_neck_posture: 'yes',
      }],
    });
    expect(isCervicalAssessmentComplete(patientData)).toBe(true);
  });
});
