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
