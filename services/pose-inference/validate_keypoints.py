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

    print(f"VALID: {args.input}")


if __name__ == "__main__":
    main()
