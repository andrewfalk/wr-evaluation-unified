// Table1 스트라티피케이션 — partitionRowsForStratify 단위테스트. 담당의처럼 고정
// 순서가 선언되지 않은 categorical 변수를 그룹 축으로 쓰는 시나리오를 중심으로,
// 기타 병합·관측 0건 레벨·결측 그룹·반복 grain 다중 소속을 검증한다.
import { describe, expect, it } from 'vitest';
import type { ExtractedValue } from '@wr/analytics-core';
import type { DatasetRow } from '../statsDatasetBuilder';
import { partitionRowsForStratify } from '../statsDescriptiveStratify';

function sv(value: unknown, missing: ExtractedValue<unknown>['missing'] = null): ExtractedValue<unknown> {
  return { value, missing, qualityFlags: [] };
}

function makeRows(
  count: number,
  stratifyValue: unknown,
  opts: { personPrefix?: string; caseId?: string } = {},
): DatasetRow[] {
  const { personPrefix = stratifyValue === null ? 'missing' : String(stratifyValue), caseId } = opts;
  return Array.from({ length: count }, (_, i) => ({
    caseId: caseId ?? `case-${personPrefix}-${i}`,
    personClusterKey: `person-${personPrefix}-${i}`,
    entityKey: null,
    stratifyValue: stratifyValue === null ? undefined : sv(stratifyValue),
    values: {},
  }));
}

describe('partitionRowsForStratify — 기본 파티셔닝', () => {
  it('15/12/3명 담당의 구성 — 3명뿐인 그룹만 기타로 병합된다', () => {
    const rows = [
      ...makeRows(15, 'doctorA'),
      ...makeRows(12, 'doctorB'),
      ...makeRows(3, 'doctorC'),
    ];
    const { groups } = partitionRowsForStratify(rows, 'case.staff.assignedDoctorUserId', 'categorical');

    expect(groups[0]).toMatchObject({ groupId: 'total', kind: 'total' });
    expect(groups[0].rows).toHaveLength(30);

    const levelGroups = groups.filter((g) => g.kind === 'level');
    expect(levelGroups.map((g) => g.level).sort()).toEqual(['doctorA', 'doctorB']);
    expect(levelGroups.find((g) => g.level === 'doctorA')!.rows).toHaveLength(15);
    expect(levelGroups.find((g) => g.level === 'doctorB')!.rows).toHaveLength(12);

    const other = groups.find((g) => g.kind === 'other');
    expect(other).toBeDefined();
    expect(other!.rows).toHaveLength(3);
    expect(other!.level).toBeNull();

    expect(groups.find((g) => g.kind === 'missing')).toBeUndefined();
  });

  it('소수인원 레벨 2개(3명+4명)가 하나의 기타로 합쳐진다', () => {
    const rows = [
      ...makeRows(15, 'doctorA'),
      ...makeRows(3, 'doctorC'),
      ...makeRows(4, 'doctorD'),
    ];
    const { groups } = partitionRowsForStratify(rows, 'k', 'categorical');
    const other = groups.find((g) => g.kind === 'other')!;
    expect(other.rows).toHaveLength(7);
    // 병합 후에도 <10이지만 그룹 자체는 만들어진다 — 억제는 이 함수의 책임이 아니다.
    expect(groups.filter((g) => g.kind === 'other')).toHaveLength(1);
  });

  it('기타 병합 후 인원이 기준을 충족하면(8+5=13) 정상 레벨처럼 그룹이 만들어진다', () => {
    // partitionRowsForStratify 자체는 "기타"를 다시 쪼개 재평가하지 않는다 — 병합
    // 여부 판정은 레벨 단위로만 하고, 병합된 결과의 최종 크기는 억제 단계가 본다.
    // 여기서는 병합된 그룹의 rows 개수가 정확한지만 확인한다.
    const rows = [...makeRows(8, 'doctorC'), ...makeRows(5, 'doctorD')];
    const { groups } = partitionRowsForStratify(rows, 'k', 'categorical');
    const other = groups.find((g) => g.kind === 'other')!;
    expect(other.rows).toHaveLength(13);
  });

  it('관측 0건인 고정 순서 레벨은 그룹도 기타 병합도 안 된다', () => {
    // diagnosis.identity.moduleGroup은 6개 고정 순서(knee/wrist/elbow/shoulder/
    // spine/cervical)가 선언돼 있다 — 이 중 2개만 실제로 관측된 경우, 나머지
    // 4개는 order 배열엔 있지만 byLevel 버킷이 없어(bucket.length===0) 그룹도
    // 기타 병합도 안 되고 조용히 스킵돼야 한다.
    const rows = [...makeRows(15, 'knee'), ...makeRows(12, 'wrist')];
    const { groups } = partitionRowsForStratify(rows, 'diagnosis.identity.moduleGroup', 'categorical');
    const levelGroups = groups.filter((g) => g.kind === 'level');
    expect(levelGroups.map((g) => g.level)).toEqual(['knee', 'wrist']);
    expect(groups.find((g) => g.kind === 'other')).toBeUndefined();
  });

  it('그룹변수 자체가 결측인 행은 missing 그룹으로 분리되고 total에는 포함된다', () => {
    const rows = [...makeRows(15, 'doctorA'), ...makeRows(5, null)];
    const { groups } = partitionRowsForStratify(rows, 'k', 'categorical');
    expect(groups[0].rows).toHaveLength(20); // total = 전체
    const missing = groups.find((g) => g.kind === 'missing');
    expect(missing).toBeDefined();
    expect(missing!.rows).toHaveLength(5);
    expect(missing!.level).toBeNull();
  });

  it('그룹변수 결측이 전혀 없으면 missing 그룹 자체가 생기지 않는다', () => {
    const rows = makeRows(15, 'doctorA');
    const { groups } = partitionRowsForStratify(rows, 'k', 'categorical');
    expect(groups.find((g) => g.kind === 'missing')).toBeUndefined();
  });

  it('boolean 타입은 값 순서와 무관하게 [false, true] 고정 순서로 정렬된다', () => {
    const rows = [...makeRows(12, true), ...makeRows(15, false)];
    const { groups } = partitionRowsForStratify(rows, 'k', 'boolean');
    const levelGroups = groups.filter((g) => g.kind === 'level');
    expect(levelGroups.map((g) => g.level)).toEqual([false, true]);
  });

  it('반복 grain — 같은 사람이 서로 다른 그룹에 동시에 속할 수 있다', () => {
    // 한 사람이 케이스 2개(서로 다른 담당의)를 가진 경우를 흉내낸다.
    const rows: DatasetRow[] = [
      { caseId: 'case-1', personClusterKey: 'person-1', entityKey: null, stratifyValue: sv('doctorA'), values: {} },
      { caseId: 'case-2', personClusterKey: 'person-1', entityKey: null, stratifyValue: sv('doctorB'), values: {} },
      ...makeRows(14, 'doctorA'),
      ...makeRows(14, 'doctorB'),
    ];
    const { groups } = partitionRowsForStratify(rows, 'k', 'categorical');
    const a = groups.find((g) => g.level === 'doctorA')!;
    const b = groups.find((g) => g.level === 'doctorB')!;
    expect(a.rows.some((r) => r.personClusterKey === 'person-1')).toBe(true);
    expect(b.rows.some((r) => r.personClusterKey === 'person-1')).toBe(true);
  });
});
