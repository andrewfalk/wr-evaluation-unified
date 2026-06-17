"""
단일 클립 RTMPose(ONNX/CPU) PoC — keypoints.json 산출 (6.0-5, PR B).

rtmlib(YOLOX 사람탐지 + RTMPose-s 포즈)로 클립을 profile별 fps로 샘플링해
관절 좌표 시계열을 keypoints 계약(schema/keypoints.schema.json) 형태로 출력한다.
앱/서버 결선 없음 — 독립 오프라인 PoC. 실제 추론 위치/큐 결선은 M2 PR D.

사용:
  python infer_clip.py --input samples/clip.mp4 --output out/keypoints.json --fps 5 [--max-frames N]
"""
import argparse
import hashlib
import json
import time
from importlib.metadata import PackageNotFoundError, version as pkg_version
from pathlib import Path

import cv2
import numpy as np
from rtmlib import Body

from tracker import IoUTracker

try:
    RTMLIB_VERSION = pkg_version("rtmlib")  # 실제 설치 버전 기록(메타데이터 거짓 방지)
except PackageNotFoundError:
    RTMLIB_VERSION = "unknown"

SCHEMA_VERSION = 1
KEYPOINT_CONVENTION = "coco17"  # rtmlib body = COCO 17점
# rtmlib lightweight body 백엔드 모델(자동 다운로드). detector는 yolox-tiny(사람탐지),
# pose는 rtmpose-s. PRD의 RTMDet은 교체 가능 — 계약은 detector-agnostic.
DETECTOR_NAME = "yolox_tiny_humanart"
POSE_NAME = "rtmpose-s_body7"
POSE_INPUT_SIZE = [192, 256]  # (w, h)
HERE = Path(__file__).parent
# 트래커 파라미터 폴백(PR D2a). 단일 source는 feature_config.json.tracking(PR D2b) — config 미존재 시 이 값.
# 재현성을 위해 실제 사용 값을 preprocessConfigHash 입력에 포함한다.
TRACK_IOU_THRESHOLD = 0.3
TRACK_MAX_AGE = 10


def load_tracking_params():
    """feature_config.json.tracking에서 트래커 파라미터를 읽는다(단일 source). 없으면 상수 폴백."""
    iou, max_age = TRACK_IOU_THRESHOLD, TRACK_MAX_AGE
    try:
        cfg = json.loads((HERE / "feature_config.json").read_text(encoding="utf-8"))
        trk = cfg.get("tracking", {})
        iou = float(trk.get("iouThreshold", iou))
        max_age = int(trk.get("maxAgeFrames", max_age))
    except (OSError, ValueError, KeyError):
        pass
    return iou, max_age


def preprocess_config_hash(fps, conv, det, pose, size, track):
    raw = json.dumps(
        {"fps": fps, "conv": conv, "det": det, "pose": pose, "inputSize": size, "track": track},
        sort_keys=True,
    )
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def xyxy_to_xywh(b):
    x1, y1, x2, y2 = [float(v) for v in b[:4]]
    return [x1, y1, x2 - x1, y2 - y1]


def clamp01(v):
    # RTMPose SimCC 점수는 엄밀한 확률이 아니라 가끔 1을 살짝 초과 → confidence로 [0,1] 클램프.
    return max(0.0, min(1.0, float(v)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--fps", type=float, default=5.0, help="target sampling fps")
    ap.add_argument("--max-frames", type=int, default=0, help="0 = all sampled frames")
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        raise SystemExit(f"cannot open video: {args.input}")
    orig_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    step = max(1, round(orig_fps / args.fps))
    actual_sampled_fps = orig_fps / step  # 정수 step 때문에 요청값과 다를 수 있음 — 실제값을 기록

    body = Body(mode="lightweight", backend="onnxruntime", device="cpu")
    track_iou, track_max_age = load_tracking_params()
    tracker = IoUTracker(iou_threshold=track_iou, max_age=track_max_age)

    frames_out = []
    sampled = 0
    idx = 0
    t0 = time.time()
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            bboxes = body.det_model(frame)  # (N,4) xyxy
            # 매 샘플 프레임마다 트래커 갱신(탐지 0이어도 호출해 트랙 age를 진행). xyxy 그대로 매칭.
            xyxy = [[float(b[0]), float(b[1]), float(b[2]), float(b[3])] for b in bboxes]
            track_ids = tracker.update(xyxy)
            persons = []
            # 탐지된 사람이 있을 때만 pose 추정 — 탐지 0이면 빈 프레임(전체이미지 fallback 방지).
            if len(bboxes) > 0:
                kpts, scores = body.pose_model(frame, bboxes=bboxes)
                kpts = np.array(kpts).reshape(-1, 17, 2)
                scores = np.array(scores).reshape(-1, 17)
                n = min(len(bboxes), kpts.shape[0])
                for i in range(n):
                    bbox = xyxy_to_xywh(bboxes[i])
                    kp_scores = [clamp01(scores[i, j]) for j in range(17)]
                    keypoints = [[round(float(kpts[i, j, 0]), 2), round(float(kpts[i, j, 1]), 2), round(kp_scores[j], 4)] for j in range(17)]
                    persons.append({
                        "trackId": track_ids[i],  # 결정적 IoU 트래커 부여(PR D2a)
                        "bbox": [round(v, 2) for v in bbox],
                        "score": round(float(np.mean(kp_scores)), 4),
                        "keypoints": keypoints,
                    })
            frames_out.append({
                "frameIndex": idx,
                "timestampMs": round(idx / orig_fps * 1000),
                "persons": persons,
            })
            sampled += 1
            if args.max_frames and sampled >= args.max_frames:
                break
        idx += 1
    cap.release()
    elapsed = time.time() - t0

    doc = {
        "schemaVersion": SCHEMA_VERSION,
        "keypointConvention": KEYPOINT_CONVENTION,
        "coordinateSpace": "pixel",
        "frameWidth": width,
        "frameHeight": height,
        "requestedFps": args.fps,
        "sampledFps": round(actual_sampled_fps, 4),  # 실제 샘플링 fps(= orig_fps / step)
        "source": {
            "clipRef": Path(args.input).name,
            "originalFps": round(orig_fps, 3),
            "totalFrames": total,
        },
        "model": {
            "detector": DETECTOR_NAME,
            "pose": POSE_NAME,
            "inputSize": POSE_INPUT_SIZE,
            "modelName": "rtmlib:body:lightweight",
            "modelVersion": f"rtmlib-{RTMLIB_VERSION}",
            "preprocessConfigHash": preprocess_config_hash(
                args.fps, KEYPOINT_CONVENTION, DETECTOR_NAME, POSE_NAME, POSE_INPUT_SIZE,
                {"iou": track_iou, "maxAge": track_max_age},  # 실제 사용 값(재현성)
            ),
        },
        "frames": frames_out,
    }

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"wrote {out} | sampled {sampled} frames | {elapsed:.1f}s | {elapsed / max(1, sampled) * 1000:.0f}ms/frame")


if __name__ == "__main__":
    main()
