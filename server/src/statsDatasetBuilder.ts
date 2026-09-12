// PR0-C — snapshot 행 + 검증된 레시피 → deterministicMigrate → 변수 계산 → 필터 적용 →
// grain별 fact rows. §1 파이프라인의 ③~⑥(preview용, ⑦은 statsEstimability.ts) 담당.
// PR0-B3 Part A — buildDataset을 grain 디스패처로 분리(case → buildCaseGradeDataset,
// 반복 grain → buildRepeatedGrainDataset). 이 파일은 카탈로그를 직접 조회하지 않는다
// (기존 구조 그대로 — catalogByKey는 검증 단계인 statsRecipeValidation.ts가 만들어
// 넘겨준다).
import { deterministicMigrate } from '@wr/analytics-core/migration/deterministicMigrate';
import { computeVariableValue, computeRepeatedVariableValue } from '@wr/analytics-core/catalog';
import { enumerateVibrationIntervalEntities, enumerateDiagnosisSideEntities, enumerateJobEntities, enumerateTaskEntities } from '@wr/analytics-core/grainEntities';
import type { AnalyticsVariableMetadata, ExtractedValue, GrainEntity, MigrationResult, RepeatedObservation } from '@wr/analytics-core';
import type { AnalysisPatient } from '@wr/analytics-core/migration/deterministicMigrate';
import type { StatsAnalysisRecipe, StatsFilter } from '@wr/contracts';
import type { SnapshotRow } from './statsSnapshot';
import { derivePersonClusterKey } from './statsPersonCluster';
import { canonicalDigest } from './canonicalSerializer';
import { extractSnapshotColumnValue } from './statsSnapshotColumnVariables';

export interface DatasetRow {
  caseId: string;
  personClusterKey: string;
  // PR0-B3 Part A — 반복 grain(case가 아닌 grain)에서는 한 case가 여러 행을 낸다. 그
  // case 안에서 이 행을 식별하는 로컬 키(entityKey, case ID 미포함 — 계획
  // pr0-b3-shimmying-magpie.md "핵심 아키텍처" 절) — case grain에서는 항상 null이다.
  // 옵셔널로 둔다 — 기존 테스트들이 DatasetRow 리터럴을 buildDataset()을 거치지 않고
  // 직접 만들므로(§0 발견, case grain 전용 시절부터의 관례), 필수 필드로 만들면 그
  // 리터럴들을 전부 고쳐야 한다. 없으면 undefined ≡ null(case grain)로 취급한다.
  entityKey?: string[] | null;
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
// PR1(statsDescriptiveSuppression.ts)이 Python에 보낼 문자열 값을 같은 규칙으로
// 정규화하고, level별 person count를 재계산할 때도 이 규칙으로 그룹핑해야 Python이
// 그룹화한 level 식별자와 일치한다 — 그래서 이 함수 자체를 export한다(matchesFilter만
// export하던 것에서 확장).
export function normalizeForCompare(value: unknown): unknown {
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
  if (recipe.grain === 'case') {
    return buildCaseGradeDataset(snapshotRows, recipe, recipeDigest, catalogByKey);
  }
  return buildRepeatedGrainDataset(snapshotRows, recipe, recipeDigest, catalogByKey);
}

function buildCaseGradeDataset(
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
      // Part C — SnapshotRow 컬럼 변수(담당의·등록일)는 payload/analytics-core를 거치지
      // 않는다. 먼저 확인하고, 아니면 기존 analytics-core 경로로 폴백한다.
      const columnValue = extractSnapshotColumnValue(key, row);
      if (columnValue) {
        values[key] = columnValue;
        continue;
      }
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
  // case grain: 1 case = 1 observation.
  const observationCount = caseCount;

  // 응답/digest엔 variableKeys(분석 대상)만 남긴다 — 필터 전용 키의 값은 노출하지 않는다.
  const outputRows: DatasetRow[] = filteredRows.map((r) => ({
    caseId: r.caseId,
    personClusterKey: r.personClusterKey,
    entityKey: null,
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

// PR0-B3 Part A는 vibration_interval을, Part B는 diagnosis_side를, Part C는 job/task를
// 등록했다. job_diagnosis는 계획상 이번 확장에서 전부 제외한다. 여기 없는 grain으로 이
// 함수가 호출되면(= statsRecipeValidation.ts의 SUPPORTED_GRAINS와 어긋난 상태) 구현
// 버그이므로 조용히 넘기지 않고 던진다.
type Enumerator = (mr: MigrationResult<AnalysisPatient>) => GrainEntity<unknown>[];
const GRAIN_ENTITY_ENUMERATORS: Partial<Record<StatsAnalysisRecipe['grain'], Enumerator>> = {
  vibration_interval: enumerateVibrationIntervalEntities as Enumerator,
  diagnosis_side: enumerateDiagnosisSideEntities as Enumerator,
  job: enumerateJobEntities as Enumerator,
  task: enumerateTaskEntities as Enumerator,
};

/**
 * PR0-B3 Part A(2차 리뷰 반영) — extractor가 canonical entity 목록을 정확히 1:1로
 * 순회했는지 검증한다. 길이 비교만으로는 canonical=[A,B]에 [A,A]를 반환하는 경우를
 * 못 잡는다(A가 덮어써지고 B는 결측인 채 남는다, 길이는 2===2로 일치) — 그래서
 * 다음 세 가지를 전부 확인한다: (1) 반환 안에 중복 entityKey가 없는가, (2) 반환된
 * entityKey가 전부 canonical 집합에 속하는가, (3) 반환된 고유 entityKey 수가 canonical
 * 엔터티 수와 정확히 같은가(= 누락 없이 전부 덮었는가). 독립적으로 단위 테스트할 수 있게
 * export한다(실제 extractor 없이 조작된 입력으로 계약 위반을 재현하기 위함).
 */
export function assertObservationsMatchCanonicalEntities(
  key: string,
  caseId: string,
  observations: RepeatedObservation<unknown>[],
  canonicalEntities: GrainEntity<unknown>[],
): void {
  const canonicalKeys = new Set(canonicalEntities.map((e) => JSON.stringify(e.entityKey)));
  const seen = new Set<string>();
  for (const obs of observations) {
    const serialized = JSON.stringify(obs.entityKey);
    if (seen.has(serialized)) {
      throw new Error(
        `buildRepeatedGrainDataset: "${key}" extractor가 같은 entityKey를 중복 반환했다(case=${caseId}, entityKey=${serialized})`,
      );
    }
    seen.add(serialized);
    if (!canonicalKeys.has(serialized)) {
      throw new Error(
        `buildRepeatedGrainDataset: "${key}" extractor가 canonical 목록에 없는 entityKey를 반환했다(case=${caseId}, entityKey=${serialized})`,
      );
    }
  }
  if (seen.size !== canonicalKeys.size) {
    throw new Error(
      `buildRepeatedGrainDataset: "${key}" extractor가 반환한 고유 entityKey 수(${seen.size})가 canonical 엔터티 수(${canonicalKeys.size})와 다르다(case=${caseId})`,
    );
  }
}

function buildRepeatedGrainDataset(
  snapshotRows: SnapshotRow[],
  recipe: StatsAnalysisRecipe,
  recipeDigest: string,
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
): DatasetResult {
  const enumerator = GRAIN_ENTITY_ENUMERATORS[recipe.grain];
  if (!enumerator) {
    throw new Error(`buildRepeatedGrainDataset: grain "${recipe.grain}"에 대한 entity enumerator가 없다`);
  }

  const neededKeys = Array.from(new Set([...recipe.variableKeys, ...recipe.filters.map((f) => f.key)]));

  interface RepeatedCandidateRow {
    caseId: string;
    personClusterKey: string;
    assignedDoctorUserId: string | null;
    entityKey: string[];
    values: Record<string, ExtractedValue<unknown>>;
  }

  const candidateRows: RepeatedCandidateRow[] = [];

  for (const row of snapshotRows) {
    const migrationResult = deterministicMigrate(row.payload, {
      caseId: row.id,
      createdAtFallbackIso: row.createdAt.toISOString(),
    });

    // canonical 엔터티 목록 — 이 case가 이 grain에서 만드는 행 모집단(변수와 무관, §"핵심
    // 아키텍처" 절). 각 변수는 이 목록에 대해서만 값을 보고해야 한다(join, union 아님).
    const canonicalEntities = enumerator(migrationResult);
    const byEntityKey = new Map<string, { entityKey: string[]; values: Record<string, ExtractedValue<unknown>> }>();
    for (const entity of canonicalEntities) {
      byEntityKey.set(JSON.stringify(entity.entityKey), { entityKey: Array.from(entity.entityKey), values: {} });
    }

    for (const key of neededKeys) {
      const variable = catalogByKey.get(key);
      const policy = variable ? recipe.formulaPolicies[variable.formulaFamily] : undefined;
      const observations = computeRepeatedVariableValue(key, migrationResult, policy ? { formulaPolicy: policy } : undefined);
      if (!observations) {
        // neededKeys는 validateRecipe(UNKNOWN_VARIABLE 게이트)를 통과한 키만 들어온다 —
        // catalogByKey에 등록돼 있는데도 extractor를 못 찾는 것은 registry 계약 위반
        // (등록은 됐는데 조회가 실패)이므로 조용히 건너뛰지 않고 던진다(2차 리뷰 지적).
        if (variable) {
          throw new Error(
            `buildRepeatedGrainDataset: "${key}"는 카탈로그에 등록돼 있는데 extractor를 찾지 못했다(case=${row.id})`,
          );
        }
        continue;
      }

      // 방어적 assertion — extractor는 canonical entity 목록을 1:1 map()으로만 순회해야
      // 한다. 길이만 같아도 canonical=[A,B]에 [A,A]를 반환하면(B는 결측인 채 A만 덮어써짐)
      // 길이 비교로는 못 잡는다 — 중복·결측 entityKey를 함께 검사한다(2차 리뷰 지적).
      assertObservationsMatchCanonicalEntities(key, row.id, observations, canonicalEntities);
      for (const obs of observations) {
        const bucket = byEntityKey.get(JSON.stringify(obs.entityKey))!; // 위 assertion이 존재를 보장
        bucket.values[key] = { value: obs.value, missing: obs.missing, qualityFlags: obs.qualityFlags };
      }
    }

    for (const bucket of byEntityKey.values()) {
      candidateRows.push({
        caseId: row.id,
        personClusterKey: derivePersonClusterKey(recipeDigest, row.patientPersonId),
        assignedDoctorUserId: row.assignedDoctorUserId,
        entityKey: bucket.entityKey,
        values: bucket.values,
      });
    }
  }

  const filteredRows = candidateRows.filter((row) =>
    recipe.filters.every((filter) => matchesFilter(row.values[filter.key], filter)),
  );

  const personCount = new Set(filteredRows.map((r) => r.personClusterKey)).size;
  // §2.2 — 반복 grain에서는 caseCount !== observationCount(한 case가 여러 행을 낼 수 있음).
  const caseCount = new Set(filteredRows.map((r) => r.caseId)).size;
  const observationCount = filteredRows.length;
  const distinctAssignedDoctorClusters = new Set(
    filteredRows.map((r) => r.assignedDoctorUserId).filter((id): id is string => id !== null),
  ).size;

  const outputRows: DatasetRow[] = filteredRows.map((r) => ({
    caseId: r.caseId,
    personClusterKey: r.personClusterKey,
    entityKey: r.entityKey,
    values: Object.fromEntries(
      recipe.variableKeys
        .map((key) => [key, r.values[key]] as const)
        .filter((entry): entry is [string, ExtractedValue<unknown>] => entry[1] !== undefined),
    ),
  }));

  const internalResultDigest = canonicalDigest({
    grain: recipe.grain,
    variableKeys: recipe.variableKeys,
    rows: outputRows.map((r) => ({ caseId: r.caseId, personClusterKey: r.personClusterKey, entityKey: r.entityKey, values: r.values })),
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
