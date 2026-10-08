// 직력 1건의 종사 연수(근속기간) 판정 — job.identity.tenureYears·대표 직력(근속 최장) 선정·
// 무릎 쪼그려앉기 가중평균/누적이 모두 이 한 곳의 규칙을 쓴다. 변수마다 "이 직력의 기간이
// 유효한가"에 대해 서로 다른 답을 내지 않게 하려는 공유 헬퍼다(원래 job/extractors.ts의
// private 함수였고, 로직은 옮기기만 했다).

import { parseStrictIsoDate, compareDate } from './dates';
import { parseWorkPeriodOverride, calculateWorkPeriod } from './workPeriod';

export type TenureResult = { kind: 'blank' } | { kind: 'invalid' } | { kind: 'ok'; years: number };

export interface JobTenureSource {
  startDate?: unknown;
  endDate?: unknown;
  workPeriodOverride?: unknown;
}

function isBlank(x: unknown): boolean {
  return x === null || x === undefined || String(x).trim() === '';
}

// parseWorkPeriodOverride(workPeriod.ts)는 정규식 부분일치라 "-10년"→10, "1.5년"→5, 배열
// String() 강제변환("['10년']"→'10년') 같은 오분류를 그대로 통과시킨다. 이 함수는 knee 등 이미
// 검증된 기존 코드가 그대로 의존하는 공유 함수라 동작을 바꾸지 않고, 호출 전에 전체 형식을
// 엄격히 검증한다. "N년"·"N개월"·"N년 M개월"(정수, 공백 허용) 형식만 허용하고 그 외(음수·소수·
// 다른 문자 포함·비문자열)는 전부 거부한다.
const STRICT_WORK_PERIOD_OVERRIDE_RE = /^(?:(\d+)\s*년)?\s*(?:(\d+)\s*개월)?$/;
function isStrictWorkPeriodOverride(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  const match = STRICT_WORK_PERIOD_OVERRIDE_RE.exec(trimmed);
  return !!match && (match[1] !== undefined || match[2] !== undefined);
}

// knee/extractors.ts의 isValidPositivePeriod와 같은 원칙(override 우선, 그 다음 strict 날짜 비교)이지만
// blank/invalid를 구분해 반환값에 그대로 반영한다(미입력과 파싱불가는 다른 결측 사유다).
export function computeJobTenureYears(job: JobTenureSource): TenureResult {
  const override = job.workPeriodOverride;
  if (!isBlank(override)) {
    if (typeof override !== 'string' || !isStrictWorkPeriodOverride(override)) return { kind: 'invalid' };
    const years = parseWorkPeriodOverride(override);
    return years > 0 ? { kind: 'ok', years } : { kind: 'invalid' };
  }
  const { startDate, endDate } = job;
  if (isBlank(startDate) && isBlank(endDate)) return { kind: 'blank' };
  if (isBlank(startDate) || isBlank(endDate)) return { kind: 'invalid' }; // 한쪽만 입력된 불완전 상태
  if (typeof startDate !== 'string' || typeof endDate !== 'string') return { kind: 'invalid' };
  const s = parseStrictIsoDate(startDate);
  const e = parseStrictIsoDate(endDate);
  if (!s || !e) return { kind: 'invalid' };
  if (compareDate(e, s) <= 0) return { kind: 'invalid' };
  return { kind: 'ok', years: calculateWorkPeriod(startDate, endDate) };
}
