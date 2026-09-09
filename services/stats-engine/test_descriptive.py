"""PR1 계획서 §1.2/§9-item1 — R(동치 독립구현) 참조값 대조 + 경계조건 전수 테스트."""
from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from descriptive import (
    NON_FINITE_RESULT,
    UNDEFINED_ZERO_VARIANCE,
    INSUFFICIENT_DATA,
    compute_continuous,
    compute_discrete,
)
from protocol import MAX_TOTAL_VALUES, MAX_VALUES_PER_VARIABLE, ProtocolError, parse_and_validate_request

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _load_reference_cases() -> list[dict]:
    with open(FIXTURES_DIR / "r_reference_values.json", encoding="utf-8") as f:
        return json.load(f)["cases"]


@pytest.mark.parametrize("case", _load_reference_cases(), ids=lambda c: c["label"])
def test_continuous_matches_reference(case):
    result = compute_continuous(case["values"])
    assert result["n"] == case["n"]
    for field in ("mean", "sd", "median", "q1", "q3", "min", "max", "skewness", "kurtosis"):
        expected = case[field]
        actual = result[field]
        if expected is None:
            assert actual is None, f"{case['label']}.{field} expected None, got {actual}"
        else:
            assert actual is not None, f"{case['label']}.{field} expected {expected}, got None"
            np.testing.assert_allclose(actual, expected, rtol=1e-6, atol=1e-9)


# ---------------------------------------------------------------------------
# 경계조건 — §1.2 표 전수 (n=0/1/2/3/4, 상수배열, 근상수배열, 매우 큰 유한값)
# ---------------------------------------------------------------------------

def test_n0_all_null_insufficient_data():
    result = compute_continuous([])
    assert result["n"] == 0
    for field in ("mean", "sd", "median", "q1", "q3", "iqr", "skewness", "kurtosis", "min", "max"):
        assert result[field] is None
        assert result["nullReasons"][field] == INSUFFICIENT_DATA


def test_n1_value_reported_sd_skew_kurt_insufficient():
    result = compute_continuous([42.0])
    assert result["n"] == 1
    assert result["mean"] == 42.0
    assert result["median"] == 42.0
    assert result["q1"] == 42.0
    assert result["q3"] == 42.0
    assert result["iqr"] == 0.0
    assert result["min"] == 42.0
    assert result["max"] == 42.0
    assert result["sd"] is None
    assert result["nullReasons"]["sd"] == INSUFFICIENT_DATA
    assert result["skewness"] is None
    assert result["kurtosis"] is None


def test_constant_array_sd_zero_skew_kurt_undefined():
    result = compute_continuous([7.0, 7.0, 7.0, 7.0, 7.0])
    assert result["n"] == 5
    assert result["mean"] == 7.0
    assert result["sd"] == 0.0
    assert result["skewness"] is None
    assert result["nullReasons"]["skewness"] == UNDEFINED_ZERO_VARIANCE
    assert result["kurtosis"] is None
    assert result["nullReasons"]["kurtosis"] == UNDEFINED_ZERO_VARIANCE


def test_near_constant_array_enters_variance_gt_zero_branch():
    # 9차 검토 필수 수정 — 이전 판은 1.0 + 1e-300을 썼는데, 이 값은 배정밀도 부동소수점
    # 표현범위(1.0 근방 최소 증분 ~2.22e-16)보다 훨씬 작아 1.0 + 1e-300 == 1.0으로 그대로
    # 반올림된다. 즉 이 배열은 "근상수"가 아니라 값 6개가 전부 bit-identical한 "정확한
    # 상수 배열"이었고, variance==0 사전분기(위 test_constant_array_*와 동일 경로)를
    # 실제로는 다시 테스트하고 있었을 뿐이다(제목과 다른 분기를 통과하면서도 assert가
    # 느슨해 통과함).
    #
    # 배정밀도에서 실제로 구별되는 최소 증분(1.0 근방 epsilon ~2.22e-16)보다 충분히 큰
    # 1e-10을 써서 "값은 다른데 극히 가깝다"는 원래 의도를 실제로 만족시킨다. 이 조건에서
    # scipy(1.13/1.18 실측)는 "Precision loss ... catastrophic cancellation" 경고를
    # 내면서도 유한한 값을 반환한다 — 비유한 결과를 만드는 실제 경로는 이게 아니라
    # 극단적으로 큰 값의 overflow 쪽이다(test_very_large_finite_values_do_not_crash가
    # 그 경로를 담당). 이 테스트는 "variance==0 사전분기를 우회하고 실제로 분산>0 분기에서
    # 계산됐는지"를 검증하는 것으로 목적을 좁힌다.
    values = [1.0, 1.0 + 1e-10, 1.0, 1.0, 1.0, 1.0]
    assert len(set(values)) == 2, "부동소수점 반올림으로 상수 배열이 돼버리지 않았는지 확인"

    result = compute_continuous(values)
    assert result["n"] == 6
    assert result["sd"] is not None and result["sd"] > 0.0, "variance==0 사전분기를 타지 않았어야 함"
    assert result["nullReasons"].get("skewness") != UNDEFINED_ZERO_VARIANCE
    assert result["nullReasons"].get("kurtosis") != UNDEFINED_ZERO_VARIANCE

    # n>=4이므로 skew/kurtosis 둘 다 계산 시도된다 — 결과가 있으면 반드시 유한해야 하고
    # (canonicalSerializer가 NaN/Infinity를 거부하므로), 방어선(_finalize)이 작동해
    # None으로 치환됐다면 그 사유는 반드시 non_finite_result여야 한다(위에서 이미
    # undefined_zero_variance는 아님을 확인했으므로).
    for field in ("skewness", "kurtosis"):
        if result[field] is not None:
            assert math.isfinite(result[field])
        else:
            assert result["nullReasons"][field] == NON_FINITE_RESULT


def test_very_large_finite_values_do_not_crash():
    values = [1e300, 2e300, 1.5e300, 1.8e300, 1.2e300]
    result = compute_continuous(values)
    assert result["n"] == 5
    assert result["mean"] is not None
    # overflow로 비유한 값이 나오면 반드시 null+non_finite_result — 절대 NaN/Infinity가
    # 결과 dict에 그대로 남지 않는다(json.dumps가 그걸 그대로 직렬화하면 계약 위반).
    for field in ("mean", "sd", "median", "q1", "q3", "iqr", "skewness", "kurtosis", "min", "max"):
        v = result[field]
        if v is not None:
            assert math.isfinite(v), f"{field} leaked a non-finite value: {v}"


def test_n2_sd_computed_skew_kurt_insufficient():
    result = compute_continuous([4.0, 10.0])
    assert result["sd"] is not None
    assert result["skewness"] is None
    assert result["nullReasons"]["skewness"] == INSUFFICIENT_DATA
    assert result["kurtosis"] is None
    assert result["nullReasons"]["kurtosis"] == INSUFFICIENT_DATA


def test_n3_skew_computed_kurtosis_insufficient():
    result = compute_continuous([1.0, 2.0, 6.0])
    assert result["skewness"] is not None
    assert result["kurtosis"] is None
    assert result["nullReasons"]["kurtosis"] == INSUFFICIENT_DATA


def test_n4_skew_and_kurtosis_both_computed():
    result = compute_continuous([2.0, 4.0, 4.0, 8.0])
    assert result["skewness"] is not None
    assert result["kurtosis"] is not None


# ---------------------------------------------------------------------------
# discrete
# ---------------------------------------------------------------------------

def test_discrete_first_occurrence_order_and_counts():
    result = compute_discrete(["중등도", "경도", "중등도", "고도", "경도", "중등도"])
    assert result["n"] == 6
    levels = {lvl["level"]: lvl["count"] for lvl in result["levels"]}
    assert levels == {"중등도": 3, "경도": 2, "고도": 1}
    # 첫 등장 순서 보존
    assert [lvl["level"] for lvl in result["levels"]] == ["중등도", "경도", "고도"]


def test_discrete_boolean_values():
    result = compute_discrete([True, False, True, True])
    assert result["n"] == 4
    levels = {lvl["level"]: lvl["count"] for lvl in result["levels"]}
    assert levels == {True: 3, False: 1}


def test_discrete_bool_int_no_collision():
    # True/1이 파이썬에서 해시 충돌하는 것을 방어했는지(설계상 실무 발생 안 하지만 방어적).
    result = compute_discrete([True, 1])
    assert result["n"] == 2
    assert len(result["levels"]) == 2


# ---------------------------------------------------------------------------
# protocol.py — 상한 검증
# ---------------------------------------------------------------------------

def test_max_total_values_rejects_when_per_variable_ok_but_sum_exceeds():
    # 변수 각각은 MAX_VALUES_PER_VARIABLE 이하지만(jsonschema maxItems를 통과) 여러
    # 변수의 합이 MAX_TOTAL_VALUES를 넘는 입력 — 변수 수를 늘려 합만 상한을 넘긴다.
    num_vars = MAX_TOTAL_VALUES // MAX_VALUES_PER_VARIABLE + 2
    request = {
        "protocolVersion": 1,
        "variables": [
            {"key": f"v{i}", "kind": "continuous", "values": [1.0] * MAX_VALUES_PER_VARIABLE}
            for i in range(num_vars)
        ],
    }
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "LIMIT_EXCEEDED"


def test_invalid_json_raises_invalid_input():
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request("not json")
    assert exc_info.value.code == "INVALID_INPUT"


def test_schema_violation_raises_invalid_input():
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps({"protocolVersion": 1, "variables": [{"key": "x"}]}))
    assert exc_info.value.code == "INVALID_INPUT"


# ---------------------------------------------------------------------------
# analyze.py — stdin/stdout/stderr 프로세스 계약(subprocess로 실측)
# ---------------------------------------------------------------------------

def _run_analyze(stdin_text: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(Path(__file__).parent / "analyze.py")],
        input=stdin_text, capture_output=True, text=True, timeout=30,
    )


def test_analyze_process_success_stdout_only():
    request = {
        "protocolVersion": 1,
        "variables": [{"key": "v", "kind": "continuous", "values": [1.0, 2.0, 3.0]}],
    }
    proc = _run_analyze(json.dumps(request))
    assert proc.returncode == 0
    assert proc.stderr == ""
    payload = json.loads(proc.stdout)
    assert payload["continuous"][0]["variableKey"] == "v"


def test_analyze_process_failure_stdout_empty_stderr_has_marker():
    proc = _run_analyze("not json")
    assert proc.returncode == 1
    assert proc.stdout == ""
    assert proc.stderr.startswith("STATS_ENGINE_ERROR ")
    marker = json.loads(proc.stderr[len("STATS_ENGINE_ERROR "):])
    assert marker["code"] == "INVALID_INPUT"


def test_analyze_selfcheck_exit_zero():
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).parent / "analyze.py"), "--selfcheck"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0
