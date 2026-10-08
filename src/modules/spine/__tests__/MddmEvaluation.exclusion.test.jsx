// @vitest-environment jsdom
//
// MDDM 평가 화면의 "신체부담평가 미포함" 직력 처리:
//  · 직력 탭에는 포함 직력만 번호 1부터 보인다.
//  · 첫 직력이 미포함이어도 sharedJobId 없는 task는 (UI와 계산이 같은 기준으로) 전체 jobs[0]에 귀속된 채 숨겨진다.
//  · 미포함 직력에 귀속된 task는 화면에서만 숨겨질 뿐 지워지지 않는다(updateModule 정리 effect가 전체 jobs 기준).
//  · 전부 미포함이면 안내가 나오고 작업 편집 UI는 없다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MddmEvaluation } from '../MddmEvaluation.jsx';

vi.mock('../components/TaskManager', () => ({
  TaskManager: ({ tasks }) => <div data-testid="task-manager">{tasks.map((t) => t.name).join('|')}</div>,
}));
vi.mock('../components/TaskEditor', () => ({ TaskEditor: () => <div data-testid="task-editor" /> }));

afterEach(cleanup);

const job = (id, jobName, flag) => ({
  id, jobName, startDate: '2010-01-01', endDate: '2015-01-01', workDaysPerYear: 250,
  ...(flag === undefined ? {} : { excludeFromAnalysis: flag }),
});

function makePatient({ jobs, tasks }) {
  return {
    id: 'p1',
    data: {
      shared: { jobs },
      module: { mddmStatus: 'present', tasks: tasks.map((t) => ({ posture: 'G3', weight: 10, frequency: 10, ...t })) },
    },
  };
}

describe('MddmEvaluation — 신체부담평가 미포함 직력', () => {
  it('직력 탭에는 포함 직력만 번호 1부터 나온다', () => {
    const patient = makePatient({
      jobs: [job('a', '사무직', true), job('b', '용접공'), job('c', '철근공')],
      tasks: [{ id: 't1', name: '용접', sharedJobId: 'b' }],
    });
    render(<MddmEvaluation patient={patient} updateModule={vi.fn()} methodTabs={null} />);
    expect(screen.queryByText(/사무직/)).toBeNull();
    expect(screen.getByText(/직력1: 용접공/)).toBeTruthy();
    expect(screen.getByText(/직력2: 철근공/)).toBeTruthy();
  });

  it('첫 포함 직력이 선택되어 그 직력의 task만 보인다 (미포함 직력 task는 숨김)', () => {
    const patient = makePatient({
      jobs: [job('a', '사무직', true), job('b', '용접공')],
      tasks: [{ id: 't1', name: '사무 작업', sharedJobId: 'a' }, { id: 't2', name: '용접 작업', sharedJobId: 'b' }],
    });
    render(<MddmEvaluation patient={patient} updateModule={vi.fn()} methodTabs={null} />);
    expect(screen.getByTestId('task-manager').textContent).toBe('용접 작업');
  });

  it('첫 직력이 미포함이면 sharedJobId 없는 task는 다음 직력 화면에 나타나지 않는다 (계산과 같은 귀속)', () => {
    const patient = makePatient({
      jobs: [job('a', '사무직', true), job('b', '용접공')],
      tasks: [{ id: 't1', name: '귀속 없음' }, { id: 't2', name: '용접 작업', sharedJobId: 'b' }],
    });
    render(<MddmEvaluation patient={patient} updateModule={vi.fn()} methodTabs={null} />);
    expect(screen.getByTestId('task-manager').textContent).toBe('용접 작업');
  });

  it('렌더가 일으키는 정리(updateModule)를 적용해도 미포함 직력의 task는 삭제되지 않는다', () => {
    const updaters = [];
    const updateModule = vi.fn((fn) => { updaters.push(fn); });
    const patient = makePatient({
      jobs: [job('a', '사무직', true), job('b', '용접공')],
      tasks: [{ id: 't1', name: '귀속 없음' }, { id: 't2', name: '사무 작업', sharedJobId: 'a' }, { id: 't3', name: '용접 작업', sharedJobId: 'b' }],
    });
    render(<MddmEvaluation patient={patient} updateModule={updateModule} methodTabs={null} />);

    let moduleData = patient.data.module;
    updaters.forEach((fn) => { moduleData = fn(moduleData); });
    expect(moduleData.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    expect(moduleData.tasks.find((t) => t.id === 't1').sharedJobId).toBe('a'); // 전체 jobs[0]에 귀속
  });

  it('전부 미포함이면 안내를 보이고 작업 목록·편집기는 없다', () => {
    const patient = makePatient({
      jobs: [job('a', '사무직', true), job('b', '관리직', true)],
      tasks: [{ id: 't1', name: '사무 작업', sharedJobId: 'a' }],
    });
    render(<MddmEvaluation patient={patient} updateModule={vi.fn()} methodTabs={null} />);
    expect(screen.getByRole('status').textContent).toContain('평가 대상 직력이 없습니다');
    expect(screen.queryByTestId('task-manager')).toBeNull();
    expect(screen.queryByTestId('task-editor')).toBeNull();
  });

  it('미포함 플래그가 없는 구데이터는 모든 직력 탭이 보인다', () => {
    const patient = makePatient({
      jobs: [job('a', '사무직'), job('b', '용접공')],
      tasks: [{ id: 't1', name: '사무 작업', sharedJobId: 'a' }],
    });
    render(<MddmEvaluation patient={patient} updateModule={vi.fn()} methodTabs={null} />);
    expect(screen.getByText(/직력1: 사무직/)).toBeTruthy();
    expect(screen.getByText(/직력2: 용접공/)).toBeTruthy();
  });
});
