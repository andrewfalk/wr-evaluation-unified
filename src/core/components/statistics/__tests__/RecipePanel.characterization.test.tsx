// @vitest-environment jsdom
//
// 레시피 패널 특성화(P2-76a, Phase 2 C9 구간 B) — 모드별(기술·이변량·상관행렬·회귀·예측) 지금 화면(DOM·폼 값)과 접힘 화면,
// 필터 편집 조작(추가·오류·제거·모두 제거·적용·예측 모드 전환 뒤 후보), 그 밖의 조작이 부르는 콜백(인자·순서)을 얼린다.
// 뒤따르는 이동·분할 PR(P2-79a-ts · P2-78b · P2-79b · P2-79c)의 안전망이다 — 이 골든은 그 PR들에서 바뀌면 안 된다.
// 입력은 `src/core/fixtures/statsScreenFixtures.ts`.
// 규칙(의도한 출력 변경에서만 갱신, 리팩터링에서는 갱신 금지): src/core/fixtures/goldenEnv.js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PreviewResponseSchema } from '@wr/contracts/stats';
import type { PreviewResponse, StatsFilter } from '@wr/contracts/stats';
import { useGoldenEnvironment } from '../../../fixtures/goldenEnv';
import { KEY, availableMethod, previewResponse, statsCatalog } from '../../../fixtures/statsScreenFixtures';
import { formState, serializeDom } from '../../../../testing/renderEvaluation';
import { RecipePanel } from '../RecipePanel';

function goldenJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

beforeEach(() => {
  useGoldenEnvironment();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface PreviewState {
  key: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  result: PreviewResponse | null;
  error: unknown;
  requestPurpose?: string;
}

type CallLog = Array<[string, ...unknown[]]>;

/** 콜백 props를 모두 기록기로 만든다(이름과 인자를 순서대로 남긴다). */
function recorders(log: CallLog) {
  // React 합성 이벤트를 그대로 넘기는 콜백(onToggleCollapse 등)은 인자 자리를 '<event>'로 적는다(이벤트 객체의 시각 등은 얼리지 않는다).
  const asArg = (a: unknown) => (a !== null && typeof a === 'object' && 'nativeEvent' in a ? '<event>' : a);
  const rec = (name: string) => (...args: unknown[]) => { log.push([name, ...args.map(asArg)]); };
  return {
    onGrainChange: rec('onGrainChange'),
    onRemoveVariable: rec('onRemoveVariable'),
    onAnalysisModeChange: rec('onAnalysisModeChange'),
    onRequestedMethodChange: rec('onRequestedMethodChange'),
    onOutcomeKeyChange: rec('onOutcomeKeyChange'),
    onStandardizePredictorsChange: rec('onStandardizePredictorsChange'),
    onInteractionTermsChange: rec('onInteractionTermsChange'),
    onSplineKeysChange: rec('onSplineKeysChange'),
    onEventLevelChange: rec('onEventLevelChange'),
    onStratifyByKeyChange: rec('onStratifyByKeyChange'),
    onAnalysisPurposeChange: rec('onAnalysisPurposeChange'),
    onDismissTransitionNotice: rec('onDismissTransitionNotice'),
    onFormulaPolicyChange: rec('onFormulaPolicyChange'),
    onFilterDraftChange: rec('onFilterDraftChange'),
    onApplyFilters: rec('onApplyFilters'),
    onRunAnalyze: rec('onRunAnalyze'),
    onToggleCollapse: rec('onToggleCollapse'),
  };
}

const IDLE: PreviewState = { key: null, status: 'idle', result: null, error: null };

function ready(result: PreviewResponse): PreviewState {
  return { key: 'k', status: 'ready', result, error: null };
}

const APPLIED_FILTER: StatsFilter = { key: KEY.age, operator: 'gte', value: 20 };

interface ScenarioProps {
  grain?: string;
  selectedKeys: string[];
  analysisMode: string;
  modeChangeBlockedNotice?: boolean;
  requestedMethod?: string | null;
  outcomeKey?: string | null;
  standardizePredictors?: boolean;
  interactionTerms?: Array<[string, string]>;
  splineKeys?: string[];
  eventLevel?: string;
  stratifyByKey?: string | null;
  analysisPurpose: string;
  transitionNotice?: { removedVariables: string[]; removedFilters: StatsFilter[] } | null;
  formulaPolicies?: Record<string, string>;
  filterDraft?: StatsFilter[];
  appliedFilters?: StatsFilter[];
  previewState?: PreviewState;
  isPreviewCurrent?: boolean;
  canExecute?: boolean;
  isAnalyzing?: boolean;
  collapsed?: boolean;
}

function panelProps(s: ScenarioProps, log: CallLog) {
  const catalog = statsCatalog();
  return {
    catalog,
    grain: s.grain ?? 'case',
    supportedGrains: catalog.supportedGrains,
    unsupportedGrains: catalog.unsupportedGrains,
    selectedKeys: s.selectedKeys,
    analysisMode: s.analysisMode,
    modeChangeBlockedNotice: s.modeChangeBlockedNotice ?? false,
    requestedMethod: s.requestedMethod ?? null,
    outcomeKey: s.outcomeKey ?? null,
    standardizePredictors: s.standardizePredictors ?? false,
    interactionTerms: s.interactionTerms ?? [],
    splineKeys: s.splineKeys ?? [],
    eventLevel: s.eventLevel ?? '',
    stratifyByKey: s.stratifyByKey ?? null,
    analysisPurpose: s.analysisPurpose,
    transitionNotice: s.transitionNotice ?? null,
    formulaPolicies: s.formulaPolicies ?? {},
    filterDraft: s.filterDraft ?? [],
    appliedFilters: s.appliedFilters ?? [],
    previewState: s.previewState ?? IDLE,
    isPreviewCurrent: s.isPreviewCurrent ?? false,
    canExecute: s.canExecute ?? false,
    isAnalyzing: s.isAnalyzing ?? false,
    collapsed: s.collapsed ?? false,
    ...recorders(log),
    // 패널이 JS인 동안은 props 기본값(`unsupportedGrains = []` 등)이 추론 타입을 좁힌다(K14) — 이동 뒤에도 그대로 쓰이게 단언 하나로 맞춘다.
  } as ComponentProps<typeof RecipePanel>;
}

function snapshot(container: Element) {
  return { dom: serializeDom(container), form: formState(container) };
}

const previewError = Object.assign(new Error('잘못된 요청'), { status: 400, data: { code: 'INVALID_RECIPE', message: '잘못된 레시피' } });

function scenarios(): Array<[string, ScenarioProps]> {
  const descriptivePreview = previewResponse('descriptive', [], {
    estimability: {
      completeCaseN: null, missingRatesByVariable: { [KEY.relatedness]: 0.05, [KEY.sex]: null }, distinctAssignedDoctorClusters: 3,
      candidateParameterCount: null, eventNonEvent: [], estimabilityPolicyVersion: 'ep1',
    },
  });
  const bivariatePreview = previewResponse('bivariate', [
    availableMethod('welch_t'),
    availableMethod('mann_whitney', { status: 'conditional', reasonCode: 'LOW_EXPECTED_COUNT' }),
    availableMethod('chi_square', { status: 'unsupported', reasonCode: 'METHOD_TYPE_MISMATCH' }),
    availableMethod('anova', {
      status: 'unsupported', reasonCode: 'REQUIRES_AT_LEAST_TWO_GROUPS',
      remedy: 'Welch t 검정으로 바꾸기', remedyRecipePatch: { requestedMethod: 'welch_t' },
    }),
  ]);
  const predictionPreview = previewResponse('prediction', [availableMethod('l2_logistic', { purpose: 'prediction', methodPolicyVersion: 'v1-prediction' })], {
    limitedDisclosure: 'applied',
    estimability: {
      completeCaseN: 18, missingRatesByVariable: {}, distinctAssignedDoctorClusters: null, candidateParameterCount: 2,
      eventNonEvent: [{ variableKey: KEY.outcome, suppressed: false, events: 6, nonEvents: 12 }], estimabilityPolicyVersion: 'ep1',
    },
  });
  return [
    ['기술통계 — 그룹 변수·공식 정책 필요·전환 안내·적용된 필터·미리보기 ready(숨김 값)', {
      selectedKeys: [KEY.relatedness, KEY.cumulative, KEY.sex], analysisMode: 'descriptive', analysisPurpose: 'association',
      stratifyByKey: KEY.doctor,
      transitionNotice: { removedVariables: [KEY.outcome], removedFilters: [{ key: KEY.grade, operator: 'in', value: ['경도', '중등도'] }] },
      filterDraft: [APPLIED_FILTER], appliedFilters: [APPLIED_FILTER],
      previewState: ready(descriptivePreview), isPreviewCurrent: true, canExecute: true,
    }],
    ['기술통계 — 직업 단위·전환 막힘 안내·공식 정책 선택됨·미리보기 억제(최소 표본)', {
      grain: 'job', selectedKeys: [KEY.cumulative, KEY.vibration, KEY.age], analysisMode: 'descriptive', analysisPurpose: 'formula_audit',
      modeChangeBlockedNotice: true, formulaPolicies: { spine_cumulative: 'recompute_current' },
      filterDraft: [APPLIED_FILTER], appliedFilters: [],
      previewState: ready(previewResponse('descriptive', [], { counts: { personCount: 3, caseCount: 3, observationCount: 3, suppressed: true, minimumCohort: 10, reasonCode: 'MIN_COHORT_NOT_MET' } })),
      isPreviewCurrent: true,
    }],
    ['기술통계 — 상병 단위·선택 없음·미리보기 idle', {
      grain: 'disease', selectedKeys: [], analysisMode: 'descriptive', analysisPurpose: 'association',
    }],
    ['이변량 — 방법 목록(실행 가능·주의·불가·바꾸기 제안)·선택됨', {
      selectedKeys: [KEY.relatedness, KEY.exceeded], analysisMode: 'bivariate', analysisPurpose: 'association',
      requestedMethod: 'welch_t', previewState: ready(bivariatePreview), isPreviewCurrent: true, canExecute: true,
    }],
    ['이변량 — 미리보기가 지금 조건이 아님(방법 목록 숨김)', {
      selectedKeys: [KEY.relatedness, KEY.exceeded], analysisMode: 'bivariate', analysisPurpose: 'association',
      previewState: ready(bivariatePreview), isPreviewCurrent: false,
    }],
    ['상관행렬 — 3개 선택·미리보기 계산 중', {
      selectedKeys: [KEY.relatedness, KEY.vibration, KEY.age], analysisMode: 'correlation_matrix', analysisPurpose: 'association',
      previewState: { key: 'k', status: 'loading', result: null, error: null }, isPreviewCurrent: true,
    }],
    ['상관행렬 — ready인데 방법 0개', {
      selectedKeys: [KEY.relatedness, KEY.vibration, KEY.age], analysisMode: 'correlation_matrix', analysisPurpose: 'association',
      previewState: ready(previewResponse('correlation_matrix', [])), isPreviewCurrent: true,
    }],
    ['회귀 — 결과변수·표준화·상호작용·미리보기 실패', {
      selectedKeys: [KEY.relatedness, KEY.age, KEY.sex, KEY.vibration], analysisMode: 'regression', analysisPurpose: 'association',
      outcomeKey: KEY.relatedness, standardizePredictors: true, interactionTerms: [[KEY.age, KEY.sex]], splineKeys: [KEY.vibration],
      previewState: { key: 'k', status: 'error', result: null, error: previewError, requestPurpose: 'association' }, isPreviewCurrent: true,
    }],
    ['회귀 — 범주형 결과변수(사건 레벨 입력)·결과변수 미선택 전·반복 조회 제한', {
      selectedKeys: [KEY.sex, KEY.age], analysisMode: 'regression', analysisPurpose: 'formula_audit',
      outcomeKey: KEY.sex, eventLevel: 'M',
      previewState: ready(previewResponse('regression', [], { counts: { personCount: 0, caseCount: 0, observationCount: 0, suppressed: true, minimumCohort: 10, reasonCode: 'DIFFERENCING_RATE_LIMIT' } })),
      isPreviewCurrent: true,
    }],
    ['회귀 — 선택 없음', {
      selectedKeys: [], analysisMode: 'regression', analysisPurpose: 'association',
    }],
    ['예측 — 결과변수·사건 레벨·설명변수·제외 변수·제한공개 미리보기·분석 중', {
      selectedKeys: [KEY.outcome, KEY.relatedness, KEY.exceeded], analysisMode: 'prediction', analysisPurpose: 'prediction',
      requestedMethod: 'l2_logistic', outcomeKey: KEY.outcome, eventLevel: 'true',
      filterDraft: [{ key: KEY.registeredAt, operator: 'gte', value: '2025-01-01' }], appliedFilters: [{ key: KEY.registeredAt, operator: 'gte', value: '2025-01-01' }],
      previewState: ready(predictionPreview), isPreviewCurrent: true, canExecute: false, isAnalyzing: true,
    }],
    ['예측 — 결과변수 후보 없음', {
      selectedKeys: [KEY.exceeded], analysisMode: 'prediction', analysisPurpose: 'prediction', requestedMethod: 'l2_logistic',
    }],
    ['접힘', {
      selectedKeys: [KEY.relatedness], analysisMode: 'descriptive', analysisPurpose: 'association', collapsed: true,
    }],
  ];
}

describe('RecipePanel 특성화 — 입력 모양', () => {
  it('미리보기 픽스처는 계약 스키마를 그대로 통과한다', () => {
    for (const [name, s] of scenarios()) {
      if (s.previewState?.result) expect(PreviewResponseSchema.parse(s.previewState.result), name).toEqual(s.previewState.result);
    }
  });
});

describe('RecipePanel 특성화 — 모드별 화면', () => {
  it('사례마다 DOM·폼 값을 얼린다', async () => {
    const out: Record<string, ReturnType<typeof snapshot>> = {};
    for (const [name, s] of scenarios()) {
      const log: CallLog = [];
      const { container, unmount } = render(<RecipePanel {...panelProps(s, log)} />);
      out[name] = snapshot(container);
      expect(log, name).toEqual([]);
      unmount();
    }
    await expect(goldenJson(out)).toMatchFileSnapshot('./__goldens__/recipe-panel-modes.json');
  });
});

/** 필터 초안·적용 상태와 분석 모드를 실제로 들고 있는 하네스 — 필터 편집 조작이 화면에 반영되는 모습을 얼린다. */
function FilterHarness({ log, initialMode }: { log: CallLog; initialMode: string }) {
  const [filterDraft, setFilterDraft] = useState<StatsFilter[]>([]);
  const [appliedFilters, setAppliedFilters] = useState<StatsFilter[]>([]);
  const [analysisMode, setAnalysisMode] = useState(initialMode);
  const base = panelProps({
    selectedKeys: [KEY.relatedness], analysisMode, analysisPurpose: analysisMode === 'prediction' ? 'prediction' : 'association',
  }, log);
  return (
    <RecipePanel
      {...base}
      filterDraft={filterDraft}
      appliedFilters={appliedFilters}
      onFilterDraftChange={(next: StatsFilter[]) => { log.push(['onFilterDraftChange', next]); setFilterDraft(next); }}
      onApplyFilters={() => { log.push(['onApplyFilters']); setAppliedFilters(filterDraft); }}
      onAnalysisModeChange={(m: string) => { log.push(['onAnalysisModeChange', m]); setAnalysisMode(m); }}
    />
  );
}

function editor(container: Element) {
  const card = container.querySelector('.swb-card--muted') as HTMLElement;
  const selects = card.querySelectorAll('select');
  return { card, keySelect: selects[0], operatorSelect: selects[1] };
}

describe('RecipePanel 특성화 — 필터 편집', () => {
  it('추가·입력 오류·제거·모두 제거·적용·예측 모드 후보를 단계마다 얼린다', async () => {
    const log: CallLog = [];
    const { container } = render(<FilterHarness log={log} initialMode="descriptive" />);
    const steps: Record<string, unknown> = {};
    const step = (name: string) => { steps[name] = { ...snapshot(container), calls: log.splice(0) }; };
    step('0 처음');

    // 연속형 eq에 값 없이 추가 → 오류
    fireEvent.click(within(editor(container).card).getByRole('button', { name: '필터 추가' }));
    step('1 값 없이 추가(오류)');

    // 범주형 in
    fireEvent.change(editor(container).keySelect, { target: { value: KEY.sex } });
    fireEvent.change(editor(container).operatorSelect, { target: { value: 'in' } });
    fireEvent.change(screen.getByPlaceholderText('값1, 값2, ... (쉼표로 구분)'), { target: { value: 'M,  F ,' } });
    step('2 범주형 포함 입력');
    fireEvent.click(within(editor(container).card).getByRole('button', { name: '필터 추가' }));
    step('3 범주형 포함 추가');

    // 연속형 between — 하한 > 상한 오류 뒤 고쳐서 추가
    fireEvent.change(editor(container).keySelect, { target: { value: KEY.age } });
    fireEvent.change(editor(container).operatorSelect, { target: { value: 'between' } });
    fireEvent.change(screen.getByPlaceholderText('하한'), { target: { value: '60' } });
    fireEvent.change(screen.getByPlaceholderText('상한'), { target: { value: '20' } });
    fireEvent.click(within(editor(container).card).getByRole('button', { name: '필터 추가' }));
    step('4 범위 하한>상한(오류)');
    fireEvent.change(screen.getByPlaceholderText('하한'), { target: { value: '20' } });
    fireEvent.change(screen.getByPlaceholderText('상한'), { target: { value: '60' } });
    fireEvent.click(within(editor(container).card).getByRole('button', { name: '필터 추가' }));
    step('5 범위 추가');

    // boolean eq, 결측(값 없음)
    fireEvent.change(editor(container).keySelect, { target: { value: KEY.exceeded } });
    fireEvent.change(container.querySelector('.swb-card--muted select:nth-of-type(3)') as HTMLSelectElement, { target: { value: 'false' } });
    fireEvent.click(within(editor(container).card).getByRole('button', { name: '필터 추가' }));
    fireEvent.change(editor(container).keySelect, { target: { value: KEY.registeredAt } });
    fireEvent.change(editor(container).operatorSelect, { target: { value: 'is_missing' } });
    fireEvent.click(within(editor(container).card).getByRole('button', { name: '필터 추가' }));
    step('6 참거짓·결측 추가');

    // 두 번째 칩 제거 → 적용
    fireEvent.click(screen.getAllByRole('button', { name: '필터 제거' })[1]);
    step('7 둘째 필터 제거');
    fireEvent.click(screen.getByRole('button', { name: '필터 적용' }));
    step('8 적용');

    // 예측 모드로 바꾸면 편집기가 다시 마운트되고 후보가 좁아진다
    fireEvent.click(screen.getByRole('button', { name: '예측' }));
    step('9 예측 모드 후보');

    fireEvent.click(screen.getByRole('button', { name: '필터 모두 제거' }));
    step('10 모두 제거');

    await expect(goldenJson(steps)).toMatchFileSnapshot('./__goldens__/recipe-panel-filters.json');
  });
});

describe('RecipePanel 특성화 — 그 밖의 조작이 부르는 콜백', () => {
  it('모드·목적·그레인·방법·바꾸기 제안·결과변수·고급 옵션·그룹 변수·공식 정책·칩 제거·실행·접기·안내 닫기', async () => {
    const out: Record<string, CallLog> = {};
    const [descriptive, , , bivariate, , , , regression, , , prediction, , collapsed] = scenarios();

    let log: CallLog = [];
    let r = render(<RecipePanel {...panelProps(descriptive[1], log)} />);
    fireEvent.click(screen.getByRole('button', { name: '상병(disease)' }));
    fireEvent.click(screen.getByRole('button', { name: '사례(case)' }));
    for (const label of ['기술통계', '이변량', '상관행렬', '회귀', '예측']) fireEvent.click(screen.getByRole('button', { name: label }));
    fireEvent.click(screen.getByRole('button', { name: '공식 감사' }));
    fireEvent.change(screen.getByRole('combobox', { name: '그룹 변수' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: '그룹 변수' }), { target: { value: KEY.exceeded } });
    fireEvent.change(screen.getByDisplayValue('선택 필요'), { target: { value: 'recompute_recorded_version' } });
    fireEvent.click(screen.getByRole('button', { name: `${KEY.cumulative} 제거` }));
    fireEvent.click(screen.getByRole('button', { name: '안내 닫기' }));
    fireEvent.click(screen.getByRole('button', { name: '분석 실행' }));
    fireEvent.click(screen.getByTitle('레시피 접기'));
    out['기술통계'] = log;
    r.unmount();

    log = [];
    r = render(<RecipePanel {...panelProps(bivariate[1], log)} />);
    fireEvent.click(screen.getByRole('button', { name: /Mann-Whitney/ }));
    fireEvent.click(screen.getByRole('button', { name: /카이제곱/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Welch t 검정으로 바꾸기' }));
    fireEvent.click(screen.getByRole('button', { name: `${KEY.exceeded} 제거` }));
    out['이변량'] = log;
    r.unmount();

    log = [];
    r = render(<RecipePanel {...panelProps(regression[1], log)} />);
    fireEvent.change(screen.getByRole('combobox', { name: '결과변수' }), { target: { value: KEY.age } });
    fireEvent.change(screen.getByRole('combobox', { name: '결과변수' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /표준화/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: '전신진동 일일노출량' }));
    fireEvent.click(screen.getByRole('button', { name: 'interaction 제거' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'interaction 변수 A' }), { target: { value: KEY.age } });
    fireEvent.change(screen.getByRole('combobox', { name: 'interaction 변수 B' }), { target: { value: KEY.sex } });
    fireEvent.click(screen.getByRole('button', { name: 'Interaction 추가' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'interaction 변수 A' }), { target: { value: KEY.sex } });
    fireEvent.change(screen.getByRole('combobox', { name: 'interaction 변수 B' }), { target: { value: KEY.sex } });
    fireEvent.click(screen.getByRole('button', { name: 'Interaction 추가' }));
    fireEvent.click(screen.getByRole('button', { name: `${KEY.age} 제거` }));
    out['회귀'] = log;
    r.unmount();

    log = [];
    r = render(<RecipePanel {...panelProps({ ...regression[1], outcomeKey: KEY.sex, interactionTerms: [], splineKeys: [] }, log)} />);
    fireEvent.change(screen.getByRole('textbox', { name: '사건 레벨' }), { target: { value: 'F' } });
    out['회귀 — 범주형 결과변수 사건 레벨'] = log;
    r.unmount();

    log = [];
    r = render(<RecipePanel {...panelProps(prediction[1], log)} />);
    fireEvent.change(screen.getByRole('combobox', { name: '사건 레벨' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: '결과변수' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: `${KEY.relatedness} 제거` }));
    out['예측'] = log;
    r.unmount();

    log = [];
    r = render(<RecipePanel {...panelProps(collapsed[1], log)} />);
    fireEvent.click(screen.getByTitle('레시피 펼치기'));
    out['접힘'] = log;
    r.unmount();

    await expect(goldenJson(out)).toMatchFileSnapshot('./__goldens__/recipe-panel-callbacks.json');
  });
});
