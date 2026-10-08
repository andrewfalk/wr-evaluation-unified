// @vitest-environment jsdom
//
// 경추 평가 화면: (1) "신체부담평가 미포함" 직력은 직력 탭에 보이지 않고, (2) 그 직력의 task는 모듈 데이터에서 지워지지
// 않으며(updateModule로 task를 삭제하지 않는다), (3) 전부 미포함이면 안내를 보이고, (4) 환자 전환으로 조기 return
// 경로가 바뀌어도 hook 호출 개수가 달라져 React가 중단되지 않는다(기존 결함 회귀 방지).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CervicalEvaluation } from '../CervicalEvaluation.jsx';
import { syncCervicalModuleData } from '../utils/data.js';

// 결과 패널·작업 편집기는 이 테스트의 관심사가 아니다 — 가볍게 대체해 렌더 비용과 결합도를 줄인다.
vi.mock('../components/CervicalResultPanel', () => ({ CervicalResultPanel: () => <div data-testid="result-panel" /> }));
vi.mock('../components/TaskEditor', () => ({ TaskEditor: () => <div data-testid="task-editor" /> }));
vi.mock('../components/TaskManager', () => ({
  TaskManager: ({ tasks }) => <div data-testid="task-manager">{tasks.map((t) => t.name).join('|')}</div>,
}));

afterEach(cleanup);

const job = (id, jobName, flag) => ({
  id, jobName, presetId: null, startDate: '2010-01-01', endDate: '2015-01-01', workPeriodOverride: '', workDaysPerYear: 250,
  ...(flag === undefined ? {} : { excludeFromAnalysis: flag }),
});
const dx = { id: 'dx-1', code: 'M50.1', name: '경추간판장애', moduleId: 'cervical', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' };
const tasks = [
  { id: 't1', sharedJobId: 'a', name: '철근 작업', exposure_types: [] },
  { id: 't2', sharedJobId: 'b', name: '사무 작업', exposure_types: [] },
];

function makePatient({ jobs, diagnoses = [dx], moduleTasks = tasks } = {}) {
  return {
    id: 'p1',
    data: {
      shared: { jobs, diagnoses },
      module: { tasks: moduleTasks.map((t) => ({ ...t })) },
      activeModules: ['cervical'],
    },
  };
}

describe('CervicalEvaluation — 신체부담평가 미포함 직력', () => {
  it('미포함 직력은 직력 탭에 나오지 않고, 포함 직력만 번호 1부터 보인다', () => {
    const patient = makePatient({ jobs: [job('a', '사무직', true), job('b', '용접공'), job('c', '철근공')] });
    render(<CervicalEvaluation patient={patient} calc={{}} updateModule={vi.fn()} />);

    expect(screen.queryByText(/사무직/)).toBeNull();
    expect(screen.getByText(/직력1: 용접공/)).toBeTruthy();
    expect(screen.getByText(/직력2: 철근공/)).toBeTruthy();
  });

  it('선택된 직력의 task만 보이고, 미포함 직력 task는 목록에 없다', () => {
    const patient = makePatient({ jobs: [job('a', '사무직', true), job('b', '용접공')] });
    render(<CervicalEvaluation patient={patient} calc={{}} updateModule={vi.fn()} />);
    expect(screen.getByTestId('task-manager').textContent).toBe('사무 작업');
  });

  it('렌더가 일으키는 updateModule(기본 필드 정규화)을 적용해도 미포함 직력의 task가 남는다 (sync는 전체 직력 기준)', () => {
    const updaters = [];
    const updateModule = vi.fn((fn) => { updaters.push(fn); });
    const patient = makePatient({ jobs: [job('a', '사무직', true), job('b', '용접공')] });
    render(<CervicalEvaluation patient={patient} calc={{}} updateModule={updateModule} />);

    let moduleData = patient.data.module;
    updaters.forEach((fn) => { moduleData = fn(moduleData); });
    expect(moduleData.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(moduleData.tasks.find((t) => t.id === 't1').sharedJobId).toBe('a');
  });

  it('전체 직력으로 sync하면 미포함 직력의 task가 그대로 남는다 (필터된 jobs를 넘기면 삭제되는 함정의 대조군)', () => {
    const jobs = [job('a', '사무직', true), job('b', '용접공')];
    expect(syncCervicalModuleData({ tasks: tasks.map((t) => ({ ...t })) }, jobs).moduleData.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    // 대조군: 포함 직력만 넘기면 job 'a'의 task가 고아로 간주되어 삭제된다 — 그래서 화면은 절대 이렇게 넘기지 않는다.
    expect(syncCervicalModuleData({ tasks: tasks.map((t) => ({ ...t })) }, [jobs[1]]).moduleData.tasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('전부 미포함이면 평가 대상 없음 안내를 보이고 작업 편집 UI는 없다', () => {
    const patient = makePatient({ jobs: [job('a', '사무직', true), job('b', '관리직', true)] });
    render(<CervicalEvaluation patient={patient} calc={{}} updateModule={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('평가 대상 직력이 없습니다');
    expect(screen.queryByTestId('task-manager')).toBeNull();
    expect(screen.queryByTestId('result-panel')).toBeNull();
  });

  it('미포함 플래그가 없으면(구데이터) 모든 직력이 보인다', () => {
    const patient = makePatient({ jobs: [job('a', '사무직'), job('b', '용접공')] });
    render(<CervicalEvaluation patient={patient} calc={{}} updateModule={vi.fn()} />);
    expect(screen.getByText(/직력1: 사무직/)).toBeTruthy();
    expect(screen.getByText(/직력2: 용접공/)).toBeTruthy();
  });
});

describe('CervicalEvaluation — 환자 전환 시 hook 순서', () => {
  it('경추 상병 없음 → 있음 → 전부 미포함 → 직력 없음으로 같은 컴포넌트가 재렌더되어도 예외 없이 전환된다', () => {
    const updateModule = vi.fn();
    const noDx = makePatient({ jobs: [job('a', '용접공')], diagnoses: [] });
    const normal = makePatient({ jobs: [job('a', '용접공')] });
    const allExcluded = makePatient({ jobs: [job('a', '용접공', true)] });
    const noJobs = makePatient({ jobs: [] });

    const { rerender } = render(<CervicalEvaluation patient={noDx} calc={{}} updateModule={updateModule} />);
    expect(screen.getByText(/경추\(목\)로 분류되는 상병이 없습니다/)).toBeTruthy();

    rerender(<CervicalEvaluation patient={normal} calc={{}} updateModule={updateModule} />);
    expect(screen.getByTestId('task-manager')).toBeTruthy();

    rerender(<CervicalEvaluation patient={allExcluded} calc={{}} updateModule={updateModule} />);
    expect(screen.getByRole('status')).toBeTruthy();

    rerender(<CervicalEvaluation patient={noJobs} calc={{}} updateModule={updateModule} />);
    expect(screen.getByText(/직업력을 먼저 입력해 주세요/)).toBeTruthy();

    rerender(<CervicalEvaluation patient={normal} calc={{}} updateModule={updateModule} />);
    expect(screen.getByTestId('task-manager')).toBeTruthy();
  });
});
