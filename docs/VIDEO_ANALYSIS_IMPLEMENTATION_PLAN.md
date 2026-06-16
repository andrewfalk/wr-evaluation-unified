# 작업 영상 인간공학 분석 (RTMPose) — v6.0.0 구현 플랜

> 원천: `PRD_video_analysis_addition.md` §8. 계획 확정: 2026-06-15 (Codex 리뷰 6회 반영).
> 이 문서는 **살아있는 진행 추적 문서**다 — 각 PR/파트 완료 시 아래 체크리스트를 갱신한다.

## 📊 구현 진행 현황

범례: `[x]` 완료 · `[~]` 진행 중 · `[ ]` 대기

### M1 — mock 세로조각 (6.0-0 ~ 6.0-4)
- [x] **PR1 (6.0-0)** feature 계약 + SharedDataSchema 확장 — PR #11 ✅ 머지
- [x] **PR2 (6.0-1)** videoAnalysis 데이터 모델 + `ensureSharedDefaults()` 마이그레이션 — PR #12 ✅ 머지
- [x] **PR3 (6.0-2)** mock 생성기 + 집계 + `videoMappingConfig` + provenance/rollback — PR #13 ✅ 머지
  - [x] `videoMock.js` — `generateMockFeatures(requestedFeatures, profile)`
  - [x] `videoAggregate.js` — 공정→직업 집계(누적=가중합, 피크=max, 빈도=가중평균)
  - [x] `videoProvenance.js` — `applyFeatureToModule()` + rollback + `videoMapping.js` 헬퍼
  - [x] `moduleRegistry` JSDoc + `getModulesWithVideoMapping()` + shape 매니페스트 테스트
  - [x] knee/shoulder/spine/cervical `videoMappingConfig` 선언(모듈별 타입 코어싱)
  - [x] vitest.config `@contracts` alias(소스) + 테스트 20건 (531 passed)
- [x] **PR4 (6.0-3)** 피처플래그 5곳 배선 + 로컬 mock UI — PR #14 ✅ 머지
- [x] **PR5 (6.0-4 백본)** clip/job DB + 서버 job API + apply endpoint + audit — PR #15 ✅ 머지
- [x] **PR5.1 (6.0-4 UI)** VideoAnalysisStep ↔ 서버 apply 연결 — **M1 완료**
  - [x] `videoServerApply.js` 오케스트레이터(createClip→createJob→apply) + `computeAppliedInputsHash`
  - [x] VideoAnalysisStep 서버/로컬/차단 분기(`resolveApplyMode`) + synced 게이팅 + busy/error
  - [x] App `onVideoServerApplied`(서버 동기화 환자 목록 반영) → StepContent → 컴포넌트 배선
  - [x] 서버 모드 rollback 미노출 + job review_pending 방어 + processId null 명시(Codex)
  - [x] 테스트(오케스트레이터 5 + resolveApplyMode 3) client 567 / lint errors 0 / build OK
- [x] **PR #17 hotfix** job/clip `processId` nullable + `docker-compose.yml` 플래그 passthrough (라이브 검증서 발견)
- [x] **M1 라이브 검증 완료** (dev docker + 실 Postgres): 0016 마이그레이션 적용, `/api/config/public` 플래그, flag on/off 라우트 401/404, UI에서 clip→job(`done`)→apply, `video_analysis_submit/apply` audit, 환자 payload `appliedInputs` 영속화(knee `squatting="126"` 문자열 coercion·`previousValue` 보존·3공정 집계) 확인

### M2 — 실제 추론 PoC (6.0-3.5, 6.0-5, 6.0-6) — 상세계획 확정(Codex 반영)
- [x] **PR A (6.0-3.5)** 검증 하네스 — annotation 계약(+segments/events) + 오차 계산기 — PR #19 ✅ 머지
- [x] **PR B (6.0-5)** 단일클립 RTMPose(YOLOX+RTMPose-s) ONNX CPU PoC — PR #20 ✅ 머지
  - [x] keypoints 계약 선고정: `schema/keypoints.schema.json`(canonical) + `shared/contracts/poseKeypoints.ts`(zod, coco17 17점 superRefine)
  - [x] `services/pose-inference/`(rtmlib): `infer_clip.py`(클립→keypoints.json) + `validate_keypoints.py`(jsonschema) + `models/manifest.json` + requirements/README
  - [x] privacy guard `.gitignore`(영상·산출·가중치 제외, synthetic fixture만) + synthetic `fixtures/keypoints.sample.json`
  - [x] Node drift 테스트 8건(fixture↔zod, 17점/[x,y,score]/bbox/**strict extra field**/score 0..1 강제). 실 Python 출력·fixture **둘 다 canonical schema VALID**(drift 없음)
  - [x] Codex 반영: sampledFps=실제값(orig/step)+requestedFps 분리, modelVersion 동적(importlib), zod `.strict()`(additionalProperties:false 정합), score [0,1] clamp(SimCC>1 대응)
  - [x] PoC 실측: 768×432, 2fps, ~28ms/frame(CPU). 전체 601 / lint errors 0 / build·tsc·server build OK
  - 참고: 실 영상·산출은 비커밋(privacy). 실제 추론 위치/큐 결선·tracking은 PR D.
- [x] **PR C (6.0-6a)** feature 계산기 — keypoints→**intrinsic clipFeatures**(자세시간 비율·각도) — PR #21 ✅ 머지
  - [x] `clipFeatures` 계약: `schema/clip_features.schema.json`(canonical) + `shared/contracts/clipFeatures.ts`(zod, .strict, discriminatedUnion)
  - [x] `feature_config.json`(버전관리: 각도 COCO17 인덱스·임계값 squat<90°/neck>20°/overhead OR·OneEuro·minConf·frameDrop) + `oneeuro.py` + `feature_calc.py`
  - [x] squatDuration(무릎각<90°)·overheadHours(손목>어깨 OR 상완거상≥90°)·neckFlexion>20°·trunkPostureG(peak각 candidate). 반복(cyclesPerMinute)은 후속.
  - [x] Node 테스트 8건(fixture↔zod·strict·confidence·segment·featureKey·**posture_ratio 0..1** + feature_config↔contract 교차검증) / Python 골든 test_feature_calc.py
  - [x] Codex 반영: canonical schema featureKey **propertyNames enum**(typo 차단), zod **posture_ratio 0..1 superRefine**, validate_keypoints.py **clip_features post-check**(ratio 0..1·segment 순서) — 3중 방어
  - [x] 실 keypoints→clip_features schema VALID, bad 케이스(typo/ratio>1/역순seg) 모두 차단. 전체 609 / lint errors 0 / build·tsc·server build OK. *per-day 환산은 PR D1.*
- [x] **PR D1 (6.0-6b)** 서버 job 워커(queued→processing→review_pending, FOR UPDATE SKIP LOCKED 단일 트랜잭션 claim) + `GET /jobs/:id` 폴링 실동작(fixture clip 입력) + **clipFeatures→per-day 환산은 클라이언트**(process.activeMinutesPerDay) — PR #22 ✅ 머지
  - [x] **설계 결정**: ① 환산=클라(서버는 intrinsic `ClipFeatureSet`만 `result_features`에 저장, 마이그레이션 불필요) ② `VideoProcessSchema.activeMinutesPerDay`(nullable, null=모름→적용불가, 0=정상) ③ fixture는 `VIDEO_ANALYSIS_FIXTURE_MODE`+allowlist(`resolveFixtureClip`, traversal/심볼릭/확장자 차단), 경로는 `clips.upload_path` 재사용
  - [x] **분석 실행 vs 적용 분리**(Codex): `runAnalysis`(공정별 createClip→createJob(fixture,queued)→pollJob→환산)만 추론, `applySuggestion`은 fixtureClipName 없는 셸 job으로 persist만(추론 미재실행)
  - [x] **provenance·수명주기**(Codex): `AppliedInput.analysisJobIds`+apply audit `sourceAnalysisJobIds`, 적용 시 원본 분석 job을 done(consumed) 전이, TTL sweep은 queued/processing만
  - [x] **per-day 정합(Codex 2차)**: 서버 절대 per-day는 job 집계 시 share 재가중 없이 합산(`buildJobFeatures absolutePerDay`), 변환은 활성모듈 requested로 필터(고정 feature set 정리)
  - [x] **sourceAnalysisJobIds 방어(Codex 3차)**: 적용 셸 job·실패/만료·결과없는 job 차단 — `result_features IS NOT NULL` + `process_id IS NOT NULL` + `status IN(review_pending,done)` + `id<>현재 셸 job`. 위조/셸 job → 400 INVALID_SOURCE_JOB
  - [x] 테스트: 서버 403(워커 claim/SKIP LOCKED·중복방지·error·fixture traversal·apply consumed·INVALID_SOURCE_JOB·셸 job 거부) / 클라 632(환산 null≠0·필터·pollJob·run 오케스트레이션·provenance·absolutePerDay 합산). lint 0 / build·tsc·server build OK. *실영상 e2e는 로컬 venv(비커밋).*
- [ ] **PR D2 (6.0-6b)** 대상자 선택/tracking(§8.7) 실제화
- [ ] **PR D3 (6.0-6b)** 품질검사 + 시점 융합(§8.6.1) + confidence(§8.8)

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
워크플로를 입힌다. M1·M2를 파일·함수/PR 경계 수준으로 상세화, M3~M4는 개요로 둔다(착수 직전 상세화).

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

### PR 1 — 6.0-0: feature 계약 + SharedDataSchema 확장 ✅ 머지 (PR #11)
**산출물**: `shared/contracts/videoAnalysis.ts` + `index.ts` 재export + `patient.ts` SharedDataSchema 확장.
- `VideoFeatureValue = discriminatedUnion('kind', [Numeric|Boolean|Categorical|Candidate])`.
- candidate 불변식(`autoSuggestAllowed:false`/`requiresManualReview:true`)을 `z.literal`로 스키마 강제.
- `FeatureKey`/`FeatureUnit` enum, `VideoFeatureMap`, `AnalysisProfile`, `VideoJobStatus`(§8.5), `Confidence`(§8.8), `AppliedInput`/`CandidateFeatureEntry`/`VideoAnalysisData`(§8.11).
- `VIDEO_FEATURE_TARGETS`: featureKey→targetPath→unit 테이블(§8.10.2-1).
- `SharedDataSchema`에 `videoAnalysis` optional 추가(구파일 호환).

### PR 2 — 6.0-1: 데이터 모델 + `ensureSharedDefaults()` 마이그레이션 ✅ 머지 (PR #12)
- `createVideoAnalysisData()` 신설(§8.11) — schema default와 shape 일치(drift 테스트).
- `createSharedData()`에 `videoAnalysis` 추가.
- `ensureSharedDefaults()` — `migratePatient` 말미 항상 호출, 빈/부분 객체도 merge 보강.
- `createSamplePatient()`에 샘플 videoAnalysis.

### PR 3 — 6.0-2: mock 생성기 + 집계 + 매핑 + provenance/rollback ✅ 머지 (PR #13)
- `src/core/services/videoMock.js`: `generateMockFeatures(requestedFeatures, profile)` → `VideoFeatureMap`.
- `src/core/services/videoAggregate.js`(§8.6.2): 공정→직업(누적=가중합, 피크=max, 빈도=가중평균). spine/cervical은 공정≈task 1:1 단축.
- **`videoMappingConfig`(§8.10.1)** registerModule 신규 선택 키:
  - `moduleRegistry.js`에 키 통과 + shape JSDoc + 매니페스트 shape 테스트. 미선언 모듈은 자동입력 제외(하위호환, §8.15) + "지원/미지원 모듈" 표기.
  - knee/shoulder/spine/cervical `index.js`에 `videoMappingConfig` 선언, 모듈별 코어싱(knee/shoulder/cervical=`String`, spine=number).
  - candidate(`suspectedKneeTwist`·`vibrationToolUseDurationCandidate`·`trunkPostureG`·`neckCombinedFlexRot`)는 모듈 필드 미기입 → `candidateFeatures[]`에만.
- **provenance(§8.11)** `src/core/services/videoProvenance.js`: `applyFeatureToModule()`(원자값 기입 + `appliedInputs[]` 기록), rollback 헬퍼.
- **환자 revision 충돌 정책**: 적용은 환자 객체를 변경 → dirty 표시 + 기존 PatientSync 충돌 처리 재사용(서버 반영은 PR5).
- **테스트**: mock→매핑→적용→appliedInputs→rollback, 모듈별 코어싱.

### PR 4 — 6.0-3: 피처플래그 배선 + 로컬 mock UI ✅ 머지 (PR #14)
- 플래그 5곳 일관 배선(env / ServerPublicConfigSchema / `/api/config/public` / `FAIL_CLOSED_CONFIG` / mock 서버).
- 클라: `serverConfig.videoAnalysisEnabled` 소비. `buildSteps(activeModules, opts)` 시그니처 확장(App.jsx, useIntakeWizard.js, 기존 테스트 동반).
- 플래그 on일 때만 공유 스텝 `[공유] 영상 분석`(modules 뒤) + `StepContent.jsx` 라우팅 → `VideoAnalysisStep.jsx`.
- 로컬 mock UI 한정: 공정 추가 → 클립/시점/시간점유율(%)/profile → 로컬 `generateMockFeatures` → 제안 검토(confidence/warning, 저신뢰 "참고만") → 적용·무시.
- win7 호환(최신 JS 메서드 금지). config 테스트 갱신.

### PR 5 — 6.0-4: clip/job DB + 서버 mock 폴링 + apply endpoint + audit ✅ 백본 머지 (PR #15)
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
- 클라 서비스 `videoAnalysisClient.js`(intranet 전용, electron/web stub) + `requireSyncedServerId`(synced 강제).
- **rollback 경계**: M1은 로컬 rollback만, 서버 apply rollback은 M3.
- **테스트**: 서버(flag off 404·guard 403/404·If-Match 400/409·멱등성·denormalize 무결성·audit) / 클라(non-synced dirty·conflict·local-only 차단).

### PR 5.1 — 6.0-4 UI: VideoAnalysisStep ↔ 서버 apply 연결 ✅ 머지 (PR #16)
- `videoServerApply.js` 오케스트레이터: `createClip→createJob(review_pending 방어)→applyFeatureToModule(로컬 data 계산)→applyVideoAnalysisJob`(If-Match 영속화). `computeAppliedInputsHash`(previousValue 제외). 순환 import 회피용 별도 모듈.
- `resolveApplyMode(serverSupported, isSynced)` → `server`/`blocked`/`local`. 인트라넷+synced=서버 적용(per-field, apply마다 job), 인트라넷+미동기=차단+안내, 그 외=로컬.
- `App.onVideoServerApplied` → 서버 동기화 환자를 로컬 id로 목록 교체(StepContent 경유 배선, `settings` 전달).
- **서버 모드 rollback 미노출**(로컬/서버 갈라짐 방지, 되돌리기는 모듈 탭 직접 수정). job-scope라 `process_id`는 의도적 null(공정 추적은 `appliedInputs.processIds`).
- **테스트**: 오케스트레이터(순서·hash·JOB_NOT_READY·synced 전파) + `resolveApplyMode`.

**M1 완료 기준**: 플래그 on → 공정 추가 → (인트라넷+synced) 서버 적용(clip→job→apply, If-Match)으로 모듈 값 반영 + appliedInputs + audit + 목록 동기화 / (로컬) updatePatient 적용·rollback. 비담당 403/404, 미동기 차단. 플래그 off → 기존 앱 100% 동일.

---

## M2 — 실제 추론 PoC (상세)

mock feature를 **실제 RTMPose 추론**으로 교체한다. M1 계약(`VideoFeatureValue`/`VIDEO_FEATURE_TARGETS`)은 그대로 유지하므로 소비측(매핑·provenance·UI)은 무변경 — 생성원만 mock→실제로 바뀐다.

### 아키텍처 결정 — 추론 위치 전환 (가장 중요)
- **M1**: `generateMockFeatures`가 **클라이언트**에서 동작(mock). **M2**: 실제 추론은 PRD §8.2에 따라 **인트라넷 서버 측**에서 수행한다.
- **추론 스택은 Python**(RTMDet+RTMPose ONNX). 이유: RTMPose/MMPose 생태계가 Python 중심, `onnxruntime-node` 네이티브는 클라(Win7) 제약이 있으나 **서버(Linux 컨테이너/Win10)** 에선 Python+onnxruntime+opencv가 표준. → 신규 **`services/pose-inference/`**(Python) 도입.
- **Node 서버 ↔ 추론 서비스 연동**: 공유 볼륨 + 비동기 큐(§8.6) 또는 localhost HTTP. **M2 PoC 단계에선 결합을 최소화**(독립 스크립트→fixture)하고, 실제 큐/HTTP 결선은 PR D에서. 에어갭 패키징(docker save/load)은 **M4(6.0-9)**.
- **백엔드 교체 어댑터(§8.14)**: CPU(ONNX/OpenVINO) 기본, GPU는 후순위 — 추론 호출부를 어댑터로 추상화해 교체 가능하게.
- **mock은 폐기하지 않음**: 계약이 동일하므로 mock 생성기·fixture는 테스트/오프라인 폴백으로 유지(클라 standalone/web은 계속 mock 또는 미지원).

### keypoints 계약 — PR B 착수 전 선고정 (Codex)
PR B 산출물이 C/D의 입력이므로 **PR B 코드 전에 `keypoints.json` 스키마를 먼저 박는다**(흔들림 방지). 위치: `services/pose-inference/schema/keypoints.schema.json` + `shared/contracts/poseKeypoints.ts`(zod, 클라/노드 소비용). 필수 필드:
- `keypointConvention`: `'coco17' | 'wholebody133'`(M2는 coco17, 손목 SI용 wholebody는 6.0-10)
- `coordinateSpace`: `'pixel' | 'normalized'` + `frameWidth`/`frameHeight`
- 프레임별: `frameIndex`, `timestampMs`, `sampledFps`
- 사람별: `bbox[x,y,w,h]`, `personId`/`trackId`, `keypoints[[x,y,score]...]`, per-keypoint `visibility`
- 재현성: `modelName`/`modelVersion`, `inputSize`, `preprocessConfigHash`

**drift 방지(Codex)**: `keypoints.schema.json`을 **single source of truth**로 삼고 `poseKeypoints.ts`(zod)는 그로부터 파생/정합되게 한다. **PR B/C에 "Python 산출 keypoints.json을 JSON Schema(또는 zod)로 검증하는 테스트"** 를 포함 — Python 출력과 TS 계약이 어긋나면 테스트가 깨지도록.

### 모델 manifest — 재현성·에어갭·법적 방어가능성 (Codex)
`services/pose-inference/models/manifest.json`: 모델별 `fileName`, `sourceUrl`, `sha256`, `inputSize`, `opset`, `preprocessing`(resize/normalize/letterbox), `postprocessing`(SimCC 등). 가중치 자체는 커밋 금지(.gitignore), manifest만 버전관리 → 에어갭 반입(M4)·재현성(§8.11)의 근거.

### privacy guard — PR B부터 적용 (Codex)
실제 영상·keypoints는 민감정보. `services/pose-inference/.gitignore`로 영상/가중치/실 keypoints 제외. **테스트 fixture는 synthetic(합성 좌표) 또는 공개 샘플 기반만** 허용 — 실 작업조사 영상·실 환자 keypoints는 저장소 반입 금지(§8.13).

### PR A — 6.0-3.5: 검증 하네스 (의존성 0, 추론과 독립 → 먼저) ✅ 머지 (PR #19)
- **`shared/contracts/videoAnnotation.ts`**(신규): `GoldStandardAnnotation`(FeatureKey-keyed gold 값 + 층화 메타 §8.9: viewpoint/occlusion/multiplePeople/clothing/cameraHeight/workType), `AnnotationValue`(numeric/boolean/categorical discriminatedUnion, confidence 없음), `AnnotationSet`.
  - **segments/events 추가(Codex)**: feature별 최종값뿐 아니라 선택적 `segments`(예: 쪼그림 start/end, overhead 구간, 반복 cycle 구간 `[{featureKey, startMs, endMs}]`). duration/repetition 오차가 "어느 구간에서 틀렸는지" 추적 가능.
  - `index.ts` 재export.
- **`src/core/services/videoValidation.js`**(신규, 순수 함수): `metricKind(unit)`(degrees→angle / *_per_day·seconds_per_cycle→time / cycles_*→count / ratio), `numericError(extracted, gold)`→{absError, errorRate}, `compareFeatureMap(featureMap, annotationFeatures)`, `summarizeErrors(comparisons)`→featureKey별 {n, mae, meanErrorRate, agreement}, `binaryMetrics(pairs)`→sensitivity/specificity(위험 역치 초과), `EXAMPLE_TOLERANCES`(§8.9 placeholder: 각도 ±12.5°, 시간 ±20%, 반복 ±17.5% — **실값은 6.0-B2**), `withinTolerance(summary)`.
- **테스트**: 스키마 parse·discriminatedUnion, 오차 계산, **mock↔annotation 비교**(예: mock overheadHours 1.8 vs gold 2.0 → absError 0.2/errorRate 0.1/time), summarize·binaryMetrics·tolerance.
- **산출물**: annotation 포맷 + 오차 계산기 → 6.0-B2(실 검증셋, M3)의 토대. 런타임 영향 0.

### PR B — 6.0-5: 단일 클립 RTMDet+RTMPose ONNX CPU PoC ✅ 머지 (PR #20)
- **선행**: 위 keypoints 계약 + 모델 manifest + privacy guard 먼저 확정.
- **목표**: 클립 1개 → `keypoints.json`(계약 준수)을 **CPU·오프라인**으로 산출. 앱/서버 결선 없음(독립 검증).
- **`services/pose-inference/`**(신규, Python): 입력 클립 경로 → (opencv/ffmpeg 프레임 샘플, profile별 fps) → RTMDet 사람탐지 → RTMPose 추정(SimCC 후처리) → keypoints.json. **백엔드 어댑터**(CPU now). `requirements.txt`.
- **환경 준비(코드 외)**: Python 3.x, onnxruntime(CPU), opencv-python-headless, **모델 가중치**(manifest 기준, 오프라인 반입은 M4). dev에선 1회 다운로드.
- **PR 범위**: `services/pose-inference/` + docs만. **앱 런타임 무변경**. 의존성 디렉터리 격리.
- **검증(육안 이상으로, Codex)**: synthetic/공개 샘플 fixture로 회귀 가능한 단위 검사 — keypoint 수(=17), score 범위(0~1), bbox 안 좌표 비율, 누락 프레임 비율, 처리시간 로그. 골든 출력 일부를 fixture로 고정.
- **CI 전략(Codex)**: 모델 가중치/ONNX 런타임은 일반 CI에서 매번 받지 않는다. **스키마·계약 검증·feature 계산 테스트는 CI(상시), 실제 ONNX inference smoke는 `RUN_POSE_INFERENCE_TESTS=1` opt-in/수동**으로 분리(가중치 없으면 skip).

### PR C — 6.0-6a: feature 계산기 (keypoints → intrinsic clipFeatures)
- **중요 — intrinsic vs per-day 분리**: 영상이 측정 가능한 건 **클립 구간의 비율·각도·빈도**(intrinsic)뿐. `hours_per_day`/`minutes_per_day`/`cyclesPerDay` 같은 **하루치 환산은 공정 활동시간(수기)** 이 필요(PRD §8.10.2-1: `cyclesPerDay = cyclesPerMinute × 공정활동분/일`). 따라서 PR C는 **intrinsic `clipFeatures`** 만 산출하고, per-day `VideoFeatureMap` 환산은 **PR D1**(공정시간 결합)에서.
- **입력/출력**: keypoints 계약 JSON → `clipFeatures` 계약(`shared/contracts/clipFeatures.ts` + `services/pose-inference/schema/clip_features.schema.json`). featureKey별 `{ kind:numeric|boolean|categorical, metric:posture_ratio|peak_angle|mean_angle|cycles_per_minute|seconds_per_cycle, value, unit, confidence, segments[], warnings }`.
- **PR C 범위(PRD §8.16 "자세시간 먼저")**: 자세시간/각도 — **squatDuration**(무릎각<90° posture_ratio), **overheadHours**(손목>어깨 OR 상완거상각≥90° posture_ratio), **neckFlexionOver20HoursPerDay**(목 굴곡>20° posture_ratio), **trunkPostureG**(체간 전굴 peak/mean angle, candidate). **반복(cyclesPerMinute/cycleSeconds)은 별도 알고리즘 → PR C2/후속.**
- **계산 규칙 config 버전관리(Codex)** — `feature_config.json`(version 포함): 각도 정의(COCO17 3-keypoint 인덱스), threshold(무릎<90°·목>20°·overhead OR 임계·최소 연속지속초), OneEuro(profile별 mincutoff/beta), minConfidence(가림 판정), frame-drop 시간보정.
- **fixture 기반**: 합성 keypoints fixture(알려진 기하)로 단위 테스트(각도/비율 계산 검증). Node: clipFeatures fixture ↔ zod + config featureKey ⊆ FeatureKey 교차검증. 실 keypoints → clip_features → schema VALID.
- **검증**: intrinsic 값을 PR A 오차 계산기로 비교(정식 검증은 6.0-B2; 누락/불일치 count 별도 집계 정책 유지).

### PR D1 — 6.0-6b: 서버 job 워커 + 폴링 실동작
- **업로드 전 입력 경로 명확화(Codex)**: M3 전까지 multipart 업로드가 없으므로, **dev-only fixture clip 경로를 job에 연결**. 즉 M2-D는 "**fixture 기반 worker job**"으로 한정 — 실제 업로드는 M3(6.0-7).
- **fixture 경로 보안 가드(Codex)**: `VIDEO_ANALYSIS_FIXTURE_MODE=true` **dev-only 플래그**(production 기본 비활성)일 때만 fixture 경로 허용 + **allowlist 디렉터리 내부로 제한** + 경로 정규화 후 allowlist escape(상대경로/`..`/심볼릭) 차단 → path traversal·임의 파일 접근 방지.
- **단일 인물 한정(Codex)**: D1은 **single-person fixture만 지원**(tracking이 D2이므로). 다중 인물·`targetPersonId` 안정화는 D2.
- 추론 서비스를 PR5 job 파이프라인에 연결: `POST /jobs` 큐 투입 → status `queued→processing→review_pending`(실제 비동기), **`GET /jobs/:id` 폴링 실동작**(PR5.1에서 미룬 부분), `result_features` 저장. 동시추론 1건 순차 큐 + 취소/만료(TTL)/재시도(§8.14).
- **clipFeatures → per-day VideoFeatureMap 환산(PR C에서 이관)**: PR C의 intrinsic `clipFeatures`(비율·빈도)를 공정 활동시간(수기 process 정보)과 결합해 per-day `VideoFeatureMap`(hours_per_day·minutes_per_day·cyclesPerDay)으로 환산. 이 환산 규칙도 버전관리(`videoMappingConfig`/feature config와 정합).
- **mock→real 전환점 명확화(Codex)**: `GET /jobs/:id`의 `result_features`를 VideoAnalysisStep의 `processFeatures`/`jobFeatures`/`candidateFeatures`에 반영하고, **서버 결과가 있으면 로컬 `generateMockFeatures`를 우회**한다(서버 모드). 로컬 모드(standalone/web)는 계속 mock. 이 지점이 실제 mock→real 교체 경계.

### PR D2 — 6.0-6b: 대상자 선택/tracking 실제화 (§8.7)
- 샘플 프레임 person box 후보 → 사용자 선택(targetPersonId, PR5 `sample-detect`/`select-target` 셸 실제화) → track ID 추적, track-loss 구간 저신뢰 처리.

### PR D3 — 6.0-6b: 품질검사 + 시점 융합 + confidence
- **영상 품질검사**: motion blur·frame drop → `usableFrameRatio`.
- **시점 융합(§8.6.1)**: sagittal/frontal 평면별 각도 채택, `INTER_VIEW_CONFLICT` 경고.
- **confidence 산출(§8.8)**: keypoint/visibility/tracking/viewpoint/usableFrameRatio → overall.
- **검증**: 샘플 클립 e2e(업로드 전 단계는 M3) → review_pending → 제안 → 적용. 오차는 6.0-B2 정식 판정.

> **M2 PR 경계 요약**: (선고정) keypoints 계약+모델 manifest+privacy guard → A(검증 하네스·순수) → B(Python 추론 PoC·격리) → C(feature 계산·fixture·config) → D1(서버 job 워커·폴링·fixture 입력) → D2(tracking) → D3(품질·융합·confidence). A는 즉시 착수, B는 환경(Python·가중치) 선행.

---

## M3~M4 (개요)

- **M3** 6.0-7 multipart 업로드(requestMultipart 계층·multer·디스크 스트리밍·TTL·cleanup·Caddy/Express 상향, tus 후속) / 6.0-B2 검증셋(층화: 시점·가림·다수·작업복·카메라높이·작업유형 + inter-rater) → 변수별 임계값 결정 / 6.0-8 저위험 모듈 자동제안 on + skeleton overlay 검수.
- **M4** 6.0-9 에어갭 Docker(ONNX/OpenVINO CPU, docker save/load, --network none, recipe versioning, WSL2 메모리 vs 네이티브 결정, 동시1건) / 6.0-10(선택) hand 모델 손목 SI(IE 수기).

---

## Verification

**각 PR 공통**: `npm run build:web`(win7 호환), 클라 `npm run dev` 수동, 서버 `cd server && npm test`, 계약 `__tests__`. 하위호환 회귀(videoAnalysis 없는 파일 로드 → 보강 + 기존 무파손, 플래그 off 동작 변화 0).

**M1 e2e(플래그 on, mock)**: 환자 생성 → 저장·동기화(synced) → 영상 분석 스텝 → 공정/클립/시점/% → mock 분석 → 폴링 review_pending(+audit) → apply(If-Match)로 값 반영+appliedInputs+sync revision 갱신(재전송 idempotent) → 로컬 rollback → 비담당 403/404·non-synced 차단.

**M2 이후**: 6.0-B2 검증셋 오차가 §8.9 허용오차(각도 ±10~15°, 시간 ±20%, 반복 ±15~20%) + inter-rater 기준 충족 시 임계값·운영 플래그 on.
