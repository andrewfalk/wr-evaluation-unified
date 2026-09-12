"""히스토그램 bin 계산 — PR3-B 계획서 §2 "히스토그램 bin 알고리즘".

분기 순서(반드시 이 순서 — IQR==0을 "상수분포"와 동일시하면 안 된다. 0이 99개+1이
1개인 배열도 IQR==0이지만 진짜 상수가 아니다):
  1. n==0            → 빈 결과
  2. min==max(진짜 상수) → 단일 bin을 직접 구성(numpy의 암묵적 range-padding에
                          기대지 않음 — numpy 버전 간 결정성 보호)
  3. min!=max·IQR==0 → Sturges 규칙
  4. 그 외           → Freedman-Diaconis 규칙

경계 포함 규칙: numpy.histogram과 동일하게 마지막 bin만 양끝 포함(right-closed),
나머지는 왼쪽 포함/오른쪽 배제 — 클라이언트 축 라벨("이상/미만")도 이 규칙을
따라야 한다.

Q1/Q3는 descriptive.py::compute_continuous()가 이미 계산한 값을 그대로 받는다
(재계산하지 않음 — 표와 차트의 Q1/Q3 불일치 방지).

이 모듈은 person을 모른다(프로젝트 전역 원칙) — bin 경계와 관측 건수(count)만
계산하고, person 단위 소수셀 판정은 Node가 이 경계로 DatasetRow[]를 재순회해
별도로 수행한다(계획서 §3).
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np

MAX_BINS = 50
MIN_BINS = 1


def compute_histogram(values: list[float], q1: float, q3: float) -> dict[str, Any]:
    n = len(values)
    if n == 0:
        return {"bins": []}

    x = np.asarray(values, dtype=np.float64)
    lo, hi = float(np.min(x)), float(np.max(x))

    if lo == hi:
        return {"bins": [{"lower": lo, "upper": hi, "count": n}]}

    iqr = q3 - q1
    if iqr == 0.0:
        k = math.ceil(math.log2(n) + 1)
    else:
        h = 2 * iqr * (n ** (-1 / 3))
        if h > 0 and math.isfinite(h):
            k = math.ceil((hi - lo) / h)
        else:
            k = math.ceil(math.log2(n) + 1)
    k = max(MIN_BINS, min(MAX_BINS, k))

    counts, edges = np.histogram(x, bins=k, range=(lo, hi))
    bins = [
        {"lower": float(edges[i]), "upper": float(edges[i + 1]), "count": int(counts[i])}
        for i in range(len(counts))
    ]
    return {"bins": bins}
