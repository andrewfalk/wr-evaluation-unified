"""
feature_calc 골든 단위 테스트 (6.0-6a). 합성 keypoints(알려진 기하)로 각도/비율 계산 검증.
추론 재실행 없이 계산 로직만 검증 — 의존성: numpy 불필요(순수 파이썬).
실행: .venv/Scripts/python test_feature_calc.py   (OK 출력 + 종료코드 0)
"""
import math

from feature_calc import (
    angle_at, angle_from_vertical, knee_min_angle, overhead_active,
    neck_flexion_angle, trunk_flexion_angle, posture_ratio, KP,
    choose_dominant_track, pick_target_person, all_track_ids,
)
from tracker import IoUTracker, iou

IDX = {
    "nose": 0, "left_eye": 1, "right_eye": 2, "left_ear": 3, "right_ear": 4,
    "left_shoulder": 5, "right_shoulder": 6, "left_elbow": 7, "right_elbow": 8,
    "left_wrist": 9, "right_wrist": 10, "left_hip": 11, "right_hip": 12,
    "left_knee": 13, "right_knee": 14, "left_ankle": 15, "right_ankle": 16,
}


def person(coords):
    """coords: {name: (x,y)} → coco17 keypoints[[x,y,score]] (score 0.9)."""
    kpts = [[0.0, 0.0, 0.0] for _ in range(17)]
    for name, (x, y) in coords.items():
        kpts[IDX[name]] = [float(x), float(y), 0.9]
    return {"keypoints": kpts, "score": 0.9}


def approx(a, b, tol=1.0):
    return abs(a - b) <= tol


def test_angle_math():
    # 직각: vertex=(0,0), a=(0,-1)위, c=(1,0)오른쪽 → 90°
    assert approx(angle_at((0, 0), (0, -1), (1, 0)), 90.0)
    # 수직 위 기준: (0,-1)벡터 → 0°, (1,0)수평 → 90°, (0,1)아래 → 180°
    assert approx(angle_from_vertical((0, -1), upward=True), 0.0)
    assert approx(angle_from_vertical((1, 0), upward=True), 90.0)
    print("ok: angle math")


def test_knee_squat_angle():
    # 굽힌 무릎(hip 위, ankle 무릎 근처) → 무릎각 < 90
    kp = KP(person({"left_hip": (100, 200), "left_knee": (100, 300), "left_ankle": (120, 260)}), IDX, 0.3)
    a = knee_min_angle(kp)
    assert a is not None and a < 90, f"expected <90 got {a}"
    # 곧게 선 다리 → 무릎각 ~180
    kp2 = KP(person({"left_hip": (100, 200), "left_knee": (100, 300), "left_ankle": (100, 400)}), IDX, 0.3)
    assert knee_min_angle(kp2) > 150
    print("ok: knee squat angle")


def test_overhead():
    # 손목이 어깨 위 → overhead True
    kp = KP(person({"left_shoulder": (100, 200), "left_wrist": (100, 120), "left_elbow": (100, 160)}), IDX, 0.3)
    assert overhead_active(kp, 90) is True
    # 손 내림 → overhead False
    kp2 = KP(person({"left_shoulder": (100, 200), "left_wrist": (100, 320), "left_elbow": (100, 260)}), IDX, 0.3)
    assert overhead_active(kp2, 90) is False
    print("ok: overhead")


def test_trunk_neck():
    # 곧게 선 체간(어깨가 엉덩이 바로 위) → 전굴각 ~0
    kp = KP(person({"left_hip": (100, 300), "right_hip": (140, 300), "left_shoulder": (100, 150), "right_shoulder": (140, 150)}), IDX, 0.3)
    assert trunk_flexion_angle(kp) < 10
    # 앞으로 굽힘 → 전굴각 큼
    kp2 = KP(person({"left_hip": (100, 300), "right_hip": (140, 300), "left_shoulder": (220, 230), "right_shoulder": (260, 230)}), IDX, 0.3)
    assert trunk_flexion_angle(kp2) > 30
    print("ok: trunk/neck")


def test_posture_ratio():
    # 0..1800ms 200ms 간격 전부 active → ratio ~1, min-hold 통과
    samples = [(t, True) for t in range(0, 2000, 200)]
    ratio, segs, total = posture_ratio(samples, max_gap_ms=1000, min_hold_ms=500)
    assert approx(ratio, 1.0, 0.01) and len(segs) == 1
    # 절반만 active
    half = [(t, t < 1000) for t in range(0, 2000, 200)]
    ratio2, _, _ = posture_ratio(half, 1000, 500)
    assert 0.4 <= ratio2 <= 0.6
    # gap(>maxGap)은 시간 미가산
    gapped = [(0, True), (200, True), (5000, True), (5200, True)]
    _, _, tot = posture_ratio(gapped, 1000, 0)
    assert tot == 400  # 0-200, 5000-5200 만 가산(200+200)
    print("ok: posture_ratio (min-hold + frame-drop)")


def test_tracker():
    t = IoUTracker(0.3, max_age=5)
    assert iou([0, 0, 10, 10], [0, 0, 10, 10]) == 1.0
    assert iou([0, 0, 10, 10], [100, 100, 110, 110]) == 0.0
    # 2인 등장 → t1,t2. 약간 이동(높은 IoU)해도 id 유지.
    assert t.update([[0, 0, 10, 10], [100, 100, 110, 110]]) == ["t1", "t2"]
    assert t.update([[1, 1, 11, 11], [101, 101, 111, 111]]) == ["t1", "t2"]
    # t2가 사라진 프레임 → t1만. (t2는 max_age 동안 생존하나 매칭 안 됨)
    assert t.update([[2, 2, 12, 12]]) == ["t1"]
    # 멀리 떨어진 새 인물 → 새 id(은퇴 전 t2 id 재사용 금지, 단조 증가).
    assert t.update([[2, 2, 12, 12], [500, 500, 510, 510]]) == ["t1", "t3"]
    print("ok: IoU tracker (stable ids, deterministic, no id reuse)")


def _mkframe(persons):
    """persons: [(trackId, bw, bh, score)] → frame dict(키포인트는 더미)."""
    return {"persons": [
        {"trackId": tid, "bbox": [0.0, 0.0, float(bw), float(bh)], "score": sc,
         "keypoints": [[0.0, 0.0, 0.0] for _ in range(17)]}
        for (tid, bw, bh, sc) in persons
    ]}


def test_target_selection():
    frames = [
        _mkframe([("t1", 10, 10, 0.9), ("t2", 10, 10, 0.5)]),
        _mkframe([("t1", 10, 10, 0.9)]),                       # t2 track-loss
        _mkframe([("t1", 10, 10, 0.9), ("t2", 10, 10, 0.5)]),
    ]
    assert all_track_ids(frames) == {"t1", "t2"}
    # t1은 3프레임, t2는 2프레임 → dominant=t1.
    assert choose_dominant_track(frames) == "t1"
    # 대상 person 선택 + track-loss(없는 프레임 → None).
    assert pick_target_person(frames[0], "t2")["trackId"] == "t2"
    assert pick_target_person(frames[1], "t2") is None
    # presenceRatio(t2) = 2/3.
    present = sum(1 for f in frames if pick_target_person(f, "t2") is not None)
    assert present == 2
    # 등장 프레임수 동률 → 평균 bbox 면적 큰 트랙 채택(결정적 tie-break).
    tie = [_mkframe([("a", 10, 10, 0.5), ("b", 20, 20, 0.5)])]
    assert choose_dominant_track(tie) == "b"
    # 트랙 없음(구 fixture) → None(폴백 트리거).
    assert choose_dominant_track([_mkframe([(None, 10, 10, 0.9)])]) is None
    print("ok: target track selection + dominant heuristic + track-loss")


if __name__ == "__main__":
    test_angle_math()
    test_knee_squat_angle()
    test_overhead()
    test_trunk_neck()
    test_posture_ratio()
    test_tracker()
    test_target_selection()
    print("ALL PASS")
