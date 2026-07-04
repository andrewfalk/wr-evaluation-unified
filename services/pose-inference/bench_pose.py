"""(벤치 도구, 6.0-10 평가용) body17 vs wholebody133 프레임당 ms·피크 RAM 비교.

현재 운영(Body lightweight: yolox416 + rtmpose-s 192x256)을 기준으로, pose만 wholebody
lightweight(rtmw-dw-l-m 192x256, 동일 입력크기)로 바꿨을 때의 프레임당 추론시간(det/pose 분리)과
프로세스 피크 RSS를 측정한다. 모델별로 별도 프로세스에서 1회씩 실행해 RAM을 깨끗하게 잰다.

가중치는 model_loader.build_pose()로 로드 — POSE_MODELS_DIR(또는 ./models)에 baked .onnx가 있으면
그걸 쓰고(에어갭·다운로드 없음), 없으면 rtmlib 자동 다운로드(dev 폴백). 출력 modelSource로 구분.

dev(Windows) 사용:
    python bench_pose.py --model body
    python bench_pose.py --model wholebody

운영 절대값 측정(Linux 컨테이너, compose cpu/mem 제한 그대로 적용 — 서버 실측):
    # 운영 app 컨테이너 안에서 실행(이미지에 추론·baked 가중치 동봉). 컨테이너명은 docker ps로 확인.
    docker exec -e POSE_MODELS_DIR=/app/services/pose-inference/models wr-prod-app-1 \
      python services/pose-inference/bench_pose.py --model wholebody --input /tmp/clip.mp4
    docker exec ... --model body --input /tmp/clip.mp4
  → compose의 cpus/mem_limit 하 절대 totalMsPerFrame·peakRssMB가 나온다(타임아웃·동시성 결정 입력).
  cpu 제한을 임시로 바꿔 재보려면: docker run --rm --cpus=2 --memory=2g -e POSE_MODELS_DIR=... <image> python .../bench_pose.py ...
"""
import argparse
import json
import os
import sys
import time

import cv2
import numpy as np

# RAM 측정은 OS 분기 — Windows는 psapi PeakWorkingSetSize, Linux/posix는 /proc(VmRSS/VmHWM)·ru_maxrss.
# psapi/WinDLL은 Linux에서 import 자체가 실패하므로 win32에서만 로드한다.
if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    class _PMC(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

    _k32 = ctypes.WinDLL("kernel32")
    _psapi = ctypes.WinDLL("psapi")
    _k32.GetCurrentProcess.restype = wintypes.HANDLE
    _psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PMC), wintypes.DWORD]
    _psapi.GetProcessMemoryInfo.restype = wintypes.BOOL

    def mem_mb():
        c = _PMC()
        c.cb = ctypes.sizeof(c)
        if not _psapi.GetProcessMemoryInfo(_k32.GetCurrentProcess(), ctypes.byref(c), c.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        return c.WorkingSetSize / 1e6, c.PeakWorkingSetSize / 1e6  # (current, peak) MB
else:
    def _proc_status_kb(key):
        try:
            with open("/proc/self/status", encoding="ascii") as f:
                for line in f:
                    if line.startswith(key):
                        return float(line.split()[1])  # kB
        except OSError:
            return None
        return None

    def mem_mb():
        # 운영(에어갭 리눅스 컨테이너): VmRSS=현재, VmHWM=피크. /proc 미존재 시 ru_maxrss 폴백.
        cur_kb = _proc_status_kb("VmRSS:")
        peak_kb = _proc_status_kb("VmHWM:")
        if peak_kb is None:
            import resource
            peak_kb = float(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)  # Linux: kB
            cur_kb = cur_kb if cur_kb is not None else peak_kb
        return (cur_kb or 0.0) / 1000.0, peak_kb / 1000.0  # kB → MB(소수, Windows /1e6과 동일 척도)


def pct(vals, p):
    return round(float(np.percentile(np.array(vals, dtype=float), p)), 1)


def parse_size(s):
    """"192,256" → (192, 256). rtmlib 입력크기 인자는 (w, h) — manifest [192,256] 규약과 동일.
    주의: OpenMMLab 파일명 "256x192"는 H×W 표기 → 이 인자에는 192,256으로 넣어야 한다(6.0-13)."""
    try:
        w, h = (int(v) for v in s.split(","))
        return (w, h)
    except ValueError:
        raise SystemExit(f"invalid size {s!r} (expected 'w,h' e.g. 192,256)")


def smoke_check(m, frames, nk):
    """(6.0-13) 오버라이드 모델의 rtmlib 출력 계약 검증 — 조용한 무의미 벤치 방지.
    최소 1명 검출되는 프레임을 찾아 bbox 좌표(finite, x2>x1, y2>y1)·kpts shape·score 유한성을 확인한다.
    bbox는 (N,4)만 허용 — 측정 루프·운영 infer_clip 모두 det 출력을 그대로 pose에 넘기는 (N,4) 계약이라,
    다른 포맷(예: score 포함 (N,5))은 슬라이스로 우회하지 않고 즉시 실패시킨다.
    pose score는 [0,1] 체크 금지(RTMPose SimCC는 1을 살짝 초과 가능 — infer_clip clamp01 참고)."""
    for fr in frames:
        raw = m.det_model(fr)
        b = np.asarray(raw, dtype=float)
        if b.size == 0:
            continue
        if b.ndim != 2 or b.shape[1] != 4:
            raise SystemExit(f"smoke: unexpected bbox shape {b.shape} (expected (N,4))")
        if not np.all(np.isfinite(b)):
            raise SystemExit("smoke: non-finite bbox values")
        if not (np.all(b[:, 2] > b[:, 0]) and np.all(b[:, 3] > b[:, 1])):
            raise SystemExit("smoke: degenerate bbox (x2<=x1 or y2<=y1)")
        # 측정 루프와 동일한 입력 경로: det 출력을 가공 없이 pose에 전달.
        kpts, scores = m.pose_model(fr, bboxes=raw)
        k = np.asarray(kpts, dtype=float)
        s = np.asarray(scores, dtype=float)
        # reshape(-1,...)는 총 원소 수만 맞으면 통과하므로 금지 — 원 shape를 명시적으로 검사한다.
        if k.ndim != 3 or k.shape[1:] != (nk, 2):
            raise SystemExit(f"smoke: unexpected kpts shape {k.shape} (expected (N, {nk}, 2))")
        if s.shape != k.shape[:2]:
            raise SystemExit(f"smoke: scores shape {s.shape} != persons x kpts {k.shape[:2]}")
        if not np.all(np.isfinite(k)) or not np.all(np.isfinite(s)):
            raise SystemExit("smoke: non-finite keypoints/scores")
        return {"personsInSmokeFrame": int(b.shape[0]), "bboxCols": int(b.shape[1])}
    raise SystemExit("smoke: no person detected in any sampled frame — use a clip with a visible person")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="samples/people-detection.mp4")
    ap.add_argument("--model", choices=["body", "wholebody"], required=True)
    ap.add_argument("--models-dir", default=None,
                    help="baked .onnx 디렉터리(POSE_MODELS_DIR). 미지정 시 기본(./models). 에어갭이면 baked 경로 지정.")
    ap.add_argument("--fps", type=float, default=5.0)
    ap.add_argument("--max-frames", type=int, default=40)
    ap.add_argument("--warmup", type=int, default=3)
    # (6.0-13) 디바이스: 기본 cpu = 기존 하드코딩과 동일 동작(docker exec 런북 호환 — infer_clip 기본 auto와 다름).
    ap.add_argument("--device", choices=["auto", "cpu", "cuda"], default="cpu",
                    help="auto=CUDA 가능 시 사용·init 실패 시 CPU 폴백 | cpu(기본, 기존 동작) | cuda(강제, 불가 시 에러)")
    # (6.0-13) 벤치 전용 모델 오버라이드 — manifest·운영 로더 무수정으로 상위 후보(tiny+m/l, yolox-s+s) 측정.
    # 크기 인자는 (w,h): OpenMMLab 파일명 "256x192"(H×W) 모델은 --pose-size 192,256.
    ap.add_argument("--det-onnx", default=None, help="detector .onnx 경로 오버라이드(미지정 시 baked)")
    ap.add_argument("--det-size", default=None, help="detector 입력크기 w,h (예 640,640). --det-onnx 지정 시 필수")
    ap.add_argument("--pose-onnx", default=None, help="pose .onnx 경로 오버라이드(미지정 시 baked). body 전용")
    ap.add_argument("--pose-size", default=None, help="pose 입력크기 w,h (예 192,256). --pose-onnx 지정 시 필수")
    args = ap.parse_args()

    override = bool(args.det_onnx or args.pose_onnx)
    if override and args.model != "body":
        raise SystemExit("--det-onnx/--pose-onnx는 --model body 전용(0단계 상위 후보는 body17만 — wholebody 상위 후보는 범위 제외)")
    if (args.det_onnx and not args.det_size) or (args.pose_onnx and not args.pose_size):
        raise SystemExit("오버라이드 .onnx에는 대응 --det-size/--pose-size(w,h)가 필요")

    # build_pose가 참조하는 baked 디렉터리 지정(에어갭 — 자동 다운로드 없이 구운 가중치 사용).
    if args.models_dir:
        os.environ["POSE_MODELS_DIR"] = args.models_dir

    # 1) 샘플 프레임을 먼저 메모리에 디코드(디코드 비용이 추론 타이밍에 안 섞이게).
    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        raise SystemExit(f"cannot open {args.input}")
    orig_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, round(orig_fps / args.fps))
    frames, idx = [], 0
    while len(frames) < args.max_frames + args.warmup:
        ok, fr = cap.read()
        if not ok:
            break
        if idx % step == 0:
            frames.append(fr)
        idx += 1
    cap.release()
    if len(frames) <= args.warmup:
        raise SystemExit(f"not enough frames: {len(frames)}")

    rss0, _ = mem_mb()

    # 2) 모델 로드 — build_pose: baked 우선(에어갭), 없으면 dev 자동 다운로드. nk = 저장 전 추출 키포인트 수.
    nk = 17 if args.model == "body" else 133
    from model_loader import (build_pose, resolve_model_paths, cuda_available,
                              available_providers, cuda_session_active)

    def build(device):
        if not override:
            return build_pose(args.model, device=device, backend="onnxruntime")
        # (6.0-13) 부분 오버라이드: 미지정 쪽은 baked 경로를 그대로 사용(예: tiny+m은 det=baked, pose=오버라이드).
        from rtmlib import Body
        det_path, det_size, pose_path, pose_size, baked_ok = resolve_model_paths(args.models_dir, args.model)
        det = args.det_onnx or (str(det_path) if baked_ok else None)
        pose = args.pose_onnx or (str(pose_path) if baked_ok else None)
        if not det or not pose:
            raise SystemExit("오버라이드 벤치에는 baked 모델 또는 양쪽 .onnx 지정이 필요(부분 오버라이드는 baked 전제)")
        dsize = parse_size(args.det_size) if args.det_size else tuple(det_size or (416, 416))
        psize = parse_size(args.pose_size) if args.pose_size else tuple(pose_size or (192, 256))
        est = Body(det=det, det_input_size=dsize, pose=pose, pose_input_size=psize,
                   backend="onnxruntime", device=device)
        return est, "override"

    # 디바이스 해석(6.0-13) — infer_clip.py의 6.0-12 로직과 동일 의미(cuda=강제·실패 시 에러, auto=CPU 폴백).
    requested_device = args.device
    device_used = "cpu"
    device_fallback = False
    fallback_reason = None
    if requested_device != "cpu":
        try:
            import onnxruntime as _ort
            if hasattr(_ort, "preload_dlls"):
                _ort.preload_dlls()  # pip nvidia-* 휠의 CUDA/cuDNN DLL 로드(Windows PATH 미등록 대비, ORT>=1.21)
        except Exception:
            pass
    t_load = time.time()
    if requested_device == "cpu":
        m, model_source = build("cpu")
    elif requested_device == "cuda":
        if not cuda_available():
            raise SystemExit(f"cuda unavailable: CUDAExecutionProvider not in providers={available_providers()}")
        m, model_source = build("cuda")
        device_used = "cuda"
    else:  # auto
        if cuda_available():
            try:
                m, model_source = build("cuda")
                device_used = "cuda"
            except Exception as e:  # noqa: BLE001 — auto는 벤치를 죽이지 않고 CPU 폴백(사유 기록)
                m, model_source = build("cpu")
                device_fallback = True
                fallback_reason = f"cuda init failed, fell back to cpu: {e}"
        else:
            m, model_source = build("cpu")
            fallback_reason = "no CUDAExecutionProvider available"
    load_s = time.time() - t_load
    rss_loaded, _ = mem_mb()

    def enforce_actual_device(stage):
        """(6.0-13) 세션 **실제** EP 검증. ORT는 두 시점에 무성 폴백한다 — ① 세션 생성 시 EP init 실패
        (경고만 내고 CPU 세션), ② **첫 추론 시** EP 실행 실패(stdout 'Falling back to ...' 후 CPU 세션
        재생성). 따라서 로드 직후와 워밍업 후 두 번 검사해, 요청이 아닌 실측 디바이스를 기록/강제한다."""
        nonlocal device_used, device_fallback, fallback_reason
        ok, sp = cuda_session_active(m)  # strict 판정(두 세션 + 첫 provider=CUDA)은 model_loader 공용
        if device_used == "cuda" and not ok:
            if requested_device == "cuda":
                raise SystemExit(
                    f"cuda silently fell back to CPU at {stage} (sessionProviders={sp}) — "
                    "CUDA/cuDNN 런타임 미충족. ORT 호환표 기준 버전 확인 필요")
            device_used = "cpu"
            device_fallback = True
            fallback_reason = f"cuda fell back to CPU at {stage} (sessionProviders={sp})"
        return sp

    # 2a) 로드 직후 EP 검증(생성 시점 무성 폴백 차단).
    sess_providers = enforce_actual_device("session init")

    # 2b) (6.0-13) 오버라이드 모델은 벤치 전 출력 계약 smoke 필수 — 실패 시 즉시 종료.
    smoke = smoke_check(m, frames, nk) if override else None

    # 3) 워밍업(ONNX runtime 첫 추론은 비정상적으로 느림 — 측정 제외. CUDA init/엔진 준비도 여기서 흡수).
    for fr in frames[:args.warmup]:
        b = m.det_model(fr)
        if len(b) > 0:
            m.pose_model(fr, bboxes=b)

    # 3b) 워밍업 후 EP 재검증(실행 시점 무성 폴백 차단 — cudnn frontend 그래프 빌드 실패 등은 여기서 드러남).
    sess_providers = enforce_actual_device("first inference (warmup)")

    # 4) 측정 루프 — det / pose 분리.
    det_ms, pose_ms, total_ms, npersons = [], [], [], []
    for fr in frames[args.warmup:]:
        t0 = time.perf_counter()
        b = m.det_model(fr)
        t1 = time.perf_counter()
        if len(b) > 0:
            kpts, scores = m.pose_model(fr, bboxes=b)
            _ = np.array(kpts).reshape(-1, nk, 2)
        t2 = time.perf_counter()
        det_ms.append((t1 - t0) * 1000)
        pose_ms.append((t2 - t1) * 1000)
        total_ms.append((t2 - t0) * 1000)
        npersons.append(len(b))

    _, peak = mem_mb()
    out = {
        "model": args.model, "modelSource": model_source, "platform": sys.platform, "keypoints": nk,
        # (6.0-13) 디바이스 메타데이터 — 실측표 신뢰성(providers 목록 + 실제 사용 디바이스 + 폴백 사유).
        "providers": available_providers(),
        "requestedDevice": requested_device, "deviceUsed": device_used,
        "deviceFallback": device_fallback, "fallbackReason": fallback_reason,
        "sessionProviders": sess_providers,
        "detOverride": args.det_onnx, "poseOverride": args.pose_onnx, "smoke": smoke,
        "framesMeasured": len(total_ms), "avgPersonsPerFrame": round(float(np.mean(npersons)), 2),
        "loadSec": round(load_s, 2),
        "rssAfterLoadMB": round(rss_loaded, 0), "rssBeforeLoadMB": round(rss0, 0),
        "peakRssMB": round(peak, 0),
        "detMs": {"mean": round(float(np.mean(det_ms)), 1), "median": pct(det_ms, 50), "p90": pct(det_ms, 90)},
        "poseMs": {"mean": round(float(np.mean(pose_ms)), 1), "median": pct(pose_ms, 50), "p90": pct(pose_ms, 90)},
        "totalMsPerFrame": {"mean": round(float(np.mean(total_ms)), 1), "median": pct(total_ms, 50), "p90": pct(total_ms, 90)},
    }
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
