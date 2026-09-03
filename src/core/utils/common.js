// PR0-B1: calculateBMI/calculateAge/stableStringify/escapeHtml는
// packages/analytics-core/common.ts로 이동(클라이언트·서버 공유). toLocalDateString은
// 의도적으로 로컬 타임존에 의존하는 UI 표시 함수라 이동하지 않고 그대로 남는다 —
// 이 파일은 "부분 shim"이다.
export { calculateBMI, calculateAge, stableStringify, escapeHtml } from '@analytics-core/common';

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
