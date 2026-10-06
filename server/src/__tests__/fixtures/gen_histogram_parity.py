"""히스토그램 원본 bin numpy 대조 픽스처 생성기.

server/src/statsChartDisclosure.ts의 buildOriginalHistogram(원본 bin의 기준 구현)이
services/stats-engine/histogram.py(numpy)와 bin 개수·경계·bin별 건수까지 정확히
같은지 고정하기 위한 픽스처를 만든다. q1/q3는 엔진과 같은 descriptive.
compute_continuous로 계산해 함께 저장한다(Node는 엔진이 준 q1/q3를 그대로 쓰므로).

재생성(저장소 루트에서, stats-engine venv로):
    services/stats-engine/.venv/Scripts/python.exe \
        server/src/__tests__/fixtures/gen_histogram_parity.py
"""

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "services" / "stats-engine"))

from descriptive import compute_continuous  # noqa: E402
from histogram import compute_histogram  # noqa: E402

OUT = Path(__file__).with_name("histogramParity.json")


def case(name, values, persons=None):
    """persons: 값마다의 사람 번호(None이면 1:1 — 모든 값이 서로 다른 사람)."""
    values = [float(v) for v in values]
    if persons is None:
        persons = list(range(len(values)))
    person_count = len(set(persons))
    stat = compute_continuous(values)
    hist = compute_histogram(values, stat["q1"], stat["q3"], person_count)
    return {
        "name": name,
        "values": values,
        "persons": persons,
        "q1": stat["q1"],
        "q3": stat["q3"],
        "bins": hist["bins"],
    }


def main():
    cases = []
    rng = np.random.default_rng(20261006)

    cases.append(case("normal-200", rng.normal(50, 10, size=200)))
    cases.append(case("lognormal-skew-150", rng.lognormal(3, 1, size=150)))
    cases.append(case("iqr-zero-99zeros-1one", [0.0] * 99 + [1.0]))
    for n in (16, 64, 128, 1024):
        # IQR==0 + 2의 거듭제곱 인원 — Sturges의 log2가 정확히 정수가 되는 경계.
        cases.append(case(f"sturges-power-of-two-{n}", [0.0] * (n - 1) + [1.0]))
    cases.append(case("cap-50-far-outlier", list(rng.normal(0, 1, size=3000)) + [500.0]))
    cases.append(case("constant-20", [5.0] * 20))
    cases.append(case("single-value", [7.0]))
    cases.append(case("two-values", [1.0, 2.0]))
    # 경계에 정확히 걸치는 값 — numpy linspace 경계(i*step+lo)와 다른 연산 순서면
    # 0.6처럼 1ulp 어긋나 다른 bin에 배정된다.
    cases.append(case("tenth-grid-on-edges", [i / 10 for i in range(11)] * 20))
    cases.append(case("fifth-grid-on-edges", [i / 5 for i in range(6)] * 3))
    cases.append(case("third-grid-on-edges", [i / 3 for i in range(31)] * 4))
    # job/disease grain 브로드캐스트 — 200명이 3행씩 같은 값(인원수 기준 bin 개수).
    base = [(i / 199) * 100 for i in range(200)]
    cases.append(case(
        "broadcast-200-persons-x3",
        [v for v in base for _ in range(3)],
        [p for p in range(200) for _ in range(3)],
    ))
    # 한 사람이 서로 다른 값 여러 개(반복 측정) — 인원수 < 행 수.
    cases.append(case(
        "repeated-person-values",
        list(rng.integers(0, 480, size=240)),
        [i // 4 for i in range(240)],
    ))
    cases.append(case("poisson-counts-120", rng.poisson(3, size=120)))
    cases.append(case("integer-minutes-skewed", [10] * 13 + [60] * 18 + [110] * 12 + [160] * 10 + [210] * 4 + [310] * 2 + [410]))

    # 다양한 크기·분포의 무작위 데이터 — pow/log2/나눗셈 경로를 폭넓게 대조.
    for i in range(40):
        n = int(rng.integers(10, 400))
        kind = i % 4
        if kind == 0:
            values = rng.normal(rng.uniform(-100, 100), rng.uniform(0.1, 50), size=n)
        elif kind == 1:
            values = rng.exponential(rng.uniform(0.5, 200), size=n)
        elif kind == 2:
            values = np.round(rng.uniform(0, 1000, size=n), int(rng.integers(0, 3)))
        else:
            values = rng.gamma(rng.uniform(0.5, 5), rng.uniform(1, 30), size=n)
        cases.append(case(f"random-{i}-kind{kind}-n{n}", values))

    # 저장소는 .gitattributes로 LF 강제 — Windows에서도 CRLF로 쓰지 않는다.
    OUT.write_text(json.dumps({"numpy": np.__version__, "cases": cases}) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {len(cases)} cases to {OUT}")


if __name__ == "__main__":
    main()
