// @vitest-environment jsdom
//
// StepContent의 read-only 래퍼는 readOnly 여부와 무관하게 항상 같은 구조(.step-content-shell)를
// 렌더해야 한다. 이전에는 read-only일 때만 <div>로 감싸서 반환했는데, 그러면 잠금 상실 등으로
// canMutate가 바뀔 때 이 위치의 루트 요소 구조가 달라져 자식(AssessmentStep 등)이 재마운트되고
// 편집 중이던 로컬 draft가 통째로 사라진다. 이 테스트는 canMutate 토글 전후로 자식의 로컬
// state(controlled input 값)가 살아남는지 — 즉 재마운트되지 않는지 — 를 직접 확인한다.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { StepContent } from '../StepContent.jsx';

afterEach(cleanup);

function StatefulProbe() {
  const [value, setValue] = useState('');
  return <input aria-label="probe" value={value} onChange={e => setValue(e.target.value)} />;
}

const activePatient = { data: { shared: {}, modules: {} } };
const currentStep = { moduleId: 'probe', tabId: 't1' };

describe('StepContent — 래퍼 상시화(잠금 상실 시 재마운트 방지)', () => {
  it('canMutate가 true→false로 바뀌어도 자식의 로컬 입력값이 유지된다(재마운트되지 않는다)', () => {
    const { rerender } = render(
      <StepContent currentStep={currentStep} activePatient={activePatient} EvaluationComponent={StatefulProbe} canMutate={true} />
    );

    fireEvent.change(screen.getByLabelText('probe'), { target: { value: '작성 중인 draft' } });
    expect(screen.getByLabelText('probe').value).toBe('작성 중인 draft');

    rerender(
      <StepContent currentStep={currentStep} activePatient={activePatient} EvaluationComponent={StatefulProbe} canMutate={false} />
    );

    // 재마운트됐다면 useState 초기값('')으로 되돌아간다 — 값이 그대로면 같은 인스턴스가 유지된 것.
    expect(screen.getByLabelText('probe').value).toBe('작성 중인 draft');
  });

  it('canMutate가 true→false→true로 왕복해도(잠금 상실 후 재획득) 값이 유지된다', () => {
    const { rerender } = render(
      <StepContent currentStep={currentStep} activePatient={activePatient} EvaluationComponent={StatefulProbe} canMutate={true} />
    );
    fireEvent.change(screen.getByLabelText('probe'), { target: { value: 'x' } });

    rerender(
      <StepContent currentStep={currentStep} activePatient={activePatient} EvaluationComponent={StatefulProbe} canMutate={false} />
    );
    rerender(
      <StepContent currentStep={currentStep} activePatient={activePatient} EvaluationComponent={StatefulProbe} canMutate={true} />
    );

    expect(screen.getByLabelText('probe').value).toBe('x');
  });

  it('canMutate=true일 때도 래퍼(.step-content-shell)가 렌더된다(read-only-content가 사라져도 껍데기는 남는다)', () => {
    const { container } = render(
      <StepContent currentStep={currentStep} activePatient={activePatient} EvaluationComponent={StatefulProbe} canMutate={true} />
    );
    expect(container.querySelector('.step-content-shell')).toBeTruthy();
    expect(container.querySelector('.read-only-content')).toBeNull();
  });

  it('canMutate=false일 때는 래퍼에 read-only-content가 함께 붙는다', () => {
    const { container } = render(
      <StepContent currentStep={currentStep} activePatient={activePatient} EvaluationComponent={StatefulProbe} canMutate={false} />
    );
    const shell = container.querySelector('.step-content-shell');
    expect(shell).toBeTruthy();
    expect(shell.classList.contains('read-only-content')).toBe(true);
  });

  // WAI-ARIA 명세상 컨테이너의 aria-disabled는 모든 focusable descendant에 적용되는 것으로
  // 간주된다 — 조회 전용 토글 일부만 실제로는 활성인 혼합 컨테이너에 컨테이너 레벨
  // aria-disabled를 다는 것은 안티패턴이라 제거했다(개별 허용 버튼에 aria-disabled={false}를
  // 얹어 상쇄하는 방식 대신). read-only 안내는 배너 문구와 시각 스타일만으로 한다.
  it('canMutate=false여도 래퍼(.step-content-shell)에 aria-disabled 속성이 없다', () => {
    const { container } = render(
      <StepContent currentStep={currentStep} activePatient={activePatient} EvaluationComponent={StatefulProbe} canMutate={false} />
    );
    const shell = container.querySelector('.step-content-shell');
    expect(shell.hasAttribute('aria-disabled')).toBe(false);
  });
});
