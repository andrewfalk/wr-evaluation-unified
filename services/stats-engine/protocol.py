"""stats-engine 프로토콜 — 입력 검증 + 상한 상수.

상한 3종(MAX_VALUES_PER_VARIABLE/MAX_TOTAL_VALUES/MAX_STRING_LENGTH)은
server/src/statsEngineLimits.ts의 같은 이름 상수와 값이 반드시 일치해야 한다
(PR1 계획 §1.1/§7.3 — 두 값이 갈리면 Node가 통과시킨 요청을 Python이 거부하는
결함이 생긴다). 이 세 값은 PR1에서 환경변수로 바꿀 수 없다 — 바꾸려면 이 파일과
statsEngineLimits.ts를 함께 코드 변경+재배포해야 한다.

PR3-A — protocolVersion을 2로 상향하고 이변량 요청 shape(`bivariate`)을
`variables`와 상호배타(oneOf)로 추가했다(계획서 § "Node→Python 3-shape").
Node가 그룹핑/교차집계까지 전부 끝낸 뒤 보내므로, 이 파일은 여전히 person 단위
소수 셀 판정이나 카탈로그 조회를 하지 않는다 — 순수 shape·상한 검증뿐이다.
"""
from __future__ import annotations

import json
import math
from typing import Any

import jsonschema

MAX_VALUES_PER_VARIABLE = 50000
MAX_TOTAL_VALUES = 350000
MAX_STRING_LENGTH = 200

BIVARIATE_METHODS = (
    "welch_t", "mann_whitney", "anova", "kruskal_wallis",
    "chi_square", "fisher_exact",
    "pearson_correlation", "spearman_correlation",
)
_GROUP_COMPARISON_METHODS = ("welch_t", "mann_whitney", "anova", "kruskal_wallis")
_CONTINGENCY_METHODS = ("chi_square", "fisher_exact")
_CORRELATION_METHODS = ("pearson_correlation", "spearman_correlation")

_LABEL_SCHEMA = {"anyOf": [{"type": "string"}, {"type": "boolean"}]}

_VARIABLES_REQUEST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["protocolVersion", "variables"],
    "additionalProperties": False,
    "properties": {
        "protocolVersion": {"const": 2},
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

_BIVARIATE_REQUEST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["protocolVersion", "bivariate"],
    "additionalProperties": False,
    "properties": {
        "protocolVersion": {"const": 2},
        "bivariate": {
            "type": "object",
            "required": ["method"],
            "additionalProperties": False,
            "properties": {
                "method": {"enum": list(BIVARIATE_METHODS)},
                "groups": {
                    "type": "array",
                    "minItems": 2,
                    "items": {
                        "type": "object",
                        "required": ["label", "values"],
                        "additionalProperties": False,
                        "properties": {
                            "label": _LABEL_SCHEMA,
                            "values": {"type": "array", "items": {"type": "number"}},
                        },
                    },
                },
                "table": {
                    "type": "array",
                    "items": {"type": "array", "items": {"type": "integer", "minimum": 0}},
                },
                "rowLabels": {"type": "array", "items": _LABEL_SCHEMA},
                "colLabels": {"type": "array", "items": _LABEL_SCHEMA},
                "x": {"type": "array", "items": {"type": "number"}},
                "y": {"type": "array", "items": {"type": "number"}},
            },
        },
    },
}

REQUEST_SCHEMA: dict[str, Any] = {"oneOf": [_VARIABLES_REQUEST_SCHEMA, _BIVARIATE_REQUEST_SCHEMA]}


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

    if "variables" in data:
        # jsonschema의 변수별 maxItems만으로는 "전체 변수의 값 개수 합" 상한을 표현할 수
        # 없다 — 구조 검증 통과 후 별도로 누적합을 검사한다(PR1 계획 §1.1).
        total_values = sum(len(v["values"]) for v in data["variables"])
        if total_values > MAX_TOTAL_VALUES:
            raise ProtocolError(
                "LIMIT_EXCEEDED",
                f"전체 변수의 값 개수 합({total_values})이 상한({MAX_TOTAL_VALUES})을 초과",
            )
        return data

    _validate_bivariate_semantics(data["bivariate"])
    return data


def _validate_bivariate_semantics(bivariate: dict[str, Any]) -> None:
    """oneOf 스키마가 표현 못 하는 교차 필드 검증 — PR3-A 계획서 §"새 프로토콜의
    입력상한·의미검증" 표를 그대로 구현한다. method별로 정확히 하나의 shape
    (groups | table+rowLabels+colLabels | x+y)만 허용한다."""
    method = bivariate["method"]
    groups, table = bivariate.get("groups"), bivariate.get("table")
    row_labels, col_labels = bivariate.get("rowLabels"), bivariate.get("colLabels")
    x, y = bivariate.get("x"), bivariate.get("y")

    if method in _GROUP_COMPARISON_METHODS:
        if groups is None or table is not None or x is not None or y is not None:
            raise ProtocolError("INVALID_INPUT", f"method '{method}'는 groups만 받는다")
        if method in ("welch_t", "mann_whitney") and len(groups) != 2:
            raise ProtocolError("INVALID_INPUT", f"method '{method}'는 groups가 정확히 2개여야 한다")
        total = sum(len(g["values"]) for g in groups)
        if total > MAX_VALUES_PER_VARIABLE:
            raise ProtocolError(
                "LIMIT_EXCEEDED",
                f"groups 전체 값 개수 합({total})이 상한({MAX_VALUES_PER_VARIABLE})을 초과",
            )
        labels = [g["label"] for g in groups]
        if len(labels) != len(set(labels)):
            raise ProtocolError("INVALID_INPUT", "groups의 label이 중복된다")
        for g in groups:
            if not all(_is_finite_number(v) for v in g["values"]):
                raise ProtocolError("INVALID_INPUT", "groups 값에 유한하지 않은 수가 있다")

    elif method in _CONTINGENCY_METHODS:
        if table is None or row_labels is None or col_labels is None or groups is not None or x is not None or y is not None:
            raise ProtocolError("INVALID_INPUT", f"method '{method}'는 table+rowLabels+colLabels만 받는다")
        if len(table) != len(row_labels):
            raise ProtocolError("INVALID_INPUT", "table 행 수가 rowLabels 길이와 다르다")
        if any(len(row) != len(col_labels) for row in table):
            raise ProtocolError("INVALID_INPUT", "table이 직사각형이 아니다(각 행 길이가 colLabels 길이와 달라야 함)")
        cell_sum = sum(sum(row) for row in table)
        if cell_sum > MAX_VALUES_PER_VARIABLE:
            raise ProtocolError(
                "LIMIT_EXCEEDED",
                f"table 셀 합계({cell_sum})가 상한({MAX_VALUES_PER_VARIABLE})을 초과",
            )
        if method == "fisher_exact" and (len(table) != 2 or len(col_labels) != 2):
            raise ProtocolError("INVALID_INPUT", "fisher_exact는 2×2 표만 지원한다")

    elif method in _CORRELATION_METHODS:
        if x is None or y is None or groups is not None or table is not None:
            raise ProtocolError("INVALID_INPUT", f"method '{method}'는 x+y만 받는다")
        if len(x) != len(y):
            raise ProtocolError("INVALID_INPUT", "x와 y의 길이가 다르다")
        if len(x) > MAX_VALUES_PER_VARIABLE:
            raise ProtocolError(
                "LIMIT_EXCEEDED",
                f"x/y 값 개수({len(x)})가 상한({MAX_VALUES_PER_VARIABLE})을 초과",
            )
        if not all(_is_finite_number(v) for v in x) or not all(_is_finite_number(v) for v in y):
            raise ProtocolError("INVALID_INPUT", "x/y 값에 유한하지 않은 수가 있다")


def _is_finite_number(value: Any) -> bool:
    """JSON 파싱 직후엔 bool이 int의 서브클래스라 isinstance(True, int)==True —
    명시적으로 bool을 제외한다."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
