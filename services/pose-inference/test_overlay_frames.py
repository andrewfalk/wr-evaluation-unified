"""write_overlay_frame best-effort 검증(overlay 검수 게이트). cv2/numpy만 — rtmlib 추론 무관.
실행: .venv/Scripts/python test_overlay_frames.py   (ALL PASS + 종료코드 0)
"""
import os
import tempfile
from pathlib import Path

import numpy as np

from infer_clip import write_overlay_frame


def test_writes_jpg():
    frame = np.zeros((120, 240, 3), dtype=np.uint8)  # BGR 더미 프레임
    with tempfile.TemporaryDirectory() as d:
        fdir = os.path.join(d, "job.frames")
        assert write_overlay_frame(frame, fdir, 6) is True
        assert Path(fdir, "6.jpg").is_file()
        # max_width 다운스케일: 240→480은 그대로(<=480), 큰 프레임은 줄어듦
        big = np.zeros((600, 1200, 3), dtype=np.uint8)
        assert write_overlay_frame(big, fdir, 12) is True
        assert Path(fdir, "12.jpg").is_file()
    print("ok: write_overlay_frame → <frameIndex>.jpg 생성")


def test_failure_swallowed():
    frame = np.zeros((120, 240, 3), dtype=np.uint8)
    with tempfile.TemporaryDirectory() as d:
        # frames-dir 위치를 '파일'로 만들어 mkdir 실패 유도 → False(예외 전파 금지, best-effort)
        blocker = os.path.join(d, "blocker")
        Path(blocker).write_text("x")
        assert write_overlay_frame(frame, blocker, 0) is False
    print("ok: mkdir/imwrite 실패 삼킴(추론 무영향)")


if __name__ == "__main__":
    test_writes_jpg()
    test_failure_swallowed()
    print("ALL PASS")
