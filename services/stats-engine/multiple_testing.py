"""BH-FDR / Holm 다중검정 보정 — 순수 numpy 구현(statsmodels 미도입, PR3-A 계획서
§ "BH-FDR/Holm 범위 정직화" 참고: PR3-A recipe는 항상 p값 1개만 만들므로 이 두
함수는 실제 운영 경로에서는 m=1로만 호출된다. m>1 경로(상관행렬·층화 반복검정
등)는 후속 PR을 위해 범용으로 구현해둔다.
"""
from __future__ import annotations

import numpy as np


def bh_fdr(pvalues: np.ndarray) -> np.ndarray:
    """Benjamini-Hochberg FDR 보정. 입력 순서 그대로 반환(정렬 순서 노출 금지)."""
    p = np.asarray(pvalues, dtype=np.float64)
    m = len(p)
    if m == 0:
        return p
    order = np.argsort(p)
    ranked = p[order]
    raw = ranked * m / np.arange(1, m + 1)
    # 단조성 보정 — 뒤에서부터 누적 최솟값(step-up)
    adj_sorted = np.minimum.accumulate(raw[::-1])[::-1]
    adj_sorted = np.clip(adj_sorted, 0, 1)
    out = np.empty(m, dtype=np.float64)
    out[order] = adj_sorted
    return out


def holm(pvalues: np.ndarray) -> np.ndarray:
    """Holm step-down 보정. 입력 순서 그대로 반환."""
    p = np.asarray(pvalues, dtype=np.float64)
    m = len(p)
    if m == 0:
        return p
    order = np.argsort(p)
    ranked = p[order]
    raw = ranked * (m - np.arange(m))
    # 단조성 보정 — 앞에서부터 누적 최댓값(step-down)
    adj_sorted = np.maximum.accumulate(raw)
    adj_sorted = np.clip(adj_sorted, 0, 1)
    out = np.empty(m, dtype=np.float64)
    out[order] = adj_sorted
    return out


def bh_fdr_with_missing(pvalues: list[float | None]) -> list[float | None]:
    """PR3-B(상관행렬) 전용 — 계산 불가(None) pValue를 검정 집합에서 제외한 뒤
    순수 bh_fdr()을 적용하고, 원래 위치에 다시 None을 채워 되돌린다(R
    p.adjust()가 NA를 자동 제외하는 관례와 동일 — 계획서 §4 "BH 검정집합 정의").

    이 함수는 person·반복측정 등 disclosure를 전혀 모른다 — Python이 자기 자신의
    계산 가능 여부(pValue not None)만으로 판단한 m을 대상으로 한다. Node가 사후에
    person 단위 소수셀·§6.1 게이트로 결정하는 억제는 이 계산에 관여하지 않는다
    (계획서 §4의 3단계 순서 — Python은 disclosure를 모른 채 정직하게만 계산).
    """
    indices = [i for i, p in enumerate(pvalues) if p is not None]
    if not indices:
        return [None] * len(pvalues)
    subset = np.array([pvalues[i] for i in indices], dtype=np.float64)
    adjusted_subset = bh_fdr(subset)
    result: list[float | None] = [None] * len(pvalues)
    for idx, adj in zip(indices, adjusted_subset):
        result[idx] = float(adj)
    return result
