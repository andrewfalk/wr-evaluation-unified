// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssessmentGroupView } from '../AssessmentGroupView.jsx';
import { blockInteraction, blockMutatingKeys } from '../StepContent.jsx';

afterEach(cleanup);

// StepContent가 read-only(비담당 환자 조회)일 때 씌우는 것과 동일한 capture-phase 핸들러를
// 재현한다 — 실제 버그는 이 래퍼 안에서만 나타나므로(단독 렌더 후 클릭하면 data-readonly-allow가
// 빠져도 통과해버려 무의미) 반드시 이 래퍼로 감싸 검증해야 한다.
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

describe('AssessmentGroupView — 구성원 기본 펼침 상태', () => {
  it('그룹 카드는 별도 클릭 없이 구성원이 기본으로 펼쳐져 있고, 접기 버튼을 누르면 숨겨진다', async () => {
    const user = userEvent.setup();
    const diag = makeDiag({ ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' });
    render(
      <AssessmentGroupView
        diagnoses={[diag]}
        activeModules={['knee']}
        onDiagnosesReplace={vi.fn()}
        onJumpToDiagnosis={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: '▴ 구성원 접기' })).toBeTruthy();
    expect(screen.getByText('무릎 관절증')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '▴ 구성원 접기' }));
    expect(screen.getByRole('button', { name: '▾ 구성원 펼치기' })).toBeTruthy();
    expect(screen.queryByText('무릎 관절증')).toBeNull();
  });
});

describe('AssessmentGroupView — 낮음 사유가 다른 그룹의 제목 구분', () => {
  it('낮음 사유만 다른 두 그룹은 제목 뒤에 "낮음 사유 1" / "낮음 사유 2"가 붙어 구분된다', () => {
    const diagnoses = [
      makeDiag({
        id: 'd1', ...KNEE, side: 'right',
        confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: ['lowBurden'],
      }),
      makeDiag({
        id: 'd2', ...KNEE, side: 'left',
        confirmedLeft: 'confirmed', assessmentLeft: 'low', reasonLeft: ['ageMild'],
      }),
    ];
    render(
      <AssessmentGroupView
        diagnoses={diagnoses}
        activeModules={['knee']}
        onDiagnosesReplace={vi.fn()}
        onJumpToDiagnosis={vi.fn()}
      />
    );

    expect(screen.getByText(/상병 확인 · 업무관련성 낮음 · 낮음 사유 1/)).toBeTruthy();
    expect(screen.getByText(/상병 확인 · 업무관련성 낮음 · 낮음 사유 2/)).toBeTruthy();
    expect(screen.getAllByText(/낮음 사유 상세:/).length).toBe(2);
  });
});

describe('AssessmentGroupView — read-only(비담당 환자) 래퍼 안에서의 조회 전용 토글', () => {
  it('구성원 펼치기/접기 버튼은 read-only 래퍼 안에서도 정상 동작한다', async () => {
    const user = userEvent.setup();
    const diag = makeDiag({ ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' });
    render(
      <ReadOnlyWrapper>
        <AssessmentGroupView
          diagnoses={[diag]}
          activeModules={['knee']}
          onDiagnosesReplace={vi.fn()}
          onJumpToDiagnosis={vi.fn()}
        />
      </ReadOnlyWrapper>
    );

    expect(screen.getByRole('button', { name: '▴ 구성원 접기' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '▴ 구성원 접기' }));
    expect(screen.getByRole('button', { name: '▾ 구성원 펼치기' })).toBeTruthy();
  });

  it('우/좌 분리 뱃지는 read-only 래퍼 안에서도 정상 동작한다', async () => {
    const user = userEvent.setup();
    const diag = makeDiag({
      ...KNEE, side: 'both',
      confirmedRight: 'confirmed', assessmentRight: 'high',
      confirmedLeft: 'confirmed', assessmentLeft: 'high',
    });
    render(
      <ReadOnlyWrapper>
        <AssessmentGroupView
          diagnoses={[diag]}
          activeModules={['knee']}
          onDiagnosesReplace={vi.fn()}
          onJumpToDiagnosis={vi.fn()}
        />
      </ReadOnlyWrapper>
    );

    const splitBadge = screen.getByRole('button', { name: '양측(우+좌)' });
    await user.click(splitBadge);
    // 분리되면 "양측(우+좌)" 뱃지 대신 우/좌 각각의 행으로 바뀐다.
    expect(screen.queryByRole('button', { name: '양측(우+좌)' })).toBeNull();
  });

  it('상병 칩("개별 카드로 이동")은 read-only 래퍼 안에서도 onJumpToDiagnosis를 호출한다', async () => {
    const user = userEvent.setup();
    const diag = makeDiag({ ...KNEE, side: '' });
    const onJump = vi.fn();
    render(
      <ReadOnlyWrapper>
        <AssessmentGroupView
          diagnoses={[diag]}
          activeModules={['knee']}
          onDiagnosesReplace={vi.fn()}
          onJumpToDiagnosis={onJump}
        />
      </ReadOnlyWrapper>
    );

    await user.click(screen.getByRole('button', { name: /M17.0 무릎 관절증/ }));
    expect(onJump).toHaveBeenCalledWith('d1');
  });

  it('"그룹 전체 수정" 버튼은 read-only 래퍼 안에서는 여전히 막힌다(회귀 방지)', async () => {
    const user = userEvent.setup();
    const diag = makeDiag({ ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' });
    render(
      <ReadOnlyWrapper>
        <AssessmentGroupView
          diagnoses={[diag]}
          activeModules={['knee']}
          onDiagnosesReplace={vi.fn()}
          onJumpToDiagnosis={vi.fn()}
        />
      </ReadOnlyWrapper>
    );

    await user.click(screen.getByRole('button', { name: '그룹 전체 수정' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('멤버 선택 체크박스("전체 선택")는 read-only 래퍼 안에서는 여전히 막힌다(회귀 방지)', async () => {
    const user = userEvent.setup();
    const diag = makeDiag({ ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' });
    render(
      <ReadOnlyWrapper>
        <AssessmentGroupView
          diagnoses={[diag]}
          activeModules={['knee']}
          onDiagnosesReplace={vi.fn()}
          onJumpToDiagnosis={vi.fn()}
        />
      </ReadOnlyWrapper>
    );

    const selectAll = screen.getByRole('checkbox', { name: '전체 선택' });
    expect(selectAll.checked).toBe(false);
    await user.click(selectAll);
    expect(selectAll.checked).toBe(false);
  });
});
