// Table1 스트라티피케이션 — 그룹별 엔진 요청 조립 + 억제 + Table1 최소 DTO 투영.
// 범위는 "동일 변수의 전체·그룹 통계 간 차감 방지"까지다(계획서 §4) — 여러 요청을
// 조합하는 교차질의 공격은 방어 범위 밖(statsPolicy.ts의 differencing guard를
// 값/관계 기반으로 재설계하는 훨씬 큰 별도 이니셔티브가 필요, 이번 범위 아님).
import type { Pool } from 'pg';
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import {
  AnalyzeDescriptiveStratifiedResultSchema,
  type AnalyzeContinuousResult,
  type AnalyzeDescriptiveStratifiedGroupResult,
  type AnalyzeDescriptiveStratifiedResult,
  type AnalyzeDiscreteResult,
  type Table1ContinuousCell,
  type Table1DiscreteCell,
} from '@wr/contracts';
import type { AnalysisContext } from './statsAnalysisContext';
import type { StratifyPartitionResult, StratifyRowGroup } from './statsDescriptiveStratify';
import { buildStatsEngineRequest, computeDescriptiveSuppression } from './statsDescriptiveSuppression';
import { assertWithinLimits, runStatsEngine, type EngineRunOpts, type StatsEngineRawResult, type StatsEngineRequest } from './statsEngine';

const GROUP_KEY_SEPARATOR = '\u0000';

// 단위테스트가 합성키 왕복을 직접 검증할 수 있도록 export한다.
export function compositeKey(groupId: string, variableKey: string): string {
  return `${groupId}${GROUP_KEY_SEPARATOR}${variableKey}`;
}

export function splitCompositeKey(key: string): { groupId: string; variableKey: string } {
  const idx = key.indexOf(GROUP_KEY_SEPARATOR);
  return { groupId: key.slice(0, idx), variableKey: key.slice(idx + 1) };
}

// 그룹마다 기존 buildStatsEngineRequest(무수정)를 호출해 그대로 이어붙인다 — 1회의
// 엔진 호출로 모든 그룹×변수를 처리한다. total 그룹의 rows(=전체 dataset rows)와
// 나머지 그룹(레벨+기타+결측, 합쳐서 total과 같은 크기)이 같은 데이터를 중복
// 전송하므로 변수당 전송 값 개수는 그룹 수와 무관하게 약 2×(전체 rows 수)다 —
// 기존 MAX_TOTAL_VALUES/MAX_VALUES_PER_VARIABLE(statsEngine.ts, 무수정)가 그대로
// 방어한다. assertInputWithinLimitsForMode(statsAnalyzeHandler.ts)가 실제 워커와
// 동일하게 이 함수로 조립한 요청을 검사해야 한다(사전검사-워커 불일치 방지).
export function buildStratifiedStatsEngineRequest(
  groups: readonly StratifyRowGroup[],
  variableKeys: string[],
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
): StatsEngineRequest {
  const variables: StatsEngineRequest['variables'] = [];
  for (const group of groups) {
    const groupRequest = buildStatsEngineRequest(group.rows, variableKeys, catalogByKey);
    for (const v of groupRequest.variables) {
      variables.push({ ...v, key: compositeKey(group.groupId, v.key) });
    }
  }
  return { variables };
}

function splitRawByGroup(
  raw: StatsEngineRawResult,
  groupIds: readonly string[],
): Map<string, StatsEngineRawResult> {
  const byGroup = new Map<string, StatsEngineRawResult>();
  for (const id of groupIds) byGroup.set(id, { continuous: [], discrete: [] });
  for (const c of raw.continuous) {
    const { groupId, variableKey } = splitCompositeKey(c.variableKey);
    byGroup.get(groupId)!.continuous.push({ ...c, variableKey });
  }
  for (const d of raw.discrete) {
    const { groupId, variableKey } = splitCompositeKey(d.variableKey);
    byGroup.get(groupId)!.discrete.push({ ...d, variableKey });
  }
  return byGroup;
}

// Table1 전용 최소 DTO로 투영한다 — missingPatterns/histogram/boxplot/skewness/
// kurtosis/nullReasons는 명시적으로 읽지 않으므로 구조적으로 새지 않는다(스프레드
// 금지, shared/contracts/stats.ts의 "1차 리뷰가 뒤집은 전제 3" 참고). 단위테스트가
// 이 투영 자체(부가정보 미포함)를 직접 검증할 수 있도록 export한다.
export function toTable1ContinuousCell(full: AnalyzeContinuousResult): Table1ContinuousCell {
  if (full.suppressed) {
    return { variableKey: full.variableKey, kind: 'continuous', suppressed: true };
  }
  return {
    variableKey: full.variableKey,
    kind: 'continuous',
    suppressed: false,
    n: full.n,
    missingCount: full.missingCount,
    mean: full.mean,
    sd: full.sd,
    median: full.median,
    q1: full.q1,
    q3: full.q3,
    iqr: full.iqr,
    min: full.min,
    max: full.max,
  };
}

export function toTable1DiscreteCell(full: AnalyzeDiscreteResult): Table1DiscreteCell {
  if (full.suppressed) {
    return { variableKey: full.variableKey, kind: 'discrete', suppressed: true };
  }
  return {
    variableKey: full.variableKey,
    kind: 'discrete',
    suppressed: false,
    n: full.n,
    missingCount: full.missingCount,
    levels: full.levels,
    mode: full.mode,
  };
}

// total 강제 억제(§4, 단일 규칙) — 변수별로 total을 제외한 그룹 중 하나라도
// suppressed면 total의 그 변수도 완전히 새 객체로 교체한다. 스프레드({...cell,
// suppressed:true})는 금지 — 기존 수치 필드가 객체에 남을 수 있다. n·레벨별
// 빈도·missingCount는 total이 그룹들의 정확한 합이라 직접 역산되고, 평균·표준
// 편차도 합계/제곱합(S=n×평균, Q=(n-1)×sd²+n×평균²)으로 변환하면 마찬가지로
// 역산되므로 예외 없이 변수의 통계 필드 전체를 셀 단위로 통째로 억제한다.
// 단위테스트가 이 규칙 자체(스프레드 없는 객체 교체)를 직접 검증할 수 있도록 export한다.
export function forceTotalSuppressionWhereAnyGroupSuppressed(
  byGroup: AnalyzeDescriptiveStratifiedGroupResult[],
): void {
  const total = byGroup.find((g) => g.groupId === 'total');
  if (!total) return;
  const others = byGroup.filter((g) => g.groupId !== 'total');

  total.continuous = total.continuous.map((cell): Table1ContinuousCell => {
    if (cell.suppressed) return cell;
    const anySuppressed = others.some((g) =>
      g.continuous.some((c) => c.variableKey === cell.variableKey && c.suppressed),
    );
    return anySuppressed
      ? { variableKey: cell.variableKey, kind: 'continuous', suppressed: true }
      : cell;
  });

  total.discrete = total.discrete.map((cell): Table1DiscreteCell => {
    if (cell.suppressed) return cell;
    const anySuppressed = others.some((g) =>
      g.discrete.some((d) => d.variableKey === cell.variableKey && d.suppressed),
    );
    return anySuppressed
      ? { variableKey: cell.variableKey, kind: 'discrete', suppressed: true }
      : cell;
  });
}

// 무결성 assertion(계획서 §4.6) — groupId 중복/누락/미매칭, 그룹별 변수 커버리지
// 불일치를 조립 단계에서 즉시 잡는다. 정상 흐름에서는 절대 발생하지 않아야 하는
// 프로그래밍 오류만 검사하므로 throw로 충분하다(요청 단위 방어가 아니라 배포 전
// 회귀를 잡기 위한 안전망).
function assertResultIntegrity(
  variableKeys: readonly string[],
  groups: readonly StratifyRowGroup[],
  byGroup: readonly AnalyzeDescriptiveStratifiedGroupResult[],
): void {
  const groupIds = groups.map((g) => g.groupId);
  if (new Set(groupIds).size !== groupIds.length) {
    throw new Error(`computeDescriptiveStratifiedAnalyzeResult: groups에 중복된 groupId가 있다 — ${groupIds.join(', ')}`);
  }
  if (byGroup.length !== groups.length) {
    throw new Error(`computeDescriptiveStratifiedAnalyzeResult: byGroup 길이(${byGroup.length})가 groups 길이(${groups.length})와 다르다`);
  }
  const byGroupIds = byGroup.map((g) => g.groupId);
  if (new Set(byGroupIds).size !== byGroupIds.length) {
    throw new Error(`computeDescriptiveStratifiedAnalyzeResult: byGroup에 중복된 groupId가 있다 — ${byGroupIds.join(', ')}`);
  }
  const byGroupIdSet = new Set(byGroupIds);
  for (const id of groupIds) {
    if (!byGroupIdSet.has(id)) {
      throw new Error(`computeDescriptiveStratifiedAnalyzeResult: groups에는 있지만 byGroup에 없는 groupId: ${id}`);
    }
  }

  const variableKeySet = new Set(variableKeys);
  for (const g of byGroup) {
    const covered = new Set<string>();
    for (const c of g.continuous) {
      if (covered.has(c.variableKey)) {
        throw new Error(`computeDescriptiveStratifiedAnalyzeResult: group=${g.groupId}에 변수 "${c.variableKey}" 결과가 중복됐다`);
      }
      covered.add(c.variableKey);
    }
    for (const d of g.discrete) {
      if (covered.has(d.variableKey)) {
        throw new Error(`computeDescriptiveStratifiedAnalyzeResult: group=${g.groupId}에 변수 "${d.variableKey}" 결과가 중복됐다`);
      }
      covered.add(d.variableKey);
    }
    if (covered.size !== variableKeySet.size || ![...variableKeySet].every((k) => covered.has(k))) {
      throw new Error(
        `computeDescriptiveStratifiedAnalyzeResult: group=${g.groupId}의 변수 결과 커버리지가 variableKeys와 다르다 ` +
        `(기대: ${[...variableKeySet].join(',')}, 실제: ${[...covered].join(',')})`,
      );
    }
  }
}

export interface StratifiedComputeVariant {
  /**
   * true면 소수 셀 억제·total 강제 억제를 전부 끈다. 제한데이터 권한자 응답 시점 전용
   * (statsDescriptiveUnrestricted.ts)이며 결과를 캐시에 저장하면 안 된다.
   */
  unrestricted?: boolean;
  /** 생략하면 ctx.descriptiveStratifyPartition(소수 그룹이 "기타"로 병합된 집계용 분할). */
  partition?: StratifyPartitionResult;
}

export async function computeDescriptiveStratifiedAnalyzeResult(
  ctx: AnalysisContext,
  opts?: EngineRunOpts,
  variant: StratifiedComputeVariant = {},
): Promise<AnalyzeDescriptiveStratifiedResult> {
  const unrestricted = variant.unrestricted === true;
  const partition = variant.partition ?? ctx.descriptiveStratifyPartition;
  const stratifyByKey = ctx.recipe.descriptive?.stratifyByKey;
  if (!partition || !stratifyByKey) {
    throw new Error('computeDescriptiveStratifiedAnalyzeResult: ctx.descriptiveStratifyPartition이 없다 — 호출 순서 위반');
  }

  const request = buildStratifiedStatsEngineRequest(partition.groups, ctx.recipe.variableKeys, ctx.catalogByKey);
  // 해제용 분할은 집계 경로 사전검사(assertInputWithinLimitsForMode)가 본 병합 분할과
  // 다르므로, 실제로 엔진에 보낼 요청 자체를 여기서 검사한다.
  if (unrestricted) assertWithinLimits(request);
  const raw = await runStatsEngine(request, opts);
  const rawByGroup = splitRawByGroup(raw, partition.groups.map((g) => g.groupId));

  const byGroup: AnalyzeDescriptiveStratifiedGroupResult[] = partition.groups.map((group) => {
    const full = computeDescriptiveSuppression(
      group.rows, ctx.recipe.variableKeys, ctx.catalogByKey, rawByGroup.get(group.groupId)!,
      unrestricted ? { unrestricted: true } : undefined,
    );
    return {
      groupId: group.groupId,
      continuous: full.continuous.map(toTable1ContinuousCell),
      discrete: full.discrete.map(toTable1DiscreteCell),
    };
  });

  if (!unrestricted) forceTotalSuppressionWhereAnyGroupSuppressed(byGroup);
  assertResultIntegrity(ctx.recipe.variableKeys, partition.groups, byGroup);

  const result: AnalyzeDescriptiveStratifiedResult = {
    suppressed: false,
    stratifyByKey,
    // level은 원본 추출 값 그대로(예: 담당의 UUID) — attempt()가 runEngineFor 직후
    // resolveStratifyGroupLabels()로 표시명을 치환한다(pool 접근이 필요해 이 순수
    // 계산 함수의 책임 밖 — statsRunsQueue.ts 참고).
    groups: partition.groups.map((g) => ({ groupId: g.groupId, kind: g.kind, level: g.level })),
    byGroup,
  };
  // 방어적 파싱(계획서 §1) — 스프레드 실수 등으로 여분 필드가 남았으면 strict
  // 스키마가 응답 전송·저장 직전에 즉시 실패시킨다(마지막 방어선).
  return AnalyzeDescriptiveStratifiedResultSchema.parse(result);
}

// 그룹 판정(억제 포함)이 끝난 뒤 최종 공개 대상 groupId의 level만 배치 조회해
// 표시명으로 치환한다. sensitivity==='staff_identifier'인 그룹 변수(담당의 등
// 사용자 ID)에만 적용 — 다른 범주형 변수(성별·진단모듈군 등)는 원본 값 자체가
// 이미 사람이 읽을 수 있는 문자열이라 치환할 필요가 없다(하드코딩된 특정 변수
// 키가 아니라 카탈로그 메타데이터로 일반화 — 이 리포의 기존 관례).
//
// pool 접근이 필요해 순수 계산 함수인 computeDescriptiveStratifiedAnalyzeResult와
// 분리했다. 실패해도(예: DB 일시 단절) 분석 자체를 실패시키지 않는다 — 표시 전용
// 향상 기능이 원본 UUID로의 폴백보다 우선순위가 높지 않다.
export async function resolveStratifyGroupLabels(
  pool: Pool,
  orgId: string,
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
  stratified: AnalyzeDescriptiveStratifiedResult,
): Promise<AnalyzeDescriptiveStratifiedResult> {
  if (stratified.suppressed) return stratified;
  const variable = catalogByKey.get(stratified.stratifyByKey);
  if (variable?.sensitivity !== 'staff_identifier') return stratified;

  const levelGroups = stratified.groups.filter(
    (g): g is typeof g & { level: string } => g.kind === 'level' && typeof g.level === 'string',
  );
  if (levelGroups.length === 0) return stratified;

  try {
    const ids = levelGroups.map((g) => g.level);
    const { rows } = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [orgId, ids],
    );
    const nameById = new Map(rows.map((r) => [r.id, r.name]));
    return {
      ...stratified,
      groups: stratified.groups.map((g) => {
        if (g.kind !== 'level' || typeof g.level !== 'string') return g;
        // 탈퇴/삭제된 사용자는 조회 결과에 없다 — 원본 UUID를 그대로 노출하지
        // 않고 중립적인 폴백 라벨을 쓴다.
        return { ...g, level: nameById.get(g.level) ?? '(알 수 없음)' };
      }),
    };
  } catch (err) {
    // 조회 실패 시에도 원본 UUID를 그대로 두면 안 된다 — 이 결과는 이후
    // attempt()가 'succeeded'로 저장하므로, DB가 복구돼도 이미 저장된 결과의
    // UUID는 자동으로 재해석되지 않는다(캐시·화면·CSV에 영구히 남음, 2차
    // 리뷰 지적). "사용자를 못 찾음"과 동일한 중립 라벨로 대체해 안전한 쪽으로
    // 실패한다 — 분석 자체는 계속 성공시키되(표시 전용 기능이 핵심 계산을
    // 막을 이유는 없다), 식별 가능한 원문은 어떤 경로로도 새지 않게 한다.
    console.error('[stats-descriptive-stratify] 담당의 표시명 조회 실패 — 원본 UUID를 노출하지 않고 중립 라벨로 대체', err);
    return {
      ...stratified,
      groups: stratified.groups.map((g) => {
        if (g.kind !== 'level' || typeof g.level !== 'string') return g;
        return { ...g, level: '(알 수 없음)' };
      }),
    };
  }
}
