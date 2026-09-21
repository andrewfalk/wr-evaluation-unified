"""protocol.py의 회귀 shape 검증(oneOf 구조검사 + _validate_regression_semantics
교차필드 검증) 단위테스트 + analyze.py 프로세스 계약(stdin/stdout/stderr) 회귀
경로 end-to-end 테스트."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from protocol import MAX_VALUES_PER_VARIABLE, MAX_TOTAL_VALUES, ProtocolError, parse_and_validate_request


def _ols_request(n=20):
    x1 = [float(i) for i in range(n)]
    # 결정적 잡음(완전적합 방지 — 잡음 없이 y=2+0.5x1로만 두면 잔차가 정확히 0이라
    # DEGENERATE_COVARIANCE로 추론이 보류돼 "정상 성공" E2E 픽스처로 못 쓴다).
    y = [2.0 + 0.5 * v + ((i % 5) - 2) * 0.13 for i, v in enumerate(x1)]
    return {
        "protocolVersion": 4,
        "regression": {
            "family": "gaussian",
            "y": y,
            "X": [[1.0, v] for v in x1],
            "columnNames": ["intercept", "x1"],
            "covariance": {"type": "hc3"},
        },
    }


def test_valid_ols_hc3_request_parses():
    data = parse_and_validate_request(json.dumps(_ols_request()))
    assert data["regression"]["family"] == "gaussian"


def test_valid_cluster_request_parses():
    n = 20
    request = _ols_request(n)
    request["regression"]["covariance"] = {"type": "cluster", "groups": [f"g{i // 2}" for i in range(n)]}
    parse_and_validate_request(json.dumps(request))


def test_wrong_protocol_version_rejected():
    request = _ols_request()
    request["protocolVersion"] = 1
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_stale_protocol_version_3_rejected():
    request = _ols_request()
    request["protocolVersion"] = 3
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_variables_and_regression_mutually_exclusive():
    request = _ols_request()
    request["variables"] = []
    with pytest.raises(ProtocolError):
        parse_and_validate_request(json.dumps(request))


def test_x_row_count_mismatch_with_y_rejected():
    request = _ols_request(n=20)
    request["regression"]["X"] = request["regression"]["X"][:-1]  # 19행, y는 20개
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_x_row_length_mismatch_with_column_names_rejected():
    request = _ols_request()
    request["regression"]["X"][0] = [1.0, 2.0, 3.0]  # 다른 행은 길이 2인데 첫 행만 3
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_empty_column_names_rejected():
    request = _ols_request()
    request["regression"]["columnNames"] = []
    request["regression"]["X"] = [[] for _ in request["regression"]["y"]]
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_cluster_covariance_requires_groups_same_length_as_y():
    request = _ols_request(n=20)
    request["regression"]["covariance"] = {"type": "cluster", "groups": ["g1", "g2"]}  # 길이 2 != 20
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_cluster_covariance_without_groups_rejected():
    request = _ols_request()
    request["regression"]["covariance"] = {"type": "cluster"}
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_non_finite_values_in_y_rejected():
    # json.dumps 기본(allow_nan=True)은 NaN을 비표준 리터럴 `NaN`으로 직렬화하고
    # json.loads가 그대로 float('nan')을 복원한다 — 구조 검증은 통과하지만
    # _validate_regression_semantics의 유한성 검사가 거부해야 한다.
    request = _ols_request()
    request["regression"]["y"][0] = float("nan")
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_non_finite_values_in_x_rejected():
    request = _ols_request()
    request["regression"]["X"][0][1] = float("inf")
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_binomial_y_must_be_0_or_1():
    request = _ols_request()
    request["regression"]["family"] = "binomial"
    request["regression"]["y"] = [0.5] * len(request["regression"]["y"])
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_binomial_y_0_1_accepted():
    n = 20
    request = _ols_request(n)
    request["regression"]["family"] = "binomial"
    request["regression"]["y"] = [float(i % 2) for i in range(n)]
    parse_and_validate_request(json.dumps(request))


def test_invalid_family_rejected():
    request = _ols_request()
    request["regression"]["family"] = "poisson"
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_row_count_exceeds_max_values_per_variable_rejected():
    # y/X 필드의 jsonschema maxItems가 변수당 상한을 구조적으로 막는다 —
    # variables shape의 개별 변수 values.maxItems와 같은 관례(INVALID_INPUT,
    # LIMIT_EXCEEDED가 아님 — 그건 여러 변수를 합친 총합 검사 전용).
    n = MAX_VALUES_PER_VARIABLE + 1
    request = {
        "protocolVersion": 4,
        "regression": {
            "family": "gaussian",
            "y": [1.0] * n,
            "X": [[1.0]] * n,
            "columnNames": ["intercept"],
            "covariance": {"type": "hc3"},
        },
    }
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_total_values_exceeds_limit_rejected():
    # 행 수는 상한 이내지만 N×P가 MAX_TOTAL_VALUES를 넘는 경우.
    n = MAX_VALUES_PER_VARIABLE
    p = MAX_TOTAL_VALUES // n + 2
    request = {
        "protocolVersion": 4,
        "regression": {
            "family": "gaussian",
            "y": [1.0] * n,
            "X": [[1.0] * p for _ in range(n)],
            "columnNames": [f"c{i}" for i in range(p)],
            "covariance": {"type": "hc3"},
        },
    }
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "LIMIT_EXCEEDED"


# ---------------------------------------------------------------------------
# analyze.py — 회귀 경로 end-to-end(stdin/stdout/stderr 프로세스 계약)
# ---------------------------------------------------------------------------

def _run_analyze(stdin_text: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(Path(__file__).parent / "analyze.py")],
        input=stdin_text, capture_output=True, text=True, timeout=30,
    )


def test_analyze_process_regression_success():
    proc = _run_analyze(json.dumps(_ols_request()))
    assert proc.returncode == 0
    assert proc.stderr == ""
    payload = json.loads(proc.stdout)
    assert payload["protocolVersion"] == 4
    assert payload["regression"]["estimation"] == "ok"
    assert len(payload["regression"]["terms"]) == 2


def test_analyze_process_regression_invalid_shape_emits_marker_and_exit1():
    bad_request = {
        "protocolVersion": 4,
        "regression": {"family": "gaussian", "y": [1.0, 2.0], "X": [[1.0]], "columnNames": ["intercept"], "covariance": {"type": "hc3"}},
    }
    proc = _run_analyze(json.dumps(bad_request))
    assert proc.returncode == 1
    assert proc.stdout == ""
    assert "STATS_ENGINE_ERROR" in proc.stderr


def test_analyze_process_regression_non_estimable_still_exits_0():
    """non_estimable(예: 분리)은 프로토콜 오류가 아니다 — 정상 종료(exit 0)에
    담겨야 한다(리뷰 #9 — 엔진 오류로 오인하면 안 되는 정상 응답)."""
    n = 50
    x1 = [-100.0, -1.0, 1.0, 2.0, 3.0] * 10
    y = [0.0, 0.0, 1.0, 1.0, 1.0] * 10
    request = {
        "protocolVersion": 4,
        "regression": {
            "family": "binomial", "y": y, "X": [[1.0, v] for v in x1],
            "columnNames": ["intercept", "x1"], "covariance": {"type": "hc3"},
        },
    }
    proc = _run_analyze(json.dumps(request))
    assert proc.returncode == 0
    payload = json.loads(proc.stdout)
    assert payload["regression"]["estimation"] == "non_estimable"
    assert payload["regression"]["nonEstimableReason"] == "SEPARATION_DETECTED"
    assert payload["regression"]["terms"] == []
