"""이변량 통계 검정 8종 — PR3-A 계획서(pr3-swift-waterfall.md) § "검정별 세부
스펙" 표를 그대로 구현한다.

이 모듈도 descriptive.py와 같은 원칙을 따른다: person 단위 소수 셀 억제·그룹
순서·카탈로그 조회는 전부 Node의 책임이고, 이 모듈은 이미 그룹핑/교차집계까지
끝난 구조화된 입력(groups/table/x·y)을 받아 통계치만 계산한다. 대응검정
(paired_t/wilcoxon_signed_rank)은 현재 카탈로그에 대응 메타데이터가 없어 Node
단에서 항상 unsupported로 막히므로 이 모듈엔 구현하지 않는다(계획서 §"방법
가용성 판정" A-1 참고).

공통 결과 envelope:
    {
      "n": int,
      "statistic": float | None,
      "df": float | {"numerator": float, "denominator": float} | None,
      "pValue": float | None,
      "effectSizes": [ {"name": str, "value": float | None,
                         "ci": [float, float] | None,
                         "ciUnavailableReason": str | None} ],
      "nullReasons": {...},
      "multipleTesting": {"method": "none", "adjustedP": float | None},
      "qualityFlags": [str],
      "extra": {...}   # cramers_v 등 검정별 부속 지표
    }

CI_CONFIDENCE_LEVEL=0.95 고정(계획서 §Python엔진).
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy import stats as scipy_stats

CI_CONFIDENCE_LEVEL = 0.95
_Z_CRIT = float(scipy_stats.norm.ppf(1 - (1 - CI_CONFIDENCE_LEVEL) / 2))  # ≈1.959964

# nullReasons 사유 — descriptive.py의 기존 3종에 이변량 전용 2종을 더한다(계획서
# §Python엔진 공통 envelope).
INSUFFICIENT_DATA = "insufficient_data"
UNDEFINED_ZERO_VARIANCE = "undefined_zero_variance"
NON_FINITE_RESULT = "non_finite_result"
CONSTANT_VARIABLE = "constant_variable"
INSUFFICIENT_GROUP_DATA = "insufficient_group_data"


def _envelope(
    n: int,
    statistic: float | None,
    df: Any,
    p_value: float | None,
    effect_sizes: list[dict[str, Any]],
    null_reasons: dict[str, str],
    quality_flags: list[str] | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "n": n,
        "statistic": statistic,
        "df": df,
        "pValue": p_value,
        "effectSizes": effect_sizes,
        "nullReasons": null_reasons,
        "multipleTesting": {"method": "none", "adjustedP": p_value},
        "qualityFlags": quality_flags or [],
        "extra": extra or {},
    }


def _finite_or_none(value: float | None) -> float | None:
    if value is None:
        return None
    return float(value) if math.isfinite(value) else None


def _effect_size(
    name: str, value: float | None, ci: tuple[float, float] | None = None,
    ci_unavailable_reason: str | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "value": _finite_or_none(value),
        "ci": [float(ci[0]), float(ci[1])] if ci is not None else None,
        "ciUnavailableReason": ci_unavailable_reason,
    }


def _group_arrays(groups: list[dict[str, Any]]) -> list[np.ndarray]:
    return [np.asarray(g["values"], dtype=np.float64) for g in groups]


# ---------------------------------------------------------------------------
# 그룹비교 — 정확히 2그룹
# ---------------------------------------------------------------------------

def welch_t(groups: list[dict[str, Any]]) -> dict[str, Any]:
    """groups[0]=기준(앞), groups[1]=비교(뒤). 평균차=mean(groups[1])-mean(groups[0])
    (계획서 §방향규칙 "고정 카탈로그 순서 뒤-앞"). Hedges' g는 pooled SD 기반
    classical(비-noncentral) CI(계획서 §검정별 세부 스펙)."""
    x1, x2 = _group_arrays(groups)
    n1, n2 = len(x1), len(x2)
    n = n1 + n2

    if n1 < 2 or n2 < 2:
        return _envelope(n, None, None, None, [], {"statistic": INSUFFICIENT_GROUP_DATA})

    var1, var2 = float(np.var(x1, ddof=1)), float(np.var(x2, ddof=1))
    if var1 == 0.0 or var2 == 0.0:
        return _envelope(n, None, None, None, [], {"statistic": CONSTANT_VARIABLE})

    mean1, mean2 = float(np.mean(x1)), float(np.mean(x2))
    mean_diff = mean2 - mean1
    se = math.sqrt(var1 / n1 + var2 / n2)
    t_stat = mean_diff / se
    df = (var1 / n1 + var2 / n2) ** 2 / (
        (var1 / n1) ** 2 / (n1 - 1) + (var2 / n2) ** 2 / (n2 - 1)
    )
    p_value = float(2 * scipy_stats.t.sf(abs(t_stat), df))
    t_crit = float(scipy_stats.t.ppf(1 - (1 - CI_CONFIDENCE_LEVEL) / 2, df))
    diff_ci = (mean_diff - t_crit * se, mean_diff + t_crit * se)

    # Hedges' g — pooled SD 분모(관례), classical(비-noncentral) 대표본 근사 CI.
    # R effsize::cohen.d(hedges.correction=TRUE, noncentral=FALSE) 소스(2026-09-11,
    # Docker r-base로 getAnywhere("cohen.d.default")를 직접 열람해 확인)를 그대로
    # 옮긴다 — SE 공식의 제곱항은 **보정 전 d가 아니라 보정 후 g**를 쓰고
    # (`S_d = sqrt((n1+n2)/(n1n2) + g²/(2(n1+n2)))`), 그 다음 J를 한 번 더 곱한다
    # (`S_d = S_d * J`, 제곱해서 J²을 곱하는 게 아니라 sqrt 밖에서 J를 한 번만
    # 곱함). 이전 구현은 g² 대신 d²를 썼다가 R 실측 대조(rel≈8.6e-4 차이)로
    # 잡혔다. CI 임계값은 z가 아니라 t(df=n1+n2-2, pooled df) — R 소스도 noncentral
    # 분기를 타지 않는 한 df를 재대입하지 않아 동일 df를 그대로 쓴다.
    df_pooled = n1 + n2 - 2
    sp = math.sqrt(((n1 - 1) * var1 + (n2 - 1) * var2) / df_pooled)
    d = mean_diff / sp
    j = 1 - 3 / (4 * (n1 + n2) - 9)
    g = d * j
    se_g = j * math.sqrt((n1 + n2) / (n1 * n2) + (g ** 2) / (2 * (n1 + n2)))
    g_t_crit = float(scipy_stats.t.ppf(1 - (1 - CI_CONFIDENCE_LEVEL) / 2, df_pooled))
    g_ci = (g - g_t_crit * se_g, g + g_t_crit * se_g)

    return _envelope(
        n, t_stat, df, p_value,
        [
            _effect_size("mean_difference", mean_diff, diff_ci),
            _effect_size("hedges_g", g, g_ci),
        ],
        {},
    )


def mann_whitney(groups: list[dict[str, Any]]) -> dict[str, Any]:
    """rank-biserial correlation r = 1 - 2U/(n1*n2), U는 groups[1](뒤) 기준."""
    x1, x2 = _group_arrays(groups)
    n1, n2 = len(x1), len(x2)
    n = n1 + n2

    if n1 < 1 or n2 < 1:
        return _envelope(n, None, None, None, [], {"statistic": INSUFFICIENT_GROUP_DATA})

    u_stat, p_value = scipy_stats.mannwhitneyu(
        x2, x1, alternative="two-sided", method="asymptotic", use_continuity=True,
    )
    # Kerby(2014) simple-difference formula: r = 2U/(n1n2) - 1, U는 groups[1](뒤)
    # 기준 — groups[1]이 groups[0]보다 전반적으로 크면 U가 커지고 r→+1(계획서
    # §방향규칙 "뒤-앞"과 부호를 일치시킴, welch_t의 mean_difference와 동일 방향).
    rank_biserial = (2 * float(u_stat)) / (n1 * n2) - 1

    return _envelope(
        n, float(u_stat), None, float(p_value),
        [_effect_size("rank_biserial", rank_biserial)],
        {},
    )


def anova(groups: list[dict[str, Any]]) -> dict[str, Any]:
    """Welch ANOVA — 운영 고정 scipy==1.13.0의 f_oneway()엔 등분산-미가정 옵션이
    없어 공식을 직접 구현(계획서 §Python엔진). R oneway.test(var.equal=FALSE)와
    동치."""
    arrays = _group_arrays(groups)
    k = len(arrays)
    n = sum(len(a) for a in arrays)

    if k < 2:
        return _envelope(n, None, None, None, [], {"statistic": INSUFFICIENT_GROUP_DATA})
    if any(len(a) < 2 for a in arrays):
        return _envelope(n, None, None, None, [], {"statistic": INSUFFICIENT_GROUP_DATA})

    ns = np.array([len(a) for a in arrays], dtype=np.float64)
    means = np.array([float(np.mean(a)) for a in arrays])
    variances = np.array([float(np.var(a, ddof=1)) for a in arrays])

    if np.any(variances == 0.0):
        return _envelope(n, None, None, None, [], {"statistic": CONSTANT_VARIABLE})

    weights = ns / variances
    w_sum = float(np.sum(weights))
    weighted_mean = float(np.sum(weights * means) / w_sum)

    numerator = float(np.sum(weights * (means - weighted_mean) ** 2) / (k - 1))
    denom_terms = ((1 - weights / w_sum) ** 2) / (ns - 1)
    denom_sum = float(np.sum(denom_terms))
    denominator = 1 + (2 * (k - 2) / (k ** 2 - 1)) * denom_sum if k > 2 else 1.0 + 2 * denom_sum * 0
    # k==2일 때 (k-2)=0이라 두 번째 항이 자연히 0 — Welch t와 동치가 되는 경계값.
    f_stat = numerator / denominator

    df1 = k - 1
    df2 = (k ** 2 - 1) / (3 * denom_sum) if denom_sum > 0 else float("inf")
    p_value = float(scipy_stats.f.sf(f_stat, df1, df2))

    # 고전 eta-squared — Welch F와 별개로, 전체 pooled 값에서 SS 기반 계산(계획서 명시).
    all_values = np.concatenate(arrays)
    grand_mean = float(np.mean(all_values))
    ss_between = float(np.sum(ns * (means - grand_mean) ** 2))
    ss_total = float(np.sum((all_values - grand_mean) ** 2))
    eta_squared = ss_between / ss_total if ss_total > 0 else None

    return _envelope(
        n, f_stat, {"numerator": df1, "denominator": df2}, p_value,
        [_effect_size("eta_squared", eta_squared, ci_unavailable_reason="not_supported_v1")],
        {},
    )


def kruskal_wallis(groups: list[dict[str, Any]]) -> dict[str, Any]:
    arrays = _group_arrays(groups)
    k = len(arrays)
    n = sum(len(a) for a in arrays)

    if k < 2:
        return _envelope(n, None, None, None, [], {"statistic": INSUFFICIENT_GROUP_DATA})

    all_values = np.concatenate(arrays)
    if np.all(all_values == all_values[0]):
        return _envelope(n, None, None, None, [], {"statistic": CONSTANT_VARIABLE})

    h_stat, p_value = scipy_stats.kruskal(*arrays)
    epsilon_squared = float(h_stat) / ((n ** 2 - 1) / (n + 1))

    return _envelope(
        n, float(h_stat), k - 1, float(p_value),
        [_effect_size("epsilon_squared", epsilon_squared, ci_unavailable_reason="not_supported_v1")],
        {},
    )


# ---------------------------------------------------------------------------
# 분할표 — chi_square/fisher_exact
# ---------------------------------------------------------------------------

def chi_square(table: list[list[int]]) -> dict[str, Any]:
    arr = np.asarray(table, dtype=np.float64)
    n = int(arr.sum())

    # p값·통계량은 scipy 기본(2x2엔 Yates 보정 자동 적용, dof>1이면 무영향).
    chi2_stat, p_value, dof, expected = scipy_stats.chi2_contingency(arr, correction=True)
    # Cramér's V는 비보정 χ²로 계산(Yates 보정 χ²를 쓰면 과소추정 — 계획서 명시).
    chi2_uncorrected, _, _, _ = scipy_stats.chi2_contingency(arr, correction=False)

    r, c = arr.shape
    cramers_v = math.sqrt(chi2_uncorrected / (n * (min(r, c) - 1))) if n > 0 and min(r, c) > 1 else None

    quality_flags: list[str] = []
    if np.any(expected < 5):
        quality_flags.append("low_expected_count")

    return _envelope(
        n, float(chi2_stat), int(dof), float(p_value),
        [],
        {},
        quality_flags=quality_flags,
        extra={"cramersV": _effect_size("cramers_v", cramers_v, ci_unavailable_reason="not_supported_v1")},
    )


def fisher_exact(table: list[list[int]]) -> dict[str, Any]:
    """2×2 전용(scipy 제약). odds_ratio=표본 교차비(ad)/(bc), 0-셀 시 네 셀 모두
    +0.5 Haldane-Anscombe 보정 — p값은 보정 없는 원본 표로(정확검정이라 연속성
    보정 불필요), OR·CI만 보정된 값으로 계산(계획서 §검정별 세부 스펙)."""
    arr = np.asarray(table, dtype=np.int64)
    if arr.shape != (2, 2):
        raise ValueError("fisher_exact는 2×2 표만 지원한다")
    n = int(arr.sum())

    _, p_value = scipy_stats.fisher_exact(arr, alternative="two-sided")

    a, b, c, d = float(arr[0, 0]), float(arr[0, 1]), float(arr[1, 0]), float(arr[1, 1])
    haldane_applied = a == 0 or b == 0 or c == 0 or d == 0
    if haldane_applied:
        a, b, c, d = a + 0.5, b + 0.5, c + 0.5, d + 0.5

    odds_ratio = (a * d) / (b * c)
    log_or = math.log(odds_ratio)
    se_log_or = math.sqrt(1 / a + 1 / b + 1 / c + 1 / d)
    ci = (math.exp(log_or - _Z_CRIT * se_log_or), math.exp(log_or + _Z_CRIT * se_log_or))

    quality_flags = ["haldane_anscombe_applied"] if haldane_applied else []

    return _envelope(
        n, None, None, float(p_value),
        [_effect_size("odds_ratio", odds_ratio, ci)],
        {},
        quality_flags=quality_flags,
    )


# ---------------------------------------------------------------------------
# 상관 — pearson/spearman
# ---------------------------------------------------------------------------

def _correlation_ci(r: float, n: int, se_fn) -> tuple[tuple[float, float] | None, str | None]:
    if n < 4:
        return None, "undefined_at_n"
    if abs(r) >= 1.0:
        return None, "perfect_correlation"
    z = math.atanh(r)
    se = se_fn(r, n)
    lo, hi = z - _Z_CRIT * se, z + _Z_CRIT * se
    return (math.tanh(lo), math.tanh(hi)), None


def pearson_correlation(x: list[float], y: list[float]) -> dict[str, Any]:
    n = len(x)
    xa, ya = np.asarray(x, dtype=np.float64), np.asarray(y, dtype=np.float64)

    if n < 3 or np.all(xa == xa[0]) or np.all(ya == ya[0]):
        reason = CONSTANT_VARIABLE if n >= 3 else INSUFFICIENT_DATA
        return _envelope(n, None, None, None, [], {"statistic": reason})

    r, p_value = scipy_stats.pearsonr(xa, ya)
    r = float(r)
    ci, ci_reason = _correlation_ci(r, n, lambda _r, _n: 1 / math.sqrt(_n - 3))

    return _envelope(
        n, r, n - 2, float(p_value),
        [_effect_size("pearson_r", r, ci, ci_reason)],
        {},
    )


def spearman_correlation(x: list[float], y: list[float]) -> dict[str, Any]:
    n = len(x)
    xa, ya = np.asarray(x, dtype=np.float64), np.asarray(y, dtype=np.float64)

    if n < 3 or np.all(xa == xa[0]) or np.all(ya == ya[0]):
        reason = CONSTANT_VARIABLE if n >= 3 else INSUFFICIENT_DATA
        return _envelope(n, None, None, None, [], {"statistic": reason})

    rho, p_value = scipy_stats.spearmanr(xa, ya)
    rho = float(rho)
    # Bonett-Wright SE — Spearman 전용(계획서 §검정별 세부 스펙).
    ci, ci_reason = _correlation_ci(
        rho, n, lambda _r, _n: math.sqrt((1 + (_r ** 2) / 2) / (_n - 3)),
    )

    return _envelope(
        n, rho, n - 2, float(p_value),
        [_effect_size("spearman_rho", rho, ci, ci_reason)],
        {},
    )
