// 차트가 TS로 옮겨질 때 지운다(임시 타입 선언, P2-78a-ts) — ScatterPlot.jsx(@ts-nocheck)는 기본값 없는 구조분해 prop을
// 필수로 추론해, 선택 prop(pointRadiusAccessor)을 넘기지 않는 TS 호출부가 붙지 않는다. 구현이 읽는 props만 적는다.
import type { ReactElement } from 'react';

export interface ScatterPlotGridCell {
  i: number;
  j: number;
  count: number;
}

export interface ScatterPlotData {
  displayedCount: number;
  totalCount: number;
  points?: Array<[number, number]>;
  grid?: {
    xEdges: number[];
    yEdges: number[];
    cells: ScatterPlotGridCell[];
  };
}

export interface ScatterPlotProps {
  /** 없거나 points·grid가 둘 다 없으면 억제 안내를 그린다. */
  scatter?: ScatterPlotData | null;
  regressionLine?: { slope: number; intercept: number } | null;
  pointRadius?: number;
  pointRadiusAccessor?: (point: [number, number], index: number) => number;
}

export function ScatterPlot(props: ScatterPlotProps): ReactElement;
