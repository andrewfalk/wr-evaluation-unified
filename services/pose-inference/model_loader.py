"""
추론 모델 로더 (6.0-9 PR-B). infer_clip·sample_detect 공통.

에어갭(운영): 이미지에 구운 가중치를 `Body(det=<path>, pose=<path>, ...)`로 직접 주입한다.
  - 경로 = POSE_MODELS_DIR(미설정 시 ./models) 아래 manifest.json의 file 이름.
  - 두 .onnx가 모두 존재하면 baked 경로 사용(인터넷 불필요 → docker run --network none 통과).
dev: 가중치 미반입이면 rtmlib mode="lightweight"로 ~/.cache 자동 다운로드(폴백).

재현성(§8.11): recipe에 들어가는 sha는 **실제 baked .onnx 파일의 sha256**이며, manifest 기대값과
일치할 때만 verified로 본다(verified_model_shas). 로컬에 오염·다른 onnx가 있으면 manifest의
'정상 해시'를 그대로 적지 않고 fail-closed(unverified) — provenance 거짓 verified 방지.

경로/manifest 해석은 Body 생성과 분리 — 네트워크 없이 단위테스트 가능.
"""
import hashlib
import json
import os
from pathlib import Path

from rtmlib import Body, Wholebody

HERE = Path(__file__).parent

# variant → pose 모델 role 후보(우선순위). 손목분석(6.0-10)은 hand-wrist 클립만 wholebody on-demand.
#   body      : pose-body 우선, 레거시 "pose"도 허용(하위호환 — 기존 baked 매니페스트/이미지).
#   wholebody : pose-wholebody(rtmw-dw-l-m, 133점 → 저장은 trimmed 59).
_POSE_ROLES = {
    "body": ("pose-body", "pose"),
    "wholebody": ("pose-wholebody",),
}


def default_models_dir():
    return os.environ.get("POSE_MODELS_DIR") or str(HERE / "models")


def _manifest(models_dir=None):
    """manifest.json은 models 디렉터리 옆에 둔다(baked 이미지에서도 함께 복사됨)."""
    mdir = models_dir or default_models_dir()
    try:
        return json.loads((Path(mdir) / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _select_models(models_dir=None, variant="body"):
    """manifest에서 (detector, pose) 모델 dict를 variant 기준으로 선택. role별 첫 항목만 채택."""
    mf = _manifest(models_dir)
    by_role = {}
    for m in (mf or {}).get("models", []):
        by_role.setdefault(m.get("role"), m)  # role별 첫 항목(중복 role 덮어쓰기 방지)
    det = by_role.get("detector")
    pose = next((by_role[r] for r in _POSE_ROLES.get(variant, ()) if r in by_role), None)
    return det, pose


def resolve_model_paths(models_dir=None, variant="body"):
    """(det_path, det_size, pose_path, pose_size, baked_ok) 반환. Body 생성 안 함(테스트 가능).
    baked_ok = manifest의 detector·해당 variant pose .onnx가 models_dir 안에 모두 존재(해시 미검증 — 존재만)."""
    mdir = models_dir or default_models_dir()
    det, pose = _select_models(mdir, variant)
    det_path = Path(mdir) / det["file"] if det and det.get("file") else None
    det_size = det.get("inputSize") if det else None
    pose_path = Path(mdir) / pose["file"] if pose and pose.get("file") else None
    pose_size = pose.get("inputSize") if pose else None
    baked_ok = bool(det_path and pose_path and det_path.exists() and pose_path.exists())
    return det_path, det_size, pose_path, pose_size, baked_ok


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verified_model_shas(models_dir=None, variant="body"):
    """baked .onnx의 **실제 파일 sha256**을 계산해 manifest 기대값과 대조한다(recipe 재현성, 6.0-9).
    variant별 pose 모델(body→pose-body|pose, wholebody→pose-wholebody)을 검증한다.
    반환 (det_sha, pose_sha, verified):
      - baked 두 파일 존재 + 실제 sha == manifest onnxSha256 → (실det, 실pose, True)
      - 미존재 / 해시 불일치(오염·다른 모델) / manifest sha 누락 → (None, None, False) [fail-closed]
    manifest 값을 맹신하지 않고 실제 파일 해시만 신뢰한다."""
    mdir = models_dir or default_models_dir()
    det, pose = _select_models(mdir, variant)
    det_path, _ds, pose_path, _ps, baked_ok = resolve_model_paths(mdir, variant)
    if not baked_ok:
        return None, None, False
    det_exp = (det or {}).get("onnxSha256")
    pose_exp = (pose or {}).get("onnxSha256")
    if not det_exp or not pose_exp:
        return None, None, False  # manifest에 기대 해시가 없으면 verified 불가.
    try:
        det_actual = _sha256_file(det_path)
        pose_actual = _sha256_file(pose_path)
    except OSError:
        return None, None, False
    if det_actual != det_exp or pose_actual != pose_exp:
        return None, None, False  # 오염·다른 모델 — fail-closed(unverified).
    return det_actual, pose_actual, True


def build_pose(variant="body", device="cpu", backend="onnxruntime"):
    """추론용 rtmlib 추정기를 만든다(variant: body=Body/coco17, wholebody=Wholebody/133점).
    baked 가중치 우선, 없으면 자동 다운로드(dev). 반환: (estimator, source) — 'baked' | 'auto'.
    주: 파일 존재만으로 baked 사용(추론 자체는 진행). 해시 검증은 recipe 단계(verified_model_shas)에서.
    알 수 없는 variant는 ValueError로 fail-fast — 오타가 조용히 body로 처리돼 손 keypoint 누락되는 오작동 방지."""
    if variant not in _POSE_ROLES:
        raise ValueError(f"unknown pose variant {variant!r} (expected one of {sorted(_POSE_ROLES)})")
    estimator_cls = Wholebody if variant == "wholebody" else Body
    det_path, det_size, pose_path, pose_size, baked_ok = resolve_model_paths(variant=variant)
    if baked_ok:
        est = estimator_cls(
            det=str(det_path), det_input_size=tuple(det_size or (416, 416)),
            pose=str(pose_path), pose_input_size=tuple(pose_size or (192, 256)),
            backend=backend, device=device,
        )
        return est, "baked"
    # dev 폴백 — 에어갭 아님(인터넷 필요). 운영 이미지에선 baked가 떠야 한다.
    return estimator_cls(mode="lightweight", backend=backend, device=device), "auto"


def build_body(device="cpu", backend="onnxruntime"):
    """하위호환 — body(coco17) 추정기. 신규 코드는 build_pose('body', ...) 사용."""
    return build_pose("body", device=device, backend=backend)
