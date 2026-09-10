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
};

function describeRecipeError(entry) {
  // 커스텀 RecipeValidationError({code,path,message})와 원시 zod issue({path:[], message})
  // 둘 다 올 수 있다(server/src/statsAnalysisContext.ts §9) — path 형태만 다르고 필드명은 같다.
  const path = Array.isArray(entry?.path) ? entry.path.join('.') : entry?.path;
  const message = entry?.message || '유효하지 않은 값';
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
