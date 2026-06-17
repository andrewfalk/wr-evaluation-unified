"""
대표 프레임 사람 box 후보 탐지 (6.0-6b, PR D2b, §8.7). 본 분석 전 대상자 선택용.

infer_clip과 **동일 detector**(rtmlib Body.det_model)로 클립 중앙(대표) 프레임 1장에서 person bbox만 뽑는다
(pose 추정 없음 → 빠름). 사용자는 이 후보들을 박스만 중립 캔버스에서 클릭해 대상자를 고른다.
원본 프레임 이미지는 반환/저장하지 않는다(privacy_first) — bbox 좌표만.

출력(SampleDetectResultSchema 정합): { schemaVersion, frameIndex, timestampMs, frameWidth, frameHeight,
  persons:[{ id:"p1", bbox:[x,y,w,h], score }] }  (bbox = xywh 픽셀, keypoints/워커 IoU와 동일 좌표계)
후보 id는 (score desc, x asc, y asc) 정렬 후 p1,p2,... → raw detector 순서 비의존(재현·UI 테스트 안정).

사용: python sample_detect.py --input clip.mp4 --output cand.json [--at-ms N]
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from rtmlib import Body


def xyxy_to_xywh(b):
    # detector가 프레임 밖(음수) 좌표를 낼 수 있으므로 0 하한 clamp → schema는 nonnegative로 받는다(신뢰 경계 정합).
    x1, y1, x2, y2 = [float(v) for v in b[:4]]
    x1 = max(0.0, x1)
    y1 = max(0.0, y1)
    w = max(0.0, x2 - x1)
    h = max(0.0, y2 - y1)
    return [round(x1, 2), round(y1, 2), round(w, 2), round(h, 2)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--at-ms", type=float, default=None, help="대표 프레임 시각(ms). 미지정 시 클립 중앙.")
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        raise SystemExit(f"cannot open video: {args.input}")
    orig_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    def read_at(idx):
        idx = max(0, min(idx, total - 1) if total > 0 else 0)
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, fr = cap.read()
        return (idx, fr) if ok else (idx, None)

    body = Body(mode="lightweight", backend="onnxruntime", device="cpu")

    if args.at_ms is not None:
        # 명시 시각: 그 프레임 그대로 사용.
        target_idx, frame = read_at(int(round(args.at_ms / 1000.0 * orig_fps)))
        if frame is None:
            target_idx, frame = read_at(0)
        if frame is None:
            raise SystemExit("cannot read representative frame")
        bboxes = body.det_model(frame)
    else:
        # 탐지가 간헐적이므로 균등 분포 프레임을 스캔해 **사람이 가장 많은** 대표 프레임을 고른다(동률→중앙 근접).
        mid = total / 2 if total > 0 else 0
        candidates = sorted({max(0, int(total * k / 10)) for k in range(1, 10)}) if total > 0 else [0]
        best = None  # (count, -abs(idx-mid), idx, bboxes)
        for idx in candidates:
            _, fr = read_at(idx)
            if fr is None:
                continue
            b = body.det_model(fr)
            key = (len(b), -abs(idx - mid))
            if best is None or key > best[0]:
                best = (key, idx, b)
        if best is None:
            target_idx, frame = read_at(0)
            bboxes = body.det_model(frame) if frame is not None else []
        else:
            target_idx, bboxes = best[1], best[2]
    cap.release()
    dets = []
    for b in bboxes:
        xywh = xyxy_to_xywh(b)
        # detector 점수 컬럼이 있으면 사용, 없으면 1.0(면적 정렬은 별도).
        score = round(float(b[4]), 4) if len(b) > 4 else 1.0
        dets.append({"bbox": xywh, "score": score})

    # 결정적 정렬: score desc, x asc, y asc → p1,p2,...
    dets.sort(key=lambda d: (-d["score"], d["bbox"][0], d["bbox"][1]))
    persons = [{"id": f"p{i + 1}", "bbox": d["bbox"], "score": d["score"]} for i, d in enumerate(dets)]

    doc = {
        "schemaVersion": 1,
        "frameIndex": target_idx,
        "timestampMs": round(target_idx / orig_fps * 1000),
        "frameWidth": width,
        "frameHeight": height,
        "persons": persons,
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"wrote {out} | frame {target_idx} | {len(persons)} person candidates")


if __name__ == "__main__":
    main()
