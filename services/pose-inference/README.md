# pose-inference (6.0-5 PoC)

단일 클립 RTMPose(ONNX/CPU) 포즈 추정 PoC. 클립 → `keypoints.json`(관절 좌표 시계열)을
오프라인으로 산출한다. **앱/서버와 결선 없음** — 독립 검증용. 실제 추론 위치/큐 결선은 M2 PR D.

> 추론 스택 격리: 의존성(onnxruntime/opencv/rtmlib)은 이 디렉터리 venv 안에만 둔다.
> privacy guard(§8.13): 실제 작업조사 영상·산출 keypoints·모델 가중치는 **커밋 금지**(.gitignore).
> fixtures/ 에는 **synthetic/공개 샘플만**.

## 설치 (호스트 Python 3.10+)
```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # Windows
# (모델 가중치는 rtmlib가 최초 실행 시 ~/.cache/rtmlib 로 자동 다운로드)
```

## 실행
```bash
# 1) 클립 1개 → keypoints.json (profile별 fps 샘플링)
.venv/Scripts/python infer_clip.py --input samples/clip.mp4 --output out/keypoints.json --fps 5
.venv/Scripts/python validate_keypoints.py --input out/keypoints.json   # 계약 검증

# 2) keypoints.json → intrinsic clipFeatures (6.0-6a, 자세시간 비율·각도)
.venv/Scripts/python feature_calc.py --keypoints out/keypoints.json --output out/clip_features.json
.venv/Scripts/python validate_keypoints.py --input out/clip_features.json --schema schema/clip_features.schema.json

# 계산 로직 골든 테스트(합성 keypoints, 의존성 불필요)
.venv/Scripts/python test_feature_calc.py
```

## feature 계산 (6.0-6a)
- `feature_calc.py`: keypoints → **intrinsic clipFeatures**(클립 시간 중 자세 비율·각도). 규칙은
  `feature_config.json`(버전관리: 각도 정의·임계값·OneEuro·품질). PoC 범위 = 자세시간/각도
  (squatDuration 무릎각<90°, overheadHours 손목>어깨 OR 상완거상≥90°, neckFlexion>20°, trunkPostureG peak각 candidate).
- **per-day 환산 아님**: `hours_per_day`/`cyclesPerDay`는 공정 활동시간(수기)과 결합하는 별도 단계(PR D1).
- 계약: `schema/clip_features.schema.json`(canonical) + `shared/contracts/clipFeatures.ts`(zod).
- 반복(cyclesPerMinute/cycleSeconds)은 별도 알고리즘 → 후속.

## 계약 (drift 방지)
- **canonical**: `schema/keypoints.schema.json` (JSON Schema)
- **Node 미러**: `shared/contracts/poseKeypoints.ts` (zod) — `PoseKeypointsSchema`
- Node 테스트(`shared/contracts/__tests__/poseKeypoints.test.ts`)가 synthetic fixture를 zod로 검증(CI).
- Python `validate_keypoints.py`가 산출물을 JSON Schema로 검증(아래 CI 정책).

## 모델
`models/manifest.json` 참조(detector=YOLOX-tiny, pose=RTMPose-s, COCO17). PRD의 RTMDet은 교체 가능
어댑터로 후속 교체(§8.14). 가중치 sha256은 에어갭 반입(6.0-9) 시 확정.

## CI 정책
- **상시(CI)**: 계약/스키마 검증(Node zod 테스트). 가중치·런타임 불필요.
- **opt-in(수동)**: 실제 ONNX 추론 smoke — `RUN_POSE_INFERENCE_TESTS=1` 일 때만(가중치 다운로드 필요).

## PoC 성능 메모 (dev, CPU)
- 768×432 people-detection.mp4, 2fps 샘플 30프레임: ~31ms/frame (YOLOX-tiny + RTMPose-s, onnxruntime CPU).
- 실측 목표(1분 클립 처리시간·동시 1건 큐·취소/만료/재시도)는 PR D에서 서버 워커로 확정.
