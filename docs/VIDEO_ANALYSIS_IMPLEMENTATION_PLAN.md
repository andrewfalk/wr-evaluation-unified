# 작업 영상 인간공학 분석 (RTMPose) — v6.0.0 구현 플랜

> 원천: `PRD_video_analysis_addition.md` §8. 계획 확정: 2026-06-15 (Codex 리뷰 6회 반영).
> 이 문서는 **살아있는 진행 추적 문서**다 — 각 PR/파트 완료 시 아래 체크리스트를 갱신한다.

## 📊 구현 진행 현황

범례: `[x]` 완료 · `[~]` 진행 중 · `[ ]` 대기

### M1 — mock 세로조각 (6.0-0 ~ 6.0-4)
- [x] **PR1 (6.0-0)** feature 계약 + SharedDataSchema 확장 — PR #11 ✅ 머지
- [x] **PR2 (6.0-1)** videoAnalysis 데이터 모델 + `ensureSharedDefaults()` 마이그레이션 — PR #12 ✅ 머지
- [~] **PR3 (6.0-2)** mock 생성기 + 집계 + `videoMappingConfig` + provenance/rollback
  - [ ] `videoMock.js` — `generateMockFeatures(requestedFeatures, profile)`
  - [ ] `videoAggregate.js` — 공정→직업 집계(누적=가중합, 피크=max, 빈도=가중평균)
  - [ ] `videoProvenance.js` — `applyFeatureToModule()` + rollback
  - [ ] `moduleRegistry` `videoMappingConfig` 키 통과 + shape 매니페스트 테스트
  - [ ] knee/shoulder/spine/cervical `videoMappingConfig` 선언(모듈별 타입 코어싱)
  - [ ] 테스트: mock→매핑→적용→appliedInputs→rollback, 모듈별 코어싱
- [ ] **PR4 (6.0-3)** 피처플래그 5곳 배선 + 로컬 mock UI
- [ ] **PR5 (6.0-4)** clip/job DB + 서버 mock 폴링 + apply endpoint + audit

### M2 — 실제 추론 PoC (6.0-3.5, 6.0-5, 6.0-6)
- [ ] 6.0-3.5 검증 하네스 skeleton
- [ ] 6.0-5 단일클립 RTMDet+RTMPose ONNX CPU PoC
- [ ] 6.0-6 feature 계산기 + 대상자 tracking + 시점 융합

### M3 — 업로드·검증·매핑 (6.0-7, 6.0-B2, 6.0-8)
- [ ] 6.0-7 multipart 업로드 + 임시저장·TTL·cleanup
- [ ] 6.0-B2 수기 annotation 검증 + 변수별 임계값 결정
- [ ] 6.0-8 저위험 모듈 본격 매핑 + skeleton overlay 검수

### M4 — 배포·고급 (6.0-9, 6.0-10)
- [ ] 6.0-9 에어갭 Docker 배포 + recipe versioning
- [ ] 6.0-10 (선택) hand 모델 손목/팔꿈치 + 손목 SI

---

## Context

`PRD_video_analysis_addition.md`(§8)는 보유 중인 **작업조사 영상**을 서버 포즈 추정(RTMPose)으로 분석해
신체부담 인간공학 변수를 **자동 추출·제안**하는 기능을 정의한다. 핵심 제약:

- **자동 판정이 아니라 자동 제안.** 임계값 미만 결과는 모듈에 자동 입력하지 않고 "참고만/수기 확인".
- **추론은 인트라넷 서버(CPU/ONNX)** — 클라이언트 OS 독립(Win7 포함 업로드만).
- **mock-first 세로조각** — 첫 PR은 RTMPose가 아니라 계약/데이터/mock feature/매핑. 추론 컨테이너는 마지막에 mock 교체.
- **기존 기능 무파손** — 하위호환 마이그레이션, 기능은 **피처플래그 뒤에서 비활성 기본**.

이 플랜은 PRD §8.16의 11개 하위단계(6.0-0~6.0-10)를 **실제 코드 구조에 매핑**하고 **단계별 PR→main(피처플래그)**
워크플로를 입힌다. 1차 마일스톤(M1)을 파일·함수 단위로 상세화, M2~M4는 개요로 둔다.

### 코드베이스 그라운딩 (실제 코드 검증 — "코드가 진실")

- **계약**: `shared/contracts/`는 zod 스키마, `index.ts` barrel export, 클라·서버 공용.
- **모듈 필드 타입(매핑 코어싱 근거)**: knee `squatting:''`/shoulder `overheadHours·repetitiveMediumHours·repetitiveFastHours:''`/cervical `neck_*:''`는 **문자열**, spine `frequency:80·timeValue:5`는 **숫자**, `timeUnit:'sec'`/`posture:'G1'` 문자열. → 모듈별 코어싱(`String(...)` vs number) 분기 필요.
- **마이그레이션 위험(해결됨)**: `migrateJobsToShared()`는 `shared.jobs` 존재 시 조기 반환 → 신형식 환자에 기본값 미주입. `ensureSharedDefaults()`를 `migratePatient` 말미에서 항상 호출하고, 빈/부분 `videoAnalysis` 객체도 merge 보강.
- **피처플래그 배선**: `src/config.ts`는 없음. 공개 설정은 `useServerConfig` → `/api/config/public`(`serverConfig.aiEnabled` 형제로 `videoAnalysisEnabled`). 위자드 `buildSteps(activeModules)`는 플래그 미수용 → 호출부(App.jsx, useIntakeWizard.js)까지 시그니처 조정 필요.
- **HTTP 계층**: `requestJson()`은 JSON 전용 → M3 업로드 전 `requestMultipart`/`fetchWithSessionHeaders` 계층 신설.
- **권한 가드**: `assignedDoctorOrAdmin(pool)`는 `req.params.id`를 환자 id로 조회(PATCH/DELETE `/api/patients/:id` 전용) → job route엔 jobId→clip→patient 조회 전용 guard 신설. `POST /clips`는 body patientId 기반 access check.
- **플래그 일관 배선(5곳)**: env `VIDEO_ANALYSIS_ENABLED=false`(server config.ts) → `ServerPublicConfigSchema` → `/api/config/public` → `useServerConfig` `FAIL_CLOSED_CONFIG` → mock 서버.
- **apply revision 정책**: `patchPatient`는 `If-Match` 헤더 요구 → mismatch 시 409. apply도 동일 패턴 + 트랜잭션 일괄.
- **레지스트리**: `registerModule`은 단순 Map 등록 — `videoMappingConfig` shape JSDoc/매니페스트 테스트 + "지원/미지원 모듈" UI 표기.
- **서버**: 라우트 팩토리(`createXRouter(pool)`), 마이그레이션 번호 SQL `server/migrations/`(다음 `0016`), audit 미들웨어, multer 미설치(추가 필요).

---

## Git 워크플로 (단계별 PR→main + 피처플래그)

각 Phase = main에서 분기한 단기 브랜치 → PR → main. main은 항상 릴리스 가능, 영상 분석 전체는 **`videoAnalysisEnabled` 플래그 뒤 비활성 기본**. mock-first라 추론 없이도 초기 단계가 안전히 머지됨.

- **브랜치**: `feat/video-6.0-N-xxx`(Phase 번호 + 요약).
- **사이클**: `git switch main && git pull` → `git switch -c feat/...` → 구현·커밋 → `npm run build:web` + 테스트 → push → `gh pr create --base main` → 리뷰 → 머지.
- **피처플래그**: 서버 `/api/config/public`에 `videoAnalysisEnabled`(기본 false). 검증(6.0-B2) 통과 전까지 운영 false.
- **DB 마이그레이션 번호 충돌 방지**: 머지 직전 최신 main 기준 `00NN_` 재번호.

---

## 마일스톤 묶음 (11 단계 → 4 마일스톤)

| 마일스톤 | 포함 Phase | 목표 |
|---------|-----------|------|
| **M1 — mock 세로조각** | 6.0-0 ~ 6.0-4 | 계약→데이터→매핑/provenance→플래그+로컬 mock UI→clip/job DB+서버 폴링+apply |
| **M2 — 실제 추론 PoC** | 6.0-3.5, 6.0-5 ~ 6.0-6 | 검증 하네스 + 단일클립 ONNX PoC + feature 계산기 + tracking |
| **M3 — 업로드·검증·매핑** | 6.0-7, 6.0-B2, 6.0-8 | multipart 업로드 + 수기 annotation 검증·임계값 + 저위험 모듈 본격 매핑 |
| **M4 — 배포·고급** | 6.0-9, 6.0-10 | 에어갭 Docker·recipe versioning + (선택) 손목 SI |

---

## M1 — mock 세로조각 (상세)

플래그 `videoAnalysisEnabled=false` 기본. 추론 없이 mock feature로 전 흐름 검증.

### PR 1 — 6.0-0: feature 계약 + SharedDataSchema 확장 ✅
**산출물**: `shared/contracts/videoAnalysis.ts` + `index.ts` 재export + `patient.ts` SharedDataSchema 확장.
- `VideoFeatureValue = discriminatedUnion('kind', [Numeric|Boolean|Categorical|Candidate])`.
- candidate 불변식(`autoSuggestAllowed:false`/`requiresManualReview:true`)을 `z.literal`로 스키마 강제.
- `FeatureKey`/`FeatureUnit` enum, `VideoFeatureMap`, `AnalysisProfile`, `VideoJobStatus`(§8.5), `Confidence`(§8.8), `AppliedInput`/`CandidateFeatureEntry`/`VideoAnalysisData`(§8.11).
- `VIDEO_FEATURE_TARGETS`: featureKey→targetPath→unit 테이블(§8.10.2-1).
- `SharedDataSchema`에 `videoAnalysis` optional 추가(구파일 호환).

### PR 2 — 6.0-1: 데이터 모델 + `ensureSharedDefaults()` 마이그레이션 ✅
- `createVideoAnalysisData()` 신설(§8.11) — schema default와 shape 일치(drift 테스트).
- `createSharedData()`에 `videoAnalysis` 추가.
- `ensureSharedDefaults()` — `migratePatient` 말미 항상 호출, 빈/부분 객체도 merge 보강.
- `createSamplePatient()`에 샘플 videoAnalysis.

### PR 3 — 6.0-2: mock 생성기 + 집계 + 매핑 + provenance/rollback (진행 중)
- `src/core/services/videoMock.js`: `generateMockFeatures(requestedFeatures, profile)` → `VideoFeatureMap`.
- `src/core/services/videoAggregate.js`(§8.6.2): 공정→직업(누적=가중합, 피크=max, 빈도=가중평균). spine/cervical은 공정≈task 1:1 단축.
- **`videoMappingConfig`(§8.10.1)** registerModule 신규 선택 키:
  - `moduleRegistry.js`에 키 통과 + shape JSDoc + 매니페스트 shape 테스트. 미선언 모듈은 자동입력 제외(하위호환, §8.15) + "지원/미지원 모듈" 표기.
  - knee/shoulder/spine/cervical `index.js`에 `videoMappingConfig` 선언, 모듈별 코어싱(knee/shoulder/cervical=`String`, spine=number).
  - candidate(`suspectedKneeTwist`·`vibrationToolUseDurationCandidate`·`trunkPostureG`·`neckCombinedFlexRot`)는 모듈 필드 미기입 → `candidateFeatures[]`에만.
- **provenance(§8.11)** `src/core/services/videoProvenance.js`: `applyFeatureToModule()`(원자값 기입 + `appliedInputs[]` 기록), rollback 헬퍼.
- **환자 revision 충돌 정책**: 적용은 환자 객체를 변경 → dirty 표시 + 기존 PatientSync 충돌 처리 재사용(서버 반영은 PR5).
- **테스트**: mock→매핑→적용→appliedInputs→rollback, 모듈별 코어싱.

### PR 4 — 6.0-3: 피처플래그 배선 + 로컬 mock UI
- 플래그 5곳 일관 배선(env / ServerPublicConfigSchema / `/api/config/public` / `FAIL_CLOSED_CONFIG` / mock 서버).
- 클라: `serverConfig.videoAnalysisEnabled` 소비. `buildSteps(activeModules, opts)` 시그니처 확장(App.jsx, useIntakeWizard.js, 기존 테스트 동반).
- 플래그 on일 때만 공유 스텝 `[공유] 영상 분석`(modules 뒤) + `StepContent.jsx` 라우팅 → `VideoAnalysisStep.jsx`.
- 로컬 mock UI 한정: 공정 추가 → 클립/시점/시간점유율(%)/profile → 로컬 `generateMockFeatures` → 제안 검토(confidence/warning, 저신뢰 "참고만") → 적용·무시.
- win7 호환(최신 JS 메서드 금지). config 테스트 갱신.

### PR 5 — 6.0-4: clip/job DB + 서버 mock 폴링 + apply endpoint + audit
- **마이그레이션 `0016_video_analysis.sql`**:
  - `video_analysis_clips`(clip_id PK, patient_record_id, organization_id, upload_path NULL 허용, original_sha256, `sample_detect_result JSONB`, target_person_id).
  - `video_analysis_jobs`(job_id PK, clip_id FK, organization_id·patient_record_id denormalize[서버가 clip 조회로 채움], process_id, status, analysis_profile, *_sha256, preprocess_config_hash, error_*, `applied_at`·`applied_revision`·`applied_inputs_hash`, expires_at). status CHECK enum, set_updated_at 트리거, 인덱스(org+status, patient, created desc).
  - mock 단계 nullable: upload_path·sha256.
- **라우트** `server/src/routes/videoAnalysis.ts`(`createVideoAnalysisRouter(pool)`), `/api/video-analysis` 마운트:
  - `POST /clips`(body patientId) → `sample-detect` → `select-target` → `POST /jobs`{clipId,processId,analysisProfile,requestedFeatures} → `GET /jobs/:jobId`.
  - **synced 책임 분리**: 클라가 차단(serverId+synced 시만 시작, 아니면 `PATIENT_NOT_SYNCED`), 서버는 존재/권한/조직 + If-Match revision 검증.
  - **전용 권한 guard**: `POST /clips`는 body patientId 기반, `/clips/:id/*`·`/jobs/:jobId/*`는 jobId/clipId→patient 조회 후 담당의/admin.
  - **`POST /jobs/:jobId/apply`**: If-Match 요구. 트랜잭션 순서 — ① `SELECT … FOR UPDATE`(jobs+patient) → ② applied_at+동일 hash면 idempotent 반환 → ③ If-Match 검사(409) → ④ apply+revision+1+audit. 응답으로 갱신 patient/revision 반환.
  - **클라 sync 반영**: `patientServerRepository.applyVideoAnalysisJob()` 신설(내부 `applyServerSync` 매핑).
  - **apply 멱등성·상태**: review_pending에서만, 성공 시 done. `applied_inputs_hash`=jobId+featureKeys+targetPaths+appliedValues canonical JSON(previousValue 미포함). `applied_revision`=apply 후 revision.
  - **audit**: handler 내 `writeAuditLog()` — target=patient, extra:{jobId,clipId,appliedInputsCount}.
- 클라 폴링 서비스 `videoAnalysisClient.js`(3-way 형제).
- **rollback 경계**: M1은 로컬 rollback만, 서버 apply rollback은 M3.
- **테스트**: 서버(상태전이·guard 403/404·If-Match 400/409·멱등성·denormalize 무결성·audit·flag off 404) / 클라(non-synced 차단·sync revision 갱신).

**M1 완료 기준**: 플래그 on → 공정 추가 → 서버 mock job 폴링 review_pending → apply(If-Match)로 모듈 값 반영 + appliedInputs + audit, 로컬 rollback 복원, 비담당 403/404. 플래그 off → 기존 앱 100% 동일.

---

## M2~M4 (개요)

- **M2** 6.0-3.5 검증 하네스(annotation 스키마+오차 계산기) / 6.0-5 ONNX CPU PoC(백엔드 교체 어댑터, 성능목표: 720p sampling fps·1분 처리시간·동시1건·취소/만료/재시도) / 6.0-6 feature 계산기+OneEuro+tracking(§8.7)+시점 융합(§8.6.1).
- **M3** 6.0-7 multipart 업로드(requestMultipart 계층·multer·디스크 스트리밍·TTL·cleanup·Caddy/Express 상향, tus 후속) / 6.0-B2 검증셋(층화: 시점·가림·다수·작업복·카메라높이·작업유형 + inter-rater) → 임계값 결정 / 6.0-8 저위험 모듈 자동제안 on + skeleton overlay 검수.
- **M4** 6.0-9 에어갭 Docker(ONNX/OpenVINO CPU, docker save/load, --network none, recipe versioning, WSL2 메모리 vs 네이티브 결정, 동시1건) / 6.0-10(선택) hand 모델 손목 SI(IE 수기).

---

## Verification

**각 PR 공통**: `npm run build:web`(win7 호환), 클라 `npm run dev` 수동, 서버 `cd server && npm test`, 계약 `__tests__`. 하위호환 회귀(videoAnalysis 없는 파일 로드 → 보강 + 기존 무파손, 플래그 off 동작 변화 0).

**M1 e2e(플래그 on, mock)**: 환자 생성 → 저장·동기화(synced) → 영상 분석 스텝 → 공정/클립/시점/% → mock 분석 → 폴링 review_pending(+audit) → apply(If-Match)로 값 반영+appliedInputs+sync revision 갱신(재전송 idempotent) → 로컬 rollback → 비담당 403/404·non-synced 차단.

**M2 이후**: 6.0-B2 검증셋 오차가 §8.9 허용오차(각도 ±10~15°, 시간 ±20%, 반복 ±15~20%) + inter-rater 기준 충족 시 임계값·운영 플래그 on.
