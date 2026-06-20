"""
6.0-B2 오프라인 검증 오케스트레이터 — 비커밋 검증셋(영상+gold annotation)에서 영상 추출값을 산출해
validation bundle로 묶는다. 비교(MAE·sensitivity)는 Node 하네스(scripts/videoValidateReport.mjs)가
앱과 동일한 변환 경로로 수행한다. 이 스크립트는 추론 산식을 재구현하지 않고 기존 두 CLI만 합성한다.

clip 입력은 case별로 다음 중 정확히 하나:
  - videoPath      : infer_clip.py(keypoints) → feature_calc.py(clip_features)  [실 영상]
  - keypointsPath  : feature_calc.py(clip_features)                              [추론 결과 재사용]
  - clipFeaturesPath: 그대로 사용                                                [fixture 데이터리스 스모크]

사용:
  python validate_set.py --manifest <manifest.json> --output-dir <out> [--overlay] [--config feature_config.json]

출력(bundle, output-dir/validation_bundle.json):
  { version, cases[{ caseId, videoRef, annotationId, activeMinutesPerDay,
                     clips[{ viewpoint, targetTrackId, clipFeatures }] }] }
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
BUNDLE_VERSION = 1
CLIP_INPUT_KEYS = ("videoPath", "keypointsPath", "clipFeaturesPath")
# 시점은 Node 하네스가 그대로 fusion 입력으로 쓴다(시점 선택·confidence 해석에 직접 영향) →
# 누락/오타를 조용히 'other'로 흘리지 않고 early fail(검증 데이터 품질 방어).
VALID_VIEWPOINTS = ("sagittal", "frontal", "other")


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def fail(msg):
    print(f"[validate_set] ERROR: {msg}", file=sys.stderr)
    raise SystemExit(2)


def resolve_input_path(base_dir, raw):
    """manifest 상대경로는 manifest 위치 기준으로 해석(절대경로는 그대로)."""
    p = Path(raw)
    return p if p.is_absolute() else (base_dir / p)


def validate_manifest(manifest):
    if not isinstance(manifest, dict):
        fail("manifest는 객체여야 합니다.")
    if manifest.get("version") != BUNDLE_VERSION:
        fail(f"manifest.version은 {BUNDLE_VERSION}이어야 합니다.")
    cases = manifest.get("cases")
    if not isinstance(cases, list) or not cases:
        fail("manifest.cases는 비어 있지 않은 배열이어야 합니다.")
    for ci, case in enumerate(cases):
        for req in ("caseId", "videoRef", "annotationId"):
            if not case.get(req):
                fail(f"cases[{ci}].{req} 누락")
        clips = case.get("clips")
        if not isinstance(clips, list) or not clips:
            fail(f"cases[{ci}].clips는 비어 있지 않은 배열이어야 합니다.")
        for li, clip in enumerate(clips):
            present = [k for k in CLIP_INPUT_KEYS if clip.get(k)]
            if len(present) != 1:
                fail(f"cases[{ci}].clips[{li}]는 {CLIP_INPUT_KEYS} 중 정확히 하나를 가져야 합니다 (현재: {present}).")
            if clip.get("viewpoint") not in VALID_VIEWPOINTS:
                fail(f"cases[{ci}].clips[{li}].viewpoint는 {VALID_VIEWPOINTS} 중 하나여야 합니다 (현재: {clip.get('viewpoint')!r}).")


def run_cli(script, args):
    """동봉 CLI(infer_clip.py/feature_calc.py)를 같은 파이썬으로 실행."""
    cmd = [sys.executable, str(HERE / script), *args]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        fail(f"{script} 실패(exit {res.returncode}): {res.stderr.strip() or res.stdout.strip()}")


def keypoints_for_clip(clip, base_dir, work_dir, clip_tag, config):
    """videoPath면 추론, keypointsPath면 그대로. clipFeaturesPath면 None(keypoints 없음)."""
    if clip.get("clipFeaturesPath"):
        return None
    if clip.get("keypointsPath"):
        return resolve_input_path(base_dir, clip["keypointsPath"])
    # videoPath → infer_clip.py
    video = resolve_input_path(base_dir, clip["videoPath"])
    if not video.exists():
        fail(f"videoPath 없음: {video}")
    kp_out = work_dir / f"{clip_tag}.keypoints.json"
    infer_args = ["--input", str(video), "--output", str(kp_out), "--fps", str(clip.get("fps", 5))]
    run_cli("infer_clip.py", infer_args)
    return kp_out


def clip_features_for_clip(clip, base_dir, work_dir, clip_tag, config, keypoints_path):
    """clip의 ClipFeatureSet 문서를 얻는다(clipFeaturesPath면 로드, 아니면 feature_calc.py)."""
    if clip.get("clipFeaturesPath"):
        return load_json(resolve_input_path(base_dir, clip["clipFeaturesPath"]))
    cf_out = work_dir / f"{clip_tag}.clip_features.json"
    feat_args = ["--keypoints", str(keypoints_path), "--output", str(cf_out)]
    if config:
        feat_args += ["--config", str(config)]
    if clip.get("targetTrackId"):
        feat_args += ["--target-track", str(clip["targetTrackId"])]
    run_cli("feature_calc.py", feat_args)
    return load_json(cf_out)


def render_overlay(clip, base_dir, work_dir, clip_tag, keypoints_path, overlay_dir):
    """--overlay: 원본 영상 위 COCO17 골격. 원본 영상+keypoints가 있어야 가능."""
    if not clip.get("videoPath") or keypoints_path is None:
        print(f"[validate_set] overlay unavailable ({clip_tag}): 원본 영상+keypoints 필요 → skip")
        return
    video = resolve_input_path(base_dir, clip["videoPath"])
    out = overlay_dir / f"{clip_tag}.overlay.mp4"
    args = ["--video", str(video), "--keypoints", str(keypoints_path), "--output", str(out)]
    if clip.get("targetTrackId"):
        args += ["--target-track", str(clip["targetTrackId"])]
    run_cli("overlay_render.py", args)
    print(f"[validate_set] overlay → {out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True, help="검증셋 입력 manifest(비커밋)")
    ap.add_argument("--output-dir", required=True, help="bundle·중간산출물 출력 디렉터리(비커밋)")
    ap.add_argument("--overlay", action="store_true", help="원본 대조 overlay 렌더(원본 영상 필요)")
    ap.add_argument("--config", default=None, help="feature_config.json 경로(기본: 동봉 config)")
    args = ap.parse_args()

    manifest_path = Path(args.manifest)
    manifest = load_json(manifest_path)
    validate_manifest(manifest)
    base_dir = manifest_path.resolve().parent

    out_dir = Path(args.output_dir)
    work_dir = out_dir / "work"
    work_dir.mkdir(parents=True, exist_ok=True)
    overlay_dir = out_dir / "overlay"
    if args.overlay:
        overlay_dir.mkdir(parents=True, exist_ok=True)

    bundle_cases = []
    for case in manifest["cases"]:
        bundle_clips = []
        for li, clip in enumerate(case["clips"]):
            clip_tag = f"{case['caseId']}-{li}"
            keypoints_path = keypoints_for_clip(clip, base_dir, work_dir, clip_tag, args.config)
            clip_features = clip_features_for_clip(clip, base_dir, work_dir, clip_tag, args.config, keypoints_path)
            if args.overlay:
                render_overlay(clip, base_dir, work_dir, clip_tag, keypoints_path, overlay_dir)
            bundle_clips.append({
                "viewpoint": clip.get("viewpoint"),
                "targetTrackId": clip.get("targetTrackId"),
                "clipFeatures": clip_features,
            })
        bundle_cases.append({
            "caseId": case["caseId"],
            "videoRef": case["videoRef"],
            "annotationId": case["annotationId"],
            "activeMinutesPerDay": case.get("activeMinutesPerDay"),
            "activeModules": case.get("activeModules", []),
            "clips": bundle_clips,
        })

    bundle = {"version": BUNDLE_VERSION, "cases": bundle_cases}
    bundle_path = out_dir / "validation_bundle.json"
    bundle_path.write_text(json.dumps(bundle, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[validate_set] bundle → {bundle_path} ({len(bundle_cases)} cases)")


if __name__ == "__main__":
    main()
