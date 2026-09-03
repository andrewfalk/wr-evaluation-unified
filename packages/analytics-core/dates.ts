// Extractor 전용 strict 날짜 파서 — `Date` 객체를 전혀 쓰지 않는다.
//
// `new Date(y, m-1, d)`로 round-trip 검증하는 방식(v5까지의 시도)도 여전히 실행 환경의
// 타임존 DB에 의존한다 — 일부 지역은 역사적 DST 전환 때문에 "존재하지 않는 로컬 시각"이
// 있어, `Date` 엔진이 그 순간을 인접 시각으로 재해석하면 같은 환경 안에서도 round-trip이
// 어긋날 수 있다. 그래서 그레고리력 산술만으로 검증한다.
//
// UI 호환용 `common.ts`의 `calculateAge`(lenient, `Date` 사용)와는 별개 함수다 — 서로
// 경쟁하지 않는다. extractor가 이 strict 파서로 먼저 걸러낸 뒤에만 `computeKneeCalc`를
// 부르므로, 그 이후 `calculateAge`가 내부적으로 도는 경로는 항상 strict happy path다.

export interface CalendarDate {
  y: number;
  m: number; // 1-12
  d: number;
}

function isLeapYear(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function daysInMonth(y: number, m: number): number {
  const table = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[m - 1];
}

const STRICT_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD"만 허용한다. 형식이 맞아도 캘린더상 존재하지 않는 날짜(예: 2021-02-31)는 거부한다. */
export function parseStrictIsoDate(s: string): CalendarDate | null {
  if (typeof s !== 'string') return null;
  const match = STRICT_DATE_RE.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/** 사전순 비교. a<b면 음수, a===b면 0, a>b면 양수 — `Date` 없이 순수 산술 비교. */
export function compareDate(a: CalendarDate, b: CalendarDate): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

/**
 * strict-only 나이 계산. lenient 폴백이 없다 — 비정형 날짜는 파싱 성공 여부와 관계없이
 * null(호출자가 not_entered/invalid로 처리). refDate가 birthDate보다 이르면(음수 나이)도 null.
 */
export function calculateAgeStrict(birthDate: string, refDate: string): number | null {
  const b = parseStrictIsoDate(birthDate);
  const r = parseStrictIsoDate(refDate);
  if (!b || !r) return null;
  if (compareDate(r, b) < 0) return null;
  let age = r.y - b.y;
  if (r.m < b.m || (r.m === b.m && r.d < b.d)) age--;
  return age;
}

const STRICT_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * RFC3339, 명시적 timezone 필수. `Date.parse`의 엔진별 lenient 차이에 기대지 않고
 * 형식과 값 범위(달력 날짜 + 시/분/초/오프셋 범위) 둘 다 직접 검증한다.
 * `deterministicMigrate`의 `createdAtFallbackIso` 계약(§5.3)에 쓰인다.
 */
export function isValidStrictDateTime(s: string): boolean {
  if (typeof s !== 'string') return false;
  const match = STRICT_DATETIME_RE.exec(s);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const hh = Number(match[4]);
  const mm = Number(match[5]);
  const ss = Number(match[6]);
  const offset = match[7];

  if (m < 1 || m > 12) return false;
  if (d < 1 || d > daysInMonth(y, m)) return false;
  if (hh > 23) return false;
  if (mm > 59) return false;
  if (ss > 59) return false;

  if (offset !== 'Z') {
    const offMatch = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
    if (!offMatch) return false;
    const offH = Number(offMatch[2]);
    const offM = Number(offMatch[3]);
    if (offH > 23 || offM > 59) return false;
  }

  return true;
}
