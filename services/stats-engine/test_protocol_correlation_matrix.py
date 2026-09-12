"""protocol.py의 상관행렬 shape 검증(oneOf 구조검사 +
_validate_correlation_matrix_semantics 교차필드 검증) 단위테스트 + analyze.py
프로세스 계약(stdin/stdout/stderr) 상관행렬 경로 end-to-end 테스트 —
test_protocol_bivariate.py와 동일 패턴(계획서 §4/§7)."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from protocol import MAX_VALUES_PER_VARIABLE, ProtocolError, parse_and_validate_request


def _correlation_matrix_request(k=3, n=10, method="pearson_correlation"):
    return {
        "protocolVersion": 3,
        "correlationMatrix": {
            "method": method,
            "variables": [
                {"key": f"v{i}", "values": [float(row + i) for row in range(n)]}
                for i in range(k)
            ],
        },
    }


def test_valid_correlation_matrix_request_parses():
    data = parse_and_validate_request(json.dumps(_correlation_matrix_request()))
    assert data["correlationMatrix"]["method"] == "pearson_correlation"
    assert len(data["correlationMatrix"]["variables"]) == 3


def test_requires_at_least_three_variables():
    request = _correlation_matrix_request(k=2)
    with pytest.raises(ProtocolError):
        parse_and_validate_request(json.dumps(request))


def test_values_may_contain_null():
    request = _correlation_matrix_request()
    request["correlationMatrix"]["variables"][0]["values"][2] = None
    parse_and_validate_request(json.dumps(request))  # 예외 없이 통과해야 함


def test_duplicate_variable_keys_rejected():
    request = _correlation_matrix_request()
    request["correlationMatrix"]["variables"][1]["key"] = request["correlationMatrix"]["variables"][0]["key"]
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_mismatched_value_array_lengths_rejected():
    request = _correlation_matrix_request()
    request["correlationMatrix"]["variables"][0]["values"].append(999.0)
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_non_finite_value_rejected():
    request = _correlation_matrix_request()
    request["correlationMatrix"]["variables"][0]["values"][0] = float("inf")
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_total_values_exceeds_limit_rejected():
    from protocol import MAX_TOTAL_VALUES

    # 변수별로는 MAX_VALUES_PER_VARIABLE(jsonschema maxItems) 이하지만, 변수 수를
    # 늘려 전체 합만 MAX_TOTAL_VALUES를 넘긴다 — test_descriptive.py의
    # test_max_total_values_rejects_when_per_variable_ok_but_sum_exceeds()와
    # 동일한 접근.
    k = MAX_TOTAL_VALUES // MAX_VALUES_PER_VARIABLE + 2
    request = _correlation_matrix_request(k=k, n=MAX_VALUES_PER_VARIABLE)
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "LIMIT_EXCEEDED"


def test_unsupported_method_rejected():
    request = _correlation_matrix_request()
    request["correlationMatrix"]["method"] = "welch_t"
    with pytest.raises(ProtocolError):
        parse_and_validate_request(json.dumps(request))


def test_variables_bivariate_correlation_matrix_mutually_exclusive():
    request = _correlation_matrix_request()
    request["variables"] = []
    with pytest.raises(ProtocolError):
        parse_and_validate_request(json.dumps(request))


def test_stale_protocol_version_2_rejected():
    request = _correlation_matrix_request()
    request["protocolVersion"] = 2
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


# ---------------------------------------------------------------------------
# analyze.py — 상관행렬 경로 end-to-end(stdin/stdout/stderr 프로세스 계약)
# ---------------------------------------------------------------------------

def _run_analyze(stdin_text: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(Path(__file__).parent / "analyze.py")],
        input=stdin_text, capture_output=True, text=True, timeout=30,
    )


def test_analyze_process_correlation_matrix_success():
    proc = _run_analyze(json.dumps(_correlation_matrix_request(k=4, n=20)))
    assert proc.returncode == 0
    assert proc.stderr == ""
    payload = json.loads(proc.stdout)
    assert payload["protocolVersion"] == 3
    assert payload["correlationMatrix"]["method"] == "pearson_correlation"
    assert len(payload["correlationMatrix"]["cells"]) == 6  # C(4,2)


def test_analyze_process_correlation_matrix_invalid_shape_emits_marker_and_exit1():
    bad_request = {
        "protocolVersion": 3,
        "correlationMatrix": {"method": "pearson_correlation", "variables": []},
    }
    proc = _run_analyze(json.dumps(bad_request))
    assert proc.returncode == 1
    assert proc.stdout == ""
    assert "STATS_ENGINE_ERROR" in proc.stderr
