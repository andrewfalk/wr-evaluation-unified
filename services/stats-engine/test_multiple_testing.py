"""bh_fdr/holm 단위테스트 — 표준 교과서 예제(Benjamini-Hochberg 1995 예시 p값
집합, 여러 통계 강의에서 R p.adjust() 결과로 인용되는 값)로 대조한다.

이 파일은 R을 직접 실행하지 않는다(로컬 개발환경에 R 없음, PR1이 했던 Docker
r-base 실행은 이 세션에서 별도로 하지 않았다 — 계획서의 "운영 고정버전 검증"
게이트는 병합 전 별도 확인 필요)."""
from __future__ import annotations

import numpy as np
import pytest

from multiple_testing import bh_fdr, holm

# Benjamini & Hochberg(1995)식 예시 — 여러 통계 교재/강의에서 R
# p.adjust(method="BH"/"holm")의 표준 예시로 인용되는 값.
_P = [0.005, 0.011, 0.02, 0.04, 0.13, 0.5]
_BH_EXPECTED = [0.03, 0.033, 0.04, 0.06, 0.156, 0.5]
_HOLM_EXPECTED = [0.03, 0.055, 0.08, 0.12, 0.26, 0.5]


def test_bh_fdr_matches_known_example():
    result = bh_fdr(np.array(_P))
    np.testing.assert_allclose(result, _BH_EXPECTED, rtol=1e-6, atol=1e-9)


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
