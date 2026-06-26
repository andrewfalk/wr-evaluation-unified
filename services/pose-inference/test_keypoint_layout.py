"""keypoint_layout 단일 source 단위 테스트 (6.0-10 Stage A).

trimmed(59) 레이아웃 정의가 내부 일관적이고(body17=0..16, hand42=17..58), coco17 블록이
기존 feature_config.json.keypointIndex와 **동일**함을 고정 — 정적 JSON ↔ 코드 drift 방지.
실행: .venv/Scripts/python test_keypoint_layout.py
"""
import json
from pathlib import Path

import keypoint_layout as kl

HERE = Path(__file__).parent


def run():
    # 1) 개수: trimmed = body17 + hand42 = 59
    assert kl.TRIMMED_KEYPOINT_COUNT == 59, kl.TRIMMED_KEYPOINT_COUNT
    assert len(kl.TRIMMED_SOURCE_INDICES) == 59, len(kl.TRIMMED_SOURCE_INDICES)
    assert len(kl.WHOLEBODY_TRIMMED_INDEX) == 59, len(kl.WHOLEBODY_TRIMMED_INDEX)
    print("ok: trimmed 개수 59 (body17+hand42)")

    # 2) trimmed 값은 0..58 연속·중복 없음
    vals = sorted(kl.WHOLEBODY_TRIMMED_INDEX.values())
    assert vals == list(range(59)), vals
    print("ok: trimmed 인덱스 0..58 연속·유일")

    # 3) body17 블록(0..16)은 coco17과 동일
    for name, i in kl.COCO17_INDEX.items():
        assert kl.WHOLEBODY_TRIMMED_INDEX[name] == i, (name, i)
    assert max(kl.COCO17_INDEX.values()) == 16
    print("ok: body17 블록(0..16) == coco17")

    # 4) hand 블록 재매핑(원래 91-132 → trimmed 17-58)
    assert kl.WHOLEBODY_TRIMMED_INDEX["left_hand_root"] == 17, kl.WHOLEBODY_TRIMMED_INDEX["left_hand_root"]
    assert kl.WHOLEBODY_TRIMMED_INDEX["right_hand_root"] == 38, kl.WHOLEBODY_TRIMMED_INDEX["right_hand_root"]
    # 손목 각도용: 중지 MCP = middle1. 원래 left=100(91+9), trimmed=26(17+9); right=121(112+9), trimmed=47(38+9).
    assert kl.WHOLEBODY_TRIMMED_INDEX["left_middle1"] == 26, kl.WHOLEBODY_TRIMMED_INDEX["left_middle1"]
    assert kl.WHOLEBODY_TRIMMED_INDEX["right_middle1"] == 47, kl.WHOLEBODY_TRIMMED_INDEX["right_middle1"]
    print("ok: hand 블록 재매핑(left_middle1=26, right_middle1=47)")

    # 5) source 인덱스: body 0..16 + left_hand 91..111 + right_hand 112..132
    assert kl.TRIMMED_SOURCE_INDICES[:17] == list(range(0, 17))
    assert kl.TRIMMED_SOURCE_INDICES[17:38] == list(range(91, 112))
    assert kl.TRIMMED_SOURCE_INDICES[38:59] == list(range(112, 133))
    print("ok: TRIMMED_SOURCE_INDICES = body0-16 + lhand91-111 + rhand112-132")

    # 6) drift 가드: coco17 == feature_config.json.keypointIndex (정적 JSON ↔ 코드 동기)
    fc = json.loads((HERE / "feature_config.json").read_text(encoding="utf-8"))
    assert fc["keypointIndex"] == kl.COCO17_INDEX, (fc["keypointIndex"], kl.COCO17_INDEX)
    print("ok: coco17 == feature_config.json.keypointIndex (drift 가드)")

    print("ALL PASS")


if __name__ == "__main__":
    run()
