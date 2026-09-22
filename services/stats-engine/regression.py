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


# ---------------------------------------------------------------------------
# PR4-A2 — 진단(VIF·condition number·leverage 계열 지원 판정). 추론 상태
# (estimation/inferenceWithheldReason) 문자열과 완전히 분리된 직접 수치 검사다
# — 계획서 §3 "_evaluate_diagnostic_support", 3차 리뷰 반례로 확정된 원칙.
# se==0(DEGENERATE_COVARIANCE)이어도 h·MSE가 둘 다 건강한 경우가 있다(공분산
# 샌드위치 공식 자체의 대수적 퇴화, h·MSE와 무관한 원인) — 그래서 추론 상태가
# 아니라 h·MSE(OLS)/mu·w·denom(로지스틱)을 매번 다시 직접 검사한다.
# ---------------------------------------------------------------------------

def _evaluate_diagnostic_support(
    x: np.ndarray, y: np.ndarray, beta: np.ndarray, family: str, h: np.ndarray | None,
) -> tuple[bool, str | None]:
    if h is None:
        return False, "QR_DECOMPOSITION_FAILED"
    if not np.all(np.isfinite(h)) or not np.all((1 - h) > LEVERAGE_TOL):
        return False, "NEAR_SINGULAR_LEVERAGE"

    if family == "gaussian":
        n, p = x.shape
        yhat = x @ beta
        resid = y - yhat
        ss_res = float(np.sum(resid ** 2))
        ss_tot = float(np.sum((y - y.mean()) ** 2))
        mse = ss_res / (n - p) if (n - p) > 0 else float("nan")
        if not (
            math.isfinite(mse) and mse > 0 and ss_tot > 0
            and math.sqrt(ss_res) / math.sqrt(ss_tot) > RESIDUAL_REL_TOL
        ):
            return False, "INVALID_DIAGNOSTIC_SCALE"
    else:
        # 4차 리뷰로 정정 — "비분리·수렴이면 w_i가 0에 안 붙는다"는 틀렸다. 분리가
        # 없어도 개별 관측치의 선형예측자가 크면(예: η≈40) mu→1.0, w=mu(1-mu)→0.0
        # 이 실측으로 확인된다(분리와 무관한 행별 현상이라 h 검사로도 안 걸린다).
        linear_predictor = x @ beta
        mu = 1.0 / (1.0 + np.exp(-linear_predictor))
        w = mu * (1 - mu)
        denom = w * (1 - h)
        if not (np.all(np.isfinite(w)) and np.all(np.isfinite(denom)) and np.all(denom > 0)):
            return False, "INVALID_DIAGNOSTIC_SCALE"
    return True, None


def _compute_vif(x: np.ndarray) -> list[float | None]:
    """절편(0번 열) 제외 각 열 j를 나머지 열(절편 포함)로 회귀한 R²_j로
    VIF_j=1/(1-R²_j). rank는 이미 Node가 확인했지만, 개별 열의 준-공선성으로
    R²_j→1이 되는 경우는 여전히 가능하다 — 열마다 독립적으로 계산·실패를
    격리한다(계획서 §3 "VIF / condition number", 5차 리뷰 — Infinity를 그대로
    반환하면 raw 스키마의 `.finite()`를 뚫어 응답 전체가 깨진다)."""
    n, p = x.shape
    vifs: list[float | None] = []
    for j in range(1, p):
        try:
            other_cols = [k for k in range(p) if k != j]
            x_other = x[:, other_cols]
            y_j = x[:, j]
            q, r = np.linalg.qr(x_other, mode="reduced")
            coef = np.linalg.solve(r, q.T @ y_j)
            fitted = x_other @ coef
            ss_res = float(np.sum((y_j - fitted) ** 2))
            ss_tot = float(np.sum((y_j - y_j.mean()) ** 2))
            if ss_tot <= 0 or (1 - ss_res / ss_tot) >= (1 - 1e-8):
                vifs.append(None)  # vif_unstable(R²_j가 1에 너무 가까움)
                continue
            r_sq = 1 - ss_res / ss_tot
            vif = 1.0 / (1.0 - r_sq)
            vifs.append(float(vif) if math.isfinite(vif) else None)
        except Exception:  # noqa: BLE001 — 이 열의 실패가 다른 열까지 막지 않는다
            vifs.append(None)
    return vifs


def _diagnostics_block(
    x: np.ndarray, y: np.ndarray, beta: np.ndarray, family: str, h: np.ndarray | None,
) -> dict[str, Any]:
    supported, reason = _evaluate_diagnostic_support(x, y, beta, family, h)
    try:
        cond_x = float(np.linalg.cond(x))
        if not math.isfinite(cond_x):
            cond_x = None
    except Exception:  # noqa: BLE001
        cond_x = None
    return {
        "conditionNumber": cond_x,
        "vif": _compute_vif(x),
        "pointDiagnosticsSupported": supported,
        "pointDiagnosticsUnsupportedReason": reason,
    }


def _evaluate_spline_contrasts(
    spline_contrasts: list[dict[str, Any]],
    beta: np.ndarray,
    cov: np.ndarray | None,
    distribution: str | None,
    df: float | None,
    family: str,
) -> list[dict[str, Any]]:
    """Node가 만든 대비행렬(contrast matrix, spline 열만 비영)로 delta/CI를
    계산한다 — Python은 spline을 모른다(계획서 §3 "spline 부분효과"). CI는
    이미 계산된 추론 분포·df·crit을 그대로 재사용한다(1.96 고정 금지). cov가
    None이면(공분산 자체가 없음) delta만 채우고 CI는 전부 None — 그리드 한
    점의 계산이 비유한이어도 그 점만 null 처리하고 나머지는 보존한다(개별
    실패 격리 원칙, VIF와 동일)."""
    results = []
    for item in spline_contrasts:
        contrast_matrix = np.asarray(item["contrastMatrix"], dtype=float)
        points = []
        for row in contrast_matrix:
            delta: float | None
            try:
                raw_delta = float(row @ beta)
                delta = raw_delta if math.isfinite(raw_delta) else None
            except Exception:  # noqa: BLE001
                delta = None
            if delta is None:
                points.append({"deltaFromBaseline": None, "ciLower": None, "ciUpper": None, "exponentiated": None})
                continue

            ci_lower = ci_upper = None
            if cov is not None and distribution is not None:
                try:
                    var = float(row @ cov @ row)
                    if var >= 0 and math.isfinite(var):
                        se = math.sqrt(var)
                        if distribution == "t" and df is not None:
                            crit = float(scipy_stats.t.ppf(1 - (1 - CI_CONFIDENCE_LEVEL) / 2, df))
                        else:
                            crit = _Z_CRIT
                        candidate_lower = delta - crit * se
                        candidate_upper = delta + crit * se
                        if math.isfinite(candidate_lower) and math.isfinite(candidate_upper):
                            ci_lower, ci_upper = candidate_lower, candidate_upper
                except Exception:  # noqa: BLE001 — 이 점의 CI 실패가 delta·다른 점을 막지 않는다
                    pass

            exponentiated = _exponentiated_term(delta, ci_lower, ci_upper) if family == "binomial" else None
            points.append({
                "deltaFromBaseline": delta, "ciLower": ci_lower, "ciUpper": ci_upper,
                "exponentiated": exponentiated,
            })
        results.append({"variableKey": item["variableKey"], "points": points})
    return results


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
        # PR4-A2 — 계수(β) 자체가 없으므로 진단·spline도 없다(shared/contracts의
        # 상태 불변식과 대응 — non_estimable → diagnostics/splinePartialEffects null).
        "diagnostics": None,
        "splinePartialEffects": None,
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
    beta: np.ndarray, x: np.ndarray, y: np.ndarray, column_names: list[str], family: str,
    fit: dict[str, Any] | None, inference_issue: str, quality_flags: list[str],
    spline_contrasts: list[dict[str, Any]], cluster_count: int | None = None, h: np.ndarray | None = None,
) -> dict[str, Any]:
    # PR4-A2 — β는 유효하므로 VIF·condition number·leverage 지원 여부는 직접
    # 재판정한다(추론 상태와 무관 — 계획서 §3). spline 대비값은 delta만 채우고
    # CI는 항상 None(공분산 자체가 없거나 퇴화한 상태이므로 — cov=None 고정).
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
        "diagnostics": _diagnostics_block(x, y, beta, family, h),
        "splinePartialEffects": _evaluate_spline_contrasts(spline_contrasts, beta, None, None, None, family),
    }


def compute_regression(
    family: str,
    y_raw: list[float],
    x_raw: list[list[float]],
    column_names: list[str],
    covariance_spec: dict[str, Any],
    spline_contrasts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    y = np.asarray(y_raw, dtype=float)
    x = np.asarray(x_raw, dtype=float)
    n, p = x.shape
    spline_contrasts = spline_contrasts or []

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
        return _withheld(beta, x, y, column_names, family, fit, "COVARIANCE_NOT_COMPUTABLE", quality_flags, spline_contrasts, h=None)

    # 리뷰 #11 — leverage가 1에 근접하면 HC3 분모가 불안정하다. bread 분해가
    # 성공해도 이 검사를 별도로 한다(작은 표본에서 흔한 함정).
    if np.any((1 - h) < LEVERAGE_TOL):
        return _withheld(beta, x, y, column_names, family, fit, "COVARIANCE_NOT_COMPUTABLE", quality_flags, spline_contrasts, h=h)

    cluster_count: int | None = None
    if covariance_spec["type"] == "hc3":
        cov = _hc3_covariance(x, u, h, bread)
    else:
        cov, cluster_count = _cr1_covariance(x, u, bread, covariance_spec["groups"], n, p)

    diag_cov = np.diag(cov)
    if np.any(diag_cov < 0) or not np.all(np.isfinite(diag_cov)):
        return _withheld(beta, x, y, column_names, family, fit, "COVARIANCE_NOT_COMPUTABLE", quality_flags, spline_contrasts, cluster_count, h)
    se = np.sqrt(diag_cov)
    if not np.all(np.isfinite(se)):
        return _withheld(beta, x, y, column_names, family, fit, "COVARIANCE_NOT_COMPUTABLE", quality_flags, spline_contrasts, cluster_count, h)

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
        return _withheld(beta, x, y, column_names, family, fit, "DEGENERATE_COVARIANCE", quality_flags, spline_contrasts, cluster_count, h)

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
        return _withheld(beta, x, y, column_names, family, fit, "DEGENERATE_COVARIANCE", quality_flags, spline_contrasts, cluster_count, h)

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
        "diagnostics": _diagnostics_block(x, y, beta, family, h),
        "splinePartialEffects": _evaluate_spline_contrasts(spline_contrasts, beta, cov, distribution, df, family),
    }


def compute_regression_diagnostics(
    family: str,
    y_raw: list[float],
    x_raw: list[list[float]],
    beta_raw: list[float],
    sampled_row_indices: list[int],
) -> dict[str, Any]:
    """PR4-A2 — limited_row 행 단위 진단(경량 경로, 재적합 없음). 캐시 hit/miss
    와 완전히 독립적인 (X,y,β)만의 순수 함수다(계획서 §4 "limited_row 진단값").
    가용성 판정은 `_evaluate_diagnostic_support`(최초 적합 경로와 동일 함수) —
    이 경로엔 estimation/inferenceWithheldReason 개념 자체가 없으므로 h/β로
    직접 재확인하는 것이 유일한 방법이다. Q-Q `theoreticalQuantile`은 **전체
    N행의 순위**로 먼저 계산한 뒤 표본만 직렬화한다(샘플링 후 재계산하면
    분위수 라벨이 틀어진다)."""
    y = np.asarray(y_raw, dtype=float)
    x = np.asarray(x_raw, dtype=float)
    beta = np.asarray(beta_raw, dtype=float)
    n, p = x.shape

    if family == "gaussian":
        w = np.ones(n)
    else:
        linear_predictor = x @ beta
        mu = 1.0 / (1.0 + np.exp(-linear_predictor))
        w = mu * (1 - mu)

    h: np.ndarray | None
    try:
        _, h = _bread_and_hat(x, w)
    except np.linalg.LinAlgError:
        h = None

    supported, reason = _evaluate_diagnostic_support(x, y, beta, family, h)
    if not supported:
        return {
            "pointDiagnosticsSupported": False,
            "pointDiagnosticsUnsupportedReason": reason,
            "points": [],
        }

    if family == "gaussian":
        yhat = x @ beta
        resid = y - yhat
        mse = float(np.sum(resid ** 2)) / (n - p)
        standardized = resid / (np.sqrt(mse) * np.sqrt(1 - h))
    else:
        yhat = 1.0 / (1.0 + np.exp(-(x @ beta)))
        resid = y - yhat
        standardized = resid / np.sqrt(w * (1 - h))
    cooks_d = (standardized ** 2 / p) * (h / (1 - h))

    order = np.argsort(standardized)
    ranks = np.empty(n, dtype=float)
    ranks[order] = np.arange(1, n + 1)
    theoretical_quantile_all = scipy_stats.norm.ppf((ranks - 0.5) / n)

    points = []
    for idx in sampled_row_indices:
        points.append({
            "rowIndex": int(idx),
            "fittedValue": float(yhat[idx]),
            "residual": float(resid[idx]),
            "leverage": float(h[idx]),
            "standardizedResidual": float(standardized[idx]),
            "cooksDistance": float(cooks_d[idx]),
            "theoreticalQuantile": float(theoretical_quantile_all[idx]),
        })

    return {
        "pointDiagnosticsSupported": True,
        "pointDiagnosticsUnsupportedReason": None,
        "points": points,
    }
