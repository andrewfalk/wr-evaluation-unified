export function SuppressionNotice({ children }) {
  return (
    <p className="swb-suppressed-note chart-suppression-notice">
      {children || '공개 정책에 따라 표시되지 않음(표본 크기 등).'}
    </p>
  );
}
