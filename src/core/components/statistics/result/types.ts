// 결과 패널과 결과 카드(result/*)가 함께 쓰는 타입 — P2-78c에서 ResultPanel.tsx 머리의 타입을 그대로 옮겼다.
import type { buildDiscreteDisplay } from '../../charts/discreteLevels';
import type { CatalogVariable, AnalyzeContinuousResult, AnalyzeDiscreteResult, AnalyzeBivariateResult, AnalyzeRegressionResult, AnalyzePredictionResult, AnalyzeDescriptiveStratifiedResult, Table1ContinuousCell, Table1DiscreteCell } from '@wr/contracts/stats';

export type CatalogByKey = Map<string, CatalogVariable>;
/**
 * 계약의 "억제 | 공개" 합집합을 한 모양으로 편 지역 타입 — 한쪽에만 있는 필드는 선택이다. 이 파일은 JS(작업대)가 import해
 * 완화 설정(tsconfig.client.js.json, strict 끔)으로도 검사되는데, 그 설정은 boolean 판별자(`suppressed`)로 합집합을
 * 좁히지 않는다 — 그래서 합집합 대신 화면이 읽는 필드를 펼쳐 적는다(서버 응답 타입은 지금 코드가 읽는 모양대로).
 */
type Loose<U, Common extends keyof U = never> = Pick<U, Common> & { suppressed: boolean }
  & Partial<Omit<Extract<U, { suppressed: false }>, 'suppressed' | Common>>
  & Partial<Omit<Extract<U, { suppressed: true }>, 'suppressed' | Common>>;
export type ContinuousRow = Loose<AnalyzeContinuousResult, 'variableKey' | 'kind'>;
export type DiscreteRow = Loose<AnalyzeDiscreteResult, 'variableKey' | 'kind'>;
export type BivariateView = Loose<AnalyzeBivariateResult, 'method'>;
export type BivariateRevealed = Extract<AnalyzeBivariateResult, { suppressed: false }>;
export type RegressionView = Loose<AnalyzeRegressionResult>;
export type PredictionView = Loose<AnalyzePredictionResult>;
export type PredictionBodyLambda = Extract<AnalyzePredictionResult, { suppressed: false }>['lambda'];
export type StratifiedView = Loose<AnalyzeDescriptiveStratifiedResult, 'stratifyByKey'>;
export type Table1ContinuousView = Loose<Table1ContinuousCell, 'variableKey' | 'kind'>;
export type Table1DiscreteView = Loose<Table1DiscreteCell, 'variableKey' | 'kind'>;
export interface Table1GroupView {
  groupId: string;
  continuous: Table1ContinuousView[];
  discrete: Table1DiscreteView[];
}
/** buildDiscreteDisplay(JS)가 돌려주지만 JSDoc 반환 타입에는 빠진 rawMode(원본 표시 때의 최빈값)까지. */
export type DiscreteDisplay = ReturnType<typeof buildDiscreteDisplay> & { rawMode?: string | boolean | null };

/** 결과 패널이 읽는 실행 조건(작업대의 committedRecipe) — 여기서 읽는 필드만 적는다. */
export interface ResultRecipeView {
  analysisMode?: string;
  variableKeys?: string[];
}
