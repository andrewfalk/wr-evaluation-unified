// EMR 진료기록 일괄 추출의 실패 사유 집계(Phase 2 C7-a FX-4). 완료 알림에 "실패 N명"만 보이던 것을 사유별로 센다.
// 사유 문구는 설치본·EMR 도우미가 준 문자열을 그대로(한 줄로 펴고 길면 자른다) 쓴다 — 문구를 다듬지 않는다.
// 설치본(preload)은 바꾸지 않는다: 실패 응답 { success:false, error } 모양은 7.1.4와 7.3.2 설치본이 같다.

/** 추출 결과의 환자 번호가 요청한 환자와 다를 때 — 다른 환자의 기록을 섞지 않고 건너뛴다. */
export const EXTRACT_FAILURE_PATIENT_MISMATCH = 'EMR 화면의 등록번호가 요청한 환자와 다름';
/** 추출 호출이 예외로 끝났을 때(문구가 환자마다 다를 수 있어 하나로 묶는다). */
export const EXTRACT_FAILURE_EXCEPTION = '처리 중 오류';
/** 실패 응답에 사유가 없을 때. */
export const EXTRACT_FAILURE_NO_REASON = '사유 없음';
/** 완료 알림에 적는 사유 가짓수 상한(많이 나온 순). */
export const EXTRACT_FAILURE_MAX_REASONS = 3;
/** 사유 한 줄의 글자 수 상한. */
export const EXTRACT_FAILURE_MAX_LENGTH = 120;

/** 실패 응답의 사유 — result.error, 없으면 result.message, 둘 다 없으면 "사유 없음". 한 줄로 펴고 길면 자른다. */
export function extractFailureReason(result: unknown): string {
  const fields = (typeof result === 'object' && result !== null ? result : {}) as { error?: unknown; message?: unknown };
  const raw = [fields.error, fields.message].find(value => typeof value === 'string' && value.trim() !== '');
  if (typeof raw !== 'string') return EXTRACT_FAILURE_NO_REASON;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > EXTRACT_FAILURE_MAX_LENGTH ? `${oneLine.slice(0, EXTRACT_FAILURE_MAX_LENGTH)}…` : oneLine;
}

/** 사유 → 명 수(처음 나온 순서를 기억한다). */
export type ExtractFailureTally = Map<string, number>;

export function addExtractFailure(tally: ExtractFailureTally, reason: string): void {
  tally.set(reason, (tally.get(reason) || 0) + 1);
}

/**
 * 완료 알림에 붙일 줄들 — 많이 나온 순(같으면 먼저 나온 순)으로 상한까지 "실패 사유: <문구> (N명)", 나머지는 "그 밖 N명".
 * 실패가 없으면 빈 배열(알림 문구는 지금과 같다).
 */
export function formatExtractFailures(tally: ExtractFailureTally): string[] {
  const entries = [...tally.entries()].map(([reason, count], order) => ({ reason, count, order }));
  entries.sort((left, right) => right.count - left.count || left.order - right.order);
  const shown = entries.slice(0, EXTRACT_FAILURE_MAX_REASONS);
  const restCount = entries.slice(EXTRACT_FAILURE_MAX_REASONS).reduce((sum, entry) => sum + entry.count, 0);
  const lines = shown.map(entry => `실패 사유: ${entry.reason} (${entry.count}명)`);
  if (restCount > 0) lines.push(`그 밖 ${restCount}명`);
  return lines;
}
