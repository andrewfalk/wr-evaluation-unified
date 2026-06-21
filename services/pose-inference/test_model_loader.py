"""model_loader.verified_model_shas 단위 테스트 (6.0-9 PR-B).

실제 baked .onnx 파일 sha256을 manifest 기대값과 대조해 일치할 때만 verified, 오염/누락이면
fail-closed(unverified)임을 검증한다 — recipe 거짓 verified 차단(§8.11).
의존성: rtmlib import만(네트워크 불필요 — Body 생성 안 함). 실행: .venv/Scripts/python test_model_loader.py
"""
import hashlib
import json
import tempfile
from pathlib import Path

import model_loader


def sha(data):
    return hashlib.sha256(data).hexdigest()


def make_models_dir(tmp, det_bytes, pose_bytes, det_sha, pose_sha):
    d = Path(tmp)
    (d / "det.onnx").write_bytes(det_bytes)
    (d / "pose.onnx").write_bytes(pose_bytes)
    manifest = {
        "weightsComplete": True,
        "models": [
            {"role": "detector", "file": "det.onnx", "onnxSha256": det_sha, "inputSize": [416, 416]},
            {"role": "pose", "file": "pose.onnx", "onnxSha256": pose_sha, "inputSize": [192, 256]},
        ],
    }
    (d / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return str(d)


def run():
    det_b, pose_b = b"DETECTOR-MODEL-BYTES", b"POSE-MODEL-BYTES"

    # 1) 실파일 sha == manifest → verified + 실제 해시 반환
    with tempfile.TemporaryDirectory() as t:
        mdir = make_models_dir(t, det_b, pose_b, sha(det_b), sha(pose_b))
        d, p, v = model_loader.verified_model_shas(mdir)
        assert v is True and d == sha(det_b) and p == sha(pose_b), (d, p, v)
        print("ok: 실파일 sha == manifest → verified")

    # 2) 해시 불일치(오염·다른 모델) → fail-closed unverified
    with tempfile.TemporaryDirectory() as t:
        mdir = make_models_dir(t, det_b, pose_b, sha(b"WRONG-EXPECTED"), sha(pose_b))
        d, p, v = model_loader.verified_model_shas(mdir)
        assert v is False and d is None and p is None, (d, p, v)
        print("ok: 해시 불일치(오염) → fail-closed unverified")

    # 3) baked 파일 없음 → unverified
    with tempfile.TemporaryDirectory() as t:
        d2 = Path(t)
        d2.joinpath("manifest.json").write_text(json.dumps({
            "weightsComplete": True,
            "models": [
                {"role": "detector", "file": "missing.onnx", "onnxSha256": "x", "inputSize": [416, 416]},
                {"role": "pose", "file": "missing2.onnx", "onnxSha256": "y", "inputSize": [192, 256]},
            ],
        }), encoding="utf-8")
        d, p, v = model_loader.verified_model_shas(str(d2))
        assert v is False, (d, p, v)
        print("ok: baked 파일 없음 → unverified")

    # 4) manifest에 기대 sha 누락 → unverified(맹신 금지)
    with tempfile.TemporaryDirectory() as t:
        mdir = make_models_dir(t, det_b, pose_b, None, None)
        d, p, v = model_loader.verified_model_shas(mdir)
        assert v is False, (d, p, v)
        print("ok: manifest 기대 sha 누락 → unverified")

    print("ALL PASS")


if __name__ == "__main__":
    run()
