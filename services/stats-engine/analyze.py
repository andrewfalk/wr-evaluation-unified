#!/usr/bin/env python3
"""stats-engine 진입점 — stdin(JSON) → stdout(JSON), 또는 --selfcheck.

계약(PR1 계획서 §1.1/§1.2):
  - 성공 시에만 stdout에 정확히 한 덩어리의 JSON을 쓴다.
  - 실패 시 stdout에는 아무것도 쓰지 않고 stderr에
    `STATS_ENGINE_ERROR {"code":...,"detail":...}` 마커 한 줄을 쓴 뒤 exit 1.
  - 로그(디버그용)는 stderr에만 쓴다 — stdout은 오직 결과 payload 전용.
"""
from __future__ import annotations

import json
import sys
from typing import Any

import bivariate
import correlation_matrix as correlation_matrix_module
from boxplot import compute_boxplot
from descriptive import compute_continuous, compute_discrete
from histogram import compute_histogram
from protocol import ProtocolError, parse_and_validate_request

PROTOCOL_VERSION = 3

_BIVARIATE_DISPATCH = {
    "welch_t": lambda b: bivariate.welch_t(b["groups"]),
    "mann_whitney": lambda b: bivariate.mann_whitney(b["groups"]),
    "anova": lambda b: bivariate.anova(b["groups"]),
    "kruskal_wallis": lambda b: bivariate.kruskal_wallis(b["groups"]),
    "chi_square": lambda b: bivariate.chi_square(b["table"]),
    "fisher_exact": lambda b: bivariate.fisher_exact(b["table"]),
    "pearson_correlation": lambda b: bivariate.pearson_correlation(b["x"], b["y"]),
    "spearman_correlation": lambda b: bivariate.spearman_correlation(b["x"], b["y"]),
}


def _emit_error(code: str, detail: str) -> None:
    marker = {"code": code, "detail": detail}
    print(f"STATS_ENGINE_ERROR {json.dumps(marker, ensure_ascii=False)}", file=sys.stderr)


def run_descriptive(request: dict[str, Any]) -> dict[str, Any]:
    continuous: list[dict[str, Any]] = []
    discrete: list[dict[str, Any]] = []

    for variable in request["variables"]:
        key = variable["key"]
        kind = variable["kind"]
        values = variable["values"]
        if kind == "continuous":
            stat = compute_continuous(values)
            # PR3-B — q1/q3/median이 계산 가능할 때만(n>=1) histogram/boxplot을
            # 만든다. n=0이면 둘 다 None(계획서 §2/§3 — Q1/Q3 재사용 원칙).
            if stat["q1"] is not None and stat["q3"] is not None and stat["median"] is not None:
                stat["histogram"] = compute_histogram(values, stat["q1"], stat["q3"])
                stat["boxplot"] = compute_boxplot(values, stat["q1"], stat["median"], stat["q3"])
            else:
                stat["histogram"] = None
                stat["boxplot"] = None
            continuous.append({"variableKey": key, **stat})
        else:
            stat = compute_discrete(values)
            discrete.append({"variableKey": key, **stat})

    return {"protocolVersion": PROTOCOL_VERSION, "continuous": continuous, "discrete": discrete}


def run_bivariate(request: dict[str, Any]) -> dict[str, Any]:
    b = request["bivariate"]
    method = b["method"]
    result = _BIVARIATE_DISPATCH[method](b)
    return {"protocolVersion": PROTOCOL_VERSION, "bivariate": {"method": method, **result}}


def run_correlation_matrix(request: dict[str, Any]) -> dict[str, Any]:
    cm = request["correlationMatrix"]
    result = correlation_matrix_module.compute_correlation_matrix(cm["method"], cm["variables"])
    return {"protocolVersion": PROTOCOL_VERSION, "correlationMatrix": result}


def run_analysis(request: dict[str, Any]) -> dict[str, Any]:
    if "correlationMatrix" in request:
        return run_correlation_matrix(request)
    if "bivariate" in request:
        return run_bivariate(request)
    return run_descriptive(request)


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--selfcheck":
        return _selfcheck()

    try:
        raw = sys.stdin.read()
        request = parse_and_validate_request(raw)
        response = run_analysis(request)
    except ProtocolError as exc:
        _emit_error(exc.code, exc.detail)
        return 1
    except Exception as exc:  # noqa: BLE001 — 예상 못 한 예외도 마커로 승격해서 알린다
        _emit_error("COMPUTE_ERROR", f"{type(exc).__name__}: {exc}")
        return 1

    sys.stdout.write(json.dumps(response, ensure_ascii=False))
    sys.stdout.flush()
    return 0


def _selfcheck() -> int:
    """numpy/scipy import 확인 + 고정 픽스처 1건을 실제로 돌려 응답 shape을 확인."""
    try:
        fixture = {
            "protocolVersion": PROTOCOL_VERSION,
            "variables": [
                {"key": "selfcheck.continuous", "kind": "continuous", "values": [1.0, 2.0, 3.0, 4.0, 5.0]},
                {"key": "selfcheck.discrete", "kind": "discrete", "values": ["a", "b", "a"]},
            ],
        }
        response = run_analysis(fixture)
        assert len(response["continuous"]) == 1
        assert len(response["discrete"]) == 1
        assert response["continuous"][0]["n"] == 5
        assert response["discrete"][0]["n"] == 3
        print("stats-engine selfcheck OK", file=sys.stderr)
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"stats-engine selfcheck FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
