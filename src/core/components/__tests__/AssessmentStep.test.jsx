// @vitest-environment jsdom
//
// 종합소견(b8) 직접 편집 UI 검증. AssessmentGroupView.test.jsx의 렌더 방식을 따르되,
// generateUnifiedEMR/resolveAssessment는 목킹해 텍스트 생성 로직(다른 테스트가 이미
// 검증)과 분리하고 편집 UI 자체의 상태 전이만 본다. activeModules=[]로 AssessmentTab을
// 렌더하지 않아 모듈 레지스트리 없이도 이 컴포넌트만 격리해 테스트할 수 있다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AssessmentStep } from '../AssessmentStep.jsx';

const mockResolveAssessment = vi.fn();

vi.mock('../../utils/emrReport', () => ({
  generateUnifiedEMR: (patient, groupOverride) => ({
    b8: groupOverride ? 'GENERATED-GROUP' : 'GENERATED-INDIVIDUAL',
  }),
  resolveAssessment: (...args) => mockResolveAssessment(...args),
}));

vi.mock('../../utils/platform', () => ({
  showConfirm: vi.fn(async () => true),
}));

import { showConfirm } from '../../utils/platform';

afterEach(cleanup);

function autoState(generated) {
  return { text: generated, generated, isOverride: false, isStale: false, hasInvalidOverride: false };
}

function overrideState({ text = 'EDITED-TEXT', generated = 'GENERATED-INDIVIDUAL', isStale = false, hasInvalidOverride = false } = {}) {
  if (hasInvalidOverride) return { text: generated, generated, isOverride: false, isStale: false, hasInvalidOverride: true };
  return { text, generated, isOverride: true, isStale, hasInvalidOverride: false };
}

function makePatient({ reportOptions, groupAssessmentResults = false } = {}) {
  return {
    id: 'p1',
    data: {
      shared: {
        diagnoses: [],
        reportOptions: reportOptions ?? { groupAssessmentResults },
      },
      modules: {},
      activeModules: [],
    },
  };
}

function setup({ patient = makePatient(), resolveImpl, canMutate = true } = {}) {
  mockResolveAssessment.mockImplementation(resolveImpl || ((_p, generated) => autoState(generated)));
  const updateShared = vi.fn();
  const utils = render(
    <AssessmentStep
      patient={patient}
      activeModules={[]}
      updateDiagnoses={vi.fn()}
      updateModuleById={vi.fn()}
      updateShared={updateShared}
      canMutate={canMutate}
      onEditingChange={vi.fn()}
    />
  );
  return { ...utils, updateShared, patient };
}

// updateShared는 함수형 업데이터를 받는다(usePatientCrud.js) — 테스트에서는 이전 shared를
// 넘겨 결과 shared를 직접 계산해 검증한다.
function applyUpdateShared(updateShared, prevShared) {
  const call = updateShared.mock.calls.at(-1)[0];
  return typeof call === 'function' ? call(prevShared) : call;
}

beforeEach(() => {
  mockResolveAssessment.mockReset();
  showConfirm.mockClear();
  showConfirm.mockResolvedValue(true);
});

describe('AssessmentStep — 오버라이드 없음(자동 생성) 상태', () => {
  it('버튼 라벨은 "직접 편집"이고 클릭하면 "편집 완료"로 토글된다', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByRole('button', { name: /직접 편집/ })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /직접 편집/ }));

    expect(screen.getByRole('button', { name: /편집 완료/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '✏ 직접 편집' })).toBeNull();
  });

  it('비교 탭(그룹)을 보고 있다가 편집 진입하면 저장된 전송 형식(개별) 기준으로 draft가 채워진다', async () => {
    const user = userEvent.setup();
    // groupAssessmentResults: false → 저장된 전송 형식은 "개별"
    setup({ patient: makePatient({ groupAssessmentResults: false }) });

    await user.click(screen.getByRole('tab', { name: /종합소견\(그룹\)/ }));
    expect(screen.getByText('GENERATED-GROUP')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /직접 편집/ }));

    const textarea = screen.getByLabelText('종합소견 직접 편집');
    expect(textarea.value).toBe('GENERATED-INDIVIDUAL');
  });

  it('공백만 입력하면 "편집 완료" 버튼이 비활성화된다', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /직접 편집/ }));

    const textarea = screen.getByLabelText('종합소견 직접 편집');
    await user.clear(textarea);
    await user.type(textarea, '   ');

    expect(screen.getByRole('button', { name: /편집 완료/ }).disabled).toBe(true);
  });

  it('편집 중 게이지는 draft 기준으로 바뀐다(자동 생성본이 아니라)', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /직접 편집/ }));

    const textarea = screen.getByLabelText('종합소견 직접 편집');
    await user.clear(textarea);
    await user.type(textarea, 'AB');

    expect(screen.getByText('2 / 3,950 byte')).toBeTruthy();
  });

  it('[취소]를 누르면 draft를 버리고 저장하지 않는다', async () => {
    const user = userEvent.setup();
    const { updateShared } = setup();
    await user.click(screen.getByRole('button', { name: /직접 편집/ }));

    const textarea = screen.getByLabelText('종합소견 직접 편집');
    await user.type(textarea, ' 수정');
    await user.click(screen.getByRole('button', { name: '취소' }));

    expect(updateShared).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /직접 편집/ })).toBeTruthy();
    expect(screen.getByText('GENERATED-INDIVIDUAL')).toBeTruthy();
  });

  it('[편집 완료]를 누르면 baseText를 현재 자동 생성본으로 캡처해 저장한다(신규 편집)', async () => {
    const user = userEvent.setup();
    const { updateShared } = setup();
    await user.click(screen.getByRole('button', { name: /직접 편집/ }));

    const textarea = screen.getByLabelText('종합소견 직접 편집');
    await user.clear(textarea);
    await user.type(textarea, '의사가 다듬은 문장');
    await user.click(screen.getByRole('button', { name: /편집 완료/ }));

    const nextShared = applyUpdateShared(updateShared, { reportOptions: { groupAssessmentResults: false } });
    expect(nextShared.reportOptions.assessmentOverride).toMatchObject({
      text: '의사가 다듬은 문장',
      baseText: 'GENERATED-INDIVIDUAL',
    });
    expect(typeof nextShared.reportOptions.assessmentOverride.updatedAt).toBe('string');
  });
});

describe('AssessmentStep — 저장된 오버라이드 상태', () => {
  const savedOverride = { text: 'EDITED-TEXT', baseText: 'STALE-BASE-TEXT', updatedAt: '2024-01-01T00:00:00.000Z' };

  it('편집본(전송됨)/현재 자동 생성본 탭으로 비교하고 편집본에는 "전송 형식" 배지가 붙는다', async () => {
    const user = userEvent.setup();
    setup({
      patient: makePatient({ reportOptions: { groupAssessmentResults: false, assessmentOverride: savedOverride } }),
      resolveImpl: (_p, generated) => overrideState({ text: savedOverride.text, generated }),
    });

    expect(screen.getByText('EDITED-TEXT')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /편집본.*전송 형식/s })).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: '현재 자동 생성본' }));
    expect(screen.getByText('GENERATED-INDIVIDUAL')).toBeTruthy();
  });

  it('재편집 시 draft는 편집본으로 채워지고, 저장해도 저장된 baseText가 그대로 유지된다(재캡처 금지)', async () => {
    const user = userEvent.setup();
    const { updateShared } = setup({
      patient: makePatient({ reportOptions: { groupAssessmentResults: false, assessmentOverride: savedOverride } }),
      resolveImpl: (_p, generated) => overrideState({ text: savedOverride.text, generated }),
    });

    await user.click(screen.getByRole('button', { name: /직접 편집/ }));
    const textarea = screen.getByLabelText('종합소견 직접 편집');
    expect(textarea.value).toBe('EDITED-TEXT');

    await user.type(textarea, ' 추가수정');
    await user.click(screen.getByRole('button', { name: /편집 완료/ }));

    const nextShared = applyUpdateShared(updateShared, {
      reportOptions: { groupAssessmentResults: false, assessmentOverride: savedOverride },
    });
    // baseText가 현재 자동 생성본(GENERATED-INDIVIDUAL)으로 재캡처되지 않고 저장된 값 그대로다.
    expect(nextShared.reportOptions.assessmentOverride.baseText).toBe('STALE-BASE-TEXT');
    expect(nextShared.reportOptions.assessmentOverride.text).toBe('EDITED-TEXT 추가수정');
  });

  it('낡음(isStale) 상태면 배너와 "최신 반영 확인" 버튼이 뜨고, 클릭하면 baseText만 현재 생성본으로 갱신한다', async () => {
    const user = userEvent.setup();
    const { updateShared } = setup({
      patient: makePatient({ reportOptions: { groupAssessmentResults: false, assessmentOverride: savedOverride } }),
      resolveImpl: (_p, generated) => overrideState({ text: savedOverride.text, generated, isStale: true }),
    });

    expect(screen.getByText(/변경되어/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '최신 반영 확인' }));

    expect(showConfirm).toHaveBeenCalled();
    const nextShared = applyUpdateShared(updateShared, {
      reportOptions: { groupAssessmentResults: false, assessmentOverride: savedOverride },
    });
    expect(nextShared.reportOptions.assessmentOverride).toEqual({
      ...savedOverride,
      baseText: 'GENERATED-INDIVIDUAL',
    });
  });

  it('재편집만으로는(저장 없이) baseText가 갱신되지 않는다 — isStale 해제는 오직 "최신 반영 확인"', async () => {
    const user = userEvent.setup();
    setup({
      patient: makePatient({ reportOptions: { groupAssessmentResults: false, assessmentOverride: savedOverride } }),
      resolveImpl: (_p, generated) => overrideState({ text: savedOverride.text, generated, isStale: true }),
    });

    await user.click(screen.getByRole('button', { name: /직접 편집/ }));
    // 편집 진입만으로 "최신 반영 확인" 버튼이 사라지는지(배너가 편집 모드 배너로 바뀌는지)만 확인 —
    // 실제 baseText 불변은 위 재편집 테스트에서 이미 검증했다.
    expect(screen.queryByRole('button', { name: '최신 반영 확인' })).toBeNull();
    expect(screen.getByText(/직접 편집 중입니다/)).toBeTruthy();
  });

  it('[자동 생성으로 되돌리기] 확인 후 assessmentOverride 키를 제거한다', async () => {
    const user = userEvent.setup();
    const { updateShared } = setup({
      patient: makePatient({ reportOptions: { groupAssessmentResults: false, assessmentOverride: savedOverride } }),
      resolveImpl: (_p, generated) => overrideState({ text: savedOverride.text, generated }),
    });

    await user.click(screen.getByRole('button', { name: '자동 생성으로 되돌리기' }));

    expect(showConfirm).toHaveBeenCalled();
    const nextShared = applyUpdateShared(updateShared, {
      reportOptions: { groupAssessmentResults: false, assessmentOverride: savedOverride },
    });
    expect(nextShared.reportOptions).not.toHaveProperty('assessmentOverride');
  });

  it('되돌리기 확인창에서 취소하면 오버라이드가 그대로 유지된다', async () => {
    const user = userEvent.setup();
    showConfirm.mockResolvedValueOnce(false);
    const { updateShared } = setup({
      patient: makePatient({ reportOptions: { groupAssessmentResults: false, assessmentOverride: savedOverride } }),
      resolveImpl: (_p, generated) => overrideState({ text: savedOverride.text, generated }),
    });

    await user.click(screen.getByRole('button', { name: '자동 생성으로 되돌리기' }));

    expect(updateShared).not.toHaveBeenCalled();
  });
});

describe('AssessmentStep — 깨진 오버라이드 상태', () => {
  it('경고 배너와 삭제 버튼만 보이고 "직접 편집" 버튼은 숨겨진다', () => {
    setup({
      patient: makePatient({ reportOptions: { groupAssessmentResults: false, assessmentOverride: { text: '' } } }),
      resolveImpl: (_p, generated) => overrideState({ generated, hasInvalidOverride: true }),
    });

    expect(screen.getByText(/손상되어/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '깨진 편집 데이터 삭제' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /직접 편집/ })).toBeNull();
    expect(screen.getByText('GENERATED-INDIVIDUAL')).toBeTruthy();
  });

  it('삭제 버튼을 누르면 확인 후 assessmentOverride 키를 제거해 자동 생성 상태로 복귀한다', async () => {
    const user = userEvent.setup();
    const brokenOverride = { text: '' };
    const { updateShared } = setup({
      patient: makePatient({ reportOptions: { groupAssessmentResults: false, assessmentOverride: brokenOverride } }),
      resolveImpl: (_p, generated) => overrideState({ generated, hasInvalidOverride: true }),
    });

    await user.click(screen.getByRole('button', { name: '깨진 편집 데이터 삭제' }));

    expect(showConfirm).toHaveBeenCalled();
    const nextShared = applyUpdateShared(updateShared, {
      reportOptions: { groupAssessmentResults: false, assessmentOverride: brokenOverride },
    });
    expect(nextShared.reportOptions).not.toHaveProperty('assessmentOverride');
  });
});

describe('AssessmentStep — canMutate=false(읽기 전용/잠금 상실)', () => {
  it('읽기 전용이면 "직접 편집" 버튼이 비활성화된다', () => {
    setup({ canMutate: false });
    expect(screen.getByRole('button', { name: /직접 편집/ }).disabled).toBe(true);
  });
});
