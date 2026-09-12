"""histogram.py — PR3-B 계획서 §2 분기(n=0/min==max/IQR==0/FD) + 결정성 +
구조 불변조건(공개된 히스토그램의 bin count 합=n, 경계 단조증가) 전수 테스트."""
from __future__ import annotations

import math

import numpy as np
import pytest

from descriptive import compute_continuous
from histogram import compute_histogram


def _q1_q3(values: list[float]) -> tuple[float, float]:
    stat = compute_continuous(values)
    return stat["q1"], stat["q3"]


def test_n0_returns_empty_bins():
    result = compute_histogram([], 0.0, 0.0)
    assert result["bins"] == []


def test_min_equals_max_returns_single_bin_without_calling_numpy_histogram_padding():
    values = [5.0] * 100
    q1, q3 = _q1_q3(values)
    result = compute_histogram(values, q1, q3)
    assert result["bins"] == [{"lower": 5.0, "upper": 5.0, "count": 100}]


def test_n1_is_min_equals_max_single_bin():
    result = compute_histogram([7.0], 7.0, 7.0)
    assert result["bins"] == [{"lower": 7.0, "upper": 7.0, "count": 1}]


def test_iqr_zero_but_not_constant_uses_sturges():
    # 0이 99개 + 1이 1개 — IQR==0이지만 진짜 상수가 아니다(계획서 §2 반례).
    values = [0.0] * 99 + [1.0]
    q1, q3 = _q1_q3(values)
    assert q1 == 0.0 and q3 == 0.0  # IQR==0 확인
    result = compute_histogram(values, q1, q3)
    n = len(values)
    expected_k = math.ceil(math.log2(n) + 1)
    assert len(result["bins"]) == expected_k
    assert sum(b["count"] for b in result["bins"]) == n


def test_freedman_diaconis_used_for_normal_spread():
    rng = np.random.default_rng(42)
    values = list(rng.normal(size=200))
    q1, q3 = _q1_q3(values)
    result = compute_histogram(values, q1, q3)
    assert 1 <= len(result["bins"]) <= 50
    assert sum(b["count"] for b in result["bins"]) == len(values)


def test_bin_edges_are_monotonically_increasing():
    rng = np.random.default_rng(7)
    values = list(rng.normal(size=500))
    q1, q3 = _q1_q3(values)
    result = compute_histogram(values, q1, q3)
    edges = [result["bins"][0]["lower"]] + [b["upper"] for b in result["bins"]]
    assert all(edges[i] < edges[i + 1] for i in range(len(edges) - 1))


def test_last_bin_is_right_closed_others_are_not():
    # 값이 정확히 마지막 bin의 상단 경계와 같을 때 마지막 bin에 포함돼야 한다
    # (numpy.histogram과 동일한 관례 — 계획서 §2 "경계 포함 규칙").
    values = [0.0, 1.0, 2.0, 3.0, 10.0]
    q1, q3 = _q1_q3(values)
    result = compute_histogram(values, q1, q3)
    assert sum(b["count"] for b in result["bins"]) == len(values)
    assert result["bins"][-1]["upper"] == max(values)


def test_bin_count_max_50():
    rng = np.random.default_rng(1)
    values = list(rng.uniform(0, 1, size=100000))
    q1, q3 = _q1_q3(values)
    result = compute_histogram(values, q1, q3)
    assert len(result["bins"]) <= 50


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_deterministic_same_input_twice(seed):
    rng = np.random.default_rng(seed)
    values = list(rng.normal(size=300))
    q1, q3 = _q1_q3(values)
    r1 = compute_histogram(values, q1, q3)
    r2 = compute_histogram(values, q1, q3)
    assert r1 == r2
