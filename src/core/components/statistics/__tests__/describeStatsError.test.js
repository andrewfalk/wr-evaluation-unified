// 리뷰 §4 — 서버 에러 코드별 고정 안내가 구현되지 않고 error.message를 그대로 노출하던
// 결함(예: "Request failed (400)")을 고쳤는지 검증한다.
import { describe, expect, it } from 'vitest';
import { describeStatsApiError } from '../describeStatsError.js';

function apiError(status, data, message) {
  const err = new Error(message || `Request failed (${status})`);
  err.status = status;
  err.data = data;
  return err;
}

describe('describeStatsApiError', () => {
  it('INVALID_RECIPE의 errors[](커스텀 코드)를 path:message로 풀어 보여준다', () => {
    const err = apiError(400, {
      code: 'INVALID_RECIPE',
      errors: [
        { code: 'OPERATOR_NOT_ALLOWED', path: 'filters[0]', message: '허용하지 않는 연산자입니다' },
      ],
    });
    expect(describeStatsApiError(err)).toBe('filters[0]: 허용하지 않는 연산자입니다');
  });

  it('INVALID_RECIPE의 원시 zod issue(path가 배열)도 처리한다', () => {
    const err = apiError(400, {
      code: 'INVALID_RECIPE',
      errors: [{ path: ['variableKeys'], message: 'Required' }],
    });
    expect(describeStatsApiError(err)).toBe('variableKeys: Required');
  });

  it('여러 개의 errors[]는 줄바꿈으로 이어 붙인다', () => {
    const err = apiError(400, {
      code: 'INVALID_RECIPE',
      errors: [
        { path: 'a', message: 'm1' },
        { path: 'b', message: 'm2' },
      ],
    });
    expect(describeStatsApiError(err)).toBe('a: m1\nb: m2');
  });

  it.each([
    ['REQUEST_CAPACITY_EXCEEDED', /동시 분석 요청/],
    ['ENGINE_BUSY', /엔진이 사용 중/],
    ['ENGINE_DEGRADED', /일시적으로 사용할 수 없/],
    ['INPUT_TOO_LARGE', /범위가 너무 큽니다/],
    ['TIMEOUT', /시간 내에 끝나지 않았/],
    ['PROCESS_ERROR', /엔진 실행 중 오류/],
    ['RESULT_SCHEMA_INVALID', /예상 형식과 다릅니다/],
    ['RUN_NOT_FOUND', /찾을 수 없습니다/],
    ['RUN_EXPIRED', /만료되었습니다/],
    ['RUN_NOT_SUCCEEDED', /실패한 실행은 내보낼 수 없/],
  ])('%s는 고정 안내 문구로 매핑된다', (code, pattern) => {
    const err = apiError(500, { code });
    expect(describeStatsApiError(err)).toMatch(pattern);
  });

  it('알 수 없는 코드는 err.message로 폴백한다', () => {
    const err = apiError(500, { code: 'SOMETHING_NEW' }, '원본 메시지');
    expect(describeStatsApiError(err)).toBe('원본 메시지');
  });

  it('err 자체가 없으면 일반 문구를 반환한다', () => {
    expect(describeStatsApiError(null)).toBe('알 수 없는 오류');
  });
});
