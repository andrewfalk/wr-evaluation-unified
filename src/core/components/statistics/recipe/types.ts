// 레시피 패널과 그 조각(recipe/*)이 함께 쓰는 타입 — P2-79b에서 RecipePanel.tsx 머리의 타입을 그대로 옮겼다.
import type { CatalogVariable, StatsFilter, PreviewResponse } from '@wr/contracts/stats';

export type CatalogByKey = Map<string, CatalogVariable>;
/** 필터 값 입력의 원시 값 — 범위(between)는 [하한, 상한], 그 밖은 글자. */
export type FilterRaw = string | string[];
/**
 * buildFilterValue의 결과 — 성공이면 value, 실패면 error. 이 파일은 JS(작업대)가 import해 완화 설정(tsconfig.client.js.json)으로도
 * 검사되는데, 그 설정은 boolean 판별자(`ok`)로 합집합을 좁히지 않아 한 모양으로 적는다.
 */
export interface FilterBuildResult {
  ok: boolean;
  value?: StatsFilter['value'];
  error?: string;
}

/** 작업대의 미리보기 상태(previewState) — 이 패널이 읽는 필드. */
export interface RecipePreviewState {
  key: string | null;
  status: string;
  result: PreviewResponse | null;
  error: unknown;
  /** 실패한 요청의 분석 목적(오류 문구용). */
  requestPurpose?: string;
}

/** 모드·목적 전환으로 자동 정리된 변수·필터 안내. */
export interface RecipeTransitionNotice {
  removedVariables: string[];
  removedFilters: StatsFilter[];
}

export interface RecipePanelProps {
  catalog: { variables?: CatalogVariable[]; minimumCohort?: number } | null | undefined;
  grain?: string;
  supportedGrains?: string[];
  unsupportedGrains?: Array<{ grain: string }>;
  onGrainChange?: (grain: string) => void;
  selectedKeys: string[];
  onRemoveVariable: (key: string) => void;
  analysisMode: string;
  onAnalysisModeChange: (mode: string) => void;
  modeChangeBlockedNotice: boolean;
  requestedMethod: string | null;
  onRequestedMethodChange: (method: string) => void;
  outcomeKey: string | null;
  onOutcomeKeyChange: (key: string | null) => void;
  standardizePredictors?: boolean;
  onStandardizePredictorsChange?: (value: boolean) => void;
  interactionTerms?: Array<[string, string]>;
  onInteractionTermsChange?: (terms: Array<[string, string]>) => void;
  splineKeys?: string[];
  onSplineKeysChange?: (keys: string[]) => void;
  eventLevel?: string;
  onEventLevelChange?: (level: string) => void;
  stratifyByKey?: string | null;
  onStratifyByKeyChange?: (key: string | null) => void;
  analysisPurpose: string;
  onAnalysisPurposeChange: (purpose: string) => void;
  transitionNotice?: RecipeTransitionNotice | null;
  onDismissTransitionNotice?: () => void;
  formulaPolicies: Record<string, string>;
  onFormulaPolicyChange: (family: string, policy: string) => void;
  filterDraft: StatsFilter[];
  onFilterDraftChange: (filters: StatsFilter[]) => void;
  appliedFilters: StatsFilter[];
  onApplyFilters: () => void;
  previewState: RecipePreviewState;
  isPreviewCurrent: boolean;
  canExecute: boolean;
  isAnalyzing: boolean;
  onRunAnalyze: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}
