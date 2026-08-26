// @vitest-environment jsdom
//
// SpineEvaluation의 "요추 압박력(MDDM)"/"전신진동(BK2110)" 탭은 화면 전환인 동시에
// activeSpineTab을 저장하는 이중 용도 컨트롤이다(AssessmentTab의 패턴 그룹/개별 카드 토글과
// 동일한 성격). 비담당 환자(read-only) 조회 시 저장을 시도해도 usePatientCrud의 silent
// guard에 막혀 아무 일도 안 일어나므로, canMutate=false일 때는 로컬 오버라이드로만 전환해야
// 한다. StepContent가 read-only일 때 씌우는 것과 동일한 capture-phase 핸들러 안에서
// 검증한다 — 단독 렌더 후 클릭만 하면 data-readonly-allow가 빠져도 통과해버려 무의미하다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SpineEvaluation } from '../SpineEvaluation.jsx';
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

function makePatient({ id = 'p1', activeSpineTab } = {}) {
  return {
    id,
    data: {
      shared: { jobs: [] },
      module: activeSpineTab ? { activeSpineTab } : {},
    },
  };
}

function renderSpine(props = {}, { readOnlyWrapper = false } = {}) {
  const el = (
    <SpineEvaluation
      patient={makePatient()}
      calc={{}}
      updateModule={vi.fn()}
      errors={{}}
      canMutate={true}
      {...props}
    />
  );
  return readOnlyWrapper ? render(<ReadOnlyWrapper>{el}</ReadOnlyWrapper>) : render(el);
}

describe('SpineEvaluation — MDDM/전신진동 탭 (canMutate=true, 기존 동작)', () => {
  it('편집 가능할 때 탭을 누르면 updateModule로 activeSpineTab을 저장한다', async () => {
    const user = userEvent.setup();
    const updateModule = vi.fn();
    renderSpine({ updateModule });

    await user.click(screen.getByRole('button', { name: '전신진동(BK2110)' }));
    expect(updateModule).toHaveBeenCalled();
    const updater = updateModule.mock.calls[0][0];
    expect(updater({ activeSpineTab: 'mddm' })).toMatchObject({ activeSpineTab: 'wbv' });
  });
});

describe('SpineEvaluation — read-only(비담당 환자) 래퍼 안에서의 탭 전환', () => {
  it('canMutate=false일 때 탭을 눌러도 updateModule은 호출되지 않는다', async () => {
    const user = userEvent.setup();
    const updateModule = vi.fn();
    renderSpine({ canMutate: false, updateModule }, { readOnlyWrapper: true });

    await user.click(screen.getByRole('button', { name: '전신진동(BK2110)' }));
    expect(updateModule).not.toHaveBeenCalled();
  });

  it('canMutate=false일 때도 read-only 래퍼 안에서 클릭이 통과해 화면이 실제로 바뀐다', async () => {
    const user = userEvent.setup();
    renderSpine({ canMutate: false }, { readOnlyWrapper: true });

    // 초기값(activeSpineTab 없음 → 'mddm')은 "요추 압박력(MDDM)"가 active.
    expect(screen.getByRole('button', { name: '요추 압박력(MDDM)' }).className).toContain('btn-primary');
    await user.click(screen.getByRole('button', { name: '전신진동(BK2110)' }));
    expect(screen.getByRole('button', { name: '전신진동(BK2110)' }).className).toContain('btn-primary');
  });

  it('canMutate가 false→true로 바뀌면 오버라이드가 사라지고 저장된 탭을 다시 따른다', async () => {
    const user = userEvent.setup();
    const { rerender } = renderSpine({ canMutate: false, patient: makePatient({ activeSpineTab: 'mddm' }) });

    await user.click(screen.getByRole('button', { name: '전신진동(BK2110)' }));
    expect(screen.getByRole('button', { name: '전신진동(BK2110)' }).className).toContain('btn-primary');

    rerender(
      <SpineEvaluation
        patient={makePatient({ activeSpineTab: 'mddm' })}
        calc={{}}
        updateModule={vi.fn()}
        errors={{}}
        canMutate={true}
      />
    );

    expect(screen.getByRole('button', { name: '요추 압박력(MDDM)' }).className).toContain('btn-primary');
  });

  it('환자 A에서 만든 오버라이드가 저장값이 같은 환자 B로 새지 않는다(핵심 회귀 — patient.id 누락 시 재현됨)', async () => {
    const user = userEvent.setup();
    // A, B 모두 저장된 activeSpineTab이 'mddm'으로 동일 — canMutate/savedTab만 의존성이면
    // 환자가 바뀌어도 값이 안 바뀐 것으로 보여 리셋 effect가 실행되지 않는다.
    const { rerender } = renderSpine(
      { canMutate: false, patient: makePatient({ id: 'patient-a', activeSpineTab: 'mddm' }) },
      { readOnlyWrapper: true }
    );

    await user.click(screen.getByRole('button', { name: '전신진동(BK2110)' }));
    expect(screen.getByRole('button', { name: '전신진동(BK2110)' }).className).toContain('btn-primary');

    rerender(
      <ReadOnlyWrapper>
        <SpineEvaluation
          patient={makePatient({ id: 'patient-b', activeSpineTab: 'mddm' })}
          calc={{}}
          updateModule={vi.fn()}
          errors={{}}
          canMutate={false}
        />
      </ReadOnlyWrapper>
    );

    // 환자 B는 자신의 저장값(mddm)대로 보여야 한다 — A에서 누른 'wbv' 오버라이드가 새어 들어오면 안 된다.
    expect(screen.getByRole('button', { name: '요추 압박력(MDDM)' }).className).toContain('btn-primary');
    expect(screen.getByRole('button', { name: '전신진동(BK2110)' }).className).not.toContain('btn-primary');
  });
});
