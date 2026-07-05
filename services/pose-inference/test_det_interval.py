"""det 빈도 감소(6.0-15) 단위 테스트 — tracker refresh/임계, bbox 역산·sanity, 해시 보존,
det 스케줄 off-by-one·trackId 상속·score gate(합성 영상 + fake 추정기로 main() 실제 실행).
실행: .venv/Scripts/python test_det_interval.py   (ALL PASS + 종료코드 0)
"""
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

import infer_clip
import model_loader
from infer_clip import (bbox_from_keypoints, carry_bbox_sane, preprocess_config_hash,
                        xyxy_to_xywh)
from tracker import IoUTracker

N_KPTS = 17  # body variant


# ---------------------------------------------------------------- tracker

def test_tracker_refresh_carry_aging():
    tr = IoUTracker(iou_threshold=0.3, max_age=2)
    assert tr.update([[0, 0, 10, 10], [50, 50, 60, 60]]) == ["t1", "t2"]
    # carry 프레임: t1만 상속 — 전체 age 진행 후 t1만 리셋. t2는 age가 쌓인다.
    tr.refresh({"t1": [1, 1, 11, 11]}, advance_age=True)
    tr.refresh({"t1": [2, 2, 12, 12]}, advance_age=True)
    tr.refresh({"t1": [3, 3, 13, 13]}, advance_age=True)  # t2 age=3 > max_age=2 → 은퇴
    ids = tr.update([[3, 3, 13, 13], [50, 50, 60, 60]])
    assert ids[0] == "t1", ids                # 상속 트랙은 갱신된 bbox로 재동기화 매칭
    assert ids[1] == "t3", ids                # t2는 은퇴했으므로 신규 발급
    # 미지의 id는 무시(신규발급 없음)
    tr.refresh({"t999": [0, 0, 5, 5]}, advance_age=True)
    assert all(t["id"] != "t999" for t in tr._tracks)
    print("ok: refresh(advance_age=True) - 상속 리셋 + 미상속 age 누적·은퇴 + 미지 id 무시")


def test_tracker_refresh_no_double_aging():
    tr = IoUTracker(iou_threshold=0.3, max_age=10)
    tr.update([[0, 0, 10, 10], [50, 50, 60, 60]])
    tr.refresh({}, advance_age=True)  # carry: t1·t2 미상속 → age 1
    ages_before = {t["id"]: t["age"] for t in tr._tracks}
    assert ages_before == {"t1": 1, "t2": 1}
    # det 프레임: update가 age 진행+매칭(t1만 재검출 → age 0, t2는 2).
    tr.update([[0, 0, 10, 10]])
    # pose 후 역산 박스 반영은 advance_age=False — age 불변(이중 aging 금지).
    tr.refresh({"t1": [0, 0, 12, 12]}, advance_age=False)
    ages = {t["id"]: t["age"] for t in tr._tracks}
    assert ages == {"t1": 0, "t2": 2}, ages
    assert [t["bbox"] for t in tr._tracks if t["id"] == "t1"] == [[0, 0, 12, 12]]
    print("ok: det 프레임 refresh(advance_age=False) - bbox 교체만, age 불변")


def test_tracker_update_threshold_override():
    tr = IoUTracker(iou_threshold=0.5, max_age=10)
    tr.update([[0, 0, 100, 100]])
    # IoU 0.25 박스: 기본 임계(0.5)면 신규발급, 재동기화 임계(0.2)면 t1 유지.
    shifted = [[0, 0, 100, 25]]  # IoU = 25*100 / (100*100) = 0.25
    tr2 = IoUTracker(iou_threshold=0.5, max_age=10)
    tr2.update([[0, 0, 100, 100]])
    assert tr2.update(shifted) == ["t2"]                       # 기본 임계 → 신규
    assert tr.update(shifted, iou_threshold=0.2) == ["t1"]      # 오버라이드 → 상속 유지
    print("ok: update(iou_threshold=...) 재동기화 임계 오버라이드")


# ---------------------------------------------------------------- bbox helpers

def test_bbox_from_keypoints():
    kpts = [(100, 200), (200, 400), (150, 300)]
    scores = [0.9, 0.9, 0.9]
    box = bbox_from_keypoints(kpts, scores, 0.3, 0.15, 640, 480)
    # extent [100,200,200,400] + 마진 15%(w15, h30) → [85,170,215,430]
    assert box == [85.0, 170.0, 215.0, 430.0], box
    # 프레임 클램프
    box = bbox_from_keypoints([(2, 2), (638, 478)], [1, 1], 0.3, 0.15, 640, 480)
    assert box[0] == 0.0 and box[1] == 0.0 and box[2] == 640.0 and box[3] == 480.0, box
    # conf 미달 점 제외 → 유효점 <2 → None
    assert bbox_from_keypoints(kpts, [0.9, 0.1, 0.1], 0.3, 0.15, 640, 480) is None
    # 퇴화(동일 점 2개 → 면적 0) → None
    assert bbox_from_keypoints([(10, 10), (10, 10)], [1, 1], 0.3, 0.15, 640, 480) is None
    print("ok: bbox_from_keypoints - extent+마진·클램프·유효점<2·퇴화 박스")


def test_carry_bbox_sane():
    sanity = {"maxAreaRatio": 0.9, "aspectRange": [0.15, 6.0], "maxCenterJumpDiagRatio": 0.5}
    prev = [100, 100, 200, 300]
    assert carry_bbox_sane([105, 105, 205, 305], prev, 640, 480, sanity) is True
    # ① 프레임 대비 과대 면적(>90%)
    assert carry_bbox_sane([0, 0, 640, 470], prev, 640, 480, sanity) is False
    # ② 종횡비 이탈(가로로 극단적으로 납작)
    assert carry_bbox_sane([0, 100, 400, 110], prev, 640, 480, sanity) is False
    # ③ 중심 급이동(직전 박스 대각선 0.5배 초과)
    assert carry_bbox_sane([400, 100, 500, 300], prev, 640, 480, sanity) is False
    # prev 없으면(첫 프레임) 중심 이동 검사 생략
    assert carry_bbox_sane([400, 100, 500, 300], None, 640, 480, sanity) is True
    print("ok: carry_bbox_sane - 과대 면적·종횡비·중심 급이동 guard")


# ---------------------------------------------------------------- hash

def test_hash_default_preserved_and_active_changes():
    base_args = (5.0, "coco17", "yolox_tiny_humanart", "rtmpose-s_body7", [192, 256],
                 {"iou": 0.3, "maxAge": 10}, {"blurThreshold": None})
    # 기본(off): det_interval=None → 6.0-15 이전과 동일한 payload = 해시 완전 보존.
    import hashlib
    legacy = hashlib.sha256(json.dumps(
        {"fps": 5.0, "conv": "coco17", "det": "yolox_tiny_humanart", "pose": "rtmpose-s_body7",
         "inputSize": [192, 256], "track": {"iou": 0.3, "maxAge": 10},
         "quality": {"blurThreshold": None}}, sort_keys=True).encode()).hexdigest()[:16]
    assert preprocess_config_hash(*base_args) == legacy
    assert preprocess_config_hash(*base_args, det_interval=None) == legacy
    # 활성: config와 동일 필드명으로 포함 → 해시 변화, 파라미터 값이 다르면 해시도 다름.
    det = {"intervalFrames": 15, "bboxMarginRatio": 0.15, "resyncIouThreshold": 0.2,
           "redetectMinScore": 0.3, "bboxSanity": {"maxAreaRatio": 0.9, "aspectRange": [0.15, 6.0],
                                                   "maxCenterJumpDiagRatio": 0.5}}
    h_active = preprocess_config_hash(*base_args, det_interval=det)
    assert h_active != legacy
    det2 = dict(det, intervalFrames=10)
    assert preprocess_config_hash(*base_args, det_interval=det2) != h_active
    print("ok: preprocessConfigHash - 기본 off 완전 보존, 활성 시 파라미터 반영")


# ---------------------------------------------------------------- e2e (fake 추정기 + 합성 영상)

class _FakeEstimator:
    """det/pose를 결정적으로 흉내 — det 호출 시점(샘플 ordinal)과 pose 호출 수를 기록."""

    def __init__(self, low_score_ordinals=frozenset()):
        self.det_ordinals = []   # det가 실행된 샘플 프레임 ordinal(=pose 호출 수)
        self.pose_calls = 0
        self.low_score_ordinals = low_score_ordinals

    def det_model(self, frame):
        self.det_ordinals.append(self.pose_calls)
        return np.array([[100.0, 100.0, 200.0, 300.0]])

    def kpts_at(self, ordinal):
        # 샘플 ordinal마다 1px씩 이동하는 4점 사각 + 13점 내부 — 17점(coco17).
        base = np.array([[110.0, 110.0], [190.0, 110.0], [110.0, 290.0], [190.0, 290.0]])
        inner = np.tile([[150.0, 200.0]], (13, 1))
        return np.vstack([base, inner]) + float(ordinal)

    def pose_model(self, frame, bboxes=None):
        ordinal = self.pose_calls
        self.pose_calls += 1
        kpts = self.kpts_at(ordinal).reshape(1, N_KPTS, 2)
        score = 0.1 if ordinal in self.low_score_ordinals else 0.9
        return kpts, np.full((1, N_KPTS), score)


def _write_video(path, frames=90, fps=30, size=(320, 400)):
    import cv2
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, size)
    assert vw.isOpened()
    for _ in range(frames):
        vw.write(np.zeros((size[1], size[0], 3), dtype=np.uint8))
    vw.release()


def _run_main(clip, out, extra_args, fake):
    orig_build_pose = model_loader.build_pose
    orig_cuda = model_loader.cuda_available
    orig_argv = sys.argv
    model_loader.build_pose = lambda variant, device="cpu", tier="standard": (fake, "fake")
    model_loader.cuda_available = lambda: False
    sys.argv = ["infer_clip.py", "--input", str(clip), "--output", str(out),
                "--device", "cpu", *extra_args]
    try:
        infer_clip.main()
    finally:
        model_loader.build_pose = orig_build_pose
        model_loader.cuda_available = orig_cuda
        sys.argv = orig_argv
    return json.loads(Path(out).read_text(encoding="utf-8"))


def test_det_schedule_and_inheritance():
    """30fps 90프레임, --fps 15 → step=2, 45샘플, sampled_fps=15. interval 1s → N=floor(15)=15.
    det는 정확히 샘플 0,15,30에서만(off-by-one 고정). trackId는 전 구간 t1 상속(신규발급 0)."""
    with tempfile.TemporaryDirectory() as d:
        clip = Path(d) / "clip.mp4"
        _write_video(clip)
        fake = _FakeEstimator()
        doc = _run_main(clip, Path(d) / "kp.json", ["--fps", "15", "--det-interval-sec", "1.0"], fake)
    assert fake.det_ordinals == [0, 15, 30], fake.det_ordinals
    assert fake.pose_calls == 45
    frames = doc["frames"]
    assert len(frames) == 45
    assert all(f["persons"][0]["trackId"] == "t1" for f in frames)  # 상속 — 스왑/신규발급 0
    # 기록 bbox 분리: det 프레임(샘플0)=det 박스, carry 프레임(샘플1)=샘플0 pose 역산 박스(≠ det 박스).
    det_bbox = frames[0]["persons"][0]["bbox"]
    assert det_bbox == [100.0, 100.0, 100.0, 200.0], det_bbox  # xywh
    inv0 = bbox_from_keypoints(fake.kpts_at(0), np.full(N_KPTS, 0.9), 0.3, 0.15, 320, 400)
    expected_carry = [round(v, 2) for v in xyxy_to_xywh(inv0)]
    carry_bbox = frames[1]["persons"][0]["bbox"]
    assert carry_bbox == expected_carry, (carry_bbox, expected_carry)
    assert carry_bbox != det_bbox
    # 해시: detInterval 포함 → interval 없는 실행과 다른 값 (아래 off 테스트에서 교차 확인)
    assert doc["model"]["preprocessConfigHash"]
    print("ok: det 스케줄 [0,15,30] off-by-one 고정 + trackId 상속 + 기록 bbox 분리")


def test_score_gate_forces_det():
    """샘플 5에서 pose score 0.1(임계 0.3 미달) → carry 폐기, 샘플 6 det 강제, 이후 6+15=21 주기."""
    with tempfile.TemporaryDirectory() as d:
        clip = Path(d) / "clip.mp4"
        _write_video(clip)
        fake = _FakeEstimator(low_score_ordinals={5})
        doc = _run_main(clip, Path(d) / "kp.json", ["--fps", "15", "--det-interval-sec", "1.0"], fake)
    assert fake.det_ordinals == [0, 6, 21, 36], fake.det_ordinals
    assert all(f["persons"][0]["trackId"] == "t1" for f in json.loads(json.dumps(doc))["frames"])
    print("ok: score gate - 폐기 다음 프레임 det 강제, 재동기화에서도 t1 유지")


def test_interval_off_default_regression():
    """interval 미지정(config 기본 0) → 매 샘플 프레임 det(현행), 해시는 활성 실행과 다름."""
    with tempfile.TemporaryDirectory() as d:
        clip = Path(d) / "clip.mp4"
        _write_video(clip)
        fake_off = _FakeEstimator()
        doc_off = _run_main(clip, Path(d) / "kp_off.json", ["--fps", "15"], fake_off)
        fake_on = _FakeEstimator()
        doc_on = _run_main(clip, Path(d) / "kp_on.json", ["--fps", "15", "--det-interval-sec", "1.0"], fake_on)
    assert fake_off.det_ordinals == list(range(45))  # 전 샘플 det = 현행
    assert doc_off["model"]["preprocessConfigHash"] != doc_on["model"]["preprocessConfigHash"]
    # off 실행의 det 프레임 산출(bbox·trackId)은 on 실행의 det 프레임(0,15,30)과 동일해야 한다.
    for s in (0, 15, 30):
        assert doc_off["frames"][s]["persons"][0]["bbox"] == doc_on["frames"][s]["persons"][0]["bbox"]
        assert doc_off["frames"][s]["persons"][0]["trackId"] == doc_on["frames"][s]["persons"][0]["trackId"]
    print("ok: interval off 기본 - 매 프레임 det(현행) + 활성 실행과 해시 분리")


if __name__ == "__main__":
    test_tracker_refresh_carry_aging()
    test_tracker_refresh_no_double_aging()
    test_tracker_update_threshold_override()
    test_bbox_from_keypoints()
    test_carry_bbox_sane()
    test_hash_default_preserved_and_active_changes()
    test_det_schedule_and_inheritance()
    test_score_gate_forces_det()
    test_interval_off_default_regression()
    print("ALL PASS")
