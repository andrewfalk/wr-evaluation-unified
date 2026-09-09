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

from descriptive import compute_continuous, compute_discrete
from protocol import ProtocolError, parse_and_validate_request

PROTOCOL_VERSION = 1


def _emit_error(code: str, detail: str) -> None:
    marker = {"code": code, "detail": detail}
    print(f"STATS_ENGINE_ERROR {json.dumps(marker, ensure_ascii=False)}", file=sys.stderr)


def run_analysis(request: dict[str, Any]) -> dict[str, Any]:
    continuous: list[dict[str, Any]] = []
    discrete: list[dict[str, Any]] = []

    for variable in request["variables"]:
        key = variable["key"]
        kind = variable["kind"]
        values = variable["values"]
        if kind == "continuous":
            stat = compute_continuous(values)
            continuous.append({"variableKey": key, **stat})
        else:
            stat = compute_discrete(values)
            discrete.append({"variableKey": key, **stat})

    return {"protocolVersion": PROTOCOL_VERSION, "continuous": continuous, "discrete": discrete}


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
            "protocolVersion": 1,
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
