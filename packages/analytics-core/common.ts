// src/core/utils/common.js에서 이동. `toLocalDateString`은 의도적으로 로컬 타임존에
// 의존하는 UI 표시 함수라 이동하지 않는다(옛 파일에 그대로 남음) — 계획서 §1/§4.6 참고.

/** BMI 계산 — 원본과 동일 로직. */
export function calculateBMI(h: unknown, w: unknown): string | number {
  const H = parseFloat(String(h));
  const W = parseFloat(String(w));
  return H && W && H > 0 ? (W / (H / 100) ** 2).toFixed(1) : 0;
}

/**
 * 만 나이 계산 — UI 호환용 hybrid.
 * strict `YYYY-MM-DD`면 로컬 컴포넌트 생성자(`new Date(y, m-1, d)`)로 만들어 생성·읽기가
 * 같은 타임존 안에서만 일어나게 한다(교차 타임존 비결정성이 없다 — 원본 버그였던
 * `new Date(문자열)`의 UTC 파싱 + 로컬 getter 조합을 strict 케이스에서 회피).
 * strict 매치가 안 되는 값(레거시 비정형 포맷)은 원본과 동일하게 lenient `new Date(문자열)`로
 * 폴백해 기존 UI 동작을 100% 보존한다.
 *
 * analytics-core의 extractor(§4.6, dates.ts)는 이 함수를 쓰지 않는다 — `Date` 자체를 아예
 * 안 쓰는 별도 strict-only 파서(`calculateAgeStrict`)를 쓴다. 둘은 서로 다른 목적(UI 호환 vs
 * 분석 결정성)의 별개 구현이라 경쟁하지 않는다.
 */
export function calculateAge(b: unknown, r: unknown): number {
  if (!b || !r) return 0;
  const birth = parseLocalOrLenient(String(b));
  const ref = parseLocalOrLenient(String(r));
  let age = ref.getFullYear() - birth.getFullYear();
  if (
    ref.getMonth() < birth.getMonth() ||
    (ref.getMonth() === birth.getMonth() && ref.getDate() < birth.getDate())
  ) {
    age--;
  }
  return age;
}

const STRICT_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseLocalOrLenient(s: string): Date {
  const match = STRICT_DATE_RE.exec(s);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  return new Date(s);
}

/**
 * 키 순서에 무관하게 안정적인 JSON 문자열 생성(PostgreSQL JSONB 등은 객체 키 삽입 순서를
 * 보존하지 않으므로, 이 함수 없이 JSON.stringify로 비교하면 값이 같아도 키 순서만 달라져
 * "변경됨"으로 오판할 수 있음). §5.4 결정성 테스트의 byte-identical 비교에 재사용한다.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val)
        .sort()
        .reduce((sorted: Record<string, unknown>, k) => {
          sorted[k] = (val as Record<string, unknown>)[k];
          return sorted;
        }, {});
    }
    return val;
  });
}

/** XSS 방지 — 원본과 동일 로직. */
export function escapeHtml(str: unknown): unknown {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
