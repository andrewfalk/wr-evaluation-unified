// PR3-B 계획서 §6.8.3 — 색 규칙. 정적 hex만 사용(color-mix() 금지, Win7 호환 §6.8.6).
// 단일 계열은 이 accent 한 색만 쓴다(범례 없이 제목이 계열을 지칭).
export const ACCENT = '#1d4ed8';

// 범주형 — 고정 순서 팔레트, 순환 금지(9번째부터는 "기타"로 접는다).
export const CATEGORICAL_PALETTE = [
  '#1d4ed8', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#be185d', '#65a30d',
];
export const OTHER_CATEGORY_COLOR = '#6b7280';

// 상태색(정상/경고/차단) — 계열 색으로 재사용하지 않는다.
export const STATUS_COLORS = {
  ok: '#16a34a',
  warn: '#d97706',
  danger: '#dc2626',
};

function hexToRgb(hex) {
  const v = hex.replace('#', '');
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
}
function lerpColor(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return rgbToHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

// 순차형 — 단일 hue light→dark. 무지개 금지.
export function sequentialColor(t) {
  return lerpColor('#dbeafe', '#1e3a8a', Math.max(0, Math.min(1, t)));
}

// 발산형(상관행렬 히트맵 전용) — 두 hue + 회색 중앙. t는 [-1,1].
export function divergingColor(t) {
  const clamped = Math.max(-1, Math.min(1, t));
  if (clamped < 0) return lerpColor('#f3f4f6', '#b91c1c', -clamped);
  return lerpColor('#f3f4f6', '#1d4ed8', clamped);
}

// 색은 entity(범주값)에 붙고 순위(배열 인덱스)에 붙지 않는다 — 필터로 계열이 줄어도
// 남은 계열의 색이 바뀌면 안 되므로, 호출자는 항상 같은 라벨에 같은 index를 넘겨야 한다.
export function categoricalColor(index) {
  if (index < CATEGORICAL_PALETTE.length) return CATEGORICAL_PALETTE[index];
  return OTHER_CATEGORY_COLOR;
}
