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

// 고정 소수 자릿수 서식 — `toLocaleString()`을 쓰지 않는다. 옵션 없는 toLocaleString은 소수 3자리에서
// 잘려(실측: formatNumber(0.2015, 6) === "0.201") 폭 0.001 이하 경계를 구분하지 못한다. toFixed 결과의
// 정수부에 천 단위 쉼표를 정규식으로 직접 넣는다(Intl 옵션 객체 금지 — Win7 구형 크롬 호환).
// 음수와 -0을 처리하고(`-0.0` → `0.0`), 1e21 이상(toFixed가 지수 표기를 돌려줌)은 그대로 둔다.
export function formatFixed(value, decimals) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const fixed = value.toFixed(decimals);
  if (fixed.indexOf('e') !== -1) return fixed;
  const dot = fixed.indexOf('.');
  let intPart = dot === -1 ? fixed : fixed.slice(0, dot);
  const frac = dot === -1 ? '' : fixed.slice(dot);
  let sign = '';
  if (intPart.charAt(0) === '-') { sign = '-'; intPart = intPart.slice(1); }
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (sign && /^[0.,]*$/.test(grouped + frac)) sign = ''; // -0.0 → 0.0
  return sign + grouped + frac;
}

// 모든 경계가 `Number(e.toFixed(d)) === e`를 만족하는 가장 작은 자릿수 d(0~12). 서버의 정렬 경계는 폭의
// 자릿수로 반올림해 만들어지므로 정확히 왕복한다. 찾지 못하면 null(서버 폴백 경계 — 균등분할이라 자릿수가
// 정해져 있지 않음).
export function decimalsForEdges(edges) {
  for (let d = 0; d <= 12; d += 1) {
    let ok = true;
    for (let i = 0; i < edges.length; i += 1) {
      if (Number(edges[i].toFixed(d)) !== edges[i]) { ok = false; break; }
    }
    if (ok) return d;
  }
  return null;
}

// 원본 히스토그램의 경계를 표현하는 단일 포매터 — 축 라벨, 툴팁, 표가 모두 이 함수를 쓴다.
//  1) 정렬 경계: 같은 고정 소수 자릿수로 표시한다(0, 5, 10 / 0.0, 0.5, 1.0 / 0.201 … 0.209).
//  2) 그 밖(서버 폴백 경계): JavaScript 기본 숫자 표기 String(value)를 쓴다. 명세상 "정확히 왕복하는
//     가장 짧은 표현"이라 근삿값 표시가 없고(8.333333333333334e-14를 8e-14로 줄이지 않음) 서로 다른
//     경계는 항상 서로 다른 라벨이 된다. 가독성은 이 드문 경로에서 희생한다.
export function makeEdgeFormatter(edges) {
  const decimals = decimalsForEdges(edges);
  if (decimals !== null) return (value) => formatFixed(value, decimals);
  return (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : '—');
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
