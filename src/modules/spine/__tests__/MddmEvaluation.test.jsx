// @vitest-environment jsdom
//
// "요추 압박력 노출 여부(미평가/노출없음/노출있음)"는 저장되는 임상 데이터인 동시에 아래
// 작업 목록의 표시 여부를 결정하는 게이트다 — mddmStatus가 'present'가 아니면 이미 입력된
// 작업이 있어도 안내문만 보인다. 비담당 환자 조회 시 저장은 막혀야 하지만, 실제 저장된
// 작업 데이터를 미리보기조차 못 하면 안 되므로 로컬 오버라이드로만 전환해야 한다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MddmEvaluation } from '../MddmEvaluation.jsx';
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

// mddmStatus를 'none'으로 명시 저장해뒀지만 tasks는 실제로 존재하는(과거 입력 후 상태만
// 바꾼) 케이스 — read-only 오버라이드가 없으면 이 작업 데이터를 절대 볼 수 없다.
function makePatient({ id = 'p1' } = {}) {
  return {
    id,
    data: {
      shared: { jobs: [{ id: 'j1', jobName: '형틀목공' }] },
      module: {
        mddmStatus: 'none',
        tasks: [
          { id: 't1', name: '문서 상자 이동', posture: 'G3', weight: 9, frequency: 16, sharedJobId: 'j1' },
        ],
      },
    },
  };
}

describe('MddmEvaluation — read-only 래퍼 안에서의 노출 여부 미리보기', () => {
  it('canMutate=false일 때 "노출있음"을 눌러도 updateModule은 호출되지 않는다', async () => {
    const user = userEvent.setup();
    const updateModule = vi.fn();
    render(
      <ReadOnlyWrapper>
        <MddmEvaluation patient={makePatient()} updateModule={updateModule} methodTabs={null} canMutate={false} />
      </ReadOnlyWrapper>
    );

    await user.click(screen.getByRole('button', { name: '노출있음' }));
    expect(updateModule).not.toHaveBeenCalled();
  });

  it('canMutate=false여도 "노출있음"을 누르면 저장된 작업 목록이 실제로 드러난다', async () => {
    const user = userEvent.setup();
    render(
      <ReadOnlyWrapper>
        <MddmEvaluation patient={makePatient()} updateModule={vi.fn()} methodTabs={null} canMutate={false} />
      </ReadOnlyWrapper>
    );

    // 저장된 mddmStatus가 'none'이라 처음엔 안내문만 보이고 작업 목록은 숨어 있다.
    expect(screen.queryByText('문서 상자 이동')).toBeNull();

    await user.click(screen.getByRole('button', { name: '노출있음' }));
    expect(screen.getByText('문서 상자 이동')).toBeTruthy();
  });

  it('canMutate=true일 때는 기존대로 updateModule로 저장한다(회귀 방지)', async () => {
    const user = userEvent.setup();
    const updateModule = vi.fn();
    render(
      <MddmEvaluation patient={makePatient()} updateModule={updateModule} methodTabs={null} canMutate={true} />
    );

    await user.click(screen.getByRole('button', { name: '노출있음' }));
    expect(updateModule).toHaveBeenCalled();
  });

  it('canMutate=false일 때 저장 안내 문구가 보인다(임상 상태가 실제로 바뀐 것으로 오인하지 않도록)', () => {
    render(
      <ReadOnlyWrapper>
        <MddmEvaluation patient={makePatient()} updateModule={vi.fn()} methodTabs={null} canMutate={false} />
      </ReadOnlyWrapper>
    );
    expect(screen.getByText(/조회 화면만 전환되며, 저장된 노출 상태는 변경되지 않습니다/)).toBeTruthy();
  });

  it('환자 A에서 만든 오버라이드가 저장값이 같은 환자 B로 새지 않는다(핵심 회귀 — patient.id 누락 시 재현됨)', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ReadOnlyWrapper>
        <MddmEvaluation patient={makePatient({ id: 'patient-a' })} updateModule={vi.fn()} methodTabs={null} canMutate={false} />
      </ReadOnlyWrapper>
    );

    await user.click(screen.getByRole('button', { name: '노출있음' }));
    expect(screen.getByRole('button', { name: '노출있음' }).className).toContain('btn-primary');

    rerender(
      <ReadOnlyWrapper>
        <MddmEvaluation patient={makePatient({ id: 'patient-b' })} updateModule={vi.fn()} methodTabs={null} canMutate={false} />
      </ReadOnlyWrapper>
    );

    // 환자 B도 저장된 mddmStatus는 'none'으로 A와 동일 — B는 자신의 저장값대로 "노출없음"이
    // active여야 한다. A에서 누른 'present' 오버라이드가 새어 들어오면 안 된다.
    expect(screen.getByRole('button', { name: '노출없음' }).className).toContain('btn-primary');
    expect(screen.getByRole('button', { name: '노출있음' }).className).not.toContain('btn-primary');
  });
});
