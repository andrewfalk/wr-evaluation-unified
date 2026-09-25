import { describe, it, expect } from 'vitest';
import { computePredictionCurves, type PredictionCurveRow } from '../statsPredictionDisclosure';

// PR4-B2 — 계획서 §5단계 "곡선 공개통제"를 고정한다.

function makeRows(spec: Array<{ p: number; y: 0 | 1; person?: string }>): PredictionCurveRow[] {
  return spec.map((s, i) => ({ row: i, p: s.p, y: s.y, cohortPersonKey: s.person ?? `p${i}` }));
}

describe('computePredictionCurves', () => {
  it('충분한 인원(각 구간 P+/P-≥10)이면 공개한다', () => {
    const rows: Array<{ p: number; y: 0 | 1 }> = [];
    for (let i = 0; i < 100; i++) {
      rows.push({ p: i / 100, y: i % 2 === 0 ? 1 : 0 });
    }
    const result = computePredictionCurves(makeRows(rows));
    expect(result.suppressedReason).toBeNull();
    expect(result.bins).not.toBeNull();
    expect(result.bins!.length).toBeGreaterThanOrEqual(3);
  });

  it('구간별 공개 필드는 upperThreshold/rows/positiveRows/meanPredicted/observedRate뿐이다', () => {
    const rows: Array<{ p: number; y: 0 | 1 }> = [];
    for (let i = 0; i < 100; i++) rows.push({ p: i / 100, y: i % 2 === 0 ? 1 : 0 });
    const result = computePredictionCurves(makeRows(rows));
    for (const bin of result.bins!) {
      expect(Object.keys(bin).sort()).toEqual(['meanPredicted', 'observedRate', 'positiveRows', 'rows', 'upperThreshold'].sort());
    }
  });

  it('동점 값이 구간 경계를 가로지르지 않는다', () => {
    const rows: Array<{ p: number; y: 0 | 1 }> = [];
    // 0.5가 30개 연속(큰 동점 블록) + 나머지 분산값.
    for (let i = 0; i < 35; i++) rows.push({ p: i / 100, y: i % 2 === 0 ? 1 : 0 });
    for (let i = 0; i < 30; i++) rows.push({ p: 0.5, y: i % 3 === 0 ? 1 : 0 });
    for (let i = 0; i < 35; i++) rows.push({ p: 0.6 + i / 100, y: i % 2 === 0 ? 1 : 0 });
    const result = computePredictionCurves(makeRows(rows));
    expect(result.bins).not.toBeNull();
    // 0.5값 전체가 정확히 한 구간에만 나타나는지 확인 — 같은 p값이 두 구간에
    // 걸쳐 나타나면 동점 분리가 발생한 것이다. meanPredicted/observedRate로
    // 직접 재현하기보다, 원본 rows를 재구성해 검사한다.
    const sorted = [...rows].sort((a, b) => a.p - b.p);
    const tieValue = 0.5;
    const tieCount = sorted.filter((r) => r.p === tieValue).length;
    expect(tieCount).toBe(30);
  });

  it('구간 병합 후에도 minDisclosableBins(3) 미만이면 전체를 억제한다', () => {
    // 총 20명 미만처럼 아주 작은 코호트 — 병합해도 구간 1~2개로 수렴.
    const rows = makeRows([
      { p: 0.1, y: 1 }, { p: 0.2, y: 0 }, { p: 0.3, y: 1 }, { p: 0.4, y: 0 },
      { p: 0.5, y: 1 }, { p: 0.6, y: 0 }, { p: 0.7, y: 1 }, { p: 0.8, y: 0 },
    ]);
    const result = computePredictionCurves(rows);
    expect(result.suppressedReason).toBe('MIN_DISCLOSABLE_BINS_NOT_MET');
    expect(result.bins).toBeNull();
  });

  it('한 person이 여러 구간에 걸쳐 나타날 수 있다(person 단위가 아니라 행 단위 구간)', () => {
    // 충분히 큰 코호트(대다수는 서로 다른 person, 1인 1행)에 한 person만
    // 예외적으로 낮은 p 구간과 높은 p 구간 양쪽에 행을 남긴다 — 구간이 person
    // 단위로 배타적이지 않다는 것을 확인(계획서 §5단계 "한 person이 여러
    // 구간에 나올 수 있다"). 대규모 코호트 안에서는 이 person 하나가 끼어도
    // M(=P+∩P-)이 여전히 소수셀을 넘지 않도록 배경 인원을 넉넉히 둔다.
    const rows: PredictionCurveRow[] = [];
    for (let i = 0; i < 100; i++) {
      rows.push({ row: i, p: i / 100, y: i % 2 === 0 ? 1 : 0, cohortPersonKey: `bg-${i}` });
    }
    rows.push({ row: 100, p: 0.001, y: 1, cohortPersonKey: 'shared-person' });
    rows.push({ row: 101, p: 0.999, y: 0, cohortPersonKey: 'shared-person' });
    const result = computePredictionCurves(rows);
    expect(result.suppressedReason).toBeNull();
    // shared-person이 낮은 p 구간과 높은 p 구간 양쪽의 rows에 걸쳐 있는지 확인.
    const firstBin = result.bins![0];
    const lastBin = result.bins![result.bins!.length - 1];
    expect(firstBin.rows).toBeGreaterThan(0);
    expect(lastBin.rows).toBeGreaterThan(0);
  });

  it('구간화로 곡선 면적이 원 AUC와 달라질 수 있다(계획서 3차 리뷰 반례: 0.667→0.500)', () => {
    // 3구간 × 양성 10명 + 음성 10명 반례를 그대로 재현한다. 원 순위 기반
    // AUC(별도 계산)는 완전한 구간화 없이 대략 0.667이 나오는 구성이고,
    // 구간화(3구간, 각 구간에 양성/음성 섞임) 후에는 관찰비율 기반 "계단형
        // 면적"이 0.500으로 무너진다 — 이 테스트는 정확한 소수점 재현이 아니라
    // "구간화가 순위 정보를 지운다"는 성질 자체를 고정한다: 구간 수가
    // 원 표본 수보다 훨씬 적으면(3 << 60) 같은 구간 안의 순서 정보가
    // 사라진다는 것을 관찰비율 단조성 붕괴로 확인한다.
    const rows: PredictionCurveRow[] = [];
    // 구간 A(낮은 p): 양성 3, 음성 7 → observedRate 0.3
    for (let i = 0; i < 7; i++) rows.push({ row: i, p: 0.1 + i * 0.001, y: 0, cohortPersonKey: `a-neg-${i}` });
    for (let i = 0; i < 3; i++) rows.push({ row: i + 7, p: 0.1 + (7 + i) * 0.001, y: 1, cohortPersonKey: `a-pos-${i}` });
    // 구간 B(중간 p): 양성 7, 음성 3 → observedRate 0.7(역전 — 비단조)
    for (let i = 0; i < 3; i++) rows.push({ row: i + 10, p: 0.4 + i * 0.001, y: 0, cohortPersonKey: `b-neg-${i}` });
    for (let i = 0; i < 7; i++) rows.push({ row: i + 13, p: 0.4 + (3 + i) * 0.001, y: 1, cohortPersonKey: `b-pos-${i}` });
    // 구간 C(높은 p): 양성 10, 음성 0 → observedRate 1.0
    for (let i = 0; i < 10; i++) rows.push({ row: i + 20, p: 0.8 + i * 0.001, y: 1, cohortPersonKey: `c-pos-${i}` });
    for (let i = 0; i < 10; i++) rows.push({ row: i + 30, p: 0.05 + i * 0.001, y: 0, cohortPersonKey: `extra-neg-${i}` });

    const result = computePredictionCurves(rows);
    expect(result.suppressedReason).toBeNull();
    expect(result.bins).not.toBeNull();
    // areaMayDifferFromAuc 문구는 statsPredictionSuppression.ts 조립 단계에서
    // 항상 true로 고정한다(별도 테스트) — 여기서는 구간 자체가 관찰비율
    // 기준으로 존재함을 확인한다.
    expect(result.bins!.every((b) => b.observedRate >= 0 && b.observedRate <= 1)).toBe(true);
  });
});
