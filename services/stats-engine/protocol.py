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

PR3-B — protocolVersion을 3으로 상향하고 상관행렬 요청 shape(`correlationMatrix`)
을 기존 두 shape과 상호배타(oneOf)로 추가했다(계획서 §4 "Node-Python 연결계층").
`_validate_bivariate_semantics`와 동일하게, oneOf 스키마가 표현 못 하는 교차필드
검증(변수 키 중복·길이 일치 등)은 `_validate_correlation_matrix_semantics`로
분리한다 — jsonschema의 `uniqueItems`는 객체 전체 비교라 "같은 key, 다른 values"
를 못 잡으므로 `key`만 뽑아 별도로 중복 검사한다.

PR4-A1 — protocolVersion을 4로 상향하고 회귀 요청 shape(`regression`)을 네
번째 상호배타 shape으로 추가했다(계획서 pr4-a-lexical-reddy.md §3). Node가
설계행렬(y·X·columnNames, 더미 인코딩 완료)을 만들어 보내고 Python은 순수
수치 계산만 한다 — 계수·소수셀 판정에 필요한 person 신원은 이 요청 shape에
없다(원칙 유지). `X`는 row-major 2차원 배열(N행×P열)이고, 각 행의 길이가
`columnNames`와 일치해야 한다(구조 검증 밖 — `_validate_regression_semantics`).

PR4-A2 — protocolVersion을 5로 상향한다. `regression` shape에 선택적
`splineContrasts`를 추가한다(Node가 spline 기저로 만든 대비행렬 — 계획서
§3 "spline 부분효과", Python은 spline을 모르고 대비 벡터만 평가한다).
다섯 번째 상호배타 shape `regressionDiagnostics`도 추가한다 — 재적합 없이
이미 주어진 β로 leverage/잔차/Cook's D만 계산하는 경량 경로(계획서 §4
"limited_row 진단값" — 캐시 hit/miss와 무관하게 독립적으로 호출된다).

PR4-B2 — protocolVersion을 6으로 상향한다. 여섯 번째 상호배타 shape
`prediction`을 추가한다(계획서 async-riding-hennessy.md §4단계). Node가
완전사례 설계행렬(y·X, full one-hot, 절편 미포함)과 person 그룹 라벨
(cohortPersonKey를 그대로), 외부 fold 배정(R×N)을 만들어 보낸다 — Python은
정책값(람다 격자·반복 수 등)을 전혀 모르는 순수 함수다(config로 전부 받는다).
"""
from __future__ import annotations

import json
import math
from typing import Any

import jsonschema

MAX_VALUES_PER_VARIABLE = 50000
MAX_TOTAL_VALUES = 350000
MAX_STRING_LENGTH = 200
# PR4-A2 — spline 부분효과 그리드 상한(§2 "예측 그리드(약 40점)"). server/src/
# statsEngineLimits.ts의 같은 이름 상수와 값이 반드시 일치해야 한다(위 세
# 상수와 같은 원칙 — statsEngineLimits.consistency.test.ts가 대조한다).
MAX_SPLINE_CONTRAST_POINTS = 60

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
        "protocolVersion": {"const": 6},
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
                    # histogram bin 개수(Freedman-Diaconis/Sturges) 계산 전용 힌트 — Node가
                    # values(행 수, 브로드캐스트면 중복 포함)와 별도로 실제 서로 다른 인원 수를
                    # 계산해 넘긴다(continuous에서만, server/src/statsEngine.ts 참고). person
                    # 신원 자체는 여전히 모른다 — 개수 하나만 받는다.
                    "personCount": {"type": "integer", "minimum": 0},
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
        "protocolVersion": {"const": 6},
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

_CORRELATION_MATRIX_METHODS = ("pearson_correlation", "spearman_correlation")

_CORRELATION_MATRIX_REQUEST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["protocolVersion", "correlationMatrix"],
    "additionalProperties": False,
    "properties": {
        "protocolVersion": {"const": 6},
        "correlationMatrix": {
            "type": "object",
            "required": ["method", "variables"],
            "additionalProperties": False,
            "properties": {
                "method": {"enum": list(_CORRELATION_MATRIX_METHODS)},
                "variables": {
                    "type": "array",
                    "minItems": 3,
                    "items": {
                        "type": "object",
                        "required": ["key", "values"],
                        "additionalProperties": False,
                        "properties": {
                            "key": {"type": "string", "minLength": 1},
                            "values": {
                                # row-aligned — 결측은 null(pairwise-complete
                                # 필터링은 Python이 pair마다 수행한다).
                                "type": "array",
                                "maxItems": MAX_VALUES_PER_VARIABLE,
                                "items": {"anyOf": [{"type": "number"}, {"type": "null"}]},
                            },
                        },
                    },
                },
            },
        },
    },
}

_REGRESSION_FAMILIES = ("gaussian", "binomial")
_REGRESSION_COVARIANCE_TYPES = ("hc3", "cluster")

# PR4-A1 — 회귀 요청 shape. y/X는 완전사례(결측 없음)로 이미 걸러진 숫자 배열 —
# Node가 더미 인코딩·기준 레벨 해석까지 전부 끝낸 뒤 보낸다. covariance.groups는
# cluster일 때만 필수(person 클러스터 키를 Node가 익명 라벨로 바꿔 보낸다 —
# 이 파일은 person 신원을 모른다는 원칙 그대로, 그냥 그룹 등가류 라벨일 뿐).
_REGRESSION_REQUEST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["protocolVersion", "regression"],
    "additionalProperties": False,
    "properties": {
        "protocolVersion": {"const": 6},
        "regression": {
            "type": "object",
            "required": ["family", "y", "X", "columnNames", "covariance"],
            "additionalProperties": False,
            "properties": {
                "family": {"enum": list(_REGRESSION_FAMILIES)},
                "y": {
                    "type": "array",
                    "maxItems": MAX_VALUES_PER_VARIABLE,
                    "items": {"type": "number"},
                },
                "X": {
                    "type": "array",
                    "maxItems": MAX_VALUES_PER_VARIABLE,
                    "items": {"type": "array", "items": {"type": "number"}},
                },
                "columnNames": {"type": "array", "items": {"type": "string", "minLength": 1}},
                "covariance": {
                    "type": "object",
                    "required": ["type"],
                    "additionalProperties": False,
                    "properties": {
                        "type": {"enum": list(_REGRESSION_COVARIANCE_TYPES)},
                        "groups": {"type": "array", "items": {"type": "string"}},
                    },
                },
                # PR4-A2 — spline predictor별 대비행렬(§3 "spline 부분효과"). 생략
                # 가능(빈 배열과 동치) — v1은 spline 없는 회귀가 훨씬 많다.
                "splineContrasts": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["variableKey", "contrastMatrix"],
                        "additionalProperties": False,
                        "properties": {
                            "variableKey": {"type": "string", "minLength": 1},
                            "contrastMatrix": {
                                "type": "array",
                                "maxItems": MAX_SPLINE_CONTRAST_POINTS,
                                "items": {"type": "array", "items": {"type": "number"}},
                            },
                        },
                    },
                },
            },
        },
    },
}

# PR4-A2 — 경량 진단 전용 요청(재적합 없음). X·y·columnNames는 회귀 shape과
# 같은 규칙이지만 covariance는 필요 없다(공분산은 이미 최초 적합에서 나온
# 값을 쓰지 않고, 이 경로 자체가 diagnostics만 계산한다 — h/잔차/Cook's D는
# β만 있으면 된다). sampledRowIndices는 Node가 미리 정한 표본 — 계산은 X
# 전체로 하되 출력은 이 행만 직렬화한다(계획서 §4 "출력은 sampledRowIndices
# 행만 직렬화").
_REGRESSION_DIAGNOSTICS_REQUEST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["protocolVersion", "regressionDiagnostics"],
    "additionalProperties": False,
    "properties": {
        "protocolVersion": {"const": 6},
        "regressionDiagnostics": {
            "type": "object",
            "required": ["family", "y", "X", "columnNames", "beta", "sampledRowIndices"],
            "additionalProperties": False,
            "properties": {
                "family": {"enum": list(_REGRESSION_FAMILIES)},
                "y": {
                    "type": "array",
                    "maxItems": MAX_VALUES_PER_VARIABLE,
                    "items": {"type": "number"},
                },
                "X": {
                    "type": "array",
                    "maxItems": MAX_VALUES_PER_VARIABLE,
                    "items": {"type": "array", "items": {"type": "number"}},
                },
                "columnNames": {"type": "array", "items": {"type": "string", "minLength": 1}},
                "beta": {"type": "array", "items": {"type": "number"}},
                "sampledRowIndices": {
                    "type": "array",
                    "items": {"type": "integer", "minimum": 0},
                },
            },
        },
    },
}

# PR4-B2 — 예측 요청 shape(계획서 §4단계 "요청"). y/X는 회귀와 같은 완전사례
# 원칙(결측 없음, full one-hot·절편 미포함)이지만 covariance가 없고 대신
# groups(cohortPersonKey 그대로)·outerFolds(R×N)·config가 있다. maxItems
# 상한은 회귀와 동일한 MAX_VALUES_PER_VARIABLE/MAX_TOTAL_VALUES를 재사용한다
# (계획서가 별도 상한 상수를 요구하지 않음).
_PREDICTION_REQUEST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["protocolVersion", "prediction"],
    "additionalProperties": False,
    "properties": {
        "protocolVersion": {"const": 6},
        "prediction": {
            "type": "object",
            "required": ["y", "X", "columnNames", "groups", "outerFoldCount", "outerFolds", "config"],
            "additionalProperties": False,
            "properties": {
                "y": {
                    "type": "array",
                    "maxItems": MAX_VALUES_PER_VARIABLE,
                    "items": {"type": "number"},
                },
                "X": {
                    "type": "array",
                    "maxItems": MAX_VALUES_PER_VARIABLE,
                    "items": {"type": "array", "items": {"type": "number"}},
                },
                "columnNames": {"type": "array", "items": {"type": "string", "minLength": 1}},
                "groups": {"type": "array", "items": {"type": "string", "minLength": 1}},
                "outerFoldCount": {"type": "integer", "minimum": 1},
                "outerFolds": {
                    "type": "array",
                    "items": {"type": "array", "items": {"type": "integer", "minimum": 0}},
                },
                "config": {
                    "type": "object",
                    "required": [
                        "innerFolds", "lambdaGrid", "bootstrapReplicates", "bootstrapMinValidRate",
                        "cvMinValidRepeats", "aucCiReplicates", "samplerSeed", "representativeRepeat",
                    ],
                    "additionalProperties": False,
                    "properties": {
                        "innerFolds": {"type": "integer", "minimum": 1},
                        "lambdaGrid": {"type": "array", "minItems": 1, "items": {"type": "number", "exclusiveMinimum": 0}},
                        "bootstrapReplicates": {"type": "integer", "minimum": 0},
                        "bootstrapMinValidRate": {"type": "number", "minimum": 0, "maximum": 1},
                        "cvMinValidRepeats": {"type": "integer", "minimum": 0},
                        "aucCiReplicates": {"type": "integer", "minimum": 0},
                        "samplerSeed": {"type": "string", "minLength": 1},
                        "representativeRepeat": {"type": "integer", "minimum": 1},
                    },
                },
            },
        },
    },
}

REQUEST_SCHEMA: dict[str, Any] = {
    "oneOf": [
        _VARIABLES_REQUEST_SCHEMA,
        _BIVARIATE_REQUEST_SCHEMA,
        _CORRELATION_MATRIX_REQUEST_SCHEMA,
        _REGRESSION_REQUEST_SCHEMA,
        _REGRESSION_DIAGNOSTICS_REQUEST_SCHEMA,
        _PREDICTION_REQUEST_SCHEMA,
    ],
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

    if "correlationMatrix" in data:
        _validate_correlation_matrix_semantics(data["correlationMatrix"])
        return data

    if "regression" in data:
        _validate_regression_semantics(data["regression"])
        return data

    if "regressionDiagnostics" in data:
        _validate_regression_diagnostics_semantics(data["regressionDiagnostics"])
        return data

    if "prediction" in data:
        _validate_prediction_semantics(data["prediction"])
        return data

    _validate_bivariate_semantics(data["bivariate"])
    return data


def _validate_regression_semantics(regression: dict[str, Any]) -> None:
    """oneOf 스키마가 표현 못 하는 교차필드 검증(계획서 §3 "요청/응답"). y 길이·
    X 각 행 길이·columnNames 길이가 전부 일치해야 하고, cluster covariance는
    groups 길이도 같은 N이어야 한다. 값 개수 상한은 기존 MAX_TOTAL_VALUES를
    재사용한다(더미 확장 후 실제 셀 수 = N×P)."""
    y = regression["y"]
    x = regression["X"]
    column_names = regression["columnNames"]
    covariance = regression["covariance"]
    n = len(y)

    if len(x) != n:
        raise ProtocolError("INVALID_INPUT", "regression.X 행 수가 y 길이와 다르다")
    p = len(column_names)
    if any(len(row) != p for row in x):
        raise ProtocolError("INVALID_INPUT", "regression.X의 각 행 길이가 columnNames 길이와 달라야 한다")
    if p == 0:
        raise ProtocolError("INVALID_INPUT", "regression.columnNames가 비어있다")

    total_values = n * p
    if total_values > MAX_TOTAL_VALUES:
        raise ProtocolError(
            "LIMIT_EXCEEDED",
            f"regression 전체 값 개수(N×P={total_values})가 상한({MAX_TOTAL_VALUES})을 초과",
        )
    if n > MAX_VALUES_PER_VARIABLE:
        raise ProtocolError(
            "LIMIT_EXCEEDED",
            f"regression 행 수({n})가 상한({MAX_VALUES_PER_VARIABLE})을 초과",
        )

    if not all(_is_finite_number(v) for v in y):
        raise ProtocolError("INVALID_INPUT", "regression.y 값에 유한하지 않은 수가 있다")
    for row in x:
        if not all(_is_finite_number(v) for v in row):
            raise ProtocolError("INVALID_INPUT", "regression.X 값에 유한하지 않은 수가 있다")

    if covariance["type"] == "cluster":
        groups = covariance.get("groups")
        if groups is None or len(groups) != n:
            raise ProtocolError("INVALID_INPUT", "regression.covariance.groups 길이가 y 길이와 같아야 한다(cluster 타입 필수)")

    if regression["family"] == "binomial" and not all(v in (0.0, 1.0) for v in y):
        raise ProtocolError("INVALID_INPUT", "regression.family가 binomial이면 y는 0/1만 허용한다")

    # PR4-A2 — 대비행렬 각 행 길이는 P(columnNames)와 같아야 하고 전부 유한해야
    # 한다. 그리드 수 상한은 스키마 maxItems로 이미 걸렸다(방어적으로 재확인).
    for contrast in regression.get("splineContrasts", []):
        matrix = contrast["contrastMatrix"]
        if len(matrix) > MAX_SPLINE_CONTRAST_POINTS:
            raise ProtocolError("LIMIT_EXCEEDED", f"splineContrasts 그리드 수가 상한({MAX_SPLINE_CONTRAST_POINTS})을 초과")
        for row in matrix:
            if len(row) != p:
                raise ProtocolError("INVALID_INPUT", "splineContrasts.contrastMatrix의 각 행 길이가 columnNames 길이와 달라야 한다")
            if not all(_is_finite_number(v) for v in row):
                raise ProtocolError("INVALID_INPUT", "splineContrasts.contrastMatrix 값에 유한하지 않은 수가 있다")


def _validate_regression_diagnostics_semantics(regression_diagnostics: dict[str, Any]) -> None:
    """oneOf 스키마가 표현 못 하는 교차필드 검증(계획서 §4 "limited_row 진단값" —
    입력 검증 목록). X의 모든 행(첫 행만이 아니라 전체)을 순회해 길이를 확인하고,
    beta 길이도 columnNames와 일치해야 한다 — 재적합이 아니라 이미 주어진 β를
    그대로 쓰므로, 불일치는 구조 자체가 어긋났다는 뜻이다."""
    y = regression_diagnostics["y"]
    x = regression_diagnostics["X"]
    column_names = regression_diagnostics["columnNames"]
    beta = regression_diagnostics["beta"]
    sampled_row_indices = regression_diagnostics["sampledRowIndices"]
    n = len(y)
    p = len(column_names)

    if len(x) != n:
        raise ProtocolError("INVALID_INPUT", "regressionDiagnostics.X 행 수가 y 길이와 다르다")
    if any(len(row) != p for row in x):
        raise ProtocolError("INVALID_INPUT", "regressionDiagnostics.X의 각 행 길이가 columnNames 길이와 달라야 한다")
    if p == 0:
        raise ProtocolError("INVALID_INPUT", "regressionDiagnostics.columnNames가 비어있다")
    if len(beta) != p:
        raise ProtocolError("INVALID_INPUT", "regressionDiagnostics.beta 길이가 columnNames 길이와 달라야 한다")

    total_values = n * p
    if total_values > MAX_TOTAL_VALUES:
        raise ProtocolError(
            "LIMIT_EXCEEDED",
            f"regressionDiagnostics 전체 값 개수(N×P={total_values})가 상한({MAX_TOTAL_VALUES})을 초과",
        )
    if n > MAX_VALUES_PER_VARIABLE:
        raise ProtocolError(
            "LIMIT_EXCEEDED",
            f"regressionDiagnostics 행 수({n})가 상한({MAX_VALUES_PER_VARIABLE})을 초과",
        )

    if not all(_is_finite_number(v) for v in y):
        raise ProtocolError("INVALID_INPUT", "regressionDiagnostics.y 값에 유한하지 않은 수가 있다")
    for row in x:
        if not all(_is_finite_number(v) for v in row):
            raise ProtocolError("INVALID_INPUT", "regressionDiagnostics.X 값에 유한하지 않은 수가 있다")
    if not all(_is_finite_number(v) for v in beta):
        raise ProtocolError("INVALID_INPUT", "regressionDiagnostics.beta 값에 유한하지 않은 수가 있다")

    if regression_diagnostics["family"] == "binomial" and not all(v in (0.0, 1.0) for v in y):
        raise ProtocolError("INVALID_INPUT", "regressionDiagnostics.family가 binomial이면 y는 0/1만 허용한다")

    # PR4-A2 — 정수·중복 없음·[0, N) 범위 내(계획서 §4 "입력 검증"). 실제 표시
    # 상한 정책(§4 "표시 상한")은 Node가 sampledRowIndices를 만들 때 이미
    # 강제한다 — 여기서는 구조적 안전망(범위·중복)만 본다.
    if len(set(sampled_row_indices)) != len(sampled_row_indices):
        raise ProtocolError("INVALID_INPUT", "regressionDiagnostics.sampledRowIndices에 중복이 있다")
    if any(idx < 0 or idx >= n for idx in sampled_row_indices):
        raise ProtocolError("INVALID_INPUT", "regressionDiagnostics.sampledRowIndices가 [0, N) 범위를 벗어난다")


def _validate_prediction_semantics(prediction: dict[str, Any]) -> None:
    """oneOf 스키마가 표현 못 하는 교차필드 검증(계획서 §4단계 "의미검증" —
    3차 리뷰 세부조건: max(fold)+1로는 마지막 fold가 빠진 입력을 구별하지
    못하므로 outerFoldCount를 명시로 받아 그 값 자체로 검사한다)."""
    y = prediction["y"]
    x = prediction["X"]
    column_names = prediction["columnNames"]
    groups = prediction["groups"]
    outer_fold_count = prediction["outerFoldCount"]
    outer_folds = prediction["outerFolds"]
    config = prediction["config"]
    n = len(y)
    p = len(column_names)

    if len(x) != n:
        raise ProtocolError("INVALID_INPUT", "prediction.X 행 수가 y 길이와 다르다")
    if any(len(row) != p for row in x):
        raise ProtocolError("INVALID_INPUT", "prediction.X의 각 행 길이가 columnNames 길이와 달라야 한다")
    if p == 0:
        raise ProtocolError("INVALID_INPUT", "prediction.columnNames가 비어있다")
    if len(groups) != n:
        raise ProtocolError("INVALID_INPUT", "prediction.groups 길이가 y 길이와 달라야 한다")

    total_values = n * p
    if total_values > MAX_TOTAL_VALUES:
        raise ProtocolError(
            "LIMIT_EXCEEDED",
            f"prediction 전체 값 개수(N×P={total_values})가 상한({MAX_TOTAL_VALUES})을 초과",
        )
    if n > MAX_VALUES_PER_VARIABLE:
        raise ProtocolError(
            "LIMIT_EXCEEDED",
            f"prediction 행 수({n})가 상한({MAX_VALUES_PER_VARIABLE})을 초과",
        )

    if not all(_is_finite_number(v) for v in y):
        raise ProtocolError("INVALID_INPUT", "prediction.y 값에 유한하지 않은 수가 있다")
    if not all(v in (0.0, 1.0) for v in y):
        raise ProtocolError("INVALID_INPUT", "prediction.y는 0/1만 허용한다")
    for row in x:
        if not all(_is_finite_number(v) for v in row):
            raise ProtocolError("INVALID_INPUT", "prediction.X 값에 유한하지 않은 수가 있다")

    r = len(outer_folds)
    if r == 0:
        raise ProtocolError("INVALID_INPUT", "prediction.outerFolds가 비어있다(반복이 0회)")
    for repeat_idx, fold_row in enumerate(outer_folds):
        if len(fold_row) != n:
            raise ProtocolError("INVALID_INPUT", f"prediction.outerFolds[{repeat_idx}] 길이가 N과 다르다")
        if any(f < 0 or f >= outer_fold_count for f in fold_row):
            raise ProtocolError("INVALID_INPUT", f"prediction.outerFolds[{repeat_idx}]에 [0, outerFoldCount) 범위 밖 값이 있다")
        if set(fold_row) != set(range(outer_fold_count)):
            raise ProtocolError(
                "INVALID_INPUT",
                f"prediction.outerFolds[{repeat_idx}]에 비어있는 fold가 있다(0..{outer_fold_count - 1} 전부 있어야 함)",
            )

        # 같은 group(person)은 이 반복 안에서 반드시 같은 fold에 들어가야 한다
        # (grouped CV의 기본 전제 — Node가 이미 보장하지만 방어적으로 재확인).
        fold_of_group: dict[str, int] = {}
        for i, g in enumerate(groups):
            f = fold_row[i]
            if g in fold_of_group and fold_of_group[g] != f:
                raise ProtocolError(
                    "INVALID_INPUT",
                    f"prediction.outerFolds[{repeat_idx}]에서 group '{g}'이 서로 다른 fold에 걸쳐 있다",
                )
            fold_of_group[g] = f

        # 각 test fold(=그 fold로 배정된 행 전체)에 y=0과 y=1이 모두 있어야
        # 한다(Node가 이미 검사했어도 방어적으로 다시 확인).
        for k in range(outer_fold_count):
            fold_y = [y[i] for i in range(n) if fold_row[i] == k]
            if 1.0 not in fold_y or 0.0 not in fold_y:
                raise ProtocolError(
                    "INVALID_INPUT",
                    f"prediction.outerFolds[{repeat_idx}]의 fold {k}에 y=0 또는 y=1이 없다",
                )

    representative_repeat = config["representativeRepeat"]
    if not (1 <= representative_repeat <= r):
        raise ProtocolError(
            "INVALID_INPUT",
            f"prediction.config.representativeRepeat({representative_repeat})가 [1, {r}] 범위를 벗어난다",
        )


def _validate_correlation_matrix_semantics(correlation_matrix: dict[str, Any]) -> None:
    """oneOf 스키마가 표현 못 하는 교차필드 검증(PR3-B 계획서 §4/§7) —
    `_validate_bivariate_semantics`와 같은 구조/의미 분리 패턴. jsonschema의
    `uniqueItems`는 객체 전체를 비교하므로 "같은 key, 다른 values" 조합을 못
    잡는다 — `key`만 뽑아 `set()`으로 별도 검사한다."""
    variables = correlation_matrix["variables"]

    keys = [v["key"] for v in variables]
    if len(keys) != len(set(keys)):
        raise ProtocolError("INVALID_INPUT", "correlationMatrix.variables의 key가 중복된다")

    lengths = {len(v["values"]) for v in variables}
    if len(lengths) > 1:
        raise ProtocolError("INVALID_INPUT", "correlationMatrix.variables의 값 배열 길이가 서로 다르다")

    # 값 개수 상한은 기존 "variables" shape와 동일한 MAX_TOTAL_VALUES를 재사용한다
    # (계획서 §8 — 상관행렬 전용 새 상수를 두지 않는다). 바이트 길이 상한은
    # server/src/statsEngine.ts가 stdin 전송 전에 이미 검사한다(§8, 이중 검사).
    total_values = sum(len(v["values"]) for v in variables)
    if total_values > MAX_TOTAL_VALUES:
        raise ProtocolError(
            "LIMIT_EXCEEDED",
            f"correlationMatrix 전체 값 개수 합({total_values})이 상한({MAX_TOTAL_VALUES})을 초과",
        )

    for v in variables:
        for value in v["values"]:
            if value is not None and not _is_finite_number(value):
                raise ProtocolError("INVALID_INPUT", "correlationMatrix.variables 값에 유한하지 않은 수가 있다")


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
