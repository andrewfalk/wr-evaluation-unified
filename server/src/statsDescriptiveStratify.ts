// Table1 스트라티피케이션 — descriptive 결과를 임의 범주형 변수(담당의 등)로
// 파티셔닝한다. 이 함수는 stratifyKey가 무엇인지 모르는 완전 일반 로직이다
// (하드코딩 없음 — 담당의든 다른 범주형이든 동일 규칙).
//
// semantics(계획서 §3):
// - 모집단 단위는 recipe.grain의 관측 단위(case/job/disease)다. 사람(person)
//   단위가 아니다 — 반복 grain에서는 같은 사람이 서로 다른 케이스로 서로 다른
//   그룹에 동시에 속할 수 있다.
// - "total" 그룹의 rows = 입력 rows 전체(stratifyKey 결측 여부 무관) — 기존에
//   이미 공개되는 dataset personCount와 정확히 같은 모집단이 되도록 한다.
// - 소수셀 판정은 고유 인원(person) 기준(distinctPersons/isSmallCell), 표에
//   찍히는 n/count는 엔진이 계산하는 관측(행) 기준.
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { DatasetRow } from './statsDatasetBuilder';
import { normalizeForCompare } from './statsDatasetBuilder';
import { isSmallCell } from './statsSmallCell';
import { distinctPersons } from './statsDescriptiveSuppression';
import { resolveLevelOrder } from './statsBivariateRoles';

export type StratifyGroupKind = 'total' | 'level' | 'other' | 'missing';

export interface StratifyRowGroup {
  groupId: string;                    // 'total' | `g${i}` | 'other' | 'missing'
  kind: StratifyGroupKind;
  level: string | boolean | null;     // kind==='level'만 채움. 담당의 UUID 등 원본 값 그대로
                                       // (표시명 치환은 클라이언트/응답 조립 단계 책임).
  rows: DatasetRow[];
}

export interface StratifyPartitionResult {
  // 항상 [total, ...levels(정해진 순서), other?, missing?] 순서.
  groups: StratifyRowGroup[];
}

/**
 * rows를 recipe.descriptive.stratifyByKey 값으로 파티셔닝한다.
 * - stratifyKey가 결측인 행은 별도 'missing' 그룹 후보로 분리된다(그룹으로
 *   만들지는 관측 인원이 있을 때만 — 0명이면 그룹 자체를 만들지 않는다).
 * - 나머지는 레벨별로 버킷팅한다. 레벨 순서는 resolveLevelOrder(카탈로그 고정
 *   순서 또는 관측값의 결정적 정렬)를 재사용한다.
 * - 레벨별 고유 인원이 0명이면 그 레벨은 완전히 버린다(기타에도 안 넣음 — 합칠
 *   대상 자체가 없음). 소수셀(<MINIMUM_COHORT)이면 "기타" 버킷에 누적한다(원본
 *   레벨 값은 이 함수의 반환값에는 없다 — 호출자가 보존하지 않는 한 사라진다).
 *   그 외에는 독립 그룹으로 남긴다.
 * - "기타" 버킷에 rows가 있으면(병합 후에도 소수셀일 수 있음 — 억제는 별도
 *   단계 책임) 맨 뒤에 kind:'other' 그룹을 추가한다.
 */
export function partitionRowsForStratify(
  rows: DatasetRow[],
  stratifyKey: string,
  stratifyType: AnalyticsVariableMetadata['type'] | undefined,
): StratifyPartitionResult {
  const presentRows: DatasetRow[] = [];
  const missingRows: DatasetRow[] = [];
  for (const row of rows) {
    const sv = row.stratifyValue;
    if (!sv || sv.missing !== null) {
      missingRows.push(row);
    } else {
      presentRows.push(row);
    }
  }

  const observed = presentRows.map(
    (r) => normalizeForCompare(r.stratifyValue!.value) as string | boolean,
  );
  const order = resolveLevelOrder(stratifyType, stratifyKey, observed) ?? [];

  const byLevel = new Map<string, DatasetRow[]>();
  for (const row of presentRows) {
    const value = normalizeForCompare(row.stratifyValue!.value);
    const levelKey = `${typeof value}:${String(value)}`;
    let bucket = byLevel.get(levelKey);
    if (!bucket) {
      bucket = [];
      byLevel.set(levelKey, bucket);
    }
    bucket.push(row);
  }

  const levelGroups: StratifyRowGroup[] = [];
  const otherRows: DatasetRow[] = [];
  let groupIndex = 0;
  for (const levelValue of order) {
    const levelKey = `${typeof levelValue}:${String(levelValue)}`;
    const bucket = byLevel.get(levelKey);
    if (!bucket || bucket.length === 0) continue; // 관측 0건 — 그룹도, 기타 병합도 안 함
    const personCount = distinctPersons(bucket);
    if (isSmallCell(personCount)) {
      otherRows.push(...bucket);
      continue;
    }
    levelGroups.push({ groupId: `g${groupIndex}`, kind: 'level', level: levelValue, rows: bucket });
    groupIndex += 1;
  }

  const groups: StratifyRowGroup[] = [
    { groupId: 'total', kind: 'total', level: null, rows },
    ...levelGroups,
  ];
  if (otherRows.length > 0) {
    groups.push({ groupId: 'other', kind: 'other', level: null, rows: otherRows });
  }
  if (missingRows.length > 0) {
    groups.push({ groupId: 'missing', kind: 'missing', level: null, rows: missingRows });
  }
  return { groups };
}
