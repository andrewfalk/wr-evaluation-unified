"""det 빈도 감소(6.0-15) A/B 검증 하네스 — 같은 클립을 interval off vs on으로 2회 추론해 비교.

측정/게이트 항목(계획 문서 6.0-15):
  - 소요시간·det 실행 수(강제 det 추정 포함)
  - trackId 시퀀스: 신규발급 수(off 대비), 프레임별 IoU 매칭 기반 스왑 검출
  - 공통 트랙 키포인트 좌표 편차(px·bbox 대각선 대비 %), 관절각(팔꿈치/무릎) 시계열 편차 p50/p95
  - hand subset confidence 하락률 + 손목 keypoint loss 프레임 비율(wholebody)
  - feature_calc 결과 diff(반복수·posture_ratio·peak 계열)
  - dominant track 동등성(target 미선택 경로)
  - target 매핑 동등성(mapTargetTrack ±500ms·IoU 0.3 재현 — det 프레임 + 간격 중간(최악) 케이스)

사용:
  .venv/Scripts/python compare_det_interval.py --input clip.mp4 --fps 20 --pose-variant wholebody \
      --interval-sec 1.0 [--device auto] [--out-dir out_ab]
결과: stdout 요약 + <out-dir>/compare_result.json (보고서 VIDEO_DET_INTERVAL_6015.md 입력).
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
PY = sys.executable

# mapTargetTrack(videoAnalysisWorker.ts) 재현용 상수 — 서버 값과 동일해야 의미 있음.
MAX_TIME_GAP_MS = 500
MIN_MATCH_IOU = 0.3

# coco17 관절각(양 variant 공통 — wholebody trimmed도 0..16이 body17).
ANGLES = {
    "elbow_L": (5, 7, 9), "elbow_R": (6, 8, 10),
    "knee_L": (11, 13, 15), "knee_R": (12, 14, 16),
}
MIN_KP_CONF = 0.3  # feature_config.minKeypointConfidence와 동일(각도·loss 판정)


def run_infer(clip, out_json, fps, variant, device, interval_sec, max_frames=0):
    args = [PY, str(HERE / "infer_clip.py"), "--input", str(clip), "--output", str(out_json),
            "--fps", str(fps), "--pose-variant", variant, "--device", device]
    if max_frames:
        args += ["--max-frames", str(max_frames)]
    if interval_sec is not None:
        args += ["--det-interval-sec", str(interval_sec)]
    t0 = time.time()
    proc = subprocess.run(args, capture_output=True, text=True)
    elapsed = time.time() - t0
    if proc.returncode != 0:
        raise SystemExit(f"infer_clip failed (rc={proc.returncode}):\n{proc.stderr[-2000:]}")
    # print 형식: "... | det X/Y (intervalFrames=N) | ..."
    det_runs = interval_frames = None
    for tok in proc.stdout.split("|"):
        tok = tok.strip()
        if tok.startswith("det "):
            det_runs = int(tok.split()[1].split("/")[0])
            interval_frames = int(tok.split("intervalFrames=")[1].rstrip(")"))
    return {"elapsedSec": round(elapsed, 2), "detRuns": det_runs, "intervalFrames": interval_frames,
            "stderrTail": proc.stderr[-500:]}


def run_features(kp_json, out_json):
    proc = subprocess.run([PY, str(HERE / "feature_calc.py"), "--keypoints", str(kp_json),
                           "--output", str(out_json)], capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"feature_calc failed (rc={proc.returncode}):\n{proc.stderr[-2000:]}")
    return json.loads(Path(out_json).read_text(encoding="utf-8"))


def iou_xywh(a, b):
    ax2, ay2 = a[0] + a[2], a[1] + a[3]
    bx2, by2 = b[0] + b[2], b[1] + b[3]
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    union = max(0, a[2]) * max(0, a[3]) + max(0, b[2]) * max(0, b[3]) - inter
    return inter / union if union > 0 else 0.0


def map_target_track(frames, sel_bbox, sel_ts):
    """videoAnalysisWorker.mapTargetTrack 재현: |ts−sel| ≤ 500ms 프레임 중 IoU ≥ 0.3 최대."""
    best = None
    for f in frames:
        if abs(f["timestampMs"] - sel_ts) > MAX_TIME_GAP_MS:
            continue
        for p in f.get("persons", []):
            if not p.get("trackId") or not p.get("bbox"):
                continue
            s = iou_xywh(p["bbox"], sel_bbox)
            if s >= MIN_MATCH_IOU and (best is None or s > best[0]):
                best = (s, p["trackId"])
    return best[1] if best else None


def choose_dominant(frames):
    sys.path.insert(0, str(HERE))
    from feature_calc import choose_dominant_track
    return choose_dominant_track(frames)


def angle_deg(a, b, c):
    v1, v2 = np.array(a) - np.array(b), np.array(c) - np.array(b)
    n1, n2 = np.linalg.norm(v1), np.linalg.norm(v2)
    if n1 == 0 or n2 == 0:
        return None
    cosv = float(np.clip(np.dot(v1, v2) / (n1 * n2), -1.0, 1.0))
    return float(np.degrees(np.arccos(cosv)))


def match_persons(f_off, f_on):
    """같은 프레임의 off/on person을 IoU 최대(≥0.1)로 짝지음 → [(p_off, p_on)]."""
    pairs = []
    used = set()
    for po in f_off.get("persons", []):
        best = None
        for j, pn in enumerate(f_on.get("persons", [])):
            if j in used:
                continue
            s = iou_xywh(po["bbox"], pn["bbox"])
            if s >= 0.1 and (best is None or s > best[0]):
                best = (s, j, pn)
        if best:
            used.add(best[1])
            pairs.append((po, best[2]))
    return pairs


def pctl(vals, q):
    return round(float(np.percentile(np.array(vals), q)), 3) if vals else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--fps", type=float, required=True, help="프로필 fps(posture 5 | repetition 12 | hand-wrist 20)")
    ap.add_argument("--pose-variant", choices=["body", "wholebody"], default="body")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--interval-sec", type=float, default=1.0)
    ap.add_argument("--max-frames", type=int, default=0, help="0=전체(긴 클립 부분 측정용)")
    ap.add_argument("--out-dir", default="out_det_interval_ab")
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    print(f"[1/4] baseline(interval off) 추론: {args.input}")
    kp_off_path = out / "kp_off.json"
    stat_off = run_infer(args.input, kp_off_path, args.fps, args.pose_variant, args.device, None, args.max_frames)
    print(f"      {stat_off['elapsedSec']}s, det {stat_off['detRuns']}")
    print(f"[2/4] active(interval {args.interval_sec}s) 추론")
    kp_on_path = out / "kp_on.json"
    stat_on = run_infer(args.input, kp_on_path, args.fps, args.pose_variant, args.device, args.interval_sec, args.max_frames)
    print(f"      {stat_on['elapsedSec']}s, det {stat_on['detRuns']} (intervalFrames={stat_on['intervalFrames']})")

    kp_off = json.loads(kp_off_path.read_text(encoding="utf-8"))
    kp_on = json.loads(kp_on_path.read_text(encoding="utf-8"))
    frames_off, frames_on = kp_off["frames"], kp_on["frames"]
    assert len(frames_off) == len(frames_on), "샘플 프레임 수 불일치 — 샘플링은 det 간격과 무관해야 함"
    n_frames = len(frames_off)
    n_sched = -(-n_frames // max(1, stat_on["intervalFrames"]))  # ceil — 스케줄상 det 수
    forced_dets = max(0, (stat_on["detRuns"] or 0) - n_sched)

    # --- trackId: 신규발급 수(트랙 개수), 프레임별 매칭 스왑 검출 -------------------
    ids_off = {p["trackId"] for f in frames_off for p in f.get("persons", [])}
    ids_on = {p["trackId"] for f in frames_on for p in f.get("persons", [])}
    id_map = {}   # off trackId -> on trackId (첫 매칭 시 고정)
    swaps = []
    kp_dev_px, kp_dev_ratio, ang_dev = [], [], {k: [] for k in ANGLES}
    hand_conf_off, hand_conf_on, wrist_loss_off, wrist_loss_on = [], [], 0, 0
    n_kpts = len(frames_off[0]["persons"][0]["keypoints"]) if frames_off and frames_off[0].get("persons") else 0
    hand_idx = list(range(17, n_kpts)) if args.pose_variant == "wholebody" else []
    for f_off, f_on in zip(frames_off, frames_on):
        for po, pn in match_persons(f_off, f_on):
            # 스왑: off 트랙이 이전에 짝지어진 on 트랙과 달라짐(교차)
            prev = id_map.get(po["trackId"])
            if prev is None:
                id_map[po["trackId"]] = pn["trackId"]
            elif prev != pn["trackId"]:
                swaps.append((f_off["frameIndex"], po["trackId"], prev, pn["trackId"]))
            ko = np.array([[k[0], k[1], k[2]] for k in po["keypoints"]])
            kn = np.array([[k[0], k[1], k[2]] for k in pn["keypoints"]])
            diag = float(np.hypot(po["bbox"][2], po["bbox"][3])) or 1.0
            d = np.hypot(ko[:, 0] - kn[:, 0], ko[:, 1] - kn[:, 1])
            kp_dev_px.extend(d.tolist())
            kp_dev_ratio.extend((d / diag * 100).tolist())
            for name, (i, j, k) in ANGLES.items():
                if min(ko[i, 2], ko[j, 2], ko[k, 2], kn[i, 2], kn[j, 2], kn[k, 2]) < MIN_KP_CONF:
                    continue
                a_off = angle_deg(ko[i, :2], ko[j, :2], ko[k, :2])
                a_on = angle_deg(kn[i, :2], kn[j, :2], kn[k, :2])
                if a_off is not None and a_on is not None:
                    ang_dev[name].append(abs(a_off - a_on))
            if hand_idx:
                hand_conf_off.append(float(np.mean(ko[hand_idx, 2])))
                hand_conf_on.append(float(np.mean(kn[hand_idx, 2])))
                wrist_loss_off += int(min(ko[9, 2], ko[10, 2]) < MIN_KP_CONF)
                wrist_loss_on += int(min(kn[9, 2], kn[10, 2]) < MIN_KP_CONF)

    # --- features(dominant 경로) --------------------------------------------------
    print("[3/4] feature_calc(off/on, dominant)")
    feat_off = run_features(kp_off_path, out / "feat_off.json")
    feat_on = run_features(kp_on_path, out / "feat_on.json")
    fdiff = {}
    f_off_map = feat_off.get("features") or {}
    f_on_map = feat_on.get("features") or {}
    for key in sorted(set(f_off_map) | set(f_on_map)):
        vo = (f_off_map.get(key) or {}).get("value")
        vn = (f_on_map.get(key) or {}).get("value")
        fdiff[key] = {"off": vo, "on": vn,
                      "delta": (round(vn - vo, 4) if isinstance(vo, (int, float)) and isinstance(vn, (int, float)) else None)}
    dom_off, dom_on = choose_dominant(frames_off), choose_dominant(frames_on)

    # --- target 매핑 동등성(det 프레임 + 간격 중간 최악 케이스) ---------------------
    print("[4/4] target 매핑 동등성(mapTargetTrack 재현)")
    n_int = stat_on["intervalFrames"] or 1
    probe_samples = sorted({s for k in range(0, n_frames, max(1, n_int))
                            for s in (k, min(n_frames - 1, k + n_int // 2))})[:40]
    target_checks = []
    for s in probe_samples:
        f = frames_off[s]
        if not f.get("persons"):
            continue
        sel = f["persons"][0]
        got_off = map_target_track(frames_off, sel["bbox"], f["timestampMs"])
        got_on = map_target_track(frames_on, sel["bbox"], f["timestampMs"])
        expected_on = id_map.get(got_off) if got_off else None
        target_checks.append({"sample": s, "timestampMs": f["timestampMs"],
                              "mid_interval": (s % n_int) != 0,
                              "off": got_off, "on": got_on,
                              "equivalent": got_on is not None and got_on == expected_on})
    target_fail = [c for c in target_checks if not c["equivalent"]]

    result = {
        "input": str(args.input), "fps": args.fps, "variant": args.pose_variant,
        "device": args.device, "intervalSec": args.interval_sec,
        "hashOff": kp_off["model"]["preprocessConfigHash"], "hashOn": kp_on["model"]["preprocessConfigHash"],
        "timing": {"off": stat_off, "on": stat_on,
                   "speedup": round(stat_off["elapsedSec"] / max(0.01, stat_on["elapsedSec"]), 2)},
        "frames": n_frames,
        "detSchedule": {"scheduled": n_sched, "actual": stat_on["detRuns"], "forcedEstimate": forced_dets},
        "tracks": {"offCount": len(ids_off), "onCount": len(ids_on),
                   "newTrackExcess": len(ids_on) - len(ids_off), "swaps": swaps[:20], "swapCount": len(swaps)},
        "keypointDeviation": {"px_p50": pctl(kp_dev_px, 50), "px_p95": pctl(kp_dev_px, 95),
                              "diagPct_p50": pctl(kp_dev_ratio, 50), "diagPct_p95": pctl(kp_dev_ratio, 95)},
        "angleDeviationDeg": {k: {"p50": pctl(v, 50), "p95": pctl(v, 95), "n": len(v)} for k, v in ang_dev.items()},
        "hand": ({"confMeanOff": round(float(np.mean(hand_conf_off)), 4),
                  "confMeanOn": round(float(np.mean(hand_conf_on)), 4),
                  "confDropPct": round((1 - float(np.mean(hand_conf_on)) / max(1e-9, float(np.mean(hand_conf_off)))) * 100, 2),
                  "wristLossFramesOff": wrist_loss_off, "wristLossFramesOn": wrist_loss_on}
                 if hand_conf_off else None),
        "features": fdiff,
        "dominantTrack": {"off": dom_off, "on": dom_on,
                          "equivalent": id_map.get(dom_off) == dom_on if dom_off else dom_on is None},
        "targetMapping": {"checked": len(target_checks), "failed": len(target_fail), "failures": target_fail[:10]},
    }
    (out / "compare_result.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: result[k] for k in
                      ("timing", "detSchedule", "tracks", "keypointDeviation", "angleDeviationDeg",
                       "hand", "dominantTrack", "targetMapping")}, indent=2, ensure_ascii=False))
    print(f"wrote {out / 'compare_result.json'}")


if __name__ == "__main__":
    main()
