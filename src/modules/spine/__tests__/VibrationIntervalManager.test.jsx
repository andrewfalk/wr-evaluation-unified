// @vitest-environment jsdom
//
// TaskManager.test.jsx와 동일한 회귀 — "TaskManager 간소 클론"인 VibrationIntervalManager도
// 같은 task-item div onClick 구조라 read-only 조회 시 구간 선택이 막혀 있었다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VibrationIntervalManager } from '../components/VibrationIntervalManager.jsx';
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

function makeIntervals() {
  return [
    { id: 'v1', name: '구간 1', awMin: 0.3, awMax: 0.5, timeValue: 2, timeUnit: 'hr' },
    { id: 'v2', name: '구간 2', awMin: 0.6, awMax: 0.8, timeValue: 1, timeUnit: 'hr' },
  ];
}

describe('VibrationIntervalManager — read-only 래퍼 안에서의 구간 선택', () => {
  it('구간 행을 클릭하면 read-only 래퍼 안에서도 onSelect가 호출된다', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ReadOnlyWrapper>
        <VibrationIntervalManager intervals={makeIntervals()} selectedIndex={0} onSelect={onSelect} onAdd={vi.fn()} onRemove={vi.fn()} />
      </ReadOnlyWrapper>
    );

    await user.click(screen.getByText('구간 2'));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('"삭제" 버튼은 read-only 래퍼 안에서는 여전히 막힌다(회귀 방지)', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <ReadOnlyWrapper>
        <VibrationIntervalManager intervals={makeIntervals()} selectedIndex={0} onSelect={vi.fn()} onAdd={vi.fn()} onRemove={onRemove} />
      </ReadOnlyWrapper>
    );

    await user.click(screen.getAllByRole('button', { name: '삭제' })[0]);
    expect(onRemove).not.toHaveBeenCalled();
  });
});
