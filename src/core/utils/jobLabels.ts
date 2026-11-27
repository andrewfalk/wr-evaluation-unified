// 화면의 직력 표기(REFACTORING_ROADMAP Phase 2 C8, P2-72f — 사용자 결정 4, 2026-11-27).
// 모듈 평가·결과 화면과 기본정보가 직력 번호·빈 직종명·근무 기간을 곳마다 다르게 적던 것을 한 규칙으로 맞춘다:
//   직력 번호는 붙여 쓴다(`직력1`), 빈 직종명은 `(미입력)`, 근무 기간이 0이거나 계산할 수 없으면 `-`.
// 화면 표기만 다룬다 — 출력(소견서·EMR)의 빈 직종명 낱말은 src/core/narrative/phrases.ts가 따로 갖는다(결정 5).
// 척추 계산(analytics-core)도 빈 직종명을 같은 `(미입력)`으로 채운다(mddm.ts·vibration.ts).

/** 화면에서 빈 직종명 대신 보이는 낱말. */
export const EMPTY_JOB_NAME_LABEL = '(미입력)';

/** `직력{n}` — n은 1부터 세는 직력 번호. */
export function formatJobNumber(n: number): string {
  return `직력${n}`;
}

/** 직종명, 비었으면 `(미입력)`. */
export function jobNameOrEmpty(jobName: string | null | undefined): string {
  return jobName || EMPTY_JOB_NAME_LABEL;
}

/** `직력{n}: {직종명 또는 (미입력)}` — 직력 카드·결과 카드의 제목. */
export function formatJobTitle(n: number, jobName: string | null | undefined): string {
  return `${formatJobNumber(n)}: ${jobNameOrEmpty(jobName)}`;
}

/** 근무 기간(년)을 `X.X년`으로, 0 이하이거나 유한한 수가 아니면 `-`. */
export function formatPeriodYears(years: number | null | undefined): string {
  return typeof years === 'number' && Number.isFinite(years) && years > 0 ? `${years.toFixed(1)}년` : '-';
}
