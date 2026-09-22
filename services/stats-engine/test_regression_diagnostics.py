"""PR4-A2 — regression.py 진단(VIF·condition number·leverage 계열)·spline
부분효과·경량 limited_row 진단(compute_regression_diagnostics) 단위테스트.

핵심 검증 대상(3차 리뷰의 반례로 확정된 원칙): `_evaluate_diagnostic_support`는
estimation/inferenceWithheldReason 문자열을 절대 참고하지 않고 (X,y,β,h)만으로
직접 판정해야 한다 — se==0(DEGENERATE_COVARIANCE)이어도 h·MSE가 둘 다 건강할 수
있다(공분산 샌드위치 공식 자체의 대수적 퇴화, h·MSE와 무관한 원인).
"""
from __future__ import annotations

import math

import numpy as np
import pytest

import regression as reg


def _design(x1: list[float]) -> list[list[float]]:
    return [[1.0, v] for v in x1]


# ---------------------------------------------------------------------------
# _evaluate_diagnostic_support — 추론 상태와 완전히 독립된 직접 수치 검사
# ---------------------------------------------------------------------------

def test_diagnostic_support_healthy_ols():
    n = 40
    x1 = np.array([-1.0] * 10 + [0.0] * 20 + [1.0] * 10)
    x = np.column_stack([np.ones(n), x1])
    y = 5.0 + 2.0 * x1 + np.array([0.3, -0.2] * 20)
    beta = np.linalg.lstsq(x, y, rcond=None)[0]
    _, h = reg._bread_and_hat(x, np.ones(n))
    supported, reason = reg._evaluate_diagnostic_support(x, y, beta, "gaussian", h)
    assert supported is True
    assert reason is None


def test_diagnostic_support_h_none_means_qr_failed():
    x = np.array(_design([-1.0, 0.0, 1.0]))
    y = np.array([1.0, 2.0, 3.0])
    beta = np.array([2.0, 1.0])
    supported, reason = reg._evaluate_diagnostic_support(x, y, beta, "gaussian", None)
    assert supported is False
    assert reason == "QR_DECOMPOSITION_FAILED"


def test_diagnostic_support_near_singular_leverage():
    # 검산(계획서 §3, 계획 문서 리뷰 #11과 동일 반례) — continuous predictor가
    # 40명 중 39명 0, 1명 1이면 마지막 관측의 leverage가 정확히 1이다.
    n = 40
    x1 = np.array([0.0] * 39 + [1.0])
    x = np.column_stack([np.ones(n), x1])
    y = np.zeros(n)
    y[-1] = 1.0
    beta = np.array([0.0, 1.0])
    _, h = reg._bread_and_hat(x, np.ones(n))
    assert h[-1] == pytest.approx(1.0, abs=1e-9)
    supported, reason = reg._evaluate_diagnostic_support(x, y, beta, "gaussian", h)
    assert supported is False
    assert reason == "NEAR_SINGULAR_LEVERAGE"


def test_diagnostic_support_ols_perfect_fit_is_invalid_scale():
    n = 20
    x1 = np.array([float(i) for i in range(n)])
    x = np.column_stack([np.ones(n), x1])
    beta = np.array([1.0, 2.0])
    y = x @ beta  # 완전적합 — 잔차 0
    _, h = reg._bread_and_hat(x, np.ones(n))
    supported, reason = reg._evaluate_diagnostic_support(x, y, beta, "gaussian", h)
    assert supported is False
    assert reason == "INVALID_DIAGNOSTIC_SCALE"


def test_diagnostic_support_logistic_extreme_linear_predictor_is_invalid_scale():
    # 4차 리뷰로 정정된 반례 — 분리가 없어도 개별 관측치의 선형예측자가 크면
    # mu→1.0, w=mu(1-mu)→0.0이 된다("비분리·수렴이면 안 붙는다"는 처음 가정이
    # 틀렸음을 실측으로 확인한 사례를 그대로 고정). predictor를 고르게 펼쳐
    # (linspace) leverage가 한 점에 쏠리지 않게 하면(최대 h≈0.59) NEAR_SINGULAR_
    # LEVERAGE가 아니라 순수하게 w=0(denom=0)만으로 INVALID_DIAGNOSTIC_SCALE이
    # 걸리는 경로를 분리해서 확인할 수 있다 — h 계산 자체는 성공한다.
    n = 40
    x1 = np.linspace(-1, 1, n)
    x = np.column_stack([np.ones(n), x1])
    beta = np.array([0.0, 45.0])
    linear_predictor = x @ beta
    mu = 1.0 / (1.0 + np.exp(-linear_predictor))
    w = mu * (1 - mu)
    assert np.any(w == 0.0)  # 전제 확인 — 일부 관측치의 w가 정확히 0으로 언더플로
    y = (mu > 0.5).astype(float)
    bread, h = reg._bread_and_hat(x, w)  # h 계산 자체는 성공(leverage가 안 쏠림)
    assert h.max() < 0.9
    supported, reason = reg._evaluate_diagnostic_support(x, y, beta, "binomial", h)
    assert supported is False
    assert reason == "INVALID_DIAGNOSTIC_SCALE"


def test_diagnostic_support_logistic_single_outlier_predictor_is_near_singular_leverage_not_scale():
    # 대조 사례 — "40명 중 39명 0, 1명 1"인 단일 이상치 predictor 구조는 가중치와
    # 무관하게 leverage 자체가 그 관측치에 쏠려 h_ii→1이 된다(OLS와 동일 기하
    # 구조). w가 매우 작아도(w_last≈9e-14로 0은 아님) NEAR_SINGULAR_LEVERAGE가
    # INVALID_DIAGNOSTIC_SCALE보다 먼저 걸린다는 것을 실측으로 고정 — 두 사유가
    # 서로 다른 원인(leverage 기하 구조 vs 가중치 언더플로)임을 구분한다.
    n = 40
    x1 = np.array([0.0] * 39 + [1.0])
    x = np.column_stack([np.ones(n), x1 * 30.0])
    y = np.array([0.0] * 39 + [1.0])
    beta = np.array([0.0, 1.0])
    linear_predictor = x @ beta
    mu = 1.0 / (1.0 + np.exp(-linear_predictor))
    w = mu * (1 - mu)
    bread, h = reg._bread_and_hat(x, w)
    assert h[-1] == pytest.approx(1.0, abs=1e-9)
    supported, reason = reg._evaluate_diagnostic_support(x, y, beta, "binomial", h)
    assert supported is False
    assert reason == "NEAR_SINGULAR_LEVERAGE"


def test_diagnostic_support_healthy_logistic():
    n = 40
    x1 = np.linspace(-3, 3, n)
    x = np.column_stack([np.ones(n), x1])
    beta = np.array([0.0, 1.0])
    linear_predictor = x @ beta
    mu = 1.0 / (1.0 + np.exp(-linear_predictor))
    y = (mu > 0.5).astype(float)
    _, h = reg._bread_and_hat(x, mu * (1 - mu))
    supported, reason = reg._evaluate_diagnostic_support(x, y, beta, "binomial", h)
    assert supported is True
    assert reason is None


# ---------------------------------------------------------------------------
# _compute_vif — 절편 제외 열별 VIF(설계행렬 열별, GVIF 아님)
# ---------------------------------------------------------------------------

def test_compute_vif_independent_columns_near_one():
    rng = np.random.default_rng(0)
    n = 200
    x1 = rng.normal(size=n)
    x2 = rng.normal(size=n)
    x = np.column_stack([np.ones(n), x1, x2])
    vifs = reg._compute_vif(x)
    assert len(vifs) == 2
    for v in vifs:
        assert v is not None
        assert v == pytest.approx(1.0, abs=0.2)


def test_compute_vif_collinear_columns_are_large():
    rng = np.random.default_rng(1)
    n = 200
    x1 = rng.normal(size=n)
    x2 = x1 + rng.normal(scale=0.01, size=n)  # x1과 거의 동일(강한 공선성)
    x = np.column_stack([np.ones(n), x1, x2])
    vifs = reg._compute_vif(x)
    assert len(vifs) == 2
    assert all(v is not None and v > 50 for v in vifs)


def test_compute_vif_isolates_individual_column_failure():
    # 한 열이 계산 불가(R²→1에 근접)여도 다른 열은 정상 값을 낸다(개별 실패 격리).
    rng = np.random.default_rng(2)
    n = 100
    x1 = rng.normal(size=n)
    x2 = x1 * 2.0  # 절편과 함께면 x1의 완전 선형결합에 아주 가까움
    x3 = rng.normal(size=n)
    x = np.column_stack([np.ones(n), x1, x2, x3])
    vifs = reg._compute_vif(x)
    assert len(vifs) == 3
    # x3(독립)는 항상 정상 값이어야 한다 — x1/x2 열의 실패가 전파되지 않는다.
    assert vifs[2] is not None
    assert vifs[2] == pytest.approx(1.0, abs=0.3)


# ---------------------------------------------------------------------------
# compute_regression — diagnostics/splinePartialEffects 상태 불변식
# ---------------------------------------------------------------------------

def test_ok_result_has_diagnostics_and_empty_spline_effects_when_no_contrasts():
    x1 = [-2.3, -1.1, 0.0, 1.1, 2.3] * 8
    y = [1.0 + 2.0 * v + (0.1 if i % 2 == 0 else -0.1) for i, v in enumerate(x1)]
    result = reg.compute_regression("gaussian", y, _design(x1), ["intercept", "x1"], {"type": "hc3"})
    assert result["estimation"] == "ok"
    assert result["diagnostics"] is not None
    assert result["diagnostics"]["pointDiagnosticsSupported"] is True
    assert result["splinePartialEffects"] == []


def test_non_estimable_result_has_null_diagnostics_and_spline_effects():
    # 완전분리 — SEPARATION_DETECTED로 종료(β 자체가 없다).
    x1 = list(range(40))
    y = [0.0 if v < 20 else 1.0 for v in x1]
    result = reg.compute_regression("binomial", y, _design(x1), ["intercept", "x1"], {"type": "hc3"})
    assert result["estimation"] == "non_estimable"
    assert result["diagnostics"] is None
    assert result["splinePartialEffects"] is None


def test_withheld_result_still_has_diagnostics_computed_directly():
    # leverage≈1 반례를 최초 적합 경로 전체로 통과시켜 _withheld()가 실제로
    # diagnostics를 채우는지 확인한다(계획서 §3 "_withheld() 재구성").
    n = 40
    x1 = [0.0] * 39 + [1.0]
    y = [0.0] * 39 + [10.0]
    result = reg.compute_regression("gaussian", y, _design(x1), ["intercept", "x1"], {"type": "hc3"})
    assert result["estimation"] == "inference_withheld"
    assert result["diagnostics"] is not None
    assert result["diagnostics"]["pointDiagnosticsSupported"] is False
    assert result["diagnostics"]["pointDiagnosticsUnsupportedReason"] == "NEAR_SINGULAR_LEVERAGE"
    # VIF/condition number는 h와 무관해 그래도 계산된다.
    assert result["diagnostics"]["vif"][0] is not None


# ---------------------------------------------------------------------------
# splineContrasts — Node가 만든 대비행렬을 받아 delta/CI 계산(Python은 spline을 모른다)
# ---------------------------------------------------------------------------

def test_spline_contrast_reproduces_term_coefficient_difference():
    # 대비 [0,1]은 그냥 x1의 계수 자체와 같다 — delta = contrast @ beta = beta[1].
    x1 = _X1_A = [-2.3, -1.1, 0.0, 1.1, 2.3] * 8
    y = [1.0 + 2.0 * v + (0.1 if i % 2 == 0 else -0.1) for i, v in enumerate(x1)]
    contrasts = [{"variableKey": "x1", "contrastMatrix": [[0.0, 0.0], [0.0, 1.0]]}]
    result = reg.compute_regression(
        "gaussian", y, _design(x1), ["intercept", "x1"], {"type": "hc3"}, contrasts,
    )
    assert result["estimation"] == "ok"
    x1_term = result["terms"][1]
    effect = result["splinePartialEffects"][0]
    assert effect["variableKey"] == "x1"
    assert effect["points"][0]["deltaFromBaseline"] == pytest.approx(0.0)
    assert effect["points"][1]["deltaFromBaseline"] == pytest.approx(x1_term["estimate"], rel=1e-9)
    # CI도 계수 자체의 CI와 일치해야 한다(같은 분산 계산 경로 재사용).
    assert effect["points"][1]["ciLower"] == pytest.approx(x1_term["ciLower"], rel=1e-6)
    assert effect["points"][1]["ciUpper"] == pytest.approx(x1_term["ciUpper"], rel=1e-6)


def test_spline_contrast_ci_null_when_inference_withheld():
    n = 40
    x1 = [0.0] * 39 + [1.0]
    y = [0.0] * 39 + [10.0]
    contrasts = [{"variableKey": "x1", "contrastMatrix": [[0.0, 0.0], [0.0, 1.0]]}]
    result = reg.compute_regression(
        "gaussian", y, _design(x1), ["intercept", "x1"], {"type": "hc3"}, contrasts,
    )
    assert result["estimation"] == "inference_withheld"
    effect = result["splinePartialEffects"][0]
    for point in effect["points"]:
        assert point["ciLower"] is None
        assert point["ciUpper"] is None
    # delta 자체는 유한하면 유지된다(β는 유효 — 공분산만 없음).
    assert math.isfinite(effect["points"][1]["deltaFromBaseline"])


# ---------------------------------------------------------------------------
# compute_regression_diagnostics — 경량 limited_row 진단(재적합 없음)
# ---------------------------------------------------------------------------

def test_compute_regression_diagnostics_matches_main_fit_values():
    x1 = [-2.3, -1.1, 0.0, 1.1, 2.3] * 8
    n = len(x1)
    y = [1.0 + 2.0 * v + (0.1 if i % 2 == 0 else -0.1) for i, v in enumerate(x1)]
    main = reg.compute_regression("gaussian", y, _design(x1), ["intercept", "x1"], {"type": "hc3"})
    beta = [t["estimate"] for t in main["terms"]]

    sampled = [0, 5, 10, n - 1]
    diag = reg.compute_regression_diagnostics("gaussian", y, _design(x1), beta, sampled)
    assert diag["pointDiagnosticsSupported"] is True
    assert [p["rowIndex"] for p in diag["points"]] == sampled

    x = np.array(_design(x1))
    beta_arr = np.array(beta)
    yhat = x @ beta_arr
    for p in diag["points"]:
        i = p["rowIndex"]
        assert p["fittedValue"] == pytest.approx(yhat[i], rel=1e-9)
        assert p["residual"] == pytest.approx(y[i] - yhat[i], rel=1e-9, abs=1e-9)


def test_compute_regression_diagnostics_unsupported_matches_main_fit():
    n = 40
    x1 = [0.0] * 39 + [1.0]
    y = [0.0] * 39 + [10.0]
    main = reg.compute_regression("gaussian", y, _design(x1), ["intercept", "x1"], {"type": "hc3"})
    beta = [t["estimate"] for t in main["terms"]]
    diag = reg.compute_regression_diagnostics("gaussian", y, _design(x1), beta, [0, 1])
    assert diag["pointDiagnosticsSupported"] is False
    assert diag["pointDiagnosticsUnsupportedReason"] == main["diagnostics"]["pointDiagnosticsUnsupportedReason"]
    assert diag["points"] == []


def test_compute_regression_diagnostics_theoretical_quantile_uses_full_rank_not_sample():
    # Q-Q 분위수는 전체 N행 기준 순위로 계산돼야 한다(샘플링 이후 재계산 금지) —
    # 표본을 다르게 골라도 같은 행의 theoreticalQuantile은 동일해야 한다.
    x1 = [-2.3, -1.1, 0.0, 1.1, 2.3] * 8
    y = [1.0 + 2.0 * v + (0.1 if i % 2 == 0 else -0.1) for i, v in enumerate(x1)]
    main = reg.compute_regression("gaussian", y, _design(x1), ["intercept", "x1"], {"type": "hc3"})
    beta = [t["estimate"] for t in main["terms"]]

    diag_all = reg.compute_regression_diagnostics("gaussian", y, _design(x1), beta, list(range(len(x1))))
    diag_partial = reg.compute_regression_diagnostics("gaussian", y, _design(x1), beta, [3])

    q_all = next(p["theoreticalQuantile"] for p in diag_all["points"] if p["rowIndex"] == 3)
    q_partial = diag_partial["points"][0]["theoreticalQuantile"]
    assert q_all == pytest.approx(q_partial, rel=1e-12)
