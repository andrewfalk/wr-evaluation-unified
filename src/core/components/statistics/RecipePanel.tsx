import { PURPOSE_LABELS } from './purposeLabels';
import { OPERATOR_LABELS } from './recipe/labels';
import { formatFilterValue } from './recipe/filterValues';
import { MethodPicker } from './recipe/MethodPicker';
import { useRecipeDerived } from './recipe/useRecipeDerived';
import { AnalysisModeSelector, GrainSelector, TransitionNoticeBanner } from './recipe/HeaderSections';
import type { RecipePanelProps } from './recipe/types';
import { PredictionVariableSection, RegressionVariableSection, SelectedVariablesSection } from './recipe/VariableSections';
import { FilterEditor } from './recipe/FilterEditor';
import { PreviewSummary } from './recipe/PreviewSummary';

// 작업대(StatisticsWorkbench)가 이 파일에서 가져가는 타입 — P2-79b·79c에서 recipe/types.ts로 옮겼다.
export type { RecipePanelProps, RecipePreviewState, RecipeTransitionNotice } from './recipe/types';

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
  // P2-79c — 파생값 useMemo 9개는 useRecipeDerived로(호출 순서 그대로, 접힘 조기 반환보다 앞).
  const {
    catalogByKey, filterCatalogByKey, stratifyCandidates, formulaFamiliesNeedingChoice,
    predictionOutcomeCandidates, predictionPredictorKeys, predictionIgnoredKeys,
  } = useRecipeDerived({ catalog, grain, analysisMode, selectedKeys, filterDraft, stratifyByKey, analysisPurpose, outcomeKey });

  const predictionSupported = (catalog?.variables ?? []).some((v) => v.allowedAnalysisPurposes.includes('prediction'));
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
        <TransitionNoticeBanner
          transitionNotice={transitionNotice}
          catalogByKey={catalogByKey}
          onDismissTransitionNotice={onDismissTransitionNotice}
        />
        <GrainSelector
          grain={grain}
          supportedGrains={supportedGrains}
          unsupportedGrains={unsupportedGrains}
          onGrainChange={onGrainChange}
        />

        <AnalysisModeSelector
          analysisMode={analysisMode}
          onAnalysisModeChange={onAnalysisModeChange}
          predictionSupported={predictionSupported}
          modeChangeBlockedNotice={modeChangeBlockedNotice}
        />

        <div className="swb-section-label">분석 목적</div>
        {/* PR4-B2 — analysisMode==='prediction' ⇔ analysisPurpose==='prediction'
            (서버 PURPOSE_MODE_MISMATCH). 예측 모드에서는 부모가 목적을 이미
            'prediction'으로 강제·고정했으므로(handleAnalysisModeChange) 여기서
            다시 고를 필요가 없다 — 목적 선택지에서 'prediction'을 아예 제거하고
            고정 문구로 대신한다(계획서 §6단계 "purpose prediction 옵션을 제거").*/}
        {analysisMode === 'prediction' ? (
          <p className="swb-suppressed-note">예측 모드에서는 분석 목적이 &quot;예측&quot;으로 자동 고정됩니다.</p>
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
            일부 변수는 &quot;연관성&quot;에서만 허용되고 &quot;공식 감사&quot;에서는 제외됩니다.
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
                인원이 {catalog?.minimumCohort ?? 10}명 미만인 그룹은 자동으로 &quot;기타&quot;로
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
          <RegressionVariableSection
            catalogByKey={catalogByKey}
            selectedKeys={selectedKeys}
            outcomeKey={outcomeKey}
            onOutcomeKeyChange={onOutcomeKeyChange}
            onRemoveVariable={onRemoveVariable}
            standardizePredictors={standardizePredictors}
            onStandardizePredictorsChange={onStandardizePredictorsChange}
            interactionTerms={interactionTerms}
            onInteractionTermsChange={onInteractionTermsChange}
            splineKeys={splineKeys}
            onSplineKeysChange={onSplineKeysChange}
            eventLevel={eventLevel}
            onEventLevelChange={onEventLevelChange}
          />
        ) : analysisMode === 'prediction' ? (
          <PredictionVariableSection
            catalogByKey={catalogByKey}
            outcomeKey={outcomeKey}
            onOutcomeKeyChange={onOutcomeKeyChange}
            eventLevel={eventLevel}
            onEventLevelChange={onEventLevelChange}
            predictionOutcomeCandidates={predictionOutcomeCandidates}
            predictionEventLevels={predictionEventLevels}
            predictionPredictorKeys={predictionPredictorKeys}
            predictionIgnoredKeys={predictionIgnoredKeys}
            onRemoveVariable={onRemoveVariable}
          />
        ) : (
          <SelectedVariablesSection
            analysisMode={analysisMode}
            selectedKeys={selectedKeys}
            catalogByKey={catalogByKey}
            onRemoveVariable={onRemoveVariable}
          />
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
          <p className="swb-status-warn">위 &quot;공식 정책&quot;에서 선택을 완료해야 분석을 실행할 수 있습니다.</p>
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
