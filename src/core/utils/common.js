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
