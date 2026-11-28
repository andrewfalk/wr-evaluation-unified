// 상관행렬 결과 카드 — P2-78d에서 ResultPanel.tsx의 선언을 본문 그대로 옮겼다.
import { CorrelationHeatmap } from '../../charts/CorrelationHeatmap';
import { METHOD_LABELS } from '../labels';
import type { AnalyzeCorrelationMatrixResult } from '@wr/contracts/stats';
import type { CatalogByKey } from './types';
import { variableLabel } from './format';

// PR3-B — 상관행렬(계획서 §4) 전용 결과 카드. 히트맵의 발산형 색은 r값(§6.8.3),
// suppressed 셀은 사유 없이 불투명 처리(§4의 3단계 게이트가 이미 판정 완료).
export function CorrelationMatrixResultCard({ correlationMatrix, catalogByKey }: { correlationMatrix: AnalyzeCorrelationMatrixResult; catalogByKey: CatalogByKey }) {
  const labelOf = (key: string) => variableLabel(catalogByKey, key);
  return (
    <div className="swb-card">
      <strong>상관행렬 — {METHOD_LABELS[correlationMatrix.method] || correlationMatrix.method}</strong>
      <p className="swb-card-subtitle">
        변수 {correlationMatrix.variableKeys.length}개 · {correlationMatrix.variableKeys.map(labelOf).join(', ')}
      </p>
      <CorrelationHeatmap
        variableKeys={correlationMatrix.variableKeys}
        cells={correlationMatrix.cells}
        labelOf={labelOf}
      />
      <p className="swb-suppressed-note">
        {correlationMatrix.adjustedPWithheld
          ? '일부 쌍이 억제되어 다중검정 보정값(BH-FDR)은 행렬 전체에서 비공개 처리됩니다.'
          : '다중검정 보정: BH-FDR(raw p와 보정 p 병기, 데이터 보기에서 확인)'}
      </p>
    </div>
  );
}
