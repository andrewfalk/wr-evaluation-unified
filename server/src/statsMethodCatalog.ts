// PR3-A — §6.9 방법 카탈로그. availableMethods[] 계산의 단일 진실원(`/preview`와
// `/analyze` 서버측 재검증 양쪽이 공유). 계획서 § "방법 가용성 판정" 최종안:
//   A-1(항상 안전): 카탈로그 메타데이터·§6.1 게이트·쌍 전체 0건 — 브레이크다운
//     상태와 무관하게 항상 계산·노출.
//   A-2("브레이크다운이 깨끗할 때만" 안전): 그룹 개수·표 크기·기대도수 — 관련된
//     모든 그룹/셀이 0 또는 ≥MINIMUM_COHORT일 때만 계산·노출, 아니면 `available`로
//     남기고 세부 판정 자체를 생략(진짜 실행 가능 여부는 B가 실행 시점에 결정).
//   B(이 파일의 책임 아님): 그룹/셀 소수셀·값상수·제외사유 소수셀 — 절대 별도
//     reasonCode를 만들지 않는다(statsBivariateSuppression.ts가 실행 시점에 처리).
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { AvailableMethod, StatsMethodId, StatsMethodReasonCode } from '@wr/contracts';
import type { PairedDatasetResult, PairedRow } from './statsBivariateDataset';
import { groupPairsByLevel } from './statsBivariateDataset';
import { isGroupBreakdownDisclosable, isTableDisclosable } from './statsBivariateDisclosureGate';
import { evaluateInferenceGate } from './statsInferenceGate';
import { isContinuousType, isGroupingType, resolveGroupComparisonRoles, resolveLevelOrder } from './statsBivariateRoles';

const METHOD_LABELS: Record<StatsMethodId, string> = {
  welch_t: 'Welch t 검정',
  mann_whitney: 'Mann-Whitney U 검정',
  anova: '일원분산분석(Welch)',
  kruskal_wallis: 'Kruskal-Wallis 검정',
  chi_square: '카이제곱 검정',
  fisher_exact: 'Fisher 정확검정',
  pearson_correlation: 'Pearson 상관',
  spearman_correlation: 'Spearman 상관',
  paired_t: '대응 t 검정',
  wilcoxon_signed_rank: 'Wilcoxon 부호순위검정',
};

const GROUP_COMPARISON_METHODS: StatsMethodId[] = ['welch_t', 'mann_whitney', 'anova', 'kruskal_wallis'];
const CONTINGENCY_METHODS: StatsMethodId[] = ['chi_square', 'fisher_exact'];
// pearson_correlation/spearman_correlation은 별도 목록이 필요 없다 —
// computeAvailableMethods()의 else 분기(그룹비교도 분할표도 아닌 나머지)가 곧 상관이다.
const PAIRED_METHODS: StatsMethodId[] = ['paired_t', 'wilcoxon_signed_rank'];

function distinctPersons(rows: ReadonlyArray<{ personClusterKey: string }>): number {
  return new Set(rows.map((r) => r.personClusterKey)).size;
}

interface MethodResult {
  status: 'available' | 'conditional' | 'unsupported';
  reasonCode: StatsMethodReasonCode | null;
  required: { rule: string } | null;
  remedy: string | null;
  remedyRecipePatch: { requestedMethod: StatsMethodId } | null;
}

function resultAvailable(): MethodResult {
  return { status: 'available', reasonCode: null, required: null, remedy: null, remedyRecipePatch: null };
}
function resultUnsupported(reasonCode: StatsMethodReasonCode, required: { rule: string } | null = null): MethodResult {
  return { status: 'unsupported', reasonCode, required, remedy: null, remedyRecipePatch: null };
}

function evaluateGroupComparison(
  method: StatsMethodId,
  pairs: PairedRow[],
  typeX: AnalyticsVariableMetadata['type'] | undefined,
  typeY: AnalyticsVariableMetadata['type'] | undefined,
  keyX: string,
  keyY: string,
): MethodResult {
  const roles = resolveGroupComparisonRoles(typeX, typeY, keyX, keyY);
  if (!roles) {
    return resultUnsupported('METHOD_TYPE_MISMATCH');
  }
  const order = resolveLevelOrder(roles.groupType, roles.groupKey);
  if (order === null) {
    return resultUnsupported('METHOD_TYPE_MISMATCH');
  }

  const { groups } = groupPairsByLevel(pairs, roles.groupRoleKey, order);
  const groupsWithCounts = [...groups.values()].map((rows) => ({ personCount: distinctPersons(rows) }));

  if (!isGroupBreakdownDisclosable(groupsWithCounts)) {
    return resultAvailable(); // A-2 생략 — 실제 판정은 B(실행 시점)로 미룬다.
  }

  const observedGroupCount = groupsWithCounts.length;
  if (method === 'welch_t' || method === 'mann_whitney') {
    if (observedGroupCount !== 2) return resultUnsupported('REQUIRES_EXACTLY_TWO_GROUPS');
  } else {
    if (observedGroupCount < 2) return resultUnsupported('REQUIRES_AT_LEAST_TWO_GROUPS');
  }
  return resultAvailable();
}

function evaluateContingency(
  method: StatsMethodId,
  pairs: PairedRow[],
  typeX: AnalyticsVariableMetadata['type'] | undefined,
  typeY: AnalyticsVariableMetadata['type'] | undefined,
  keyX: string,
  keyY: string,
): MethodResult {
  if (!isGroupingType(typeX) || !isGroupingType(typeY)) {
    return resultUnsupported('METHOD_TYPE_MISMATCH');
  }
  const xOrder = resolveLevelOrder(typeX, keyX);
  const yOrder = resolveLevelOrder(typeY, keyY);
  if (xOrder === null || yOrder === null) {
    return resultUnsupported('METHOD_TYPE_MISMATCH');
  }

  const { groups: xGroups } = groupPairsByLevel(pairs, 'x', xOrder);
  const { groups: yGroups } = groupPairsByLevel(pairs, 'y', yOrder);
  const rowLabels = [...xGroups.keys()];
  const colLabels = [...yGroups.keys()];

  const table: number[][] = rowLabels.map((rowLevel) => {
    const rowsForX = xGroups.get(rowLevel) ?? [];
    return colLabels.map((colLevel) => distinctPersons(rowsForX.filter((p) => p.y === colLevel)));
  });

  if (!isTableDisclosable(table)) {
    return resultAvailable(); // A-2 생략 — 실제 판정은 B로 미룬다.
  }

  if (rowLabels.length < 2 || colLabels.length < 2) {
    return resultUnsupported('REQUIRES_AT_LEAST_TWO_LEVELS');
  }
  if (method === 'fisher_exact') {
    if (rowLabels.length !== 2 || colLabels.length !== 2) {
      return resultUnsupported('TABLE_NOT_2X2');
    }
    return resultAvailable();
  }

  // chi_square — 기대도수 검사(§"검정별 세부 스펙" 표: 기대도수<5는 conditional, 차단 아님).
  const rowTotals = table.map((row) => row.reduce((s, c) => s + c, 0));
  const colTotals = colLabels.map((_, j) => table.reduce((s, row) => s + row[j], 0));
  const grandTotal = rowTotals.reduce((s, v) => s + v, 0);
  let hasLowExpected = false;
  if (grandTotal > 0) {
    for (let i = 0; i < rowLabels.length; i += 1) {
      for (let j = 0; j < colLabels.length; j += 1) {
        const expected = (rowTotals[i] * colTotals[j]) / grandTotal;
        if (expected < 5) hasLowExpected = true;
      }
    }
  }
  if (hasLowExpected) {
    const is2x2 = rowLabels.length === 2 && colLabels.length === 2;
    return {
      status: 'conditional',
      reasonCode: 'LOW_EXPECTED_COUNT',
      required: null,
      remedy: is2x2 ? '표본이 작아 Fisher 정확검정을 권장합니다' : null,
      remedyRecipePatch: is2x2 ? { requestedMethod: 'fisher_exact' } : null,
    };
  }
  return resultAvailable();
}

function evaluateCorrelation(
  typeX: AnalyticsVariableMetadata['type'] | undefined,
  typeY: AnalyticsVariableMetadata['type'] | undefined,
): MethodResult {
  if (!isContinuousType(typeX) || !isContinuousType(typeY)) {
    return resultUnsupported('METHOD_TYPE_MISMATCH');
  }
  return resultAvailable();
}

// PR3-B §4/§7 — 상관행렬 전용 방법 카탈로그. 2변수 이변량과 달리 "방법 하나의
// 실행가능 여부"가 이진적이지 않다(pair마다 다르다) — 여기서는 "선택 가능/불가능"
// 까지만 판정하고, 실제 노출은 /analyze 응답의 셀별 suppressed가 담당한다
// (statsCorrelationMatrixSuppression.ts). §6.9.1 "availableMethods[]에 상관행렬
// 모드도 포함"을 이걸로 충족한다.
const CORRELATION_MATRIX_METHOD_IDS: StatsMethodId[] = ['pearson_correlation', 'spearman_correlation'];

// 코드리뷰 수정(2026-09-11) — 원래는 personCount만 보고 pearson/spearman을 항상
// available로 보고했다. 그런데 statsRecipeValidation.ts는 상관행렬의 "전부
// continuous"를 context==='analyze'일 때만(§4/§7 "preview는 관대하다") 검사해
// METHOD_TYPE_MISMATCH로 거부한다 — 그 결과 boolean/ordinal 변수를 섞어 선택해도
// /preview는 두 방법 다 available로 보여주고, 실행(/analyze) 버튼을 눌러야만
// 400을 받는 모순이 생겼다. 2변수 이변량(computeAvailableMethods/evaluateCorrelation,
// 위 §156)은 이미 preview·analyze 양쪽이 공유하는 이 카탈로그 함수 안에서 타입
// 검사를 하므로 이 모순이 없다 — 상관행렬도 같은 원칙으로 맞춘다(타입 자체는
// "아직 method를 안 골랐다"와 무관한 정적 사실이라 preview에서 관대할 이유가
// 없다 — "method 미선택 허용"과 "타입 불일치 허용"은 별개).
export function computeCorrelationMatrixAvailableMethods(
  datasetPersonCount: number,
  variableKeys: string[],
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
  methodPolicyVersion: string,
): AvailableMethod[] {
  const observed = { personCount: datasetPersonCount, rowCount: datasetPersonCount };
  let status: MethodResult['status'];
  let reasonCode: StatsMethodReasonCode | null;
  if (datasetPersonCount === 0) {
    status = 'unsupported';
    reasonCode = 'INSUFFICIENT_DATA';
  } else if (variableKeys.some((key) => !isContinuousType(catalogByKey.get(key)?.type))) {
    status = 'unsupported';
    reasonCode = 'METHOD_TYPE_MISMATCH';
  } else {
    status = 'available';
    reasonCode = null;
  }
  return CORRELATION_MATRIX_METHOD_IDS.map((id) => ({
    id,
    label: METHOD_LABELS[id],
    purpose: 'association',
    status,
    reasonCode,
    observed,
    required: null,
    remedy: null,
    remedyRecipePatch: null,
    methodPolicyVersion,
  }));
}

export function computeAvailableMethods(
  keyX: string,
  keyY: string,
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
  paired: PairedDatasetResult,
  methodPolicyVersion: string,
): AvailableMethod[] {
  const observed = { personCount: paired.includedPersonCount, rowCount: paired.includedCaseCount };

  // 쌍 전체가 완전사례 0건이면(A-1, "0"이라 안전) 전부 동일 사유로 통일.
  if (paired.includedPersonCount === 0) {
    return (Object.keys(METHOD_LABELS) as StatsMethodId[]).map((id) => ({
      id,
      label: METHOD_LABELS[id],
      purpose: 'association',
      status: 'unsupported',
      reasonCode: 'INSUFFICIENT_DATA',
      observed,
      required: null,
      remedy: null,
      remedyRecipePatch: null,
      methodPolicyVersion,
    }));
  }

  // §6.1 게이트 — 실패하면 8개 실행가능 방법 전부 같은 사유(관계적 사실, 인원수와
  // 무관 — 안전하게 노출 가능). 대응 2종은 이 게이트와 무관하게 항상 별도 사유.
  const inferenceGate = evaluateInferenceGate(paired.includedPersonCount, paired.includedCaseCount);

  const typeX = catalogByKey.get(keyX)?.type;
  const typeY = catalogByKey.get(keyY)?.type;

  return (Object.keys(METHOD_LABELS) as StatsMethodId[]).map((id) => {
    let result: MethodResult;
    if (PAIRED_METHODS.includes(id)) {
      result = resultUnsupported('PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING');
    } else if (!inferenceGate.allowed) {
      result = resultUnsupported('REPEATED_MEASURES_NOT_ALIGNED', { rule: 'personCount == rowCount' });
    } else if (GROUP_COMPARISON_METHODS.includes(id)) {
      result = evaluateGroupComparison(id, paired.pairs, typeX, typeY, keyX, keyY);
    } else if (CONTINGENCY_METHODS.includes(id)) {
      result = evaluateContingency(id, paired.pairs, typeX, typeY, keyX, keyY);
    } else {
      result = evaluateCorrelation(typeX, typeY);
    }
    return {
      id,
      label: METHOD_LABELS[id],
      purpose: 'association',
      observed,
      methodPolicyVersion,
      ...result,
    };
  });
}
