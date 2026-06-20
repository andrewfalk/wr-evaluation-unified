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
    """trackId가 없는 입력(PR B fixture 등) 폴백: 최고 score 1명."""
    persons = frame.get("persons", [])
    if not persons:
        return None
    return max(persons, key=lambda p: p.get("score", 0))


def pick_target_person(frame, target_id):
    """대상 trackId person 반환. 그 프레임에 대상이 없으면 None(track-loss → gap)."""
    for p in frame.get("persons", []):
        if p.get("trackId") == target_id:
            return p
    return None


def all_track_ids(frames):
    """클립 전체에 등장한 trackId 집합(None 제외)."""
    ids = set()
    for f in frames:
        for p in f.get("persons", []):
            tid = p.get("trackId")
            if tid is not None:
                ids.add(tid)
    return ids


def choose_dominant_track(frames):
    """대상 미지정 시 휴리스틱: 가장 많은 프레임에 등장한 trackId.
    동률 → 평균 bbox 면적 큰 것 → 평균 score 큰 것 → id 사전순(결정성). 트랙 없으면 None."""
    stats = {}  # id -> [frame_count, area_sum, score_sum, seen_in_frame]
    for f in frames:
        seen = set()
        for p in f.get("persons", []):
            tid = p.get("trackId")
            if tid is None:
                continue
            s = stats.setdefault(tid, [0, 0.0, 0.0])
            bbox = p.get("bbox") or [0, 0, 0, 0]
            area = (bbox[2] if len(bbox) > 2 else 0) * (bbox[3] if len(bbox) > 3 else 0)
            s[1] += float(area)
            s[2] += float(p.get("score", 0))
            if tid not in seen:
                s[0] += 1
                seen.add(tid)
    if not stats:
        return None
    # frame_count desc, area desc, score desc, id asc
    best = sorted(stats.items(), key=lambda kv: (-kv[1][0], -kv[1][1], -kv[1][2], kv[0]))
    return best[0][0]


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
    ap.add_argument("--target-track", default=None,
                    help="대상 trackId(미지정 시 dominant-track 휴리스틱; D2b 워커가 주입)")
    args = ap.parse_args()

    kdoc = load_json(args.keypoints)
    cfg = load_json(args.config)
    idx = cfg["keypointIndex"]
    min_conf = cfg["minKeypointConfidence"]
    max_gap = cfg["frameDropMaxGapMs"]
    min_hold = cfg["minHoldSec"] * 1000
    euro = cfg["oneEuro"]
    min_presence = cfg.get("tracking", {}).get("minTargetPresenceRatio", 0.5)

    frames = kdoc["frames"]
    times = [f["timestampMs"] for f in frames]

    # 대상 track 결정(§8.7). 트랙이 있으면 target 기준, 없으면(구 fixture) 최고 score 폴백.
    track_ids = all_track_ids(frames)
    tracked = len(track_ids) > 0
    target_id = args.target_track if args.target_track else (choose_dominant_track(frames) if tracked else None)

    def select(frame):
        if target_id is None:
            return pick_person(frame)         # 폴백(트랙 없음)
        return pick_target_person(frame, target_id)

    kps = [KP(select(f), idx, min_conf) for f in frames]
    clip_ms = (max(times) - min(times)) if times else 0

    # track-loss: 대상 등장 프레임 비율. 임계 미만이면 각 feature에 경고.
    present = sum(1 for f in frames if select(f) is not None)
    presence_ratio = (present / len(frames)) if frames else 0.0
    track_warnings = ["TARGET_TRACK_LOST"] if (tracked and presence_ratio < min_presence) else []

    features = {}

    def conf_for(names):
        """관여 keypoint 평균 score(대상 가용 프레임) = breakdown.keypoint."""
        vals = []
        for f in frames:
            p = select(f)
            if not p:
                continue
            for nm in names:
                i = idx[nm]
                if i < len(p["keypoints"]):
                    vals.append(p["keypoints"][i][2])
        return round(sum(vals) / len(vals), 4) if vals else 0.0

    def visibility_for(names):
        """가림 보정 = clamp(1 - missingRatio, 0, 1) = min_conf 이상인 관절 비율(0..1, '역수' 아님)."""
        total = visible = 0
        for f in frames:
            p = select(f)
            if not p:
                continue
            for nm in names:
                i = idx[nm]
                if i < len(p["keypoints"]):
                    total += 1
                    if p["keypoints"][i][2] >= min_conf:
                        visible += 1
        return round(visible / total, 4) if total else 0.0

    # usableFrameRatio는 keypoints.quality에서 운반(있을 때만) — 정보용, overall(min) 제외(§8.8 D3a).
    usable_fr = None
    kq = kdoc.get("quality")
    if isinstance(kq, dict) and isinstance(kq.get("usableFrameRatio"), (int, float)):
        usable_fr = kq["usableFrameRatio"]

    def make_conf(names):
        """confidence scalar(overall) + confidenceBreakdown 동시 산출.
        overall = min(keypoint, visibility, tracking?, viewpoint?) — usableFrameRatio 제외(정보용).
        viewpoint 성분은 D3b(시점 융합)에서 채움 — 여기선 omit."""
        kp = conf_for(names)
        vis = visibility_for(names)
        bd = {"keypoint": kp, "visibility": vis}
        comps = [kp, vis]
        if tracked:
            tr = round(presence_ratio, 4)
            bd["tracking"] = tr
            comps.append(tr)
        if usable_fr is not None:
            bd["usableFrameRatio"] = round(float(usable_fr), 4)  # breakdown에만(min 제외)
        return round(min(comps), 4), bd

    # squatDuration: knee angle < 90
    knee_raw = [(times[i], knee_min_angle(kps[i])) for i in range(len(frames))]
    knee_sm = smooth_series(knee_raw, euro)
    thr = cfg["features"]["squatDuration"]["thresholdDeg"]
    samples = [(t, (v is not None and v < thr)) for t, v in knee_sm if v is not None]
    if samples:
        ratio, segs, _ = posture_ratio(samples, max_gap, min_hold)
        ov, bd = make_conf(["left_knee", "right_knee", "left_hip", "right_hip", "left_ankle", "right_ankle"])
        features["squatDuration"] = {
            "kind": "numeric", "metric": "posture_ratio", "value": round(ratio, 4), "unit": "ratio",
            "confidence": ov, "confidenceBreakdown": bd,
            "segments": segs, "warnings": list(track_warnings),
        }

    # overheadHours: wrist>shoulder OR upperarm elevation >= deg
    elev = cfg["features"]["overheadHours"]["criteria"]["upperarmElevationDeg"]
    oh = [(times[i], overhead_active(kps[i], elev)) for i in range(len(frames)) if select(frames[i])]
    if oh:
        ratio, segs, _ = posture_ratio(oh, max_gap, min_hold)
        ov, bd = make_conf(["left_shoulder", "right_shoulder", "left_wrist", "right_wrist", "left_elbow", "right_elbow"])
        features["overheadHours"] = {
            "kind": "numeric", "metric": "posture_ratio", "value": round(ratio, 4), "unit": "ratio",
            "confidence": ov, "confidenceBreakdown": bd,
            "segments": segs, "warnings": list(track_warnings),
        }

    # neckFlexionOver20: neck flexion > 20
    neck_raw = [(times[i], neck_flexion_angle(kps[i])) for i in range(len(frames))]
    neck_sm = smooth_series(neck_raw, euro)
    nthr = cfg["features"]["neckFlexionOver20HoursPerDay"]["thresholdDeg"]
    nsamples = [(t, (v is not None and v > nthr)) for t, v in neck_sm if v is not None]
    if nsamples:
        ratio, segs, _ = posture_ratio(nsamples, max_gap, min_hold)
        ov, bd = make_conf(["left_shoulder", "right_shoulder", "left_ear", "right_ear"])
        features["neckFlexionOver20HoursPerDay"] = {
            "kind": "numeric", "metric": "posture_ratio", "value": round(ratio, 4), "unit": "ratio",
            "confidence": ov, "confidenceBreakdown": bd,
            "segments": segs, "warnings": list(track_warnings),
        }

    # trunkPostureG: peak trunk flexion angle (candidate)
    trunk_raw = [(times[i], trunk_flexion_angle(kps[i])) for i in range(len(frames))]
    trunk_sm = smooth_series(trunk_raw, euro)
    trunk_vals = [v for _, v in trunk_sm if v is not None]
    if trunk_vals:
        ov, bd = make_conf(["left_hip", "right_hip", "left_shoulder", "right_shoulder"])
        features["trunkPostureG"] = {
            "kind": "numeric", "metric": "peak_angle", "value": round(max(trunk_vals), 2), "unit": "degrees",
            "confidence": ov, "confidenceBreakdown": bd,
            "segments": [], "warnings": ["POSTURE_G_MANUAL"] + track_warnings,
        }

    # trunkFlexionOver45Duration: trunk flexion > 45° 유지 비율 (candidate, neckFlexion 미러)
    tthr = cfg["features"]["trunkFlexionOver45Duration"]["thresholdDeg"]
    tsamples = [(t, (v is not None and v > tthr)) for t, v in trunk_sm if v is not None]
    if tsamples:
        ratio, segs, _ = posture_ratio(tsamples, max_gap, min_hold)
        ov, bd = make_conf(["left_hip", "right_hip", "left_shoulder", "right_shoulder"])
        features["trunkFlexionOver45Duration"] = {
            "kind": "numeric", "metric": "posture_ratio", "value": round(ratio, 4), "unit": "ratio",
            "confidence": ov, "confidenceBreakdown": bd,
            "segments": segs, "warnings": list(track_warnings),
        }

    doc = {
        "schemaVersion": 1,
        "featureConfigVersion": cfg["version"],
        "clipRef": kdoc.get("source", {}).get("clipRef", "unknown"),
        "clipDurationMs": round(clip_ms),
        "analyzedFrames": len(frames),
        "features": features,
    }
    # 트랙이 있을 때만 tracking 블록(트랙 없는 구 fixture는 PR C 출력과 동일 유지 — 하위호환).
    if tracked:
        doc["tracking"] = {
            "targetTrackId": target_id,
            "presenceRatio": round(presence_ratio, 4),
            "trackCount": len(track_ids),
        }
    # keypoints.quality(infer_clip 산출) → clip-global quality 복사(있을 때만, D3a). 없는 구 fixture는 미부착.
    if isinstance(kq, dict):
        doc["quality"] = kq
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    trk = f" | track={target_id} presence={round(presence_ratio, 3)} of {len(track_ids)} tracks" if tracked else ""
    print(f"wrote {out} | features: {list(features.keys())}{trk}")


if __name__ == "__main__":
    main()
