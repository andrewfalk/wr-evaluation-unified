// PR3-A — 쌍(pair) 단위 complete-case 추출. 계획서 §"쌍 추출 + 요청 조립" 참고.
// 기존 statsDatasetBuilder.ts의 buildDataset()은 "변수별 독립 추출"만 안다(기술통계는
// 변수마다 자기 결측만 빼면 됐음) — 이변량은 같은 case-row에서 두 변수가 동시에
// non-missing인 경우만 쌍으로 뽑아야 한다.
import type { DatasetRow } from './statsDatasetBuilder';
import { normalizeForCompare } from './statsDatasetBuilder';

export type BivariateExclusionReasonCode = 'x_missing' | 'y_missing' | 'both_missing';

export interface BivariateExclusionEntry {
  reasonCode: BivariateExclusionReasonCode;
  count: number;
  personCount: number;
}

export interface PairedRow {
  caseId: string;
  personClusterKey: string;
  x: unknown;
  y: unknown;
}

export interface PairedDatasetResult {
  pairs: PairedRow[];
  includedCaseCount: number;
  includedPersonCount: number;
  excludedCaseCount: number;
  excludedPersonCount: number;
  // §"통합 공개통제 게이트" B-2 — 사유별 personCount가 소수셀이면 이 배열 전체를
  // null로 생략한다(statsBivariateSuppression.ts가 판정, 여기선 항상 채워서 반환).
  exclusions: BivariateExclusionEntry[];
}

function distinctPersons(rows: Array<{ personClusterKey: string }>): number {
  return new Set(rows.map((r) => r.personClusterKey)).size;
}

/** 같은 case-row에서 keyX·keyY가 둘 다 non-missing인 경우만 쌍으로 추출한다.
 * `rows`는 이미 buildDataset()이 필터까지 적용한 것을 그대로 받는다. */
export function buildPairedDataset(rows: DatasetRow[], keyX: string, keyY: string): PairedDatasetResult {
  const pairs: PairedRow[] = [];
  const excludedRowsByReason = new Map<BivariateExclusionReasonCode, DatasetRow[]>();

  for (const row of rows) {
    const x = row.values[keyX];
    const y = row.values[keyY];
    const xMissing = !x || x.missing !== null;
    const yMissing = !y || y.missing !== null;

    if (!xMissing && !yMissing) {
      pairs.push({
        caseId: row.caseId,
        personClusterKey: row.personClusterKey,
        x: normalizeForCompare(x!.value),
        y: normalizeForCompare(y!.value),
      });
      continue;
    }

    const reasonCode: BivariateExclusionReasonCode = xMissing && yMissing ? 'both_missing' : xMissing ? 'x_missing' : 'y_missing';
    let bucket = excludedRowsByReason.get(reasonCode);
    if (!bucket) { bucket = []; excludedRowsByReason.set(reasonCode, bucket); }
    bucket.push(row);
  }

  const excludedRows = [...excludedRowsByReason.values()].flat();
  const exclusions: BivariateExclusionEntry[] = (['x_missing', 'y_missing', 'both_missing'] as const)
    .map((reasonCode) => {
      const bucket = excludedRowsByReason.get(reasonCode) ?? [];
      return { reasonCode, count: bucket.length, personCount: distinctPersons(bucket) };
    })
    .filter((entry) => entry.count > 0);

  return {
    pairs,
    includedCaseCount: pairs.length,
    includedPersonCount: distinctPersons(pairs),
    excludedCaseCount: excludedRows.length,
    excludedPersonCount: distinctPersons(excludedRows),
    exclusions,
  };
}

export interface GroupedPairs {
  // `order`(고정 카탈로그 순서, 미관측 레벨 제거) 순서로 이미 정렬돼 있다 — Map
  // insertion 순서가 아니라 이 순서가 그룹비교/분할표 축 순서의 단일 진실원이다.
  groups: Map<string | boolean, PairedRow[]>;
  // 관측 0건이라 groups에 없는 레벨(§"쌍 추출" — 관측 레벨 vs 카탈로그 선언 레벨).
  excludedEmptyLevels: Array<string | boolean>;
}

/** pairs를 roleKey('x' 또는 'y') 값 기준으로 그룹핑한다. order는 그 변수의 고정
 * 순서(boolean=[false,true] 또는 getOrdinalOrder() 결과) — 데이터 등장 순서가
 * 아니라 이 순서가 "뒤-앞" 방향규칙의 기준이다(행을 섞어도 그룹 순서 불변). */
export function groupPairsByLevel(
  pairs: PairedRow[],
  roleKey: 'x' | 'y',
  order: ReadonlyArray<string | boolean>,
): GroupedPairs {
  const byLevel = new Map<string | boolean, PairedRow[]>();
  for (const pair of pairs) {
    const level = pair[roleKey] as string | boolean;
    let bucket = byLevel.get(level);
    if (!bucket) { bucket = []; byLevel.set(level, bucket); }
    bucket.push(pair);
  }

  const groups = new Map<string | boolean, PairedRow[]>();
  for (const level of order) {
    const bucket = byLevel.get(level);
    if (bucket) groups.set(level, bucket);
  }
  const excludedEmptyLevels = order.filter((level) => !byLevel.has(level));

  return { groups, excludedEmptyLevels };
}
