// PR0-C — snapshot 행 + 검증된 레시피 → deterministicMigrate → 변수 계산 → 필터 적용 →
// case grain fact rows. §1 파이프라인의 ③~⑥(preview용, ⑦은 statsEstimability.ts) 담당.
import { deterministicMigrate } from '@wr/analytics-core/migration/deterministicMigrate';
import { computeVariableValue } from '@wr/analytics-core/catalog';
import type { AnalyticsVariableMetadata, ExtractedValue } from '@wr/analytics-core';
import type { StatsAnalysisRecipe, StatsFilter } from '@wr/contracts';
import type { SnapshotRow } from './statsSnapshot';
import { derivePersonClusterKey } from './statsPersonCluster';
import { canonicalDigest } from './canonicalSerializer';

export interface DatasetRow {
  caseId: string;
  personClusterKey: string;
  values: Record<string, ExtractedValue<unknown>>;
}

export interface DatasetResult {
  rows: DatasetRow[];
  personCount: number;
  caseCount: number;
  observationCount: number;
  distinctAssignedDoctorClusters: number;
  // §E — 서버 전용, HTTP 응답엔 절대 포함하지 않는다(억제 전 원값을 해시하면 무차별대입으로
  // 역산될 수 있음). 결정성 테스트 + 감사로그 provenance용.
  internalResultDigest: string;
}

// canonicalSerialize(§G)는 문자열 leaf 값을 NFC로 정규화한 뒤 해시한다 — recipeDigest는
// 이미 정규화된 형태로 동일해지므로, 필터 비교도 같은 규칙을 쓰지 않으면 recipeDigest는
// 같은데 실제 매치 결과는 다른 경우가 생긴다(예: 필터값 '고도'가 NFD로 들어오면 NFC로
// 저장된 관측값과 코드유닛이 달라 값이 실제로 같은데도 eq가 false를 낸다). 숫자/불린은
// 정규화 대상이 아니므로 그대로 통과시킨다.
function normalizeForCompare(value: unknown): unknown {
  return typeof value === 'string' ? value.normalize('NFC') : value;
}

// §A-6 — 결측 취급: is_missing/not_missing이 아닌 모든 연산자는 그 키의 값이
// missing!==null인 행을 절대 매치하지 않는다(neq가 "missing이니까 다르다"고 오판하지
// 않도록 최우선으로 처리).
// buildDataset()을 통하지 않고도 NFC 정규화 계약(위 normalizeForCompare)을 직접 단위
// 테스트할 수 있도록 export한다 — ordinal 문자열 변수(elbow/wrist)로 실제 값을 만들려면
// 모듈 전체 계산 경로를 다시 구성해야 해서 비용이 큰 반면, 이 함수 자체는 순수 함수라
// ExtractedValue를 직접 주입해 테스트하는 편이 더 신뢰성 있고 저렴하다.
export function matchesFilter(extracted: ExtractedValue<unknown> | undefined, filter: StatsFilter): boolean {
  if (filter.operator === 'is_missing') {
    return !extracted || extracted.missing !== null;
  }
  if (filter.operator === 'not_missing') {
    return !!extracted && extracted.missing === null;
  }
  if (!extracted || extracted.missing !== null) return false;

  const value = normalizeForCompare(extracted.value);
  const filterValue = normalizeForCompare(filter.value);
  switch (filter.operator) {
    case 'eq':
      return value === filterValue;
    case 'neq':
      return value !== filterValue;
    case 'gt':
      return (value as number) > (filterValue as number);
    case 'gte':
      return (value as number) >= (filterValue as number);
    case 'lt':
      return (value as number) < (filterValue as number);
    case 'lte':
      return (value as number) <= (filterValue as number);
    case 'between': {
      const [lo, hi] = filterValue as [number, number];
      return (value as number) >= lo && (value as number) <= hi;
    }
    case 'in':
      return (
        Array.isArray(filterValue) &&
        (filterValue as unknown[]).map(normalizeForCompare).includes(value)
      );
    default:
      return false;
  }
}

export function buildDataset(
  snapshotRows: SnapshotRow[],
  recipe: StatsAnalysisRecipe,
  recipeDigest: string,
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
): DatasetResult {
  const neededKeys = Array.from(new Set([...recipe.variableKeys, ...recipe.filters.map((f) => f.key)]));

  const familyByKey = new Map<string, string>();
  for (const key of neededKeys) {
    const variable = catalogByKey.get(key);
    if (variable) familyByKey.set(key, variable.formulaFamily);
  }

  const candidateRows = snapshotRows.map((row) => {
    const migrationResult = deterministicMigrate(row.payload, {
      caseId: row.id,
      createdAtFallbackIso: row.createdAt.toISOString(),
    });

    const values: Record<string, ExtractedValue<unknown>> = {};
    for (const key of neededKeys) {
      const family = familyByKey.get(key);
      const policy = family ? recipe.formulaPolicies[family] : undefined;
      const extracted = computeVariableValue(key, migrationResult, policy ? { formulaPolicy: policy } : undefined);
      if (extracted) values[key] = extracted;
    }

    return {
      caseId: row.id,
      personClusterKey: derivePersonClusterKey(recipeDigest, row.patientPersonId),
      // assignedDoctorUserId는 distinctAssignedDoctorClusters 계산에만 쓰고 출력 행/digest엔
      // 절대 포함하지 않는다(원문 미노출, §B).
      assignedDoctorUserId: row.assignedDoctorUserId,
      values,
    };
  });

  // §A-7 — 다중 필터는 AND로 결합된다.
  const filteredRows = candidateRows.filter((row) =>
    recipe.filters.every((filter) => matchesFilter(row.values[filter.key], filter)),
  );

  const personCount = new Set(filteredRows.map((r) => r.personClusterKey)).size;
  const caseCount = filteredRows.length;
  // §B — NULL(미배정)은 cluster 수에서 제외.
  const distinctAssignedDoctorClusters = new Set(
    filteredRows.map((r) => r.assignedDoctorUserId).filter((id): id is string => id !== null),
  ).size;
  // case grain: 1 case = 1 observation(이번 PR 한정, §2.2).
  const observationCount = caseCount;

  // 응답/digest엔 variableKeys(분석 대상)만 남긴다 — 필터 전용 키의 값은 노출하지 않는다.
  const outputRows: DatasetRow[] = filteredRows.map((r) => ({
    caseId: r.caseId,
    personClusterKey: r.personClusterKey,
    values: Object.fromEntries(
      recipe.variableKeys
        .map((key) => [key, r.values[key]] as const)
        .filter((entry): entry is [string, ExtractedValue<unknown>] => entry[1] !== undefined),
    ),
  }));

  const internalResultDigest = canonicalDigest({
    grain: recipe.grain,
    variableKeys: recipe.variableKeys,
    rows: outputRows.map((r) => ({ caseId: r.caseId, personClusterKey: r.personClusterKey, values: r.values })),
  });

  return {
    rows: outputRows,
    personCount,
    caseCount,
    observationCount,
    distinctAssignedDoctorClusters,
    internalResultDigest,
  };
}
