"""boxplot.py — Tukey 1.5×IQR whisker/이상치 분류 정확성만 검증한다(계획서 §1의
person 단위 공개통제는 Node 책임이라 서버 테스트로 옮겨졌다 — 이 파일은 산술만).
R 대조는 fixtures/generate_r_reference_boxplot.R(quantile(type=7)+수동 Tukey
규칙, boxplot.stats()는 쓰지 않음)로 별도 검증한다."""
from __future__ import annotations

from descriptive import compute_continuous
from boxplot import compute_boxplot


def _boxplot_for(values: list[float]) -> dict:
    stat = compute_continuous(values)
    return compute_boxplot(values, stat["q1"], stat["median"], stat["q3"])


def test_no_outliers_when_all_within_fence():
    values = [1.0, 2.0, 3.0, 4.0, 5.0]
    result = _boxplot_for(values)
    assert result["outlierCount"] == 0
    assert result["outlierValues"] == []
    assert result["lowerWhisker"] == min(values)
    assert result["upperWhisker"] == max(values)


def test_pr3b_disclosure_counterexample_reproduced():
    # 계획서 §1의 반례를 산술적으로만 재현(공개 여부 판정은 서버 테스트 몫) —
    # 0×50 / 1×26 / 2.49×23 / 2.51×1, n=100.
    values = [0.0] * 50 + [1.0] * 26 + [2.49] * 23 + [2.51] * 1
    stat = compute_continuous(values)
    assert stat["q1"] == 0.0
    assert stat["q3"] == 1.0
    result = compute_boxplot(values, stat["q1"], stat["median"], stat["q3"])
    assert result["upperFence"] == 2.5
    assert result["outlierCount"] == 1
    assert result["outlierValues"] == [2.51]


def test_lower_and_upper_outliers_both_detected():
    values = [-100.0] + [10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0] + [200.0]
    result = _boxplot_for(values)
    assert -100.0 in result["outlierValues"]
    assert 200.0 in result["outlierValues"]
    assert result["outlierCount"] == 2


def test_constant_values_no_outliers_and_zero_width_fence():
    values = [5.0] * 10
    result = _boxplot_for(values)
    assert result["outlierCount"] == 0
    assert result["lowerFence"] == 5.0
    assert result["upperFence"] == 5.0
    assert result["lowerWhisker"] == 5.0
    assert result["upperWhisker"] == 5.0


def test_single_value_degenerate():
    result = _boxplot_for([42.0])
    assert result["outlierCount"] == 0
    assert result["lowerWhisker"] == 42.0
    assert result["upperWhisker"] == 42.0


def test_whisker_is_actual_observed_value_not_fence_boundary():
    # Tukey 정의 — whisker는 fence 값 자체가 아니라 fence 안의 실제 관측값 중
    # 극단값이어야 한다.
    values = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 100.0]
    result = _boxplot_for(values)
    assert result["upperWhisker"] in values
    assert result["upperWhisker"] != result["upperFence"]
    assert 100.0 in result["outlierValues"]
