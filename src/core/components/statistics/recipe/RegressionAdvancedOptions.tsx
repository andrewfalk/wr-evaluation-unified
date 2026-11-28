// 회귀 고급 옵션(표준화·interaction·spline·사건 레벨) — P2-79b에서 RecipePanel.tsx의 선언을 본문 그대로 옮겼다.
import { useState } from 'react';
import type { CatalogByKey } from './types';

// PR4-A2 §5 "RecipePanel.jsx" — 회귀 고급 옵션(표준화·interaction·spline·
// eventLevel). <details>/<summary>로 접어둔다(새 CSS/JS 의존성 없이 접근성
// 기본값 유지). eventLevel은 자유 입력이다 — CatalogVariableSchema에 선언 레벨
// 필드가 없어(A1의 referenceLevels와 같은 제약) 관측 레벨을 드롭다운으로 못
// 보여준다. 비워두면 서버가 결정적으로 자동 선택한다(§2 "categorical 2레벨
// outcome" — predictor 기준 레벨 해석과 동일 함수 재사용).
export function RegressionAdvancedOptions({
  catalogByKey, outcomeKey, predictorKeys,
  standardizePredictors, onStandardizePredictorsChange,
  interactionTerms, onInteractionTermsChange,
  splineKeys, onSplineKeysChange,
  eventLevel, onEventLevelChange,
}: {
  catalogByKey: CatalogByKey; outcomeKey: string | null; predictorKeys: string[];
  standardizePredictors: boolean; onStandardizePredictorsChange: (value: boolean) => void;
  interactionTerms: Array<[string, string]>; onInteractionTermsChange: (terms: Array<[string, string]>) => void;
  splineKeys: string[]; onSplineKeysChange: (keys: string[]) => void;
  eventLevel: string; onEventLevelChange: (level: string) => void;
}) {
  const [pendingPairA, setPendingPairA] = useState('');
  const [pendingPairB, setPendingPairB] = useState('');

  // spline predictor는 interaction에 전면 금지(v1, 계약 §1) — 선택 UI 단계에서
  // 이미 막아 서버 400(SPLINE_INTERACTION_NOT_SUPPORTED)까지 갈 필요가 없게 한다.
  const splineKeySet = new Set(splineKeys);
  const interactionCandidates = predictorKeys.filter((k) => !splineKeySet.has(k));
  // 이미 interaction에 쓰인 predictor도 spline 후보에서 뺀다(같은 배타 규칙의 반대 방향).
  const predictorsInInteractions = new Set(interactionTerms.flat());
  const splineCandidates = predictorKeys.filter(
    (k) => catalogByKey.get(k)?.type === 'continuous' && !predictorsInInteractions.has(k),
  );

  const outcomeType = outcomeKey ? catalogByKey.get(outcomeKey)?.type : undefined;

  function addInteractionPair() {
    if (!pendingPairA || !pendingPairB || pendingPairA === pendingPairB) return;
    const normalized = [pendingPairA, pendingPairB].sort().join('\u0000');
    const exists = interactionTerms.some(([a, b]) => [a, b].sort().join('\u0000') === normalized);
    if (exists) return;
    onInteractionTermsChange([...interactionTerms, [pendingPairA, pendingPairB] as [string, string]]);
    setPendingPairA('');
    setPendingPairB('');
  }

  return (
    <details className="swb-advanced-options">
      <summary>고급 옵션(표준화·interaction·spline)</summary>

      <label className="swb-checkbox-row">
        <input
          type="checkbox"
          checked={standardizePredictors}
          onChange={(e) => onStandardizePredictorsChange(e.target.checked)}
        />
        연속형 설명변수 표준화(z-score) — spline 대상 변수는 제외됩니다
      </label>

      {outcomeType === 'categorical' && (
        <div className="swb-section-label">
          사건 레벨(eventLevel, 선택)
          <input
            type="text"
            className="swb-search"
            aria-label="사건 레벨"
            placeholder="비워두면 자동 선택"
            value={eventLevel}
            onChange={(e) => onEventLevelChange(e.target.value)}
          />
        </div>
      )}

      <div className="swb-section-label">Spline 대상(연속형만, {splineKeys.length}개)</div>
      <div>
        {splineCandidates.length === 0 && (
          <p className="swb-suppressed-note">spline을 적용할 수 있는 연속형 설명변수가 없습니다.</p>
        )}
        {splineCandidates.map((k) => (
          <label key={k} className="swb-checkbox-row">
            <input
              type="checkbox"
              checked={splineKeys.includes(k)}
              onChange={(e) => {
                if (e.target.checked) onSplineKeysChange([...splineKeys, k]);
                else onSplineKeysChange(splineKeys.filter((x) => x !== k));
              }}
            />
            {catalogByKey.get(k)?.label || k}
          </label>
        ))}
      </div>

      <div className="swb-section-label">Interaction 항({interactionTerms.length}개)</div>
      <div>
        {interactionTerms.map(([a, b], i) => (
          <span key={`${a}-${b}`} className="swb-recipe-chip">
            {(catalogByKey.get(a)?.label || a)} × {(catalogByKey.get(b)?.label || b)}
            <button
              type="button"
              onClick={() => onInteractionTermsChange(interactionTerms.filter((_, idx) => idx !== i))}
              aria-label="interaction 제거"
            >×</button>
          </span>
        ))}
        {interactionCandidates.length >= 2 && (
          <div className="swb-filter-row">
            <select className="swb-search" aria-label="interaction 변수 A" value={pendingPairA} onChange={(e) => setPendingPairA(e.target.value)}>
              <option value="">변수 A</option>
              {interactionCandidates.map((k) => (
                <option key={k} value={k}>{catalogByKey.get(k)?.label || k}</option>
              ))}
            </select>
            <select className="swb-search" aria-label="interaction 변수 B" value={pendingPairB} onChange={(e) => setPendingPairB(e.target.value)}>
              <option value="">변수 B</option>
              {interactionCandidates.map((k) => (
                <option key={k} value={k}>{catalogByKey.get(k)?.label || k}</option>
              ))}
            </select>
            <button type="button" className="swb-btn swb-btn--sm" onClick={addInteractionPair}>Interaction 추가</button>
          </div>
        )}
      </div>
    </details>
  );
}
