// @vitest-environment jsdom
//
// TaskManager의 작업 행 클릭(onSelect)은 선택된 작업을 바꿔 보여주는 조회 전용 동작이다
// (선택 상태는 부모 컴포넌트의 로컬 useState — patient 데이터를 바꾸지 않는다). 비담당 환자
// 조회 시 이 클릭조차 막혀 "선택된 작업의 상세를 볼 수 없다"는 버그가 있었다. StepContent가
// read-only일 때 씌우는 것과 동일한 capture-phase 핸들러 안에서 검증한다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskManager } from '../components/TaskManager.jsx';
import { blockInteraction, blockMutatingKeys } from '../../../core/components/StepContent.jsx';

afterEach(cleanup);

function ReadOnlyWrapper({ children }) {
  return (
    <div
      onClickCapture={blockInteraction}
      onKeyDownCapture={blockMutatingKeys}
      onChangeCapture={blockInteraction}
    >
      {children}
    </div>
  );
}

function makeTasks() {
  return [
    { id: 't1', name: '문서 상자 이동', posture: 'G3', weight: 9, frequency: 16, force: 2593 },
    { id: 't2', name: '사무 비품 정리', posture: 'G4', weight: 8, frequency: 22, force: 1700 },
  ];
}

describe('TaskManager — read-only 래퍼 안에서의 작업 선택', () => {
  it('작업 행을 클릭하면 read-only 래퍼 안에서도 onSelect가 호출된다', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ReadOnlyWrapper>
        <TaskManager tasks={makeTasks()} selectedIndex={0} onSelect={onSelect} onAdd={vi.fn()} onRemove={vi.fn()} onReorder={vi.fn()} />
      </ReadOnlyWrapper>
    );

    await user.click(screen.getByText('사무 비품 정리'));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('"삭제" 버튼은 read-only 래퍼 안에서는 여전히 막힌다(회귀 방지 — 컨테이너 전체가 아니라 조회 영역에만 허용했는지)', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <ReadOnlyWrapper>
        <TaskManager tasks={makeTasks()} selectedIndex={0} onSelect={vi.fn()} onAdd={vi.fn()} onRemove={onRemove} onReorder={vi.fn()} />
      </ReadOnlyWrapper>
    );

    await user.click(screen.getAllByRole('button', { name: '삭제' })[0]);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('"+ 작업 추가" 버튼은 read-only 래퍼 안에서는 여전히 막힌다(회귀 방지)', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <ReadOnlyWrapper>
        <TaskManager tasks={makeTasks()} selectedIndex={0} onSelect={vi.fn()} onAdd={onAdd} onRemove={vi.fn()} onReorder={vi.fn()} />
      </ReadOnlyWrapper>
    );

    await user.click(screen.getByRole('button', { name: '+ 작업 추가' }));
    expect(onAdd).not.toHaveBeenCalled();
  });
});
