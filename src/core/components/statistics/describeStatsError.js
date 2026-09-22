// PR2 §9 — 서버 에러 코드별 고정 안내 문구. statsRepository.js가 던지는 Error는
// httpClient.js 관례대로 `.status`/`.data`를 달고 오므로, 그 `.data.code`(와 INVALID_RECIPE의
// `.data.errors[]`)를 해석해 사용자가 실제로 무엇이 문제인지 알 수 있는 문장으로 바꾼다.
// 1차 구현은 error.message를 그대로 노출해(예: "Request failed (400)") 계획서 §9가 요구한
// 코드별 안내가 빠져 있었다 — 이 함수가 그 자리를 채운다.
const FIXED_MESSAGES = {
  REQUEST_CAPACITY_EXCEEDED: '동시 분석 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  ENGINE_BUSY: '통계 엔진이 사용 중입니다. 잠시 후 다시 시도해 주세요.',
  ENGINE_DEGRADED: '통계 엔진을 일시적으로 사용할 수 없습니다.',
  INPUT_TOO_LARGE: '선택한 범위가 너무 큽니다 — 필터로 좁혀 주세요.',
  TIMEOUT: '분석이 시간 내에 끝나지 않았습니다.',
  PROCESS_ERROR: '통계 엔진 실행 중 오류가 발생했습니다.',
  INVALID_OUTPUT: '통계 엔진이 잘못된 결과를 반환했습니다.',
  OUTPUT_TOO_LARGE: '결과가 너무 커서 처리할 수 없습니다.',
  RESULT_SCHEMA_INVALID: '통계 엔진 결과가 예상 형식과 다릅니다.',
  RUN_NOT_FOUND: '결과를 찾을 수 없습니다 — 다시 분석해 주세요.',
  RUN_EXPIRED: '결과가 만료되었습니다 — 다시 분석해 주세요.',
  RUN_NOT_SUCCEEDED: '실패한 실행은 내보낼 수 없습니다.',
  NOT_FOUND: '기능을 사용할 수 없습니다.',
  FORBIDDEN: '이 작업을 수행할 권한이 없습니다.',
  UNAUTHORIZED: '인증이 만료되었습니다. 다시 로그인해 주세요.',
  // PR3-A — 이변량 관련 HTTP 에러(계획서 §"에러 코드").
  METHOD_NOT_AVAILABLE: '선택한 분석 방법을 현재 데이터로 실행할 수 없습니다.',
  BIVARIATE_EXPORT_NOT_SUPPORTED: '이변량 분석 결과는 아직 CSV 내보내기를 지원하지 않습니다.',
  CORRELATION_MATRIX_EXPORT_NOT_SUPPORTED: '상관행렬 분석 결과는 아직 CSV 내보내기를 지원하지 않습니다.',
};

// PR3-A — zod superRefine 커스텀 이슈(StatsAnalysisRecipeSchema)는 code가 항상
// 'custom' 고정이고 실제 의미는 message 필드에 실린다(예: 'SAME_VARIABLE_SELECTED_TWICE')
// — validateRecipe(비-zod)의 {code,path,message}와 message 자리에 코드 문자열이
// 오는 형태가 겹치므로, 같은 테이블로 둘 다 처리한다.
const RECIPE_ERROR_MESSAGE_LABELS = {
  BIVARIATE_REQUIRES_EXACTLY_TWO_VARIABLES: '이변량 분석은 변수를 정확히 2개 선택해야 합니다.',
  SAME_VARIABLE_SELECTED_TWICE: '같은 변수를 두 번 선택할 수 없습니다.',
  BIVARIATE_REQUIRES_METHOD: '이변량 분석은 방법을 선택해야 합니다.',
  METHOD_TYPE_MISMATCH: '선택한 방법이 변수 타입 조합과 맞지 않습니다.',
  PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING: '현재 카탈로그에는 좌우 대응(짝) 변수가 없어 지원하지 않습니다.',
  // PR4-A2 — interaction/spline/eventLevel 구조검사·의미검증 사유(계획서 §1).
  INTERACTION_REQUIRES_TWO_DISTINCT_VARIABLES: 'interaction 쌍은 서로 다른 두 변수여야 합니다.',
  DUPLICATE_INTERACTION_TERM: '같은 interaction 쌍을 중복해서 추가할 수 없습니다.',
  INTERACTION_VARIABLE_MUST_BE_A_PREDICTOR: 'interaction에 사용한 변수가 설명변수 목록에 없습니다.',
  SPLINE_VARIABLE_MUST_BE_A_PREDICTOR: 'spline에 사용한 변수가 설명변수 목록에 없습니다.',
  DUPLICATE_SPLINE_KEY: '같은 변수를 spline 대상으로 중복 지정할 수 없습니다.',
  SPLINE_INTERACTION_NOT_SUPPORTED: 'spline을 적용한 변수는 interaction에 함께 쓸 수 없습니다.',
  SPLINE_PREDICTOR_MUST_BE_CONTINUOUS: '연속형 변수만 spline을 적용할 수 있습니다.',
  EVENT_LEVEL_REQUIRES_CATEGORICAL_OUTCOME: '사건 레벨은 범주형 결과변수에서만 지정할 수 있습니다.',
  REGRESSION_REQUIRES_AT_LEAST_TWO_VARIABLES: '회귀 분석은 결과변수와 설명변수를 합쳐 2개 이상 선택해야 합니다.',
  REGRESSION_OUTCOME_MUST_BE_IN_VARIABLE_KEYS: '결과변수는 선택한 변수 목록에 포함돼야 합니다.',
  REGRESSION_REQUIRES_REGRESSION_OBJECT: '회귀 분석은 결과변수를 지정해야 합니다.',
  REGRESSION_REFERENCE_LEVEL_UNKNOWN_PREDICTOR: '기준 레벨을 지정한 변수가 설명변수 목록에 없습니다.',
  REGRESSION_REFERENCE_LEVEL_NOT_DECLARED: '지정한 기준 레벨이 해당 변수의 선언된 값이 아닙니다.',
  REGRESSION_PREDICTOR_TYPE_UNSUPPORTED: '이 변수 타입은 회귀 설명변수로 쓸 수 없습니다.',
};

function describeRecipeError(entry) {
  // 커스텀 RecipeValidationError({code,path,message})와 원시 zod issue({path:[], message})
  // 둘 다 올 수 있다(server/src/statsAnalysisContext.ts §9) — path 형태만 다르고 필드명은 같다.
  const path = Array.isArray(entry?.path) ? entry.path.join('.') : entry?.path;
  // PR3-A — message 자체가 알려진 코드 문자열이면(위 두 경로 모두 해당 가능) 번역한다.
  const message = RECIPE_ERROR_MESSAGE_LABELS[entry?.message] || entry?.message || '유효하지 않은 값';
  return path ? `${path}: ${message}` : message;
}

export function describeStatsApiError(err) {
  if (!err) return '알 수 없는 오류';
  const code = err.data?.code || err.data?.error?.code;

  if (code === 'INVALID_RECIPE' && Array.isArray(err.data?.errors) && err.data.errors.length > 0) {
    return err.data.errors.map(describeRecipeError).join('\n');
  }
  if (code && FIXED_MESSAGES[code]) return FIXED_MESSAGES[code];
  return err.message || '알 수 없는 오류가 발생했습니다.';
}
