"""박스플롯 5수요약 + Tukey whisker/이상치 — PR3-B 계획서 §3.

Q1/Q3/median은 descriptive.py::compute_continuous()가 이미 계산한 값(method="linear",
R quantile(type=7)과 동치)을 그대로 받아 재사용한다 — 표와 차트의 Q1/Q3 불일치를
막기 위함이다. 이 앱의 박스플롯 whisker/이상치는 그 Q1/Q3에 Tukey 1.5×IQR 규칙을
적용한 것이라, R 기본 boxplot()/boxplot.stats()의 Tukey hinges 기반 결과와 다를 수
있다(의도적 선택 — R 대조는 fixtures/generate_r_reference_boxplot.R에서
quantile(type=7)+수동 Tukey 규칙으로 재현하고, boxplot.stats()는 쓰지 않는다).

이 모듈은 person을 모른다 — outlierCount/outlierValues의 person 단위 공개통제
(이상치·비이상치 양쪽 partition의 고유 인원 게이트)는 Node
(statsChartDisclosure.ts::computeOutlierDisclosure)가 lowerFence/upperFence를
받아 별도로 수행한다(계획서 §1). 이 모듈은 항상 정직하게 전부 계산해서 반환한다
— 노출 여부는 순수하게 Node의 정책 책임이다.
"""
from __future__ import annotations

from typing import Any


def compute_boxplot(values: list[float], q1: float, median: float, q3: float) -> dict[str, Any]:
    iqr = q3 - q1
    lower_fence = q1 - 1.5 * iqr
    upper_fence = q3 + 1.5 * iqr

    inside = [v for v in values if lower_fence <= v <= upper_fence]
    outliers = [v for v in values if v < lower_fence or v > upper_fence]

    lower_whisker = min(inside) if inside else q1
    upper_whisker = max(inside) if inside else q3

    return {
        "q1": q1,
        "median": median,
        "q3": q3,
        "lowerWhisker": lower_whisker,
        "upperWhisker": upper_whisker,
        "lowerFence": lower_fence,
        "upperFence": upper_fence,
        "outlierCount": len(outliers),
        "outlierValues": outliers,
    }
