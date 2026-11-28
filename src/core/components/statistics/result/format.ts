// 결과 카드 공용 서식·라벨 함수 — P2-78c에서 ResultPanel.tsx의 선언을 본문 그대로 옮겼다(num은 회귀 구역에 있었지만 기술통계 카드·층화 표도 쓴다).
import { formatStat } from '../../charts/numberFormat';
import { GROUPING_TYPES } from '../labels';
import type { AnalyzeMissingPatternEntry } from '@wr/contracts/stats';
import type { CatalogByKey, ResultRecipeView } from './types';

export function variableLabel(catalogByKey: CatalogByKey, key: string): string {
  return catalogByKey.get(key)?.label || key;
}

// [코드리뷰 2026-09-12 2차] 결과 카드만 보고도 어떤 변수의 행/열·그룹/값인지
// 식별할 수 있어야 한다. **committedRecipe**(실행 당시 조건)만 읽는다 — 현재
// 편집 중인 draft 선택값을 쓰면 이전 실행 결과에 지금 고른 변수 이름이 잘못
// 붙는다(§6 "실행된 결과-조건 연결은 절대 안 바뀜"과 같은 원칙).
// Node의 server/src/stats/recipe/analysisContext.ts:92 `const [keyX, keyY] = recipe.variableKeys`와
// server/src/stats/dataset/bivariateRoles.ts의 역할판정(타입으로 그룹/값을 가른다, 선택 순서 아님)을
// 그대로 재현한다 — 서버가 실제로 쓰는 규칙과 갈리면 표시가 실제 응답과 어긋난다.
export function resolveBivariateVariableLabels(catalogByKey: CatalogByKey, committedRecipe: ResultRecipeView | null | undefined) {
  const [keyX, keyY] = committedRecipe?.variableKeys ?? [];
  const xLabel = keyX ? variableLabel(catalogByKey, keyX) : null;
  const yLabel = keyY ? variableLabel(catalogByKey, keyY) : null;
  const typeX = keyX ? catalogByKey.get(keyX)?.type : undefined;
  const typeY = keyY ? catalogByKey.get(keyY)?.type : undefined;
  let groupLabel: string | null = null;
  let valueLabel: string | null = null;
  if (GROUPING_TYPES.has(typeX) && typeY === 'continuous') {
    groupLabel = xLabel;
    valueLabel = yLabel;
  } else if (GROUPING_TYPES.has(typeY) && typeX === 'continuous') {
    groupLabel = yLabel;
    valueLabel = xLabel;
  }
  return { xLabel, yLabel, groupLabel, valueLabel };
}

export function missingPatternsText(patterns: AnalyzeMissingPatternEntry[] | null): string {
  if (patterns === null) return '(비공개)'; // §8 — null(억제)과 []([]0건)을 다른 표기로 구분
  if (patterns.length === 0) return '(없음)';
  return patterns.map((p) => `${p.reasonCode}:${p.count}`).join(', ');
}

export function fmt(n: string | number | boolean | null | undefined): string {
  return n === null || n === undefined ? '—' : String(n);
}

export function fmtCi(ci: readonly number[] | null | undefined): string {
  if (!ci) return '—';
  return `[${formatStat(ci[0])}, ${formatStat(ci[1])}]`;
}

// 자유도: 정수(분자 df 등)는 그대로, 소수(Welch df)는 유효숫자 서식.
export function fmtDf(df: number | null | undefined): string {
  if (df === null || df === undefined) return '—';
  return Number.isInteger(df) ? String(df) : formatStat(df);
}

// PR4-A1 §5 — 연관성 회귀 결과 카드. estimation 4상태(suppressed 포함)를 각각
// 다르게 그린다: non_estimable은 사유 문구만, inference_withheld는 계수표에서
// p·CI 열을 빈 칸으로 두고 상단에 배지(BivariateFooter의 qualityFlags 패턴 재사용).
export function num(v: number | null | undefined, digits = 4): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}
