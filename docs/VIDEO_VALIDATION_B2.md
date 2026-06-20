# 6.0-B2 영상 분석 파일럿 검증 절차

> 살아있는 절차 문서. PR 경계·코드 그라운딩의 source of truth는
> [`VIDEO_ANALYSIS_IMPLEMENTATION_PLAN.md`](./VIDEO_ANALYSIS_IMPLEMENTATION_PLAN.md)의 M3 / PR M3-B2 섹션.
> 본 문서는 그 B2 항목의 **실행 절차**다.

## 왜 필요한가

영상 분석은 "돈다"만으로 산재 판단에 쓸 수 없다. **얼마나 틀리는지**(§8.9)를 수기 annotation 대비
측정해, 변수별 허용오차와 자동제안 신뢰도 임계값을 **근거로** 정해야 한다. 검증 통과 전까지 운영 플래그
(`videoAnalysisEnabled`)와 confidence 게이팅은 보수적으로 off로 둔다.

## 코드 골조(이미 구현됨 — 데이터 없이 동작)

| 구성 | 위치 | 역할 |
|------|------|------|
| 오차 계산기 | `src/core/services/videoValidation.js` | MAE·errorRate·sensitivity/specificity·허용오차 판정(순수함수, M2 완성) |
| gold 계약 | `shared/contracts/videoAnnotation.ts` | `AnnotationSetSchema`(층화·segments) |
| 오케스트레이터 | `services/pose-inference/validate_set.py` | manifest → 추론/재사용 → validation bundle |
| 원본 대조 overlay | `services/pose-inference/overlay_render.py` | 원본 프레임 위 COCO17(육안 검수) |
| 비교 하네스 | `scripts/videoValidateReport.mjs` | 앱과 동일 변환(fuse→convert) → 비교 → §8.9 리포트 |
| 잠정 임계값 | `videoConfidenceConfig.js`(`CANDIDATE_CONFIDENCE_THRESHOLDS`) / `videoValidationThresholds.js` | 측정 후 채울 자리(런타임 비활성) |
| 입력 템플릿 | `services/pose-inference/{manifest,annotations}.template.json` | 비커밋 검증셋 작성용 |

**임계값 추측 금지(§8.9):** `CANDIDATE_CONFIDENCE_THRESHOLDS`·`CANDIDATE_RISK_DECISION_THRESHOLDS`는
측정 전까지 비워 둔다. `DEFAULT_CONFIDENCE_THRESHOLDS`에는 절대 넣지 않는다(즉시 게이팅 ON).

## 절차 (데이터 확보 후 순서대로)

### 1. 영상 수집
- 실제/샘플 작업영상 **20~50개**. §8.9 **층화**가 실제 촬영 조건을 반영하도록:
  시점(sagittal/frontal), 가림(none/partial/heavy), 다인원, 복장(light/heavy/ppe), 카메라 높이, 작업유형.
- **동의·비식별**: `videoRef`는 비식별 참조만. 파일경로·PHI 금지(§8.13). 실 영상·라벨은 **커밋 금지**
  (`.gitignore`의 `.video-validation/`).

### 2. manifest 작성
- `services/pose-inference/manifest.template.json`을 복사 → 비커밋 경로(예: `.video-validation/manifest.json`).
- case별 `caseId`·`videoRef`·`annotationId`·`activeMinutesPerDay`·`activeModules`·`clips[]` 기입.
- clip 입력은 `videoPath`/`keypointsPath`/`clipFeaturesPath` 중 **정확히 하나**.
- **시간·분/일 단위 gold를 검증하려는 case는 `activeMinutesPerDay` 필수** — null이면 시간형 feature는
  `missingActiveTime`/`no_active_time`으로 비교에서 빠진다.

### 3. gold annotation 작성
- **전문의용 상세 가이드(프로젝트 모르는 분께 배포용)**: [`VIDEO_VALIDATION_B2_ANNOTATION_GUIDE.md`](./VIDEO_VALIDATION_B2_ANNOTATION_GUIDE.md)
  — Kinovea 설치·측정법(각도 정의 = 시스템 산식 일치)·엑셀 기입까지 step-by-step.
  엑셀 템플릿: [`templates/gold_annotation_template.csv`](./templates/gold_annotation_template.csv).
- 전문의는 엑셀(클립 단위 raw: 각도°·누적초·횟수)만 채우고, **IT가 → `annotations.json`(`AnnotationSetSchema`) 변환**
  (누적초/클립길이×activeMinutesPerDay = 분/일 등). 단위는 `VIDEO_FEATURE_TARGETS`와 일치.
- `segments`로 "어느 구간"까지 기록(duration/반복 오차의 시간대 추적, 선택).

### 4. inter-rater 점검
- 같은 영상 일부를 복수 평가자가 독립 annotation → gold 자체의 평가자 간 변동 확인.
- 변동이 크면 그 변수는 임계값 신뢰 근거가 약함(측정 오차와 분리해 기록).

### 5. 정확도 측정
```bash
# (a0) 전문의 엑셀(CSV) → annotations.json + manifest 스켈레톤(퍼-데이 환산 자동). 가이드 §8 참고.
npm run video:annotations-from-csv -- --csv .video-validation/gold.csv \
  --out-annotations .video-validation/annotations.json \
  --out-manifest .video-validation/manifest.skeleton.json
# → manifest.skeleton.json에 실제 videoPath·targetTrackId 채워 manifest.json으로 저장.

# (a) 추출값 bundle 생성 — Python venv(Tier-3) 필요. --overlay는 원본 대조 육안.
python services/pose-inference/validate_set.py \
  --manifest .video-validation/manifest.json \
  --output-dir .video-validation/out [--overlay]

# (b) 앱과 동일 변환으로 비교 → §8.9 리포트. (prevideo:validate-report가 shared/dist 선빌드)
npm run video:validate-report -- \
  --bundle .video-validation/out/validation_bundle.json \
  --annotations .video-validation/annotations.json \
  --out .video-validation/out/report.json
```
- 리포트: 변수별 MAE(각도)/오차율(시간·반복) + 허용오차 PASS/FAIL, 위험역치 sensitivity/specificity,
  비교 제외 사유(not_comparable_candidate·no_active_time·type_mismatch 등).

### 6. 임계값 결정
- §8.9 허용오차(각도 ±10~15°, 시간 ±20%, 반복 ±15~20%) + inter-rater 기준을 **충족하는 변수만**:
  - `CANDIDATE_CONFIDENCE_THRESHOLDS`(videoConfidenceConfig.js)에 잠정 confidence 임계값 기입 + 결정 근거.
  - 위험역치 sensitivity/specificity가 필요하면 `CANDIDATE_RISK_DECISION_THRESHOLDS`에 컷오프 기입.
- 미충족 변수는 **자동제안 금지 유지**(후보/수기 확인).

### 7. 게이팅 활성 (별도 PR — B2 범위 밖)
- 검증 통과 변수에 한해 `DEFAULT_CONFIDENCE_THRESHOLDS` 배선 + 6.0-8에서 분리해둔
  `confidenceGatingEnabledByFeature`·운영 플래그(`videoAnalysisEnabled`) on.
- **데이터·측정 의존**이므로 이번 골조 PR과 분리한다.

## 데이터 없이 가능한 스모크(코드 검증)
- bundle 생성(fixture): `validate_set.py`에 `clipFeaturesPath: fixtures/clip_features.sample.json`을 가리키는
  manifest → 추론 없이 bundle 생성.
- 비교 하네스: 합성 bundle + 합성 annotation → fuse→convert·normalization·비교 동작 확인(단위테스트).
- overlay 렌더러: 임시 synthetic mp4 + 합성 keypoints(커밋 영상 없음·privacy).
