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

// 통계 결과 표시용 서식. 서버 CSV·차트 내부 formatNumber와 별개로, 화면 표의 숫자를 일관되게
// 읽히게 한다(16자리 원값 노출 방지). toLocaleString·Intl 옵션은 쓰지 않는다(Win7 Chrome 호환).
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// p값: 0.0001 미만은 "<0.0001", 그 외 소수 4자리. 경계 0.0001은 "0.0001".
export function formatPValue(p) {
  if (!isFiniteNumber(p)) return '—';
  if (p < 0.0001) return '<0.0001';
  return p.toFixed(4);
}

// 유효숫자 sig자리(기본 4). 소수부에서만 자릿수를 줄이고 정수부는 반올림해도 자릿수를 잘라내지
// 않는다(12345.6 → "12346"; toPrecision(4)는 "12350"이 되므로 쓰지 않는다). 1e-3 미만은
// 지수 표기(toExponential의 인자는 소수점 이하 자리수 → sig - 1)로 0으로 사라지지 않게 한다.
// 숫자가 아니거나 비유한 값은 모두 "—". 0과 -0은 "0".
export function formatStat(v, sig = 4) {
  if (!isFiniteNumber(v)) return '—';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs < 1e-3) return v.toExponential(sig - 1);
  const decimals = Math.max(0, sig - 1 - Math.floor(Math.log10(abs)));
  return v.toFixed(decimals);
}
