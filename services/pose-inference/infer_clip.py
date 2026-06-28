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
import sys
import time
from importlib.metadata import PackageNotFoundError, version as pkg_version
from pathlib import Path

import cv2
import numpy as np

from model_loader import build_body
from tracker import IoUTracker

try:
    RTMLIB_VERSION = pkg_version("rtmlib")  # 실제 설치 버전 기록(메타데이터 거짓 방지)
except PackageNotFoundError:
    RTMLIB_VERSION = "unknown"

SCHEMA_VERSION = 1
KEYPOINT_CONVENTION = "coco17"  # rtmlib body = COCO 17점 (body variant 기본)
# rtmlib lightweight body 백엔드 모델(자동 다운로드). detector는 yolox-tiny(사람탐지),
# pose는 rtmpose-s. PRD의 RTMDet은 교체 가능 — 계약은 detector-agnostic.
DETECTOR_NAME = "yolox_tiny_humanart"
POSE_NAME = "rtmpose-s_body7"
POSE_INPUT_SIZE = [192, 256]  # (w, h)
HERE = Path(__file__).parent

# pose variant 정의(6.0-10). hand-wrist 클립만 wholebody on-demand(나머지 body17).
# wholebody는 133점 추출 후 body17+hand42=59만 저장(face·feet drop) — sourceIndices로 슬라이스.
# body 값은 기존과 동일(회귀 0): modelVersion·convention·pose·hash 무변경.
from keypoint_layout import TRIMMED_SOURCE_INDICES  # noqa: E402 — 단일 source(trimmed 레이아웃)
POSE_VARIANTS = {
    "body": {
        "convention": "coco17", "nKpts": 17, "sourceIndices": None,
        "detector": DETECTOR_NAME, "pose": POSE_NAME, "inputSize": POSE_INPUT_SIZE,
        "modelName": "rtmlib:body:lightweight",
    },
    "wholebody": {
        "convention": "wholebody133-trimmed", "nKpts": 133, "sourceIndices": TRIMMED_SOURCE_INDICES,
        "detector": DETECTOR_NAME, "pose": "rtmw-dw-l-m", "inputSize": [192, 256],
        "modelName": "rtmlib:wholebody:lightweight",
    },
}
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


def load_model_shas(variant="body"):
    """recipe(§8.11)에 들어갈 (detectorSha256, poseSha256, weightsComplete)를 만든다(6.0-9).
    variant별 pose 모델(body→pose-body, wholebody→pose-wholebody)의 실제 baked .onnx sha256을
    manifest 기대값과 대조해 일치할 때만 verified. dev 자동다운로드/오염/다른 모델이면 (None, None, False)
    — manifest의 '정상 해시'를 맹신해 거짓 verified로 만들지 않는다(서버 apply 게이트가 fail-closed)."""
    try:
        from model_loader import verified_model_shas
        return verified_model_shas(variant=variant)
    except (OSError, ValueError, ImportError):
        return None, None, False


def preprocess_config_hash(fps, conv, det, pose, size, track, quality):
    raw = json.dumps(
        {"fps": fps, "conv": conv, "det": det, "pose": pose, "inputSize": size,
         "track": track, "quality": quality},  # quality(blurThreshold) 변경 시 재현성 hash 반영(D3a)
        sort_keys=True,
    )
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def xyxy_to_xywh(b):
    x1, y1, x2, y2 = [float(v) for v in b[:4]]
    return [x1, y1, x2 - x1, y2 - y1]


def clamp01(v):
    # RTMPose SimCC 점수는 엄밀한 확률이 아니라 가끔 1을 살짝 초과 → confidence로 [0,1] 클램프.
    return max(0.0, min(1.0, float(v)))


def summarize_blur(blur_values):
    """Laplacian variance 분포 요약(raw metric, 6.0-6b D3a). threshold 무관하게 항상 산출."""
    arr = np.array(blur_values, dtype=float)
    return {
        "mean": round(float(np.mean(arr)), 2),
        "p10": round(float(np.percentile(arr, 10)), 2),
        "median": round(float(np.median(arr)), 2),
    }


def drop_ratio_from_timestamps(timestamps):
    """실제 timestamp 중앙값 간격 기준 frame-drop 비율(§8.8). 요청 fps 고정 step 오판 방지.
    중앙값 대비 간격이 배수로 벌어진 만큼을 누락 프레임으로 추정."""
    if len(timestamps) < 2:
        return 0.0
    diffs = [b - a for a, b in zip(timestamps[:-1], timestamps[1:]) if b > a]
    if not diffs:
        return 0.0
    med = float(np.median(diffs))
    if med <= 0:
        return 0.0
    missing = sum(max(0, int(round(d / med)) - 1) for d in diffs)
    return round(missing / (missing + len(timestamps)), 4)


def load_quality_blur_threshold():
    """feature_config.json.quality.blurThreshold(있을 때만). 기본 None = threshold 파생값(blurRatio/
    usableFrameRatio) 비활성(D3a: 검증 전 추정 금지). raw blurMetric/dropRatio는 threshold와 무관."""
    try:
        cfg = json.loads((HERE / "feature_config.json").read_text(encoding="utf-8"))
        bt = cfg.get("quality", {}).get("blurThreshold")
        return float(bt) if bt is not None else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def write_overlay_frame(frame, frames_dir, frame_index, max_width=480, quality=70):
    """샘플 프레임을 다운스케일 JPEG(<frameIndex>.jpg)로 저장 — overlay 검수 게이트(privacy 예외).
    best-effort: mkdir/resize/imwrite 실패를 삼키고 bool 반환(추론 전체로 절대 전파 금지)."""
    try:
        h, w = frame.shape[:2]
        out = frame
        if w > max_width:
            scale = max_width / float(w)
            out = cv2.resize(frame, (max_width, max(1, int(round(h * scale)))), interpolation=cv2.INTER_AREA)
        Path(frames_dir).mkdir(parents=True, exist_ok=True)
        path = Path(frames_dir) / f"{frame_index}.jpg"
        return bool(cv2.imwrite(str(path), out, [int(cv2.IMWRITE_JPEG_QUALITY), quality]))
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--fps", type=float, default=5.0, help="target sampling fps")
    ap.add_argument("--max-frames", type=int, default=0, help="0 = all sampled frames")
    ap.add_argument("--frames-dir", default=None,
                    help="지정 시 각 샘플 프레임을 <frameIndex>.jpg로 저장(overlay 검수 게이트, best-effort)")
    ap.add_argument("--pose-variant", choices=list(POSE_VARIANTS), default="body",
                    help="body=coco17(기본) | wholebody=133점 추출→body17+hand42=59 저장(손목분석, 6.0-10)")
    ap.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto",
                    help="추론 디바이스(6.0-12): auto(GPU 가능 시 사용·실패 시 CPU 폴백) | cpu | cuda(강제, 실패 시 에러)")
    args = ap.parse_args()
    variant = args.pose_variant
    vcfg = POSE_VARIANTS[variant]
    convention = vcfg["convention"]
    n_raw = vcfg["nKpts"]
    # 저장 인덱스: wholebody는 trimmed(body17+hand42), body는 전체(0..16). 출력 keypoints 순서·개수를 결정.
    store_idx = vcfg["sourceIndices"] if vcfg["sourceIndices"] is not None else list(range(n_raw))

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        raise SystemExit(f"cannot open video: {args.input}")
    orig_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    step = max(1, round(orig_fps / args.fps))
    actual_sampled_fps = orig_fps / step  # 정수 step 때문에 요청값과 다를 수 있음 — 실제값을 기록

    from model_loader import build_pose, cuda_available, available_providers
    # 디바이스 해석(6.0-12): auto=GPU 가능 시 사용·init 실패 시 CPU 폴백, cuda=강제(불가/실패 시 마커+nonzero exit).
    requested_device = args.device
    device_used = "cpu"
    device_fallback = False
    fallback_reason = None
    if requested_device == "cpu":
        body, _model_source = build_pose(variant, device="cpu")
    elif requested_device == "cuda":
        if not cuda_available():
            sys.stderr.write(f"__CUDA_UNAVAILABLE__: CUDAExecutionProvider not available (providers={available_providers()})\n")
            raise SystemExit(3)
        try:
            body, _model_source = build_pose(variant, device="cuda")
            device_used = "cuda"
        except Exception as e:  # noqa: BLE001 — 강제 cuda 실패는 명확 마커로 워커가 CUDA_UNAVAILABLE 매핑
            sys.stderr.write(f"__CUDA_UNAVAILABLE__: cuda init failed: {e}\n")
            raise SystemExit(3)
    else:  # auto
        if cuda_available():
            try:
                body, _model_source = build_pose(variant, device="cuda")
                device_used = "cuda"
            except Exception as e:  # noqa: BLE001 — auto는 분석을 죽이지 않고 CPU로 폴백
                body, _model_source = build_pose(variant, device="cpu")
                device_used = "cpu"
                device_fallback = True
                fallback_reason = f"cuda init failed, fell back to cpu: {e}"
        else:
            # GPU 자체가 없는 환경 → CPU가 정상 결과(폴백 아님). 사유만 기록.
            body, _model_source = build_pose(variant, device="cpu")
            fallback_reason = "no CUDAExecutionProvider available"
    track_iou, track_max_age = load_tracking_params()
    tracker = IoUTracker(iou_threshold=track_iou, max_age=track_max_age)
    blur_threshold = load_quality_blur_threshold()  # config에 있을 때만(기본 None=파생값 비활성)

    frames_out = []
    blur_values = []   # 샘플 프레임별 Laplacian variance(품질검사, D3a)
    sampled_ts = []    # 샘플 프레임 timestampMs(drop 추정용 — 실제 캡처 timestamp)
    sampled = 0
    idx = 0
    t0 = time.time()
    while True:
        # 실제 캡처 timestamp(VFR·프레임드롭 반영). read 전 위치 = 곧 읽을 프레임의 ts.
        pos_msec = cap.get(cv2.CAP_PROP_POS_MSEC)
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            # POS_MSEC가 유효하면 실제 timestamp, 아니면(0/미지원) idx/orig_fps 폴백.
            ts_ms = round(pos_msec) if (pos_msec and pos_msec > 0) else round(idx / orig_fps * 1000)
            # 품질 메타: 픽셀 접근 가능한 여기(infer_clip)에서만 산출(feature_calc는 keypoints만 입력).
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            blur_values.append(float(cv2.Laplacian(gray, cv2.CV_64F).var()))
            sampled_ts.append(ts_ms)
            bboxes = body.det_model(frame)  # (N,4) xyxy
            # 매 샘플 프레임마다 트래커 갱신(탐지 0이어도 호출해 트랙 age를 진행). xyxy 그대로 매칭.
            xyxy = [[float(b[0]), float(b[1]), float(b[2]), float(b[3])] for b in bboxes]
            track_ids = tracker.update(xyxy)
            persons = []
            # 탐지된 사람이 있을 때만 pose 추정 — 탐지 0이면 빈 프레임(전체이미지 fallback 방지).
            if len(bboxes) > 0:
                kpts, scores = body.pose_model(frame, bboxes=bboxes)
                kpts = np.array(kpts).reshape(-1, n_raw, 2)
                scores = np.array(scores).reshape(-1, n_raw)
                n = min(len(bboxes), kpts.shape[0])
                for i in range(n):
                    bbox = xyxy_to_xywh(bboxes[i])
                    # store_idx로 슬라이스 — wholebody는 body17+hand42(face·feet drop), body는 0..16 전체.
                    kp_scores = [clamp01(scores[i, j]) for j in store_idx]
                    keypoints = [[round(float(kpts[i, j, 0]), 2), round(float(kpts[i, j, 1]), 2), round(sc, 4)]
                                 for j, sc in zip(store_idx, kp_scores)]
                    persons.append({
                        "trackId": track_ids[i],  # 결정적 IoU 트래커 부여(PR D2a)
                        "bbox": [round(v, 2) for v in bbox],
                        "score": round(float(np.mean(kp_scores)), 4),
                        "keypoints": keypoints,
                    })
            frames_out.append({
                "frameIndex": idx,
                "timestampMs": ts_ms,
                "persons": persons,
            })
            # overlay 검수 게이트(privacy 예외): 디코드된 프레임을 frameIndex로 저장(best-effort, 실패 무전파).
            if args.frames_dir:
                write_overlay_frame(frame, args.frames_dir, idx)
            sampled += 1
            if args.max_frames and sampled >= args.max_frames:
                break
        idx += 1
    cap.release()
    elapsed = time.time() - t0

    # 품질 메타(D3a): raw blurMetric/dropRatio는 항상, threshold 파생값은 config에 blurThreshold 있을 때만.
    quality = None
    if blur_values:
        drop_ratio = drop_ratio_from_timestamps(sampled_ts)
        quality = {
            "blurMetric": summarize_blur(blur_values),
            "dropRatio": drop_ratio,
            "sampledFps": round(actual_sampled_fps, 4),
        }
        if blur_threshold is not None:
            blur_ratio = round(sum(1 for b in blur_values if b < blur_threshold) / len(blur_values), 4)
            quality["blurThreshold"] = blur_threshold
            quality["blurRatio"] = blur_ratio
            # usableFrameRatio = blur∪drop 제외 후 사용가능 비율(정보용 — overall·게이팅 미입력, 6.0-B2까지).
            quality["usableFrameRatio"] = round(max(0.0, 1.0 - min(1.0, blur_ratio + drop_ratio)), 4)

    detector_sha256, pose_sha256, weights_complete = load_model_shas(variant)

    # modelVersion: body는 기존값 유지(회귀 0), wholebody만 variant 접미사(bundle mdl: 구분 강화, 6.0-10).
    model_version = f"rtmlib-{RTMLIB_VERSION}" if variant == "body" else f"rtmlib-{RTMLIB_VERSION}/{variant}"

    doc = {
        "schemaVersion": SCHEMA_VERSION,
        "keypointConvention": convention,
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
            "detector": vcfg["detector"],
            "pose": vcfg["pose"],
            "inputSize": vcfg["inputSize"],
            "modelName": vcfg["modelName"],
            "modelVersion": model_version,
            # recipe 재현성(6.0-9): 실제 실행 .onnx 가중치 해시. 미반입(PoC/dev)이면 null + weightsComplete=False.
            "detectorSha256": detector_sha256,
            "poseSha256": pose_sha256,
            "weightsComplete": weights_complete,
            # 추론 디바이스(6.0-12): 워커가 읽어 job에 기록 → 검토 UI 실행 모드 배지.
            "requestedDevice": requested_device,
            "deviceUsed": device_used,
            "deviceFallback": device_fallback,
            "fallbackReason": fallback_reason,
            "preprocessConfigHash": preprocess_config_hash(
                args.fps, convention, vcfg["detector"], vcfg["pose"], vcfg["inputSize"],
                {"iou": track_iou, "maxAge": track_max_age},  # 실제 사용 값(재현성)
                {"blurThreshold": blur_threshold},  # quality threshold도 재현성 hash에 포함(D3a)
            ),
        },
        "frames": frames_out,
    }
    if quality is not None:
        doc["quality"] = quality  # optional — PR B/C/D2 산출 하위호환

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"wrote {out} | sampled {sampled} frames | {elapsed:.1f}s | {elapsed / max(1, sampled) * 1000:.0f}ms/frame")


if __name__ == "__main__":
    main()
