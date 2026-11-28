// 영상 분석 화면 검토 열의 작업 단위(척추·경추) 제안·관찰값 조각(P2-75f, Phase 2 C9 구간 D) — 공정≈task 1:1, 모듈별 독립 + 대상 작업 선택.
// 본체에 있던 JSX 그대로이고, 행은 행 컴포넌트(key는 호출부, 같은 값)로 그린다. 상태(대상 작업 선택 포함)는 본체가 들고 props로 내려준다.
import { getModuleSuggestions, getModuleCandidates } from '../../services/videoProvenance';
import { getModule } from '../../moduleRegistry';
import { tasksForJob, resolveTargetTaskId } from '../../services/videoStepState';
import { CandidateRow, SuggestionRow } from './ReviewRows';
import type { TaskScopeReviewProps } from './types';

export function TaskScopeReview({
  va, taskScopeModules, activePatient, taskTargets, setTaskTargets, analysisEvidence, jobName, review,
}: TaskScopeReviewProps) {
  return (
    <div className="va-suggest-group">
      <div className="va-suggest-group-title">작업 단위 (척추·경추)</div>
      {va.processes.map((p) => {
        const pf = (va.processFeatures || []).find((f) => f.processId === p.id);
        if (!pf) return null;
        const blocks = taskScopeModules.map((moduleId) => {
          const suggestions = getModuleSuggestions(pf.features, moduleId);
          const candidates = getModuleCandidates(pf.features, moduleId); // 관찰값(apply 없음)
          if (suggestions.length === 0 && candidates.length === 0) return null; // candidate만 있어도 표시
          const mod = getModule(moduleId);
          const procEv = analysisEvidence.processEvidenceByProcessId[p.id] || {};
          // 이 직업의 해당 모듈 task 목록(적용 대상). 경추·척추는 작업 갯수·이름이 달라 모듈별로 독립.
          // spine은 미연결 레거시 task fallback 허용(taskFallbackUnlinked).
          const tasks = tasksForJob(activePatient?.data?.modules?.[moduleId], p.sharedJobId,
            { fallbackUnlinked: !!mod?.videoMappingConfig?.taskFallbackUnlinked });
          const targetKey = `${p.id}:${moduleId}`;
          // 선택값이 현재 후보에 실제 존재할 때만 유효(stale 선택 → 적용 잘못 활성 방지).
          const targetTaskId = resolveTargetTaskId(tasks, taskTargets[targetKey]);
          const noTarget = !targetTaskId;
          return (
            <ul key={moduleId} className="va-suggest-list">
              {/* 대상 작업 선택은 apply가 있는 auto 제안에만 의미 — candidate만 있는 블록엔 경고/선택 생략 */}
              {suggestions.length > 0 && (
                <div className="va-target-pick">
                  <b>{mod?.name || moduleId}</b> 대상 작업:{' '}
                  {tasks.length === 0 ? <span className="va-target-empty">없음 — {mod?.name} 탭에서 작업을 추가한 뒤 적용 가능</span>
                    : tasks.length === 1 ? (tasks[0].name || '작업')
                      : (
                        <select value={targetTaskId || ''} onChange={(e) => setTaskTargets((m) => ({ ...m, [targetKey]: e.target.value }))}>
                          <option value="">(작업 선택)</option>
                          {tasks.map((t) => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
                        </select>
                      )}
                </div>
              )}
              {suggestions.length === 0 && candidates.length > 0 && (
                <div className="va-target-pick"><b>{mod?.name || moduleId}</b> 관찰값</div>
              )}
              {suggestions.map((s) => (
                <SuggestionRow
                  key={`${p.id}:${moduleId}:${s.featureKey}`}
                  s={s}
                  moduleId={moduleId}
                  ctx={{ taskId: targetTaskId }}
                  processIds={[p.id]}
                  analysisProfile={p.analysisProfile}
                  jobEv={procEv[s.featureKey]}
                  rowKey={`${p.id}:${moduleId}:${s.featureKey}`}
                  applyDisabled={noTarget}
                  applyDisabledTitle="적용할 대상 작업을 먼저 선택하세요"
                  review={review}
                />
              ))}
              {candidates.map((c) => (
                <CandidateRow
                  key={`${p.id}:${moduleId}:cand:${c.featureKey}`}
                  c={c}
                  activeMinutesPerDay={p.activeMinutesPerDay}
                  jobEv={procEv[c.featureKey]}
                  rowKey={`${p.id}:${moduleId}:cand:${c.featureKey}`}
                  review={review}
                />
              ))}
            </ul>
          );
        });
        if (blocks.every((b) => b === null)) return null;
        return (
          <div key={p.id} className="va-review-block">
            <b className="va-review-block-title">{p.name}</b> <span className="va-hint">({jobName(p.sharedJobId)})</span>
            {blocks}
          </div>
        );
      })}
    </div>
  );
}
