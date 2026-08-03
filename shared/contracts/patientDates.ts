// 환자 달력 날짜(생년월일 · 재해일자) 검증 — 클라이언트/서버 공통 규칙.
//
// 일괄입력 엑셀에서 생년월일을 텍스트 서식으로 붙여넣어 `4110-02-12` 같은 값이
// 서버 patient_persons.birth_date에 저장되면, assertCompatibleBirthDate가 이후 모든
// 저장을 409로 막아 사용자가 스스로 복구할 수 없는 상태가 된다. 유입 자체를 막는
// 것이 1차 방어선이고, 그 규칙은 클라이언트와 서버가 갈라지면 안 되므로 여기 한 곳에
// 둔다(런타임 의존 없음 — zod 불필요).
//
// canonical 저장 형식: 항상 `YYYY-MM-DD`. `2020/01/02`를 "유효"로만 판정하고 원본
// 문자열을 payload에 남기면 DB DATE 컬럼(2020-01-02)과 payload(2020/01/02)가 갈려
// dateOnly() 비교에서 다시 충돌한다. 그래서 validate 결과의 normalized 값을 DB 컬럼과
// payload/snapshot 양쪽에 저장해야 한다.

/** 허용 최소 날짜. 이보다 이른 값은 오타로 간주한다. */
export const MIN_CALENDAR_DATE = '1900-01-01';

/** 한국 표준시 오프셋(분). 대한민국은 1988년 이후 서머타임이 없어 고정값이 정확하다. */
const KST_OFFSET_MINUTES = 9 * 60;

export type DateRejectReason =
  | 'empty'                // 빈 값 (allowEmpty=false일 때만 거부)
  | 'format'               // YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD 로 해석 불가
  | 'not_a_calendar_date'  // 2026-02-30 처럼 실재하지 않는 날짜
  | 'too_old'              // MIN_CALENDAR_DATE 미만
  | 'future';              // 오늘(KST) 초과

export interface DateValidationResult {
  valid: boolean;
  /** 유효한 경우 canonical `YYYY-MM-DD`. 빈 값이 허용돼 통과한 경우 ''. */
  normalized: string;
  reason: DateRejectReason | null;
}

export interface ValidateDateOptions {
  /**
   * "오늘" 판정 기준 시각. 미지정 시 현재 시각.
   * 테스트에서 고정 날짜를 주입하기 위한 것이며, 서버 TZ와 무관하게 항상 KST로 환산된다.
   */
  now?: Date;
  /** 빈 값/null 허용 여부. 일반 환자 입력은 true, 정정 API는 false. */
  allowEmpty?: boolean;
}

/**
 * 기준 시각을 한국 로컬 달력 날짜(`YYYY-MM-DD`)로 환산한다.
 *
 * 서버 UTC 기준으로 "오늘"을 비교하면 KST 오전 9시 이전에 입력된 오늘자 날짜가
 * 미래로 오판된다. patientPersons.dateOnly()가 같은 이유로 로컬 컴포넌트를 쓰는 것과
 * 같은 맥락이되, 여기서는 서버 TZ 설정에 의존하지 않도록 고정 오프셋으로 환산한다.
 */
export function todayInSeoul(now?: Date): string {
  const base = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const shifted = new Date(base.getTime() + KST_OFFSET_MINUTES * 60 * 1000);
  return formatUtcDateOnly(shifted);
}

function formatUtcDateOnly(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 문자열/Date를 canonical `YYYY-MM-DD`로 정규화한다.
 * 실재하지 않는 달력 날짜(2026-02-30 등)는 null을 반환한다.
 * 범위(1900 이상 · 오늘 이하)는 검사하지 않는다 — validatePastDate가 담당.
 */
export function normalizeCalendarDate(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Date 객체는 로컬 컴포넌트로 읽는다(UTC 변환 시 KST에서 하루 밀림).
    const y = value.getFullYear();
    const m = value.getMonth() + 1;
    const d = value.getDate();
    return buildIfRealDate(y, m, d);
  }

  if (typeof value !== 'string') return null;

  const str = value.trim();
  if (!str) return null;

  // 기존 batchImportHelpers.parseDate와 동일한 구분자 집합(-, ., /).
  const match = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(str);
  if (!match) return null;

  return buildIfRealDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** 연/월/일이 실재하는 달력 날짜일 때만 canonical 문자열을 만든다. */
function buildIfRealDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Date.UTC는 2026-02-30을 2026-03-02로 넘겨버리므로, 되읽어 원래 값과 같은지 확인한다.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) {
    return null;
  }

  return formatUtcDateOnly(probe);
}

/**
 * 생년월일/재해일자 공통 검증.
 * 유효 조건: 실재하는 달력 날짜 · MIN_CALENDAR_DATE 이상 · 오늘(KST) 이하.
 */
export function validatePastDate(value: unknown, options: ValidateDateOptions = {}): DateValidationResult {
  const allowEmpty = options.allowEmpty !== false;

  const isEmpty = value === null
    || value === undefined
    || (typeof value === 'string' && value.trim() === '');

  if (isEmpty) {
    return allowEmpty
      ? { valid: true, normalized: '', reason: null }
      : { valid: false, normalized: '', reason: 'empty' };
  }

  const normalized = normalizeCalendarDate(value);
  if (normalized === null) {
    // 형식 자체가 깨진 경우와 실재하지 않는 날짜를 구분해 사용자에게 다른 안내를 준다.
    const looksLikeDate = typeof value === 'string'
      && /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.test(value.trim());
    return {
      valid: false,
      normalized: '',
      reason: looksLikeDate ? 'not_a_calendar_date' : 'format',
    };
  }

  if (normalized < MIN_CALENDAR_DATE) {
    return { valid: false, normalized: '', reason: 'too_old' };
  }

  if (normalized > todayInSeoul(options.now)) {
    return { valid: false, normalized: '', reason: 'future' };
  }

  return { valid: true, normalized, reason: null };
}

/** 사용자 표시용 한국어 사유 문구. */
export function describeDateRejectReason(reason: DateRejectReason | null): string {
  switch (reason) {
    case 'empty':                return '값이 비어 있습니다';
    case 'not_a_calendar_date':  return '실제로 존재하지 않는 날짜입니다';
    case 'too_old':              return `${MIN_CALENDAR_DATE} 이전 날짜는 사용할 수 없습니다`;
    case 'future':               return '오늘 이후의 날짜는 사용할 수 없습니다';
    case 'format':
    default:                     return '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)';
  }
}
