import { useMemo } from 'react';
import { isGrainCompatible, isPurposeCompatible } from '@wr/analytics-core/common';
import { PURPOSE_LABELS } from './purposeLabels';
import { PREDICTION_REGISTERED_AT_KEY } from './workbenchTransitions';
import { GROUPING_TYPES } from './labels';
import {
  GRAIN_DISPLAY_ORDER,
  GRAIN_LABELS,
  OPERATOR_LABELS,
} from './recipe/labels';
import type { CatalogVariable, StatsFilter } from '@wr/contracts/stats';
import type { RecipePreviewState } from './recipe/types';
import { formatFilterValue } from './recipe/filterValues';
import { MethodPicker } from './recipe/MethodPicker';
import { RegressionAdvancedOptions } from './recipe/RegressionAdvancedOptions';
import { FilterEditor } from './recipe/FilterEditor';
import { PreviewSummary } from './recipe/PreviewSummary';

// 작업대(StatisticsWorkbench)가 이 파일에서 가져가는 미리보기 상태 타입 — P2-79b에서 recipe/types.ts로 옮겼다.
export type { RecipePreviewState } from './recipe/types';

/** 모드·목적 전환으로 자동 정리된 변수·필터 안내. */
export interface RecipeTransitionNotice {
  removedVariables: string[];
  removedFilters: StatsFilter[];
}

export interface RecipePanelProps {
  catalog: { variables?: CatalogVariable[]; minimumCohort?: number } | null | undefined;
  grain?: string;
  supportedGrains?: string[];
  unsupportedGrains?: Array<{ grain: string }>;
  onGrainChange?: (grain: string) => void;
  selectedKeys: string[];
  onRemoveVariable: (key: string) => void;
  analysisMode: string;
  onAnalysisModeChange: (mode: string) => void;
  modeChangeBlockedNotice: boolean;
  requestedMethod: string | null;
  onRequestedMethodChange: (method: string) => void;
  outcomeKey: string | null;
  onOutcomeKeyChange: (key: string | null) => void;
  standardizePredictors?: boolean;
  onStandardizePredictorsChange?: (value: boolean) => void;
  interactionTerms?: Array<[string, string]>;
  onInteractionTermsChange?: (terms: Array<[string, string]>) => void;
  splineKeys?: string[];
  onSplineKeysChange?: (keys: string[]) => void;
  eventLevel?: string;
  onEventLevelChange?: (level: string) => void;
  stratifyByKey?: string | null;
  onStratifyByKeyChange?: (key: string | null) => void;
  analysisPurpose: string;
  onAnalysisPurposeChange: (purpose: string) => void;
  transitionNotice?: RecipeTransitionNotice | null;
  onDismissTransitionNotice?: () => void;
  formulaPolicies: Record<string, string>;
  onFormulaPolicyChange: (family: string, policy: string) => void;
  filterDraft: StatsFilter[];
  onFilterDraftChange: (filters: StatsFilter[]) => void;
  appliedFilters: StatsFilter[];
  onApplyFilters: () => void;
  previewState: RecipePreviewState;
  isPreviewCurrent: boolean;
  canExecute: boolean;
  isAnalyzing: boolean;
  onRunAnalyze: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

function sortGrainsForDisplay(grains: string[]): string[] {
  return [...grains].sort((a, b) => {
    const ia = GRAIN_DISPLAY_ORDER.indexOf(a);
    const ib = GRAIN_DISPLAY_ORDER.indexOf(b);
    return (ia === -1 ? GRAIN_DISPLAY_ORDER.length : ia) - (ib === -1 ? GRAIN_DISPLAY_ORDER.length : ib);
  });
}

// PR2 §5/§6 — 레시피 패널: 그레인(case 고정)·변수 칩·분석 목적·공식 정책·필터(적용 버튼으로
// 커밋)·미리보기 카드·실행 버튼. isPreviewCurrent/canExecute는 부모(StatisticsWorkbench)가
// 계산해 내려준다 — 이 컴포넌트는 그 값을 그대로 표시만 한다(계획서 §6 render 시점 판정 원칙).
export function RecipePanel({
  catalog,
  grain = 'case', supportedGrains = ['case'], unsupportedGrains = [], onGrainChange = () => {},
  selectedKeys, onRemoveVariable,
  analysisMode, onAnalysisModeChange, modeChangeBlockedNotice,
  requestedMethod, onRequestedMethodChange,
  outcomeKey, onOutcomeKeyChange,
  standardizePredictors = false, onStandardizePredictorsChange = () => {},
  interactionTerms = [], onInteractionTermsChange = () => {},
  splineKeys = [], onSplineKeysChange = () => {},
  eventLevel = '', onEventLevelChange = () => {},
  stratifyByKey = null, onStratifyByKeyChange = () => {},
  analysisPurpose, onAnalysisPurposeChange,
  transitionNotice = null, onDismissTransitionNotice = () => {},
  formulaPolicies, onFormulaPolicyChange,
  filterDraft, onFilterDraftChange, appliedFilters, onApplyFilters,
  previewState, isPreviewCurrent,
  canExecute, isAnalyzing, onRunAnalyze,
  collapsed, onToggleCollapse,
}: RecipePanelProps) {
  const catalogByKey = useMemo(
    () => new Map((catalog?.variables ?? []).map((v) => [v.key, v])),
    [catalog],
  );

  // 필터 후보 = 현재 grain과 호환되는 전체(analysisRole 계약은 별개 — filter_only도
  // 여기선 그대로 둔다). 분석 변수 선택은 CatalogPanel이 이미 grain 호환성으로 거르므로
  // 여기서는 필터 후보만 별도로 좁힌다. grain 단순화(PR0-B4 개정) — 서버와 동일한
  // isGrainCompatible로 case 브로드캐스트 안전 변수도 포함시킨다.
  const grainCatalogByKey = useMemo(
    () => new Map(Array.from(catalogByKey.entries()).filter(([, v]) => isGrainCompatible(v, grain))),
    [catalogByKey, grain],
  );

  // PR4-B2 — 예측 필터는 predictor 역할이거나 등록일(REGISTERED_AT_KEY)만 허용된다
  // (server/src/stats/recipe/validate/prediction.ts PREDICTION_FILTER_LEAKAGE — outcome이나
  // outcome과 얽힌 변수를 필터로 쓰면 결과를 미리 알고 거른 셈이 되는 정보누출을
  // 막는다, 계획서 §0단계 "필터"). 그 외 필터는 여기서 아예 후보에서 뺀다 —
  // "필터를 비활성화할 때 사유를 표시한다"(계획서 §6단계).
  const filterCatalogByKey = useMemo(() => {
    if (analysisMode !== 'prediction') return grainCatalogByKey;
    return new Map(Array.from(grainCatalogByKey.entries()).filter(
      ([k, v]) => v.predictionRole === 'predictor' || k === PREDICTION_REGISTERED_AT_KEY,
    ));
  }, [analysisMode, grainCatalogByKey]);

  // Table1 — 산식 선택 UI(formulaFamiliesNeedingChoice)가 stratifyByKey도 대상에
  // 포함하도록 neededKeys에 추가한다(그룹 변수에 산식 버전이 여러 개면 선택 가능해야
  // 한다). analysisMode!=='descriptive'면 stratifyByKey는 recipe에 실리지 않으므로 제외.
  const neededKeys = useMemo(
    () => Array.from(new Set([
      ...selectedKeys,
      ...filterDraft.map((f) => f.key),
      ...(analysisMode === 'descriptive' && stratifyByKey ? [stratifyByKey] : []),
    ])),
    [selectedKeys, filterDraft, analysisMode, stratifyByKey],
  );

  // Table1 — 그룹 변수 후보: grain 호환 + boolean/ordinal/categorical + 필터 전용
  // 아님 + 이미 분석 변수로 선택된 키 제외(양방향 충돌 방지 — StatisticsWorkbench의
  // toggleVariable 조건부 리셋과 짝을 이룬다).
  const stratifyCandidates = useMemo(() => {
    return Array.from(grainCatalogByKey.values())
      .filter((v) => GROUPING_TYPES.has(v.type) && v.analysisRole !== 'filter_only' && !selectedKeys.includes(v.key)
        // 서버는 stratifyByKey에도 분석 목적을 검사한다(PURPOSE_NOT_ALLOWED) — 선택 자체를 막는다.
        && isPurposeCompatible(v, analysisPurpose))
      .sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  }, [grainCatalogByKey, selectedKeys, analysisPurpose]);

  const formulaFamiliesNeedingChoice = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const key of neededKeys) {
      const v = catalogByKey.get(key);
      if (!v || seen.has(v.formulaFamily)) continue;
      seen.add(v.formulaFamily);
      if (v.supportedFormulaPolicies.length > 1) out.push(v);
    }
    return out;
  }, [neededKeys, catalogByKey]);

  const predictionSupported = (catalog?.variables ?? []).some((v) => v.allowedAnalysisPurposes.includes('prediction'));
  // PR4-B2 — 계획서 §6단계 "outcome과 predictor를 역할별로 필터링한다". CatalogPanel은
  // predictionRole과 무관하게 체크를 허용하므로(회귀와 동일한 원칙 — 역할 제약이 없는
  // 모드도 있다), 여기서 selectedKeys를 역할로 다시 나눈다. StatisticsWorkbench.jsx의
  // predictionEffectiveVariableKeys/isRecipeComplete와 같은 필터 로직이다 — 실제로
  // recipe에 담기는 집합과 화면에 보이는 집합이 어긋나면 안 된다.
  const predictionOutcomeCandidates = useMemo(
    () => selectedKeys.filter((k) => catalogByKey.get(k)?.predictionRole === 'outcome'),
    [selectedKeys, catalogByKey],
  );
  const predictionPredictorKeys = useMemo(
    () => selectedKeys.filter((k) => k !== outcomeKey && catalogByKey.get(k)?.predictionRole === 'predictor'),
    [selectedKeys, outcomeKey, catalogByKey],
  );
  const predictionIgnoredKeys = useMemo(
    () => selectedKeys.filter((k) => k !== outcomeKey && catalogByKey.get(k)?.predictionRole !== 'predictor'),
    [selectedKeys, outcomeKey, catalogByKey],
  );
  // DTO 필드(server/src/stats/routes/catalogPreview.ts toCatalogVariableDto) — 자유입력이 아니라 이 목록에서만
  // 고른다(계획서 §6단계 "eventLevel select는 DTO의 predictionEventLevels에서 만든다").
  const predictionEventLevels = outcomeKey ? (catalogByKey.get(outcomeKey)?.predictionEventLevels ?? []) : [];
  const filtersDirty = JSON.stringify(filterDraft) !== JSON.stringify(appliedFilters);
  const missingFormulaPolicy = formulaFamiliesNeedingChoice.some((v) => !formulaPolicies[v.formulaFamily]);

  if (collapsed) {
    return (
      <aside className="swb-panel swb-panel--collapsed" aria-label="분석 레시피(접힘)">
        <div className="swb-panel-header">
          <button type="button" className="swb-collapse-btn" onClick={onToggleCollapse} aria-expanded={false} title="레시피 펼치기">›</button>
        </div>
        <div className="swb-panel-rail">분석 레시피</div>
      </aside>
    );
  }

  return (
    <aside className="swb-panel swb-panel--recipe" aria-label="분석 레시피">
      <div className="swb-panel-header">
        <span>분석 레시피</span>
        <button type="button" className="swb-collapse-btn" onClick={onToggleCollapse} aria-expanded title="레시피 접기">‹</button>
      </div>
      <div className="swb-panel-body">
        {transitionNotice && (
          <div className="swb-status-warn" role="status" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              {transitionNotice.removedVariables.length > 0 && (
                <p>
                  이 분석 목적에서 쓸 수 없는 변수 {transitionNotice.removedVariables.length}개를 선택에서 해제했습니다:
                  {' '}{transitionNotice.removedVariables.join(', ')}
                </p>
              )}
              {transitionNotice.removedFilters.length > 0 && (
                <p>
                  예측 모드에서 쓸 수 없는 필터 {transitionNotice.removedFilters.length}개를 제거했습니다:
                  {' '}{transitionNotice.removedFilters.map((f) => `${catalogByKey.get(f.key)?.label || f.key} ${OPERATOR_LABELS[f.operator] || f.operator} ${formatFilterValue(f.operator, f.value)}`.trim()).join(', ')}
                </p>
              )}
            </div>
            <button type="button" className="swb-btn swb-btn--sm" onClick={onDismissTransitionNotice} aria-label="안내 닫기">닫기</button>
          </div>
        )}
        <div className="swb-section-label">그레인</div>
        <div className="swb-seg">
          {sortGrainsForDisplay(supportedGrains).map((g) => (
            <button
              key={g}
              type="button"
              className={`swb-seg-opt${grain === g ? ' swb-seg-opt--active' : ''}`}
              onClick={() => onGrainChange(g)}
            >{GRAIN_LABELS[g] || g}</button>
          ))}
        </div>
        {unsupportedGrains?.length > 0 && (
          <p className="swb-suppressed-note">
            나머지 {unsupportedGrains.length}종은 아직 지원하지 않습니다: {unsupportedGrains.map((u) => GRAIN_LABELS[u.grain] || u.grain).join(', ')}
          </p>
        )}
        {/* grain 단순화 개정(PR0-B4) — job/disease 기술통계는 case 단위가 아니라 관측 행
            단위다. 브로드캐스트된 인적사항(성별 등)도 그 행 수만큼 반복 집계되므로 사람이
            job을 여러 개 가지면 고유 인원 분포처럼 보이지 않는다 — 계획서 "행 단위 가중
            한계" 절, 오해 방지를 위해 grain 선택 즉시 명시한다. */}
        {(grain === 'job' || grain === 'disease') && (
          <p className="swb-suppressed-note">
            {GRAIN_LABELS[grain]} 기술통계는 <strong>관측 행 기준</strong>입니다 — 브로드캐스트된 인적사항(성별 등)도 그 행 수만큼 반영됩니다(고유 인원 분포가 아닙니다).{' '}
            {grain === 'job'
              ? '예: 한 사람이 직업을 3개 가지면 그 사람의 값이 3행에 그대로 반복됩니다.'
              : '예: 양측 상병 하나는 좌·우 2행으로 나뉘고, 그 사람의 값이 2행에 그대로 반복됩니다.'}
          </p>
        )}

        {/* PR3-A — 분석 모드. 전환은 부모(StatisticsWorkbench.handleAnalysisModeChange)가
            3개 이상 선택 시 막는다(암묵적 선택 손실 방지, 계획서 §클라이언트배선). */}
        <div className="swb-section-label">분석 모드</div>
        <div className="swb-seg">
          <button
            type="button"
            className={`swb-seg-opt${analysisMode === 'descriptive' ? ' swb-seg-opt--active' : ''}`}
            onClick={() => onAnalysisModeChange('descriptive')}
          >기술통계</button>
          <button
            type="button"
            className={`swb-seg-opt${analysisMode === 'bivariate' ? ' swb-seg-opt--active' : ''}`}
            onClick={() => onAnalysisModeChange('bivariate')}
          >이변량</button>
          {/* PR3-B — 상관행렬(계획서 §4). 3개 이상의 연속형 변수를 골라 모든 쌍의
              상관계수를 계산한다. */}
          <button
            type="button"
            className={`swb-seg-opt${analysisMode === 'correlation_matrix' ? ' swb-seg-opt--active' : ''}`}
            onClick={() => onAnalysisModeChange('correlation_matrix')}
          >상관행렬</button>
          {/* PR4-A1 — 연관성 회귀(계획서 §5). 결과변수 1개 + 설명변수 1개 이상. */}
          <button
            type="button"
            className={`swb-seg-opt${analysisMode === 'regression' ? ' swb-seg-opt--active' : ''}`}
            onClick={() => onAnalysisModeChange('regression')}
          >회귀</button>
          {/* PR4-B2 — 예측(계획서 §6단계). outcome/predictor는 predictionRole로
              정해진 역할제 선택이라 회귀와 다른 UI를 쓴다(아래). */}
          <button
            type="button"
            className={`swb-seg-opt${analysisMode === 'prediction' ? ' swb-seg-opt--active' : ''}`}
            disabled={!predictionSupported}
            onClick={() => onAnalysisModeChange('prediction')}
            title={!predictionSupported ? '현재 지원 변수 없음' : undefined}
          >예측</button>
        </div>
        {modeChangeBlockedNotice && analysisMode !== 'bivariate' && (
          <p className="swb-status-warn">이변량 모드는 변수를 2개까지만 지원합니다 — 먼저 2개로 줄여주세요.</p>
        )}

        <div className="swb-section-label">분석 목적</div>
        {/* PR4-B2 — analysisMode==='prediction' ⇔ analysisPurpose==='prediction'
            (서버 PURPOSE_MODE_MISMATCH). 예측 모드에서는 부모가 목적을 이미
            'prediction'으로 강제·고정했으므로(handleAnalysisModeChange) 여기서
            다시 고를 필요가 없다 — 목적 선택지에서 'prediction'을 아예 제거하고
            고정 문구로 대신한다(계획서 §6단계 "purpose prediction 옵션을 제거").*/}
        {analysisMode === 'prediction' ? (
          <p className="swb-suppressed-note">예측 모드에서는 분석 목적이 "예측"으로 자동 고정됩니다.</p>
        ) : (
          <div className="swb-seg">
            {['association', 'formula_audit'].map((p) => (
              <button
                key={p}
                type="button"
                className={`swb-seg-opt${analysisPurpose === p ? ' swb-seg-opt--active' : ''}`}
                onClick={() => onAnalysisPurposeChange(p)}
              >{PURPOSE_LABELS[p as keyof typeof PURPOSE_LABELS]}</button>
            ))}
          </div>
        )}
        {analysisMode === 'descriptive' && (
          <p className="swb-suppressed-note">
            목적은 기술통계 자체를 바꾸지 않지만, 선택 가능한 변수 범위에 영향을 줍니다 —
            일부 변수는 "연관성"에서만 허용되고 "공식 감사"에서는 제외됩니다.
          </p>
        )}

        {/* Table1 스트라티피케이션 — 그룹별 비교(선택). 회귀 결과변수 select(아래
            §"결과변수" 블록)와 같은 패턴이나, 축이 독립적이라(행=variableKeys,
            열=그룹) selectedKeys를 소비하지 않고 grain 호환 카탈로그 전체에서
            고른다. */}
        {analysisMode === 'descriptive' && (
          <>
            <div className="swb-section-label">그룹별 비교(선택)</div>
            <select
              className="swb-search"
              aria-label="그룹 변수"
              value={stratifyByKey || ''}
              onChange={(e) => onStratifyByKeyChange(e.target.value || null)}
            >
              <option value="">사용 안 함</option>
              {stratifyCandidates.map((v) => (
                <option key={v.key} value={v.key}>{v.label}</option>
              ))}
            </select>
            {stratifyByKey && (
              <p className="swb-suppressed-note">
                인원이 {catalog?.minimumCohort ?? 10}명 미만인 그룹은 자동으로 "기타"로
                합쳐집니다. 병합 후에도 인원이 부족하면 해당 그룹의 값은 공개되지 않습니다.
              </p>
            )}
          </>
        )}

        {(analysisMode === 'bivariate' || analysisMode === 'correlation_matrix' || analysisMode === 'regression' || analysisMode === 'prediction') && (
          <MethodPicker
            previewState={previewState}
            isPreviewCurrent={isPreviewCurrent}
            requestedMethod={requestedMethod}
            onRequestedMethodChange={onRequestedMethodChange}
            onApplyRemedy={(patch) => { if (patch?.requestedMethod) onRequestedMethodChange(patch.requestedMethod); }}
            notReadyMessage={analysisMode === 'correlation_matrix'
              ? '연속형 변수를 3개 이상 선택하면 사용 가능한 방법이 표시됩니다.'
              : analysisMode === 'regression' || analysisMode === 'prediction'
                ? '결과변수 1개와 설명변수 1개 이상을 선택하면 사용 가능한 방법이 표시됩니다.'
                : '변수를 2개 선택하면 사용 가능한 방법이 표시됩니다.'}
          />
        )}

        {/* PR4-A1 §5 — 회귀는 기존 "선택 변수" 칩 목록과 다른 UI를 쓴다: 결과변수
            (outcome)는 <select>로 역할을 지정하고, 나머지가 설명변수(predictor)로
            파생된다. CatalogPanel의 체크박스 선택은 그대로 재사용 — 여기서는
            "이미 고른 변수들 중 무엇이 outcome인지"만 정한다(새로 고르지 않음). */}
        {analysisMode === 'regression' ? (
          <>
            <div className="swb-section-label">결과변수(outcome, 1개)</div>
            {selectedKeys.length === 0 && (
              <p className="swb-suppressed-note">좌측 카탈로그에서 변수를 2개 이상 선택하세요.</p>
            )}
            {selectedKeys.length > 0 && (
              <select
                className="swb-search"
                aria-label="결과변수"
                value={outcomeKey || ''}
                onChange={(e) => onOutcomeKeyChange(e.target.value || null)}
              >
                <option value="">선택 필요</option>
                {selectedKeys.map((k) => (
                  <option key={k} value={k}>{catalogByKey.get(k)?.label || k}</option>
                ))}
              </select>
            )}
            <div className="swb-section-label">
              설명변수(predictor, {Math.max(selectedKeys.length - (outcomeKey ? 1 : 0), 0)}개)
            </div>
            <div>
              {selectedKeys.filter((k) => k !== outcomeKey).length === 0 && (
                <p className="swb-suppressed-note">결과변수 외에 설명변수를 1개 이상 선택하세요.</p>
              )}
              {selectedKeys.filter((k) => k !== outcomeKey).map((k) => (
                <span key={k} className="swb-recipe-chip">
                  {catalogByKey.get(k)?.label || k}
                  <button type="button" onClick={() => onRemoveVariable(k)} aria-label={`${k} 제거`}>×</button>
                </span>
              ))}
            </div>

            <RegressionAdvancedOptions
              catalogByKey={catalogByKey}
              outcomeKey={outcomeKey}
              predictorKeys={selectedKeys.filter((k) => k !== outcomeKey)}
              standardizePredictors={standardizePredictors}
              onStandardizePredictorsChange={onStandardizePredictorsChange}
              interactionTerms={interactionTerms}
              onInteractionTermsChange={onInteractionTermsChange}
              splineKeys={splineKeys}
              onSplineKeysChange={onSplineKeysChange}
              eventLevel={eventLevel}
              onEventLevelChange={onEventLevelChange}
            />
          </>
        ) : analysisMode === 'prediction' ? (
          <>
            <div className="swb-section-label">결과변수(outcome, 1개)</div>
            {predictionOutcomeCandidates.length === 0 && (
              <p className="swb-suppressed-note">좌측 카탈로그에서 예측 결과변수로 쓸 수 있는 변수를 선택하세요.</p>
            )}
            {predictionOutcomeCandidates.length > 0 && (
              <select
                className="swb-search"
                aria-label="결과변수"
                value={outcomeKey || ''}
                onChange={(e) => onOutcomeKeyChange(e.target.value || null)}
              >
                <option value="">선택 필요</option>
                {predictionOutcomeCandidates.map((k) => (
                  <option key={k} value={k}>{catalogByKey.get(k)?.label || k}</option>
                ))}
              </select>
            )}

            {outcomeKey && (
              <div className="swb-section-label">
                사건 레벨(eventLevel)
                <select
                  className="swb-search"
                  aria-label="사건 레벨"
                  value={eventLevel}
                  onChange={(e) => onEventLevelChange(e.target.value)}
                >
                  <option value="">선택 필요</option>
                  {predictionEventLevels.map((lvl) => <option key={lvl} value={lvl}>{lvl}</option>)}
                </select>
              </div>
            )}

            <div className="swb-section-label">설명변수(predictor, {predictionPredictorKeys.length}개)</div>
            <div>
              {predictionPredictorKeys.length === 0 && (
                <p className="swb-suppressed-note">결과변수 외에 예측 설명변수를 1개 이상 선택하세요.</p>
              )}
              {predictionPredictorKeys.map((k) => (
                <span key={k} className="swb-recipe-chip">
                  {catalogByKey.get(k)?.label || k}
                  <button type="button" onClick={() => onRemoveVariable(k)} aria-label={`${k} 제거`}>×</button>
                </span>
              ))}
            </div>
            {predictionIgnoredKeys.length > 0 && (
              <p className="swb-suppressed-note">
                선택했지만 예측에는 쓸 수 없는 변수 {predictionIgnoredKeys.length}개는 제외됩니다:{' '}
                {predictionIgnoredKeys.map((k) => catalogByKey.get(k)?.label || k).join(', ')}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="swb-section-label">
              선택 변수 ({selectedKeys.length}
              {analysisMode === 'bivariate' ? '/2' : analysisMode === 'correlation_matrix' ? ', 3개 이상' : ''})
            </div>
            <div>
              {selectedKeys.length === 0 && (
                <p className="swb-suppressed-note">
                  좌측 카탈로그에서 변수를 선택하세요.
                  {analysisMode === 'correlation_matrix' && ' (연속형 변수만 3개 이상)'}
                </p>
              )}
              {selectedKeys.map((k, i) => (
                <span key={k} className="swb-recipe-chip">
                  {analysisMode === 'bivariate' && <strong style={{ marginRight: 4 }}>{i === 0 ? 'x' : 'y'}</strong>}
                  {catalogByKey.get(k)?.label || k}
                  <button type="button" onClick={() => onRemoveVariable(k)} aria-label={`${k} 제거`}>×</button>
                </span>
              ))}
            </div>
          </>
        )}

        {formulaFamiliesNeedingChoice.length > 0 && (
          <>
            <div className="swb-section-label">공식 정책</div>
            {formulaFamiliesNeedingChoice.map((v) => (
              <div key={v.formulaFamily} style={{ marginBottom: 6 }}>
                <label style={{ fontSize: 11, color: 'var(--swb-ink-muted)' }}>{v.formulaFamily}</label>
                <select
                  className="swb-search"
                  value={formulaPolicies[v.formulaFamily] || ''}
                  onChange={(e) => onFormulaPolicyChange(v.formulaFamily, e.target.value)}
                >
                  <option value="">선택 필요</option>
                  {v.supportedFormulaPolicies.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            ))}
          </>
        )}

        <div className="swb-section-label">필터 ({appliedFilters.length}개 적용됨)</div>
        {analysisMode === 'prediction' && (
          <p className="swb-suppressed-note">
            예측 모드에서는 결과와 무관한 필터만 쓸 수 있습니다 — 설명변수이거나 등록일 하나만 허용됩니다(결과를 미리 알고 거르는 정보누출 방지).
          </p>
        )}
        {filterDraft.map((f, i) => (
          <span key={`${f.key}-${i}`} className="swb-recipe-chip">
            {catalogByKey.get(f.key)?.label || f.key} {OPERATOR_LABELS[f.operator] || f.operator} {formatFilterValue(f.operator, f.value)}
            <button
              type="button"
              className="swb-chip-remove"
              onClick={() => onFilterDraftChange(filterDraft.filter((_, idx) => idx !== i))}
              aria-label="필터 제거"
              title="이 필터 제거"
            >×</button>
          </span>
        ))}
        {filterDraft.length > 1 && (
          <button type="button" className="swb-btn swb-btn--sm" style={{ margin: '2px 0' }} onClick={() => onFilterDraftChange([])}>
            필터 모두 제거
          </button>
        )}
        {filterDraft.length < 10 && (
          // key={grain} — FilterEditor는 key/operator/raw/error를 내부 useState로 갖고
          // 있어 catalogByKey prop만 바뀌는 것으로는 초기화되지 않는다(grain 전환 후
          // 이전 grain의 key가 남아 variable이 undefined가 되고 필터 추가가 조용히
          // 무동작이 될 수 있음) — grain이 바뀌면 컴포넌트를 통째로 재마운트한다.
          <FilterEditor
            key={`${grain}-${analysisMode === 'prediction' ? 'prediction' : 'other'}`}
            catalogByKey={filterCatalogByKey}
            onAdd={(f) => onFilterDraftChange([...filterDraft, f])}
          />
        )}
        {filtersDirty && (
          <button type="button" className="swb-btn swb-btn--sm" style={{ marginTop: 6 }} onClick={onApplyFilters}>
            필터 적용
          </button>
        )}

        <div className="swb-section-label">분석 범위 미리보기</div>
        <PreviewSummary previewState={previewState} isPreviewCurrent={isPreviewCurrent} catalogByKey={catalogByKey} />

        {missingFormulaPolicy && (
          <p className="swb-status-warn">위 "공식 정책"에서 선택을 완료해야 분석을 실행할 수 있습니다.</p>
        )}
        <button
          type="button"
          className="swb-btn swb-btn--primary"
          style={{ width: '100%', marginTop: 12 }}
          disabled={!canExecute || missingFormulaPolicy}
          onClick={onRunAnalyze}
        >
          {isAnalyzing ? '분석 중…' : '분석 실행'}
        </button>
      </div>
    </aside>
  );
}
