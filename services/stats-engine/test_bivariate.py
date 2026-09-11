"""bivariate.py 단위테스트.

R 참조값 대조(PR1이 test_descriptive.py에서 했던 Docker r-base:latest + 실행
방식)는 이 세션에서 수행하지 않았다 — 계획서(pr3-swift-waterfall.md) §구현순서
1단계 "운영 고정버전(scipy 1.13.0) Docker pytest 통과가 병합 전 필수 게이트"는
별도로 남아 있는 작업이다. 이 파일은 그때까지의 회귀 방지용으로:
  1) scipy 함수를 직접 호출해 통계량·p값을 교차검증(같은 scipy 안에서지만
     bivariate.py가 값을 왜곡 없이 그대로 전달하는지 확인)
  2) 손으로 계산 가능한 값(OR, 상관계수 CI 등)을 수식대로 재계산해 대조
  3) 수학적 항등식(Welch ANOVA k=2일 때 F=t², Welch t와 동일 df)으로 anova()
     구현을 독립적으로 검증(R 없이도 신뢰 가능한 회귀 앵커)
로 구성한다.
"""
from __future__ import annotations

import math

import numpy as np
import pytest
from scipy import stats as scipy_stats

import bivariate as bv


def _groups(*value_lists, labels=None):
    labels = labels or list(range(len(value_lists)))
    return [{"label": lbl, "values": list(vals)} for lbl, vals in zip(labels, value_lists)]


# ---------------------------------------------------------------------------
# welch_t
# ---------------------------------------------------------------------------

def test_welch_t_matches_scipy_statistic_and_pvalue():
    x1 = [4.0, 5.0, 6.0, 5.0, 7.0, 6.0]
    x2 = [8.0, 9.0, 7.0, 10.0, 9.0, 8.0, 11.0]
    result = bv.welch_t(_groups(x1, x2))

    ref_t, ref_p = scipy_stats.ttest_ind(x2, x1, equal_var=False)
    assert result["statistic"] == pytest.approx(ref_t, rel=1e-9)
    assert result["pValue"] == pytest.approx(ref_p, rel=1e-9)

    mean_diff = result["effectSizes"][0]
    assert mean_diff["name"] == "mean_difference"
    assert mean_diff["value"] == pytest.approx(np.mean(x2) - np.mean(x1), rel=1e-9)
    assert mean_diff["ci"][0] < mean_diff["value"] < mean_diff["ci"][1]


def test_welch_t_hedges_g_uses_pooled_sd():
    x1 = [1.0, 2.0, 3.0, 4.0]
    x2 = [5.0, 6.0, 7.0, 8.0]
    result = bv.welch_t(_groups(x1, x2))
    g = result["effectSizes"][1]
    assert g["name"] == "hedges_g"

    n1, n2 = len(x1), len(x2)
    var1, var2 = np.var(x1, ddof=1), np.var(x2, ddof=1)
    sp = math.sqrt(((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2))
    d = (np.mean(x2) - np.mean(x1)) / sp
    j = 1 - 3 / (4 * (n1 + n2 - 2) - 1)
    expected_g = d * j
    assert g["value"] == pytest.approx(expected_g, rel=1e-9)


def test_welch_t_zero_variance_group_returns_null():
    result = bv.welch_t(_groups([5.0, 5.0, 5.0], [1.0, 2.0, 3.0]))
    assert result["statistic"] is None
    assert result["nullReasons"]["statistic"] == bv.CONSTANT_VARIABLE
    assert result["effectSizes"] == []


def test_welch_t_singleton_group_returns_insufficient_data():
    result = bv.welch_t(_groups([5.0], [1.0, 2.0, 3.0]))
    assert result["statistic"] is None
    assert result["nullReasons"]["statistic"] == bv.INSUFFICIENT_GROUP_DATA


# ---------------------------------------------------------------------------
# mann_whitney
# ---------------------------------------------------------------------------

def test_mann_whitney_matches_scipy():
    x1 = [1.0, 2.0, 3.0, 4.0, 5.0]
    x2 = [6.0, 7.0, 8.0, 9.0, 10.0]
    result = bv.mann_whitney(_groups(x1, x2))

    ref_u, ref_p = scipy_stats.mannwhitneyu(x2, x1, alternative="two-sided", method="asymptotic", use_continuity=True)
    assert result["statistic"] == pytest.approx(ref_u, rel=1e-9)
    assert result["pValue"] == pytest.approx(ref_p, rel=1e-9)

    # x2가 x1보다 전부 크므로 rank-biserial은 +1에 가까워야 한다(완전 분리).
    r = result["effectSizes"][0]["value"]
    assert r == pytest.approx(1.0, abs=1e-9)


# ---------------------------------------------------------------------------
# anova (Welch) — k=2일 때 welch_t와 수학적으로 동치(F=t², df 동일)
# ---------------------------------------------------------------------------

def test_welch_anova_two_groups_equals_welch_t_squared():
    x1 = [4.0, 5.0, 6.0, 5.0, 7.0, 6.0]
    x2 = [8.0, 9.0, 7.0, 10.0, 9.0, 8.0, 11.0]
    t_result = bv.welch_t(_groups(x1, x2))
    f_result = bv.anova(_groups(x1, x2))

    assert f_result["statistic"] == pytest.approx(t_result["statistic"] ** 2, rel=1e-6)
    assert f_result["df"]["numerator"] == 1
    assert f_result["df"]["denominator"] == pytest.approx(t_result["df"], rel=1e-6)
    assert f_result["pValue"] == pytest.approx(t_result["pValue"], rel=1e-6)


def test_welch_anova_three_groups_eta_squared_bounds():
    x1, x2, x3 = [1.0, 2.0, 3.0], [10.0, 11.0, 12.0], [20.0, 22.0, 24.0]
    result = bv.anova(_groups(x1, x2, x3))
    eta_sq = result["effectSizes"][0]["value"]
    # 그룹 간 분산이 압도적으로 커서 eta-squared는 1에 매우 가까워야 한다.
    assert 0.9 < eta_sq <= 1.0
    assert result["df"]["numerator"] == 2


def test_welch_anova_constant_group_returns_null():
    result = bv.anova(_groups([5.0, 5.0, 5.0], [1.0, 2.0, 3.0], [9.0, 10.0, 11.0]))
    assert result["statistic"] is None
    assert result["nullReasons"]["statistic"] == bv.CONSTANT_VARIABLE


# ---------------------------------------------------------------------------
# kruskal_wallis
# ---------------------------------------------------------------------------

def test_kruskal_wallis_matches_scipy():
    x1, x2, x3 = [1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]
    result = bv.kruskal_wallis(_groups(x1, x2, x3))
    ref_h, ref_p = scipy_stats.kruskal(x1, x2, x3)
    assert result["statistic"] == pytest.approx(ref_h, rel=1e-9)
    assert result["pValue"] == pytest.approx(ref_p, rel=1e-9)


def test_kruskal_wallis_all_identical_returns_constant_variable():
    result = bv.kruskal_wallis(_groups([5.0, 5.0], [5.0, 5.0], [5.0, 5.0]))
    assert result["statistic"] is None
    assert result["nullReasons"]["statistic"] == bv.CONSTANT_VARIABLE


# ---------------------------------------------------------------------------
# chi_square
# ---------------------------------------------------------------------------

def test_chi_square_matches_scipy_and_cramers_v_uses_uncorrected_chi2():
    table = [[50, 30], [20, 60]]
    result = bv.chi_square(table)

    ref_chi2, ref_p, ref_dof, _ = scipy_stats.chi2_contingency(np.array(table), correction=True)
    assert result["statistic"] == pytest.approx(ref_chi2, rel=1e-9)
    assert result["pValue"] == pytest.approx(ref_p, rel=1e-9)
    assert result["df"] == ref_dof

    uncorrected_chi2, _, _, _ = scipy_stats.chi2_contingency(np.array(table), correction=False)
    n = sum(sum(row) for row in table)
    expected_v = math.sqrt(uncorrected_chi2 / (n * (min(2, 2) - 1)))
    assert result["extra"]["cramersV"]["value"] == pytest.approx(expected_v, rel=1e-9)
    # Yates 보정 chi2와 비보정 chi2는 2x2에서 다른 값이어야 한다(둘을 구분해 쓰고 있는지 확인).
    assert ref_chi2 != uncorrected_chi2


def test_chi_square_low_expected_count_flag():
    table = [[1, 19], [19, 61]]
    result = bv.chi_square(table)
    assert "low_expected_count" in result["qualityFlags"]


# ---------------------------------------------------------------------------
# fisher_exact
# ---------------------------------------------------------------------------

def test_fisher_exact_odds_ratio_hand_computed():
    table = [[10, 5], [3, 12]]
    result = bv.fisher_exact(table)
    assert result["effectSizes"][0]["value"] == pytest.approx((10 * 12) / (5 * 3), rel=1e-9)
    assert "haldane_anscombe_applied" not in result["qualityFlags"]

    _, ref_p = scipy_stats.fisher_exact(np.array(table), alternative="two-sided")
    assert result["pValue"] == pytest.approx(ref_p, rel=1e-9)


def test_fisher_exact_zero_cell_applies_haldane_anscombe():
    table = [[0, 10], [10, 10]]
    result = bv.fisher_exact(table)
    assert "haldane_anscombe_applied" in result["qualityFlags"]
    expected_or = (0.5 * 10.5) / (10.5 * 10.5)
    assert result["effectSizes"][0]["value"] == pytest.approx(expected_or, rel=1e-9)


def test_fisher_exact_rejects_non_2x2():
    with pytest.raises(ValueError):
        bv.fisher_exact([[1, 2, 3], [4, 5, 6]])


# ---------------------------------------------------------------------------
# pearson_correlation / spearman_correlation
# ---------------------------------------------------------------------------

def test_pearson_correlation_matches_scipy_r_and_ci_hand_computed():
    x = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
    y = [2.1, 3.9, 6.2, 7.8, 10.1, 11.9, 14.2, 15.8, 18.1, 19.9]
    result = bv.pearson_correlation(x, y)

    ref_r, ref_p = scipy_stats.pearsonr(x, y)
    assert result["effectSizes"][0]["value"] == pytest.approx(ref_r, rel=1e-9)
    assert result["pValue"] == pytest.approx(ref_p, rel=1e-9)

    n = len(x)
    z = math.atanh(ref_r)
    se = 1 / math.sqrt(n - 3)
    zcrit = float(scipy_stats.norm.ppf(0.975))
    expected_ci = (math.tanh(z - zcrit * se), math.tanh(z + zcrit * se))
    ci = result["effectSizes"][0]["ci"]
    assert ci[0] == pytest.approx(expected_ci[0], rel=1e-9)
    assert ci[1] == pytest.approx(expected_ci[1], rel=1e-9)


def test_pearson_correlation_small_n_ci_unavailable():
    result = bv.pearson_correlation([1.0, 2.0, 3.0], [2.0, 4.0, 5.0])
    assert result["effectSizes"][0]["ci"] is None
    assert result["effectSizes"][0]["ciUnavailableReason"] == "undefined_at_n"


def test_pearson_correlation_perfect_correlation_ci_unavailable():
    result = bv.pearson_correlation([1.0, 2.0, 3.0, 4.0, 5.0], [2.0, 4.0, 6.0, 8.0, 10.0])
    assert result["effectSizes"][0]["value"] == pytest.approx(1.0, abs=1e-9)
    assert result["effectSizes"][0]["ci"] is None
    assert result["effectSizes"][0]["ciUnavailableReason"] == "perfect_correlation"


def test_pearson_correlation_constant_variable():
    result = bv.pearson_correlation([5.0, 5.0, 5.0, 5.0], [1.0, 2.0, 3.0, 4.0])
    assert result["statistic"] is None
    assert result["nullReasons"]["statistic"] == bv.CONSTANT_VARIABLE


def test_spearman_correlation_matches_scipy_and_bonett_wright_ci():
    x = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
    y = [2.0, 1.0, 4.0, 3.0, 6.0, 5.0, 8.0, 7.0, 10.0, 9.0]
    result = bv.spearman_correlation(x, y)

    ref_rho, ref_p = scipy_stats.spearmanr(x, y)
    assert result["effectSizes"][0]["value"] == pytest.approx(ref_rho, rel=1e-9)
    assert result["pValue"] == pytest.approx(ref_p, rel=1e-9)

    n = len(x)
    z = math.atanh(ref_rho)
    se = math.sqrt((1 + ref_rho ** 2 / 2) / (n - 3))
    zcrit = float(scipy_stats.norm.ppf(0.975))
    expected_ci = (math.tanh(z - zcrit * se), math.tanh(z + zcrit * se))
    ci = result["effectSizes"][0]["ci"]
    assert ci[0] == pytest.approx(expected_ci[0], rel=1e-9)
    assert ci[1] == pytest.approx(expected_ci[1], rel=1e-9)
