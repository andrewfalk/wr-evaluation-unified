// @vitest-environment jsdom
//
// 무릎·어깨 평가 화면의 "신체부담평가 미포함" 직력 처리:
//  · JobTab에는 포함 직력만 넘어간다(번호는 포함 직력 기준 1부터).
//  · 누락된 jobExtras 자동 생성은 전체 직력 기준이라 미포함 직력의 extras도 유지·생성된다.
//  · 전부 미포함이면 JobTab 대신 안내가 나온다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { KneeEvaluation } from '../KneeEvaluation.jsx';
import { ShoulderEvaluation } from '../../shoulder/ShoulderEvaluation.jsx';

vi.mock('../components/JobTab', () => ({
  JobTab: ({ sharedJobs }) => <div data-testid="job-tab">{sharedJobs.map((j) => j.jobName).join('|')}</div>,
}));
vi.mock('../components/KneeResultPanel', () => ({ KneeResultPanel: () => <div data-testid="result-panel" /> }));
vi.mock('../../shoulder/components/JobTab', () => ({
  JobTab: ({ sharedJobs }) => <div data-testid="job-tab">{sharedJobs.map((j) => j.jobName).join('|')}</div>,
}));
vi.mock('../../shoulder/components/ShoulderResultPanel', () => ({ ShoulderResultPanel: () => <div data-testid="result-panel" /> }));

afterEach(cleanup);

const job = (id, jobName, flag) => ({ id, jobName, ...(flag === undefined ? {} : { excludeFromAnalysis: flag }) });

describe.each([
  ['knee', KneeEvaluation],
  ['shoulder', ShoulderEvaluation],
])('%s 평가 화면 — 신체부담평가 미포함 직력', (moduleId, Component) => {
  const makePatient = (jobs, jobExtras = []) => ({ id: 'p1', data: { shared: { jobs }, module: { jobExtras } } });

  it('JobTab에는 포함 직력만 넘어간다', () => {
    render(<Component patient={makePatient([job('a', '사무직', true), job('b', '용접공'), job('c', '철근공')])} calc={{}} updateModule={vi.fn()} errors={null} />);
    expect(screen.getByTestId('job-tab').textContent).toBe('용접공|철근공');
  });

  it('jobExtras 자동 생성은 전체 직력 기준이라 미포함 직력의 extras도 만들어진다', () => {
    const updaters = [];
    const updateModule = vi.fn((fn) => { updaters.push(fn); });
    const patient = makePatient([job('a', '사무직', true), job('b', '용접공')]);
    render(<Component patient={patient} calc={{}} updateModule={updateModule} errors={null} />);

    let moduleData = patient.data.module;
    updaters.forEach((fn) => { moduleData = fn(moduleData); });
    expect(moduleData.jobExtras.map((e) => e.sharedJobId).sort()).toEqual(['a', 'b']);
  });

  it('이미 입력된 미포함 직력의 extras 값은 렌더 후에도 그대로다', () => {
    const updaters = [];
    const updateModule = vi.fn((fn) => { updaters.push(fn); });
    const extras = [{ sharedJobId: 'a', weight: '30', squatting: '60', overheadHours: '2' }, { sharedJobId: 'b' }];
    const patient = makePatient([job('a', '사무직', true), job('b', '용접공')], extras);
    render(<Component patient={patient} calc={{}} updateModule={updateModule} errors={null} />);

    let moduleData = patient.data.module;
    updaters.forEach((fn) => { moduleData = fn(moduleData); });
    expect(moduleData.jobExtras.find((e) => e.sharedJobId === 'a')).toMatchObject({ weight: '30', squatting: '60', overheadHours: '2' });
  });

  it('전부 미포함이면 JobTab 대신 안내가 나온다', () => {
    render(<Component patient={makePatient([job('a', '사무직', true), job('b', '관리직', true)])} calc={{}} updateModule={vi.fn()} errors={null} />);
    expect(screen.getByRole('status').textContent).toContain('평가 대상 직력이 없습니다');
    expect(screen.queryByTestId('job-tab')).toBeNull();
  });

  it('플래그가 없는 구데이터는 모든 직력이 보인다', () => {
    render(<Component patient={makePatient([job('a', '사무직'), job('b', '용접공')])} calc={{}} updateModule={vi.fn()} errors={null} />);
    expect(screen.getByTestId('job-tab').textContent).toBe('사무직|용접공');
  });
});
