// 필터 값 입력의 순수 함수(원시 입력 → 서버 계약 값, 표시 글자) — P2-79b에서 RecipePanel.tsx의 선언을 본문 그대로 옮겼다.
import type { CatalogVariable, StatsFilter } from '@wr/contracts/stats';
import type { FilterRaw, FilterBuildResult } from './types';

// server/src/stats/dataset/snapshotColumnVariables.ts의 REGISTERED_AT_KEY와 동일 리터럴.

export function needsValue(operator: string): boolean {
  return operator !== 'is_missing' && operator !== 'not_missing';
}

// 1차 리뷰가 잡은 결함 — 연속형만 Number(value), 나머지는 무조건 문자열로 보내던 기존 코드는
// between(배열 아님)·in(배열 아님)·boolean(문자열 "true"/"false")에서 전부 서버 400을 냈고,
// 빈 숫자는 Number('')===0으로 조용히 통과했다. 연산자·타입별로 원시 UI 입력을 서버 계약이
// 요구하는 정확한 형태로 변환하고, 빈/잘못된 입력은 여기서 막는다(server/src/stats/recipe/validate
// 의 isValueOfType·between·in 검증과 대응).
export function buildFilterValue(variable: CatalogVariable, operator: string, raw: FilterRaw): FilterBuildResult {
  if (!needsValue(operator)) return { ok: true, value: undefined };

  if (variable.type === 'boolean') {
    if (raw !== 'true' && raw !== 'false') return { ok: false, error: '값을 선택하세요.' };
    return { ok: true, value: raw === 'true' };
  }

  if (operator === 'between') {
    const [lowerRaw, upperRaw] = Array.isArray(raw) ? raw : ['', ''];
    if (lowerRaw === '' || upperRaw === '') return { ok: false, error: '하한·상한을 모두 입력하세요.' };
    if (variable.type === 'continuous') {
      const lower = Number(lowerRaw);
      const upper = Number(upperRaw);
      if (!Number.isFinite(lower) || !Number.isFinite(upper)) return { ok: false, error: '숫자를 입력하세요.' };
      if (lower > upper) return { ok: false, error: '하한이 상한보다 클 수 없습니다.' };
      return { ok: true, value: [lower, upper] };
    }
    return { ok: true, value: [lowerRaw, upperRaw] }; // date 등 문자열 타입(현재 카탈로그엔 없음)
  }

  if (operator === 'in') {
    const items = String(raw ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (items.length === 0) return { ok: false, error: '값을 하나 이상 입력하세요(쉼표로 구분).' };
    return { ok: true, value: items };
  }

  // eq/neq/gt/gte/lt/lte
  if (variable.type === 'continuous') {
    if (raw === '' || raw === undefined) return { ok: false, error: '값을 입력하세요.' };
    const num = Number(raw);
    if (!Number.isFinite(num)) return { ok: false, error: '숫자를 입력하세요.' };
    return { ok: true, value: num };
  }
  if (!raw) return { ok: false, error: '값을 입력하세요.' };
  return { ok: true, value: raw };
}

// 3차 리뷰가 잡은 결함 — 배열 길이만 보고 판단하면 in:['low','high'](값 2개, 목록)도
// between처럼 "low ~ high"(범위)로 표시돼 포함 조건을 구간 조건으로 오해하게 만든다.
// 연산자를 함께 받아 between만 범위로, in은 항상 쉼표 목록으로 표시한다.
export function formatFilterValue(operator: string, value: StatsFilter['value']): string {
  if (value === undefined) return '';
  if (operator === 'between' && Array.isArray(value)) return `${value[0]} ~ ${value[1]}`;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

export function emptyRawValueFor(operator: string): FilterRaw {
  return operator === 'between' ? ['', ''] : '';
}

// 등록일처럼 date 타입 필터는 자유 텍스트로 두면 "2024/01/15"·"2024-01-15T00:00:00Z" 같은
// 형식이 섞여 들어온다 — 서버(server/src/stats/recipe/validate/filters.ts)는 YYYY-MM-DD만 엄격히 허용하므로
// (실제 값 비교도 그 형식 기준), 브라우저 네이티브 <input type="date">로 입력 자체를 그
// 형식으로 고정한다(네이티브 date input의 value는 항상 YYYY-MM-DD).
export function inputTypeFor(variableType: string): string {
  if (variableType === 'continuous') return 'number';
  if (variableType === 'date') return 'date';
  return 'text';
}
