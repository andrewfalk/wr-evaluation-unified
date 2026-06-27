"""
feature_calc 골든 단위 테스트 (6.0-6a). 합성 keypoints(알려진 기하)로 각도/비율 계산 검증.
추론 재실행 없이 계산 로직만 검증 — 의존성: numpy 불필요(순수 파이썬).
실행: .venv/Scripts/python test_feature_calc.py   (OK 출력 + 종료코드 0)
"""
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from feature_calc import (
    angle_at, angle_from_vertical, knee_min_angle, overhead_active,
    neck_flexion_angle, trunk_flexion_angle, posture_ratio, KP,
    choose_dominant_track, pick_target_person, all_track_ids,
    repetition_count, upperarm_elevation_angle, elbow_flexion_angle,
    wrist_flexion_angle,
)
from keypoint_layout import WHOLEBODY_TRIMMED_INDEX
from tracker import IoUTracker, iou

HERE = Path(__file__).parent

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


def _build_squat_keypoints(quality=None, track_id=None, n=40, dt=200):
    """쪼그림 기하(무릎각<90)를 n프레임 — squatDuration 산출용 합성 keypoints 문서."""
    squat = {
        "left_hip": (100, 200), "left_knee": (100, 300), "left_ankle": (120, 260),
        "right_hip": (140, 200), "right_knee": (140, 300), "right_ankle": (160, 260),
    }
    frames = []
    for i in range(n):
        p = person(squat)            # 관여 관절 score 0.9
        p["trackId"] = track_id
        p["bbox"] = [0.0, 0.0, 50.0, 100.0]
        frames.append({"frameIndex": i, "timestampMs": i * dt, "persons": [p]})
    doc = {
        "schemaVersion": 1, "keypointConvention": "coco17", "coordinateSpace": "pixel",
        "frameWidth": 640, "frameHeight": 480, "requestedFps": 5, "sampledFps": 5,
        "source": {"clipRef": "synthetic-d3a", "originalFps": 30, "totalFrames": n},
        "model": {"detector": "d", "pose": "p", "inputSize": [192, 256],
                  "modelName": "test", "modelVersion": "test", "preprocessConfigHash": "test"},
        "frames": frames,
    }
    if quality is not None:
        doc["quality"] = quality
    return doc


def _run_feature_calc(kdoc):
    with tempfile.TemporaryDirectory() as td:
        kpath = os.path.join(td, "kp.json")
        opath = os.path.join(td, "cf.json")
        Path(kpath).write_text(json.dumps(kdoc), encoding="utf-8")
        r = subprocess.run([sys.executable, str(HERE / "feature_calc.py"),
                            "--keypoints", kpath, "--output", opath],
                           capture_output=True, text=True)
        assert r.returncode == 0, f"feature_calc failed: {r.stderr}"
        return json.loads(Path(opath).read_text(encoding="utf-8"))


def _build_trunk_keypoints(coords, n=40, dt=200):
    """주어진 체간 기하를 n프레임 — trunkFlexion 산출용 합성 keypoints 문서."""
    frames = []
    for i in range(n):
        p = person(coords)
        p["trackId"] = None
        p["bbox"] = [0.0, 0.0, 50.0, 100.0]
        frames.append({"frameIndex": i, "timestampMs": i * dt, "persons": [p]})
    return {
        "schemaVersion": 1, "keypointConvention": "coco17", "coordinateSpace": "pixel",
        "frameWidth": 640, "frameHeight": 480, "requestedFps": 5, "sampledFps": 5,
        "source": {"clipRef": "synthetic-trunk", "originalFps": 30, "totalFrames": n},
        "model": {"detector": "d", "pose": "p", "inputSize": [192, 256],
                  "modelName": "test", "modelVersion": "test", "preprocessConfigHash": "test"},
        "frames": frames,
    }


def test_trunk_flexion_over45_candidate():
    # 전굴 >45° (hip mid (100,300) → shoulder mid (220,230): 약 60°) 전 구간 유지 → ratio ~1.
    flexed = {"left_hip": (80, 300), "right_hip": (120, 300),
              "left_shoulder": (200, 230), "right_shoulder": (240, 230)}
    out = _run_feature_calc(_build_trunk_keypoints(flexed))
    tf = out["features"]["trunkFlexionOver45Duration"]
    assert tf["metric"] == "posture_ratio" and tf["unit"] == "ratio", tf
    assert approx(tf["value"], 1.0, 0.05), tf            # 전 구간 >45° → ratio ~1
    assert len(tf["segments"]) >= 1, tf                  # 유지 구간 존재
    # trunkPostureG(peak_angle): peak 프레임 점-세그먼트(startMs==endMs) — overlay 별색 표시용.
    tg = out["features"]["trunkPostureG"]
    assert tg["metric"] == "peak_angle", tg
    assert len(tg["segments"]) == 1 and tg["segments"][0]["startMs"] == tg["segments"][0]["endMs"], tg
    # candidate라도 Python은 metric/unit/segments만 — mode/candidate 판정은 클라(VIDEO_FEATURE_TARGETS).
    # 곧게 선 체간 → 45° 미만 → ratio 0 (feature는 생성되나 value 0).
    upright = {"left_hip": (80, 300), "right_hip": (120, 300),
               "left_shoulder": (80, 150), "right_shoulder": (120, 150)}
    out2 = _run_feature_calc(_build_trunk_keypoints(upright))
    tf2 = out2["features"].get("trunkFlexionOver45Duration")
    assert tf2 is None or tf2["value"] == 0.0, tf2
    print("ok: trunkFlexionOver45Duration (candidate, posture_ratio >45°)")


def test_minhold_disabled_policy():
    # 정책(feature-calc-2026-06-d): minHoldSec=0 — 연속유지 요건 없이 임계 초과 프레임시간을 합산.
    # config 락(되돌림 방지).
    cfg = json.loads((HERE / "feature_config.json").read_text(encoding="utf-8"))
    assert cfg["minHoldSec"] == 0, f"minHoldSec must be 0 (B 정책), got {cfg['minHoldSec']}"

    # 대부분 직립 + 잠깐(2프레임)만 >45 굽힘 → min-hold 0이라 작게나마 ratio>0(이전 0.5초였으면 0).
    flexed = {"left_hip": (80, 300), "right_hip": (120, 300),
              "left_shoulder": (200, 230), "right_shoulder": (240, 230)}
    upright = {"left_hip": (80, 300), "right_hip": (120, 300),
               "left_shoulder": (80, 150), "right_shoulder": (120, 150)}
    n, dt = 20, 200
    frames = []
    for i in range(n):
        p = person(flexed if i in (8, 9) else upright)  # 8,9 프레임만 전굴
        p["trackId"] = None
        p["bbox"] = [0.0, 0.0, 50.0, 100.0]
        frames.append({"frameIndex": i, "timestampMs": i * dt, "persons": [p]})
    doc = _build_trunk_keypoints(upright)  # 래퍼 메타 재사용
    doc["frames"] = frames
    out = _run_feature_calc(doc)
    tf = out["features"]["trunkFlexionOver45Duration"]
    assert tf["value"] > 0, f"min-hold 0이면 짧은 크로싱도 시간으로 잡혀야 함, got {tf['value']}"
    assert tf["value"] < 0.3, tf  # 전체의 일부분만(과대계상 아님)
    print("ok: minHoldSec=0 policy - short crossing counted as exposure time")


def test_d3a_breakdown_and_quality():
    # (A) untracked + quality.usableFrameRatio=0.8 — 핵심 불변식: usableFrameRatio는
    #     breakdown에만, overall(min)에서 제외 → confidence는 0.8이 아니라 min(keypoint,visibility).
    quality = {"blurMetric": {"mean": 120.0, "p10": 40.0, "median": 110.0},
               "dropRatio": 0.02, "sampledFps": 5, "usableFrameRatio": 0.8}
    out = _run_feature_calc(_build_squat_keypoints(quality=quality, track_id=None))
    assert out["quality"] == quality, "keypoints.quality가 clip_features.quality로 복사돼야 함"
    sq = out["features"]["squatDuration"]
    bd = sq["confidenceBreakdown"]
    assert approx(bd["keypoint"], 0.9, 0.001), bd          # 관여 관절 score 0.9
    assert bd["visibility"] == 1.0, bd                      # 모두 min_conf 이상 → 가림 없음
    assert bd["usableFrameRatio"] == 0.8, bd                # breakdown에는 실림
    assert "tracking" not in bd, bd                         # trackId null → untracked
    assert "viewpoint" not in bd, bd                        # viewpoint는 D3b
    assert approx(sq["confidence"], 0.9, 0.001), sq         # min(0.9,1.0)=0.9 (0.8 아님!)

    # (B) tracked — tracking 성분이 breakdown+overall(min)에 포함.
    out_b = _run_feature_calc(_build_squat_keypoints(quality=None, track_id="t1"))
    bd_b = out_b["features"]["squatDuration"]["confidenceBreakdown"]
    assert "tracking" in bd_b and bd_b["tracking"] == 1.0, bd_b   # 단일 트랙 항상 등장 → presence 1.0
    assert "usableFrameRatio" not in bd_b, bd_b                   # quality 없으면 omit
    assert "quality" not in out_b, out_b
    print("ok: D3a confidenceBreakdown + quality copy + usableFrameRatio excluded from overall(min)")


# ── 6.0-11 반복빈도(cycles/min) ──────────────────────────────────────────────
REP_PARAMS = {"minAmplitudeDeg": 15, "hysteresisDeg": 5, "minCycleMs": 300, "minObservationMs": 3000}


def _sine_series(freq_hz, dur_s, fps, amp=30.0, mid=90.0):
    """주파수 기지 사인파 각도 시계열 [(t_ms, angle)] — repetition_count 직접 검증용."""
    n = int(dur_s * fps)
    return [(round(i / fps * 1000), mid + amp * math.sin(2 * math.pi * freq_hz * (i / fps))) for i in range(n)]


def test_repetition_count_synthetic():
    # 1.0Hz·10초 → ~9.5 사이클(phase-independent half-swing/2), rate ~57/분(true 60에 근접).
    cycles, rate, segs, active = repetition_count(_sine_series(1.0, 10, 30), 1000, REP_PARAMS)
    assert 9.0 <= cycles <= 10.5, (cycles, rate)
    assert 53 <= rate <= 63, rate
    assert len(segs) == round(cycles * 2), (len(segs), cycles)   # segments = 유효 half-swing
    assert active > 9000, active
    print(f"ok: repetition_count synthetic 1Hz/10s -> cycles={cycles} rate={rate:.1f}/min")


def test_repetition_fps_degradation():
    # Nyquist 실증: 1.0Hz 신호를 fps 낮춰가며 언더카운트 시작점을 표로 출력.
    print("  [fps degradation] freq=1.0Hz, 10s (expect ~9-10 cycles):")
    counts = {}
    for fps in (30, 20, 12, 8, 5, 3, 2):
        c, r, _, _ = repetition_count(_sine_series(1.0, 10, fps), 1000, REP_PARAMS)
        counts[fps] = c
        print(f"    fps={fps:2d} (samples/cycle={fps:2d}) -> cycles={c} rate={r if r is None else round(r,1)}")
    assert counts[30] >= 9, counts                 # 충분한 fps → true 10에 근접(~9.5)
    assert counts[2] == 0, counts                  # 2fps = 2×freq(Nyquist) → 영점 샘플링, 0 카운트
    assert counts[3] < counts[30], counts          # Nyquist 근방 언더카운트
    print("ok: repetition fps degradation (Nyquist undercount demonstrated)")


def test_repetition_amplitude_gate():
    # 히스테리시스는 통과하나 사이클 진폭(20°) < minAmplitudeDeg(30°) → 0 카운트(거짓양성 제거).
    params = {**REP_PARAMS, "minAmplitudeDeg": 30, "hysteresisDeg": 5}
    cycles, _, _, _ = repetition_count(_sine_series(1.0, 10, 30, amp=10.0), 1000, params)  # peak-to-peak 20
    assert cycles == 0, cycles
    print("ok: repetition amplitude gate (sub-threshold swing → 0)")


def test_repetition_gap_reset():
    # 두 5초 구간 사이 3초 gap(>max_gap 1000) → gap 시간 미가산, 사이클이 gap을 가로지르지 않음.
    seg1 = _sine_series(1.0, 5, 30)
    last = seg1[-1][0]
    seg2 = [(t + last + 3000, v) for (t, v) in _sine_series(1.0, 5, 30)]
    cycles, rate, _, active = repetition_count(seg1 + seg2, 1000, REP_PARAMS)
    assert cycles > 0, cycles
    assert active < 11000, active   # ~2×5000ms (3000ms gap 제외) — gap 포함이면 >13000
    print(f"ok: repetition gap reset (active={active:.0f}ms excludes gap)")


def test_repetition_min_observation():
    # 유효 관측 2초 < minObservationMs(3초) → rate None(짧은 클립 과대추정 방지).
    cycles, rate, _, active = repetition_count(_sine_series(1.0, 2, 30), 1000, REP_PARAMS)
    assert rate is None and active < 3000, (rate, active)
    print("ok: repetition min observation guard (short clip → rate None)")


def test_repetition_boundary_partial():
    # 코덱스 Medium 회귀: 화면 중앙에서 시작 → peak → trough로 끝나는 반쪽 동작(완결 사이클 아님).
    # 시작 anchor를 반전으로 세면 1로 잘못 셌음. 시작 anchor 제외 → 완결 trough-peak-trough 없음 → 0.
    # 중앙에서 시작 → peak(0.5s) → trough(1.5s): 진짜 반전 2개 = half-swing 1개 = 0.5 사이클(정확).
    # 시작 anchor를 반전으로 세면 1.0으로 부풀었음. 0.5로 나와야 phase-독립·경계 비편향.
    s = _sine_series(0.5, 2, 30)   # 0.5Hz·2초: midline→peak→trough
    cycles, _, _, _ = repetition_count(s, 1000, REP_PARAMS)
    assert cycles == 0.5, cycles
    print("ok: repetition boundary partial (mid-start up-down → 0.5 cycle, not inflated to 1)")


def test_repetition_slow_realistic():
    # 회귀(코덱스 High): 0.2Hz(=12회/분)·진폭35°·12fps → 프레임당 변화 ~3.7°(<hysteresis).
    # anchor를 매 샘플 끌면 방향 초기화 실패로 0이 됐음. running min/max anchor면 정상 검출.
    per_frame = 35.0 * 2 * math.pi * 0.2 / 12  # ~3.66°/frame < hyst(5)
    assert per_frame < REP_PARAMS["hysteresisDeg"], per_frame
    cycles, rate, _, _ = repetition_count(_sine_series(0.2, 30, 12, amp=35.0), 1000, REP_PARAMS)
    assert 4.5 <= cycles <= 6.5, (cycles, rate)    # 30s×0.2Hz=6주기 → ~5.5 사이클(phase-독립)
    assert 10 <= rate <= 13, rate                  # ~11~12회/분(true 12에 근접)
    print(f"ok: repetition slow realistic 0.2Hz/12fps -> cycles={cycles} rate={rate:.1f}/min (per-frame {per_frame:.1f}°<hyst)")


def _build_oscillating_arm_keypoints(freq, dur_s, fps, base_deg=45.0, amp_deg=35.0):
    """좌측 상완 거상각을 base±amp로 진동시키는 합성 keypoints(shoulder/elbowRepetitionRate emit용).
    elevation = base + amp·sin(2π·freq·t) (angle_from_vertical 정의상 정확히 일치)."""
    sx, sy, r = 100.0, 200.0, 80.0
    n, dt = int(dur_s * fps), round(1000 / fps)
    frames = []
    for i in range(n):
        e = math.radians(base_deg + amp_deg * math.sin(2 * math.pi * freq * (i / fps)))
        ex, ey = sx + r * math.sin(e), sy + r * math.cos(e)
        p = person({"left_shoulder": (sx, sy), "left_elbow": (ex, ey), "left_wrist": (ex, ey + 80)})
        p["trackId"] = None
        p["bbox"] = [0.0, 0.0, 50.0, 100.0]
        frames.append({"frameIndex": i, "timestampMs": i * dt, "persons": [p]})
    return {
        "schemaVersion": 1, "keypointConvention": "coco17", "coordinateSpace": "pixel",
        "frameWidth": 640, "frameHeight": 480, "requestedFps": fps, "sampledFps": fps,
        "source": {"clipRef": "synthetic-rep", "originalFps": 30, "totalFrames": n},
        "model": {"detector": "d", "pose": "p", "inputSize": [192, 256],
                  "modelName": "test", "modelVersion": "test", "preprocessConfigHash": "test"},
        "frames": frames,
    }


def test_repetition_endtoend_emit():
    # sampledFps=5 (<minFpsForReliableRate 10) → cycles/min 산출 + LOW_FPS 경고.
    out = _run_feature_calc(_build_oscillating_arm_keypoints(0.5, 12, 5))
    sr = out["features"]["shoulderRepetitionRate"]
    assert sr["metric"] == "cycles_per_minute" and sr["unit"] == "cycles_per_minute", sr
    assert sr["value"] > 0, sr
    assert len(sr["segments"]) >= 1, sr
    assert "LOW_FPS_FOR_REPETITION" in sr["warnings"], sr
    # sampledFps=12 (>=10) → 경고 없음.
    out2 = _run_feature_calc(_build_oscillating_arm_keypoints(0.5, 12, 12))
    sr2 = out2["features"]["shoulderRepetitionRate"]
    assert "LOW_FPS_FOR_REPETITION" not in sr2["warnings"], sr2
    print(f"ok: repetition end-to-end emit (5fps value={sr['value']} +LOW_FPS, 12fps no warning)")


def _wb_person(coords):
    """coords: {name: (x,y)} → wholebody133-trimmed(59점) keypoints[[x,y,score]] (score 0.9)."""
    kpts = [[0.0, 0.0, 0.0] for _ in range(59)]
    for name, (x, y) in coords.items():
        kpts[WHOLEBODY_TRIMMED_INDEX[name]] = [float(x), float(y), 0.9]
    return {"keypoints": kpts, "score": 0.9}


def _build_oscillating_wrist_keypoints(freq, dur_s, fps, base_deg=30.0, amp_deg=25.0):
    """손목 굽힘각 θ(=중립으로부터 편차)를 진동시키는 wholebody-trimmed 합성 keypoints.
    전완은 수직 고정(elbow 위, wrist 아래), 손축(중지 MCP)을 θ만큼 회전 → magnitude == θ."""
    n = int(dur_s * fps)
    dt = 1000.0 / fps
    frames = []
    ex, ey, wx, wy, L = 100.0, 100.0, 100.0, 200.0, 50.0  # elbow 위, wrist 아래(전완 수직)
    for i in range(n):
        theta = math.radians(base_deg + amp_deg * math.sin(2 * math.pi * freq * (i / fps)))
        mc = (wx + L * math.sin(theta), wy + L * math.cos(theta))  # 손축을 θ 회전
        p = _wb_person({"left_elbow": (ex, ey), "left_wrist": (wx, wy), "left_middle1": mc})
        p["trackId"] = None
        p["bbox"] = [0.0, 0.0, 50.0, 100.0]
        frames.append({"frameIndex": i, "timestampMs": round(i * dt), "persons": [p]})
    return {
        "schemaVersion": 1, "keypointConvention": "wholebody133-trimmed", "coordinateSpace": "pixel",
        "frameWidth": 640, "frameHeight": 480, "requestedFps": fps, "sampledFps": fps,
        "source": {"clipRef": "synthetic-wrist", "originalFps": 30, "totalFrames": n},
        "model": {"detector": "d", "pose": "rtmw-dw-l-m", "inputSize": [192, 256],
                  "modelName": "test", "modelVersion": "test", "preprocessConfigHash": "test"},
        "frames": frames,
    }


def test_wrist_angle_math():
    # 전완 수직(아래), 손축 일직선 아래 → 중립 magnitude 0.
    kp = KP(_wb_person({"left_elbow": (100, 100), "left_wrist": (100, 200), "left_middle1": (100, 300)}),
            WHOLEBODY_TRIMMED_INDEX, 0.3)
    assert approx(wrist_flexion_angle(kp, "left"), 0.0, 1.0), wrist_flexion_angle(kp, "left")
    # 손축 45° 굽힘 → magnitude ~45.
    kp2 = KP(_wb_person({"left_elbow": (100, 100), "left_wrist": (100, 200),
                         "left_middle1": (100 + 50 * math.sin(math.radians(45)), 200 + 50 * math.cos(math.radians(45)))}),
             WHOLEBODY_TRIMMED_INDEX, 0.3)
    assert approx(wrist_flexion_angle(kp2, "left"), 45.0, 2.0), wrist_flexion_angle(kp2, "left")
    # coco17(hand 없음) → middle1 부재 → None (KeyError 없이 자연 미산출).
    kp3 = KP(person({"left_elbow": (100, 100), "left_wrist": (100, 200)}), IDX, 0.3)
    assert wrist_flexion_angle(kp3, "left") is None
    print("ok: wrist angle math (중립 0·45°, coco17 None)")


def test_wrist_endtoend_emit():
    # wholebody-trimmed 클립(20fps) → 손목 반복·굴곡/편위 peak 산출.
    out = _run_feature_calc(_build_oscillating_wrist_keypoints(1.0, 8, 20))
    wr = out["features"]["wristRepetitionRate"]
    assert wr["metric"] == "cycles_per_minute" and wr["value"] > 0, wr
    assert "LOW_FPS_FOR_REPETITION" not in wr["warnings"], wr  # 20fps >= 15
    fp = out["features"]["wristFlexionPeakAngle"]
    dv = out["features"]["wristDeviationPeakAngle"]
    assert fp["metric"] == "peak_angle" and fp["unit"] == "degrees" and fp["value"] > 0, fp
    # 굴곡·편위는 동일 기하 → 같은 값(시점이 라벨 결정, 클라 하드 게이트).
    assert fp["value"] == dv["value"], (fp["value"], dv["value"])
    # body17(coco17) 클립 → 손목 feature 조용히 미산출(KeyError 없이).
    out_body = _run_feature_calc(_build_oscillating_arm_keypoints(0.5, 12, 12))
    assert "wristRepetitionRate" not in out_body["features"]
    assert "wristFlexionPeakAngle" not in out_body["features"]
    print(f"ok: wrist end-to-end emit (rep={wr['value']}/min, peak={fp['value']}°, body17 미산출)")


if __name__ == "__main__":
    test_angle_math()
    test_knee_squat_angle()
    test_overhead()
    test_trunk_neck()
    test_posture_ratio()
    test_tracker()
    test_target_selection()
    test_trunk_flexion_over45_candidate()
    test_minhold_disabled_policy()
    test_d3a_breakdown_and_quality()
    test_repetition_count_synthetic()
    test_repetition_fps_degradation()
    test_repetition_amplitude_gate()
    test_repetition_gap_reset()
    test_repetition_min_observation()
    test_repetition_boundary_partial()
    test_repetition_slow_realistic()
    test_repetition_endtoend_emit()
    test_wrist_angle_math()
    test_wrist_endtoend_emit()
    print("ALL PASS")
