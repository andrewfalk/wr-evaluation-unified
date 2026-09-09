"""stats-engine 프로토콜 — 입력 검증 + 상한 상수.

상한 3종(MAX_VALUES_PER_VARIABLE/MAX_TOTAL_VALUES/MAX_STRING_LENGTH)은
server/src/statsEngineLimits.ts의 같은 이름 상수와 값이 반드시 일치해야 한다
(PR1 계획 §1.1/§7.3 — 두 값이 갈리면 Node가 통과시킨 요청을 Python이 거부하는
결함이 생긴다). 이 세 값은 PR1에서 환경변수로 바꿀 수 없다 — 바꾸려면 이 파일과
statsEngineLimits.ts를 함께 코드 변경+재배포해야 한다.
"""
from __future__ import annotations

import json
from typing import Any

import jsonschema

MAX_VALUES_PER_VARIABLE = 50000
MAX_TOTAL_VALUES = 350000
MAX_STRING_LENGTH = 200

REQUEST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["protocolVersion", "variables"],
    "additionalProperties": False,
    "properties": {
        "protocolVersion": {"const": 1},
        "variables": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["key", "kind", "values"],
                "additionalProperties": False,
                "properties": {
                    "key": {"type": "string", "minLength": 1},
                    "kind": {"enum": ["continuous", "discrete"]},
                    "values": {
                        "type": "array",
                        "maxItems": MAX_VALUES_PER_VARIABLE,
                        "items": {
                            "anyOf": [
                                {"type": "number"},
                                {"type": "string", "maxLength": MAX_STRING_LENGTH},
                                {"type": "boolean"},
                            ]
                        },
                    },
                },
            },
        },
    },
}


class ProtocolError(Exception):
    """code는 STATS_ENGINE_ERROR 마커의 code 필드로 그대로 나간다."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def parse_and_validate_request(raw: str) -> dict[str, Any]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ProtocolError("INVALID_INPUT", f"stdin이 유효한 JSON이 아님: {exc}") from exc

    try:
        jsonschema.validate(instance=data, schema=REQUEST_SCHEMA)
    except jsonschema.ValidationError as exc:
        raise ProtocolError("INVALID_INPUT", f"입력 스키마 위반: {exc.message}") from exc

    # jsonschema의 변수별 maxItems만으로는 "전체 변수의 값 개수 합" 상한을 표현할 수
    # 없다 — 구조 검증 통과 후 별도로 누적합을 검사한다(PR1 계획 §1.1).
    total_values = sum(len(v["values"]) for v in data["variables"])
    if total_values > MAX_TOTAL_VALUES:
        raise ProtocolError(
            "LIMIT_EXCEEDED",
            f"전체 변수의 값 개수 합({total_values})이 상한({MAX_TOTAL_VALUES})을 초과",
        )

    return data
