"""protocol.py의 이변량 shape 검증(oneOf 구조검사 + _validate_bivariate_semantics
교차필드 검증) 단위테스트 + analyze.py 프로세스 계약(stdin/stdout/stderr) 이변량
경로 end-to-end 테스트."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from protocol import MAX_VALUES_PER_VARIABLE, ProtocolError, parse_and_validate_request


def _welch_t_request(n1=5, n2=5):
    return {
        "protocolVersion": 2,
        "bivariate": {
            "method": "welch_t",
            "groups": [
                {"label": False, "values": [float(i) for i in range(n1)]},
                {"label": True, "values": [float(i + 10) for i in range(n2)]},
            ],
        },
    }


def test_valid_groups_request_parses():
    data = parse_and_validate_request(json.dumps(_welch_t_request()))
    assert data["bivariate"]["method"] == "welch_t"


def test_valid_table_request_parses():
    request = {
        "protocolVersion": 2,
        "bivariate": {
            "method": "chi_square",
            "table": [[10, 5], [3, 12]],
            "rowLabels": [False, True],
            "colLabels": ["a", "b"],
        },
    }
    parse_and_validate_request(json.dumps(request))


def test_valid_correlation_request_parses():
    request = {
        "protocolVersion": 2,
        "bivariate": {
            "method": "pearson_correlation",
            "x": [1.0, 2.0, 3.0],
            "y": [2.0, 4.0, 6.0],
        },
    }
    parse_and_validate_request(json.dumps(request))


def test_wrong_protocol_version_rejected():
    request = _welch_t_request()
    request["protocolVersion"] = 1
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_variables_and_bivariate_mutually_exclusive():
    request = _welch_t_request()
    request["variables"] = []
    with pytest.raises(ProtocolError):
        parse_and_validate_request(json.dumps(request))


def test_welch_t_requires_exactly_two_groups():
    request = _welch_t_request()
    request["bivariate"]["groups"].append({"label": "extra", "values": [1.0, 2.0]})
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_anova_allows_more_than_two_groups():
    request = {
        "protocolVersion": 2,
        "bivariate": {
            "method": "anova",
            "groups": [
                {"label": "a", "values": [1.0, 2.0, 3.0]},
                {"label": "b", "values": [4.0, 5.0, 6.0]},
                {"label": "c", "values": [7.0, 8.0, 9.0]},
            ],
        },
    }
    parse_and_validate_request(json.dumps(request))


def test_duplicate_group_labels_rejected():
    request = _welch_t_request()
    request["bivariate"]["groups"][1]["label"] = False  # groups[0]과 동일 라벨
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_groups_total_values_exceeds_limit_rejected():
    request = {
        "protocolVersion": 2,
        "bivariate": {
            "method": "welch_t",
            "groups": [
                {"label": False, "values": [1.0] * (MAX_VALUES_PER_VARIABLE // 2 + 1)},
                {"label": True, "values": [1.0] * (MAX_VALUES_PER_VARIABLE // 2 + 1)},
            ],
        },
    }
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "LIMIT_EXCEEDED"


def test_table_not_rectangular_rejected():
    request = {
        "protocolVersion": 2,
        "bivariate": {
            "method": "chi_square",
            "table": [[10, 5, 1], [3, 12]],
            "rowLabels": ["r1", "r2"],
            "colLabels": ["c1", "c2", "c3"],
        },
    }
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_fisher_exact_requires_2x2():
    request = {
        "protocolVersion": 2,
        "bivariate": {
            "method": "fisher_exact",
            "table": [[10, 5, 1], [3, 12, 2]],
            "rowLabels": ["r1", "r2"],
            "colLabels": ["c1", "c2", "c3"],
        },
    }
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_correlation_requires_equal_length_x_y():
    request = {
        "protocolVersion": 2,
        "bivariate": {
            "method": "pearson_correlation",
            "x": [1.0, 2.0, 3.0],
            "y": [2.0, 4.0],
        },
    }
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_wrong_shape_for_method_rejected():
    # chi_square인데 groups를 보냄 — 방법별 허용 shape 불일치.
    request = {
        "protocolVersion": 2,
        "bivariate": {
            "method": "chi_square",
            "groups": [
                {"label": "a", "values": [1.0, 2.0]},
                {"label": "b", "values": [3.0, 4.0]},
            ],
        },
    }
    with pytest.raises(ProtocolError):
        parse_and_validate_request(json.dumps(request))


# ---------------------------------------------------------------------------
# analyze.py — 이변량 경로 end-to-end(stdin/stdout/stderr 프로세스 계약)
# ---------------------------------------------------------------------------

def _run_analyze(stdin_text: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(Path(__file__).parent / "analyze.py")],
        input=stdin_text, capture_output=True, text=True, timeout=30,
    )


def test_analyze_process_bivariate_success():
    proc = _run_analyze(json.dumps(_welch_t_request()))
    assert proc.returncode == 0
    assert proc.stderr == ""
    payload = json.loads(proc.stdout)
    assert payload["protocolVersion"] == 2
    assert payload["bivariate"]["method"] == "welch_t"
    assert payload["bivariate"]["n"] == 10
    assert payload["bivariate"]["pValue"] is not None


def test_analyze_process_bivariate_invalid_shape_emits_marker_and_exit1():
    bad_request = {
        "protocolVersion": 2,
        "bivariate": {"method": "welch_t", "groups": [{"label": "only-one", "values": [1.0, 2.0]}]},
    }
    proc = _run_analyze(json.dumps(bad_request))
    assert proc.returncode == 1
    assert proc.stdout == ""
    assert "STATS_ENGINE_ERROR" in proc.stderr
