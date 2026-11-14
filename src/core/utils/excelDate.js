// 엑셀 날짜 일련번호 → 연·월·일 — REFACTORING_ROADMAP Phase 2 P-2a(P2-22).
//
// 일괄입력 파서(batchImportHelpers.parseDate)가 숫자 셀을 날짜로 바꿀 때 쓰던 `XLSX.SSF.parse_date_code`의 **날짜 부분**을
// 그대로 옮겼다(SheetJS SSF, Apache-2.0 — xlsx 0.20.3 `SSF_parse_date_code`·`SSF_normalize_xl_unsafe`, 1900 날짜 체계,
// 1904·회교력 옵션 없음). 이 함수 때문에 6개 모듈의 index.js가 xlsx 전체(약 490 KB)를 메인 청크로 끌어왔다(계획 F8).
// 원본과 같은 값을 내는지는 src/core/utils/__tests__/excelDate.parity.test.js가 넓은 입력 범위에서 원본과 직접 비교한다.
//
// 반환: { y, m, d } 또는 범위 밖(음수·2958465 초과)이면 null. 0 → 1900-01-00, 60 → 1900-02-29(엑셀 윤년 버그) 그대로.

function normalizeXlUnsafe(v) {
  const s = v.toPrecision(16);
  if (s.indexOf('e') > -1) {
    let m = s.slice(0, s.indexOf('e'));
    m = m.indexOf('.') > -1 ? m.slice(0, (m.slice(0, 2) === '0.' ? 17 : 16)) : (m.slice(0, 15) + '0'.repeat(Math.max(0, m.length - 15)));
    return m + s.slice(s.indexOf('e')); // 원본도 이 경우 문자열을 돌려준다(아래 `| 0`이 숫자로 바꾼다)
  }
  const n = s.indexOf('.') > -1 ? s.slice(0, (s.slice(0, 2) === '0.' ? 17 : 16)) : (s.slice(0, 15) + '0'.repeat(Math.max(0, s.length - 15)));
  return Number(n);
}

export function excelSerialToYmd(value) {
  if (value > 2958465 || value < 0) return null;
  const v = normalizeXlUnsafe(value);
  let date = v | 0;
  let time = Math.floor(86400 * (v - date));
  let u = 86400 * (v - date) - time;
  if (Math.abs(u) < 1e-6) u = 0;
  if (u > 0.9999) {
    time += 1;
    if (time === 86400) date += 1;
  }
  if (date === 60) return { y: 1900, m: 2, d: 29 };
  if (date === 0) return { y: 1900, m: 1, d: 0 };
  if (date > 60) date -= 1;
  // 1 = 1900-01-01(그레고리력, 로컬 시각 — 원본과 같음)
  const d = new Date(1900, 0, 1);
  d.setDate(d.getDate() + date - 1);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}
