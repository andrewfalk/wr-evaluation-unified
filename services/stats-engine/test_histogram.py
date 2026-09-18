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


# person_count 힌트 — job/disease grain 브로드캐스트 회귀 방지(A안). 실제 값(x)은 그대로
# 다 쓰되, bin 개수(k) 공식의 n만 person_count로 바꿔치기한다는 계약을 고정한다.
def test_person_count_none_matches_omitted_argument():
    rng = np.random.default_rng(11)
    values = list(rng.normal(size=200))
    q1, q3 = _q1_q3(values)
    assert compute_histogram(values, q1, q3) == compute_histogram(values, q1, q3, None)


def test_person_count_zero_or_negative_falls_back_to_row_count():
    rng = np.random.default_rng(12)
    values = list(rng.normal(size=200))
    q1, q3 = _q1_q3(values)
    baseline = compute_histogram(values, q1, q3)
    assert compute_histogram(values, q1, q3, 0) == baseline
    assert compute_histogram(values, q1, q3, -5) == baseline


def test_person_count_changes_bin_count_deterministically():
    # 200명(person_count)이 각 3행씩 브로드캐스트돼 600행(values)이 됐다고 가정 —
    # 무작위 시드에 기대지 않고 등간격 고정값 + FD 공식을 그대로 재현해 기대 k를
    # 직접 계산한다. 이전 버전은 "<="만 확인해 person_count를 통째로 무시해도
    # 우연히 통과할 수 있었다(1차 리뷰 지적) — 이번엔 두 k가 서로 다르다는 것과,
    # 각각이 정확히 그 공식값과 일치한다는 것까지 강하게 고정한다.
    base = [i / 199 * 100 for i in range(200)]  # 0~100 등간격 200개
    values = [v for v in base for _ in range(3)]  # 각 값 3행씩 복제 → n=600
    q1, q3 = _q1_q3(values)
    iqr = q3 - q1
    lo, hi = min(values), max(values)
    assert iqr > 0  # FD 분기(§2 분기 3/4 중 4번)를 타는지 자가검증

    def expected_k(n: int) -> int:
        h = 2 * iqr * (n ** (-1 / 3))
        return max(1, min(50, math.ceil((hi - lo) / h)))

    expected_row_k = expected_k(len(values))
    expected_person_k = expected_k(200)
    assert expected_row_k != expected_person_k  # 데이터 선택이 실제로 판별력이 있는지 자가검증

    by_row_count = compute_histogram(values, q1, q3)
    by_person_count = compute_histogram(values, q1, q3, 200)
    assert len(by_row_count["bins"]) == expected_row_k
    assert len(by_person_count["bins"]) == expected_person_k
    # bin을 무엇으로 세든 실제 채워지는 값(x)은 그대로 전부 다 쓴다 — count 합은 항상 n(행 수).
    assert sum(b["count"] for b in by_person_count["bins"]) == len(values)
    assert sum(b["count"] for b in by_row_count["bins"]) == len(values)


def test_person_count_used_for_iqr_zero_branch_too():
    # IQR==0(Sturges 분기)도 k_n 대입 대상이다 — FD 분기만 고치고 이쪽을 빠뜨리는 회귀 방지.
    values = [0.0] * 599 + [1.0]  # n=600, person_count=200이라고 가정
    q1, q3 = _q1_q3(values)
    assert q1 == 0.0 and q3 == 0.0
    result = compute_histogram(values, q1, q3, 200)
    assert len(result["bins"]) == math.ceil(math.log2(200) + 1)
