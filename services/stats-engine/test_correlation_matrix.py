"""correlation_matrix.py — 계획서 §4. 이 모듈은 person/반복측정/소수셀을 전혀
모른 채 정직하게 계산만 한다는 원칙을 검증한다: (1) 모든 요청 쌍이 빠짐없이
반환되는지, (2) pairwise-complete 필터링이 정확한지, (3) BH-FDR이 "Python 자신이
계산 가능했던 쌍"만으로 수행되는지(계산 불가 쌍의 raw None이 다른 쌍의 adjustedP
계산을 오염시키지 않는지 — multiple_testing.bh_fdr()의 NaN 전파 결함 회귀 포함).

R 참조값 대조(`test_r_reference_*`)는 2026-09-11에 Docker r-base:latest(R 4.6.1)
+ jsonlite로 실제 실행해 완료했다(`fixtures/generate_r_reference_correlation_matrix.R`
실행 결과가 `fixtures/r_reference_values_correlation_matrix.json`) — cor.test()
pearson/spearman + p.adjust(method="BH")와 독립 구현체로 교차검증한다."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

from correlation_matrix import compute_correlation_matrix

_R_REFERENCE = json.loads(
    (Path(__file__).parent / "fixtures" / "r_reference_values_correlation_matrix.json").read_text(encoding="utf-8")
)


def _variable(key: str, values: list[float | None]) -> dict:
    return {"key": key, "values": values}


def test_all_pairs_present_for_three_variables():
    rng = np.random.default_rng(1)
    n = 50
    variables = [_variable(f"v{i}", list(rng.normal(size=n))) for i in range(3)]
    result = compute_correlation_matrix("pearson_correlation", variables)
    pairs = {(c["xKey"], c["yKey"]) for c in result["cells"]}
    assert pairs == {("v0", "v1"), ("v0", "v2"), ("v1", "v2")}
    assert len(result["cells"]) == 3


def test_cell_count_matches_combinatorial_count():
    rng = np.random.default_rng(2)
    n = 30
    k = 6
    variables = [_variable(f"v{i}", list(rng.normal(size=n))) for i in range(k)]
    result = compute_correlation_matrix("pearson_correlation", variables)
    assert len(result["cells"]) == math.comb(k, 2)


def test_pairwise_complete_filtering_excludes_either_null():
    x = [1.0, None, 3.0, 4.0, None, 6.0, 7.0]
    y = [2.0, 3.0, None, 8.0, 5.0, 12.0, 14.0]
    z = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
    variables = [_variable("x", x), _variable("y", y), _variable("z", z)]
    result = compute_correlation_matrix("pearson_correlation", variables)
    xy = next(c for c in result["cells"] if {c["xKey"], c["yKey"]} == {"x", "y"})
    # x,y 둘 다 non-null인 인덱스: 0,3,5,6 → n=4
    assert xy["n"] == 4


def test_constant_variable_pair_is_null_not_crash():
    rng = np.random.default_rng(3)
    variables = [
        _variable("const", [5.0] * 20),
        _variable("normal", list(rng.normal(size=20))),
        _variable("normal2", list(rng.normal(size=20))),
    ]
    result = compute_correlation_matrix("pearson_correlation", variables)
    const_pair = next(c for c in result["cells"] if "const" in (c["xKey"], c["yKey"]))
    assert const_pair["r"] is None
    assert const_pair["pValue"] is None
    assert const_pair["adjustedP"] is None


def test_zero_overlap_pair_returns_null():
    x = [1.0, 2.0, None, None]
    y = [None, None, 3.0, 4.0]
    z = [1.0, 2.0, 3.0, 4.0]
    variables = [_variable("x", x), _variable("y", y), _variable("z", z)]
    result = compute_correlation_matrix("pearson_correlation", variables)
    xy = next(c for c in result["cells"] if {c["xKey"], c["yKey"]} == {"x", "y"})
    assert xy["n"] == 0
    assert xy["r"] is None


def test_bh_fdr_uses_only_computable_pairs_no_nan_contamination():
    # multiple_testing.bh_fdr()는 None이 섞이면 NaN이 배열 전체를 오염시킨다
    # (계획서 §4 "BH-FDR 계산불가 pair 처리" — 직접 계산으로 재현했던 결함).
    # 여기서는 constant 변수 하나를 섞어 실제로 그 오염이 없는지 회귀검증한다.
    rng = np.random.default_rng(4)
    n = 100
    variables = [
        _variable("a", list(rng.normal(size=n))),
        _variable("b", list(rng.normal(loc=0.5, size=n))),
        _variable("const", [1.0] * n),  # a-const, b-const는 계산 불가(pValue=None)
    ]
    result = compute_correlation_matrix("pearson_correlation", variables)
    ab = next(c for c in result["cells"] if {c["xKey"], c["yKey"]} == {"a", "b"})
    assert ab["pValue"] is not None
    assert ab["adjustedP"] is not None
    assert not math.isnan(ab["adjustedP"])
    for c in result["cells"]:
        if "const" in (c["xKey"], c["yKey"]):
            assert c["adjustedP"] is None


def test_adjusted_p_matches_bh_fdr_with_missing_directly():
    from multiple_testing import bh_fdr_with_missing

    rng = np.random.default_rng(5)
    n = 80
    variables = [_variable(f"v{i}", list(rng.normal(size=n))) for i in range(4)]
    result = compute_correlation_matrix("pearson_correlation", variables)
    pvalues = [c["pValue"] for c in result["cells"]]
    expected = bh_fdr_with_missing(pvalues)
    actual = [c["adjustedP"] for c in result["cells"]]
    assert actual == expected


def test_spearman_method_computes_rho_not_pearson_r():
    x = [1.0, 2.0, 3.0, 4.0, 5.0]
    y = [1.0, 4.0, 9.0, 16.0, 25.0]  # 단조 증가지만 비선형 — pearson r<1, spearman rho==1
    z = [5.0, 3.0, 1.0, 2.0, 4.0]
    variables = [_variable("x", x), _variable("y", y), _variable("z", z)]
    pearson_result = compute_correlation_matrix("pearson_correlation", variables)
    spearman_result = compute_correlation_matrix("spearman_correlation", variables)
    xy_pearson = next(c for c in pearson_result["cells"] if {c["xKey"], c["yKey"]} == {"x", "y"})
    xy_spearman = next(c for c in spearman_result["cells"] if {c["xKey"], c["yKey"]} == {"x", "y"})
    assert xy_spearman["r"] == pytest.approx(1.0)
    assert xy_pearson["r"] < 1.0


@pytest.mark.parametrize("seed", [10, 11])
def test_deterministic_same_input_twice(seed):
    rng = np.random.default_rng(seed)
    variables = [_variable(f"v{i}", list(rng.normal(size=40))) for i in range(4)]
    r1 = compute_correlation_matrix("pearson_correlation", variables)
    r2 = compute_correlation_matrix("pearson_correlation", variables)
    assert r1 == r2


# ---------------------------------------------------------------------------
# R 참조값 대조 — generate_r_reference_correlation_matrix.R과 동일한 입력벡터.
# ---------------------------------------------------------------------------

def _xyz_variables() -> list[dict]:
    x = list(range(1, 11))
    y = [v * 2 for v in x]
    z = list(range(10, 0, -1))
    return [_variable("x", [float(v) for v in x]), _variable("y", [float(v) for v in y]), _variable("z", [float(v) for v in z])]


def test_r_reference_pearson_matrix_matches_r_cor_test_and_p_adjust():
    ref = _R_REFERENCE["pearson_matrix"]
    result = compute_correlation_matrix("pearson_correlation", _xyz_variables())
    for pair_key, (a, b) in (("xy", ("x", "y")), ("xz", ("x", "z")), ("yz", ("y", "z"))):
        cell = next(c for c in result["cells"] if {c["xKey"], c["yKey"]} == {a, b})
        cell_ref = ref[pair_key]
        assert cell["r"] == pytest.approx(cell_ref["r"], rel=1e-6)
        assert cell["pValue"] == pytest.approx(cell_ref["p_value"], rel=1e-4)
        assert cell["adjustedP"] == pytest.approx(cell_ref["adjusted_p"], rel=1e-4)


def test_r_reference_pairwise_complete_matches_r_cor_test():
    ref = _R_REFERENCE["pairwise_complete"]
    xa = [1.0, None, 3.0, 4.0, None, 6.0, 7.0]
    ya = [2.0, 3.0, None, 8.0, 5.0, 12.0, 14.0]
    variables = [_variable("x", xa), _variable("y", ya)]
    result = compute_correlation_matrix("pearson_correlation", variables)
    cell = result["cells"][0]
    assert cell["n"] == ref["n"]
    assert cell["r"] == pytest.approx(ref["r"], rel=1e-6)
    assert cell["pValue"] == pytest.approx(ref["p_value"], rel=1e-4)


def test_r_reference_spearman_matches_r_cor_test():
    ref = _R_REFERENCE["spearman_xy"]
    result = compute_correlation_matrix("spearman_correlation", _xyz_variables())
    cell = next(c for c in result["cells"] if {c["xKey"], c["yKey"]} == {"x", "y"})
    assert cell["r"] == pytest.approx(ref["rho"], rel=1e-6)
    assert cell["pValue"] == pytest.approx(ref["p_value"], rel=1e-4)
