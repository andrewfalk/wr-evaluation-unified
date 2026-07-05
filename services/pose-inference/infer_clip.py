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
from keypoint_layout import TRIMMED_SOURCE_INDICES, WHOLEBODY_HAND_SOURCE_INDICES  # noqa: E402 — 단일 source(trimmed 레이아웃)
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

# det 빈도 감소 폴백(6.0-15). 단일 source는 feature_config.json.detection — config 미존재 시 이 값.
# intervalSec 0 = 매 샘플 프레임 det(현행 무변경, 기본 off). 활성(N>1) 시에만 실제 사용 값을
# preprocessConfigHash에 포함한다(기본 off는 기존 해시 완전 보존).
DET_INTERVAL_SEC = 0.0
DET_BBOX_MARGIN_RATIO = 0.15
DET_REDETECT_MIN_SCORE = 0.3
DET_RESYNC_IOU_THRESHOLD = 0.2
DET_BBOX_SANITY = {"maxAreaRatio": 0.9, "aspectRange": [0.15, 6.0], "maxCenterJumpDiagRatio": 0.5}


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


def load_detection_params():
    """feature_config.json.detection에서 det 빈도 감소 파라미터(6.0-15)를 읽는다(단일 source).
    없으면 상수 폴백(intervalSec 0 = 현행 매 프레임 det)."""
    out = {
        "intervalSec": DET_INTERVAL_SEC,
        "bboxMarginRatio": DET_BBOX_MARGIN_RATIO,
        "redetectMinScore": DET_REDETECT_MIN_SCORE,
        "resyncIouThreshold": DET_RESYNC_IOU_THRESHOLD,
        "bboxSanity": dict(DET_BBOX_SANITY),
    }
    try:
        cfg = json.loads((HERE / "feature_config.json").read_text(encoding="utf-8"))
        det = cfg.get("detection", {})
        out["intervalSec"] = float(det.get("intervalSec", out["intervalSec"]))
        out["bboxMarginRatio"] = float(det.get("bboxMarginRatio", out["bboxMarginRatio"]))
        out["redetectMinScore"] = float(det.get("redetectMinScore", out["redetectMinScore"]))
        out["resyncIouThreshold"] = float(det.get("resyncIouThreshold", out["resyncIouThreshold"]))
        sanity = det.get("bboxSanity", {})
        out["bboxSanity"] = {
            "maxAreaRatio": float(sanity.get("maxAreaRatio", DET_BBOX_SANITY["maxAreaRatio"])),
            "aspectRange": [float(v) for v in sanity.get("aspectRange", DET_BBOX_SANITY["aspectRange"])][:2],
            "maxCenterJumpDiagRatio": float(sanity.get("maxCenterJumpDiagRatio", DET_BBOX_SANITY["maxCenterJumpDiagRatio"])),
        }
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return out


def bbox_from_keypoints(kpts, scores, min_conf, margin_ratio, frame_w, frame_h):
    """pose 키포인트 역산 박스(xyxy, 6.0-15). conf>=min_conf 점들의 extent에 변별 마진을 더해
    프레임에 클램프. raw 전체 키포인트(body17/wholebody133 — trimmed 아님) 기준으로 호출할 것.
    유효점 <2 또는 퇴화 박스 → None(호출자가 폐기+다음 프레임 det 강제)."""
    xs, ys = [], []
    for (x, y), s in zip(kpts, scores):
        if float(s) >= min_conf:
            xs.append(float(x))
            ys.append(float(y))
    if len(xs) < 2:
        return None
    x1, x2, y1, y2 = min(xs), max(xs), min(ys), max(ys)
    mx = (x2 - x1) * margin_ratio
    my = (y2 - y1) * margin_ratio
    x1 = max(0.0, x1 - mx)
    y1 = max(0.0, y1 - my)
    x2 = min(float(frame_w), x2 + mx)
    y2 = min(float(frame_h), y2 + my)
    if x2 <= x1 or y2 <= y1:
        return None
    return [x1, y1, x2, y2]


def carry_bbox_sane(bbox, prev_bbox, frame_w, frame_h, sanity):
    """역산 carry 박스 sanity guard(6.0-15). wholebody는 손/얼굴/발 outlier 1점이 박스를 크게 흔들 수
    있어, 비정상 박스는 carry하지 않고 다음 프레임 det로 복구한다. 검사: ①프레임 대비 과대 면적
    ②종횡비(h/w) 정상범위 ③직전 박스(이 프레임 pose 입력) 대비 급격한 중심 이동."""
    x1, y1, x2, y2 = bbox
    w, h = x2 - x1, y2 - y1
    if w <= 0 or h <= 0:
        return False
    if w * h > sanity["maxAreaRatio"] * frame_w * frame_h:
        return False
    aspect = h / w
    if not (sanity["aspectRange"][0] <= aspect <= sanity["aspectRange"][1]):
        return False
    if prev_bbox is not None:
        px1, py1, px2, py2 = prev_bbox
        pw, ph = px2 - px1, py2 - py1
        diag = (pw * pw + ph * ph) ** 0.5
        dx = (x1 + x2) / 2 - (px1 + px2) / 2
        dy = (y1 + y2) / 2 - (py1 + py2) / 2
        if (dx * dx + dy * dy) ** 0.5 > sanity["maxCenterJumpDiagRatio"] * diag:
            return False
    return True


def load_model_shas(variant="body", tier="standard"):
    """recipe(§8.11)에 들어갈 (detectorSha256, poseSha256, weightsComplete)를 만든다(6.0-9).
    variant(+tier, 6.0-14)별 pose 모델(body→pose-body, body+high→pose-body-l, wholebody→pose-wholebody)의
    실제 baked .onnx sha256을 manifest 기대값과 대조해 일치할 때만 verified.
    dev 자동다운로드/오염/다른 모델이면 (None, None, False)
    — manifest의 '정상 해시'를 맹신해 거짓 verified로 만들지 않는다(서버 apply 게이트가 fail-closed)."""
    try:
        from model_loader import verified_model_shas
        return verified_model_shas(variant=variant, tier=tier)
    except (OSError, ValueError, ImportError):
        return None, None, False


def preprocess_config_hash(fps, conv, det, pose, size, track, quality, det_interval=None):
    payload = {"fps": fps, "conv": conv, "det": det, "pose": pose, "inputSize": size,
               "track": track, "quality": quality}  # quality(blurThreshold) 변경 시 재현성 hash 반영(D3a)
    if det_interval is not None:
        # det 빈도 감소 활성(N>1) 시에만 — 행동을 바꾸는 모든 effective detection 파라미터를
        # config와 동일한 필드명으로 포함. 기본(off)은 payload 불변 = 기존 해시 완전 보존(6.0-15).
        # 키는 "detInterval" — 기존 "det"(detector 모델명)와 충돌 금지.
        payload["detInterval"] = det_interval
    raw = json.dumps(payload, sort_keys=True)
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
    ap.add_argument("--pose-tier", choices=["standard", "high", "auto"], default="standard",
                    help="pose 모델 티어(6.0-14, **body 전용 — wholebody에서는 경고 후 무시**): "
                         "standard(기본, rtmpose-s=기존 동작) | "
                         "auto(l/cuda 2단 검증 통과 시에만 rtmpose-l, 실패 시 tier만 강등·디바이스 계약 유지) | "
                         "high(dev 디버그 전용: l+cuda 강제, 불가 시 에러 exit — CPU-l 경로 금지)")
    ap.add_argument("--det-interval-sec", type=float, default=None,
                    help="det 실행 간격 초(6.0-15). 사이 샘플 프레임은 pose 키포인트 역산 박스 재사용 + "
                         "trackId 상속. 미지정=feature_config.json.detection.intervalSec(기본 0=매 프레임 det, "
                         "현행). 명시 시 config 오버라이드(A/B 벤치·dev용). 1 초과 값은 target 매핑 "
                         "±500ms 창을 벗어날 수 있어 서버는 (0,1.0]만 허용.")
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

    from model_loader import (build_pose, cuda_available, available_providers,
                              cuda_session_active, resolve_model_paths, selected_pose_info)

    # 티어 정규화(6.0-14): tier는 body 전용 — wholebody는 standard로 동작(에러 아님, 의도).
    # fallbackReason은 device 폴백 전용 의미라 오염시키지 않고 stderr 경고만 남긴다.
    requested_tier = args.pose_tier
    tier = requested_tier
    if variant != "body" and requested_tier != "standard":
        sys.stderr.write(f"warning: --pose-tier {requested_tier} is body-only; "
                         "wholebody uses its single model (tier ignored)\n")
        tier = "standard"

    def verify_cuda_or_reason(est):
        """(6.0-13) cuda 세션 실사용 검증. ORT는 ①세션 생성 시 ②**첫 추론 시**(cudnn frontend 그래프
        빌드 실패 등) EP 실패를 예외 없이 CPU 폴백으로 처리 — build_pose 성공만으로는 GPU 실행 보장이
        안 된다. 더미 프레임+전체 bbox로 det/pose를 1회씩 실제 실행한 뒤 세션 EP를 재확인한다.
        반환: None(진짜 CUDA) 또는 폴백 사유 문자열."""
        ok, sp = cuda_session_active(est)
        if not ok:
            return f"cuda session init fell back to CPU (sessionProviders={sp})"
        dummy = np.zeros((320, 320, 3), dtype=np.uint8)
        try:
            est.det_model(dummy)
            est.pose_model(dummy, bboxes=np.array([[0.0, 0.0, 320.0, 320.0]]))
        except Exception as e:  # noqa: BLE001 — 워밍업 실패도 폴백 사유로 수렴(분석 자체는 CPU로 가능)
            return f"cuda warmup inference failed: {e}"
        ok, sp = cuda_session_active(est)
        if not ok:
            return f"cuda fell back to CPU at first inference (sessionProviders={sp})"
        return None

    # 디바이스×티어 통합 해석(6.0-12 + 6.0-14). 두 축은 **독립적으로 강등**된다:
    #   - l 실패는 tier만 포기(standard로), --device cuda의 "CPU 금지·불가 시 exit 3" 계약은 불변.
    #   - CPU-l 경로는 어떤 조합에서도 열지 않는다(l은 CUDA 2단 검증과 한 몸).
    # 조합 상태표(계획 문서 6.0-14 §3)가 이 블록의 단일 기준. tier 강등 사유는 stderr 경고만
    # (fallbackReason은 device 폴백 전용 의미 유지 — UI 배지·워커 매핑이 그 의미로 소비).
    requested_device = args.device
    device_used = "cpu"
    device_fallback = False
    fallback_reason = None
    tier_used = "standard"
    if requested_device != "cpu":
        try:
            import onnxruntime as _ort
            if hasattr(_ort, "preload_dlls"):
                _ort.preload_dlls()  # pip nvidia-* 휠의 CUDA/cuDNN DLL 로드(Windows PATH 미등록 대비, ORT>=1.21).
        except Exception:  # noqa: BLE001 — preload 불가 환경(구버전/Linux 시스템 CUDA)은 기존 경로로 진행
            pass

    def try_build_cuda_high():
        """l 추정기 자체를 cuda로 build + 2단 검증(6.0-14). 성공 (est, None) | 실패 (None, 사유).
        판단 기준은 's의 CUDA 검증'이 아니라 'l 세션의 CUDA 검증' — 모델별로 EP 실패 양상이 다를 수 있다."""
        if not resolve_model_paths(variant=variant, tier="high")[4]:
            return None, "pose-body-l not baked"
        try:
            est, _src = build_pose(variant, device="cuda", tier="high")
        except Exception as e:  # noqa: BLE001 — 강등/exit 판단은 호출자
            return None, f"l cuda init failed: {e}"
        why = verify_cuda_or_reason(est)
        if why is not None:
            return None, f"l {why}"
        return est, None

    body = None
    if tier == "high":
        # high = l+cuda 강제(dev 디버그 전용): device 인자와 무관하게 l/cuda 성공만 허용.
        if requested_device == "cpu":
            raise SystemExit("--pose-tier high requires cuda (l+cuda 강제, CPU-l 금지) — --device cpu와 함께 쓸 수 없음")
        if not cuda_available():
            sys.stderr.write(f"__CUDA_UNAVAILABLE__: CUDAExecutionProvider not available (providers={available_providers()})\n")
            raise SystemExit(3)
        body, why = try_build_cuda_high()
        if body is None:
            sys.stderr.write(f"__CUDA_UNAVAILABLE__: high tier(l+cuda) failed: {why}\n")
            raise SystemExit(3)
        device_used = "cuda"
        tier_used = "high"
    elif requested_device == "cpu":
        # tier auto여도 CPU 확정이면 l 시도 자체가 없다(상태표 — CPU-l 금지).
        body, _model_source = build_pose(variant, device="cpu")
    elif requested_device == "cuda":
        if not cuda_available():
            sys.stderr.write(f"__CUDA_UNAVAILABLE__: CUDAExecutionProvider not available (providers={available_providers()})\n")
            raise SystemExit(3)
        if tier == "auto":
            body, why = try_build_cuda_high()
            if body is not None:
                device_used = "cuda"
                tier_used = "high"
            else:
                sys.stderr.write(f"warning: pose tier auto — {why}; using standard tier (device contract kept)\n")
        if body is None:
            # 기존 6.0-12 강제 cuda 경로(standard) — 실패 시 CPU 폴백 없이 exit 3.
            try:
                body, _model_source = build_pose(variant, device="cuda")
                device_used = "cuda"
            except Exception as e:  # noqa: BLE001 — 강제 cuda 실패는 명확 마커로 워커가 CUDA_UNAVAILABLE 매핑
                sys.stderr.write(f"__CUDA_UNAVAILABLE__: cuda init failed: {e}\n")
                raise SystemExit(3)
            silent_fallback = verify_cuda_or_reason(body)
            if silent_fallback is not None:
                # 강제 cuda인데 무성 폴백 → CPU로 계속하면 GPU 배지가 거짓이 됨. 기존 계약대로 마커+exit 3.
                sys.stderr.write(f"__CUDA_UNAVAILABLE__: {silent_fallback}\n")
                raise SystemExit(3)
    else:  # device auto
        if cuda_available():
            if tier == "auto":
                body, why = try_build_cuda_high()
                if body is not None:
                    device_used = "cuda"
                    tier_used = "high"
                else:
                    sys.stderr.write(f"warning: pose tier auto — {why}; using standard tier\n")
            if body is None:
                # 기존 device auto 경로(standard): cuda 시도+검증 → 실패 시 CPU 폴백(deviceFallback 기록).
                try:
                    body, _model_source = build_pose(variant, device="cuda")
                    device_used = "cuda"
                except Exception as e:  # noqa: BLE001 — auto는 분석을 죽이지 않고 CPU로 폴백
                    body, _model_source = build_pose(variant, device="cpu")
                    device_used = "cpu"
                    device_fallback = True
                    fallback_reason = f"cuda init failed, fell back to cpu: {e}"
                if device_used == "cuda":
                    silent_fallback = verify_cuda_or_reason(body)
                    if silent_fallback is not None:
                        # 무성 폴백 상태의 추정기는 이미 CPU 세션이지만, 명시적으로 CPU 재빌드해 상태를 확정.
                        body, _model_source = build_pose(variant, device="cpu")
                        device_used = "cpu"
                        device_fallback = True
                        fallback_reason = f"{silent_fallback}; fell back to cpu"
        else:
            # GPU 자체가 없는 환경 → CPU가 정상 결과(폴백 아님). 사유만 기록. (tier auto여도 l 시도 없음.)
            body, _model_source = build_pose(variant, device="cpu")
            fallback_reason = "no CUDAExecutionProvider available"
    track_iou, track_max_age = load_tracking_params()
    tracker = IoUTracker(iou_threshold=track_iou, max_age=track_max_age)
    blur_threshold = load_quality_blur_threshold()  # config에 있을 때만(기본 None=파생값 비활성)

    # det 빈도 감소(6.0-15): CLI 오버라이드 > feature_config.detection.intervalSec > 폴백 0(off).
    # N은 샘플 프레임 단위 간격. floor(int 절사) — round면 29.97fps에서 N=30→1001ms로 target 매핑
    # ±500ms 창을 벗어난다. N<=1이면 코드 경로·해시 모두 현행과 동일(회귀 0).
    det_cfg = load_detection_params()
    det_interval_sec = det_cfg["intervalSec"] if args.det_interval_sec is None else args.det_interval_sec
    det_interval = max(1, int(det_interval_sec * actual_sampled_fps)) if det_interval_sec > 0 else 1

    frames_out = []
    blur_values = []   # 샘플 프레임별 Laplacian variance(품질검사, D3a)
    sampled_ts = []    # 샘플 프레임 timestampMs(drop 추정용 — 실제 캡처 timestamp)
    sampled = 0
    idx = 0
    det_runs = 0           # det 실행 횟수(벤치·검증 추적)
    frames_since_det = 0   # 마지막 det 이후 샘플 프레임 수
    force_det = False      # score gate/sanity 폐기 발생 시 다음 샘플 프레임 det 강제
    carry = []             # [(trackId, xyxy)] — 직전 프레임 pose 역산 확장 박스(다음 프레임 pose 입력)
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
            # det 실행 여부(6.0-15): 간격 미활성(N<=1)이면 항상 det(현행). 활성이면 N샘플프레임마다,
            # 또는 score gate/sanity 폐기·carry 소진 시 강제. force/carry 조건이 스케줄보다 우선.
            use_det = (det_interval <= 1 or force_det or not carry
                       or frames_since_det + 1 >= det_interval)
            if use_det:
                bboxes = body.det_model(frame)  # (N,4) xyxy
                # det 프레임마다 트래커 갱신(탐지 0이어도 호출해 트랙 age를 진행). xyxy 그대로 매칭.
                # 간격 활성 시 트랙 bbox는 키포인트 역산 박스(타이트)라 det 박스(여유)와 모양이 달라
                # 재동기화 전용 임계(resyncIouThreshold)로 매칭 — ID 신규발급(대상 데이터 단절) 방지.
                xyxy = [[float(b[0]), float(b[1]), float(b[2]), float(b[3])] for b in bboxes]
                track_ids = tracker.update(
                    xyxy, iou_threshold=det_cfg["resyncIouThreshold"] if det_interval > 1 else None)
                det_runs += 1
                frames_since_det = 0
                force_det = False
            else:
                # carry 프레임(6.0-15): det 생략 — 직전 프레임 pose 역산 확장 박스를 pose 입력으로,
                # trackId는 매칭 없이 상속(역산 박스는 정의상 그 트랙의 것 — 매칭은 스왑/신규발급 위험).
                xyxy = [list(b) for _tid, b in carry]
                track_ids = [tid for tid, _b in carry]
                bboxes = np.asarray(xyxy, dtype=np.float32)
                frames_since_det += 1
            persons = []
            next_carry = []    # 다음 프레임 pose 입력 후보: 현재 프레임 pose 역산 박스(stale 방지)
            refresh_map = {}   # tracker state도 동일 박스로 갱신 — 재동기화 IoU 안정화
            # 탐지된 사람이 있을 때만 pose 추정 — 탐지 0이면 빈 프레임(전체이미지 fallback 방지).
            if len(bboxes) > 0:
                kpts, scores = body.pose_model(frame, bboxes=bboxes)
                kpts = np.array(kpts).reshape(-1, n_raw, 2)
                scores = np.array(scores).reshape(-1, n_raw)
                n = min(len(bboxes), kpts.shape[0])
                if det_interval > 1 and n < len(bboxes):
                    # pose가 bbox보다 적게 반환(부분 실패): 누락 인물은 carry 후보가 없어 조용히
                    # 사라질 수 있다(현행 매 프레임 det는 다음 샘플에서 자동 복구되지만 간격 활성 시
                    # 최대 다음 스케줄 det까지 공백). 다음 프레임 det로 전원 재동기화.
                    force_det = True
                for i in range(n):
                    # person.bbox 기록은 "실제 pose 입력 박스"(det 프레임=det box, carry 프레임=직전 역산 박스).
                    bbox = xyxy_to_xywh(xyxy[i])
                    # store_idx로 슬라이스 — wholebody는 body17+hand42(face·feet drop), body는 0..16 전체.
                    kp_scores = [clamp01(scores[i, j]) for j in store_idx]
                    keypoints = [[round(float(kpts[i, j, 0]), 2), round(float(kpts[i, j, 1]), 2), round(sc, 4)]
                                 for j, sc in zip(store_idx, kp_scores)]
                    person_score = round(float(np.mean(kp_scores)), 4)
                    persons.append({
                        "trackId": track_ids[i],  # 결정적 IoU 트래커 부여(PR D2a) / carry 프레임은 상속(6.0-15)
                        "bbox": [round(v, 2) for v in bbox],
                        "score": person_score,
                        "keypoints": keypoints,
                    })
                    if det_interval > 1:
                        # carry 후보 게이트: 역산 실패·평균 score 미달·sanity 위반·(wholebody) 손 붕괴는
                        # carry하지 않고 다음 프레임 det 강제 — 문제 프레임 자체는 복구 불가(본질적 비용,
                        # A/B 하네스가 열화 지표로 게이트).
                        inv = bbox_from_keypoints(kpts[i], scores[i], det_cfg["redetectMinScore"],
                                                  det_cfg["bboxMarginRatio"], width, height)
                        ok_carry = (inv is not None
                                    and person_score >= det_cfg["redetectMinScore"]
                                    and carry_bbox_sane(inv, xyxy[i], width, height, det_cfg["bboxSanity"]))
                        if ok_carry and variant == "wholebody":
                            # hand subset gate: 몸통 conf가 높으면 평균이 손 붕괴를 가린다(손목 분석 보호).
                            hand_mean = float(np.mean(
                                [clamp01(scores[i, j]) for j in WHOLEBODY_HAND_SOURCE_INDICES]))
                            ok_carry = hand_mean >= det_cfg["redetectMinScore"]
                        if ok_carry:
                            next_carry.append((track_ids[i], inv))
                            refresh_map[track_ids[i]] = inv
                        else:
                            force_det = True
            if det_interval > 1:
                # carry 프레임은 refresh가 age 진행 담당(update 미호출), det 프레임은 update가 이미
                # 진행했으므로 bbox 교체만(advance_age=False) — 한 프레임 age 2회 증가(조기 은퇴) 금지.
                tracker.refresh(refresh_map, advance_age=not use_det)
                if not next_carry:
                    force_det = True
                carry = next_carry
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

    detector_sha256, pose_sha256, weights_complete = load_model_shas(variant, tier=tier_used)

    # modelVersion: body(standard)는 기존값 유지(회귀 0), wholebody는 variant 접미사(6.0-10),
    # body+l(6.0-14)은 "/body-l" 접미사 — recipe·analysisBundleVersion(mdl:)에 티어가 실려 추적된다.
    model_version = f"rtmlib-{RTMLIB_VERSION}" if variant == "body" else f"rtmlib-{RTMLIB_VERSION}/{variant}"
    # pose 기록 필드: standard는 vcfg 고정값 그대로(기존 출력·preprocessConfigHash 완전 보존 — 기존 분석과의
    # recipe 일관성 유지). high일 때만 실제 선택된 manifest 항목(pose-body-l) 기준으로 교체.
    pose_name = vcfg["pose"]
    pose_input_size = vcfg["inputSize"]
    model_name = vcfg["modelName"]
    if tier_used == "high":
        pinfo = selected_pose_info(variant=variant, tier="high") or {}
        pose_name = pinfo.get("name") or "rtmpose-l_simcc-body7"
        pose_input_size = list(pinfo.get("inputSize") or POSE_INPUT_SIZE)
        model_name = "rtmlib:body:performance-l"
        model_version = f"rtmlib-{RTMLIB_VERSION}/body-l"

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
            "pose": pose_name,
            "inputSize": pose_input_size,
            "modelName": model_name,
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
            # l 사용 시 pose 이름이 바뀌어 hash도 달라진다 — 의도(재현성·recipe 일관성 검사의 근거, 6.0-14).
            "preprocessConfigHash": preprocess_config_hash(
                args.fps, convention, vcfg["detector"], pose_name, pose_input_size,
                {"iou": track_iou, "maxAge": track_max_age},  # 실제 사용 값(재현성)
                {"blurThreshold": blur_threshold},  # quality threshold도 재현성 hash에 포함(D3a)
                # det 빈도 감소(6.0-15) 활성 시에만 — 행동을 바꾸는 모든 파라미터, config와 동일 필드명.
                det_interval={
                    "intervalFrames": det_interval,
                    "bboxMarginRatio": det_cfg["bboxMarginRatio"],
                    "resyncIouThreshold": det_cfg["resyncIouThreshold"],
                    "redetectMinScore": det_cfg["redetectMinScore"],
                    "bboxSanity": det_cfg["bboxSanity"],
                } if det_interval > 1 else None,
            ),
        },
        "frames": frames_out,
    }
    if quality is not None:
        doc["quality"] = quality  # optional — PR B/C/D2 산출 하위호환

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"wrote {out} | sampled {sampled} frames | det {det_runs}/{sampled} (intervalFrames={det_interval})"
          f" | {elapsed:.1f}s | {elapsed / max(1, sampled) * 1000:.0f}ms/frame")


if __name__ == "__main__":
    main()
