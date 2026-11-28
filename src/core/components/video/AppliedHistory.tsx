// 영상 분석 화면의 적용 이력 + 되돌리기(전체폭) 조각(P2-75f, Phase 2 C9 구간 D) — 본체에 있던 JSX 그대로다.
// 되돌리기(rollback)는 본체의 핸들러를 그대로 받는다(적용 이력 항목의 참조로 찾는다).
import type { AppliedHistoryProps } from './types';

export function AppliedHistory({ va, serverMode, rollback }: AppliedHistoryProps) {
  return (
    <div className="va-history">
      <div className="va-col-title">적용 이력</div>
      {serverMode && (
        <p className="muted">서버에 적용한 항목의 되돌리기는 아직 지원되지 않습니다. 모듈 탭에서 직접 수정하세요.</p>
      )}
      <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
        {va.appliedInputs.map((e, i) => (
          <li key={i} style={{ margin: '4px 0' }}>
            <code>{e.targetPath.split('.').slice(-2).join('.')}</code> = {String(e.appliedValue)}
            <span className="muted" style={{ marginLeft: 6 }}>(이전: {String(e.previousValue)})</span>
            {/* 서버 모드: 로컬 rollback은 서버(done) 상태와 갈라지므로 미노출(§8.12, Codex). */}
            {!serverMode && (
              <button type="button" className="btn btn-secondary btn-xs" style={{ marginLeft: 8 }} onClick={() => rollback(e)}>되돌리기</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
