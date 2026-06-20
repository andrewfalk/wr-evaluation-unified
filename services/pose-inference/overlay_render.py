"""
6.0-B2 원본 대조 overlay 렌더러 — 원본 영상 프레임 위에 COCO17 골격을 그린다(육안 검수용).

기존 자산과 구분:
  - SkeletonOverlay.jsx = 중립 배경(원본 프레임 없음) 골격 → "값이 맞나"의 절대좌표 검수.
  - 본 렌더러 = 원본 프레임 위 골격 → "추정이 실제 사람과 겹치나"의 대조 검수.
표시 규칙은 SkeletonOverlay.jsx를 미러: target track은 강조(밝게), 그 외 인물은 흐리게.

사용:
  python overlay_render.py --video <clip.mp4> --keypoints <keypoints.json> --output <out.mp4>
                           [--target-track t1] [--max-frames N]

원본 영상 + keypoints가 둘 다 있어야 한다(clip_features만으론 불가 → validate_set이 skip).
"""
import argparse
import sys
from pathlib import Path

import cv2

# COCO17 골격 엣지(몸통/사지). 얼굴(코-눈-귀)은 검수 노이즈라 생략.
COCO17_EDGES = [
    (5, 7), (7, 9), (6, 8), (8, 10),       # 팔
    (5, 6), (5, 11), (6, 12), (11, 12),    # 어깨/골반 사각형
    (11, 13), (13, 15), (12, 14), (14, 16),  # 다리
    (0, 5), (0, 6),                        # 코→어깨(머리 방향)
]
TARGET_COLOR = (80, 230, 80)    # 강조(밝은 초록, BGR)
OTHER_COLOR = (140, 140, 140)   # 흐리게(회색)
MIN_KP_CONF = 0.3               # 이 미만 관절은 그리지 않음(저신뢰 점 노이즈 제거)


def load_keypoints(path):
    import json
    return json.loads(Path(path).read_text(encoding="utf-8"))


def draw_person(frame, person, color, thickness):
    kps = person.get("keypoints", [])
    for (a, b) in COCO17_EDGES:
        if a < len(kps) and b < len(kps):
            xa, ya, ca = kps[a]
            xb, yb, cb = kps[b]
            if ca >= MIN_KP_CONF and cb >= MIN_KP_CONF:
                cv2.line(frame, (int(xa), int(ya)), (int(xb), int(yb)), color, thickness, cv2.LINE_AA)
    for kp in kps:
        x, y, c = kp
        if c >= MIN_KP_CONF:
            cv2.circle(frame, (int(x), int(y)), max(2, thickness), color, -1, cv2.LINE_AA)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--keypoints", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--target-track", default=None)
    ap.add_argument("--max-frames", type=int, default=0, help="0 = all sampled frames")
    args = ap.parse_args()

    kdoc = load_keypoints(args.keypoints)
    frames = kdoc.get("frames", [])
    if not frames:
        print("[overlay_render] keypoints에 frames 없음 → skip", file=sys.stderr)
        return

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"[overlay_render] 원본 영상 열기 실패: {args.video}", file=sys.stderr)
        raise SystemExit(2)

    w = kdoc.get("frameWidth") or int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = kdoc.get("frameHeight") or int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    out_fps = kdoc.get("sampledFps") or 5
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(args.output, cv2.VideoWriter_fourcc(*"mp4v"), out_fps, (w, h))

    written = 0
    for fr in frames:
        if args.max_frames and written >= args.max_frames:
            break
        cap.set(cv2.CAP_PROP_POS_FRAMES, fr.get("frameIndex", 0))
        ok, img = cap.read()
        if not ok or img is None:
            continue
        if (img.shape[1], img.shape[0]) != (w, h):
            img = cv2.resize(img, (w, h))
        for person in fr.get("persons", []):
            is_target = args.target_track is not None and person.get("trackId") == args.target_track
            draw_person(img, person, TARGET_COLOR if is_target else OTHER_COLOR, 3 if is_target else 1)
        # 프레임 메타(시각) 라벨 — 검수 시 어느 시점인지.
        cv2.putText(img, f"t={fr.get('timestampMs', 0)}ms", (8, 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 1, cv2.LINE_AA)
        writer.write(img)
        written += 1

    writer.release()
    cap.release()
    print(f"[overlay_render] {written} frames → {args.output}")


if __name__ == "__main__":
    main()
