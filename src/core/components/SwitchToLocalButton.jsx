export function SwitchToLocalButton({ onSwitch }) {
  return (
    <button type="button" className="btn btn-sm btn-secondary" onClick={onSwitch}>
      로컬 모드로 전환
      <span className="switch-local-hint">(이 브라우저에서만 작업)</span>
    </button>
  );
}
