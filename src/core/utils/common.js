// 공통 유틸리티 함수

// BMI 계산
export function calculateBMI(h, w) {
  const H = parseFloat(h);
  const W = parseFloat(w);
  return (H && W && H > 0) ? (W / ((H / 100) ** 2)).toFixed(1) : 0;
}

// 만 나이 계산
export function calculateAge(b, r) {
  if (!b || !r) return 0;
  const birth = new Date(b);
  const ref = new Date(r);
  let age = ref.getFullYear() - birth.getFullYear();
  if (ref.getMonth() < birth.getMonth() ||
    (ref.getMonth() === birth.getMonth() && ref.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

// 키 순서에 무관하게 안정적인 JSON 문자열 생성 (PostgreSQL JSONB 등은 객체 키 삽입 순서를 보존하지 않으므로,
// 이 함수 없이 JSON.stringify로 비교하면 값이 같아도 키 순서만 달라져 "변경됨"으로 오판할 수 있음)
export function stableStringify(value) {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val).sort().reduce((sorted, k) => {
        sorted[k] = val[k];
        return sorted;
      }, {});
    }
    return val;
  });
}

// XSS 방지
export function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
