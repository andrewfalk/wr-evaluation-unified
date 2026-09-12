// PR3-B 계획서 §6.8.6 — Win7 구형 크롬 호환: Intl.NumberFormat 옵션객체 금지.
// toFixed()·toLocaleString()(옵션 없이 호출)만 사용한다.
export function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value.toFixed(digits)).toLocaleString();
}

export function formatInt(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Math.round(value).toLocaleString();
}
