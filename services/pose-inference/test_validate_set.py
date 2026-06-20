"""
validate_set.py 스모크 — 커밋된 fixture(clip_features.sample.json)를 clipFeaturesPath로 가리키는
manifest로 추론 없이 bundle을 만든다(데이터/영상 불필요). manifest 검증 에러 경로도 확인.
실행: .venv/Scripts/python test_validate_set.py   (ALL PASS + 종료코드 0)
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent


def run_validate_set(manifest_path, out_dir):
    cmd = [sys.executable, str(HERE / "validate_set.py"),
           "--manifest", str(manifest_path), "--output-dir", str(out_dir)]
    return subprocess.run(cmd, capture_output=True, text=True)


def write_manifest(d, manifest):
    p = Path(d) / "manifest.json"
    p.write_text(json.dumps(manifest), encoding="utf-8")
    return p


def test_precomputed_bundle():
    manifest = {
        "version": 1,
        "cases": [{
            "caseId": "case-smoke",
            "videoRef": "b2-smoke",
            "annotationId": "ann-smoke",
            "activeMinutesPerDay": None,
            "activeModules": ["spine"],
            # 상대경로는 manifest 위치 기준 — manifest를 fixtures 부모(=HERE)에 두고 fixtures/ 가리킴.
            "clips": [{"clipFeaturesPath": "fixtures/clip_features.sample.json",
                       "viewpoint": "sagittal", "targetTrackId": "t1"}],
        }],
    }
    with tempfile.TemporaryDirectory() as out:
        manifest_path = write_manifest(HERE, manifest)  # HERE 기준 상대경로 해석
        try:
            res = run_validate_set(manifest_path, out)
        finally:
            manifest_path.unlink(missing_ok=True)
        assert res.returncode == 0, f"exit {res.returncode}: {res.stderr}"
        bundle = json.loads((Path(out) / "validation_bundle.json").read_text(encoding="utf-8"))
        assert bundle["version"] == 1
        assert len(bundle["cases"]) == 1
        c = bundle["cases"][0]
        assert c["caseId"] == "case-smoke" and c["videoRef"] == "b2-smoke"
        assert c["annotationId"] == "ann-smoke" and c["activeMinutesPerDay"] is None
        clip = c["clips"][0]
        assert clip["viewpoint"] == "sagittal" and clip["targetTrackId"] == "t1"
        # clip_features 원문이 그대로 실려야 한다(앱 변환은 Node 하네스 몫).
        assert "features" in clip["clipFeatures"]
        assert "trunkPostureG" in clip["clipFeatures"]["features"]
    print("ok: precomputed clipFeaturesPath → bundle")


def test_rejects_multiple_inputs():
    manifest = {
        "version": 1,
        "cases": [{
            "caseId": "c", "videoRef": "v", "annotationId": "a",
            "clips": [{"videoPath": "x.mp4", "clipFeaturesPath": "fixtures/clip_features.sample.json",
                       "viewpoint": "sagittal"}],
        }],
    }
    with tempfile.TemporaryDirectory() as out:
        manifest_path = write_manifest(out, manifest)
        res = run_validate_set(manifest_path, out)
        assert res.returncode == 2, f"expected exit 2, got {res.returncode}"
        assert "정확히 하나" in res.stderr, res.stderr
    print("ok: clip 입력 2개 → 거부(정확히 하나)")


def test_rejects_missing_viewpoint():
    manifest = {
        "version": 1,
        "cases": [{
            "caseId": "c", "videoRef": "v", "annotationId": "a",
            # viewpoint 누락 → early fail(조용히 other로 흘리지 않음).
            "clips": [{"clipFeaturesPath": "fixtures/clip_features.sample.json"}],
        }],
    }
    with tempfile.TemporaryDirectory() as out:
        manifest_path = write_manifest(HERE, manifest)
        try:
            res = run_validate_set(manifest_path, out)
        finally:
            manifest_path.unlink(missing_ok=True)
        assert res.returncode == 2, f"expected exit 2, got {res.returncode}"
        assert "viewpoint" in res.stderr, res.stderr
    print("ok: viewpoint 누락/오타 → 거부")


def test_rejects_bad_version():
    manifest = {"version": 99, "cases": []}
    with tempfile.TemporaryDirectory() as out:
        manifest_path = write_manifest(out, manifest)
        res = run_validate_set(manifest_path, out)
        assert res.returncode == 2, f"expected exit 2, got {res.returncode}"
    print("ok: 잘못된 version → 거부")


if __name__ == "__main__":
    test_precomputed_bundle()
    test_rejects_multiple_inputs()
    test_rejects_missing_viewpoint()
    test_rejects_bad_version()
    print("ALL PASS")
