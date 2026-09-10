// @vitest-environment jsdom
// 리뷰 §1 — between/in/boolean 필터가 잘못된 타입(단일 숫자·문자열·"true"/"false" 문자열)으로
// 전송되던 결함과, 빈 숫자 입력이 Number('')===0으로 조용히 통과하던 결함을 고쳤는지 검증한다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecipePanel } from '../RecipePanel.jsx';

afterEach(cleanup);

function catalogFixture() {
  return {
    variables: [
      {
        key: 'knee.relatedness.max', label: '신체부담기여도', group: 'g', moduleId: 'knee',
        grain: 'case', type: 'continuous', unit: '%', provenance: 'derived', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true, allowedAnalysisPurposes: ['association'],
        sensitivity: 'non_sensitive', formulaFamily: 'f1', supportedFormulaPolicies: ['recompute_current'], formulaVersionKey: null,
      },
      {
        key: 'shoulder.exposure.anyExceeded', label: '노출 한도 초과', group: 'g', moduleId: 'shoulder',
        grain: 'case', type: 'boolean', unit: null, provenance: 'derived', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true, allowedAnalysisPurposes: ['association'],
        sensitivity: 'non_sensitive', formulaFamily: 'f2', supportedFormulaPolicies: ['recompute_current'], formulaVersionKey: null,
      },
      {
        key: 'elbow.assessment.burdenGradeMax', label: '팔꿈치 부담 등급', group: 'g', moduleId: 'elbow',
        grain: 'case', type: 'ordinal', unit: null, provenance: 'derived', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true, allowedAnalysisPurposes: ['association'],
        sensitivity: 'non_sensitive', formulaFamily: 'f3', supportedFormulaPolicies: ['recompute_current'], formulaVersionKey: null,
      },
    ],
    unsupportedGrains: [],
  };
}

function baseProps(overrides = {}) {
  return {
    catalog: catalogFixture(),
    selectedKeys: ['knee.relatedness.max'],
    onRemoveVariable: vi.fn(),
    analysisPurpose: 'association',
    onAnalysisPurposeChange: vi.fn(),
    formulaPolicies: {},
    onFormulaPolicyChange: vi.fn(),
    filterDraft: [],
    onFilterDraftChange: vi.fn(),
    appliedFilters: [],
    onApplyFilters: vi.fn(),
    previewState: { key: null, status: 'idle', result: null, error: null },
    isPreviewCurrent: false,
    canExecute: false,
    isAnalyzing: false,
    onRunAnalyze: vi.fn(),
    collapsed: false,
    onToggleCollapse: vi.fn(),
    ...overrides,
  };
}

describe('RecipePanel — 필터 값 타입 변환', () => {
  it('boolean 변수의 eq 필터는 문자열이 아니라 실제 boolean 값을 전달한다', async () => {
    const user = userEvent.setup();
    const onFilterDraftChange = vi.fn();
    render(<RecipePanel {...baseProps({ onFilterDraftChange })} />);

    await user.selectOptions(screen.getByDisplayValue('신체부담기여도'), '노출 한도 초과');
    await user.selectOptions(screen.getByDisplayValue('='), 'eq');
    await user.selectOptions(screen.getByDisplayValue('값 선택'), '참');
    await user.click(screen.getByRole('button', { name: '필터 추가' }));

    expect(onFilterDraftChange).toHaveBeenCalledWith([
      { key: 'shoulder.exposure.anyExceeded', operator: 'eq', value: true },
    ]);
  });

  it('continuous 변수의 between 필터는 2개짜리 숫자 배열을 전달한다(문자열·단일값 아님)', async () => {
    const user = userEvent.setup();
    const onFilterDraftChange = vi.fn();
    render(<RecipePanel {...baseProps({ onFilterDraftChange })} />);

    await user.selectOptions(screen.getByDisplayValue('='), 'between');
    await user.type(screen.getByPlaceholderText('하한'), '5');
    await user.type(screen.getByPlaceholderText('상한'), '10');
    await user.click(screen.getByRole('button', { name: '필터 추가' }));

    expect(onFilterDraftChange).toHaveBeenCalledWith([
      { key: 'knee.relatedness.max', operator: 'between', value: [5, 10] },
    ]);
  });

  it('숫자 값을 비워둔 채 추가를 누르면 0으로 대체되지 않고 거부된다', async () => {
    const user = userEvent.setup();
    const onFilterDraftChange = vi.fn();
    render(<RecipePanel {...baseProps({ onFilterDraftChange })} />);

    // eq 연산자, 값 입력 없이 바로 추가
    await user.click(screen.getByRole('button', { name: '필터 추가' }));

    expect(onFilterDraftChange).not.toHaveBeenCalled();
    expect(await screen.findByText('값을 입력하세요.')).toBeTruthy();
  });

  it('ordinal 변수의 in 필터는 쉼표 구분 입력을 문자열 배열로 변환한다', async () => {
    const user = userEvent.setup();
    const onFilterDraftChange = vi.fn();
    render(<RecipePanel {...baseProps({ onFilterDraftChange })} />);

    await user.selectOptions(screen.getByDisplayValue('신체부담기여도'), '팔꿈치 부담 등급');
    await user.selectOptions(screen.getByDisplayValue('='), 'in');
    await user.type(screen.getByPlaceholderText('값1, 값2, ... (쉼표로 구분)'), '경도, 중등도');
    await user.click(screen.getByRole('button', { name: '필터 추가' }));

    expect(onFilterDraftChange).toHaveBeenCalledWith([
      { key: 'elbow.assessment.burdenGradeMax', operator: 'in', value: ['경도', '중등도'] },
    ]);
  });

  it('between에서 하한이 상한보다 크면 거부된다', async () => {
    const user = userEvent.setup();
    const onFilterDraftChange = vi.fn();
    render(<RecipePanel {...baseProps({ onFilterDraftChange })} />);

    await user.selectOptions(screen.getByDisplayValue('='), 'between');
    await user.type(screen.getByPlaceholderText('하한'), '10');
    await user.type(screen.getByPlaceholderText('상한'), '5');
    await user.click(screen.getByRole('button', { name: '필터 추가' }));

    expect(onFilterDraftChange).not.toHaveBeenCalled();
    expect(await screen.findByText('하한이 상한보다 클 수 없습니다.')).toBeTruthy();
  });
});

describe('RecipePanel — 필터 칩 표시(3차 리뷰)', () => {
  it('값이 2개인 in 필터는 범위(~)가 아니라 목록(,)으로 표시된다', () => {
    render(<RecipePanel {...baseProps({
      filterDraft: [{ key: 'elbow.assessment.burdenGradeMax', operator: 'in', value: ['경도', '중등도'] }],
      appliedFilters: [{ key: 'elbow.assessment.burdenGradeMax', operator: 'in', value: ['경도', '중등도'] }],
    })} />);
    expect(screen.getByText(/경도, 중등도/)).toBeTruthy();
    expect(screen.queryByText(/경도 ~ 중등도/)).toBeNull();
  });

  it('between 필터는 여전히 범위(~)로 표시된다', () => {
    render(<RecipePanel {...baseProps({
      filterDraft: [{ key: 'knee.relatedness.max', operator: 'between', value: [5, 10] }],
      appliedFilters: [{ key: 'knee.relatedness.max', operator: 'between', value: [5, 10] }],
    })} />);
    expect(screen.getByText(/5 ~ 10/)).toBeTruthy();
  });
});

describe('RecipePanel — Preview estimability 표시', () => {
  it('completeCaseN과 변수별 결측률을 표시한다', () => {
    render(<RecipePanel {...baseProps({
      isPreviewCurrent: true,
      previewState: {
        key: 'k', status: 'ready',
        result: {
          counts: { personCount: 20, caseCount: 20, observationCount: 20, suppressed: false, minimumCohort: 10, reasonCode: null },
          estimability: {
            completeCaseN: 18, missingRatesByVariable: { 'knee.relatedness.max': 0.1 },
            distinctAssignedDoctorClusters: 3, candidateParameterCount: null, eventNonEvent: [],
            estimabilityPolicyVersion: 'v1',
          },
        },
        error: null,
      },
    })} />);
    expect(screen.getByText('18')).toBeTruthy();
    expect(screen.getByText('10.0%')).toBeTruthy();
  });
});
