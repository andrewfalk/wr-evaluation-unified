"""protocol.py의 예측(prediction) shape 검증(oneOf 구조검사 +
_validate_prediction_semantics 교차필드 검증) 단위테스트 + analyze.py 프로세스
계약(stdin/stdout/stderr) end-to-end 테스트. 계획서(async-riding-hennessy.md)
§4단계 "의미검증" 반례 목록을 그대로 고정한다."""
from __future__ import annotations

import copy
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

import prediction as pred
from protocol import ProtocolError, parse_and_validate_request


def _grouped_request(n_person=30, rows_per_person=1, repeats=2, outer_fold_count=3, seed=1):
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(n_person * rows_per_person, 3))
    groups = []
    y_list = []
    person_y = (rng.random(n_person) < 0.5).astype(float)
    for i in range(n_person):
        for _ in range(rows_per_person):
            groups.append(f"p{i}")
            y_list.append(person_y[i])
    y = np.array(y_list)

    outer_folds = []
    for r in range(repeats):
        fold = pred._grouped_stratified_fold(y, groups, outer_fold_count, f"seed-{r}")
        outer_folds.append(fold.tolist())

    return {
        "protocolVersion": 6,
        "prediction": {
            "y": y.tolist(),
            "X": x.tolist(),
            "columnNames": ["x1", "x2", "x3"],
            "groups": groups,
            "outerFoldCount": outer_fold_count,
            "outerFolds": outer_folds,
            "config": {
                "innerFolds": 3,
                "lambdaGrid": [0.01, 0.1, 1.0],
                "bootstrapReplicates": 10,
                "bootstrapMinValidRate": 0.9,
                "cvMinValidRepeats": 1,
                "aucCiReplicates": 10,
                "samplerSeed": "test-seed",
                "representativeRepeat": 1,
            },
        },
    }


def test_valid_request_parses():
    data = parse_and_validate_request(json.dumps(_grouped_request()))
    assert data["prediction"]["outerFoldCount"] == 3


def test_wrong_protocol_version_rejected():
    request = _grouped_request()
    request["protocolVersion"] = 5
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_y_length_mismatch_with_x_rejected():
    request = _grouped_request()
    request["prediction"]["y"] = request["prediction"]["y"][:-1]
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_x_row_length_mismatch_with_column_names_rejected():
    request = _grouped_request()
    request["prediction"]["X"][0] = request["prediction"]["X"][0][:-1]
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_y_not_binary_rejected():
    request = _grouped_request()
    request["prediction"]["y"][0] = 2.0
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


def test_groups_length_mismatch_rejected():
    request = _grouped_request()
    request["prediction"]["groups"] = request["prediction"]["groups"][:-1]
    with pytest.raises(ProtocolError) as exc_info:
        parse_and_validate_request(json.dumps(request))
    assert exc_info.value.code == "INVALID_INPUT"


class TestOuterFoldsSemantics:
    """의미검증 반례 — 계획서 §4단계 목록을 그대로 재현한다."""

    def test_outer_folds_empty_rejected(self):
        request = _grouped_request()
        request["prediction"]["outerFolds"] = []
        with pytest.raises(ProtocolError) as exc_info:
            parse_and_validate_request(json.dumps(request))
        assert exc_info.value.code == "INVALID_INPUT"

    def test_outer_folds_row_length_mismatch_rejected(self):
        request = _grouped_request()
        request["prediction"]["outerFolds"][0] = request["prediction"]["outerFolds"][0][:-1]
        with pytest.raises(ProtocolError) as exc_info:
            parse_and_validate_request(json.dumps(request))
        assert exc_info.value.code == "INVALID_INPUT"

    def test_last_fold_missing_rejected_even_when_max_plus_one_would_hide_it(self):
        """3차 세부조건 — max(fold)+1로는 마지막 fold가 빠진 입력을 구별하지
        못한다. outerFoldCount=3인데 실제 값이 0,1만 나오면(2가 전혀 없음)
        거부돼야 한다 — max(values)+1==2!=3이라 outerFoldCount 자체를 명시로
        받아야만 잡을 수 있는 반례."""
        request = _grouped_request(outer_fold_count=3)
        fold_row = request["prediction"]["outerFolds"][0]
        # fold==2인 값을 전부 0으로 바꿔치기(2가 사라지게).
        request["prediction"]["outerFolds"][0] = [0 if f == 2 else f for f in fold_row]
        with pytest.raises(ProtocolError) as exc_info:
            parse_and_validate_request(json.dumps(request))
        assert exc_info.value.code == "INVALID_INPUT"
        assert "비어있는 fold" in exc_info.value.detail

    def test_fold_value_out_of_range_rejected(self):
        request = _grouped_request(outer_fold_count=3)
        request["prediction"]["outerFolds"][0][0] = 99
        with pytest.raises(ProtocolError) as exc_info:
            parse_and_validate_request(json.dumps(request))
        assert exc_info.value.code == "INVALID_INPUT"

    def test_group_split_across_folds_rejected(self):
        """같은 group(person)이 한 반복 안에서 서로 다른 fold에 걸치면 거부한다."""
        request = _grouped_request(rows_per_person=2)
        groups = request["prediction"]["groups"]
        fold_row = request["prediction"]["outerFolds"][0]
        # 같은 person의 두 행을 찾아 fold를 강제로 다르게 만든다.
        first_person = groups[0]
        indices = [i for i, g in enumerate(groups) if g == first_person]
        assert len(indices) >= 2
        other_fold = (fold_row[indices[0]] + 1) % request["prediction"]["outerFoldCount"]
        fold_row[indices[1]] = other_fold
        with pytest.raises(ProtocolError) as exc_info:
            parse_and_validate_request(json.dumps(request))
        assert exc_info.value.code == "INVALID_INPUT"
        assert "서로 다른 fold" in exc_info.value.detail

    def test_test_fold_single_class_rejected(self):
        """각 test fold에 y=0과 y=1이 모두 있어야 한다(Node가 이미 검사했어도
        방어적으로 다시 확인)."""
        request = _grouped_request(outer_fold_count=3)
        y = request["prediction"]["y"]
        fold_row = request["prediction"]["outerFolds"][0]
        # fold 0에 배정된 모든 행의 y를 1로 덮어써 단일 클래스로 만든다.
        for i, f in enumerate(fold_row):
            if f == 0:
                y[i] = 1.0
        with pytest.raises(ProtocolError) as exc_info:
            parse_and_validate_request(json.dumps(request))
        assert exc_info.value.code == "INVALID_INPUT"

    def test_representative_repeat_out_of_range_rejected(self):
        request = _grouped_request(repeats=2)
        request["prediction"]["config"]["representativeRepeat"] = 3
        with pytest.raises(ProtocolError) as exc_info:
            parse_and_validate_request(json.dumps(request))
        assert exc_info.value.code == "INVALID_INPUT"

    def test_representative_repeat_zero_rejected(self):
        request = _grouped_request(repeats=2)
        request["prediction"]["config"]["representativeRepeat"] = 0
        with pytest.raises(ProtocolError) as exc_info:
            parse_and_validate_request(json.dumps(request))
        assert exc_info.value.code == "INVALID_INPUT"


# ---------------------------------------------------------------------------
# analyze.py — 예측 경로 end-to-end(stdin/stdout/stderr 프로세스 계약)
# ---------------------------------------------------------------------------
def _run_analyze(stdin_text: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(Path(__file__).parent / "analyze.py")],
        input=stdin_text, capture_output=True, text=True, timeout=60,
    )


def test_analyze_process_prediction_success():
    proc = _run_analyze(json.dumps(_grouped_request()))
    assert proc.returncode == 0
    assert proc.stderr == ""
    payload = json.loads(proc.stdout)
    assert payload["protocolVersion"] == 6
    assert payload["prediction"]["estimation"] in ("ok", "non_estimable")


def test_analyze_process_prediction_invalid_shape_emits_marker_and_exit1():
    bad_request = {"protocolVersion": 6, "prediction": {"y": [1.0, 0.0]}}
    proc = _run_analyze(json.dumps(bad_request))
    assert proc.returncode == 1
    assert proc.stdout == ""
    assert "STATS_ENGINE_ERROR" in proc.stderr
