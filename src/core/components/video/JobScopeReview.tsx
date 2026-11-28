// 영상 분석 화면 검토 열의 직업 단위(무릎·어깨) 제안 조각(P2-75f, Phase 2 C9 구간 D) — 본체에 있던 JSX 그대로이고, 행은 렌더 함수 대신
// 행 컴포넌트(key는 호출부, 같은 값)로 그린다. 상태는 본체가 들고 props로 내려준다.
import { getModuleSuggestions } from '../../services/videoProvenance';
import { JobScopeProcessBreakdown, SuggestionRow } from './ReviewRows';
import type { JobScopeReviewProps } from './types';

export function JobScopeReview({ va, jobScopeModules, jobName, analysisEvidence, review }: JobScopeReviewProps) {
  return (
    <div className="va-suggest-group">
      <div className="va-suggest-group-title">직업 단위 (무릎·어깨)</div>
      {jobScopeModules.length === 0 && <p className="va-hint">자동 매핑 지원 직업단위 모듈(무릎·어깨)이 활성화되어 있지 않습니다.</p>}
      {(va.jobFeatures || []).map((jf) => (
        <div key={jf.sharedJobId} className="va-review-block">
          <b className="va-review-block-title">{jobName(jf.sharedJobId)}</b>
          {jobScopeModules.map((moduleId) => {
            const suggestions = getModuleSuggestions(jf.features, moduleId);
            if (suggestions.length === 0) return null;
            const jobProcesses = va.processes.filter((p) => p.sharedJobId === jf.sharedJobId);
            const procIds = jobProcesses.map((p) => p.id);
            const analysisProfile = jobProcesses[0]?.analysisProfile;
            return (
              <ul key={moduleId} className="va-suggest-list">
                {suggestions.map((s) => [
                  <SuggestionRow
                    key={`${jf.sharedJobId}:${s.featureKey}`}
                    s={s}
                    moduleId={moduleId}
                    ctx={{ sharedJobId: jf.sharedJobId }}
                    processIds={procIds}
                    analysisProfile={analysisProfile}
                    jobEv={analysisEvidence.jobEvidenceBySharedJobId[jf.sharedJobId]?.[s.featureKey]}
                    rowKey={`${jf.sharedJobId}:${s.featureKey}`}
                    review={review}
                  />,
                  <JobScopeProcessBreakdown key={`${s.featureKey}:breakdown`} s={s} jobProcesses={jobProcesses} va={va} />,
                ])}
              </ul>
            );
          })}
        </div>
      ))}
    </div>
  );
}
