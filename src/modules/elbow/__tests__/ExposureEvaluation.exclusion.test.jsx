// @vitest-environment jsdom
//
// 팔꿈치·손목 평가 화면(구조가 같다)의 "신체부담평가 미포함" 직력 처리:
//  · 노출 입력 카드는 포함 직력만 번호 1부터 보인다.
//  · syncXxxModuleData는 전체 직력 기준이라 미포함 직력의 jobEvaluations 입력값이 지워지지 않는다.
//  · 전부 미포함이면 안내만 보이고 결과 패널·입력 카드는 없다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ElbowEvaluation } from '../ElbowEvaluation.jsx';
import { WristEvaluation } from '../../wrist/WristEvaluation.jsx';

vi.mock('../components/ExposureForm', () => ({
  ExposureForm: ({ job, jobIndex }) => <div data-testid="exposure-form">{`직력${jobIndex + 1}:${job.jobName}`}</div>,
}));
vi.mock('../components/ElbowResultPanel', () => ({ ElbowResultPanel: () => <div data-testid="result-panel" /> }));
vi.mock('../../wrist/components/ExposureForm', () => ({
  ExposureForm: ({ job, jobIndex }) => <div data-testid="exposure-form">{`직력${jobIndex + 1}:${job.jobName}`}</div>,
}));
vi.mock('../../wrist/components/WristResultPanel', () => ({ WristResultPanel: () => <div data-testid="result-panel" /> }));

afterEach(cleanup);

const job = (id, jobName, flag) => ({
  id, jobName, startDate: '2010-01-01', endDate: '2015-01-01', workDaysPerYear: 250,
  ...(flag === undefined ? {} : { excludeFromAnalysis: flag }),
});

const CASES = [
  ['elbow', ElbowEvaluation, { id: 'dx-1', code: 'M77.0', name: '내측상과염', moduleId: 'elbow', side: 'right' }],
  ['wrist', WristEvaluation, { id: 'dx-1', code: 'G56.0', name: '수근관증후군', moduleId: 'wrist', side: 'right' }],
];

describe.each(CASES)('%s 평가 화면 — 신체부담평가 미포함 직력', (moduleId, Component, dx) => {
  const makePatient = (jobs, jobEvaluations) => ({
    id: 'p1',
    data: {
      shared: { jobs, diagnoses: [dx] },
      module: { jobEvaluations },
      activeModules: [moduleId],
    },
  });
  const evals = () => [
    { sharedJobId: 'a', diagnosisEntries: [{ diagnosisId: 'dx-1', daily_exposure_hours: '3' }] },
    { sharedJobId: 'b', diagnosisEntries: [{ diagnosisId: 'dx-1', daily_exposure_hours: '5' }] },
    { sharedJobId: 'c', diagnosisEntries: [{ diagnosisId: 'dx-1', daily_exposure_hours: '7' }] },
  ];

  it('미포함 직력의 입력 카드는 나오지 않고 포함 직력만 1부터 번호가 붙는다', () => {
    const patient = makePatient([job('a', '사무직', true), job('b', '용접공'), job('c', '철근공')], evals());
    render(<Component patient={patient} calc={{}} updateModule={vi.fn()} errors={null} />);
    const texts = screen.getAllByTestId('exposure-form').map((el) => el.textContent);
    expect(texts).toEqual(['직력1:용접공', '직력2:철근공']);
  });

  it('렌더가 일으키는 sync(updateModule)를 적용해도 미포함 직력의 jobEvaluations 입력값이 남는다', () => {
    const updaters = [];
    const updateModule = vi.fn((fn) => { updaters.push(fn); });
    const patient = makePatient([job('a', '사무직', true), job('b', '용접공'), job('c', '철근공')], evals());
    render(<Component patient={patient} calc={{}} updateModule={updateModule} errors={null} />);

    let moduleData = patient.data.module;
    updaters.forEach((fn) => { moduleData = fn(moduleData); });
    const kept = moduleData.jobEvaluations.find((e) => e.sharedJobId === 'a');
    expect(moduleData.jobEvaluations.map((e) => e.sharedJobId)).toEqual(['a', 'b', 'c']);
    expect(kept.diagnosisEntries.find((e) => e.diagnosisId === 'dx-1').daily_exposure_hours).toBe('3');
  });

  it('전부 미포함이면 안내만 보이고 입력 카드·결과 패널은 없다', () => {
    const patient = makePatient([job('a', '사무직', true), job('b', '관리직', true)], evals().slice(0, 2));
    render(<Component patient={patient} calc={{}} updateModule={vi.fn()} errors={null} />);
    expect(screen.getByRole('status').textContent).toContain('평가 대상 직력이 없습니다');
    expect(screen.queryByTestId('exposure-form')).toBeNull();
    expect(screen.queryByTestId('result-panel')).toBeNull();
  });

  it('미포함 플래그가 없는 구데이터는 모든 직력 카드가 보이고 결과 패널도 있다', () => {
    const patient = makePatient([job('a', '사무직'), job('b', '용접공')], evals().slice(0, 2));
    render(<Component patient={patient} calc={{}} updateModule={vi.fn()} errors={null} />);
    expect(screen.getAllByTestId('exposure-form')).toHaveLength(2);
    expect(screen.getByTestId('result-panel')).toBeTruthy();
  });
});
