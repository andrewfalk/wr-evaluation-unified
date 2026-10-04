// 리뷰 §4 — 서버 에러 코드별 고정 안내가 구현되지 않고 error.message를 그대로 노출하던
// 결함(예: "Request failed (400)")을 고쳤는지 검증한다.
import { describe, expect, it } from 'vitest';
import { describeStatsApiError, getUnknownVariableKeys } from '../describeStatsError.js';

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

  describe('PURPOSE_NOT_ALLOWED / UNKNOWN_VARIABLE', () => {
    const catalogByKey = new Map([
      ['assocOnly', { key: 'assocOnly', label: '성별', allowedAnalysisPurposes: ['association', 'prediction'] }],
    ]);
    const purposeErr = apiError(400, {
      code: 'INVALID_RECIPE',
      errors: [{ code: 'PURPOSE_NOT_ALLOWED', path: 'assocOnly', message: 'assocOnly는 analysisPurpose "formula_audit"를 허용하지 않는다(허용: association, prediction)' }],
    });

    it('내부 키 대신 변수명·실패한 요청의 목적·사용 가능한 목적을 한글로 보여준다', () => {
      expect(describeStatsApiError(purposeErr, { catalogByKey, analysisPurpose: 'formula_audit' }))
        .toBe("'성별'은(는) '공식 감사' 목적에서 쓸 수 없습니다. 사용 가능한 목적: 연관성, 예측");
    });

    it('요청 목적이 없으면 목적명을 생략한다', () => {
      expect(describeStatsApiError(purposeErr, { catalogByKey }))
        .toBe("'성별'은(는) 이 목적에서 쓸 수 없습니다. 사용 가능한 목적: 연관성, 예측");
    });

    it('카탈로그에 변수가 없으면 키로 폴백하되 내부 문구(analysisPurpose)는 노출하지 않는다', () => {
      const msg = describeStatsApiError(purposeErr, { analysisPurpose: 'formula_audit' });
      expect(msg).toBe("'assocOnly'은(는) '공식 감사' 목적에서 쓸 수 없습니다.");
      expect(msg).not.toMatch(/analysisPurpose/);
    });

    it('context 인자가 없으면 기존 동작(path: message)을 유지한다', () => {
      const err = apiError(400, { code: 'INVALID_RECIPE', errors: [{ path: 'a', message: 'm1' }] });
      expect(describeStatsApiError(err)).toBe('a: m1');
    });

    it('삭제된 변수(ageAtEvaluation)는 대체 변수 안내를, 그 외 알 수 없는 변수는 카탈로그 변경 안내를 보여준다', () => {
      const removed = apiError(400, { code: 'INVALID_RECIPE', errors: [{ code: 'UNKNOWN_VARIABLE', path: 'patient.identity.ageAtEvaluation', message: 'x' }] });
      expect(describeStatsApiError(removed)).toMatch(/만 나이\(재해일자 기준\)/);
      const other = apiError(400, { code: 'INVALID_RECIPE', errors: [{ code: 'UNKNOWN_VARIABLE', path: 'foo.bar', message: 'x' }] });
      expect(describeStatsApiError(other)).toMatch(/카탈로그가 변경되었을 수 있습니다/);
    });

    it('getUnknownVariableKeys는 UNKNOWN_VARIABLE 항목의 키만 뽑는다', () => {
      const err = apiError(400, {
        code: 'INVALID_RECIPE',
        errors: [
          { code: 'UNKNOWN_VARIABLE', path: 'a', message: 'x' },
          { code: 'PURPOSE_NOT_ALLOWED', path: 'b', message: 'y' },
        ],
      });
      expect(getUnknownVariableKeys(err)).toEqual(['a']);
      expect(getUnknownVariableKeys(null)).toEqual([]);
    });
  });
});
