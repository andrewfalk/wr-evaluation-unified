// 레시피 패널의 모드별 변수 구역(회귀 · 예측 · 그 밖의 모드) — P2-79c에서 RecipePanel 본체의 JSX를 글자 그대로 옮겼다
// (들여쓰기만 다르다). 본체의 모드 분기(삼항)는 그대로이고, 각 가지가 이 컴포넌트를 그린다.
import { RegressionAdvancedOptions } from './RegressionAdvancedOptions';
import type { CatalogByKey } from './types';

// PR4-A1 §5 — 회귀: 결과변수(outcome)는 <select>로 역할을 지정하고 나머지가 설명변수(predictor)다.
export function RegressionVariableSection({
  catalogByKey, selectedKeys, outcomeKey, onOutcomeKeyChange, onRemoveVariable, standardizePredictors, onStandardizePredictorsChange, interactionTerms, onInteractionTermsChange, splineKeys, onSplineKeysChange, eventLevel, onEventLevelChange,
}: {
  catalogByKey: CatalogByKey;
  selectedKeys: string[];
  outcomeKey: string | null;
  onOutcomeKeyChange: (key: string | null) => void;
  onRemoveVariable: (key: string) => void;
  standardizePredictors: boolean;
  onStandardizePredictorsChange: (value: boolean) => void;
  interactionTerms: Array<[string, string]>;
  onInteractionTermsChange: (terms: Array<[string, string]>) => void;
  splineKeys: string[];
  onSplineKeysChange: (keys: string[]) => void;
  eventLevel: string;
  onEventLevelChange: (level: string) => void;
}) {
  return (
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
  );
}

// PR4-B2 — 예측: 결과변수·사건 레벨·설명변수를 predictionRole로 나눠 보여 준다.
export function PredictionVariableSection({
  catalogByKey, outcomeKey, onOutcomeKeyChange, eventLevel, onEventLevelChange, predictionOutcomeCandidates, predictionEventLevels, predictionPredictorKeys, predictionIgnoredKeys, onRemoveVariable,
}: {
  catalogByKey: CatalogByKey;
  outcomeKey: string | null;
  onOutcomeKeyChange: (key: string | null) => void;
  eventLevel: string;
  onEventLevelChange: (level: string) => void;
  predictionOutcomeCandidates: string[];
  predictionEventLevels: string[];
  predictionPredictorKeys: string[];
  predictionIgnoredKeys: string[];
  onRemoveVariable: (key: string) => void;
}) {
  return (
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
  );
}

// 기술통계·이변량·상관행렬: 선택 변수 칩(이변량은 x/y 표시).
export function SelectedVariablesSection({
  analysisMode, selectedKeys, catalogByKey, onRemoveVariable,
}: {
  analysisMode: string;
  selectedKeys: string[];
  catalogByKey: CatalogByKey;
  onRemoveVariable: (key: string) => void;
}) {
  return (
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
  );
}
