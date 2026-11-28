// 영상 분석 화면의 왼쪽 셋업 열(P2-75e, Phase 2 C9 구간 D) — 공정·클립 입력, 업로드·대상자 탐지 표시, 분석 실행 버튼, 진행바.
// 상태와 핸들러는 본체(VideoAnalysisStep)가 그대로 들고 props로 내려준다(이 조각은 상태를 갖지 않는다). JSX는 본체에 있던 그대로이고,
// 문구의 따옴표만 &quot;로 적었다(변환 결과 같음).
import { TargetPicker } from '../TargetPicker';
import { isJobExcludedFromAnalysis } from '@wr/analytics-core/jobScope';
import { VIEWPOINTS, PROFILES, canDetectClip } from '../../services/videoStepState';
import type { SetupColumnProps } from './types';

export function SetupColumn({
  va, jobs, activeModules, shareTotals, analysisEvidence, jobName, uploads, serverMode, fixtureMode, detecting, analyzing,
  pipelineSteps, pipelineIndex, validDetection,
  addProcess, editProcess, removeProcess, addClip, editClip, removeClip, uploadClipFile, detectTarget, chooseTarget, runAnalysis,
}: SetupColumnProps) {
  return (
    <div className="va-col">
      <div className="va-col-title">셋업 — 공정·클립</div>
      {va.processes.length === 0 && <p className="evaluation-empty-state">공정을 추가하세요. 공정 구조·시간 점유율은 조사 서류 기반 수기 입력입니다.</p>}
      {va.processes.map((p) => {
        const clips = va.clips.filter((c) => c.processId === p.id);
        const total = shareTotals[p.sharedJobId] || 0;
        return (
          <div key={p.id} className="va-process-card">
            <div className="va-process-fields">
              <div className="form-group va-pf-job"><label>직업</label>
                <select value={p.sharedJobId} onChange={(e) => editProcess(p.id, { sharedJobId: e.target.value })}>
                  {jobs.map((j) => <option key={j.id} value={j.id}>{`${j.jobName || '(직업 미지정)'}${isJobExcludedFromAnalysis(j) ? ' (신체부담평가 미포함)' : ''}`}</option>)}
                </select></div>
              <div className="form-group va-pf-name"><label>공정명</label>
                <input value={p.name} onChange={(e) => editProcess(p.id, { name: e.target.value })} placeholder="공정명" /></div>
              {/* 점유율·활동시간은 한 묶음 — 폭이 좁아 한 줄에 안 들어가면 묶음째 다음 줄로 넘어간다. */}
              <div className="va-pf-pair">
                <div className="form-group va-pf-share"><label>점유율(%)</label>
                  <input type="number" min="0" max="100" value={p.shiftSharePercent}
                    onChange={(e) => editProcess(p.id, { shiftSharePercent: Number(e.target.value) })} /></div>
                <div className="form-group va-pf-active"><label title="공정활동분/일(수기). 비우면 모름(적용 불가).">활동시간(분/일)</label>
                  <input type="number" min="0" max="1440" placeholder="분/일" value={p.activeMinutesPerDay ?? ''}
                    onChange={(e) => editProcess(p.id, { activeMinutesPerDay: e.target.value === '' ? null : Number(e.target.value) })} /></div>
              </div>
              <div className="form-group va-pf-profile"><label>분석 프로필</label>
                {/* 손목·손(고프레임)은 wholebody 추론이 무거워(처리 느림·서버 부하) 손목 모듈 활성 시에만 노출.
                    단, 이미 그 프로필로 저장된 공정은 폴백으로 옵션 유지(선택 보존). 6.0-10. */}
                <select value={p.analysisProfile} onChange={(e) => editProcess(p.id, { analysisProfile: e.target.value })}>
                  {PROFILES.filter((pr) => pr.value !== 'hand-wrist'
                    || activeModules.includes('wrist') || p.analysisProfile === 'hand-wrist')
                    .map((pr) => <option key={pr.value} value={pr.value}>{pr.label}</option>)}
                </select></div>
              <div className="va-pf-rest">
                <div className="va-pf-desc">
                  {PROFILES.find((pr) => pr.value === p.analysisProfile)?.desc}
                  {p.analysisProfile === 'hand-wrist' && (
                    <div className="va-pf-warn">고부담(처리 느림·서버 부하) — 손목·손 분석이 필요한 공정에만 사용</div>
                  )}
                </div>
                <button type="button" className="btn btn-secondary btn-sm va-pf-del" onClick={() => removeProcess(p.id)}>공정 삭제</button>
              </div>
            </div>
            {/* 6.0-12: 실제 실행된 추론 디바이스 배지(분석 후). auto에서 cuda→cpu 폴백 시 사유 tooltip. */}
            {(() => {
              const dev = analysisEvidence.deviceByProcessId[p.id];
              if (!dev) return null;
              const label = dev.used === 'cuda' ? 'GPU(CUDA)' : (dev.fallback ? 'CPU(폴백)' : 'CPU');
              return (
                <p className="muted" style={{ fontSize: 11, marginTop: 4 }} title={dev.reason || ''}>
                  실행: <b>{label}</b>
                </p>
              );
            })()}
            {total !== 100 && <p className="muted" style={{ color: 'var(--color-warning)', marginTop: 6 }}>⚠ &quot;{jobName(p.sharedJobId)}&quot; 공정 점유율 합 {total}% (100% 권장)</p>}
            <div className="va-process-clips">
              {clips.map((c) => {
                const up = uploads[c.id];
                const canDetect = canDetectClip({ serverMode, fixtureMode, clip: c, upload: up });
                const det = canDetect ? validDetection(c) : null;
                return (
                  <div key={c.id} className="va-clip-row">
                    <select value={c.viewpoint} onChange={(e) => editClip(c.id, { viewpoint: e.target.value })}>
                      {VIEWPOINTS.map((vp) => <option key={vp.value} value={vp.value}>{vp.label}</option>)}
                    </select>
                    {fixtureMode && (
                      <input type="text" placeholder="시험용 영상 파일명" value={c.fixtureClipName || ''}
                        onChange={(e) => editClip(c.id, { fixtureClipName: e.target.value })} style={{ width: 150 }} />
                    )}
                    {serverMode && !c.fixtureClipName && (
                      <>
                        <input type="file" accept="video/*" disabled={up?.status === 'uploading'}
                          onChange={(e) => uploadClipFile(c, p.id, e.target.files && e.target.files[0])} />
                        {up?.status === 'uploading' && <span className="muted" style={{ fontSize: 12 }}>업로드 {Math.round((up.progress || 0) * 100)}%</span>}
                        {up?.status === 'done' && <span className="va-flag-pill tone-positive">업로드 완료</span>}
                        {up?.status === 'error' && <span className="va-flag-pill tone-warning">업로드 실패</span>}
                      </>
                    )}
                    {canDetect && (
                      <button type="button" className="btn btn-secondary btn-sm" disabled={detecting === c.id} onClick={() => detectTarget(c, p.id)}>
                        {detecting === c.id ? '탐지 중…' : (det ? '재탐지' : '대상자 탐지')}
                      </button>
                    )}
                    <button type="button" className="btn btn-secondary btn-xs" onClick={() => removeClip(c.id)}>×</button>
                    {det && (
                      <div className="va-clip-detect">
                        <TargetPicker result={det.result} selectedId={det.selectedId} frameUrl={det.frameUrl} onSelect={(id: string) => chooseTarget(c, id)} />
                        <p className="muted" style={{ fontSize: 12 }}>
                          {det.selectedId ? `대상자: ${det.selectedId}` : '박스를 클릭해 대상 작업자를 선택하세요(미선택 시 자동=주요 인물).'}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
              <div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => addClip(p.id)}>+ 클립</button>
                {clips.length === 0 && <span className="muted"> 클립(시점) 미태깅</span>}
              </div>
            </div>
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={addProcess}>+ 공정 추가</button>
        <button type="button" className="btn btn-primary" onClick={runAnalysis} disabled={va.processes.length === 0 || analyzing}>
          {analyzing ? '분석 중…' : (serverMode ? '영상 분석 실행' : '예시 분석 실행')}
        </button>
      </div>

      {/* 파이프라인 진행바(coarse) */}
      <div className="va-pipeline">
        {pipelineSteps.map((label, i) => {
          const done = i < pipelineIndex;
          const active = i === pipelineIndex;
          return (
            <span key={label} className={`va-pipeline-step${done ? ' is-done' : ''}${active ? ' is-active' : ''}`}>
              {done ? '✓ ' : (active ? '▶ ' : '')}{label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
