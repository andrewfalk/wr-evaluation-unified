"""bivariate.py 단위테스트.

R 참조값 대조는 2026-09-11에 Docker r-base:latest(R 4.6.1 "Happy Hop") +
effsize 0.8.1로 실제 실행해 완료했다(PR1이 test_descriptive.py에서 한 방식과
동일 — `fixtures/generate_r_reference_bivariate.R` 실행 결과가
`fixtures/r_reference_values_bivariate.json`). 이 파일은:
  1) scipy 함수를 직접 호출해 통계량·p값을 교차검증(같은 scipy 안에서지만
     bivariate.py가 값을 왜곡 없이 그대로 전달하는지 확인)
  2) 손으로 계산 가능한 값(OR, 상관계수 CI 등)을 수식대로 재계산해 대조
  3) 수학적 항등식(Welch ANOVA k=2일 때 F=t², Welch t와 동일 df)으로 anova()
     구현을 독립적으로 검증(R 없이도 신뢰 가능한 회귀 앵커)
  4) `test_r_reference_*`: 위 R 실행 결과와 직접 대조(scipy 자기교차검증이
     아니라 독립 구현체와의 교차검증)
로 구성한다. 운영 고정버전(numpy==1.26.4/scipy==1.13.0) 자체의 Docker pytest
검증은 별도 게이트(README 참고)로 수행한다.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest
from scipy import stats as scipy_stats

import bivariate as bv

_R_REFERENCE = json.loads(
    (Path(__file__).parent / "fixtures" / "r_reference_values_bivariate.json").read_text(encoding="utf-8")
)


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


def test_welch_t_hedges_g_ci_matches_effsize_reference():
    """코드리뷰(2026-09-12)가 R effsize::cohen.d(hedges.correction=TRUE,
    noncentral=FALSE)를 손으로 옮겨 계산해 대조한 값 — Var(d) 분모가 2(n1+n2-2)가
    아니라 2(n1+n2)이고, 임계값이 z가 아니라 t(df=n1+n2-2)여야 이 값과 일치한다.
    당시엔 R을 직접 실행한 것은 아니었으나, 이후 Docker r-base로 같은 입력을
    실제 실행해(`test_r_reference_welch_t_hedges_g_matches_r_effsize_cohen_d`)
    rel=1e-9까지 정확히 일치함을 확인했다(그 과정에서 SE 공식의 제곱항이 보정
    전 d가 아니라 보정 후 g여야 한다는 걸 추가로 잡아냄 — bivariate.py 주석
    참고). 아래 두 테스트가 사실상 같은 걸 검증하지만, 이 테스트는 "공식이
    맞는지" abs 허용오차로 남겨둔다(틀린 공식인 z-crit을 쓰면 약 0.06 차이가 나
    확실히 걸러진다)."""
    x1 = list(range(10))       # 0..9
    x2 = list(range(1, 11))    # 1..10
    result = bv.welch_t(_groups(x1, x2))
    g = result["effectSizes"][1]
    assert g["value"] == pytest.approx(0.316333, abs=1e-5)
    assert g["ci"][0] == pytest.approx(-0.589138, abs=1e-3)
    assert g["ci"][1] == pytest.approx(1.221805, abs=1e-3)


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


# ---------------------------------------------------------------------------
# R 참조값 교차검증 (Docker r-base:latest R 4.6.1 + effsize 0.8.1, 2026-09-11 실측)
#
# 위의 scipy 자기교차검증과 달리, 이 절은 scipy와 무관한 독립 구현(R)과 대조한다.
# fisher_exact의 OR·ANOVA의 eta-squared처럼 R과 정의 자체가 달라 대조 불가능한
# 값은 설계표(pr3-swift-waterfall.md §검정별 세부 스펙)가 명시한 대로 p값만 비교한다.
# ---------------------------------------------------------------------------

def test_r_reference_welch_t_matches_r_stats_t_test():
    ref = _R_REFERENCE["welch_t_basic"]
    x1 = [4.0, 5.0, 6.0, 5.0, 7.0, 6.0]
    x2 = [8.0, 9.0, 7.0, 10.0, 9.0, 8.0, 11.0]
    result = bv.welch_t(_groups(x1, x2))
    assert result["statistic"] == pytest.approx(ref["statistic"], rel=1e-6)
    assert result["pValue"] == pytest.approx(ref["p_value"], rel=1e-6)
    assert result["df"] == pytest.approx(ref["df"], rel=1e-6)
    assert result["effectSizes"][0]["value"] == pytest.approx(ref["mean_difference"], rel=1e-9)


def test_r_reference_welch_t_hedges_g_matches_r_effsize_cohen_d():
    ref = _R_REFERENCE["welch_t_hedges_g"]
    x1 = list(range(10))
    x2 = list(range(1, 11))
    result = bv.welch_t(_groups(x1, x2))
    g = result["effectSizes"][1]
    assert g["value"] == pytest.approx(ref["estimate"], rel=1e-9)
    assert g["ci"][0] == pytest.approx(ref["ci_lower"], rel=1e-9)
    assert g["ci"][1] == pytest.approx(ref["ci_upper"], rel=1e-9)


def test_r_reference_mann_whitney_pvalue_matches_r_wilcox_test():
    ref = _R_REFERENCE["mann_whitney"]
    m1 = [1.0, 2.0, 3.0, 4.0, 5.0]
    m2 = [6.0, 7.0, 8.0, 9.0, 10.0]
    result = bv.mann_whitney(_groups(m1, m2))
    assert result["pValue"] == pytest.approx(ref["p_value"], rel=1e-6)


def test_r_reference_anova_welch_matches_r_oneway_test():
    ref = _R_REFERENCE["anova_welch_three_groups"]
    x1, x2, x3 = [1.0, 2.0, 3.0], [10.0, 11.0, 12.0], [20.0, 22.0, 24.0]
    result = bv.anova(_groups(x1, x2, x3))
    assert result["statistic"] == pytest.approx(ref["statistic"], rel=1e-6)
    assert result["pValue"] == pytest.approx(ref["p_value"], rel=1e-6)
    assert result["df"]["numerator"] == ref["df1"]
    assert result["df"]["denominator"] == pytest.approx(ref["df2"], rel=1e-6)


def test_r_reference_kruskal_wallis_matches_r_kruskal_test():
    ref = _R_REFERENCE["kruskal_wallis"]
    x1, x2, x3 = [1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]
    result = bv.kruskal_wallis(_groups(x1, x2, x3))
    assert result["statistic"] == pytest.approx(ref["statistic"], rel=1e-6)
    assert result["pValue"] == pytest.approx(ref["p_value"], rel=1e-6)


def test_r_reference_chi_square_matches_r_chisq_test():
    ref = _R_REFERENCE["chi_square_50_30_20_60"]
    table = [[50, 30], [20, 60]]
    result = bv.chi_square(table)
    assert result["statistic"] == pytest.approx(ref["statistic"], rel=1e-6)
    assert result["pValue"] == pytest.approx(ref["p_value"], rel=1e-6)
    assert result["df"] == ref["df"]


def test_r_reference_chi_square_low_expected_count_matches_r_chisq_test():
    # [[1,19],[19,61]] — 8차 계획 리뷰가 지목한 "주변합은 충분해도 내부 셀이 작은"
    # 반례와 같은 표. R의 chisq.test도 같은 표에서 같은 경고(근사 부정확)를 낸다.
    ref = _R_REFERENCE["chi_square_1_19_19_61"]
    table = [[1, 19], [19, 61]]
    result = bv.chi_square(table)
    assert result["statistic"] == pytest.approx(ref["statistic"], rel=1e-6)
    assert result["pValue"] == pytest.approx(ref["p_value"], rel=1e-6)


def test_r_reference_fisher_exact_pvalue_matches_r_fisher_test():
    ref = _R_REFERENCE["fisher_exact_10_5_3_12"]
    table = [[10, 5], [3, 12]]
    result = bv.fisher_exact(table)
    assert result["pValue"] == pytest.approx(ref["p_value"], rel=1e-6)


def test_r_reference_fisher_exact_zero_cell_pvalue_matches_r_fisher_test():
    ref = _R_REFERENCE["fisher_exact_0_10_10_10"]
    table = [[0, 10], [10, 10]]
    result = bv.fisher_exact(table)
    assert result["pValue"] == pytest.approx(ref["p_value"], rel=1e-6)


def test_r_reference_pearson_correlation_matches_r_cor_test():
    ref = _R_REFERENCE["pearson_correlation"]
    x = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
    y = [2.1, 3.9, 6.2, 7.8, 10.1, 11.9, 14.2, 15.8, 18.1, 19.9]
    result = bv.pearson_correlation(x, y)
    assert result["effectSizes"][0]["value"] == pytest.approx(ref["r"], rel=1e-6)
    assert result["pValue"] == pytest.approx(ref["p_value"], rel=1e-4)
    assert result["effectSizes"][0]["ci"][0] == pytest.approx(ref["ci_lower"], rel=1e-3)
    assert result["effectSizes"][0]["ci"][1] == pytest.approx(ref["ci_upper"], rel=1e-3)


def test_r_reference_spearman_correlation_matches_r_cor_test():
    ref = _R_REFERENCE["spearman_correlation"]
    x = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
    y = [2.0, 1.0, 4.0, 3.0, 6.0, 5.0, 8.0, 7.0, 10.0, 9.0]
    result = bv.spearman_correlation(x, y)
    assert result["effectSizes"][0]["value"] == pytest.approx(ref["rho"], rel=1e-6)
    assert result["pValue"] == pytest.approx(ref["p_value"], rel=1e-4)


# ---------------------------------------------------------------------------
# PR3-B — 그룹별 박스플롯(§5) + 상관 적합선(§7) 배선.
# ---------------------------------------------------------------------------

def test_group_boxplots_present_for_all_four_group_comparison_methods():
    groups = [
        {"label": "a", "values": [1.0, 2.0, 3.0, 4.0, 5.0]},
        {"label": "b", "values": [10.0, 11.0, 12.0, 13.0, 14.0]},
    ]
    for fn in (bv.welch_t, bv.mann_whitney):
        result = fn(groups)
        assert len(result["groupBoxplots"]) == 2
        assert result["groupBoxplots"][0]["label"] == "a"
        assert result["groupBoxplots"][0]["boxplot"]["q1"] is not None
        assert result["groupBoxplots"][1]["label"] == "b"

    three_groups = groups + [{"label": "c", "values": [20.0, 21.0, 22.0, 23.0, 24.0]}]
    for fn in (bv.anova, bv.kruskal_wallis):
        result = fn(three_groups)
        assert len(result["groupBoxplots"]) == 3


def test_group_boxplots_present_even_on_early_return_insufficient_data():
    # welch_t는 n1<2 또는 n2<2면 조기 반환 — 그 경로에서도 groupBoxplots가 있어야
    # 한다(계획서 §5 — Python은 disclosure와 무관하게 항상 정직하게 계산).
    groups = [
        {"label": "a", "values": [1.0]},  # n1=1 < 2
        {"label": "b", "values": [10.0, 11.0, 12.0]},
    ]
    result = bv.welch_t(groups)
    assert result["statistic"] is None
    assert len(result["groupBoxplots"]) == 2
    assert result["groupBoxplots"][0]["boxplot"] is not None  # n=1이어도 단일값 boxplot


def test_group_boxplot_matches_standalone_boxplot_computation():
    from boxplot import compute_boxplot
    from descriptive import compute_continuous

    values = [1.0, 2.0, 3.0, 4.0, 5.0, 100.0]
    groups = [
        {"label": "x", "values": values},
        {"label": "y", "values": [1.0, 2.0, 3.0]},
    ]
    result = bv.mann_whitney(groups)
    stat = compute_continuous(values)
    expected = compute_boxplot(values, stat["q1"], stat["median"], stat["q3"])
    assert result["groupBoxplots"][0]["boxplot"] == expected


def test_pearson_regression_line_slope_matches_manual_ols():
    x = [1.0, 2.0, 3.0, 4.0, 5.0]
    y = [2.1, 3.9, 6.2, 7.8, 10.1]
    result = bv.pearson_correlation(x, y)
    r = result["statistic"]
    import numpy as np
    sd_x, sd_y = float(np.std(x, ddof=1)), float(np.std(y, ddof=1))
    expected_slope = r * sd_y / sd_x
    assert result["regressionLine"]["slope"] == pytest.approx(expected_slope)
    expected_intercept = float(np.mean(y)) - expected_slope * float(np.mean(x))
    assert result["regressionLine"]["intercept"] == pytest.approx(expected_intercept)


def test_spearman_has_no_regression_line():
    x = [1.0, 2.0, 3.0, 4.0, 5.0]
    y = [5.0, 3.0, 1.0, 2.0, 4.0]
    result = bv.spearman_correlation(x, y)
    assert result["regressionLine"] is None


def test_pearson_regression_line_none_when_constant_variable():
    x = [1.0, 1.0, 1.0, 1.0]
    y = [1.0, 2.0, 3.0, 4.0]
    result = bv.pearson_correlation(x, y)
    assert result["statistic"] is None
    assert result["regressionLine"] is None
