// 원본 입력값 엄격 숫자 파서 — case grain 합계 변수(shoulder.case.sum*, cervical.case.*)가 공유한다.
//
// 검사 순서가 중요하다(shoulder 원본 추출기의 기존 처리와 동일):
// 1) null·undefined·공백 문자열만 blank. String(raw)로 강제변환해서 빈값을 판정하면
//    [] · [null]이 빈 문자열이 되어 손상 입력이 조용히 blank(= 미입력)로 오인된다.
// 2) 그 외 number/string이 아닌 값은 invalid.
// 3) Number()로 전체 문자열을 변환 — parseFloat('2h')=2처럼 숫자-접두 문자열을 통과시키지 않고,
//    유한값이 아니거나 음수면 invalid (시간·횟수·초·kg·일수는 물리적으로 음수가 불가능).
//
// 예측 코호트(statsPredictionCohort)는 missing만 보고 qualityFlags는 보지 않으므로, 손상값은
// 호출 쪽에서 value가 아니라 결측(missing)으로 표현해야 한다.

export type StrictNumeric =
  | { kind: 'blank' }
  | { kind: 'invalid' }
  | { kind: 'value'; value: number };

export function parseStrictNonNegative(raw: unknown): StrictNumeric {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { kind: 'blank' };
  }
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return { kind: 'invalid' };
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) {
    return { kind: 'invalid' };
  }
  return { kind: 'value', value: n };
}
