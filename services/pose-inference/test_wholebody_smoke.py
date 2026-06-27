"""rtmlib Wholebody API 호환성 smoke test (6.0-10 Stage B0).

손목분석은 hand-wrist 클립만 wholebody(133점)로 추론한다. 이 테스트는 Wholebody가 body(Body)와
**동일한 추론 인터페이스**를 갖는지 조기 확인 — infer_clip의 기존 패턴 `pose_model(frame, bboxes=...)`을
reshape 개수(17→133)만 바꿔 재사용할 수 있음을 보장.

가중치 미반입(에어갭 빌드 전·네트워크 차단)이면 기본은 graceful skip(exit 0) — 로컬 보조 검증.
단, 공식/CI 검증에서는 skip이 통과처럼 보이면 안 되므로 `REQUIRE_WHOLEBODY_SMOKE=1`이면 생성 실패를
**FAIL(exit 1)** 로 처리한다(실제 wholebody 불가 상태를 통과로 숨기지 않음).
실행: .venv/Scripts/python test_wholebody_smoke.py  (CI: REQUIRE_WHOLEBODY_SMOKE=1)
"""
import os
import sys

import numpy as np


def run():
    require = os.environ.get("REQUIRE_WHOLEBODY_SMOKE") in ("1", "true", "True")
    try:
        from rtmlib import Wholebody
        wb = Wholebody(mode="lightweight", backend="onnxruntime", device="cpu")
    except Exception as e:  # noqa: BLE001 — 가중치 다운로드 실패(에어갭/네트워크) 등.
        msg = f"Wholebody 생성 불가(가중치 미반입/네트워크?) — {type(e).__name__}: {e}"
        if require:
            print(f"FAIL: {msg} (REQUIRE_WHOLEBODY_SMOKE)")
            sys.exit(1)
        print(f"SKIP: {msg}")
        return

    h, w = 256, 192
    frame = (np.random.rand(h, w, 3) * 255).astype("uint8")
    # 합성 noise라 detector가 사람을 못 찾을 수 있어, bbox를 직접 주입해 pose_model shape만 확정 검증.
    bboxes = np.array([[0, 0, w, h]], dtype=float)
    kpts, scores = wb.pose_model(frame, bboxes=bboxes)
    kpts, scores = np.asarray(kpts), np.asarray(scores)

    # body(Body)와 동일 인터페이스 + 133점 출력(reshape 개수만 다름).
    assert kpts.reshape(-1, 133, 2).shape == (1, 133, 2), kpts.shape
    assert scores.reshape(-1, 133).shape == (1, 133), scores.shape
    print("ok: Wholebody.pose_model(frame, bboxes=...) -> (N,133,2)/(N,133), Body interface 동일")
    print("ALL PASS")


if __name__ == "__main__":
    run()
