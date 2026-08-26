// @vitest-environment jsdom
//
// spine의 TaskManager.test.jsx와 동일한 회귀 — 경추 모듈의 작업 목록도 같은 컴포넌트 형태
// (task-item div onClick)라 read-only 조회 시 행 클릭이 막혀 있었다.
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
    { id: 't1', name: '목 굽힘 작업', exposure_types: [], carry_hours_per_shift: 1, neck_nonneutral_hours_per_day: 2 },
    { id: 't2', name: '모니터 작업', exposure_types: [], carry_hours_per_shift: 0, neck_nonneutral_hours_per_day: 4 },
  ];
}

describe('TaskManager(경추) — read-only 래퍼 안에서의 작업 선택', () => {
  it('작업 행을 클릭하면 read-only 래퍼 안에서도 onSelect가 호출된다', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ReadOnlyWrapper>
        <TaskManager tasks={makeTasks()} selectedIndex={0} onSelect={onSelect} onAdd={vi.fn()} onRemove={vi.fn()} />
      </ReadOnlyWrapper>
    );

    await user.click(screen.getByText('모니터 작업'));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('"삭제" 버튼은 read-only 래퍼 안에서는 여전히 막힌다(회귀 방지)', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <ReadOnlyWrapper>
        <TaskManager tasks={makeTasks()} selectedIndex={0} onSelect={vi.fn()} onAdd={vi.fn()} onRemove={onRemove} />
      </ReadOnlyWrapper>
    );

    await user.click(screen.getAllByRole('button', { name: '삭제' })[0]);
    expect(onRemove).not.toHaveBeenCalled();
  });
});
