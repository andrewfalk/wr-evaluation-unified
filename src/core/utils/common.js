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

// UTC(Z) ISO 타임스탬프(createdAt 등)의 앞 10자를 그대로 잘라 쓰면(slice/split) KST(UTC+9)
// 등 UTC보다 빠른 시간대에서는 자정~오전 사이 생성된 기록이 하루 전날 UTC 날짜로 표시된다.
// 항상 런타임 로컬 타임존 기준 캘린더 날짜(getFullYear/getMonth/getDate)로 변환한다.
// 이미 "YYYY-MM-DD" 형식(시간 정보 없음)인 값은 그대로 로컬 자정으로 파싱해 오프
// 원본 캘린더 날짜가 밀리지 않게 한다.
export function toLocalDateString(value) {
  if (!value) return '';
  const str = String(value);
  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, day] = str.split('-').map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(str);
  }
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
