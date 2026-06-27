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

    # 5) 레거시 role "pose"는 variant="body"로 인식(하위호환) — 위 1)이 이미 role="pose"로 verified.
    print("ok: 레거시 role 'pose' → body alias (case 1~4)")

    # 6) pose-body / pose-wholebody 분리 manifest → variant별 올바른 pose 검증
    wb_b = b"WHOLEBODY-POSE-BYTES"
    with tempfile.TemporaryDirectory() as t:
        d = Path(t)
        (d / "det.onnx").write_bytes(det_b)
        (d / "pose_body.onnx").write_bytes(pose_b)
        (d / "pose_wb.onnx").write_bytes(wb_b)
        (d / "manifest.json").write_text(json.dumps({
            "weightsComplete": True,
            "models": [
                {"role": "detector", "file": "det.onnx", "onnxSha256": sha(det_b), "inputSize": [416, 416]},
                {"role": "pose-body", "file": "pose_body.onnx", "onnxSha256": sha(pose_b), "inputSize": [192, 256]},
                {"role": "pose-wholebody", "file": "pose_wb.onnx", "onnxSha256": sha(wb_b), "inputSize": [192, 256]},
            ],
        }), encoding="utf-8")
        db, pb, vb = model_loader.verified_model_shas(str(d), variant="body")
        assert vb is True and pb == sha(pose_b), (db, pb, vb)
        dw, pw, vw = model_loader.verified_model_shas(str(d), variant="wholebody")
        assert vw is True and pw == sha(wb_b), (dw, pw, vw)
        # resolve_model_paths도 variant별로 다른 pose 파일을 가리킨다.
        _, _, body_pose, _, _ = model_loader.resolve_model_paths(str(d), variant="body")
        _, _, wb_pose, _, _ = model_loader.resolve_model_paths(str(d), variant="wholebody")
        assert body_pose.name == "pose_body.onnx" and wb_pose.name == "pose_wb.onnx"
        print("ok: pose-body/pose-wholebody role-keyed variant 검증")

    # 7) pose-wholebody 파일 미반입 → wholebody는 unverified, body는 그대로 verified
    with tempfile.TemporaryDirectory() as t:
        d = Path(t)
        (d / "det.onnx").write_bytes(det_b)
        (d / "pose_body.onnx").write_bytes(pose_b)
        (d / "manifest.json").write_text(json.dumps({
            "weightsComplete": True,
            "models": [
                {"role": "detector", "file": "det.onnx", "onnxSha256": sha(det_b), "inputSize": [416, 416]},
                {"role": "pose-body", "file": "pose_body.onnx", "onnxSha256": sha(pose_b), "inputSize": [192, 256]},
                {"role": "pose-wholebody", "file": None, "onnxSha256": None, "inputSize": [192, 256]},
            ],
        }), encoding="utf-8")
        _, _, vb = model_loader.verified_model_shas(str(d), variant="body")
        _, _, vw = model_loader.verified_model_shas(str(d), variant="wholebody")
        assert vb is True and vw is False, (vb, vw)
        print("ok: wholebody 미반입 → wholebody unverified, body는 verified")

    # 8) 알 수 없는 variant → build_pose fail-fast(ValueError) — 오타가 조용히 body로 처리되지 않음
    try:
        model_loader.build_pose(variant="wholeBody")  # 오타
        assert False, "expected ValueError for unknown variant"
    except ValueError:
        print("ok: 알 수 없는 variant → ValueError fail-fast")

    print("ALL PASS")


if __name__ == "__main__":
    run()
