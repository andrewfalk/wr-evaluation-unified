"""
keypoints.json ↔ canonical JSON Schema 검증 (6.0-5).
Python 추론 산출물이 계약(schema/keypoints.schema.json)과 어긋나지 않는지 확인 — drift 방지.

사용: python validate_keypoints.py --input out/keypoints.json
종료코드 0=VALID, 1=INVALID.
"""
import argparse
import json
import sys
from pathlib import Path

from jsonschema import Draft7Validator

HERE = Path(__file__).parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--schema", default=str(HERE / "schema" / "keypoints.schema.json"))
    args = ap.parse_args()

    schema = json.loads(Path(args.schema).read_text(encoding="utf-8"))
    doc = json.loads(Path(args.input).read_text(encoding="utf-8"))
    errors = sorted(Draft7Validator(schema).iter_errors(doc), key=lambda e: e.path)
    if errors:
        for e in errors[:10]:
            loc = "/".join(str(p) for p in e.path)
            print(f"INVALID at /{loc}: {e.message}")
        sys.exit(1)

    # convention별 keypoint 개수 추가 검증(JSON Schema로는 cross-field 어려움).
    expected = {"coco17": 17, "wholebody133": 133}.get(doc.get("keypointConvention"))
    if expected:
        for f in doc.get("frames", []):
            for p in f.get("persons", []):
                if len(p.get("keypoints", [])) != expected:
                    print(f"INVALID: frame {f.get('frameIndex')} person has {len(p['keypoints'])} keypoints, expected {expected}")
                    sys.exit(1)

    # clip_features cross-field 검증(Draft7로 어려운 부분): tracking presenceRatio 0..1, posture_ratio 0..1, segment 순서.
    if "featureConfigVersion" in doc and isinstance(doc.get("features"), dict):
        trk = doc.get("tracking")
        if isinstance(trk, dict):
            pr = trk.get("presenceRatio")
            if not (isinstance(pr, (int, float)) and 0.0 <= pr <= 1.0):
                print(f"INVALID: tracking.presenceRatio {pr} out of 0..1")
                sys.exit(1)
        for key, fv in doc["features"].items():
            if fv.get("metric") == "posture_ratio":
                v = fv.get("value")
                if not (isinstance(v, (int, float)) and 0.0 <= v <= 1.0):
                    print(f"INVALID: {key} posture_ratio {v} out of 0..1")
                    sys.exit(1)
            for seg in fv.get("segments", []):
                if seg.get("endMs", 0) < seg.get("startMs", 0):
                    print(f"INVALID: {key} segment endMs < startMs ({seg})")
                    sys.exit(1)

    print(f"VALID: {args.input}")


if __name__ == "__main__":
    main()
