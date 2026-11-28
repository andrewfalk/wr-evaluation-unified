// 영상 분석 화면의 "왜 이 값?" 근거 패널(P2-75d, Phase 2 C9 구간 D) — VideoAnalysisStep에 있던 그대로다.
import type { ReactNode } from 'react';
import type { OverlaySegment } from '../SkeletonOverlay';
import type { FeatureEvidence, ContributionEvidence, FusionCandidate } from '../../services/videoStepTypes';
import { contribFormula } from '../../services/videoStepEvidence';

// "왜 이 값?" 근거 패널. jobEv 없으면(mock·이전 세션) fallback 안내(영속화 안 하는 설계 표현).
export function EvidencePanel({ jobEv, unit }: { jobEv: FeatureEvidence | null | undefined; unit: string | null | undefined }) {
  if (!jobEv) {
    return (
      <div className="va-evidence-note">
        근거 정보는 현재 분석 세션에서만 표시됩니다. 다시 분석하면 확인할 수 있습니다.
      </div>
    );
  }
  // 한 행(라벨 dt + 값 dd). 값이 비면 행 자체를 그리지 않는다.
  const row = (label: string, value: ReactNode) => (
    <div className="va-evidence-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <div className="va-evidence">
      <dl className="va-evidence-dl">
        {row('집계 방식', <code>{jobEv.aggregationMethod}</code>)}
        {(jobEv.analysisJobIds?.length as number) > 0 && row('분석 job', jobEv.analysisJobIds.join(', '))}
      </dl>
      {(jobEv.contributions || []).map((c, i) => {
        const ev = (c.evidence || {}) as ContributionEvidence;
        const formula = contribFormula(ev, c.perDayValue, unit);
        const bd = ev.confidenceBreakdown;
        const adopted = ev.fusion?.adopted;
        const bdKeys = bd
          ? ['keypoint', 'visibility', 'tracking', 'viewpoint', 'usableFrameRatio'].filter((k) => bd[k] != null)
          : [];
        return (
          <div key={i} className="va-evidence-proc">
            <div className="va-evidence-proc-title">
              <b>{c.processName || '(공정)'}</b> <span>공정 점유율 {c.sharePercent}%</span>
            </div>
            <dl className="va-evidence-dl">
              {formula && row('환산식', formula)}
              {adopted && row('채택 시점', `${adopted.viewpoint || '미지정'}${adopted.jobId ? ` (job ${adopted.jobId})` : ''}${(ev.fusion?.candidates?.length as number) > 1 ? ` / 후보 ${(ev.fusion as { candidates: FusionCandidate[] }).candidates.length}개` : ''}`)}
              {bdKeys.length > 0 && row('신뢰도 성분', (
                <span className="va-evidence-chips">
                  {bdKeys.map((k) => <span key={k} className="va-flag-pill tone-neutral">{`${k} ${Math.round((bd as Record<string, number>)[k] * 100)}%`}</span>)}
                </span>
              ))}
              {(ev.segments?.length as number) > 0 && row('근거 구간', `${(ev.segments as OverlaySegment[]).length}개`)}
            </dl>
            {(ev.warnings?.length as number) > 0 && <div className="va-evidence-warn">경고: {(ev.warnings as string[]).join(', ')}</div>}
          </div>
        );
      })}
      <div className="va-evidence-note">
        ※ 신뢰도·경고는 실험값입니다(자동제안 차단 임계값은 검증 전까지 비활성). 값은 전문의가 확정합니다.
      </div>
    </div>
  );
}
