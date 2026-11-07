"""analyze.py 계측(P0-13) — STATS_ENGINE_TIMING이 꺼져 있으면 stderr가 비고, 켜면 표식 한 줄만 더한다.
stdout 결과는 켜든 끄든 같아야 한다(계측이 결과 계약을 바꾸지 않음)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

import analyze

_REQUEST = {
    "protocolVersion": 6,
    "variables": [
        {"key": "t.continuous", "kind": "continuous", "values": [1.0, 2.0, 3.0, 4.0, 5.0]},
        {"key": "t.discrete", "kind": "discrete", "values": ["a", "b", "a"]},
    ],
}


def _run(timing: str | None, request: dict) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k != "STATS_ENGINE_TIMING"}
    if timing is not None:
        env["STATS_ENGINE_TIMING"] = timing
    return subprocess.run(
        [sys.executable, str(Path(__file__).parent / "analyze.py")],
        input=json.dumps(request), capture_output=True, text=True, timeout=60, env=env,
    )


def test_timing_off_writes_nothing_to_stderr():
    proc = _run(None, _REQUEST)
    assert proc.returncode == 0
    assert proc.stderr == ""


def test_timing_value_other_than_1_stays_off():
    proc = _run("true", _REQUEST)
    assert proc.returncode == 0
    assert proc.stderr == ""


def test_timing_on_adds_one_marker_line_and_keeps_stdout_identical():
    off = _run(None, _REQUEST)
    on = _run("1", _REQUEST)
    assert on.returncode == 0
    assert on.stdout == off.stdout
    lines = on.stderr.strip().splitlines()
    assert len(lines) == 1
    assert lines[0].startswith("STATS_ENGINE_TIMING ")
    timing = json.loads(lines[0][len("STATS_ENGINE_TIMING "):])
    assert timing["mode"] == "descriptive"
    for key in ("importMs", "stdinMs", "parseMs", "computeMs", "serializeMs", "processMs"):
        assert isinstance(timing[key], (int, float)) and timing[key] >= 0, key
    assert timing["processMs"] >= timing["importMs"]
    assert timing["processStartWallMs"] > 1_600_000_000_000


def test_timing_on_failure_emits_only_the_error_marker():
    proc = _run("1", {"protocolVersion": 6, "bivariate": {"method": "welch_t", "groups": []}})
    assert proc.returncode == 1
    assert proc.stdout == ""
    assert "STATS_ENGINE_ERROR" in proc.stderr
    assert "STATS_ENGINE_TIMING" not in proc.stderr


@pytest.mark.parametrize(
    "request_body,expected",
    [
        ({"correlationMatrix": {}}, "correlationMatrix"),
        ({"regression": {}}, "regression"),
        ({"regressionDiagnostics": {}}, "regressionDiagnostics"),
        ({"prediction": {}}, "prediction"),
        ({"bivariate": {}}, "bivariate"),
        ({"variables": []}, "descriptive"),
        ({"correlationMatrix": {}, "bivariate": {}}, "correlationMatrix"),
    ],
)
def test_analysis_mode_follows_run_analysis_branch_order(request_body, expected):
    assert analyze.analysis_mode(request_body) == expected
