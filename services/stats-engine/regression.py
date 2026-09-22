"""연관성 회귀(OLS·이분 로지스틱) — PR4-A1 계획서(pr4-a-lexical-reddy.md) §3
"Python 회귀 엔진" 구현.

Node가 완전사례(결측 없음)로 걸러진 설계행렬(y, X — 더미 인코딩·절편 포함 완료,
columnNames)을 만들어 보내고, 이 모듈은 순수 수치 계산만 한다 — person 신원도
소수셀 판정도 이 모듈의 책임이 아니다(프로젝트 전역 원칙).

covariance(HC3/person-cluster CR1)는 **직접 계산**한다(확정 결정 4) —
statsmodels 0.14.2의 `Logit.fit(cov_type='HC3')`는 결과 클래스에 `cov_HC3`가
없어 `cov_white_simple(use_correction=False)`로 대체되고 실제로는 HC0를
계산한다. statsmodels는 계수 추정(Logit MLE)과 적합도 지표에만 쓴다. OLS는
QR 기반 정규방정식으로 직접 푼다 — closed-form이라 "수렴 실패"가 없고, 계수
계산 경로를 하나로 고정해야 완전적합 판정이 경로에 따라 흔들리지 않는다
(리뷰 #19).

공통 표기(계획 §3 "covariance — 직접 계산"):
    W = diag(w_i), bread = (X'WX)^-1, score residual u_i.
    OLS:      w_i=1,          u_i = y_i - ŷ_i
    로지스틱:  w_i=μ_i(1-μ_i), u_i = y_i - μ_i
    hat h_ii = diag(W^½ X (X'WX)^-1 X' W^½) — Z=W^½X의 QR로 h_ii=row(Q)·row(Q)
    (X=QR이면 X(X'X)^-1X'=QQ' 항등식, 수치적으로 안정적).

    HC3: ω_i = u_i²/(1-h_ii)², V = bread·(X'diag(ω)X)·bread
    CR1: V = bread·(Σ_g s_g s_g')·bread·c, s_g=Σ_{i∈g}u_i x_i,
         c = G/(G-1)·(N-1)/(N-P)  (모형 불문 동일 공식)

분리 판정(로지스틱 전용)은 Konis(2007) LP 방식 — 완전/준완전분리를 구분하지
않는다(리뷰 #10, margin-0 기준이 성립하지 않음을 반례로 확인). solver 실패는
"분리 없음"으로 흘리지 않고 SEPARATION_CHECK_FAILED로 보수적으로 차단한다.

완전적합(OLS) 판정은 무차원 상대 잔차 비율로 한다(리뷰 #19/#21) —
‖e‖₂/‖y-ȳ‖₂ ≤ RESIDUAL_REL_TOL. 분모에 바닥값을 두지 않는다: outcome 배율을
줄이는 것만으로 정상 모형이 보류로 뒤집히는 반례가 있었다(상수 outcome은 Node
④에서 이미 걸러 분모 0이 나올 수 없다).
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy import stats as scipy_stats
from scipy.optimize import linprog

# statsmodels는 로지스틱(binomial) 경로에서만 쓴다 — 모듈 최상위에서 import하면
# analyze.py가 모든 요청(descriptive/bivariate/correlation_matrix 포함)에서
# 무조건 regression 모듈을 import할 때(디스패처 구조) statsmodels가 없는
# 인터프리터에서는 회귀와 무관한 요청까지 전부 깨진다. 함수 내부 지연 import로
# 그 결합을 끊는다(운영 venv는 requirements.txt로 항상 설치돼 있어 실제 동작에는
# 영향 없음 — 로컬에서 numpy/scipy만 있는 인터프리터로 다른 경로를 테스트할 때만
# 의미 있는 분리).

CI_CONFIDENCE_LEVEL = 0.95
_Z_CRIT = float(scipy_stats.norm.ppf(1 - (1 - CI_CONFIDENCE_LEVEL) / 2))

# 리뷰 #11 — h_ii=1(또는 매우 근접)이면 HC3의 (1-h_ii)² 분모가 0이거나 부동소수점
# 잡음으로 극히 작은 양수가 된다. full rank·충분한 잔차자유도에서도 발생할 수
# 있다(검산: 40명 중 39명 0, 1명 1인 predictor → rank 2, df 38, h_ii=1).
LEVERAGE_TOL = 1e-8

# 리뷰 #16/#19/#21 — 완전적합(OLS) 판정. 무차원 비율만 쓴다(분모 바닥값 없음).
RESIDUAL_REL_TOL = 1e-9

# 분리 판정(LP) 수치 허용오차 — solver 정밀도 잡음을 분리로 오판하지 않기 위함.
SEPARATION_TOL = 1e-6

# 조건수 임계 — 넘으면 ill_conditioned 경고만(추론은 계속). rank는 이미 Node가
# 확인했으므로 여기서 차단하지 않는다.
ILL_CONDITIONED_THRESHOLD = 1e12

# exp() 오버플로 경계(709 근방) — 이보다 크면 OR을 계산하지 않는다(계획 §3).
_EXP_OVERFLOW_GUARD = 700.0


def _safe_exp(value: float) -> float | None:
    if not math.isfinite(value) or abs(value) > _EXP_OVERFLOW_GUARD:
        return None
    return float(math.exp(value))


def _exponentiated_term(estimate: float, ci_lower: float | None, ci_upper: float | None) -> dict[str, Any] | None:
    exp_estimate = _safe_exp(estimate)
    if exp_estimate is None:
        return None
    return {
        "estimate": exp_estimate,
        "ciLower": _safe_exp(ci_lower) if ci_lower is not None else None,
        "ciUpper": _safe_exp(ci_upper) if ci_upper is not None else None,
    }


def _bread_and_hat(x: np.ndarray, w: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """bread=(X'WX)^-1과 hat h_ii를 Z=W^½X의 QR로 계산한다. X=QR이면
    X(X'X)^-1X'=QQ'(항등식)이므로 h_ii=row(Q)·row(Q), bread=Rinv@Rinv.T —
    역행렬을 직접 구하지 않고 삼각행렬만 다뤄 수치적으로 안정적이다."""
    sw = np.sqrt(w)
    z = x * sw[:, None]
    q, r = np.linalg.qr(z, mode="reduced")
    r_inv = np.linalg.inv(r)  # P×P(P≤20) — 작은 삼각행렬이라 직접 역행렬도 안전
    bread = r_inv @ r_inv.T
    h = np.sum(q * q, axis=1)
    return bread, h


def _hc3_covariance(x: np.ndarray, u: np.ndarray, h: np.ndarray, bread: np.ndarray) -> np.ndarray:
    omega = u ** 2 / (1 - h) ** 2
    meat = x.T @ (omega[:, None] * x)
    return bread @ meat @ bread


def _cr1_covariance(
    x: np.ndarray, u: np.ndarray, bread: np.ndarray, groups: list[str], n: int, p: int,
) -> tuple[np.ndarray, int]:
    by_group: dict[str, list[int]] = {}
    for i, g in enumerate(groups):
        by_group.setdefault(g, []).append(i)
    p_dim = x.shape[1]
    meat = np.zeros((p_dim, p_dim))
    for idxs in by_group.values():
        s_g = (u[idxs][:, None] * x[idxs]).sum(axis=0)
        meat += np.outer(s_g, s_g)
    num_groups = len(by_group)
    correction = (num_groups / (num_groups - 1)) * ((n - 1) / (n - p))
    return bread @ meat @ bread * correction, num_groups


def _check_separation(x: np.ndarray, y: np.ndarray) -> str:
    """Konis(2007) LP 판정. z_i=2y_i-1로 두고
    maximize Σz_i·x_i'β s.t. 0≤z_i·x_i'β≤1(모든 i)을 푼다. 최적값>허용오차면
    분리(완전/준완전 구분 안 함, 리뷰 #10). solver 실패·비최적종료는
    'check_failed'로 보수적으로 처리한다(분리 없음으로 흘리지 않음)."""
    n, p = x.shape
    z = 2 * y - 1
    c = -(z[:, None] * x).sum(axis=0)  # linprog는 최소화 — 부호 반전
    a_ub = np.vstack([z[:, None] * x, -z[:, None] * x])
    b_ub = np.concatenate([np.ones(n), np.zeros(n)])
    bounds = [(None, None)] * p
    try:
        res = linprog(c, A_ub=a_ub, b_ub=b_ub, bounds=bounds, method="highs")
    except Exception:  # noqa: BLE001
        return "check_failed"
    if res.status != 0:
        return "check_failed"
    optimal_value = -res.fun
    return "separated" if optimal_value > SEPARATION_TOL else "not_separated"


def _non_estimable(reason: str) -> dict[str, Any]:
    return {
        "estimation": "non_estimable",
        "nonEstimableReason": reason,
        "inferenceIssue": None,
        "inferenceDistribution": None,
        "inferenceDf": None,
        "clusterCount": None,
        "terms": [],
        "fit": None,
        "converged": False,
        "qualityFlags": [],
    }


def _withheld_terms(beta: np.ndarray, column_names: list[str], family: str) -> list[dict[str, Any]]:
    terms = []
    for i, name in enumerate(column_names):
        exponentiated = _exponentiated_term(float(beta[i]), None, None) if family == "binomial" else None
        terms.append({
            "name": name, "estimate": float(beta[i]), "se": None,
            "statistic": None, "pValue": None, "ciLower": None, "ciUpper": None,
            "exponentiated": exponentiated,
        })
    return terms


def _withheld(
    beta: np.ndarray, column_names: list[str], family: str, fit: dict[str, Any] | None,
    inference_issue: str, quality_flags: list[str], cluster_count: int | None = None,
) -> dict[str, Any]:
    return {
        "estimation": "inference_withheld",
        "nonEstimableReason": None,
        "inferenceIssue": inference_issue,
        "inferenceDistribution": None,
        "inferenceDf": None,
        "clusterCount": cluster_count,
        "terms": _withheld_terms(beta, column_names, family),
        "fit": fit,
        "converged": True,
        "qualityFlags": quality_flags,
    }


def compute_regression(
    family: str,
    y_raw: list[float],
    x_raw: list[list[float]],
    column_names: list[str],
    covariance_spec: dict[str, Any],
) -> dict[str, Any]:
    y = np.asarray(y_raw, dtype=float)
    x = np.asarray(x_raw, dtype=float)
    n, p = x.shape

    quality_flags: list[str] = []

    if family == "binomial":
        separation = _check_separation(x, y)
        if separation == "check_failed":
            return _non_estimable("SEPARATION_CHECK_FAILED")
        if separation == "separated":
            return _non_estimable("SEPARATION_DETECTED")

        import statsmodels.api as sm  # noqa: PLC0415 — 지연 import(위 모듈 docstring 근접 설명 참고)

        try:
            model = sm.Logit(y, x)
            res = model.fit(disp=0, maxiter=100, method="newton")
        except Exception:  # noqa: BLE001 — statsmodels가 수렴 실패를 예외로 낼 수 있음
            return _non_estimable("NOT_CONVERGED")
        converged = bool(res.mle_retvals.get("converged", False))
        if not converged:
            return _non_estimable("NOT_CONVERGED")

        beta = np.asarray(res.params, dtype=float)
        if not np.all(np.isfinite(beta)):
            return _non_estimable("NOT_CONVERGED")
        linear_predictor = x @ beta
        mu = 1.0 / (1.0 + np.exp(-linear_predictor))
        w = mu * (1 - mu)
        u = y - mu
        fit: dict[str, Any] = {
            "r2": None, "adjR2": None,
            "logLik": float(res.llf), "aic": float(res.aic), "pseudoR2": float(res.prsquared),
        }
        ss_res = ss_tot = None
    else:
        q, r = np.linalg.qr(x, mode="reduced")
        beta = np.linalg.solve(r, q.T @ y)
        yhat = x @ beta
        resid = y - yhat
        w = np.ones(n)
        u = resid
        ss_res = float(np.sum(resid ** 2))
        ss_tot = float(np.sum((y - y.mean()) ** 2))
        r2 = (1 - ss_res / ss_tot) if ss_tot > 0 else None
        adj_r2 = (1 - (1 - r2) * (n - 1) / (n - p)) if (r2 is not None and (n - p) > 0) else None
        fit = {"r2": r2, "adjR2": adj_r2, "logLik": None, "aic": None, "pseudoR2": None}

    try:
        bread, h = _bread_and_hat(x, w)
    except np.linalg.LinAlgError:
        return _withheld(beta, column_names, family, fit, "COVARIANCE_NOT_COMPUTABLE", quality_flags)

    # 리뷰 #11 — leverage가 1에 근접하면 HC3 분모가 불안정하다. bread 분해가
    # 성공해도 이 검사를 별도로 한다(작은 표본에서 흔한 함정).
    if np.any((1 - h) < LEVERAGE_TOL):
        return _withheld(beta, column_names, family, fit, "COVARIANCE_NOT_COMPUTABLE", quality_flags)

    cluster_count: int | None = None
    if covariance_spec["type"] == "hc3":
        cov = _hc3_covariance(x, u, h, bread)
    else:
        cov, cluster_count = _cr1_covariance(x, u, bread, covariance_spec["groups"], n, p)

    diag_cov = np.diag(cov)
    if np.any(diag_cov < 0) or not np.all(np.isfinite(diag_cov)):
        return _withheld(beta, column_names, family, fit, "COVARIANCE_NOT_COMPUTABLE", quality_flags, cluster_count)
    se = np.sqrt(diag_cov)
    if not np.all(np.isfinite(se)):
        return _withheld(beta, column_names, family, fit, "COVARIANCE_NOT_COMPUTABLE", quality_flags, cluster_count)

    # 리뷰 #16/#19/#21 — se===0(완전적합) 또는 OLS 상대잔차 완전적합이면
    # DEGENERATE_COVARIANCE로 추론 보류(COVARIANCE_NOT_COMPUTABLE과 구분 — 원인이
    # 다르다: 저게 leverage/분해 실패라면 이건 "계산은 됐는데 값이 퇴화").
    degenerate = bool(np.any(se == 0))
    if family == "gaussian" and ss_tot is not None and ss_res is not None:
        y_norm = math.sqrt(ss_tot)
        resid_norm = math.sqrt(ss_res)
        if y_norm > 0 and (resid_norm / y_norm) <= RESIDUAL_REL_TOL:
            degenerate = True
    if degenerate:
        return _withheld(beta, column_names, family, fit, "DEGENERATE_COVARIANCE", quality_flags, cluster_count)

    # 계획 §3 "추론 분포와 자유도" 표 — 분포·df는 family와 covariance 타입
    # *조합*으로 정해진다(OLS는 covariance 타입과 무관하게 항상 t이지만 df가
    # 다르고, 로지스틱은 covariance 타입에 따라 분포 자체가 달라진다). 처음
    # 구현에서 covariance 타입 분기보다 family 분기를 앞에 둬 OLS+cluster에서
    # 항상 N−P(HC3 df)를 쓰는 버그가 있었다 — 실제 스모크 테스트(§검증)에서
    # G−1이 아니라 N−P가 나오는 것으로 발견·수정.
    if covariance_spec["type"] == "hc3":
        if family == "gaussian":
            distribution = "t"
            df: float | None = float(n - p)
        else:
            distribution = "normal"
            df = None
    else:  # cluster
        distribution = "t"
        df = float(cluster_count - 1) if cluster_count is not None else None

    statistic = beta / se
    if distribution == "t" and df is not None:
        p_value = 2 * scipy_stats.t.sf(np.abs(statistic), df)
        crit = float(scipy_stats.t.ppf(1 - (1 - CI_CONFIDENCE_LEVEL) / 2, df))
    else:
        p_value = 2 * scipy_stats.norm.sf(np.abs(statistic))
        crit = _Z_CRIT

    ci_lower = beta - crit * se
    ci_upper = beta + crit * se

    if not (
        np.all(np.isfinite(statistic)) and np.all(np.isfinite(p_value))
        and np.all(np.isfinite(ci_lower)) and np.all(np.isfinite(ci_upper))
    ):
        return _withheld(beta, column_names, family, fit, "DEGENERATE_COVARIANCE", quality_flags, cluster_count)

    cond = float(np.linalg.cond(x.T @ x)) if p > 0 else 0.0
    if not math.isfinite(cond) or cond > ILL_CONDITIONED_THRESHOLD:
        quality_flags.append("ill_conditioned")

    terms = []
    for i, name in enumerate(column_names):
        exponentiated = (
            _exponentiated_term(float(beta[i]), float(ci_lower[i]), float(ci_upper[i]))
            if family == "binomial" else None
        )
        terms.append({
            "name": name,
            "estimate": float(beta[i]),
            "se": float(se[i]),
            "statistic": float(statistic[i]),
            "pValue": float(p_value[i]),
            "ciLower": float(ci_lower[i]),
            "ciUpper": float(ci_upper[i]),
            "exponentiated": exponentiated,
        })

    return {
        "estimation": "ok",
        "nonEstimableReason": None,
        "inferenceIssue": "ok",
        "inferenceDistribution": distribution,
        "inferenceDf": df,
        "clusterCount": cluster_count,
        "terms": terms,
        "fit": fit,
        "converged": True,
        "qualityFlags": quality_flags,
    }
