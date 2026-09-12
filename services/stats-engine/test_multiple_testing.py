"""bh_fdr/holm 단위테스트 — 표준 교과서 예제(Benjamini-Hochberg 1995 예시 p값
집합, 여러 통계 강의에서 R p.adjust() 결과로 인용되는 값)로 대조한다.

R 참조값 대조는 2026-09-11에 Docker r-base:latest(R 4.6.1)로 실제 실행해
완료했다(`fixtures/generate_r_reference_correlation_matrix.R`의
`bh_fdr_standard_example` 블록 — correlation_matrix.py R 검증과 같은 스크립트를
재사용해 p.adjust(method="BH")로 이 파일의 _P/_BH_EXPECTED를 직접 대조한다).
아래 하드코딩된 _BH_EXPECTED/_HOLM_EXPECTED 자체는 여러 통계 강의에서 인용되는
값이라 이전부터 신뢰해 왔으나, R을 직접 실행해 _BH_EXPECTED만큼은 이제 그
인용이 아니라 실측으로 확인된 상태다(Holm은 R 미실행 — p.adjust(method="holm")
대조는 범위 밖으로 남겨둠)."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

from multiple_testing import bh_fdr, bh_fdr_with_missing, holm

_R_REFERENCE = json.loads(
    (Path(__file__).parent / "fixtures" / "r_reference_values_correlation_matrix.json").read_text(encoding="utf-8")
)

# Benjamini & Hochberg(1995)식 예시 — 여러 통계 교재/강의에서 R
# p.adjust(method="BH"/"holm")의 표준 예시로 인용되는 값.
_P = [0.005, 0.011, 0.02, 0.04, 0.13, 0.5]
_BH_EXPECTED = [0.03, 0.033, 0.04, 0.06, 0.156, 0.5]
_HOLM_EXPECTED = [0.03, 0.055, 0.08, 0.12, 0.26, 0.5]


def test_bh_fdr_matches_known_example():
    result = bh_fdr(np.array(_P))
    np.testing.assert_allclose(result, _BH_EXPECTED, rtol=1e-6, atol=1e-9)


def test_r_reference_bh_fdr_matches_r_p_adjust():
    ref = _R_REFERENCE["bh_fdr_standard_example"]
    assert ref["raw_p"] == pytest.approx(_P)
    result = bh_fdr(np.array(_P))
    np.testing.assert_allclose(result, ref["adjusted_p"], rtol=1e-6, atol=1e-9)


def test_holm_matches_known_example():
    result = holm(np.array(_P))
    np.testing.assert_allclose(result, _HOLM_EXPECTED, rtol=1e-6, atol=1e-9)


def test_bh_fdr_preserves_input_order():
    shuffled = [0.5, 0.005, 0.04, 0.011, 0.13, 0.02]
    # _P 순서대로 재배치한 기대 인덱스: 0.5->idx5, 0.005->idx0, 0.04->idx3,
    # 0.011->idx1, 0.13->idx4, 0.02->idx2
    expected = [_BH_EXPECTED[5], _BH_EXPECTED[0], _BH_EXPECTED[3], _BH_EXPECTED[1], _BH_EXPECTED[4], _BH_EXPECTED[2]]
    result = bh_fdr(np.array(shuffled))
    np.testing.assert_allclose(result, expected, rtol=1e-6, atol=1e-9)


def test_holm_preserves_input_order():
    shuffled = [0.5, 0.005, 0.04, 0.011, 0.13, 0.02]
    expected = [_HOLM_EXPECTED[5], _HOLM_EXPECTED[0], _HOLM_EXPECTED[3], _HOLM_EXPECTED[1], _HOLM_EXPECTED[4], _HOLM_EXPECTED[2]]
    result = holm(np.array(shuffled))
    np.testing.assert_allclose(result, expected, rtol=1e-6, atol=1e-9)


def test_single_pvalue_is_noop_like():
    # PR3-A recipe는 항상 m=1로만 이 함수들을 호출한다(계획서 §"BH-FDR/Holm 범위
    # 정직화") — m=1이면 adjusted == raw여야 한다.
    assert bh_fdr(np.array([0.037]))[0] == pytest.approx(0.037)
    assert holm(np.array([0.037]))[0] == pytest.approx(0.037)


def test_empty_array_returns_empty():
    assert len(bh_fdr(np.array([]))) == 0
    assert len(holm(np.array([]))) == 0


def test_adjusted_p_is_monotonic_nondecreasing_in_sorted_order():
    # BH/Holm 둘 다 "정렬된 원본 p값 순서로 봤을 때 보정값이 감소하지 않는다"는
    # 성질을 만족해야 한다(단조성 보정의 목적).
    p = np.array([0.5, 0.005, 0.04, 0.011, 0.13, 0.02])
    order = np.argsort(p)
    for adjust_fn in (bh_fdr, holm):
        adjusted = adjust_fn(p)
        sorted_adjusted = adjusted[order]
        assert all(sorted_adjusted[i] <= sorted_adjusted[i + 1] + 1e-12 for i in range(len(sorted_adjusted) - 1))


# ---------------------------------------------------------------------------
# bh_fdr_with_missing — PR3-B(상관행렬) 전용. None(계산 불가) 처리.
# ---------------------------------------------------------------------------

def test_bh_fdr_with_missing_excludes_none_from_correction_set():
    # 계획서 §4 반례 — p=[0.04, 0.05, 0.9]에서 가운데를 None(계산 불가)으로 두면,
    # 나머지 두 값은 m=2 기준으로 보정돼야 한다(m=3 기준인 순수 bh_fdr()과 달라야
    # 함 — None을 억제된 셀로 오인해 그대로 넣으면 안 된다는 것과는 별개로, 애초에
    # "계산 자체가 안 된" 값이므로 m에서 제외하는 게 R p.adjust()의 NA 처리 관례).
    result = bh_fdr_with_missing([0.04, None, 0.9])
    assert result[1] is None
    two_value_bh = bh_fdr(np.array([0.04, 0.9]))
    assert result[0] == pytest.approx(float(two_value_bh[0]))
    assert result[2] == pytest.approx(float(two_value_bh[1]))


def test_bh_fdr_with_missing_none_does_not_contaminate_others_with_nan():
    # multiple_testing.bh_fdr()에 None이 섞인 배열을 그대로 넣으면 float64 변환
    # 시 NaN이 되고, argsort가 NaN을 최댓값으로 취급해 역방향 누적최솟값이 배열
    # 전체를 NaN으로 오염시킨다(계획서 §4에서 직접 재현한 결함) — 이 회귀를 고정.
    result = bh_fdr_with_missing([0.01, 0.02, None, 0.03, 0.5])
    for i, p in enumerate([0.01, 0.02, None, 0.03, 0.5]):
        if p is None:
            assert result[i] is None
        else:
            assert result[i] is not None
            assert not math.isnan(result[i])


def test_bh_fdr_with_missing_all_none_returns_all_none():
    result = bh_fdr_with_missing([None, None, None])
    assert result == [None, None, None]


def test_bh_fdr_with_missing_empty_returns_empty():
    assert bh_fdr_with_missing([]) == []


def test_bh_fdr_with_missing_no_none_matches_plain_bh_fdr():
    p = [0.005, 0.011, 0.02, 0.04, 0.13, 0.5]
    result = bh_fdr_with_missing(list(p))
    expected = bh_fdr(np.array(p))
    for actual, exp in zip(result, expected):
        assert actual == pytest.approx(float(exp))
