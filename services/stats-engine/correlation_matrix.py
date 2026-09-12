"""상관행렬 — 여러 연속형 변수(3개+)의 모든 쌍에 대해 pearson/spearman 상관을
계산한다 — PR3-B 계획서 §4.

핵심 원칙(계획서 §4의 3단계 순서 중 1단계): 이 모듈은 person도, 반복측정도,
소수셀도 전혀 모른다. 요청된 모든 쌍에 대해 정직하게 계산하고, "Python 자신이
계산 가능했던 쌍"만으로 BH-FDR을 수행한다. 공개 여부(소수셀 게이트·§6.1
반복측정 게이트·계산불가 억제)는 전부 Node(statsCorrelationMatrixSuppression.ts)
가 이 결과를 받은 뒤 사후에 결정한다 — 이 모듈이 반환한 값을 그대로 클라이언트에
내보내지 않는다.

pairwise-complete 필터링: 각 변수의 값 배열은 row-aligned(같은 길이, 결측은
null)로 들어온다. 쌍마다 두 변수 다 non-null인 인덱스만 추려 계산한다 — R의
cor(df, use="pairwise.complete.obs")와 개념이 동일하다.

기존 bivariate.py::pearson_correlation()/spearman_correlation()을 그대로 재사용
한다(재구현하지 않음) — n<3·상수변수 등 경계조건 처리를 중복 구현하지 않기 위함.
"""
from __future__ import annotations

from typing import Any

from bivariate import pearson_correlation, spearman_correlation
from multiple_testing import bh_fdr_with_missing

_METHODS = {
    "pearson_correlation": pearson_correlation,
    "spearman_correlation": spearman_correlation,
}


def compute_correlation_matrix(method: str, variables: list[dict[str, Any]]) -> dict[str, Any]:
    fn = _METHODS[method]
    keys = [v["key"] for v in variables]
    k = len(keys)

    cells: list[dict[str, Any]] = []
    for i in range(k):
        for j in range(i + 1, k):
            xi, yj = variables[i]["values"], variables[j]["values"]
            paired = [(a, b) for a, b in zip(xi, yj) if a is not None and b is not None]
            xs = [p[0] for p in paired]
            ys = [p[1] for p in paired]
            raw = fn(xs, ys)
            cells.append({
                "xKey": keys[i],
                "yKey": keys[j],
                "n": raw["n"],
                "r": raw["statistic"],
                "pValue": raw["pValue"],
            })

    # BH-FDR — Python이 계산 가능했던(pValue not None) 쌍만 대상(계획서 §4 "BH
    # 검정집합 정의"). 억제될 쌍의 raw p값도 이 계산엔 포함된다 — Node가 사후에
    # 매트릭스 전체의 adjustedP 노출 여부를 다시 결정한다(계획서 §4.1).
    pvalues = [c["pValue"] for c in cells]
    adjusted = bh_fdr_with_missing(pvalues)
    for cell, adj in zip(cells, adjusted):
        cell["adjustedP"] = adj

    return {"method": method, "cells": cells}
