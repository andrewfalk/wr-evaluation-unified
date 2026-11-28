// 레시피 패널 머리 구역(전환 안내 · 그레인 · 분석 모드) — P2-79c에서 RecipePanel 본체의 JSX를 글자 그대로 옮겼다(들여쓰기만 다르다).
import { GRAIN_DISPLAY_ORDER, GRAIN_LABELS, OPERATOR_LABELS } from './labels';
import { formatFilterValue } from './filterValues';
import type { CatalogByKey, RecipeTransitionNotice } from './types';

export function sortGrainsForDisplay(grains: string[]): string[] {
  return [...grains].sort((a, b) => {
    const ia = GRAIN_DISPLAY_ORDER.indexOf(a);
    const ib = GRAIN_DISPLAY_ORDER.indexOf(b);
    return (ia === -1 ? GRAIN_DISPLAY_ORDER.length : ia) - (ib === -1 ? GRAIN_DISPLAY_ORDER.length : ib);
  });
}

// 모드·목적 전환으로 자동 정리된 변수·필터 안내(닫기 가능).
export function TransitionNoticeBanner({
  transitionNotice, catalogByKey, onDismissTransitionNotice,
}: {
  transitionNotice: RecipeTransitionNotice | null;
  catalogByKey: CatalogByKey;
  onDismissTransitionNotice: () => void;
}) {
  return (
    <>
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
    </>
  );
}

export function GrainSelector({
  grain, supportedGrains, unsupportedGrains, onGrainChange,
}: {
  grain: string;
  supportedGrains: string[];
  unsupportedGrains: Array<{ grain: string }>;
  onGrainChange: (grain: string) => void;
}) {
  return (
    <>
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
    </>
  );
}

export function AnalysisModeSelector({
  analysisMode, onAnalysisModeChange, predictionSupported, modeChangeBlockedNotice,
}: {
  analysisMode: string;
  onAnalysisModeChange: (mode: string) => void;
  predictionSupported: boolean;
  modeChangeBlockedNotice: boolean;
}) {
  return (
    <>
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
    </>
  );
}
