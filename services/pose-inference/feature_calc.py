"""
feature 계산기 (6.0-6a, PR C): keypoints.json -> intrinsic clipFeatures.

영상이 측정 가능한 클립-레벨 값만 산출(자세시간 비율·각도). per-day 환산은 PR D1(공정시간 결합).
규칙은 feature_config.json(버전관리). OneEuro로 각도/위치 시계열 평활화.

사용: python feature_calc.py --keypoints out/keypoints.json --output out/clip_features.json
"""
import argparse
import json
import math
from pathlib import Path

from oneeuro import OneEuroFilter

HERE = Path(__file__).parent


def load_json(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


def angle_at(b, a, c):
    """vertex b에서 b->a, b->c 사이 각(degrees)."""
    v1 = (a[0] - b[0], a[1] - b[1])
    v2 = (c[0] - b[0], c[1] - b[1])
    n1 = math.hypot(*v1)
    n2 = math.hypot(*v2)
    if n1 < 1e-6 or n2 < 1e-6:
        return None
    cosv = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
    return math.degrees(math.acos(cosv))


def angle_from_vertical(vec, upward=True):
    """벡터와 수직축(이미지 y) 사이 각(degrees). upward=True면 위쪽(0,-1) 기준."""
    n = math.hypot(*vec)
    if n < 1e-6:
        return None
    ref = (0.0, -1.0) if upward else (0.0, 1.0)
    cosv = max(-1.0, min(1.0, (vec[0] * ref[0] + vec[1] * ref[1]) / n))
    return math.degrees(math.acos(cosv))


class KP:
    """프레임의 keypoint 접근자(coco17)."""
    def __init__(self, person, idx_map, min_conf):
        self.kpts = person["keypoints"] if person else []
        self.idx = idx_map
        self.min_conf = min_conf

    def get(self, name):
        i = self.idx[name]
        if i >= len(self.kpts):
            return None
        x, y, s = self.kpts[i]
        return (x, y) if s >= self.min_conf else None


def pick_person(frame):
    """단일 인물 PoC: 최고 score 1명(tracking은 PR D2)."""
    persons = frame.get("persons", [])
    if not persons:
        return None
    return max(persons, key=lambda p: p.get("score", 0))


# ── per-frame predicates/angles ───────────────────────────────────────────
def knee_min_angle(kp):
    vals = []
    for side in ("left", "right"):
        hip, knee, ankle = kp.get(f"{side}_hip"), kp.get(f"{side}_knee"), kp.get(f"{side}_ankle")
        if hip and knee and ankle:
            a = angle_at(knee, hip, ankle)
            if a is not None:
                vals.append(a)
    return min(vals) if vals else None


def overhead_active(kp, upperarm_elev_deg):
    for side in ("left", "right"):
        sh, el, wr = kp.get(f"{side}_shoulder"), kp.get(f"{side}_elbow"), kp.get(f"{side}_wrist")
        if sh and wr and wr[1] < sh[1]:          # 손목이 어깨보다 위(y 작음)
            return True
        if sh and el:                            # 상완 거상각 >= 임계
            elev = angle_from_vertical((el[0] - sh[0], el[1] - sh[1]), upward=False)
            if elev is not None and elev >= upperarm_elev_deg:
                return True
    return False


def midpoint(a, b):
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) if a and b else None


def neck_flexion_angle(kp):
    sh = midpoint(kp.get("left_shoulder"), kp.get("right_shoulder"))
    ear = midpoint(kp.get("left_ear"), kp.get("right_ear"))
    if not (sh and ear):
        return None
    return angle_from_vertical((ear[0] - sh[0], ear[1] - sh[1]), upward=True)


def trunk_flexion_angle(kp):
    hip = midpoint(kp.get("left_hip"), kp.get("right_hip"))
    sh = midpoint(kp.get("left_shoulder"), kp.get("right_shoulder"))
    if not (hip and sh):
        return None
    return angle_from_vertical((sh[0] - hip[0], sh[1] - hip[1]), upward=True)


# ── 시계열 → posture_ratio (min-hold + frame-drop) ─────────────────────────
def posture_ratio(samples, max_gap_ms, min_hold_ms):
    """samples: [(t_ms, active_bool)]. 반환 (ratio, segments[], total_ms)."""
    total = 0.0
    runs = []  # (start, end)
    cur_start = None
    for i in range(len(samples) - 1):
        t0, a0 = samples[i]
        t1, _ = samples[i + 1]
        dt = t1 - t0
        if dt <= 0 or dt > max_gap_ms:
            # gap: 진행 중 run 종료, 시간 미가산
            if cur_start is not None:
                runs.append((cur_start, t0))
                cur_start = None
            continue
        total += dt
        if a0:
            if cur_start is None:
                cur_start = t0
        else:
            if cur_start is not None:
                runs.append((cur_start, t0))
                cur_start = None
    if cur_start is not None:
        runs.append((cur_start, samples[-1][0]))
    qualifying = [(s, e) for (s, e) in runs if (e - s) >= min_hold_ms]
    active_ms = sum(e - s for (s, e) in qualifying)
    ratio = active_ms / total if total > 0 else 0.0
    return ratio, [{"startMs": round(s), "endMs": round(e)} for (s, e) in qualifying], total


def smooth_series(samples, cfg):
    """samples: [(t_ms, value or None)]. OneEuro로 평활(None은 통과)."""
    f = OneEuroFilter(cfg["minCutoff"], cfg["beta"], cfg["dCutoff"])
    out = []
    for t, v in samples:
        out.append((t, f(v, t / 1000.0) if v is not None else None))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keypoints", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--config", default=str(HERE / "feature_config.json"))
    args = ap.parse_args()

    kdoc = load_json(args.keypoints)
    cfg = load_json(args.config)
    idx = cfg["keypointIndex"]
    min_conf = cfg["minKeypointConfidence"]
    max_gap = cfg["frameDropMaxGapMs"]
    min_hold = cfg["minHoldSec"] * 1000
    euro = cfg["oneEuro"]

    frames = kdoc["frames"]
    times = [f["timestampMs"] for f in frames]
    kps = [KP(pick_person(f), idx, min_conf) for f in frames]
    clip_ms = (max(times) - min(times)) if times else 0

    features = {}

    def conf_for(names):
        """관여 keypoint 평균 score(가용 프레임)."""
        vals = []
        for f in frames:
            p = pick_person(f)
            if not p:
                continue
            for nm in names:
                i = idx[nm]
                if i < len(p["keypoints"]):
                    vals.append(p["keypoints"][i][2])
        return round(sum(vals) / len(vals), 4) if vals else 0.0

    # squatDuration: knee angle < 90
    knee_raw = [(times[i], knee_min_angle(kps[i])) for i in range(len(frames))]
    knee_sm = smooth_series(knee_raw, euro)
    thr = cfg["features"]["squatDuration"]["thresholdDeg"]
    samples = [(t, (v is not None and v < thr)) for t, v in knee_sm if v is not None]
    if samples:
        ratio, segs, _ = posture_ratio(samples, max_gap, min_hold)
        features["squatDuration"] = {
            "kind": "numeric", "metric": "posture_ratio", "value": round(ratio, 4), "unit": "ratio",
            "confidence": conf_for(["left_knee", "right_knee", "left_hip", "right_hip", "left_ankle", "right_ankle"]),
            "segments": segs, "warnings": [],
        }

    # overheadHours: wrist>shoulder OR upperarm elevation >= deg
    elev = cfg["features"]["overheadHours"]["criteria"]["upperarmElevationDeg"]
    oh = [(times[i], overhead_active(kps[i], elev)) for i in range(len(frames)) if pick_person(frames[i])]
    if oh:
        ratio, segs, _ = posture_ratio(oh, max_gap, min_hold)
        features["overheadHours"] = {
            "kind": "numeric", "metric": "posture_ratio", "value": round(ratio, 4), "unit": "ratio",
            "confidence": conf_for(["left_shoulder", "right_shoulder", "left_wrist", "right_wrist", "left_elbow", "right_elbow"]),
            "segments": segs, "warnings": [],
        }

    # neckFlexionOver20: neck flexion > 20
    neck_raw = [(times[i], neck_flexion_angle(kps[i])) for i in range(len(frames))]
    neck_sm = smooth_series(neck_raw, euro)
    nthr = cfg["features"]["neckFlexionOver20HoursPerDay"]["thresholdDeg"]
    nsamples = [(t, (v is not None and v > nthr)) for t, v in neck_sm if v is not None]
    if nsamples:
        ratio, segs, _ = posture_ratio(nsamples, max_gap, min_hold)
        features["neckFlexionOver20HoursPerDay"] = {
            "kind": "numeric", "metric": "posture_ratio", "value": round(ratio, 4), "unit": "ratio",
            "confidence": conf_for(["left_shoulder", "right_shoulder", "left_ear", "right_ear"]),
            "segments": segs, "warnings": [],
        }

    # trunkPostureG: peak trunk flexion angle (candidate)
    trunk_raw = [(times[i], trunk_flexion_angle(kps[i])) for i in range(len(frames))]
    trunk_vals = [v for _, v in smooth_series(trunk_raw, euro) if v is not None]
    if trunk_vals:
        features["trunkPostureG"] = {
            "kind": "numeric", "metric": "peak_angle", "value": round(max(trunk_vals), 2), "unit": "degrees",
            "confidence": conf_for(["left_hip", "right_hip", "left_shoulder", "right_shoulder"]),
            "segments": [], "warnings": ["POSTURE_G_MANUAL"],
        }

    doc = {
        "schemaVersion": 1,
        "featureConfigVersion": cfg["version"],
        "clipRef": kdoc.get("source", {}).get("clipRef", "unknown"),
        "clipDurationMs": round(clip_ms),
        "analyzedFrames": len(frames),
        "features": features,
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"wrote {out} | features: {list(features.keys())}")


if __name__ == "__main__":
    main()
