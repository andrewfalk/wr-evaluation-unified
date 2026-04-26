import Dashboard from './Dashboard';

export function LandingScreen({
  patients,
  onStartIntake,
  onOpenLoadModal,
  onShowSaveModal,
  onShowBatchImport,
  onLoadTestData,
  onShowSettings,
  onGoBack,
  onResetPatients,
  onSelectPatient,
}) {
  return (
    <div className="panel landing-panel pattern-surface pattern-surface-hero">
      <div className="landing-hero">
        <div className="section-title-row landing-hero-copy">
          <h1 className="landing-title">근골격계 질환 업무관련성 평가 및 특별진찰 소견서 작성 도우미</h1>
          <p className="landing-description">새 환자 평가를 시작하거나 저장된 데이터를 불러오세요.</p>
        </div>
      </div>
      <div className="landing-actions">
        <button className="btn btn-primary landing-action-btn" onClick={onStartIntake}>+ 새환자</button>
        <button className="btn btn-secondary landing-action-btn" onClick={onOpenLoadModal}>불러오기</button>
        <button className="btn btn-secondary landing-action-btn" onClick={onShowSaveModal}>저장</button>
        <button className="btn btn-info landing-action-btn" onClick={onShowBatchImport}>엑셀 일괄입력</button>
        <button className="btn btn-warning landing-action-btn" onClick={onLoadTestData}>테스트</button>
        <button className="btn btn-secondary landing-action-btn" onClick={onShowSettings}>설정</button>
        {patients.length > 0 && (
          <>
            <button className="btn btn-secondary btn-sm" onClick={onGoBack}>
              작업 목록 돌아가기 ({patients.length}명)
            </button>
            <button className="btn btn-danger btn-sm" onClick={onResetPatients}>
              목록 초기화
            </button>
          </>
        )}
      </div>
      <Dashboard patients={patients} onSelectPatient={onSelectPatient} />
    </div>
  );
}
