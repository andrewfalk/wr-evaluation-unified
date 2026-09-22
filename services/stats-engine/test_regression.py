"""regression.py 단위테스트.

R 참조값 대조는 2026-09-21에 Docker r-base:latest(R 4.6.1 "Happy Hop") +
sandwich 3.1.3 + lmtest 0.9.40으로 실제 실행해 완료했다(bivariate.py가
test_bivariate.py에서 쓴 방식과 동일 —
`fixtures/generate_r_reference_regression.R` 실행 결과가
`fixtures/r_reference_values_regression.json`). 로지스틱 HC3는 **R만 정답이다**
— statsmodels 0.14.2의 `Logit.fit(cov_type='HC3')`는 결과 클래스에 cov_HC3가
없어 실제로는 HC0를 계산하므로(requirements.txt 주석), 자체 계산값을
statsmodels와 대조하는 방식은 로지스틱에 쓰지 않는다. OLS HC3만 statsmodels도
정상 동작하므로 교차검증에 쓴다.

이 파일은:
  1) OLS HC3를 자체 계산값과 statsmodels 값 양쪽으로 교차검증
  2) `test_r_reference_*`: R 실행 결과와 직접 대조(OLS+HC3/OLS+CR1/로지스틱+HC3/
     로지스틱+CR1 4조합 전부, rtol/atol 허용오차)
  3) 계획서가 실측으로 잡은 반례를 회귀 테스트로 고정 — LP 분리판정 margin-0
     오분류(리뷰 #10), leverage=1 함정(리뷰 #11), 완전적합 부동소수점 경로
     의존성과 배율 불변성(리뷰 #16/#19/#21), OLS-CR1 df 버그(family 분기가
     covariance 분기보다 먼저라 항상 N-P를 쓰던 실제 구현 버그, 스모크
     테스트로 발견·수정)
  4) 항등식 — HC3 경로에서는 "2군 OLS ≡ 등분산 t"가 성립하지 않는다는 것 자체를
     검증(리뷰 #6, 초안의 잘못된 검증 항등식을 반증으로 고정)
운영 고정버전(numpy==1.26.4/scipy==1.13.0/statsmodels==0.14.2) 자체의 Docker
pytest 검증은 별도 게이트(README 참고)로 수행한다 — 이 로컬 실행은
numpy 2.5.3/scipy 1.18.1/statsmodels 0.15.0(Python 3.14, 이 머신엔 3.11/3.12가
없어 0.14.2 wheel을 못 받음)으로 했다.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest
import statsmodels.api as sm
from scipy import stats as scipy_stats

import regression as reg

_R_REFERENCE = json.loads(
    (Path(__file__).parent / "fixtures" / "r_reference_values_regression.json").read_text(encoding="utf-8")
)

# R 스크립트와 정확히 동일한 리터럴(fixtures/generate_r_reference_regression.R 참고).
_X1_A = [-2.3, -2.1, -1.9, -1.7, -1.5, -1.3, -1.1, -0.9, -0.7, -0.5, -0.3, -0.1, 0.1, 0.3, 0.5, 0.7, 0.9, 1.1, 1.3, 1.5, 1.7, 1.9, 2.1, 2.3]
_Y_A = [-2.56, -1.89, -1.22, -0.55, 0.12, 0.79, 1.46, -0.46, 0.21, 0.88, 1.55, 2.22, 2.89, 3.56, 1.64, 2.31, 2.98, 3.65, 4.32, 4.99, 5.66, 3.74, 4.41, 5.08]

_X1_B = [-3.3, -2.3, -1.3, -0.3, -3, -2, -1, 0, -2.7, -1.7, -0.7, 0.3, -2.4, -1.4, -0.4, 0.6, -2.1, -1.1, -0.1, 0.9, -1.8, -0.8, 0.2, 1.2, -1.5, -0.5, 0.5, 1.5, -1.2, -0.2, 0.8, 1.8, -0.9, 0.1, 1.1, 2.1, -0.6, 0.4, 1.4, 2.4, -0.3, 0.7, 1.7, 2.7, 0, 1, 2, 3]
_Y_B = [-7.8, -5.35, -2.9, -1.8, -5.95, -3.5, -2.4, 0.05, -4.1, -3, -0.55, 1.9, -3.6, -1.15, 1.3, 2.4, -1.75, 0.7, 1.8, 4.25, -3.9, -2.8, -0.35, 2.1, -3.4, -0.95, 1.5, 2.6, -1.55, 0.9, 2, 4.45, 0.3, 1.4, 3.85, 6.3, 0.8, 3.25, 5.7, 6.8, -1.35, 1.1, 2.2, 4.65, 0.5, 1.6, 4.05, 6.5]
_CLUSTER_B = [f"g{i // 4}" for i in range(48)]

_X1_C = [-3, -2.8983, -2.7966, -2.6949, -2.5932, -2.4915, -2.3898, -2.2881, -2.1864, -2.0847, -1.9831, -1.8814, -1.7797, -1.678, -1.5763, -1.4746, -1.3729, -1.2712, -1.1695, -1.0678, -0.9661, -0.8644, -0.7627, -0.661, -0.5593, -0.4576, -0.3559, -0.2542, -0.1525, -0.0508, 0.0508, 0.1525, 0.2542, 0.3559, 0.4576, 0.5593, 0.661, 0.7627, 0.8644, 0.9661, 1.0678, 1.1695, 1.2712, 1.3729, 1.4746, 1.5763, 1.678, 1.7797, 1.8814, 1.9831, 2.0847, 2.1864, 2.2881, 2.3898, 2.4915, 2.5932, 2.6949, 2.7966, 2.8983, 3]
_Y_C = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]

_X1_D = [-2.55, -1.85, -1.15, -0.45, -2.4, -1.7, -1, -0.3, -2.25, -1.55, -0.85, -0.15, -2.1, -1.4, -0.7, -0, -1.95, -1.25, -0.55, 0.15, -1.8, -1.1, -0.4, 0.3, -1.65, -0.95, -0.25, 0.45, -1.5, -0.8, -0.1, 0.6, -1.35, -0.65, 0.05, 0.75, -1.2, -0.5, 0.2, 0.9, -1.05, -0.35, 0.35, 1.05, -0.9, -0.2, 0.5, 1.2, -0.75, -0.05, 0.65, 1.35, -0.6, 0.1, 0.8, 1.5, -0.45, 0.25, 0.95, 1.65, -0.3, 0.4, 1.1, 1.8, -0.15, 0.55, 1.25, 1.95, 0, 0.7, 1.4, 2.1, 0.15, 0.85, 1.55, 2.25, 0.3, 1, 1.7, 2.4]
_Y_D = [0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1]
_CLUSTER_D = [f"g{i // 4}" for i in range(80)]


def _design(x1: list[float]) -> list[list[float]]:
    return [[1.0, v] for v in x1]


# ---------------------------------------------------------------------------
# OLS HC3 — 자체계산 vs statsmodels 교차검증
# ---------------------------------------------------------------------------

def test_ols_hc3_matches_statsmodels():
    x = np.array(_design(_X1_A))
    y = np.array(_Y_A)
    result = reg.compute_regression("gaussian", _Y_A, _design(_X1_A), ["intercept", "x1"], {"type": "hc3"})
    assert result["estimation"] == "ok"

    sm_fit = sm.OLS(y, x).fit(cov_type="HC3")
    for i in range(2):
        assert result["terms"][i]["estimate"] == pytest.approx(sm_fit.params[i], rel=1e-9)
        assert result["terms"][i]["se"] == pytest.approx(sm_fit.bse[i], rel=1e-6)


# ---------------------------------------------------------------------------
# R 대조 — 4조합
# ---------------------------------------------------------------------------

def test_r_reference_ols_hc3():
    ref = _R_REFERENCE["ols_hc3"]
    result = reg.compute_regression("gaussian", _Y_A, _design(_X1_A), ["intercept", "x1"], {"type": "hc3"})
    assert result["estimation"] == "ok"
    assert result["inferenceDistribution"] == "t"
    assert result["inferenceDf"] == pytest.approx(len(_Y_A) - 2)
    intercept, x1 = result["terms"]
    assert intercept["estimate"] == pytest.approx(ref["intercept_estimate"], rel=1e-6)
    assert intercept["se"] == pytest.approx(ref["intercept_se"], rel=1e-4)
    assert x1["estimate"] == pytest.approx(ref["x1_estimate"], rel=1e-6)
    assert x1["se"] == pytest.approx(ref["x1_se"], rel=1e-4)
    assert x1["statistic"] == pytest.approx(ref["x1_statistic"], rel=1e-4)
    assert x1["pValue"] == pytest.approx(ref["x1_p"], rel=1e-3, abs=1e-12)


def test_r_reference_ols_cr1():
    ref = _R_REFERENCE["ols_cr1"]
    result = reg.compute_regression(
        "gaussian", _Y_B, _design(_X1_B), ["intercept", "x1"], {"type": "cluster", "groups": _CLUSTER_B},
    )
    assert result["estimation"] == "ok"
    assert result["inferenceDistribution"] == "t"
    assert result["clusterCount"] == 12
    assert result["inferenceDf"] == pytest.approx(11)  # G-1
    intercept, x1 = result["terms"]
    assert intercept["estimate"] == pytest.approx(ref["intercept_estimate"], rel=1e-6)
    assert intercept["se"] == pytest.approx(ref["intercept_se"], rel=1e-4)
    assert x1["estimate"] == pytest.approx(ref["x1_estimate"], rel=1e-6)
    assert x1["se"] == pytest.approx(ref["x1_se"], rel=1e-4)
    assert x1["statistic"] == pytest.approx(ref["x1_statistic"], rel=1e-4)
    assert x1["pValue"] == pytest.approx(ref["x1_p"], rel=1e-3, abs=1e-10)


def test_r_reference_logistic_hc3():
    # 로지스틱 HC3는 R만 정답이다(statsmodels 0.14.2는 실제로 HC0를 계산) —
    # 이 테스트가 그 대조의 전부다.
    ref = _R_REFERENCE["logistic_hc3"]
    result = reg.compute_regression("binomial", _Y_C, _design(_X1_C), ["intercept", "x1"], {"type": "hc3"})
    assert result["estimation"] == "ok"
    assert result["inferenceDistribution"] == "normal"
    assert result["inferenceDf"] is None
    intercept, x1 = result["terms"]
    assert intercept["estimate"] == pytest.approx(ref["intercept_estimate"], rel=1e-5)
    assert intercept["se"] == pytest.approx(ref["intercept_se"], rel=1e-3)
    assert x1["estimate"] == pytest.approx(ref["x1_estimate"], rel=1e-5)
    assert x1["se"] == pytest.approx(ref["x1_se"], rel=1e-3)
    assert x1["statistic"] == pytest.approx(ref["x1_statistic"], rel=1e-3)
    assert x1["pValue"] == pytest.approx(ref["x1_p"], rel=1e-2, abs=1e-6)
    assert result["fit"]["logLik"] == pytest.approx(ref["logLik"], rel=1e-6)
    assert result["fit"]["aic"] == pytest.approx(ref["aic"], rel=1e-6)


def test_r_reference_logistic_cr1():
    ref = _R_REFERENCE["logistic_cr1"]
    result = reg.compute_regression(
        "binomial", _Y_D, _design(_X1_D), ["intercept", "x1"], {"type": "cluster", "groups": _CLUSTER_D},
    )
    assert result["estimation"] == "ok"
    assert result["inferenceDistribution"] == "t"
    assert result["clusterCount"] == 20
    assert result["inferenceDf"] == pytest.approx(19)
    intercept, x1 = result["terms"]
    assert intercept["estimate"] == pytest.approx(ref["intercept_estimate"], rel=1e-5)
    assert intercept["se"] == pytest.approx(ref["intercept_se"], rel=1e-3)
    assert x1["estimate"] == pytest.approx(ref["x1_estimate"], rel=1e-5)
    assert x1["se"] == pytest.approx(ref["x1_se"], rel=1e-3)
    assert x1["statistic"] == pytest.approx(ref["x1_statistic"], rel=1e-3)
    assert x1["pValue"] == pytest.approx(ref["x1_p"], rel=1e-2, abs=1e-6)
    assert result["fit"]["logLik"] == pytest.approx(ref["logLik"], rel=1e-6)
    assert result["fit"]["aic"] == pytest.approx(ref["aic"], rel=1e-6)


# ---------------------------------------------------------------------------
# 항등식(리뷰 #6) — HC3 경로에서는 "2군 OLS ≡ 등분산 t"가 성립하지 않는다
# ---------------------------------------------------------------------------

def test_two_group_ols_coefficient_equals_mean_difference_regardless_of_covariance():
    """계수 자체(평균차)는 covariance 계산법과 무관하게 항상 성립한다 —
    이 부분은 리뷰 이전에도 맞았던 유일한 조각이라 유지한다."""
    group0 = [4.0, 5.0, 6.0, 5.0, 7.0, 6.0]
    group1 = [8.0, 9.0, 7.0, 10.0, 9.0, 8.0, 11.0]
    y = group0 + group1
    x1 = [0.0] * len(group0) + [1.0] * len(group1)
    result = reg.compute_regression("gaussian", y, _design(x1), ["intercept", "group"], {"type": "hc3"})
    mean_diff = np.mean(group1) - np.mean(group0)
    assert result["terms"][1]["estimate"] == pytest.approx(mean_diff, rel=1e-9)


def test_hc3_se_differs_from_equal_variance_se_for_two_group_ols():
    """리뷰 #6 — 초안은 "2군 OLS ≡ 등분산 t"를 HC3 경로에도 적용하는 항등식으로
    잘못 검증했다. 계수(평균차) 자체는 covariance와 무관하게 같지만, SE는
    covariance 계산법에 따라 실제로 달라진다는 성질만 검증한다 — 정확한 수치는
    리뷰가 어떤 데이터로 냈는지 이 세션에서 재현할 근거가 없어 단언하지 않는다
    (리뷰가 제시한 1.87083/1.91943은 이분산 표본에서의 예시 수치이지, 특정
    데이터셋을 못박은 게 아니다). 이분산이 뚜렷한 두 그룹(분산이 크게 다름)을
    써서 등분산 가정 SE와 HC3 SE가 실제로 달라지는지만 확인한다."""
    group0 = [10.0, 10.1, 9.9, 10.05, 9.95]  # 분산 거의 0
    group1 = [5.0, 25.0, -10.0, 40.0, 0.0]  # 분산 큼
    y = group0 + group1
    x1 = [0.0] * len(group0) + [1.0] * len(group1)

    result = reg.compute_regression("gaussian", y, _design(x1), ["intercept", "group"], {"type": "hc3"})
    hc3_se = result["terms"][1]["se"]

    # 등분산(OLS 표준) SE는 statsmodels 기본 cov_type로 계산 — HC3와 달라야 한다.
    x = np.array(_design(x1))
    sm_default = sm.OLS(np.array(y), x).fit()  # 등분산 가정(기본 nonrobust)
    equal_var_se = float(sm_default.bse[1])

    assert hc3_se != pytest.approx(equal_var_se, rel=1e-3)
    # 계수(평균차) 자체는 covariance 무관 — 항등식으로 유지되는 부분은 그대로 성립.
    assert result["terms"][1]["estimate"] == pytest.approx(np.mean(group1) - np.mean(group0), rel=1e-9)


# ---------------------------------------------------------------------------
# 분리 판정 — LP 반례(리뷰 #10)
# ---------------------------------------------------------------------------

def test_lp_separation_counterexample_from_review():
    """계획 리뷰 #10 반례 — margin-0 기준으로 "준완전분리"로 오분류됐던 입력.
    A1은 완전/준완전을 구분하지 않고 SEPARATION_DETECTED 하나로 수렴시킨다."""
    x1 = [-100.0, -1.0, 1.0, 2.0, 3.0] * 10  # 각 조합 10명(소수셀 방어)
    y = [0.0, 0.0, 1.0, 1.0, 1.0] * 10
    result = reg.compute_regression("binomial", y, _design(x1), ["intercept", "x1"], {"type": "hc3"})
    assert result["estimation"] == "non_estimable"
    assert result["nonEstimableReason"] == "SEPARATION_DETECTED"
    assert result["terms"] == []
    assert result["fit"] is None


def test_lp_separation_unit_invariance():
    """단위(predictor 스케일)를 바꿔도 분리 판정이 뒤집히지 않는다 — 리뷰 #4가
    지적한 |β|>20 같은 단위 의존 휴리스틱을 LP로 대체한 이유를 실측으로 고정."""
    x1_scaled = [v * 100 for v in ([-100.0, -1.0, 1.0, 2.0, 3.0] * 10)]
    y = [0.0, 0.0, 1.0, 1.0, 1.0] * 10
    result = reg.compute_regression("binomial", y, _design(x1_scaled), ["intercept", "x1"], {"type": "hc3"})
    assert result["estimation"] == "non_estimable"
    assert result["nonEstimableReason"] == "SEPARATION_DETECTED"


def test_normal_data_with_large_coefficient_not_misclassified_as_separated():
    """리뷰 #4 — predictor가 0/0.01이고 사건비율 25%/75%면 분리가 없어도 계수가
    약 219.72로 크다. |β|>20 같은 휴리스틱이면 이 정상 모형을 분리로 오판한다.
    LP 기반 판정은 이 사례를 분리로 잘못 잡지 않아야 한다."""
    x1 = [0.0] * 40 + [0.01] * 40
    # 0.0 그룹: 25% 사건, 0.01 그룹: 75% 사건(완전분리 아님 — 각 그룹에 event/non-event 섞임)
    y = [1.0] * 10 + [0.0] * 30 + [1.0] * 30 + [0.0] * 10
    result = reg.compute_regression("binomial", y, _design(x1), ["intercept", "x1"], {"type": "hc3"})
    assert result["estimation"] != "non_estimable"


# ---------------------------------------------------------------------------
# leverage 함정(리뷰 #11)
# ---------------------------------------------------------------------------

def test_leverage_one_triggers_covariance_not_computable():
    """full rank·충분한 residual df에서도 h_ii=1이 나올 수 있다(검산: 40명 중
    39명 predictor=0, 1명 predictor=1 → rank=2, df=38, 마지막 관측 leverage=1).
    비유한 값 검사만으로는 이 상황을 못 잡는다 — 별도 leverage 검사가 필요."""
    x1 = [0.0] * 39 + [1.0]
    y = [float(i % 5) for i in range(40)]
    result = reg.compute_regression("gaussian", y, _design(x1), ["intercept", "x1"], {"type": "hc3"})
    assert result["estimation"] == "inference_withheld"
    assert result["inferenceIssue"] == "COVARIANCE_NOT_COMPUTABLE"
    assert all(t["se"] is None for t in result["terms"])
    assert all(t["estimate"] is not None for t in result["terms"])  # 계수는 유지


# ---------------------------------------------------------------------------
# 완전적합(리뷰 #16/#19/#21)
# ---------------------------------------------------------------------------

def test_perfect_fit_ols_is_degenerate_regardless_of_solve_path():
    """se===0(정규방정식 경로)과 se≈7e-17(lstsq류 경로)이 같은 상태를 내야
    한다 — 상대 잔차 기준(‖e‖₂/‖y-ȳ‖₂)이 부동소수점 잡음에 좌우되지 않는지 확인.
    regression.py는 QR 경로 하나로 고정돼 있으므로, 이 테스트는 그 고정 경로가
    실제로 완전적합을 degenerate로 잡는지를 검증한다."""
    x1 = [-1.0] * 20 + [1.0] * 20
    y = list(x1)  # y = x, 완전적합
    result = reg.compute_regression("gaussian", y, _design(x1), ["intercept", "x1"], {"type": "hc3"})
    assert result["estimation"] == "inference_withheld"
    assert result["inferenceIssue"] == "DEGENERATE_COVARIANCE"
    assert all(t["se"] is None for t in result["terms"])
    assert result["terms"][1]["estimate"] == pytest.approx(1.0, abs=1e-6)


@pytest.mark.parametrize("scale", [1.0, 1000.0, 1e-12])
def test_perfect_fit_stays_degenerate_across_outcome_scale(scale):
    """리뷰 #21 — 완전적합 판정 분모에 바닥값을 두면 outcome 배율을 줄이는 것만
    으로 판정이 뒤집힌다. 무차원 비율만 쓰면 배율과 무관하게 판정이 유지된다."""
    x1 = [-1.0] * 20 + [1.0] * 20
    y = [v * scale for v in x1]
    result = reg.compute_regression("gaussian", y, _design(x1), ["intercept", "x1"], {"type": "hc3"})
    assert result["estimation"] == "inference_withheld"
    assert result["inferenceIssue"] == "DEGENERATE_COVARIANCE"


@pytest.mark.parametrize("scale", [1.0, 1000.0, 1e-12])
def test_noisy_normal_model_stays_ok_across_outcome_scale(scale):
    """리뷰 #21 — 잡음이 있는 정상 모형은 outcome 배율을 바꿔도 계속 통과해야
    한다(분모 바닥값이 되살아나면 극단적 배율에서 이 테스트가 깨진다)."""
    result = reg.compute_regression(
        "gaussian", [v * scale for v in _Y_A], _design(_X1_A), ["intercept", "x1"], {"type": "hc3"},
    )
    assert result["estimation"] == "ok"


# ---------------------------------------------------------------------------
# 비수렴 / 분리 solver 실패는 별도 상태
# ---------------------------------------------------------------------------

def test_separation_check_failed_is_distinct_from_separation_detected(monkeypatch):
    """solver 실패를 '분리 없음'으로 흘리지 않는다 — SEPARATION_CHECK_FAILED로
    보수적으로 차단하고, 정상 판정(SEPARATION_DETECTED)과 사유가 다름을 확인."""
    import scipy.optimize as sp_opt

    def _raise(*args, **kwargs):
        raise RuntimeError("simulated solver failure")

    monkeypatch.setattr(reg, "linprog", _raise)
    x1 = [float(i) for i in range(40)]
    y = [float(i % 2) for i in range(40)]
    result = reg.compute_regression("binomial", y, _design(x1), ["intercept", "x1"], {"type": "hc3"})
    assert result["estimation"] == "non_estimable"
    assert result["nonEstimableReason"] == "SEPARATION_CHECK_FAILED"
