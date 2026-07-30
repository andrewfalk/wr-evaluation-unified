// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssessmentGroupView } from '../AssessmentGroupView.jsx';

afterEach(cleanup);

function makeDiag(overrides = {}) {
  return {
    id: 'd1', code: '', name: '', side: '',
    confirmedRight: '', assessmentRight: '', reasonRight: [], reasonRightOther: '',
    confirmedLeft: '', assessmentLeft: '', reasonLeft: [], reasonLeftOther: '',
    klgRight: '', klgLeft: '', ellmanRight: '', ellmanLeft: '',
    ...overrides,
  };
}

const KNEE = { code: 'M17.0', name: '무릎 관절증' };

describe('AssessmentGroupView — 방향 미선택 상병 노출 (finding #1)', () => {
  it('방향을 아직 선택하지 않은 상병을 별도 카드로 보여주고 점프 버튼을 제공한다', () => {
    const diag = makeDiag({ ...KNEE, side: '' });
    const onJump = vi.fn();
    render(
      <AssessmentGroupView
        diagnoses={[diag]}
        activeModules={['knee']}
        onDiagnosesReplace={vi.fn()}
        onJumpToDiagnosis={onJump}
      />
    );

    expect(screen.getByText(/방향 미선택/)).toBeTruthy();
    expect(screen.queryByText('표시할 상병이 없습니다.')).toBeNull();

    screen.getByRole('button', { name: /M17.0 무릎 관절증/ }).click();
    expect(onJump).toHaveBeenCalledWith('d1');
  });

  it('방향 미선택 상병이 없으면 카드가 나타나지 않는다', () => {
    const diag = makeDiag({ ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' });
    render(
      <AssessmentGroupView
        diagnoses={[diag]}
        activeModules={['knee']}
        onDiagnosesReplace={vi.fn()}
        onJumpToDiagnosis={vi.fn()}
      />
    );
    expect(screen.queryByText(/방향 미선택/)).toBeNull();
  });

  it('상단 통계의 "미완료" 수는 방향 미선택 카드까지 합산해 실제 카드 수와 일치한다 (finding #2)', () => {
    // 방향 미선택 1건뿐이고 평가단위 기반 미완료는 0건 — 통계가 0으로 나오면 아래 카드(1건)와 모순된다.
    const diag = makeDiag({ ...KNEE, side: '' });
    render(
      <AssessmentGroupView
        diagnoses={[diag]}
        activeModules={['knee']}
        onDiagnosesReplace={vi.fn()}
        onJumpToDiagnosis={vi.fn()}
      />
    );
    expect(screen.getByText(/미완료 1개/)).toBeTruthy();
  });
});

describe('AssessmentGroupView — 그룹 수정 모달 초기값 (finding #3)', () => {
  it('완료 그룹을 "그룹 전체 수정"하면 기존 값으로 폼이 채워진다', async () => {
    const user = userEvent.setup();
    const diag = makeDiag({
      ...KNEE, side: 'both',
      confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: ['lowBurden'],
      confirmedLeft: 'confirmed', assessmentLeft: 'low', reasonLeft: ['lowBurden'],
    });
    render(
      <AssessmentGroupView
        diagnoses={[diag]}
        activeModules={['knee']}
        onDiagnosesReplace={vi.fn()}
        onJumpToDiagnosis={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '그룹 전체 수정' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('select')).toBeTruthy();
    const selects = dialog.querySelectorAll('select');
    expect(selects[0].value).toBe('confirmed'); // 상병 상태
    expect(selects[1].value).toBe('low'); // 업무관련성
    expect(screen.getByRole('checkbox', { name: /누적 신체부담 낮음/ }).checked).toBe(true);
  });

  it('미입력 그룹은 빈 값으로 열린다', async () => {
    const user = userEvent.setup();
    const diag = makeDiag({ ...KNEE, side: 'right' });
    render(
      <AssessmentGroupView
        diagnoses={[diag]}
        activeModules={['knee']}
        onDiagnosesReplace={vi.fn()}
        onJumpToDiagnosis={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '그룹 값 입력' }));

    const dialog = screen.getByRole('dialog');
    const selects = dialog.querySelectorAll('select');
    expect(selects[0].value).toBe('');
    expect(selects[1].value).toBe('');
  });
});
