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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="samples/people-detection.mp4")
    ap.add_argument("--model", choices=["body", "wholebody"], required=True)
    ap.add_argument("--models-dir", default=None,
                    help="baked .onnx 디렉터리(POSE_MODELS_DIR). 미지정 시 기본(./models). 에어갭이면 baked 경로 지정.")
    ap.add_argument("--fps", type=float, default=5.0)
    ap.add_argument("--max-frames", type=int, default=40)
    ap.add_argument("--warmup", type=int, default=3)
    args = ap.parse_args()

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
    t_load = time.time()
    from model_loader import build_pose
    m, model_source = build_pose(args.model, device="cpu", backend="onnxruntime")
    load_s = time.time() - t_load
    rss_loaded, _ = mem_mb()

    # 3) 워밍업(ONNX runtime 첫 추론은 비정상적으로 느림 — 측정 제외).
    for fr in frames[:args.warmup]:
        b = m.det_model(fr)
        if len(b) > 0:
            m.pose_model(fr, bboxes=b)

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
