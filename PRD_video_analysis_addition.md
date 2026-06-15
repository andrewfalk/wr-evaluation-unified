## 8. 작업 영상 인간공학 분석 (RTMPose) — v6.0.0 (계획)

> **상태:** 설계 단계(검토 3회 반영본, 코드 착수 전 최종 초안). 본 섹션은 기존 평가 엔진에 **작업 영상 기반 인간공학 변수 자동 추출·제안**을 연결하는 구조를 정의한다.
> **범위 한정 (가장 중요):** 본 기능은 v6.0.0에서 **자동 판정이 아니라 자동 추출·제안**으로 한정한다. 운영 적용 전, 검증 영상셋에서 수기 annotation 대비 오차를 산출하고(§8.9) 변수별 허용오차·자동제안 신뢰도 임계값을 정한다. 임계값 미만 결과는 모듈 입력으로 자동 제안하지 않고 "참고만 가능/수기 확인 필요"로 표시한다.
> **전제 (이전 검토 + 레거시 OS 제약 + 검토 반영):**
> - 포즈 추정은 **RTMPose(MMPose 계열)**. **추론은 인트라넷 서버**에서 수행(클라이언트 OS 독립 — §8.2).
> - **v6.0.0 현장 기본 구현은 CPU(ONNX/OpenVINO) 경로로 확정.** 현 서버는 GPU가 없다(§8.2). GPU 경로는 향후 서버 증설 시 교체 가능한 backend adapter로만 남긴다(§8.14).
> - 딥러닝은 **사전학습 특징 추출기**로만 사용. 결과를 직접 예측하는 end-to-end 시계열 DL은 채택하지 않는다.
> - **2D 우선.** 진짜 3D 융합은 보정·동기된 새 촬영이 갖춰질 때까지 보류.
> - **영상은 각도·시간·반복·비율만 채운다.** 무게·힘·진동 강도·BK 유형은 영상 불가 → 수기 유지(§8.10). out-of-plane(비틀림·회전)·진동은 자동입력하지 않고 "후보/저신뢰 플래그"로만 격하.
> - 회귀 등 통계 분석은 **본 단계 범위 밖** — §9에 스코프만.

---

### 8.1 목적과 위치

기존 시스템은 신체부담 지표를 **전문의가 영상을 육안으로 보고 수기 입력**한다. 본 모듈은 보유 중인 **작업조사 영상**을 서버 포즈 추정으로 분석해 그 지표를 **자동 추출·제안**한다.

1. **영상 분석** — 서버가 RTMPose로 관절 좌표 시계열을 뽑고 부위별 인간공학 변수를 계산.
2. **모듈 자동 입력** — 추출 변수를 각 부위 모듈 입력 필드에 **형태를 맞춰 제안**(§8.10). 항상 **제안값**이며 전문의가 확정(§8.12). 최종 책임은 사람.

---

### 8.2 아키텍처 결정 — 서버 추론

추론은 **인트라넷 서버의 Docker 추론 컨테이너**에서 수행한다. 클라이언트는 영상을 업로드하고 서버가 추출한 수치 변수를 돌려받아 모듈 입력에 제안한다.

| 배포 모드 | 추론 위치 | 클라이언트 요구 | 비고 |
|-----------|-----------|------------------|------|
| **Electron Intranet** | **서버 (Docker 추론 컨테이너)** | **모든 OS(Win7 포함) — HTTP 업로드만** | **권장·기본. 본 설계의 중심** |
| Electron Standalone | 단일 PC, 서버 없음 | Win10+ 선택적 로컬 추론 / Win7 미지원 | 영상 분석은 사실상 인트라넷 기능. Win7 standalone은 기존 수기 입력만 |
| 웹 (Vercel) | 추론 서버 미보유 | 브라우저 | 영상 분석 미지원(데모) |

**서버 추론 결정 이유:**
- **클라이언트 OS 독립 (결정적).** `onnxruntime-node` 및 native runtime은 **Windows 10(1809+)·11 기준으로 문서화·테스트**되며 **Visual C++ 2019 런타임을 요구**한다. Win7에서는 공식 지원·현장 안정성을 보장하기 어렵고 VC 런타임·CPU 명령어(AVX)·바이너리 호환성 문제가 발생할 수 있다. 따라서 **Win7 클라이언트 로컬 추론은 지원 범위에서 제외**하고 서버 추론으로 한정한다. 추론을 서버에 두면 클라이언트는 업로드만 하면 되므로 Electron 22 위 Win7에서도 동작한다.
- **버전 일관성·법적 재현성↑.** 단일 서버 모델로 모든 케이스 동일 추출 → 비교·재현 용이.
- **클라이언트 단순화.** 모델·런타임을 클라이언트에 안 실음 → 설치본 작고, 모델 교체 시 서버 이미지 하나만 갱신(에어갭에서 특히 유리).

**되돌아오는 트레이드오프(정직하게):**
- **GB 영상 업로드 부활** → §8.6 업로드 아키텍처 필요.
- **프라이버시 약화** — 원본 영상이 서버로 이동 → 임시 저장 후 추론 완료 시 삭제, 비식별 수치 변수만 보존(§8.13).
- **서버 리소스** — 추론 집중 → CPU(ONNX/OpenVINO) 경량 경로 + 비동기 큐 순차 처리. 추론 이미지 에어갭 반입(§8.14).

**실제 서버 사양 반영 (현 인트라넷 서버):** Intel Core i5-14500(6P+8E, 14코어 20스레드, AVX2 지원) / RAM 16GB / **전용 GPU 없음(Microsoft Basic Display Adapter — Intel iGPU 드라이버 미설치, 전용 비디오 메모리 0MB)** / Windows 10 Enterprise 20H2(build 19042). 이 사양이 설계에 주는 결론:
- **CPU 전용 추론으로 확정.** NVIDIA GPU가 없고 iGPU 드라이버도 없으므로 **ONNX Runtime/OpenVINO CPU 경로가 기본이자 사실상 유일한 선택**(원안의 "GPU 있으면 사용"은 이 서버에선 비활성). i5-14500은 AVX2를 지원하는 현세대 CPU라 RTMDet+RTMPose-m ONNX의 CPU 추론은 충분히 동작한다. 단 **실시간이 아니라 비동기 배치**(클립 단위 큐) 전제 — 5분 클립을 5~10fps로 샘플링해 detection+pose를 도는 데 클립당 수 분이 걸릴 수 있고, 이는 오프라인 분석으로 허용 가능.
- **RAM 16GB가 진짜 제약.** 같은 박스에서 앱·PostgreSQL 16·Caddy·백업 컨테이너·(Docker/WSL2 VM)·영상 디코드·모델 로드가 메모리를 나눠 쓴다. 따라서 (1) **동시 추론 1건(순차 큐) 강제**, (2) 프레임을 전부 메모리에 적재하지 않는 스트리밍 디코드, (3) 공격적 다운샘플(해상도·fps), (4) **PyTorch 풀스택(수 GB) 대신 ONNX 경량 이미지**가 선택이 아니라 필요. iGPU 가속을 원하면 Intel 그래픽 드라이버를 설치해 OpenVINO로 UHD 770을 쓰는 길은 있으나, 16GB 공유 메모리에선 이득이 제한적이라 후순위.

> **클라이언트 본체의 별도 리스크(영상 분석과 무관):** 평가 앱 본체가 Win7을 지원하는 건 Electron 22 덕분이나, 22.x는 보안 지원이 종료된 계열이다. 이는 영상 분석 도입 이전부터의 리스크이며 본 설계로 해소되지 않는다.

---

### 8.3 영상 구성 — 직업 × 공정 × 시점 (3계층)

```
직업 (shared.jobs[])
└── 공정 (process)              ← 예: "철근 절단", "배근", "결속"
    └── 클립 (clip)             ← 정면 / 측면 영상 (서버 업로드·추론 단위)
        └── viewpoint: sagittal | frontal | other
```

- **공정**이 핵심 엔티티. 각 공정은 **시간 점유율(`shiftSharePercent`)** 을 가짐(직업 집계 가중치).
- **공정 구조·시간 점유율은 조사 서류 기반 전문의 수기 입력이 유일한 소스.** 영상은 그 위에 수치를 채울 뿐 공정을 만들지 않는다.
- 이 계층이 두 합성 단계를 만든다 — 공정 내 *시점 융합*, 직업 내 *공정 집계*(§8.6, 서버 수행).

---

### 8.4 Feature 표준 스키마·단위·신뢰도 계약 (schema-first)

**구현은 이 계약부터 확정한다(코드의 첫 산출물).** 모든 추출값은 단위·신뢰도·자동제안 가능 여부를 포함하는 표준 객체로 흐른다. **모든 feature가 숫자는 아니므로**(posture G코드·forced_neck_posture=categorical, suspectedKneeTwist=boolean, 진동·회전=candidate) numeric/boolean/categorical/candidate **union**으로 정의한다.

```ts
// shared/contracts/videoAnalysis.ts
type FeatureBase = {
  confidence: number;            // 0~1, §8.8의 overall
  autoSuggestAllowed: boolean;   // false면 모듈 자동 제안 금지(참고만)
  requiresManualReview: boolean; // true면 적용 시 수기 확인 강제
  warnings: string[];            // 예: 'LOW_VIEWPOINT_CONFIDENCE','PARTIAL_OCCLUSION'
};
type NumericFeatureValue = FeatureBase & {
  kind: 'numeric';
  value: number;
  unit: 'minutes_per_day' | 'hours_per_day' | 'cycles_per_minute'
      | 'cycles_per_day' | 'seconds_per_cycle' | 'ratio' | 'degrees';
};
type BooleanFeatureValue     = FeatureBase & { kind: 'boolean';     value: boolean };
type CategoricalFeatureValue = FeatureBase & { kind: 'categorical'; value: string; allowedValues?: string[] };
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };
type CandidateFeatureValue   = FeatureBase & {
  kind: 'candidate'; value: JsonValue; reason: string;   // unknown 금지 — JSONB 저장 가능 값으로 제한
  autoSuggestAllowed: false; requiresManualReview: true;   // 항상 고정
};
type VideoFeatureValue =
  | NumericFeatureValue | BooleanFeatureValue | CategoricalFeatureValue | CandidateFeatureValue;

// feature를 키로 식별 — requestedFeatures와 반환 feature의 대응 검증 가능
type FeatureKey =
  | 'squatDuration' | 'overheadHours' | 'repetitiveMediumHours' | 'repetitiveFastHours'
  | 'cyclesPerDay' | 'cycleSeconds' | 'trunkPostureG'
  | 'neckFlexionOver20HoursPerDay' | 'neckForcedFlexion' | 'neckCombinedFlexRot'
  | 'vibrationToolUseDurationCandidate' | 'suspectedKneeTwist';
type VideoFeatureMap = Partial<Record<FeatureKey, VideoFeatureValue>>;
```

**원자값 원칙:** 모듈 계산 필드에 실제 기입되는 것은 numeric/boolean/categorical의 `.value`(원자값)뿐이다(§8.11). `candidate`(진동공구 후보·회전 성분 등)는 **모듈 필드에 직접 쓰지 않고** `videoAnalysis.candidateFeatures[]` 또는 제안 UI에서만 표시한다. 단위·기준시간을 계약 단계에서 고정해 시간 단위 혼동(분/시)·비율 오해석을 막는다.

**requestedFeatures:** 한 클립에서 여러 부위 변수를 동시에 뽑을 수 있으므로(예: 어깨 overhead + 척추 trunk flexion), `analysisProfile`(fps 프로파일, §8.5)은 유지하되 내부적으로 추출 대상 feature 목록을 함께 지정한다.

```ts
{ analysisProfile: 'posture-basic',
  requestedFeatures: ['squatDuration','overheadHours','trunkFlexionOver20Ratio','neckFlexionOver20HoursPerDay'] }
```

---

### 8.5 분석 파이프라인 (클라이언트 업로드 + 서버 추론)

```
[클라이언트] 클립 선택 → (선택)FFmpeg 다운스케일 → 업로드 ─▶ [서버] 임시 저장
  ① 샘플 프레임에서 사람 box 후보 탐지 ──▶ [클라이언트] 대상 작업자 클릭(§8.7)
  ──▶ [서버] 본 분석 큐 투입:
  ② 디코드+다운샘플(analysisProfile별 fps) → ③ RTMDet 사람탐지 → ④ 대상자 track(§8.7)
  → ⑤ RTMPose 추정 → ⑥ 평활화(OneEuro) → ⑦ 인간공학 변수+신뢰도 계산(§8.8)
  → ⑧ 시점 융합(공정) → ⑨ 공정 집계(직업) → review_pending(검수 대기, §8.12)
[클라이언트] ◀── features + overlay 검수 ── ⑩ 모듈 매핑(§8.10) → 제안값 → 확정/폐기
  → 확정 후 영상·임시파일 보존 정책(§8.12)에 따라 삭제
```

**Job 상태 전이 (업로드와 본 분석 분리):** 대상 작업자 선택이 필요한 top-down 파이프라인 특성상, 업로드와 본 분석은 한 호출이 아니라 단계로 나뉜다.

```
uploaded → sample_detecting → awaiting_target_selection → target_selected
  → queued → processing → review_pending → done
오류: error   |   TTL 만료·사용자 취소: expired / cancelled
```

상태 정의(혼동 방지): `processing` 완료 후 상태는 `review_pending`(분석은 성공했으나 **아직 사용자 미검토**)이다. `done`은 사용자가 제안값을 **적용 또는 폐기하여 검수 흐름이 종료**된 상태를 뜻한다(= 분석 완료 ≠ done). 이 정의로 TTL cleanup·UI badge·audit 로그의 기준이 명확해진다.

상태·임시파일은 환자 JSONB가 아니라 **서버 job 테이블**이 관리한다(§8.6, 재시작·orphan·TTL 대비). 최종 feature·provenance만 JSONB(§8.11).

**analysisProfile (변수별 fps — 고정 5~10fps 금지):** 느린 자세시간 변수와 빠른 반복 변수는 필요 프레임율이 다르다.

| analysisProfile | 권장 fps | 대상 변수 |
|-----------------|----------|-----------|
| `posture-basic` | 5~10fps | 쪼그려앉기·체간 전굴·오버헤드 자세시간 |
| `repetition-upper-limb` | 10~15fps | 어깨·팔꿈치 반복 빈도 |
| `hand-wrist` | 15~30fps | 손목·손가락 반복, SI 보조 |

고fps는 처리·업로드 비용이 커지므로 공정/부위 목적에 맞는 프로파일만 선택한다.

**구현 메모:** RTMPose는 top-down → 앞단 RTMDet도 ONNX로 동반. SimCC 후처리는 서버 추론 서비스에서 처리. 프레임은 메모리 스트리밍.

---

### 8.6 업로드 아키텍처 (서버 추론의 핵심 과제)

인트라넷 Caddy(8080/8443) + Node/Express + 공유 Docker 볼륨 위에서:

- **스트리밍 업로드** — `multipart/form-data`, `multer`로 공유 볼륨에 디스크 스트리밍(base64 금지 — 33% 부풀고 메모리 폭발).
- **크기 제한·타임아웃 상향** — 프록시·서버 body size/timeout을 영상 크기에 맞게.
- **재개 가능 업로드(권장)** — **tus**(청크·이어받기·진행률, 자체 호스팅·오프라인 OK). 단 디버깅 범위 고려해 **첫 단계는 단순 multipart, tus는 후속 Phase**.
- **비동기 작업 큐** — 업로드 완료 시 `jobId` 즉시 반환, 클라이언트 폴링. Node가 볼륨에 쓰고 추론 컨테이너가 같은 볼륨을 읽음.
- **클라이언트 다운스케일** — 업로드 전 **FFmpeg** 해상도·fps·CRF 조정·오디오 제거. FFmpeg 자체는 Win7에서 동작 가능하지만, **`ffmpeg-static`에 번들된 현재 바이너리의 Win7 호환성은 패키지 버전에 따라 달라질 수 있다.** 따라서 Win7에서 검증된 바이너리를 번들하고 **현장 배포 전 Win7 테스트 PC에서 실행 검증**하며, 실패 시 **서버 측 트랜스코딩 fallback**(서버는 Win10이라 안전)을 사용한다. 과압축은 정확도 손해 → 네트워크 병목 시 보수적으로.
- **LAN 실측** — 그 PC↔그 서버 1~2GB end-to-end(`scp`·`iperf3`), 혼잡 시간대·동시 업로드 경합 확인.
- **서버 job 테이블 (휘발 상태는 JSONB 밖)** — 업로드 중·처리 중·삭제 대기 상태는 서버 재시작·중단·orphan에 견디도록 PostgreSQL 16에 별도 관리(인트라넷 모드). 최종 feature·provenance만 환자 JSONB.

```
video_analysis_jobs (인트라넷)
  id, patient_record_id, user_id, status,
  clip_id, process_id, target_person_id,
  upload_path, original_sha256, analysis_input_sha256, preprocess_config_hash,
  analysis_profile, error_code, error_message,
  created_at, updated_at, expires_at
```

- **API (업로드↔본 분석 분리, §8.5 상태 머신):**
  `POST /clips`(클립 등록→clipId) → `POST /clips/:id/sample-detect`(대표 프레임+person box) → `POST /clips/:id/select-target`(targetPersonId 저장) → `POST /jobs`(본 분석 시작) → `GET /jobs/:jobId`(폴링).
- **영상 보존** — §8.12의 검수 보존 정책에 따름(추론 직후 무조건 삭제 아님 — overlay 검수와 충돌 방지).

#### 8.6.1 시점 융합 (클립 → 공정)

각도별로 가장 잘 보이는 평면에서 읽어 공정 프로파일로 조립(3D 융합 아님). 측면: 체간 전굴·팔꿈치·무릎·목 굴곡 / 정면: 어깨 외전·체간 좌우굴곡·목 회전. 두 시점이 같은 각도를 보면 신뢰도 높은 쪽 채택, 한 시점만이면 그 평면 각도만 채우고 나머지는 누락 표시. **정면/측면 결과가 크게 다르면 `INTER_VIEW_CONFLICT` 경고**(§8.8).

#### 8.6.2 공정 집계 (공정 → 직업)

시간 점유율 가중. 누적형(시간·횟수)=가중합, 최댓값형(피크 각도)=최댓값, 빈도형=가중평균. 규칙은 `videoMappingConfig`에서 선언.

> **`tasks[]` 모듈 단축 경로:** 척추·경추는 `tasks[]` 구조라 **공정 ≈ task 1:1**. 집계 없이 공정 1개 → task 1개. 무릎·어깨·팔꿈치·손목은 집계 필수.

---

### 8.7 대상 작업자 선택 및 Tracking (다중 인물 처리)

작업조사 영상엔 작업자·조사자·행인이 함께 찍힌다. "가장 큰 box" 자동 선택은 엉뚱한 사람을 추적할 위험이 크다. **대상자 선택은 본 분석 전(前) 별도 단계**다(§8.5 상태 머신: `sample_detecting → awaiting_target_selection → target_selected`).

1. 업로드 후 서버가 **샘플/대표 프레임에서만** 사람 box 후보를 탐지(`sample-detect`, 본 분석 아님).
2. **사용자가 분석 대상 작업자를 클릭**(클립별, `select-target` → `targetPersonId` 저장).
3. 선택 후에야 본 분석 큐에 투입, 서버는 해당 **track ID** 기준으로 추적.
4. track이 끊긴 구간은 **"대상자 추적 실패 구간"** 표시.
5. 실패 구간은 자동 제안에서 제외하거나 낮은 confidence 처리.

선택한 작업자의 track metadata(track id, 추적 성공 프레임 비율)는 재현성 기록(§8.11)에 포함한다. (RTMPose/MMPose는 포즈 추정엔 강하나 top-down에서 detector·tracking 안정화는 별도 과제다.)

---

### 8.8 신뢰도(confidence) 세분화 및 저신뢰도 처리

신뢰도를 "정렬 구간 비율" 하나로 두면 부족하다. 결과 객체에 세분 지표를 둔다. **단, 첫 구현은 실제 산출 가능한 것부터(keypoint·visibility·tracking·inter-view), out-of-plane 등 계산이 까다로운 항목은 점진 확장.**

```ts
confidence: {
  overall: 0.82,
  keypoint: 0.88,         // RTMPose per-keypoint score 평균/최저
  visibility: 0.76,       // 관절 가림 비율
  tracking: 0.91,         // 대상자 추적 안정성
  viewpoint: 0.70,        // 읽으려는 각도와 시점 적합성
  usableFrameRatio: 0.83, // motion blur·frame drop 제외 후 사용 가능 비율
  warnings: ['LOW_VIEWPOINT_CONFIDENCE','PARTIAL_OCCLUSION']
}
```

**저신뢰도 처리 정책:** `overall`(또는 핵심 성분)이 임계값 미만이면 `autoSuggestAllowed:false`로 두어 **모듈 자동 제안 금지**, UI엔 "참고만 가능/수기 확인 필요"로 표시.

**임계값은 전역 단일값이 아니라 feature별로 둔다** — 무릎 쪼그려앉기와 손목 자세는 추정 난이도가 전혀 다르기 때문. 단, **구체 수치는 추측하지 않고 §8.9 검증(수기 annotation 대비 오차)으로 결정**한다(아래는 구조 예시이며 값은 placeholder).

```ts
thresholds: {              // 값은 §8.9 검증 후 확정 (예시)
  squatDuration: { overall: 0.70, visibility: 0.65 },
  overheadHours: { overall: 0.75, shoulderVisibility: 0.70 },
  wristPosture:  { overall: 0.85, handVisibility: 0.80 }
}
```

---

### 8.9 검증 및 허용오차

운영 적용 전 정확도를 측정하고 임계값을 정한다. 이 단계가 빠지면 "돈다"만 알고 "얼마나 틀리는지"를 모른 채 산재 판단에 쓰게 된다.

| Phase | 내용 | 산출물 |
|-------|------|--------|
| 검증셋 구축 | 실제/샘플 영상 20~50개, 전문의·평가자가 각도·자세시간·반복 수기 annotation | gold-standard JSON/CSV |
| 정확도 평가 | 영상 추출값 vs 수기값 | 각도 MAE, 반복 count 오차, 자세시간 오차율 |
| 임계값 결정 | 어느 confidence 이하 자동 제안 금지 | 변수별 `autoSuggestAllowed` 기준 |
| 문구 확정 | "영상 추정값/저신뢰도/수기확인 필요" 표시 기준 | UX·보고서 문구 |

| 변수 | 검증 지표(예시 허용오차) |
|------|--------------------------|
| 체간/무릎/목/어깨 각도 | 평균절대오차 MAE, ±10~15° 이내 |
| 쪼그려앉기/오버헤드 시간 | 수기 대비 오차율, ±20% |
| 반복 빈도 | 수기 count 대비 ±15~20% |
| 위험 역치 초과 여부 | sensitivity / specificity |
| 공정 집계 일일 노출시간 | 수기값 대비 차이 |

> 검증셋은 **실제 촬영 조건(거리·각도·가림)** 을 반영해야 하며, gold-standard 자체의 평가자 간 변동(inter-rater)도 함께 점검한다.

---

### 8.10 모듈별 입력 자동 매핑

서버가 돌려준 feature를 각 모듈 입력 구조로 변환(추론 위치와 무관). `presetConfig.applyToModule()`의 형제 계약.

#### 8.10.1 매핑 계약 — `videoMappingConfig`

```javascript
videoMappingConfig: {
  scope: 'job' | 'job-diagnosis' | 'task',
  aggregation: { /* 필드별 sum|max|weightedAvg */ },
  mapFromVideoFeatures(features, ctx /* {sharedJobId, diagnosisId?, processId?} */) {
    // features: §8.4 FeatureValue 객체들
    // 반환: 이 모듈 입력에 맞는 부분 객체 (suggested)
  }
}
```

#### 8.10.2 모듈별 매핑 표 (영상 불가 항목은 후보/플래그로 격하)

실제 모듈 데이터 구조(PRD §2.2 검증)의 필드명·구조를 기준으로 한다.

| 모듈 | 대상 구조 / scope | 1차 자동제안(검증 통과 시) | **후보/저신뢰 격하** | 수기 유지(영상 불가) |
|------|-------------------|----------------------------|----------------------|----------------------|
| **무릎** | `knee.jobExtras[]` / `job` | `squatting`(쪼그려앉기 시간) | `kneeTwist`→`suspectedKneeTwist`(저신뢰 플래그, 자동입력 금지) | `weight`, `kneeContact`, `stairs`, `startStop`, `tightSpace`, `jumpDown` |
| **어깨** | `shoulder.jobExtras[]` / `job` | `overheadHours`, `repetitiveMediumHours`, `repetitiveFastHours` | `vibrationHours`→`vibrationToolUseDurationCandidate`(공구 사용시간 후보만, **자동입력 금지** — 가속도 측정 불가) | `heavyLoadCount`, `heavyLoadSeconds`(무게) |
| **척추(MDDM)** | `spine.tasks[]` / `task` (공정≈task) | `frequency`(회/일), `timeValue`+`timeUnit`(1회 소요시간) | `posture`→`postureCandidate`(G1~G11은 하중 위치·작업유형 반영 → **수기 확인 필수**) | `weight`, `force`, `correctionFactor`(F1~F4) |
| **경추** | `cervical.tasks[]` / `task` (공정≈task) | `neck_nonneutral_hours_per_day`(목 20°↑ 굴곡 유지시간), `forced_neck_posture`(굴곡 성분) | `combined_flexion_rotation_posture`(회전·복합자세는 2D 저신뢰 → 임계 미만 제안 금지) | `load_weight_kg`, `carry_hours_per_shift`, `exposure_types[]`, `precision_work` |
| **팔꿈치** | `elbow.jobEvaluations[].diagnosisEntries[]` / `job-diagnosis` | 반복·자세 지표 | — | `exposure_types[]`, `force_level`, `direct_anatomic_link`, `selectedBkType` |
| **손목** | `wrist.jobEvaluations[].diagnosisEntries[]` / `job-diagnosis` | 반복·손목 자세(**hand 모델**), SI 부분 변수(§8.10.3) | — | 힘·진동, **SI 강도(IE)**, `selectedBkType` |

원칙: 영상은 **각도·시간·반복·비율**만. **무게·힘·진동 강도·BK 유형·out-of-plane(비틀림·회전)** 은 자동입력하지 않는다. `job-diagnosis` 모듈은 영상(공정)을 어느 상병에 매핑할지 사용자가 지정.

#### 8.10.2-1 매핑 타깃 계약 (코드 초안 — featureKey → targetPath → unit)

6.0-0 계약 단계에서 다음을 확정한다. `targetPath`는 `appliedInputs[].targetPath`(§8.11)에 그대로 들어가며, 값은 해당 모듈 필드에 **숫자/원자값**으로 적용된다(객체로 바꾸지 않음).

```
무릎 (knee.jobExtras[sharedJobId])
  squatDuration   → .squatting        unit: minutes_per_day  (auto)       ※ 단위 확정: 분/일 (createKneeJobExtras 기준)
  kneeTwist       → (자동입력 금지)    suspectedKneeTwist 플래그만 표시     (candidate)

어깨 (shoulder.jobExtras[sharedJobId])  ※ 모든 *_Hours는 dailyHours, 누적 = dailyHours×workDaysPerYear×periodYears
  overheadHours          → .overheadHours          unit: hours_per_day  (auto)
  repetitiveMediumHours  → .repetitiveMediumHours   unit: hours_per_day  (auto)  사이클 속도 '중간'으로 분류된 누적시간
  repetitiveFastHours    → .repetitiveFastHours     unit: hours_per_day  (auto)  사이클 속도 '빠름'으로 분류된 누적시간
  vibrationToolUseDurationCandidate → (자동입력 금지) 후보 표시만           (candidate, ≠ .vibrationHours)

척추 MDDM (spine.tasks[*]  ※ 공정 1개 = task 1개)
  cyclesPerDay    → .frequency            unit: cycles_per_day  (auto, review)  = cyclesPerMinute × 공정활동분/일
  cycleSeconds    → .timeValue + .timeUnit unit: seconds_per_cycle (auto, review)  1회 소요시간
                    ※ 1차 구현 변환 규칙: 항상 초 단위 — timeValue=Math.round(sec), timeUnit='sec'. 사용자가 UI에서 분/시로 수정 가능.
  trunkPostureG   → .posture(G1~G11)        postureCandidate     (candidate, 수기확인 필수)
  (수기) .weight, .force, .correctionFactor

경추 (cervical.tasks[*]  ※ 공정 1개 = task 1개)
  neckFlexionOver20HoursPerDay → .neck_nonneutral_hours_per_day  unit: hours_per_day  (auto)
  neckForcedFlexion            → .forced_neck_posture(굴곡 성분)                       (auto, review)
  neckCombinedFlexRot          → .combined_flexion_rotation_posture  (회전 성분 저신뢰)  (candidate)
  (수기) .load_weight_kg, .carry_hours_per_shift, .exposure_types[], .precision_work
```

단위 주의: 어깨·경추의 시간 필드는 **시간/일(hours_per_day)** 누적 기반이고, MDDM `frequency`는 **회/일**, `timeValue`는 **1회 소요시간**으로 의미가 다르다(누적시간 아님). 무릎 `squatting`은 **분/일(minutes_per_day)** 이다.

> **타입은 코드가 진실:** 위 매핑의 필드명·타입(categorical/boolean 표기 포함, 특히 `forced_neck_posture`)은 PRD 문서에서 유추한 **초안**이다. **6.0-0에서 실제 모듈 `data.js`의 `createModuleData` 기본값 타입과 계산 함수 입력 타입을 기준으로 확정**하며, 문서와 코드가 어긋나면 코드를 우선한다.

#### 8.10.3 손목 Strain Index (SI) — 하이브리드 산출

| SI 변수 | 영상 추출 | 출처 |
|---------|-----------|------|
| 분당 노출 횟수 | ✅ | 영상(사이클 카운팅) |
| 손목·손 자세 | ✅ (**hand 모델 21점**) | 영상 |
| 노출 지속(% cycle) | ⚠️ 보조 | 영상→수기 확인 |
| 작업 속도 | ⚠️ 보조 | 영상→수기 확인 |
| **노출 강도(IE)** | ❌ | **수기 (SI 최대 가중 — 힘 측정 불가)** |
| 1일 작업 지속 | — | 직업력/일정 |

서버가 횟수·손목 자세를 채우고, 전문의가 강도(IE) 입력, 지속(DD)은 일정에서 → 엔진이 SI 계산. SI는 손목 모듈 **보조 점수**(참고), BK 판정 대체 아님. **본 항목은 hand 모델이 필요하므로 최종 Phase로 미룸.**

---

### 8.11 Provenance 저장 및 재현성 (recipe versioning)

**환자 JSONB vs 서버 job 테이블 역할 분리.** 영구·UI용 구조는 환자 JSONB에, 휘발 상태·임시파일 경로는 서버 테이블에 둔다. **임시파일 경로(`upload_path`)는 JSONB에 절대 넣지 않는다.**

```
data.shared.videoAnalysis = {       // 환자 JSONB (영구·UI용)
  processes: [],          // 공정 메타(name, shiftSharePercent 등)
  clips: [],              // 클립 메타데이터만 — 파일 경로 저장 금지
  processFeatures: [],    // 공정 단위 fused feature(VideoFeatureMap)
  jobFeatures: [],        // 직업 단위 집계(파생값 — 필요 시 재계산 가능)
  candidateFeatures: [],  // 자동입력 금지 후보(진동·회전 등)
  appliedInputs: [],      // provenance (아래)
  settings: { retentionMode: 'privacy_first' | 'review_fidelity' }   // §8.12
}

video_analysis_jobs (서버 테이블)    // 휘발 상태·임시파일 — JSONB 밖
  status, upload_path, original_sha256, analysis_input_sha256,
  preprocess_config_hash, expires_at, error_* ...  (§8.6)
```

**기존 입력 필드를 객체로 바꾸지 않는다.** 계산 엔진이 `overheadHours: 1.8`(숫자)을 기대하므로 객체를 박으면 깨진다. 값은 숫자로 두고 출처는 `appliedInputs[]`에 저장. **원제안값·최종적용값·이전값을 모두 보존**한다(방어가능성 + 되돌리기).

```
data.modules.shoulder.jobExtras[]
  └── { sharedJobId, overheadHours: 2.0, ... }   // 그대로 숫자(최종 적용값)

data.shared.videoAnalysis.appliedInputs[]         // provenance는 별도
  └── {
        moduleId: 'shoulder',
        targetPath: 'modules.shoulder.jobExtras[sharedJobId=...].overheadHours',
        suggestedValue: 1.8,        // 영상 원제안
        appliedValue: 2.0,          // 전문의 확정값
        previousValue: null,        // 적용 전 값(되돌리기용)
        editReason: '가려진 구간 수기 보정',  // 수정 시
        unit: 'hours_per_day', source: 'video',
        processIds: ['p1','p2'], clipIds: ['c1','c2'],
        confidence: 0.82,
        analysisBundleVersion: 'rtmpose-2026-06-a',
        appliedAt: '...', appliedBy: 'doctor01'
      }
```

**재현성 — modelVersion 하나로는 부족.** 영상을 안 남기더라도 다음을 `analysisBundleVersion`(=recipe)으로 묶어 기록한다.

| 항목 | 이유 |
|------|------|
| `originalFileSha256` | 원본 영상 증명용(같은 영상에서 나온 결과임) |
| `analysisInputFileSha256` | **클라이언트 다운스케일 시 실제 모델 입력은 원본이 아니므로 분리** — 입력 재현용 |
| `preprocessConfigHash` (fps/resize/crop/CRF/오디오 + 원본 config JSON) | 같은 원본을 다른 CRF로 압축해 결과가 달라지는 상황 설명 |
| 모델 weight SHA-256 (detector·pose 각각) | 버전명만으로 부족 |
| feature config 버전 (각도 threshold·count 알고리즘) | 계산 동일성 |
| code commit hash | 같은 모델이라도 코드 변경 가능 |
| usable frame ratio·warnings | 신뢰도 설명 |
| 선택 작업자 track metadata | 다중 인물에서 필수 |

**분석 결과 삭제 vs 적용값 유지 정책:** 사용자가 "영상 분석 결과 삭제"를 누를 때 —
- 분석 job/result(`rawFeatures`·temp preview)는 삭제.
- **이미 적용된 모듈 숫자값은 유지**(되돌리려면 `previousValue`로 rollback).
- provenance(`appliedInputs[]`)는 기본 유지, 사용자가 명시적으로 제거 가능.

---

### 8.12 자동 입력 UX 와 확정 흐름

**트리 정리 → 업로드·서버 분석 → skeleton 검수 → 제안 검토 → 확정.** 자동 입력은 제안.

1. **영상 정리(트리)** — 새 공유 스텝 `[공유] 영상 분석`. 직업별 공정 추가(서류 기반) → 클립 지정 → 시점 태깅 → 공정별 시간 점유율(%) 입력 → analysisProfile 선택. 누락 시점·미태깅 경고.
2. **대상자 선택** — 대표 프레임에서 작업자 클릭(§8.7).
3. **업로드+분석** — (선택)다운스케일 → 업로드 진행률 → `jobId` → 서버 처리 진행률 폴링 → 완료 시 `review_pending` 상태로 공정별/직업별 결과 + 신뢰도 표시.
4. **Skeleton overlay 검수 (분석 후 재생 오버레이)** — 분석된 클립을 재생하며 원본 프레임 위에 관절·뼈대·각도 라벨·track을 오버레이해, 어느 구간에서 어떤 자세가 잡혔는지 전문의가 눈으로 확인(오인식·잘못된 대상자 조기 발견). **라이브 실시간이 아니라 배치 분석 후 재생 시 오버레이**다 — CPU 전용 서버·비동기 배치(§8.2) 전제와 일치. 오버레이는 원본 프레임 위에 그려지므로 얼굴·작업장이 함께 보일 수 있어, 보존 정책(아래)의 privacy_first에서는 **비식별 overlay 썸네일/스켈레톤 전용 렌더**(원본 영상 없이 뼈대만)로 검수한다.
5. **제안 검토** — 필드 옆 제안 배지 + **confidence·warning 표시**. 저신뢰(`autoSuggestAllowed:false`)는 "참고만". `tasks[]` 모듈은 공정별 task 후보 나열. 필드/일괄 적용·무시.
6. **확정** — 값은 숫자로 저장, provenance는 `appliedInputs[]`에(§8.11). `requiresManualReview:true`는 확인 강제. **확정/폐기 시점에 보존 정책(아래)에 따라 임시 영상 삭제.**
7. **수정 가능** — 적용 후에도 자유 수정. 최종 책임은 사람.

**검수 보존 정책 (overlay 검수 ↔ 영상 삭제 충돌 해소):** "추론 직후 무조건 삭제"와 "분석 후 overlay 검수"는 그대로 두면 충돌하므로, `review_pending` 동안의 보존을 운영 설정으로 **둘 중 하나** 선택한다.

- **(A, 기본 — 프라이버시 우선)** 원본은 분석 직후 삭제하고, 검수는 분석 중 생성한 **비식별 overlay 썸네일 strip + keypoint preview**만 사용. 에어갭·의료 맥락의 기본값.
- **(B, 검수 충실 우선)** 다운스케일 영상을 **암호화 임시 저장소**에 검수 완료 또는 TTL(예: 24h)까지 보관 후 삭제. 미세한 추적 오류까지 원영상 대조가 필요할 때.

어느 쪽이든 원본 영상은 PostgreSQL JSONB에 저장하지 않으며(§8.13), TTL·orphan cleanup이 미확정 임시파일을 회수한다.

---

### 8.13 보안·권한·감사·삭제 정책 (기존 인트라넷 모델과 결합)

기존 PRD의 JWT·Device 등록·감사 로그·권한 정책에 영상 파이프라인을 묶는다.

| 항목 | 정책 |
|------|------|
| 업로드 권한 | 해당 환자 수정 권한 보유자만 업로드 |
| Device 상태 | 인트라넷 Electron device가 active일 때만 허용 |
| 감사 로그 | 업로드 시작/완료/분석/삭제/제안 적용 모두 audit 기록 |
| 임시 저장소 | 백업 대상 제외, 권한 제한, TTL 삭제 |
| 실패 정리 | 분석 실패·앱 종료·큐 중단 시 orphan temp cleanup job |
| 파일 제한 | 허용 확장자, MIME sniffing, 최대 크기·길이 |
| 저장 금지 | 원본 영상은 PostgreSQL JSONB에 절대 저장 금지 |
| 환자 권한 | 비담당 환자 영상 분석 결과 적용 금지 |

---

### 8.14 서버 추론 서비스 배포 (에어갭)

- **컨테이너** — RTMDet+RTMPose. **이 서버는 GPU 없음(§8.2) → ONNX/OpenVINO CPU 이미지로 확정**(CUDA 불가). 16GB RAM이므로 PyTorch 풀스택(수 GB) 대신 ONNX 경량 이미지.
- **에어갭** — 온라인 PC에서 의존성·가중치까지 이미지에 구워 빌드 → `docker save` → 반입 → `docker load` 실행만(기존 `import-images.ps1`/`.sh` 흐름 재사용). 출하 전 `docker run --network none` 검증.
- **주의** — `--platform` 아키텍처 일치, OpenCV `libGL.so.1`(→`libgl1` 또는 `opencv-python-headless`), 텔레메트리·버전 체크 비활성화.
- **공유 볼륨** — Node(업로드 수신)와 추론 컨테이너가 동일 볼륨 마운트.
- **Windows 호스트 현실 (이 서버는 Windows 10 Enterprise).** 기존 인트라넷 스택(PostgreSQL 16·Caddy·백업)이 Docker Compose로 Linux 컨테이너로 돈다는 것은 호스트에서 **Docker가 WSL2(또는 Hyper-V) 백엔드로 Linux VM을 띄워** 동작 중이라는 뜻이다. 추론 Linux 컨테이너를 추가하면 같은 WSL2 VM의 메모리를 공유하므로, **`.wslconfig`로 WSL2 메모리 상한을 명시**(예: 기존 컨테이너 + 추론이 16GB를 넘지 않게)하고, 추론 컨테이너에 메모리/CPU 한도(`--memory`, `--cpus`)를 건다. 기본값(WSL2가 호스트 RAM 대부분 점유)을 두면 추론 중 다른 서비스가 메모리 부족으로 흔들릴 수 있다.
- **대안 — 네이티브 Windows 프로세스.** 16GB 제약과 Windows 호스트를 감안하면, 추론을 Linux 컨테이너 대신 **호스트의 네이티브 Python 프로세스(onnxruntime + OpenCV)** 로 두고 Node 백엔드가 자식 프로세스로 관리하는 방식도 검토할 가치가 있다. WSL2 VM 오버헤드(메모리 중복 점유)를 없애 16GB를 더 효율적으로 쓰며, 에어갭에선 오프라인 wheel/embeddable Python로 설치한다. 단 기존 배포가 전부 컨테이너 기반이라 운영 일관성(빌드·반입·버전 고정)은 컨테이너가 유리 — 6.0-9에서 **WSL2 메모리 상한 vs 네이티브 프로세스**를 실측(동시 사용·메모리 피크)으로 결정한다.
- **(조건부·후순위) NVIDIA GPU 추가 시.** 향후 서버에 NVIDIA GPU를 장착하면 추론을 CUDA 경로(ONNX Runtime CUDA EP 또는 PyTorch)로 전환해 처리량을 크게 높일 수 있다. 이 경우 NVIDIA 드라이버 + (컨테이너 사용 시) NVIDIA Container Toolkit으로 GPU 패스스루를 구성하고, 동시 처리·큐 정책을 재산정한다. 현 v6.0.0은 **CPU 추론 기준으로 설계·구현**하며, GPU는 실측상 CPU가 병목으로 확인된 뒤 검토하는 후순위 옵션으로 둔다(CPU↔GPU 전환이 가능하도록 추론 백엔드는 교체 가능한 어댑터로 분리).

---

### 8.15 새 모듈 추가 절차 영향

기존 5단계(§2.1)에 추가: 5.(선택) `videoMappingConfig` 선언(공정 집계·후보 격하 포함). 미선언 모듈은 자동 입력 제외(수기만, 하위호환).

---

### 8.16 단계적 구현 우선순위 (검토 반영 — mock-first 세로조각)

**첫 PR은 RTMPose가 아니라 계약/데이터/mock feature/매핑이다.** 실제 추론 없이 "공정 추가 → mock feature → 모듈 제안 → 적용/무시 → provenance 기록"까지 세로로 얇게 검증한 뒤, 마지막에 추론 컨테이너로 mock을 교체한다.

| Phase | 내용 | 산출물 |
|-------|------|--------|
| 6.0-0 | **Feature 표준 스키마/계약 확정**(§8.4/8.8) — `VideoFeatureValue` union, `FeatureKey`/`VideoFeatureMap`, `analysisProfile`/job status enum, `appliedInputs`·`candidateFeatures` 스키마 | `shared/contracts/videoAnalysis.ts` |
| 6.0-1 | `videoAnalysis` 데이터 모델(§8.11) + `migratePatient` 초기화 + 기존 파일 로드 테스트(기존 기능 무파손) | 데이터 모델 |
| 6.0-2 | **mock feature 생성기 + 집계 + 큰 관절 매핑 + `appliedInputs[]`** | 추론 없이 핵심 흐름 동작 |
| 6.0-3 | `[공유] 영상 분석` 위자드 스텝(트리·공정·시점·제안 검토, mock) | UX 골격 |
| 6.0-3.5 | **검증 하네스 조기 구축** — gold-standard annotation 스키마 + 오차 계산기 skeleton + mock feature↔annotation 비교 테스트(실제 검증셋은 6.0-B2) | annotation 포맷·오차 계산기 |
| 6.0-4 | 서버 job API(상태 머신 §8.5: …`processing → review_pending → done`) + 폴링 + 환자 권한 + audit | mock job 흐름 |
| 6.0-5 | 단일 클립 RTMDet+RTMPose ONNX PoC | keypoints.json |
| 6.0-6 | feature 계산기(각도·반복·자세시간) + **대상자 선택/tracking** + 영상 품질검사 | 실제 feature |
| 6.0-B2 | **수기 annotation 검증 + 변수별 허용오차·임계값 결정**(§8.9, 하네스는 6.0-3.5에서 준비됨) | 정확도 기준 |
| 6.0-7 | 실제 업로드(multipart→크기·MIME·임시저장·삭제·orphan cleanup) | 업로드. tus는 이 뒤 |
| 6.0-8 | 저위험 모듈 본격 매핑(어깨 overhead, 무릎 squatting, 경추 neck flexion, 척추 freq/time/postureCandidate) | 모듈 자동 제안 |
| 6.0-9 | 에어갭 Docker 배포·운영 리허설 + recipe versioning(§8.11) | 인트라넷 배포 |
| 6.0-10 | (선택) hand/whole-body 모델로 팔꿈치·손목 + **손목 SI** | 손목·SI |

핵심: 처음부터 손목/SI까지 욕심내지 말고 **큰 관절·자세시간 변수부터 검증**한다.

---

## 9. 통계 분석 모듈 — 다음 단계 (스코프만)

> **상태:** **본 단계(v6.0.0) 범위 밖.** 영상 분석으로 정량 변수가 누적된 뒤 별도 단계(v7.x)에서 구현. 방향만 기록.

- 공통 토대는 **중첩 JSON → 평탄한 분석 테이블** 피처 추출 레이어. 그 위에 3단(기술통계 → 추론·회귀 → 예측·ML). 영상 추출 정량 변수(§8.4)도 입력.
- **작은 임상 표본(수백~수천)** 은 과적합 때문에 ML이 회귀를 못 이기는 경우 많음 → **해석 가능한 회귀(선형·로지스틱·순서형)** 가 sweet spot. 산재 판단의 법적 방어가능성 때문에 glass-box 우선.
- 변수 많거나 상관되면 **벌점 회귀(Ridge/LASSO/Elastic Net)**, 깨끗한 추론(오즈비·신뢰구간)엔 벌점 없는 회귀. 비선형 용량-반응엔 **스플라인**.
- **ML이 정당화되는 조건:** 비정형 데이터(영상·텍스트·신호), 큰 표본, 복잡한 상호작용, 순수 예측. 영상 분석(§8)이 "비정형 데이터의 정형화" 진입로.
- 재현성을 위해 모델·변환 파라미터 고정.

**구현 스코프(예정):** 피처 추출 레이어 → 기술통계 → 회귀(선형/로지스틱/순서형) → (조건 충족 시) 벌점 회귀·스플라인.

---

## 10. 향후 연구 트랙 — 3D 생체역학 / OpenSim (선행 조건 충족 시)

> **상태:** **v6.0.0 범위 밖, 별도 연구 트랙.** 근육 부하·관절 토크 역계산(OpenSim 등)은 매력적이나, 아래 선행 조건이 갖춰지기 전에는 착수해도 검증을 통과하기 어렵다. 방향과 전제만 기록한다.

**선행 조건 (이게 핵심):**
- **진짜 3D 모션이 필요.** OpenSim의 역동역학·근육 추정은 3D 관절 좌표를 전제한다. 현재 보유 영상은 보정·동기 안 된 2D 단일 시점이라(§8.5에서 3D 융합 보류) 부적합. 3D를 얻으려면 **동기화(같은 순간 프레임) + 캘리브레이션(체커보드로 카메라 내부·상대 위치 산출) + 고정된 멀티카메라 리그**로 같은 동작을 2대 이상에서 동시 촬영해야 한다 — **현장 촬영 방식 자체를 새로 셋업**해야 하는 운영상 무거운 변화.
- **외력 정보가 필요.** 관절 토크·근육 부하 역계산은 취급 하중·지면 반력 같은 외력을 입력으로 요구한다. 영상은 무게를 못 재므로(§8.10의 "무게·힘 수기 유지"와 같은 한계), 외력 없는 토크 값은 신뢰하기 어렵다.
- **개인화 근골격 모델 스케일링·마커셋·시뮬레이션 수렴 검증** 등 OpenSim 파이프라인 자체의 구축·검증 부담이 크다(사실상 별도 R&D 프로젝트급, v6.0.0 전체에 맞먹거나 그 이상).

**법적 방어가능성과의 관계:** OpenSim 산출값(근육 부하·토크)은 모델 가정이 다수 개입된 **추정값**이다. 본 앱의 원칙(자동 판정 금지·glass-box 우선, §8.1)상 검증 없이 의학적·법적 판정 근거로 끌어들이지 않는다. 도입하더라도 **참고 연구 지표**에 한정한다.

**전제 충족 시 경로(예정):** 동기·보정 멀티카메라 촬영 → 2D 포즈(시점별) → 삼각측량 3D → (외력 입력) → `.trc`/`.mot` 익스포트 → OpenSim 역동역학. MOT 익스포트 자체는 어렵지 않으나, "나온 부하 값이 믿을 만한가"의 **검증**이 진짜 과제다.
