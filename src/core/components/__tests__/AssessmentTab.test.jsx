// @vitest-environment jsdom
//
// "패턴 그룹"/"개별 카드" 보기 토글은 화면 전환인 동시에 저장되는
// reportOptions.groupAssessmentResults를 바꾸는 이중 용도 컨트롤이다. 비담당 환자(read-only)
// 조회 시에는 저장을 시도해도 usePatientCrud의 silent guard에 막혀 아무 일도 안 일어나므로,
// canMutate=false일 때는 로컬 오버라이드로만 화면을 전환해야 한다. 여기서는 그 분기 로직과,
// StepContent가 read-only일 때 씌우는 것과 동일한 capture-phase 핸들러(blockInteraction/
// blockMutatingKeys) 안에서도 실제로 클릭이 통과하는지(=data-readonly-allow가 제대로
// 붙었는지)를 함께 검증한다 — AssessmentTab을 단독 렌더 후 클릭만 하면 이 속성이 빠져도
// 테스트가 통과해버려 무의미하다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssessmentTab } from '../AssessmentTab.jsx';
import { blockInteraction, blockMutatingKeys } from '../StepContent.jsx';

afterEach(cleanup);

// jsdom은 scrollIntoView를 구현하지 않는다 — "개별 카드로 이동" 점프 이후 카드 뷰로 스크롤하는
// useEffect(AssessmentTab.jsx:132)가 실제 브라우저에서는 정상 동작하지만 테스트에서는 없는
// 메서드를 호출해 예외가 난다. 스크롤 자체는 이 테스트의 관심사가 아니므로 no-op으로 스텁한다.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});

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
    id: 'd1', code: 'M17.0', name: '무릎 관절증', side: 'right',
    confirmedRight: 'confirmed', assessmentRight: 'high', reasonRight: [], reasonRightOther: '',
    confirmedLeft: '', assessmentLeft: '', reasonLeft: [], reasonLeftOther: '',
    klgRight: '', klgLeft: '', ellmanRight: '', ellmanLeft: '',
    ...overrides,
  };
}

function renderTab(props = {}, { readOnlyWrapper = false } = {}) {
  const el = (
    <AssessmentTab
      diagnoses={[makeDiag()]}
      onDiagnosisUpdate={vi.fn()}
      onDiagnosesReplace={vi.fn()}
      returnConsiderations=""
      onReturnChange={vi.fn()}
      activeModules={['knee']}
      reportOptions={{ groupAssessmentResults: false }}
      onReportOptionsChange={vi.fn()}
      canMutate={true}
      {...props}
    />
  );
  return readOnlyWrapper ? render(<ReadOnlyWrapper>{el}</ReadOnlyWrapper>) : render(el);
}

describe('AssessmentTab — 패턴 그룹/개별 카드 토글 (canMutate=true, 기존 동작)', () => {
  it('편집 가능할 때 토글을 누르면 onReportOptionsChange로 저장을 시도한다', async () => {
    const user = userEvent.setup();
    const onReportOptionsChange = vi.fn();
    renderTab({ onReportOptionsChange });

    await user.click(screen.getByRole('button', { name: '패턴 그룹' }));
    expect(onReportOptionsChange).toHaveBeenCalledWith({ groupAssessmentResults: true });
  });

  it('편집 가능할 때 안내 문구는 "출력도 그룹 형식으로 나갑니다"다', () => {
    renderTab();
    expect(screen.getByText(/미리보기·EMR·엑셀 출력도 그룹 형식으로 나갑니다/)).toBeTruthy();
  });
});

describe('AssessmentTab — read-only(비담당 환자) 래퍼 안에서의 그룹/개별 카드 토글', () => {
  it('canMutate=false일 때 토글을 눌러도 onReportOptionsChange는 호출되지 않는다', async () => {
    const user = userEvent.setup();
    const onReportOptionsChange = vi.fn();
    renderTab({ canMutate: false, onReportOptionsChange }, { readOnlyWrapper: true });

    await user.click(screen.getByRole('button', { name: '패턴 그룹' }));
    expect(onReportOptionsChange).not.toHaveBeenCalled();
  });

  it('canMutate=false일 때도 read-only 래퍼 안에서 클릭이 통과해 화면(view)이 실제로 바뀐다', async () => {
    const user = userEvent.setup();
    renderTab({ canMutate: false }, { readOnlyWrapper: true });

    // 초기값(groupAssessmentResults: false)은 "개별 카드"가 active.
    expect(screen.getByRole('button', { name: '개별 카드' }).className).toContain('active');
    await user.click(screen.getByRole('button', { name: '패턴 그룹' }));
    expect(screen.getByRole('button', { name: '패턴 그룹' }).className).toContain('active');
  });

  it('canMutate=false일 때 안내 문구는 "화면 보기만 전환" 문구로 바뀐다', () => {
    renderTab({ canMutate: false }, { readOnlyWrapper: true });
    expect(screen.getByText(/현재 화면 보기만 전환되며, 실제 출력 형식은 바뀌지 않습니다/)).toBeTruthy();
  });

  it('상병 칩("개별 카드로 이동")도 read-only 래퍼 안에서 저장 없이 view만 전환한다', async () => {
    const user = userEvent.setup();
    const onReportOptionsChange = vi.fn();
    renderTab(
      {
        canMutate: false,
        reportOptions: { groupAssessmentResults: true },
        onReportOptionsChange,
      },
      { readOnlyWrapper: true }
    );

    // groupAssessmentResults: true → 초기 view는 'group'이라 그룹 뷰의 상병 칩이 보인다.
    await user.click(screen.getByRole('button', { name: /M17.0 무릎 관절증/ }));
    expect(onReportOptionsChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '개별 카드' }).className).toContain('active');
  });
});

describe('AssessmentTab — 로컬 오버라이드 리셋', () => {
  it('canMutate가 false→true로 바뀌면 오버라이드가 사라지고 저장된 groupOutput을 다시 따른다', async () => {
    const user = userEvent.setup();
    const { rerender } = renderTab({ canMutate: false, reportOptions: { groupAssessmentResults: false } });

    await user.click(screen.getByRole('button', { name: '패턴 그룹' }));
    expect(screen.getByRole('button', { name: '패턴 그룹' }).className).toContain('active');

    rerender(
      <AssessmentTab
        diagnoses={[makeDiag()]}
        onDiagnosisUpdate={vi.fn()}
        onDiagnosesReplace={vi.fn()}
        returnConsiderations=""
        onReturnChange={vi.fn()}
        activeModules={['knee']}
        reportOptions={{ groupAssessmentResults: false }}
        onReportOptionsChange={vi.fn()}
        canMutate={true}
      />
    );

    // 저장된 값(groupAssessmentResults: false)대로 "개별 카드"가 다시 active여야 한다 —
    // 락 재획득 전에 누르던 오버라이드가 새어 남아있으면 안 된다.
    expect(screen.getByRole('button', { name: '개별 카드' }).className).toContain('active');
  });

  it('저장된 groupOutput 값 자체가 바뀌면(다른 사용자의 실제 저장) 오버라이드가 사라진다', async () => {
    const user = userEvent.setup();
    const { rerender } = renderTab({ canMutate: false, reportOptions: { groupAssessmentResults: false } });

    await user.click(screen.getByRole('button', { name: '패턴 그룹' }));
    expect(screen.getByRole('button', { name: '패턴 그룹' }).className).toContain('active');

    rerender(
      <AssessmentTab
        diagnoses={[makeDiag()]}
        onDiagnosisUpdate={vi.fn()}
        onDiagnosesReplace={vi.fn()}
        returnConsiderations=""
        onReturnChange={vi.fn()}
        activeModules={['knee']}
        reportOptions={{ groupAssessmentResults: true }}
        onReportOptionsChange={vi.fn()}
        canMutate={false}
      />
    );

    expect(screen.getByRole('button', { name: '패턴 그룹' }).className).toContain('active');
  });

  it('환자 전환(재마운트)을 시뮬레이션하면 이전 환자의 오버라이드가 새 환자로 새지 않는다', async () => {
    const user = userEvent.setup();
    const { unmount } = renderTab({ canMutate: false, reportOptions: { groupAssessmentResults: false } });

    await user.click(screen.getByRole('button', { name: '패턴 그룹' }));
    expect(screen.getByRole('button', { name: '패턴 그룹' }).className).toContain('active');
    unmount();

    // 호출부는 <AssessmentTab key={patient.id} .../>로 렌더해 환자가 바뀌면 완전히 새
    // 인스턴스로 마운트한다 — 여기서는 그 결과(새 마운트)를 직접 재현한다.
    renderTab({
      canMutate: false,
      reportOptions: { groupAssessmentResults: true },
      diagnoses: [makeDiag({ id: 'd2', code: 'M75.1', name: '회전근개 파열' })],
    });

    expect(screen.getByRole('button', { name: '패턴 그룹' }).className).toContain('active');
  });
});
