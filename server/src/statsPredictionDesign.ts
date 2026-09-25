// PR4-B2 — 예측 설계행렬(계획서 §3-5단계). 회귀(statsRegressionDesign.ts)와 달리
// 표준화·spline·interaction·기준 레벨(reference level) 로직이 전혀 없다 — L2
// 정칙화라 범주형을 "full one-hot"(레벨 K개 전부 열로, 기준 레벨을 빼지 않음)으로
// 인코딩해도 릿지 페널티가 공선성을 자연스럽게 처리한다(레벨 하나를 기준으로 빼는
// 건 OLS처럼 정칙화가 없을 때만 필요한 관례). 표준화는 여기서 하지 않는다 — Python
// 엔진의 fit_procedure가 내부 CV의 각 학습 fold 자체 통계로만 표준화한다(§4단계,
// 데이터 유출 방지).
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { DatasetRow } from './statsDatasetBuilder';
import { getOrdinalOrder, getCategoricalOrder } from './statsOrdinalOrder';
import { sortDeterministic } from './statsBivariateRoles';

export interface PredictionDesignColumn {
  name: string;
  variableKey: string;
  level: string | null;
}

export interface PredictionDesignMatrix {
  x: number[][]; // N × columnCount, 절편 제외(엔진이 절편을 별도로 다룬다)
  columns: PredictionDesignColumn[];
  // one-hot 실제 열 수(레벨 K개 전부) — 엔진에 보내는 실제 행렬 크기.
  columnCount: number;
  // EPV 계산용 "보수적" 파라미터 수 — continuous/boolean은 1, categorical/ordinal은
  // K−1(고전적 회귀 관례를 그대로 따르는 서비스 정책값이지 이 모형의 실제 자유도가
  // 아니다 — 계획서 §3-5단계 "서비스의 보수적 실행 제한"). columnCount보다 항상
  // 작거나 같다.
  parameterCount: number;
}

/** rows는 이미 S2(완전사례)로 좁혀진 것을 전제한다 — 레벨 집합은 S2 관측값
 * 기준으로 결정적 정렬한다(선언 순서가 있으면 그 순서, 없으면 정렬된 관측값). */
export function buildPredictionDesignMatrix(
  rows: DatasetRow[],
  predictorKeys: string[],
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
): PredictionDesignMatrix {
  const columns: PredictionDesignColumn[] = [];
  const columnValues: number[][] = [];
  let parameterCount = 0;

  for (const key of predictorKeys) {
    const variable = catalogByKey.get(key);
    if (!variable) continue; // UNKNOWN_VARIABLE로 이미 statsRecipeValidation.ts가 거부

    if (variable.type === 'continuous') {
      columns.push({ name: key, variableKey: key, level: null });
      columnValues.push(rows.map((r) => r.values[key]!.value as number));
      parameterCount += 1;
      continue;
    }
    if (variable.type === 'boolean') {
      columns.push({ name: key, variableKey: key, level: null });
      columnValues.push(rows.map((r) => (r.values[key]?.value === true ? 1 : 0)));
      parameterCount += 1;
      continue;
    }

    // categorical | ordinal — full one-hot(기준 레벨 없음).
    const stringValues = rows.map((r) => String(r.values[key]?.value));
    const observedLevels = new Set(stringValues);
    const declared = getOrdinalOrder(key) ?? getCategoricalOrder(key);
    const levelOrder = declared
      ? declared.filter((l) => observedLevels.has(l))
      : sortDeterministic(Array.from(observedLevels));
    for (const level of levelOrder) {
      columns.push({ name: `${key}=${level}`, variableKey: key, level });
      columnValues.push(stringValues.map((v) => (v === level ? 1 : 0)));
    }
    parameterCount += Math.max(0, levelOrder.length - 1);
  }

  const n = rows.length;
  const x: number[][] = Array.from({ length: n }, (_, i) => columnValues.map((col) => col[i]));

  return {
    x,
    columns,
    columnCount: columns.length,
    parameterCount,
  };
}
