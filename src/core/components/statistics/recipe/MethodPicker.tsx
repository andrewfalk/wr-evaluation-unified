// 분석 방법 선택기 — P2-79b에서 RecipePanel.tsx의 선언을 본문 그대로 옮겼다.
import { describeMethodReasonCode } from '../describeMethodReasonCode';
import { METHOD_LABELS } from '../labels';
import { METHOD_ORDER, METHOD_LIST_PVALUE_NOTE, METHOD_TOOLTIPS, STATUS_LABELS } from './labels';
import type { AvailableMethod } from '@wr/contracts/stats';
import type { RecipePreviewState } from './types';

// PR3-A §6.9.4 — "분석 목적 아코디언 안"에 방법 선택기를 둔다. availableMethods는
// /preview 응답에서 온다(§파이프라인 — preview는 method 미선택이어도 정상 응답).
// 인원수 관련 차단 사유(B)는 서버가 애초에 세분화해서 안 보낸다 — 그래서 이 UI는
// "왜 안 되는지" 대신 결과가 표본 크기에 따라 표시되지 않을 수 있다는 고정 문구만
// 상시 노출한다(데이터 의존 아님, 계획서 §"방법 가용성 판정").
export function MethodPicker({ previewState, isPreviewCurrent, requestedMethod, onRequestedMethodChange, onApplyRemedy, notReadyMessage }: {
  previewState: RecipePreviewState; isPreviewCurrent: boolean; requestedMethod: string | null;
  onRequestedMethodChange: (method: string) => void; onApplyRemedy: (patch: AvailableMethod['remedyRecipePatch']) => void; notReadyMessage: string;
}) {
  const ready = isPreviewCurrent && previewState.status === 'ready' && !previewState.result?.counts?.suppressed;
  const methods = ready ? (previewState.result?.availableMethods ?? []) : [];
  const byId = new Map<string, AvailableMethod>(methods.map((m) => [m.id, m]));
  const orderedMethods = METHOD_ORDER.map((id) => byId.get(id)).filter(Boolean) as AvailableMethod[];

  return (
    <>
      <div className="swb-section-label">분석 방법</div>
      {!ready && <p className="swb-suppressed-note">{notReadyMessage || '변수를 2개 선택하면 사용 가능한 방법이 표시됩니다.'}</p>}
      {ready && orderedMethods.length === 0 && (
        <p className="swb-suppressed-note">표본 수가 부족해 이용 가능한 방법을 표시할 수 없습니다.</p>
      )}
      {ready && orderedMethods.length > 0 && (
        <div className="swb-method-list">
          <p className="swb-suppressed-note" style={{ margin: '0 0 4px' }}>{METHOD_LIST_PVALUE_NOTE}</p>
          {orderedMethods.map((m) => {
            const selected = requestedMethod === m.id;
            const clickable = m.status !== 'unsupported';
            return (
              <div
                key={m.id}
                className={`swb-method-card${selected ? ' swb-method-card--selected' : ''}${clickable ? '' : ' swb-method-card--disabled'}`}
              >
                <button
                  type="button"
                  className="swb-method-card-main"
                  disabled={!clickable}
                  onClick={() => clickable && onRequestedMethodChange(m.id)}
                  title={m.status === 'unsupported' ? describeMethodReasonCode(m.reasonCode) : METHOD_TOOLTIPS[m.id]}
                >
                  <span>{METHOD_LABELS[m.id] || m.label}</span>
                  <span
                    className={
                      m.status === 'available' ? 'swb-status-ok'
                        : m.status === 'conditional' ? 'swb-status-warn'
                          : 'swb-suppressed-note'
                    }
                  >{STATUS_LABELS[m.status] || m.status}</span>
                </button>
                {m.status === 'conditional' && (
                  <p className="swb-status-warn" style={{ margin: '2px 0 0' }}>{describeMethodReasonCode(m.reasonCode)}</p>
                )}
                {m.status === 'unsupported' && m.reasonCode && (
                  <p className="swb-suppressed-note" style={{ margin: '2px 0 0' }}>{describeMethodReasonCode(m.reasonCode)}</p>
                )}
                {m.remedy && m.remedyRecipePatch && (
                  <button type="button" className="swb-btn swb-btn--sm" style={{ marginTop: 4 }} onClick={() => onApplyRemedy(m.remedyRecipePatch)}>
                    {m.remedy}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {/* 데이터 의존 아님 — B(그룹/셀 소수셀·값상수)는 절대 세분화해서 노출하지 않는다는
          설계상, 이 문구는 항상 같은 형태로 상시 표시한다(계획서 §"방법 가용성 판정"). */}
      <p className="swb-suppressed-note">결과가 표본 크기에 따라 표시되지 않을 수 있습니다.</p>
    </>
  );
}
