"""연속형 요약 / 범주형 빈도 계산 — PR1 계획서 §1.2 경계조건 표를 그대로 구현한다.

이 모듈은 missing이라는 개념을 전혀 모른다 — Node가 이미 결측이 아닌 값만 걸러서
넘긴다. 이 모듈의 역할은 순수하게 "값 배열이 주어지면 통계치를 계산한다"뿐이다.
person 단위 소수 셀 억제, mode 동점 처리, ordinal 순서 재배열은 Node(카탈로그를
아는 쪽)의 책임이며 이 모듈은 관여하지 않는다.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy import stats as scipy_stats

# 결측 아닌 값이 없거나(n=0) 표본 표준편차·왜도·첨도를 계산하기에 부족한 경우.
INSUFFICIENT_DATA = "insufficient_data"
# n>=2인데 분산이 정확히 0(상수 배열)이라 왜도/첨도가 0/0으로 수학적으로 미정의.
UNDEFINED_ZERO_VARIANCE = "undefined_zero_variance"
# 위 두 사전조건을 통과했는데도 계산 결과가 유한하지 않은 경우(근상수 배열·overflow
# 등에 대한 최종 방어선) — math.isfinite()로 모든 수치 필드를 검사한 뒤 치환한다.
NON_FINITE_RESULT = "non_finite_result"

_CONTINUOUS_NUMERIC_FIELDS = (
    "mean", "sd", "median", "q1", "q3", "iqr", "skewness", "kurtosis", "min", "max",
)


def compute_continuous(values: list[float]) -> dict[str, Any]:
    n = len(values)
    result: dict[str, Any] = {
        "n": n,
        "mean": None, "sd": None, "median": None, "q1": None, "q3": None, "iqr": None,
        "skewness": None, "kurtosis": None, "min": None, "max": None,
        "nullReasons": {},
    }

    if n == 0:
        for field in _CONTINUOUS_NUMERIC_FIELDS:
            result["nullReasons"][field] = INSUFFICIENT_DATA
        return result

    x = np.asarray(values, dtype=np.float64)

    if n == 1:
        v = float(x[0])
        result.update(mean=v, median=v, q1=v, q3=v, iqr=0.0, min=v, max=v)
        result["nullReasons"]["sd"] = INSUFFICIENT_DATA
        result["nullReasons"]["skewness"] = INSUFFICIENT_DATA
        result["nullReasons"]["kurtosis"] = INSUFFICIENT_DATA
        return _finalize(result)

    # n >= 2 — 분산을 먼저 확인해 0이면 scipy 호출 자체를 건너뛴다(0/0 NaN 방지, §1.2).
    variance = float(np.var(x, ddof=1))
    mean = float(np.mean(x))
    q1, median, q3 = (float(v) for v in np.percentile(x, [25, 50, 75], method="linear"))
    result.update(
        mean=mean, median=median, q1=q1, q3=q3, iqr=q3 - q1,
        min=float(np.min(x)), max=float(np.max(x)),
    )

    if variance == 0.0:
        result["sd"] = 0.0
        result["nullReasons"]["skewness"] = UNDEFINED_ZERO_VARIANCE
        result["nullReasons"]["kurtosis"] = UNDEFINED_ZERO_VARIANCE
        return _finalize(result)

    result["sd"] = math.sqrt(variance)  # ddof=1 표본표준편차 — numpy.std 기본값(ddof=0)과 다름

    # 왜도는 n>=3, 첨도는 n>=4(편향보정 첨도 공식의 분모에 (n-3) 항이 있어 n=3에서
    # 수학적으로 미정의 — §1.2, e1071::kurtosis(type=2)/scipy 구현과 일치시킴).
    if n < 3:
        result["nullReasons"]["skewness"] = INSUFFICIENT_DATA
        result["nullReasons"]["kurtosis"] = INSUFFICIENT_DATA
    elif n == 3:
        result["skewness"] = float(scipy_stats.skew(x, bias=False))
        result["nullReasons"]["kurtosis"] = INSUFFICIENT_DATA
    else:
        result["skewness"] = float(scipy_stats.skew(x, bias=False))
        result["kurtosis"] = float(scipy_stats.kurtosis(x, fisher=True, bias=False))

    return _finalize(result)


def _finalize(result: dict[str, Any]) -> dict[str, Any]:
    """모든 수치 필드에 대해 math.isfinite() 최종검사 — 근상수 배열·overflow로 인한
    비유한 값이 새어나가지 않게 한다(사전조건 통과 후에도 필요한 마지막 방어선)."""
    for field in _CONTINUOUS_NUMERIC_FIELDS:
        v = result[field]
        if v is not None and not math.isfinite(v):
            result[field] = None
            result["nullReasons"][field] = NON_FINITE_RESULT
    return result


def compute_discrete(values: list[Any]) -> dict[str, Any]:
    """exact match로 그룹화, 원본 입력 순서에서 첫 등장한 순서대로 levels를 반환한다.
    mode·동점 처리·ordinal 순서 재배열은 Node의 책임 — 여기서는 하지 않는다.
    bool과 int(1/0)가 Python에서 해시 충돌하는 것을 방어하기 위해 (타입명, 값) 튜플로
    그룹 키를 만든다(카탈로그상 한 변수는 항상 단일 타입이라 실무 영향은 없지만, 방어적)."""
    n = len(values)
    order: list[Any] = []
    counts: dict[tuple[str, Any], int] = {}
    representative: dict[tuple[str, Any], Any] = {}

    for v in values:
        key = (type(v).__name__, v)
        if key not in counts:
            counts[key] = 0
            representative[key] = v
            order.append(key)
        counts[key] += 1

    levels = [{"level": representative[key], "count": counts[key]} for key in order]
    return {"n": n, "levels": levels}
