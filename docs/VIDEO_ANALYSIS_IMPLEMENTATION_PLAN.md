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
- [x] **PR D2a (6.0-6b)** 다중 인물 트래킹 코어(§8.7) — PR #25 ✅ 머지
  - [x] **결정적 IoU 트래커**(`tracker.py`, 순수 파이썬·무상태·결정적 → synthetic fixture 단위테스트) — rtmlib PoseTracker 대신
  - [x] `infer_clip.py` 프레임별 trackId 부여(트래커 파라미터를 preprocessConfigHash에 포함, 재현성)
  - [x] `feature_calc.py` **대상 track 기준 산출** — `--target-track`(D2b 워커 주입) 또는 dominant-track 휴리스틱(최다 등장→면적→score→id), 트랙 없으면 `pick_person` 폴백(하위호환). track-loss → presenceRatio + `TARGET_TRACK_LOST` 경고
  - [x] 계약: clip_features `tracking{targetTrackId,presenceRatio,trackCount}`(optional, PR C 하위호환) — `clipFeatures.ts`+canonical schema+`validate_keypoints.py` presenceRatio 0..1
  - [x] 테스트: Python 골든(트래커 안정/결정/은퇴·dominant·track-loss·폴백) + Node 계약(tracking VALID·presenceRatio 범위·strict·하위호환). smoke 재실행 PASS(tracking 블록 산출). 클라 635/서버 403, lint 0, build·tsc·server build OK. **서버/워커/UI 무변경**
- [x] **PR D2b (6.0-6b)** 대상자 선택 UI(§8.7) — PR #27 ✅ 머지
  - [x] `sample_detect.py`(대표 프레임 detector-only, 사람 많은 프레임 스캔, 후보 id 결정적 정렬) + `SampleDetectResultSchema`(zod, 신뢰 경계)
  - [x] 서버: createClip fixture 이관(upload_path), createJob 큐=clip.upload_path 일원화, **sample-detect=fixture 전용**(async execFile, off→409), select-target 강화(선행 detect 409·위조 id 400)
  - [x] 워커 box→track: `runInference(targetSelection)` 내부에서 infer_clip→keypoints→**`iouXywh` 시간/IoU 허용 내 매핑**→`--target-track`. **선택+매핑 실패=job error `TARGET_TRACK_MAP_FAILED`(dominant 금지), track-loss=경고만**
  - [x] 클라: `TargetPicker`(박스만 중립 SVG, privacy_first) + 2단계(탐지→선택) + detection stale 무효화(validDetection) + serverClipId 재사용
  - [x] tracker 파라미터 단일 source(infer_clip이 feature_config.json.tracking 읽음, hash엔 실제 값)
  - [x] 테스트: Python 골든 + 계약(SampleDetectResult) + 서버(createClip/createJob/sample-detect/select-target) + 워커(iouXywh·mapTargetTrack·MAP_FAILED) + 클라(run detection 재사용·TargetPicker geometry). 클라 642/서버 416, lint 0, build·tsc·server build OK, smoke PASS
  - [x] **Codex 리뷰 반영(3건)**: ① 선택 있는데 `sample_detect_result` null이면 dominant 폴백 금지 → `INVALID_SAMPLE_DETECT` job error("선택=그 사람 or 실패") ② 깨진 sample-detect 출력(JSON/계약 parse 실패)만 태깅 → 라우트 **502 INVALID_SAMPLE_DETECT** 명시 응답(timeout/크래시는 500 유지), select-target 저장값도 500→502 ③ bbox: Python 0 하한 clamp + schema `nonnegative`(퇴화/위조 박스 차단). 회귀 테스트 3건. 클라 643/서버 418, lint 0
- [x] **PR D3 (6.0-6b)** 품질검사 + 시점 융합(§8.6.1) + confidence(§8.8) — 하위 분할 완료(D3a #29·D3b #30 머지)
  - [x] **D3a** confidence 세분화 + 품질검사 — **PR #29 ✅ 머지**
    - [x] 계약 선고정: poseKeypoints `quality{blurMetric{mean,p10,median}·dropRatio·sampledFps + threshold 파생값 optional}` + clipFeatures per-feature `confidenceBreakdown` + ClipFeatureSet `quality`(모두 optional, canonical JSON 미러 + validate post-check)
    - [x] Python: `infer_clip.py`가 blur(Laplacian)·drop 산출 → keypoints.quality / `feature_calc.py` breakdown(visibility=`clamp(1-missingRatio,0,1)`·tracking·`overall=min(존재 성분, usableFrameRatio 제외)`) + quality 복사
    - [x] 게이팅: `videoConfidenceConfig.js`(클라 번들, **기본 비활성**) → `convert`가 `autoSuggestAllowed=false`+base `warnings[]` 사유 → UI "참고만"+버튼 비활성. 실 threshold 6.0-B2
    - [x] **Codex 리뷰 반영(3건)**: dropRatio 실 `CAP_PROP_POS_MSEC` 기반 + 집계 게이트 전파(weighted/or/max any-false→false) + blurThreshold를 preprocessConfigHash에 포함
  - [x] **D3b** 시점 융합(§8.6.1) — **PR #30 ✅ 머지**
    - [x] provenance 배열화: `ProcessFeaturesSchema.analysisJobIds[]` + `resolveAnalysisJobIds` 정규화(빈배열/`[undefined]` 방지), apply·producer 배열 기반
    - [x] `videoViewpointConfig.js`(클라 번들): featureKey별 preferredViewpoint + viewpoint 성분 결정적 매핑(preferred 1.0/known-non-preferred 0.5/other·선호없음 omit) + tier + conflictThreshold 기본 비활성
    - [x] `videoViewpointFusion.js`: featureKey별 1차 tier·2차 viewpoint 보정 overall 채택(other가 preferred 못 이김) + viewpoint breakdown 충전 + NON_PREFERRED_VIEWPOINT 경고 + INTER_VIEW_CONFLICT(임계값 설정 시만) + 단일=passthrough
    - [x] `videoAnalysisRun`: 공정당 클립 `.find`→`.filter` 그룹핑 → 클립별 추론 → 융합 → per-day, analysisJobIds[] 복수, 부분 실패=공정 실패
    - [x] **Codex 리뷰 반영**: ① 서버 `createJob` process_id를 clip source of truth로(body 불일치 400 `PROCESS_MISMATCH`) ② 빈 provenance 거부 — 서버모드 apply가 빈 `analysisJobIds`면 `VideoAnalysisStep` 1차 차단 + `videoServerApply` `EMPTY_PROVENANCE` throw(로컬/mock 예외) ③ 집계 규칙 문서 정리(breakdown은 per-day로 미운반 → job-scope 집계 불필요, autoSuggestAllowed는 weighted=any-false·pick=채택 전파)
    - [x] 테스트: 융합 7 + run 2(다중클립·부분실패) + 계약(analysisJobIds·resolveAnalysisJobIds) + 서버 PROCESS_MISMATCH 2. 클라 671/서버 420, lint 0, build OK
- [x] **PR D 수동 검증 완료** (실영상 e2e — CI는 합성 fixture만)
  - [x] **Tier 1** (`services/pose-inference/smoke_d.ps1`, standalone Python·venv·ONNX): 실영상→keypoints→clip_features. **quality{blurMetric·dropRatio·sampledFps} 존재 / confidenceBreakdown overall=min 불변식(성분별 binding 확인) / tracking trackId·presenceRatio / sample-detect 3인 후보 / `--target-track` 동작** 모두 PASS
  - [x] **Tier 3** (네이티브 intranet 서버+워커+venv + 웹 UI 라이브): 플래그 on→공정/클립(fixture)→sample-detect→TargetPicker 선택→**서버 워커 실추론**(D1 워커→Python, 그동안 mock만 검증되던 경로)→제안/적용 e2e 동작 확인. *값 자체의 타당성은 6.0-B2(실 작업영상+수기검증) 몫 — 본 검증은 "전 구간 실동작" 확인.*

### M3 — 업로드·검증·매핑 (6.0-7, 6.0-B2, 6.0-8) — 상세계획 확정(Codex 리뷰 8회 반영)
> 순서 6.0-7→B2→6.0-8. 보존정책 config 노브(A 완전구현·B 노브만). B2는 일부 영상 파일럿. 상세: 아래 "M3 — 업로드·검증·매핑 (상세)".
- [x] **PR M3-7a (6.0-7 백본)** 보존 config 노브 + 서버 multipart 업로드 — **PR #31 ✅ 머지**
  - [x] `0017_video_analysis_clip_state.sql` — `clips.source_type`(fixture|upload|apply_shell)+`file_state`(none|present|deleted), CHECK+backfill
  - [x] `config.video` — uploadDir(미설정=업로드 비활성)·maxUploadBytes·allowedMimeTypes·retentionPolicy·clipTtlHours / `multer` 추가
  - [x] `POST /clips/:id/upload` — tmp 스트리밍→매직바이트 sniff(ftyp/EBML/RIFF, file-type ESM 회피)→atomic rename→`WHERE source_type='upload' AND file_state='none'` 단일 UPDATE(경쟁 한쪽만)→audit
  - [x] `createClip` purpose(누락 400 MISSING_PURPOSE·조합검증·fixture+fixtureMode off 409) / `createJob`·`sample-detect` 상태 guard(NO_UPLOAD·SOURCE_DELETED_REUPLOAD_REQUIRED·FIXTURE_MODE_OFF) / loadAccessibleClip 컬럼 확장 / uploadDir 미설정 503 UPLOAD_DISABLED
  - [x] 워커 `resolveJobClipPath` source_type 분기(`resolveUploadedClipPath` 신설) + 기동조건 `fixtureMode||uploadDir`
  - [x] 클라 `requestMultipart`(XHR·진행률·win7)+`uploadClip`+VideoAnalysisStep 업로드 UI·`canDetectClip`·파이프라인 / videoAnalysisRun fixture-only 필터 해제 / videoServerApply purpose='apply_shell'
  - [x] 테스트: 서버 440/클라 682 통과, lint 0, web·server build OK (업로드 정상·MIME위조·CLIP_NOT_UPLOAD_TARGET·경쟁 409·guard·resolveUploadedClipPath·requestMultipart/uploadClip/canDetectClip·UPLOAD_DISABLED)
- [x] **PR M3-7b (6.0-7 정리)** keypoints artifact 영속화(`0018`) + TTL·orphan cleanup + 보존 정책 A — **PR #32 ✅ 머지** · **수동 통합 스모크 ✅ 라이브 완료(2026-06-18)**
  - [x] `0018_video_analysis_artifacts.sql` — `jobs.keypoints_path`+`keypoints_sha256`
  - [x] 워커: 추론 성공 시 keypoints 원문을 `uploadDir/artifacts/<jobId>.keypoints.json`로 영속(좌표만, 원본 프레임 없음) + `keypoints_path/sha256` 기록
  - [x] 보존 정책 A(privacy_first): 실 업로드 원본은 추론 직후 unlink + `upload_path=NULL`+`file_state='deleted'`(fixture는 미삭제). keypoints artifact는 clip TTL까지 보존
  - [x] `videoClipCleanup.ts`: TTL 만료 clip 원본+artifact 회수 + orphan(미참조 파일·tmp 1h 잔여물) 회수. `index.ts` 1h 간격 + `npm run cleanup:video` CLI
  - [x] 테스트: 서버 450 통과(artifact 영속·보존A·fixture 미삭제·cleanup TTL/artifact/orphan/tmp-grace), lint(내 코드) 0, build OK
- [~] **(B2 선행) 영상 분석 근거 패널 + 파이프라인 진행바** — 파일럿 검증 관찰 UX. "왜 이 값?"(산출식·집계방식·confidence breakdown·사용 클립/시점·근거 시점·warnings·source jobIds) 펼침 + coarse 진행바(`클립 준비→대상자 확인→분석 중→검수대기/제안생성`). **클라 한정, 서버·계약·DB 무변경.** 승인 계획 `purring-wishing-curry.md`. skeleton overlay/`GET /overlay`/close-review는 M3-8 유지. **PR #38 — Tier-3 라이브 수동 검증 ✅(2026-06-18, 에러 없음) · 머지 대기.**
  - [x] 값/evidence **완전 분리**: evidence는 feature 객체에 미부착(영속화 차단) + 2단 keying(`jobEvidenceBySharedJobId`/`processEvidenceByProcessId`) — featureKey 단독 keying은 다직업 충돌
  - [x] `convertClipFeaturesToPerDay` → `evidenceByFeatureKey` 별도 반환(features shape 무변경) / `fuseClipFeatureSetsWithEvidence` wrapper(기존 `fuseClipFeatureSets` 반환 계약 유지, `pickWinner` helper 공유)
  - [x] `runServerAnalysis` → `processEvidence[]`(환산+융합 evidence 병합) / 신규 `buildJobEvidence`(aggregationMethod·contributions, aggregate는 evidence 미접촉)
  - [x] UI transient `analysisEvidence` state(va/shared 저장 안 함) + reset 정책(runAnalysis 시작·`useEffect`(jobFeatures empty)·환자 전환·업로드/탐지/선택 `invalidateDerived`) + evidence 부재 fallback("다시 분석 필요") + experimental 라벨(게이팅 B2 전 비활성)
  - [x] UX 오해방지 보정(Codex 4차): 진행바 재분석 중 `analyzing` 우선(hasAnalysis 덮어쓰기 방지)·환산식 hours/minutes 단위 분기(÷60 표기)·contribution `sharePercent`=실 공정 점유율(집계 가중치 100과 구분, "공정 점유율" 라벨)
  - [x] 테스트: 클라 **703 통과**(evidence 반환·feature 누출 0·fusion provenance·2단 keying·다직업 비충돌·processEvidence·sharePercent·mock 비파손), `build:web`(win7) OK, lint 0(내 코드). Codex 리뷰 4회 반영(feature 미부착·overlay 범위·fuse 계약 유지·2단 keying·reset 정책·집계 설명·진행바 포괄·fallback·단위 분기·sharePercent)
- [ ] **PR M3-B2 (6.0-B2)** 파일럿 검증(오프라인 `validate_set.py`) + `CANDIDATE_CONFIDENCE_THRESHOLDS`(런타임 비활성 유지)
- [ ] **PR M3-8 (6.0-8)** 저위험 모듈 자동제안 명시활성 + skeleton overlay 검수(keypoints artifact 기반) + close-review 엔드포인트
- [x] **(후속 개선) 대상자 선택 대표 프레임 썸네일** — privacy 정책 예외(동의+인트라넷, `VIDEO_ANALYSIS_TARGET_THUMBNAIL` 기본 off). 박스-only로 작업자 식별 곤란 → 게이트 on 시 대표 프레임 위 선택. **PR #36 ✅ 머지 · 라이브 스모크(게이트 on) 검증 완료**
  - [x] `0019`(clips.sample_frame_path) + `sample_detect.py --thumbnail`(target_idx 재독·다운스케일·best-effort) + config 게이트
  - [x] 버전 파일명(`<clipId>.<uuid>.thumb.jpg`)·`resolveSampleFramePath`(전용 검증, 삭제도 경유) + `GET /sample-frame`(게이트 off면 과거 경로 잔존해도 404·no-store·nosniff) + DB-first 옛 파일 회수
  - [x] 수명: select-target/retention A/cleanup 회수(식별 이미지 단명) / 클라 `requestBlob`+`fetchSampleFrame`+`TargetPicker frameUrl`(objectURL 누수 해제)
  - [x] 테스트 서버 465/클라 689 통과, lint 0, build OK (Python cv2 경로는 스모크 검증). Codex 리뷰 6회 반영

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

### PR D3 — 6.0-6b: 품질검사 + 시점 융합(§8.6.1) + confidence 세분화(§8.8)

D3는 **세 관심사 + 구조 변경(공정당 다중 시점 클립)** 이 묶여 D2처럼 **하위 PR로 분할**한다.
임계값 **수치는 추측 금지** — D3는 게이팅 *메커니즘*만 placeholder threshold로 배선하고, **실값은 6.0-B2(M3) 검증으로 확정**(§8.8/§8.9).

#### 코드 그라운딩 (현재 상태 — "코드가 진실", Codex 리뷰 검증 반영)
- **per-feature confidence = 단일 숫자**: `clipFeatures.ts`의 numeric/boolean/categorical 모두 `confidence: z.number().min(0).max(1)` 하나뿐. `feature_calc.py`의 `conf_for(names)` = 대상 keypoint score 평균. **세분 지표(visibility/tracking/viewpoint/usableFrameRatio) 없음.**
- **품질검사 입력 위치 문제(High)**: `feature_calc.py` 입력은 **keypoints.json뿐 — 원본 프레임 픽셀 미접근**. ∴ Laplacian-blur는 feature_calc에서 산출 **불가**. 프레임을 읽는 `infer_clip.py`에서 산출해 **keypoints.json `quality` 메타**로 실어야 함(→ `poseKeypoints` 계약 확장 동반).
- **공정당 클립 1개**: `videoAnalysisRun.js`가 `va.clips.find(c => c.processId === p.id && c.fixtureClipName)`로 **첫 클립만** 사용 → 같은 공정의 sagittal+frontal **다중 시점 융합 불가**(구조 확장 필요).
- **provenance 단일 job(High)**: `ProcessFeaturesSchema.jobId`는 **단일 optional**. apply 시 `AppliedInput.analysisJobIds`(이미 배열)를 **단일 `processFeatures.jobId`에서** 채움. D3b 다중클립 융합 → 원본 job 복수 → **배열화 필요**.
- **게이팅 경로 단절(High)**: per-day `VideoFeatureValue`는 `FeatureBaseSchema.autoSuggestAllowed: z.boolean()`을 **모든 kind가 보유**(candidate만 literal false). 하지만 ① clipFeatures엔 `autoSuggestAllowed` 없음 ② [VideoAnalysisStep.jsx:401] 적용 버튼은 `disabled={busy||applyBlocked}`로 **`s.autoSuggestAllowed` 미확인**(`requiresManualReview`만 배지 표기). → 저신뢰 numeric 제안도 현재는 적용 가능.
- **`reason`은 candidate 전용·base엔 `warnings[]`만(재리뷰 반영)**: `FeatureBaseSchema`(L49)엔 `autoSuggestAllowed`·`requiresManualReview`·`warnings[]`만. `reason: z.string()`은 `CandidateFeatureValueSchema`(L78)에만 존재(required). → numeric/boolean/categorical 저신뢰 제안 **사유는 별도 필드 신설 없이 base `warnings[]`로 표현**(스키마 무변경, candidate-only `reason`과 충돌 회피).
- **`feature_config.json`은 클라 번들 불가(Medium-High)**: 클라 런타임(`videoPerDayConversion.js`)은 feature_config를 **import하지 않고 version 문자열만** provenance로 참조. 실제 fs read는 **계약 테스트(`clipFeatures.test.ts`)뿐**. ∴ 클라가 `feature_config.json.thresholds`를 런타임에 읽을 수 없음 → threshold 정책은 **클라 번들 위치**에 둬야 함. 집계 method는 `videoAggregate.js` AGG 테이블에 `weightedSum/weightedAvg/or/pick/max` 5종 선언.
- **이미 있는 것(재사용)**: `warnings[]`(per-feature) + clip-level `tracking{targetTrackId, presenceRatio, trackCount}`(D2a) + `VideoClipSchema.viewpoint('sagittal'|'frontal'|'other')` + per-feature `segments[]`.

#### PR D3a — confidence 세분화(§8.8) + 영상 품질검사(usableFrameRatio)
- **품질검사 = `infer_clip.py`에서 산출(High #1·#5 반영)**: 프레임 읽기 단계에서 frame별 **motion-blur raw metric**(Laplacian variance) + **frame-drop**을 계산. **frame-drop은 config 고정 step이 아니라 실제 `sampledFps`/timestamp 중앙값 간격 기준**(요청 fps≠실 sampled fps 오판 방지). `keypoints.json`에 `quality{ blurMetric, dropRatio, sampledFps, blurThreshold?, blurRatio?, usableFrameRatio? }` 적재 — **raw metric은 항상**, threshold 파생값(blurRatio/usableFrameRatio)은 threshold 설정 시에만. **`blurMetric` 계약 형태 고정(재리뷰 보완)**: frame별 배열/단일 scalar 아니라 **summary object `{ mean, p10, median }`**(Laplacian variance 분포 요약) — canonical schema·zod 흔들림 방지.
- **blur threshold도 "추정 금지" 정합(재리뷰 반영)**: blur 판정 기준값은 검증 전 추측 금지. D3 기본은 **raw blurMetric만 산출, blurThreshold=null → blurRatio/usableFrameRatio 정책 판정 비활성**(테스트에서만 threshold 주입). D3에서 쓰는 어떤 blur 기준값도 **"실험값이며 자동제안 차단에 미사용"** — usableFrameRatio는 **정보용(breakdown 표시)일 뿐 overall·게이팅 어디에도 입력 아님**(아래 overall 포함범위 참조), 실값/overall 편입/차단 활성화는 6.0-B2.
- **계약 확장(2곳)**: ① `poseKeypoints`(canonical `keypoints.schema.json` + zod + drift 테스트)에 optional `quality`(`blurMetric`·`dropRatio`·`sampledFps` 필수, threshold 파생 `blurRatio`/`usableFrameRatio` optional) 추가. ② `clipFeatures`: per-feature `confidence: number`(=overall) **유지** + **optional `confidenceBreakdown`**(`{ keypoint, visibility, tracking?, viewpoint?, usableFrameRatio? }`) 추가 + `ClipFeatureSet` 최상위 optional `quality`(keypoints에서 복사). 모두 strict 정합(canonical·zod·`validate_keypoints.py` post-check 동시). **하위호환**: 기존 소비측은 scalar `confidence`만 읽으므로 무변경, breakdown 없는 PR C/D2 fixture VALID.
- **`feature_calc.py` 산출(측정만, 정책 없음)**: keypoint(=score 평균, 기존), **visibility = `clamp(1 - missingRatio, 0, 1)`**(대상 관절이 `min_conf` 미달인 프레임 비율 missingRatio → visibleFrameRatio, **0..1, "역수" 아님**, 재리뷰 #1 반영), **tracking**(D2 `presence_ratio` 재사용), **usableFrameRatio**(keypoints `quality`에서 운반, threshold 설정 시에만 존재). `viewpoint` 성분은 D3b에서 채움(없으면 breakdown에서 **omit**). **keypoints `quality` → `ClipFeatureSet.quality`로 복사(보완 반영)**. feature_calc는 **측정 사실 warning만**(기존 `TARGET_TRACK_LOST`·`POSTURE_G_MANUAL` 등) — **threshold 판단/`LOW_CONFIDENCE_*`는 내지 않음**(정책은 클라).
- **overall 공식 + 포함 범위 고정(Medium #4 + 재리뷰 #2 반영)**: `overall = min(존재하는 **포함 성분**)` — 최약 성분 지배(보수적, 안전, 테스트 안정). **포함 성분 = `keypoint, visibility, tracking?, viewpoint?`**. **`usableFrameRatio`는 overall에서 제외(B2 전까지 breakdown 표시·정보용 only)** — blur threshold가 실험값인 동안 experimental 파생값이 gating-관련 scalar(overall→autoSuggestAllowed)에 새지 않게 함(L277 "정보용" 선언과 일관). 누락 성분(tracking/viewpoint 없을 때)은 **1로 보지 않고 min 대상에서 제외**. usableFrameRatio의 overall 편입·가중은 6.0-B2.
- **threshold 정책 = 클라 단일 source(Medium-High #1 반영)**: 신규 **`src/core/services/videoConfidenceConfig.js`**(번들 가능, 버전 포함, `videoMappingConfig`/`videoPerDayConversion`과 동거). feature별 confidence threshold를 **여기 한 곳**에만 둠 — Python feature_config(측정 파라미터: blur threshold·min_conf·각도 인덱스)와 **역할 분리**(중복 source 제거, drift 차단).
- **placeholder는 기본 비활성(Medium-High #2 반영)**: `videoConfidenceConfig` 기본값은 **threshold = null/disabled → 게이팅 없음**(autoSuggestAllowed 기본 true 유지). 메커니즘은 **테스트에서 명시 threshold 주입으로만 검증**. **실제 차단 기본 활성화는 6.0-B2 이후**(검증 전 제안 차단 방지).
- **저신뢰 게이팅 경로(High #2 반영)**: 책임 분리 —
  - `feature_calc`: 측정 breakdown + 구조적 warning만(정책 없음).
  - `convertClipFeaturesToPerDay`: breakdown을 **`videoConfidenceConfig`**(기본 비활성)와 대조 → threshold 설정 시에만 **per-day `VideoFeatureValue.autoSuggestAllowed=false`** + **base `warnings[]`에 사유 코드(`LOW_CONFIDENCE_*`) 추가**(별도 reason 필드 없음 — candidate `reason`과 구분).
  - **UI([VideoAnalysisStep.jsx:401])**: `s.autoSuggestAllowed === false`면 "참고만" 표기 + **적용 버튼 비활성화**.
  - **서버 적용 방어 경계(보완 반영)**: D3는 **클라 게이트만**(autoSuggestAllowed는 클라 config 정책 → 서버 독립 검증 불가). 우회(직접 API 호출) 시 안전망은 **review_pending + 담당의 명시 적용**. 서버측 강제는 threshold config를 서버 공유하는 6.0-B2+로 **명시 연기**.
- **테스트**: Python 골든(합성 frame으로 blur/drop 비율, keypoints quality 메타·sampledFps 기준 drop, quality→clipFeatures 복사), Node 계약(poseKeypoints quality optional·clipFeatures breakdown/quality optional·strict·하위호환), `convertClipFeaturesToPerDay`(**기본=게이팅 없음**, 주입 threshold 미만→autoSuggestAllowed=false), UI(autoSuggestAllowed=false→버튼 disabled).

#### PR D3b — 시점 융합 (§8.6.1, 클립 → 공정)
- **구조 확장**: 공정당 **다중 클립(시점별)** 허용. `videoAnalysisRun.js`를 `processId`별 클립 **그룹핑**(현 `.find` → `.filter`), 각 클립 job 추론 후 공정 레벨 융합.
- **융합 순서 명시(보완 반영)**: **clipFeatures(intrinsic) 단계에서 시점 융합 → 그 다음 per-day 환산**(한 공정의 다중 시점 클립은 동일 `activeMinutesPerDay` 공유 → 융합 후 1회 환산). per-day-후-융합 대비 `confidenceBreakdown` 보존이 깔끔.
- **융합 config = 클라 번들 위치(재리뷰 #1 반영)**: 융합이 클라(`videoAnalysisRun`)에서 도므로 fusion 정책도 **클라 번들 config**(`videoConfidenceConfig.js`와 동거 또는 형제 `videoViewpointConfig.js`)에 둠 — **Python `feature_config.json`에 두지 않음**(threshold와 동일 이유: 클라가 Python 파일 런타임 read 불가). config = **featureKey별 `preferredViewpoint` + `conflictThreshold` 테이블**(측면: 체간전굴·팔꿈치·무릎·목굴곡 / 정면: 어깨외전·체간측굴·목회전). *(각도→관절 인덱스 같은 **측정** 정의는 Python feature_config 유지 — 역할 분리.)* 한 시점만 → 그 값 + 나머지 **누락 표시**. 3D 융합 아님.
- **선택 기준 = viewpoint 보정 overall(보완 반영)**: 같은 featureKey 두 시점 채택은 **raw keypoint confidence가 아니라 `viewpoint` 성분을 반영해 재계산한 `overall` confidence 높은 쪽**. (잘못된 평면에서 keypoint score만 높아 선택되는 상황 차단.)
- **`viewpoint` 성분 고정 매핑 명시(재리뷰 보완)**: threshold 아니라 **결정적 매핑**(임의 수치 금지) — `videoViewpointConfig`에 명시: clip.viewpoint가 featureKey의 `preferredViewpoint`와 **일치=`1.0`**, **불일치(다른 평면)=`0.5`**, **`other`/unknown=omit**(overall min 제외, 맹목 페널티 회피). **단일 시점만**이면 경쟁 없이 **그대로 채택**, non-preferred일 때 `NON_PREFERRED_VIEWPOINT` **warning만**(차단 아님). (1.0/0.5는 평면 적합성 상대비교용 고정값 — 재조정 6.0-B2.)
- **경쟁 시 tier tie-breaker(재리뷰 보완 — `other` omit 허점 차단)**: 다중 시점 경쟁에서 `other`/unknown이 overall min에서 빠져 keypoint 점수만으로 preferred를 이기지 못하게, **선택은 1차 viewpoint tier(`preferred(1.0) > non-preferred(0.5) > other/unknown`), 동일 tier 내 2차 viewpoint 보정 overall**. 즉 **`omit`은 단일 시점일 때만 적용**(overall 페널티 회피용), **경쟁에서 `other`/unknown은 최하위 tier**라 known preferred/non-preferred를 못 이김.
- **`INTER_VIEW_CONFLICT`**: 두 시점 같은 featureKey 값이 `conflictThreshold` 이상 차이 → 경고(§8.8) + 저신뢰. `viewpoint` confidence 성분(읽으려는 각도와 시점 적합성)을 D3a breakdown에 채워 위 overall 재계산에 반영.
- **`conflictThreshold`도 "추정 금지" 정합(재리뷰 #1 반영)**: conflictThreshold도 수치 임계값 → confidence/blur threshold와 동일 정책. **기본 `null`/disabled → INTER_VIEW_CONFLICT 판정 비활성**(테스트에서만 주입), 실제 활성화는 **6.0-B2**. (D3는 다중시점 융합·선택 메커니즘만, conflict 경고 차단은 비활성 기본.) 단, **선택 기준(viewpoint 보정 overall 높은 쪽 채택)은 threshold 무관하게 항상 동작** — 채택은 상대비교라 추정 임계값 불필요.
- **confidenceBreakdown 운반 경계(실제 구현 정리 — Codex 재리뷰)**: `confidenceBreakdown`은 **clip(intrinsic) 레벨에만** 존재한다. `convertClipFeaturesToPerDay`가 게이팅 판정에 **소비**한 뒤, per-day `VideoFeatureValue`(계약 base에 breakdown 필드 없음)로는 **운반하지 않는다**. ∴ 공정→직업 집계(`videoAggregate`)에는 breakdown이 없어 **breakdown 집계가 불필요** — 게이팅 결정은 아래 `autoSuggestAllowed` + `warnings`로 운반된다. (clip→process 시점 융합은 breakdown을 다루지만 그 결과도 per-day에서 소비·드롭됨.)
- **`autoSuggestAllowed` 집계 전파 규칙(per-day VideoFeatureValue, `videoAggregate`)**: per-day에서 세팅된 `autoSuggestAllowed=false`가 집계에서 **유실 금지** —
  - **weightedSum/weightedAvg**(실사용 auto feature): 기여 source 중 **하나라도 `false`면 결과 `false`(보수적)** — 구현됨. 사유는 `warnings[]` **합집합**.
  - **pick**: **채택(최고 confidence) contribution**의 `autoSuggestAllowed`/`warnings` 따라감 — 구현됨.
  - **or/max**: 보수적 any-false. *(or featureKey는 모두 candidate=항상 `autoSuggestAllowed:false`, max는 현재 AGG 테이블 미사용 → "승리 contribution" 정밀화는 기능적 효과 없어 보류.)*
  - `overall`(confidence scalar)은 집계 시 **min**으로 재계산, `warnings`는 합집합. *(threshold 기본 비활성이라 B2 전엔 전 구간 true — 본 전파는 활성화 대비.)*
- **provenance 배열화(High #3 반영)**: `ProcessFeaturesSchema`에 **`analysisJobIds: string[]`** 추가, 기존 단일 `jobId`는 **deprecated 유지**. **폴백 정규화(재리뷰 보완)**: `analysisJobIds?.length ? analysisJobIds : (jobId ? [jobId] : [])` — 빈 배열/`undefined` jobId에 `[undefined]` 생성 방지. apply provenance·source job consume·`AppliedInput.analysisJobIds` 채우는 경로를 **배열 기반**으로 전환(D1 `sourceAnalysisJobIds` 검증·consume 트랜잭션 포함). **빈 provenance 거부 = 클라(mode를 아는 쪽)에서 강제** — 서버모드 apply가 빈 `analysisJobIds`면 `VideoAnalysisStep`이 1차 차단 + `videoServerApply`가 `EMPTY_PROVENANCE` throw(직접 호출 방어). **로컬/mock은 예외**(updatePatient 경로, 서버 미경유). *서버 route는 mock-bundle apply(빈 sources)와 구분 불가 → 빈 sources를 막지 않음(`uniqueSourceIds>0`일 때만 INVALID_SOURCE_JOB 검증).* `jobId`는 M3에서 제거.
- **융합 위치**: 서버는 clip별 intrinsic `ClipFeatureSet`만 산출(마이그레이션 불필요, D1 정합), 융합은 클라 `videoAnalysisRun`. `tasks[]` 모듈(척추·경추)은 공정≈task 1:1 단축(§8.6.2) 유지.
- **테스트**: 융합 단위(동일 featureKey 2시점→고신뢰 채택·단일시점 누락), **conflict 기본 비활성(threshold null→경고 없음)·주입 시 INTER_VIEW_CONFLICT**, **autoSuggestAllowed 집계 전파(pick=채택 contribution·weighted=any-false→false·warnings 합집합)**·**viewpoint 성분 고정매핑(preferred=1.0/비preferred=0.5/other=omit)·단일시점 NON_PREFERRED_VIEWPOINT warning·경쟁 tier(other가 preferred를 못 이김)**, 다중클립 그룹핑·다중 analysisJobIds provenance(apply consume 복수 job·**빈 provenance EMPTY_PROVENANCE 거부**), `tasks[]` 단축 회귀.

#### 검증 / 경계
- e2e(업로드 전 단계는 M3): 다중 시점 fixture clip → review_pending → 융합·세분 confidence 제안 → (autoSuggestAllowed 게이팅) 적용. **오차 정식 판정·임계값 확정은 6.0-B2(M3).**
- **하위호환**: 단일 시점·breakdown/quality 없는 PR C/D2 산출물 그대로 동작(플래그 off 영향 0).

> **M2 PR 경계 요약**: (선고정) keypoints 계약+모델 manifest+privacy guard → A(검증 하네스·순수) → B(Python 추론 PoC·격리) → C(feature 계산·fixture·config) → D1(서버 job 워커·폴링·fixture 입력) → D2a(tracking 코어)·D2b(대상자 선택 UI) → **D3a(confidence 세분화+품질검사)·D3b(시점 융합)**. A는 즉시 착수, B는 환경(Python·가중치) 선행.

---

## M3 — 업로드·검증·매핑 (상세)

> 확정 결정: 순서 **6.0-7(업로드)→B2→6.0-8**. 보존정책은 **config 노브**(`retentionPolicy`)로 A/B 둘 다 표현하되 **A(privacy_first, skeleton-only) 앱 내 완전 구현**, B의 암호화 영상 serving은 파일럿 후로 연기. B2는 **일부 보유 영상 파일럿**(잠정 임계값, 운영 게이팅은 보수적 off 유지).
> **핵심 리스크**: fixture 전용으로 안전하게 막아둔 코드(`resolveFixtureClip` 재검증·sample-detect 409·UI `canDetect`)를 실 업로드로 여는 순간 **새 신뢰 경계**가 생긴다 → 상태 모델 `purpose → source_type/file_state → upload/sample-detect/job guard`로 일관 차단. (Codex 리뷰 8회 반영 — 전체 근거는 승인 계획 `witty-gathering-quasar.md`.)

### 코드 그라운딩(확인)
- DB clips에 `upload_path/original_sha256/expires_at` nullable 존재(M3부터 채움) → 7a는 `source_type/file_state` 컬럼만 추가(`0017`).
- HTTP는 JSON 전용(`requestJson`) → `requestMultipart`(XHR·진행률) 신설.
- 워커 `resolveJobClipPath`가 fixtureDir allowlist로만 재검증 → 실 업로드 분기(`resolveUploadedClipPath`) 필요.
- sample-detect/UI `canDetect`/`videoAnalysisRun` 필터가 fixture 전제 → 실 업로드 경로로 확장.
- multer 미설치(추가) / file-type은 ESM 전용 → 매직바이트 직접 sniff(CommonJS·에어갭 친화).

### PR M3-7a — 보존 config 노브 + 서버 multipart 업로드 (PR #31 ✅ 머지)
- **`0017`**: `clips.source_type`(fixture|upload|apply_shell)+`file_state`(none|present|deleted), 각 CHECK, nullable 추가→backfill(`upload_path` 유무)→NOT NULL DEFAULT. 불변식: apply_shell→none&path NULL, upload→none→present→deleted, fixture→present(dev).
- **config**: `uploadDir`(미설정=업로드 비활성), `maxUploadBytes`(2GB), `allowedMimeTypes`/`allowedExtensions`, `retentionPolicy`(privacy_first 기본), `clipTtlHours`(24). `multer` 추가.
- **`POST /clips/:id/upload`**: multer→`uploadDir/tmp/<uuid>` 스트리밍(락 없음)→매직바이트 sniff→atomic rename→짧은 단일 `UPDATE … WHERE source_type='upload' AND file_state='none' AND upload_path IS NULL`(0행=`CLIP_ALREADY_UPLOADED`/대상 아님=`CLIP_NOT_UPLOAD_TARGET`)→`original_sha256`·`expires_at`·audit. 크기초과 413, MIME위조 400.
- **createClip `purpose`**: source_type 명시 설정. 누락 400 `MISSING_PURPOSE`, 잘못된 조합 400(fixture↔fixtureClipName 필수/금지), fixture+fixtureMode off 409 `FIXTURE_MODE_OFF`.
- **guard**: `createJob`/`sample-detect`가 source_type/file_state로 분기 — `NO_UPLOAD`/`SOURCE_DELETED_REUPLOAD_REQUIRED`/`FIXTURE_MODE_OFF`. `loadAccessibleClip`에 두 컬럼 포함.
- **워커**: `resolveUploadedClipPath`(uploadDir 하위·symlink·존재 검증) + `resolveJobClipPath` source_type 분기. 기동조건 `fixtureMode || uploadDir`.
- **클라**: `requestMultipart`(XHR·진행률·취소·win7) + `uploadClip` + `createClip(purpose)`. VideoAnalysisStep 업로드 UI·진행률·`canDetectClip`·파이프라인(createClip→uploadClip→sampleDetect→selectTarget→createJob), 업로드 serverClipId 재사용. `videoAnalysisRun` fixture-only 필터 해제(업로드 클립 포함), `videoServerApply` purpose='apply_shell'. 환자 JSONB에 경로·파일명·Blob 미저장(serverClipId는 UI 임시상태).
- **검증**: 서버 440/클라 682 테스트, lint 0, web·server build OK.

### PR M3-7b — keypoints artifact 영속화 + cleanup + 보존 A (PR #32 ✅ 머지)
- **`0018`**: `jobs.keypoints_path/keypoints_sha256`. 워커가 성공 시 keypoints 원문(좌표만)을 `uploadDir/artifacts/<jobId>.keypoints.json`로 영속(현재 result_features만 저장 → overlay 입력 보존). `InferenceResult.keypointsJson` 추가.
- **cleanup 잡**(`videoClipCleanup.ts`, workspaceRetention 패턴): TTL 만료 clip 원본+해당 job artifact unlink + orphan(uploadDir 미참조 파일·`tmp/` 1h 잔여물) 회수. `index.ts` 1h 간격 + `npm run cleanup:video` CLI.
- **보존 A**: privacy_first 추론 직후 **실 업로드 원본만** unlink+`upload_path=null`+`file_state='deleted'`(fixture는 dev allowlist라 미삭제). artifact는 **done이 아니라 clip TTL까지** 보존(done=한 번 소비됨, 다중 feature 적용 보호). review_fidelity는 노브만.
- **테스트**: artifact 영속·보존A(업로드 삭제/fixture 미삭제)·cleanup(TTL 원본/artifact·orphan·tmp grace). 서버 450 통과.

### PR M3-B2 — 파일럿 검증 + 잠정 임계값
- 오프라인 `validate_set.py`(비커밋 데이터): 영상+gold annotation→infer→`videoValidation.js` 비교(MAE·errorRate·sensitivity/specificity), `--overlay`로 원본 대조 육안. 잠정 임계값은 `CANDIDATE_CONFIDENCE_THRESHOLDS`+문서(런타임 게이팅 비활성 유지 — `DEFAULT_*`에 넣으면 즉시 적용되므로 금지). §8.9 허용오차(각도 ±10\~15°, 시간 ±20%, 반복 ±15\~20%) 대비 표.

### PR M3-8 — 저위험 모듈 매핑 on + skeleton overlay 검수
- 저위험(어깨 overhead·무릎 squatting·경추 neck flexion·척추 freq/time/postureCandidate) `confidenceGatingEnabledByFeature`로 검증 통과분만 명시 활성.
- `GET /jobs/:id/overlay`(keypoints artifact 반환, 원본 없음) + `SkeletonOverlay`(중립 배경 뼈대·각도·track-loss). `POST /clips/:id/close-review`(검수 종료+artifact 즉시 삭제). 보존 B(원본 위 overlay)는 노브만.

---

## M4 (개요)

- **M4** 6.0-9 에어갭 Docker(ONNX/OpenVINO CPU, docker save/load, --network none, recipe versioning, WSL2 메모리 vs 네이티브 결정, 동시1건) / 6.0-10(선택) hand 모델 손목 SI(IE 수기).

---

## Verification

**각 PR 공통**: `npm run build:web`(win7 호환), 클라 `npm run dev` 수동, 서버 `cd server && npm test`, 계약 `__tests__`. 하위호환 회귀(videoAnalysis 없는 파일 로드 → 보강 + 기존 무파손, 플래그 off 동작 변화 0).

**M1 e2e(플래그 on, mock)**: 환자 생성 → 저장·동기화(synced) → 영상 분석 스텝 → 공정/클립/시점/% → mock 분석 → 폴링 review_pending(+audit) → apply(If-Match)로 값 반영+appliedInputs+sync revision 갱신(재전송 idempotent) → 로컬 rollback → 비담당 403/404·non-synced 차단.

**M2 이후**: 6.0-B2 검증셋 오차가 §8.9 허용오차(각도 ±10~15°, 시간 ±20%, 반복 ±15~20%) + inter-rater 기준 충족 시 임계값·운영 플래그 on.

### 6.0-7 업로드 경로 수동 검증 (7a+7b) — ✅ 2026-06-18 라이브 완료

> 자동 테스트는 mock(fs/DB/multer)이라 프록시·디스크·실 영상·워커 추론은 못 잡는다. **6.0-7 = 7a+7b 합본**으로 실 업로드 전 구간을 1회 통합 스모크. **값 타당성은 6.0-B2 몫**(여기선 "전 구간 실동작"만). 환경: 실 영상(mp4) + Python venv(host) + 네이티브 인트라넷 서버(`npm run build` → `node dist/index.js`, **TZ=UTC**) + `VIDEO_ANALYSIS_ENABLED=true`·`VIDEO_ANALYSIS_UPLOAD_DIR` + docker postgres. 헬퍼: `scripts/dev-intranet-server.ps1`.

- **Tier 3 (웹 UI 라이브, 네이티브 인트라넷)** — 실 영상 업로드→분석→적용 에러 없이 완주.
  - [x] 업로드 **진행률** → 완료 후 sample-detect 활성(canDetect)
  - [x] sample-detect → TargetPicker 선택 → 분석 실행(워커 실추론) → review_pending → 서버 apply(`applied_revision` 기록)
- **검증(DB+디스크 대조)**:
  - [x] 분석된 upload 클립 → `file_state='deleted'`·`upload_path=NULL`·`original_sha256` 보존(retention A). 디스크 원본 `.bin` 실삭제. 미분석(present) 클립만 원본 유지.
  - [x] keypoints artifact 보존 — `done`·`review_pending` job 모두 `keypoints_path` + `.video-uploads/artifacts/*.keypoints.json`(좌표만). done이어도 유지(clip TTL까지).
  - [x] `apply_shell` 클립 = `none`·파일 없음. `tmp/` 잔여 0.
- **발견된 별건 버그(영상 무관)**: 네이티브 서버를 호스트 로컬(KST)로 띄우면 `dateOnly()`가 pg DATE→`toISOString()`(UTC)로 하루 밀려 환자 식별(생년월일) 비교가 깨져 모든 저장이 409 `PATIENT_IDENTITY_CONFLICT`. 운영 docker(UTC)는 잠복. → **별도 PR로 수정**(스모크는 TZ=UTC로 우회).
