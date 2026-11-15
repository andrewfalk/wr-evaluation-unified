// disabled: 로그인 요청이 진행 중일 때(계정 전환 수정 AS-4 — 창을 줄이는 보조 장치, 본 방어는 인증 문맥 세대 검사).
export function SwitchToLocalButton({ onSwitch, disabled = false }) {
  return (
    <button type="button" className="btn btn-sm btn-secondary" onClick={onSwitch} disabled={disabled}>
      로컬 모드로 전환
      <span className="switch-local-hint">(이 브라우저에서만 작업)</span>
    </button>
  );
}
