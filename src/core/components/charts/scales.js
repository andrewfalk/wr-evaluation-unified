// PR3-B 계획서 §6.8.6 — 공통 차트 프리미티브(스케일). 순수 함수, 외부 의존성 없음.

export function createLinearScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

export function createBandScale(domainValues, range, paddingRatio = 0.25) {
  const [r0, r1] = range;
  const n = domainValues.length || 1;
  const step = (r1 - r0) / n;
  const bandwidth = step * (1 - paddingRatio);
  const offsets = new Map(domainValues.map((v, i) => [v, r0 + i * step + (step - bandwidth) / 2]));
  return {
    bandwidth,
    step,
    position: (value) => offsets.get(value) ?? r0,
  };
}

// "nice number" 알고리즘(표준) — 격자선이 0.1/0.2/0.5/1/2/5/10 배수에 오도록.
function niceNumber(value, round) {
  if (value === 0) return 0;
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / Math.pow(10, exponent);
  let niceFraction;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * Math.pow(10, exponent);
}

export function computeNiceTicks(min, max, targetCount = 5) {
  if (min === max) return [min];
  const range = niceNumber(max - min, false);
  const step = niceNumber(range / Math.max(1, targetCount - 1), true) || 1;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}
