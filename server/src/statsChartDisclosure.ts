// PR3-B — 차트 데이터(히스토그램·박스플롯 이상치·산점도)의 person 단위 공개통제.
// 계획서 §1/§3/§9. 이 모듈은 두 가지 독립된 축을 다룬다:
//
//   1) aggregate 게이트(compute 시점, 캐시 대상) — 히스토그램 bin 전체연결억제,
//      박스플롯 이상치 전용 partition 게이트(outlierCount의 존재 여부).
//   2) limited_row 응답시점 merge(§9) — outlierCount가 이미 공개 확정된 변수에
//      한해, 권한이 있을 때만 정확한 원시값을 원본 rows에서 즉석 재계산한다
//      (Python 재호출 없음, stats_runs.result에 절대 저장하지 않음).
//
// Python은 person을 모른다(프로젝트 전역 원칙) — 이 두 게이트 모두 Node가
// person 신원을 아는 원본 행(DatasetRow 또는 PairedRow, 둘 다 personClusterKey를
// 가짐)을 직접 재순회해 판정한다. 제네릭으로 두 타입 모두를 받아 그룹별 박스플롯
// (계획서 §5, PairedRow 기반)과 단변량 히스토그램/박스플롯(DatasetRow 기반)이
// 같은 게이트 로직을 공유하게 한다(중복 구현 금지).
import { isSmallCell } from './statsSmallCell';

export interface PersonKeyed {
  personClusterKey: string;
}

function distinctPersons<T extends PersonKeyed>(rows: T[]): number {
  return new Set(rows.map((r) => r.personClusterKey)).size;
}

export interface HistogramBinLike {
  lower: number;
  upper: number;
  count: number;
}

/**
 * 히스토그램 person 단위 전체연결억제(계획서 §3). Python이 만든 bin 경계로
 * Node가 원본 행을 재순회해 bin별 distinctPersons를 계산한다 — Python의
 * row-count(한 사람의 반복기록이 여러 건일 수 있음)를 억제 판정에 직접 쓰지
 * 않는다. 마지막 bin만 양끝 포함(numpy.histogram과 동일한 경계 포함 규칙, §2).
 * count===0인 bin은 검사할 person 집합이 없으므로 건너뛴다. 어느 한 bin이라도
 * 소수셀이면 히스토그램 전체를 억제한다(true=공개 가능).
 */
export function isHistogramDisclosable<T extends PersonKeyed>(
  rows: T[],
  bins: HistogramBinLike[],
  valueOf: (row: T) => number | null,
): boolean {
  const presentRows = rows.filter((r) => valueOf(r) !== null);
  for (let i = 0; i < bins.length; i += 1) {
    const bin = bins[i];
    if (bin.count === 0) continue;
    const isLast = i === bins.length - 1;
    const inBin = presentRows.filter((row) => {
      const v = valueOf(row) as number;
      return isLast ? v >= bin.lower && v <= bin.upper : v >= bin.lower && v < bin.upper;
    });
    if (isSmallCell(distinctPersons(inBin))) return false;
  }
  return true;
}

export interface BoxplotFenceInput {
  q1: number;
  q3: number;
}

function computeFence({ q1, q3 }: BoxplotFenceInput): { lowerFence: number; upperFence: number } {
  const iqr = q3 - q1;
  return { lowerFence: q1 - 1.5 * iqr, upperFence: q3 + 1.5 * iqr };
}

function partitionByFence<T extends PersonKeyed>(
  rows: T[],
  lowerFence: number,
  upperFence: number,
  valueOf: (row: T) => number | null,
): { outlier: T[]; nonOutlier: T[] } {
  const outlier: T[] = [];
  const nonOutlier: T[] = [];
  for (const row of rows) {
    const v = valueOf(row);
    if (v === null) continue;
    if (v < lowerFence || v > upperFence) outlier.push(row);
    else nonOutlier.push(row);
  }
  return { outlier, nonOutlier };
}

/**
 * 이상치 전용 게이트(계획서 §1) — 히스토그램의 bin 게이트와 **완전히 별개**다.
 * 반례(직접 계산으로 확인): bin 빈도가 [50,0,26,0,0,24]로 히스토그램 게이트를
 * 전부 통과해도, 이상치가 정확히 1명이면 outlierCount가 그 소수집단을 노출한다.
 * 이상치·비이상치 **양쪽** partition의 person 고유 인원이 전부 0이거나
 * ≥MINIMUM_COHORT여야 한다 — 한쪽만 검사하면 "이상치 10명·비이상치 1명"(반복
 * 기록으로 가능) 같은 반대 방향 반례를 놓친다. 그룹별 박스플롯(§5)에도 그룹마다
 * 독립 적용한다 — 그룹 단위 게이트(전체 인원수)는 그룹 내부의 소수 이상치
 * 집단까지 막지 못하기 때문.
 */
export function isOutlierCountDisclosable<T extends PersonKeyed>(
  rows: T[],
  fence: BoxplotFenceInput,
  valueOf: (row: T) => number | null,
): boolean {
  const { lowerFence, upperFence } = computeFence(fence);
  const { outlier, nonOutlier } = partitionByFence(rows, lowerFence, upperFence, valueOf);
  return !isSmallCell(distinctPersons(outlier)) && !isSmallCell(distinctPersons(nonOutlier));
}

/**
 * 응답시점 전용(§9) — outlierCount가 이미 공개 확정된 변수에 한해, 호출자가
 * stats.export_limited_rows 권한을 확인한 뒤에만 호출해야 한다. 원본 rows에서
 * 즉석 재계산하므로 Python 재호출도, 캐시 저장도 없다.
 */
export function computeOutlierValues<T extends PersonKeyed>(
  rows: T[],
  fence: BoxplotFenceInput,
  valueOf: (row: T) => number | null,
): number[] {
  const { lowerFence, upperFence } = computeFence(fence);
  const { outlier } = partitionByFence(rows, lowerFence, upperFence, valueOf);
  const values: number[] = [];
  for (const row of outlier) {
    const v = valueOf(row);
    if (v !== null) values.push(v);
  }
  return values;
}
