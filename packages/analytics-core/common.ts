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

// 그레인 단순화(3개: case/job/disease) + 공통변수 브로드캐스트 — 계획 "공통변수
// 브로드캐스트 설계" 절. 판정에 필요한 필드(grain/sensitivity/type) 세 개만 구조적으로
// 받는다 — types.ts의 AnalyticsVariableMetadata를 그대로 import해도 되지만, common.ts는
// 의도적으로 다른 모듈에 의존하지 않는 leaf 유틸이라 구조적 타입으로 최소화한다.
// 클라이언트(CatalogPanel.jsx/RecipePanel.jsx, `@analytics-core/common` → dist)와 서버
// (statsRecipeValidation.ts, `@wr/analytics-core`) 양쪽이 이 함수 하나를 그대로 import해서
// 쓴다 — 복제 구현 금지(리뷰 지적 — 클라이언트/서버 별도 구현은 드리프트 위험).
export interface GrainCompatibilityVariable {
  grain: string;
  sensitivity: string;
  type: string;
}

/** case 변수는 다른 grain(job/disease)에도 안전하게 값을 복제(브로드캐스트)할 수 있다 —
 * 단, 유사식별자·고카디널리티 변수는 세부 grain에 뿌리면 다른 변수와 조합했을 때
 * 재식별 위험이 커지므로 제외한다. */
export function isBroadcastSafe(variable: GrainCompatibilityVariable): boolean {
  return variable.sensitivity !== 'quasi_identifier' && variable.type !== 'high_cardinality';
}

/** 이 변수를 `grain` 분석/필터 후보로 쓸 수 있는가 — 자기 grain과 정확히 같거나,
 * case 브로드캐스트 안전 변수를 job/disease grain에서 보는 경우다. job/disease → case
 * 역방향 롤업은 이번 범위 밖(항상 false). 목적지 grain 자체가 유효한 3개(case/job/disease)
 * 중 하나가 아니면 동일성 검사까지 가기 전에 즉시 거부한다(순서 중요 — 이 검사를 동일성
 * 검사 뒤에 두면 무효한 값끼리 우연히 같을 때 잘못 통과한다, 리뷰 지적). */
export function isGrainCompatible(variable: GrainCompatibilityVariable, grain: string): boolean {
  if (grain !== 'case' && grain !== 'job' && grain !== 'disease') return false;
  if (variable.grain === grain) return true;
  return variable.grain === 'case' && isBroadcastSafe(variable);
}
