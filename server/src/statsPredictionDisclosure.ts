// PR4-B2 — 예측 곡선(ROC/PR/calibration 공통) 공개통제(계획서 §5단계 "곡선
// 공개통제"). 반복 1의 OOF 예측만 쓴다(계획서 결정 #8). 세 곡선(ROC·PR·
// calibration)이 이 공통 구간 하나를 공유한다 — 구간 경계가 곡선마다 다르면
// 지표 표와 곡선이 서로 다른 이야기를 하는 것처럼 보인다.
import type { PredictionCurveBin } from '@wr/contracts';
import { PREDICTION_POLICY } from './statsPolicy';
import { isSmallCell } from './statsSmallCell';

export interface PredictionCurveRow {
  row: number;
  p: number;
  y: 0 | 1;
  cohortPersonKey: string;
}

export interface PredictionCurvesResult {
  bins: PredictionCurveBin[] | null;
  suppressedReason: 'MIN_DISCLOSABLE_BINS_NOT_MET' | null;
}

interface WorkingBin {
  rows: PredictionCurveRow[];
}

function personSetsOf(rows: readonly PredictionCurveRow[]): { pPlus: Set<string>; pMinus: Set<string> } {
  const pPlus = new Set<string>();
  const pMinus = new Set<string>();
  for (const r of rows) {
    if (r.y === 1) pPlus.add(r.cohortPersonKey);
    else pMinus.add(r.cohortPersonKey);
  }
  return { pPlus, pMinus };
}

/** 이 구간(병합된 WorkingBin)이 공개 가능한가 — P⁺/P⁻/M 전부 0 또는
 * ≥MINIMUM_COHORT(계획서 §5단계 "구간별로 P⁺_k·P⁻_k·M_k를 센다"). */
function isBinDisclosable(bin: WorkingBin): boolean {
  const { pPlus, pMinus } = personSetsOf(bin.rows);
  const m = new Set([...pPlus].filter((k) => pMinus.has(k)));
  return !isSmallCell(pPlus.size) && !isSmallCell(pMinus.size) && !isSmallCell(m.size);
}

/** 예측값 오름차순 정렬 후 동점을 한 덩어리로 묶어 candidateBinCount개 후보
 * 구간으로 나눈다(계획서 §5단계 1~2 — "경계는 정렬 인덱스로 정한다", 동점이
 * 경계를 가로지르지 않게 다음 경계를 동점 블록 끝까지 민다). */
function buildCandidateBins(sortedRows: PredictionCurveRow[], candidateBinCount: number): WorkingBin[] {
  const n = sortedRows.length;
  if (n === 0) return [];
  const bins: WorkingBin[] = [];
  let start = 0;
  for (let b = 0; b < candidateBinCount && start < n; b++) {
    const targetEnd = Math.round(((b + 1) * n) / candidateBinCount);
    let end = Math.max(targetEnd, start + 1);
    end = Math.min(end, n);
    // 동점 블록이 경계를 가로지르면 블록 끝까지 민다.
    while (end < n && sortedRows[end].p === sortedRows[end - 1].p) end++;
    bins.push({ rows: sortedRows.slice(start, end) });
    start = end;
  }
  return bins;
}

/** 공개 불가능한 구간을 이웃(다음) 구간과 병합한다 — 전부 공개 가능해질 때까지
 * 반복. 마지막 구간이 여전히 불가능하면 이전 구간과 병합한다(계획서 §5단계 3
 * "0 또는 ≥MINIMUM_COHORT가 될 때까지 이웃 구간과 병합"). */
function mergeUntilDisclosable(candidateBins: WorkingBin[]): WorkingBin[] {
  const merged: WorkingBin[] = [];
  let pending: WorkingBin | null = null;
  for (const bin of candidateBins) {
    pending = pending ? { rows: [...pending.rows, ...bin.rows] } : bin;
    if (isBinDisclosable(pending)) {
      merged.push(pending);
      pending = null;
    }
  }
  if (pending) {
    if (merged.length > 0) {
      merged[merged.length - 1] = { rows: [...merged[merged.length - 1].rows, ...pending.rows] };
    } else {
      merged.push(pending); // 전체가 하나로도 공개 불가 — 아래 minDisclosableBins 검사가 억제로 처리
    }
  }
  return merged;
}

export function computePredictionCurves(representativeRows: PredictionCurveRow[]): PredictionCurvesResult {
  const sorted = [...representativeRows].sort((a, b) => a.p - b.p);
  const candidateBins = buildCandidateBins(sorted, PREDICTION_POLICY.disclosure.curveCandidateBins);
  const merged = mergeUntilDisclosable(candidateBins);

  if (merged.length < PREDICTION_POLICY.disclosure.minDisclosableBins || merged.some((b) => !isBinDisclosable(b))) {
    return { bins: null, suppressedReason: 'MIN_DISCLOSABLE_BINS_NOT_MET' };
  }

  const bins: PredictionCurveBin[] = merged.map((bin) => {
    const rows = bin.rows.length;
    const positiveRows = bin.rows.filter((r) => r.y === 1).length;
    const sumP = bin.rows.reduce((acc, r) => acc + r.p, 0);
    const upperThreshold = Math.max(...bin.rows.map((r) => r.p));
    return {
      upperThreshold,
      rows,
      positiveRows,
      meanPredicted: sumP / rows,
      observedRate: positiveRows / rows,
    };
  });

  return { bins, suppressedReason: null };
}
