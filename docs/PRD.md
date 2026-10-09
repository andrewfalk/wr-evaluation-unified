# PRD: 직업성 질환 통합 평가 시스템 (wr-evaluation-unified)

> **Version:** 7.1.2
> **Last Updated:** 2026-10-09
> **Status:** 인트라넷 운영 중 · **무릎 노출 변수 4종(쪼그려앉기 분/일·시간, 중량물 kg/일·톤)을 직업력 단순합에서 직력 기간 가중평균·누적으로 개편 + 대표 직종명을 상병(disease) grain에서 선택 + 제한 데이터 열람 권한자에게 기술통계 소수 셀 제한 응답 시점 해제(DB 마이그레이션 0036, 카탈로그 v31)** · **직력별 "신체부담평가 미포함" 선택(직력 카드 포함/미포함 라디오, 모듈 평가·결과·통계의 신체부담 변수에서 제외, 직업력 출력에는 맨 끝에 표기) · EMR·엑셀 확인 상병은 종합소견에서 "확인"으로 입력한 상병만 내보내기 · 범주형 소수 범주 "기타" 병합 + 원본 범주 빈도 · 원본 히스토그램 경계를 보기 좋은 값으로 정렬(DB 마이그레이션 0035, 카탈로그 v29)** · **통계 히스토그램 양 끝 소수 구간 병합 + 권한자 원본 히스토그램(권한 표시명 "제한 데이터 열람", DB 마이그레이션 0034)** · **통계분석 워크벤치 도입(인트라넷 전용·기본 비활성 `STATS_WORKBENCH_ENABLED`)** — 기술통계·Table 1 층화·이변량 8종·상관행렬·회귀(OLS/이분 로지스틱, 진단·spline·interaction)·예측(L2 로지스틱) + 차트, 소수 셀 억제·차분 방지 공개통제, 비동기 실행 큐, 통합 카탈로그 85개 변수(case/job/disease grain), 서버가 데이터셋을 조립하는 `@wr/analytics-core` 공유 계산 패키지, Python 통계 엔진(별도 venv) · capability 권한(기본 3종 전원 허용, 제한 행데이터 필드만 grant) + 관리자 콘솔 "통계 권한" 탭 · 환자 완료시각 서버 재검증 추적 · DB 마이그레이션 0028~0033 · 상병 입력 진단명 잘림 수정 · 등록 마법사 필수값 안내 · 평가 시점 나이를 만 나이(재해일자 기준)로 정정 · 영상 분석 UI 가독성 개선 · 무릎 관절염 상병(M17 하위코드 전체·슬관절/관절염 표기)에서 K-L Grade 입력창이 숨던 문제 수정 · 손목 영상분석 timeout 오분류(DEADLINE_EXCEEDED) 수정 + dev 서버 포트 충돌 가드 · 영상분석 flat 참고 후보(무릎 비틀림·어깨/팔꿈치 반복·손목 반복/각도)에 골격 검수·"왜 이 값?" 근거 패널 배선 + Left/Right 반복시간 근거 패널 환산식 오류 수정 · 비담당 환자 조회 시 막혀 있던 조회 전용 토글(종합평가 그룹/개별 카드 전환·상병 칩 이동, 척추/경추 작업 목록 선택·직력 탭·MDDM/전신진동 탭, 영상분석 근거 패널 등) 상호작용 수정 · Electron 셸 자동 업데이트(electron-updater) 도입 — 관리자 on/off 스위치 + canary 채널, 평상시 휴면(트랙 2) · 종합소견 직접 편집 오버라이드(자동 생성 문장을 의사가 다듬어 EMR 전송) · 특이 사항 메모 개편(구 복귀 고려사항, EMR 전송 제외) · 락 취득/상실 직후 모듈 편집 가드 stale 클로저 수정 · 인증 부팅 시 무한 루프(자기영속 401 재시도) 수정 · 환자 등록일 표시 KST 타임존 버그 수정 · 등록번호 "유령 충돌" 해소 + 생년월일 정정 경로(정정 API·고아 person 해제·데드락 재시도) · 종합소견 그룹 형식 미리보기를 개별 형식과 통일 · zod record 타입 optional 처리에 맞춘 테스트 정리 · Electron 종료 후 로그인 유지 문제 + 서버 세션(logout/refresh) 동시성 경쟁조건 수정 · 환자 단위 편집 락(TTL lease lock, LOCK_ENFORCEMENT_MODE 롤아웃) 구현 · 경추/팔꿈치/손목 모듈 저장 무한루프 수정(stableStringify) · 경추 모듈 부담 작업 0건 시 완료 배지 오판정 수정 · 종합소견 미리보기 그룹/개별 탭 명칭 정리 + 토글 연동 자동전환 + 낮음 사유 그룹 제목 구분 표시 + 손목/팔꿈치 직업별 요약 가독성 개선 · 종합평가 패턴 그룹화(상병 50건↑ 우/좌 일괄 처리) + EMR byte 절감 + K-L/Ellman 조건부 표시 · 손목/팔꿈치 BK유형 그룹 합류 시 진단별 저장값 자동 동기화 수정 · 환자 목록 의사별 필터 + 비담당 환자 열람성(복사/스크롤) 개선 · EMR 디바이스 등록 rate-limit 자기악순환 방지 · EMR 추출(재해일자별 신청건 매칭·성별 자동입력)/직접입력 개선 · 일괄입력 빈 양식 상시 제공 · M4 영상분석 시범 운영(참고용, 미검증 배너 — 어깨 반복 시간합 계산기 + 공정별 값 표시 추가, 상세는 `docs/VIDEO_ANALYSIS_IMPLEMENTATION_PLAN.md`)

---

## 1. 제품 개요

### 1.1 목적

직업환경의학 전문의가 **업무상 질병 인정 여부를 판단**할 때 사용하는 통합 평가 도구.
현재 무릎(슬관절), 척추(요추 MDDM), 경추(목 BK2109), 팔꿈치(주관절 BK2101/2103/2105/2106), 어깨(견관절 BK2117), 손목(수관절 BK2113/2101/2103/2106) 평가를 지원하며, 향후 고관절 등 추가 부위를 플러그인 형태로 확장할 수 있는 아키텍처로 설계되었다.

### 1.2 배경

기존에 부위별로 독립된 도구가 운영되고 있었다:

| 기존 도구 | 기술 스택 | 용도 |
|-----------|-----------|------|
| `mddm-vercel` | Vanilla JS | 척추 MDDM 척추압박력 평가 |
| `wr-evaluation-claude` | React | 무릎 슬관절 업무관련성 평가 |

두 도구의 **환자 기본정보, 직업력, 상병 입력** 등이 중복되었고, 하나의 환자에 대해 여러 부위를 동시 평가할 수 없었다.
이를 해결하기 위해 **플러그인 아키텍처 기반의 통합 시스템**으로 재설계했다.

### 1.3 대상 사용자

- **직업환경의학 전문의** — 산재보험 업무상 질병 인정 여부 감정 업무
- **근로복지공단 자문의사** — 요양급여 신청 사례 검토
- **산업보건 연구자** — 직업성 근골격계 질환 역학 분석

### 1.4 배포 형태 (v5.0.0)

본 시스템은 동일 코드베이스에서 세 가지 형태로 배포된다:

| 형태 | 사용 시나리오 | 데이터 저장 | 인증 |
|------|---------------|-------------|------|
| **웹 (Vercel)** | 개인 사용자, 데모, 평가 도구 단독 사용 | 브라우저 localStorage | 없음 |
| **Electron Standalone** | 단일 PC 임상 사용, 인터넷 불가 환경 | 사용자 데이터 디렉터리 파일 | 없음 |
| **Electron Intranet** | 병원 인트라넷, 다중 사용자 | 서버 PostgreSQL | JWT + Device 등록 |

빌드 타깃은 `electron/build-target.json` (`standalone` | `intranet`)으로 분기되며, `npm run electron:build` / `npm run electron:build:intranet`로 각각 빌드한다.

> **운영 환경 참고 (v5.1.0 이후):** 인트라넷 배포 시 Caddy 호스트 포트는 **8080/8443** (컨테이너 내부 80/443은 그대로). `CORS_ORIGINS` 환경변수에 `:8443` 포함 필요. 방화벽 인바운드 8080/8443 허용.

### 1.5 기술 스택

#### 프론트엔드 / 클라이언트

| 영역 | 기술 |
|------|------|
| 프론트엔드 | React 18, CSS Variables (다크모드 지원) |
| 빌드 | Vite 5 |
| 데스크톱 | Electron 22 + electron-builder (NSIS) |
| 웹 배포 | Vercel (서버리스) |
| AI | Google Gemini API + Claude API (Vercel 서버리스 / Electron IPC / 인트라넷 서버 프록시) |
| 내보내기 | xlsx (엑셀), html2pdf.js (PDF), jszip |
| 폰트 | Pretendard (CDN), Noto Sans KR (fallback) |
| 테스트 | Vitest (renderer + electron), node 환경 기본 + jsdom·@testing-library/react·user-event로 컴포넌트/훅 렌더링 테스트 (v6.1.6+) |

#### 백엔드 / 인프라 (인트라넷 모드, v5.0.0 신규)

| 영역 | 기술 |
|------|------|
| API 서버 | Node.js 20 + TypeScript + Express |
| DB | PostgreSQL 16 (감사 로그 월별 파티셔닝) |
| HTTPS 리버스 프록시 | Caddy 2 (내부 CA 자동 발급) |
| 컨테이너 오케스트레이션 | Docker Compose v2.17+ (`!reset` 태그 + profile 기반 backup 분리) |
| 인증 | JWT access(15m) + refresh(7d), bcrypt 12라운드 |
| 감사 로그 | Ed25519 (Electron device 키페어) + append-only 파티션 |
| 백업 | pg_dump + GPG (RSA 4096, passphrase-less 복구 키) |
| 백업 모니터링 | 별도 컨테이너 — stale 감지, alert 파일 생성 |
| 통계 엔진 (v7.0.0) | Python 3 subprocess — app 이미지 내 별도 venv `/opt/stats-venv`(numpy 1.26.4 · scipy 1.13.0 · statsmodels 0.14.2 · pandas 2.2.3 · jsonschema 4.22.0), 별도 컨테이너 없음 |
| 공유 계산 패키지 (v7.0.0) | `@wr/analytics-core`(`packages/analytics-core`, TypeScript) — 클라이언트·서버가 같은 계산·변수 추출 코드를 import |
| 권한 (v7.0.0) | capability 모델(`capabilities` + `user_capability_grants`) — 기본 허용 ∪ 유효 grant |
| 테스트 | Vitest (server/) — admin/auth/audit/patients/presets/workspaces/opsBackupStatus |
| CI | (없음 — 오프라인 빌드 + 수동 리허설 패스 정책) |

---

## 2. 핵심 아키텍처

### 2.1 플러그인 모듈 시스템

```
src/core/moduleRegistry.js
├── registerModule(manifest)   — 모듈 등록
├── getModule(id)              — ID로 모듈 조회
└── getAllModules()             — 전체 모듈 목록
```

각 모듈은 `src/modules/<name>/index.js`에서 자기 자신을 등록한다:

```javascript
registerModule({
  id: 'knee',
  name: '무릎 (슬관절)',
  icon: '🦵',
  description: '근골격계 질환 업무관련성 평가',
  EvaluationComponent,          // 메인 UI 컴포넌트
  createModuleData,             // 초기 데이터 팩토리
  createDiagnosis,              // (선택) 모듈별 상병 확장 팩토리
  computeCalc,                  // 계산/점수 산출 함수
  isComplete,                   // 완료 판정 함수
  exportHandlers,               // 내보내기 핸들러 (Excel, PDF 등)
  tabs: [                       // 위자드 스텝 정의
    { id: 'job', label: '신체부담 평가' },
  ]
});
```

**새 모듈 추가 절차:**
1. `src/modules/<name>/` 디렉토리 생성
2. `index.js`에서 `registerModule()` 호출
3. `src/App.jsx`에 `import './modules/<name>'` 한 줄 추가
4. (선택) `src/core/utils/diagnosisMapping.js`에 ICD 코드 매핑 추가

### 2.2 데이터 모델

```
Patient
├── id: UUID
├── phase: 'intake' | 'evaluation'
└── data
    ├── shared                          ← 모듈 공통
    │   ├── patientNo                   ← 환자등록번호
    │   ├── name, gender, height, weight, birthDate
    │   ├── injuryDate, evaluationDate
    │   ├── hospitalName, department, doctorName
    │   ├── medicalRecord               ← 진료기록 / 의학적 소견
    │   ├── highBloodPressure, diabetes  ← 기저질환 (유/무)
    │   ├── visitHistory                ← 수진이력
    │   ├── consultReplyOrtho/Neuro/Rehab/Other ← 다학제 회신 (과별)
    │   ├── specialNotes
    │   ├── diagnoses[]                 ← 상병 목록
    │   │   └── { id, code, name, side }
    │   └── jobs[]                      ← 직업력 (공통)
    │       └── { id, jobName, presetId, startDate, endDate,
    │             workPeriodOverride, workDaysPerYear, excludeFromAnalysis? }
    ├── modules
    │   ├── knee                        ← 무릎 전용
    │   │   ├── jobExtras[]             ← 직종별 신체부담 (sharedJobId로 연결)
    │   │   │   └── { sharedJobId, weight, squatting,
    │   │   │         stairs, kneeTwist, startStop,
    │   │   │         tightSpace, kneeContact, jumpDown }
    │   │   └── returnConsiderations    ← 특이 사항 메모
    │   ├── spine                       ← 척추 전용
    │   │   ├── tasks[]                 ← MDDM 작업 목록
    │   │   │   └── { id, name, posture, weight, frequency,
    │   │   │         timeValue, timeUnit, correctionFactor, force,
    │   │   │         sharedJobId }     ← 직업력 연결 (shared.jobs[].id)
    │   │   └── returnConsiderations    ← 특이 사항 메모
    │   ├── shoulder                    ← 어깨 전용
    │   │   ├── jobExtras[]             ← 직종별 신체부담 (sharedJobId로 연결)
    │   │   │   └── { sharedJobId, overheadHours, repetitiveMediumHours,
    │   │   │         repetitiveFastHours, heavyLoadCount, heavyLoadSeconds,
    │   │   │         vibrationHours, evidenceSources[] }
    │   │   └── returnConsiderations    ← 특이 사항 메모
    │   └── elbow                       ← 팔꿈치 전용 (Job × Diagnosis 2차원)
    │       ├── temporalSequence        ← 공통 시간적 선후관계 (모듈 전체 1회 입력)
    │       │   └── { recent_task_change, task_change_date,
    │       │         symptom_onset_interval, improves_with_rest }
    │       ├── jobEvaluations[]        ← 직업별 × 상병별 엔트리
    │       │   └── { sharedJobId,
    │       │         diagnosisEntries[{
    │       │           diagnosisId, selectedBkType, bkSelectionMode,
    │       │           main_task_name, direct_anatomic_link,
    │       │           exposure_types[], 공통지표..., BK분기필드... }] }
    │       └── returnConsiderations    ← 특이 사항 메모
    │   ├── wrist                       ← 손목 전용 (Job × Diagnosis 2차원)
    │   │   ├── temporalSequence        ← 공통 시간적 선후관계 (모듈 전체 1회 입력)
    │   │   ├── jobEvaluations[]        ← 직업별 × 상병별 엔트리
    │   │   └── returnConsiderations    ← 특이 사항 메모
    │   └── cervical                    ← 경추 전용 (spine 패턴과 동일)
    │       ├── tasks[]                 ← 경추 작업 목록
    │       │   └── { id, name, exposure_types[], load_weight_kg,
    │       │         carry_hours_per_shift, forced_neck_posture,
    │       │         neck_nonneutral_hours_per_day,
    │       │         combined_flexion_rotation_posture,
    │       │         precision_work, notes,
    │       │         sharedJobId }     ← 직업력 연결 (shared.jobs[].id)
    │       └── returnConsiderations    ← 특이 사항 메모
    └── activeModules: ['knee', 'spine', 'shoulder', 'elbow', 'wrist', 'cervical']
```

**공통/전용 분리 원칙:**
직종명·기간·연간근무일수 등 여러 모듈에서 공통으로 필요한 정보는 `shared.jobs[]`에, 쪼그려앉기 시간·중량물 무게 등 모듈 고유 정보는 `modules.<id>.jobExtras[]`에 저장한다. `sharedJobId`로 1:1 매핑된다.

**팔꿈치/손목 모듈 예외 — Job × Diagnosis 2차원 구조:**
팔꿈치와 손목은 동일 직업 내에서도 상병별로 BK 분기별 지표가 달라지기 때문에 `jobExtras[]`(직업 1차원) 대신 `jobEvaluations[].diagnosisEntries[]`(직업 × 상병 2차원) 구조를 사용한다. `sharedJobId`로 `shared.jobs[]`와 연결되고, `diagnosisId`로 `shared.diagnoses[]`와 연결된다.

**경추 모듈 — 척추(spine) tasks[] 패턴:**
경추는 상병별 분기 없이 작업 단위로 노출을 평가하므로 팔꿈치/손목 2차원 구조 대신 척추와 동일한 `tasks[]` 1차원 구조를 사용한다. 각 task는 `sharedJobId`로 `shared.jobs[]`의 특정 직업에 연결된다.

### 2.3 데이터 마이그레이션

기존 단일 모듈 형식(`data.module`)에서 멀티 모듈 형식(`data.modules`)으로의 자동 마이그레이션을 지원한다:

```
migratePatient(patient)
├── moduleId + data.module → data.modules[moduleId] + data.activeModules
└── migrateJobsToShared(patient)
    ├── knee.jobs[] → shared.jobs[] + knee.jobExtras[]
    └── spine 평문 필드 → shared.jobs[] 항목으로 변환
```

불러오기(load) 시 자동 실행되므로 사용자는 기존 저장 데이터를 그대로 사용할 수 있다.

### 2.4 공유 계산 패키지 — `@wr/analytics-core` (v7.0.0)

통계분석 워크벤치가 서버에서 데이터셋을 조립하려면 6개 평가 모듈의 공식·변수 추출·완료 판정을 **서버가 클라이언트와 같은 코드로** 실행할 수 있어야 한다. 이를 위해 `packages/analytics-core`(npm 패키지 `@wr/analytics-core`)로 해당 로직을 이관했다.

- **이관 범위**: 모듈별 계산·변수 추출(`modules/<id>/`), 직력 기간·상병 매핑 등 leaf 유틸, 레코드 구형식 → 현재 형식 결정적 마이그레이션(`migration/`, 순수 TS SHA-1/UUIDv5), 완료 판정(`completion.ts`), grain 엔터티(`grainEntities.ts`), 변수 카탈로그(`catalog.ts`).
- **기존 경로 호환**: `src/core/utils/*`·각 모듈 `utils/calculations.js`는 옛 경로 shim으로 남겨 기존 코드·테스트가 무수정으로 동작한다.
- **빌드**: `scripts/prebuild-analytics-core.mjs`가 dev/build/test 전에 패키지를 빌드(tsup)하고, Vite·vitest는 별칭 `@analytics-core`로 resolve한다. 서버 Docker 빌드는 web-builder 단계에서 패키지를 빌드해 server 이미지에 `node_modules/@wr/analytics-core`로 vendoring한다.
- **원칙**: 파생 공식을 서버·클라이언트에서 각각 재구현하지 않는다. 타임존에 따라 결과가 달라질 수 있는 `Date` 파싱 대신 순수 그레고리력 산술로 날짜를 검증한다.

---

## 3. 위자드 기반 UI 흐름

탭 기반 네비게이션에서 **단계별 위자드(Step Wizard)**로 전면 전환했다.

### 3.1 신규 환자 생성 위자드 (Intake)

| 스텝 | 내용 |
|------|------|
| 1. 기본정보 | 인적사항 + 직업력 입력 |
| 2. 상병 입력 | ICD 코드/상병명/부위 입력, 모듈 자동 감지 힌트 |
| 3. 모듈 선택 | 상병 기반 자동 추천 + 수동 선택 |

생성 완료 시 첫 번째 모듈 스텝으로 자동 이동.

### 3.2 메인 평가 위자드

공유 스텝과 모듈별 스텝이 순차적으로 배치되고, 마지막에 종합소견과 AI 분석 스텝이 위치한다:

```
[공유] 기본정보 → 상병 입력 → 모듈 선택
[무릎] 🦵 신체부담 평가
[팔꿈치] 💪 신체부담 평가
[손목] ✋ 신체부담 평가
[어깨] 🙆 신체부담 평가
[경추] 👤 부담 노출 평가
[척추] ⚕️ 신체부담 평가
[공유] 종합소견 → AI 분석
```

`buildSteps(activeModules)` 함수가 활성 모듈에 따라 동적으로 스텝 목록을 생성한다.

### 3.3 종합소견 스텝 (공유 최종 스텝)

모든 모듈의 평가 결과를 **좌우 2패널 레이아웃**으로 표시한다:

**좌측 패널 — 입력:**
- **무릎 상병:** KLG 등급 입력 (좌/우, `supportsKlGrade`가 true인 상병만 — v6.2.0) + 상태 확인 + 업무관련성 평가
- **팔꿈치/손목 상병:** BK 유형(자동 제안/수동) + 공통 시간적 선후관계 + 상태 확인 + 업무관련성 평가
- **어깨 상병:** Ellman Class 입력 (좌/우, `supportsEllmanClass`가 true인 상병만 — v6.2.0) + 상태 확인 + 업무관련성 평가
- **척추 상병:** 수직분포원리(확인/미확인) + 동반성 척추증(확인/미확인) 드롭다운 + 상태 확인 + 업무관련성 평가 (좌우 구분 없음)
- **경추 상병:** 척추와 동일하게 좌우 구분 없는 축(Axial) 상병으로 처리 + 상태 확인 + 업무관련성 평가
- 특이 사항 메모 (활성 모듈이 하나라도 있으면 표시 — 척추 포함 전 모듈 공통. 평가 기록에는 저장되나 EMR로는 전송되지 않음)

**우측 패널 — 미리보기:**
- 전체 모듈 결과를 텍스트 보고서로 통합 표시 (패널 높이를 꽉 채움)
- **"종합소견(그룹)"/"종합소견(개별)" 탭** — 각각 `generateUnifiedEMR(patient, true|false)`로 그룹/개별 형식을 동시에 계산해 보여주며, 두 탭 모두 EMR 종합소견(`txtSyth1Cont`) CP949 3,950byte 한도 대비 사용량 게이지를 표시한다. 좌측 패턴 그룹/개별 카드 토글을 바꾸면 미리보기 탭도 자동으로 따라가며(수동으로 다른 탭을 눌러 비교하는 것은 계속 가능), 이 탭에 실제로 표시되는 내용이 그대로 EMR 직접입력으로 전송된다 (v6.2.2, 이전 v6.2.0에서는 "EMR 종합소견"/"통합 리포트 초안"이라는 이름으로 그룹 탭에만 게이지가 있었음)

상병별로 `getDiagnosisModuleHint()`를 사용하여 무릎/척추를 자동 구분하고, 해당 모듈에 맞는 입력 UI를 렌더링한다.

#### 3.3.1 종합평가 패턴 그룹화 (v6.2.0)

상병이 50건을 넘어가면 좌측 패널에서 우/좌 개별 클릭이 과도해지는 문제를 해결하기 위해, 상병+방향(평가단위) 단위로 **동일한 상태·업무관련성 패턴**을 자동으로 묶어 그룹 단위로 일괄 입력할 수 있는 뷰를 제공한다.

- **`assessmentGroups.js`**: 상병+방향(평가단위) 단위 패턴 그룹 엔진. 그룹 계산·일괄 적용·Undo·개별/그룹 형식 텍스트 생성을 매번 진단 데이터에서 재계산(별도 저장 상태 없음).
- **`AssessmentGroupView`**: 패턴 그룹 카드 목록(연번 배지) — 완료 그룹은 클릭 시 이미 채워진 값으로 수정 모달이 열림(빈 값으로 시작하지 않음). 방향(우/좌/양측) 미선택 비축성 상병은 "방향 미선택" 카드로 별도 노출되어 개별 카드로 이동 가능. 그룹 카드는 기본적으로 구성원이 펼쳐진 채로 표시되고 "구성원 접기" 버튼으로 감출 수 있다(v6.2.2). 업무관련성이 낮음인 그룹은 상태·업무관련성이 같아도 낮음 사유가 다르면 별도 그룹으로 갈리므로, 제목 뒤에 "낮음 사유 N" 연번을 붙여 구분한다(v6.2.2, 하단 캐션은 "낮음 사유 상세").
- **`AssessmentPatternEditor`**: 그룹 전체에 상병 상태·업무관련성·낮음 사유를 한 번에 적용하는 일괄 입력 에디터.
- **`AssessmentIndividualFields`**: K-L Grade/Ellman Class/척추 공통 항목(수직분포원리·동반성 척추증) 개별 입력 패널.
- **출력 형식 전환**: `shared.reportOptions.groupAssessmentResults` 옵션(개별/그룹 단일 토글)에 따라 통합 미리보기·EMR 종합소견의 상병별 서술 형식이 전환된다. 기존 환자는 이 옵션 미설정 시 출력이 개별 형식 그대로 유지되며, 그룹 뷰 자체는 이 옵션과 무관하게 항상 열려 있어 기존 환자의 미완료 건도 그룹 화면에서 바로 일괄 입력할 수 있다.
- **b6 신체부담 평가 요약본**: `buildExposureSummary`(비척추)/`buildSpineSectionSummary`(척추)가 신체부담 섹션을 요약해 b8(종합소견)로 넘어가는 분량을 줄인다. 이 요약은 `groupAssessmentResults` 옵션과 무관하게 항상 적용된다. 손목/팔꿈치는 직업별로 노출을 요약하므로 `buildExposureSummary`가 직업명 헤더(`[직업명]`)를 출력하고 직업이 바뀔 때마다 줄바꿈해 가독성을 확보한다(v6.2.2).

### 3.4 환자 전환

- 사이드바에서 환자 목록 관리 (검색, 필터, 정렬, 다중 선택)
- 환자별 마지막 스텝 위치를 기억하여 전환 시 복귀
- 완료 상태(●) 표시: 모든 활성 모듈의 `isComplete()` 충족 시 (무릎은 무릎 상병만, 척추는 척추 상병만 검사하여 교차 간섭 방지)

---

## 4. 모듈 상세

### 4.1 무릎 모듈 (knee)

**평가 방법론:** 한국 산재보상보험법 근골격계 질환 업무관련성 평가 기준

#### 신체부담 평가 (JobTab + KneeResultPanel)

**좌측 패널 — 입력 (JobTab):**
공통 직업력(BasicInfoForm)과 연결된 무릎 전용 부담 요인 입력:

| 항목 | 설명 |
|------|------|
| 쪼그려앉기 (분/일) | 일일 쪼그려앉기 작업 시간 |
| 중량물 (kg) | 일일 취급 중량물 무게 |
| 보조변수 6개 | 계단오르내리기, 무릎비틀기, 기동정지 반복, 좁은공간, 무릎접촉/충격, 뛰어내리기 |

**우측 패널 — 결과 (KneeResultPanel):**
입력값에 실시간 연동되는 시각적 결과 표시:
- 신체부담기여도 카드 (최소~최대%, 평균)
- 누적신체부담 판정 (충분함/불충분함) + 만 나이
- 직종별 신체부담 등급: 고도 / 중등도상 / 중등도하 / 경도 (4단계)

#### 계산 로직 (`computeKneeCalc`)

```
shared.jobs[] + knee.jobExtras[] → mergeJobsWithExtras() → 합성 job 객체
→ calculateWorkRelatedness() → relatedness (min~max %)
→ jobBurdens[] → burden level per job
→ cumulativeBurden → '충분함' | '불충분'
```

### 4.3 어깨 모듈 (shoulder)

**평가 방법론:** 독일 직업병 BK2117 기준 — 어깨 근골격계 질환 누적 노출 평가

#### 신체부담 평가 (JobTab + ShoulderResultPanel)

**좌측 패널 — 입력 (JobTab):**
공통 직업력(BasicInfoForm)과 연결된 어깨 전용 부담 요인 입력 (단위: 일일 노출 시간):

| 항목 | 단위 | 설명 |
|------|------|------|
| 오버헤드/어깨높이 이상 작업 | 시간/일 | 팔을 어깨 위로 들어올리는 작업 |
| 반복동작 중간속도 (4~14회/분) | 시간/일 | 중간 속도 반복 작업 시간 |
| 반복동작 고도 (≥15회/분) | 시간/일 | 고속 반복 작업 시간 |
| 중량물(≥20kg) 취급 | 횟수/일 + 초/회 | 취급 횟수와 1회 소요 시간 분리 입력 |
| 손-팔 진동 (≥3 m/s²) | 시간/일 | 진동 공구 노출 시간 |

**중량물 누적 계산:** `(횟수/일 × 초/회) / 3600 × 연간근무일수 × 근무년수` (시간 단위 환산)

**우측 패널 — 결과 (ShoulderResultPanel):**
- BK2117 노출 임계값 대비 누적 시간 비교 테이블 (RatioBar 시각화)
- 반복동작 OR 조건: 중간속도 OR 고도 초과 시 기준 충족 판정
- 직력별 기여 상세 (2개 이상 직업 시)

#### BK2117 누적 노출 임계값

| 노출 유형 | 임계값 |
|-----------|--------|
| 오버헤드 작업 | 3,600시간 |
| 반복동작 중간속도 | 38,000시간 |
| 반복동작 고도 | 9,400시간 |
| 중량물(≥20kg) 취급 | 200시간 |
| 손-팔 진동 | 5,300시간 |

#### 계산 로직 (`computeShoulderCalc`)

```
shared.jobs[] + shoulder.jobExtras[] → mergeJobsWithExtras()
→ computeJobExposures(extras, periodYears, workDaysPerYear)
   각 변수: cumulativeHours = dailyHours × workDaysPerYear × periodYears
   (중량물: dailyHours = (heavyLoadCount × heavyLoadSeconds) / 3600)
→ totals[] = 직력별 합산 누적시간, BK2117 임계값 대비 ratio/exceeded

누적 신체부담 판정 (3단):
  1) 초과 항목 ≥1개 → "기준 초과, 누적 신체부담 충분"
  2) 초과 없으나 50%↑ ≥3개 또는 75%↑ ≥2개 → "복합 노출 고려, 충분"
  3) 그 외 → "기준 미달, 불충분"
```

---

### 4.4 팔꿈치 모듈 (elbow)

**평가 방법론:** 독일 산재보험 BK2101/2103/2105/2106 기반 공통 신체부담 평가. 임계값/스코어가 아닌 **Gate-and-Flag 판정** 방식으로 핵심 위험 요인 조합을 신호(flag)로 표시하고, 서술형(narrative) 종합평가 문장을 자동 생성한다.

#### BK 4유형 분기

| BK 유형 | 질환 | 핵심 분기 지표 |
|---------|------|----------------|
| BK2101 | 상과병변 / 부착부 건병증 | 1회 동작 주기, 시간당 반복횟수, 단조 반복패턴, 강제 배측굴곡, 회내·회외 반복 |
| BK2103 | 팔꿈치 골관절염 / 박리성 골연골염 | 진동 공구 종류, 1일 진동 사용시간, 공구 파지·가압 작업 |
| BK2105 | 팔꿈치 점액낭염 | 팔꿈치 지지·기대기, 직접 압박/마찰/충격, 압박 원인 |
| BK2106 | 주관증후군 / 척골신경병변 | 같은 자세 유지, 직접 압박 수준, 압박 원인 |

#### 데이터 구조 (Job × Diagnosis 2차원)

```
modules.elbow
├── temporalSequence                       ← 공통 시간적 선후관계 (모듈 1회 입력)
│   └── { recent_task_change, task_change_date,
│         symptom_onset_interval, improves_with_rest }
├── jobEvaluations[]
│   └── { sharedJobId,
│         diagnosisEntries[{
│           diagnosisId, selectedBkType, bkSelectionMode,
│           main_task_name, direct_anatomic_link,
│           exposure_types[],                    ← 반복/힘/비중립 자세 복수 선택
│           repetition_level, force_level,
│           awkward_posture_level, static_holding_level,
│           direct_pressure_level, vibration_exposure,
│           daily_exposure_hours, shift_share_percent,
│           days_per_week, work_pattern, rest_distribution,
│           bk2101_*, bk2103_*, bk2105_*, bk2106_*  ← BK 분기 필드
│         }] }
└── returnConsiderations
```

#### 신체부담 평가 (ExposureForm + DiseaseSpecificFields + ElbowResultPanel)

**좌측 패널 — 입력 (ExposureForm + DiseaseSpecificFields):**
- 직업별 카드 내부에 해당 직업의 팔꿈치 상병 엔트리 카드들을 나열
- 각 상병 카드: BK 유형(자동/수동), 핵심 동작 연결성 → `yes`일 때만 노출 세부 항목 공개
- 공통 핵심 노출유형(반복/힘/비중립 자세) 체크박스 + 각 항목 세부 수준
- BK 유형별 `DiseaseSpecificFields` 분기 렌더링

**우측 패널 — 결과 (ElbowResultPanel):**
- 최상단: 공통 시간적 선후관계 섹션(모듈 전체 1회 입력)
- 직업별 카드 → 상병별 Summary Card: BK 라벨, 주요 flag pill, narrative 서술, 위험 요인 요약, 종합평가 문장

#### 계산 로직 (`computeElbowCalc`) — Gate-and-Flag

```
각 diagnosisEntry에 대해:
  1) 필수 입력 게이트: REQUIRED_ENTRY_FIELDS 체크 (selectedBkType, main_task_name,
     direct_anatomic_link, exposure_types, daily_exposure_hours, shift_share_percent,
     days_per_week, work_pattern, rest_distribution)
  2) 게이트 통과 시 15+ flag 판정:
     - core_exposure_present / core_exposure_unclear
     - daily_share_high / daily_share_moderate / daily_share_low
     - rest_unfavorable
     - mechanical_load_dominant / pressure_load_dominant / vibration_present
     - bk2101_high_freq_example, bk2101_pattern_supported
     - bk2105_pattern_supported, bk2106_pattern_supported
     - bk2103_pattern_supported, bk2103_transmission_amplifier_present
     - temporal_fit_high / temporal_fit_unclear
  3) RISK_FACTOR_FLAGS 집합을 riskFactorItems로 분리
  4) narrative + riskFactorSentence 자동 생성
```

**`work_pattern` 수식자:**
- `continuous`: daily_share 임계값 상향(1.5h/20% vs 기본 3h/40%), rest_unfavorable이 `moderate` 휴식에서도 활성화
- `intermittent` / `mixed`: 기본 임계값 유지

#### 자동 BK 매핑 (`inferElbowBkTypeFromDiagnosis`)

ICD 코드 우선 → 상병명 키워드 순:

| 기준 | 추천 BK |
|------|---------|
| ICD `^M77\.0` / `^M77\.1` | BK2101 |
| ICD `^T75\.2` | BK2103 |
| 상병명 `점액낭염` | BK2105 |
| 상병명 `주관증후군`/`척골신경`/`단신경병증` | BK2106 |
| 상병명 `진동성 팔꿈치`/`팔꿈치 골관절염`/`박리성 골연골염` | BK2103 |
| 상병명 `상과염`/`테니스 엘보`/`골프 엘보`/`부착부 건병증` | BK2101 |

사용자는 `bkSelectionMode = 'manual'`로 수동 덮어쓰기 가능.

#### BK유형 그룹 자동 동기화 (v6.2.1)

같은 직업 내에서 `selectedBkType`이 동일한 상병 엔트리들은 화면에서 하나의 카드(`BkGroupCard`)로 묶여 대표값(가장 많이 채워진 entry)만 표시된다. 신규 진단이 그룹에 합류(자동추론)하거나, 개별 카드에서 BK유형을 처음 수동 선택하거나, 진단코드 수정으로 자동추론 BK유형이 바뀌는 세 경로 모두에서 `syncElbowModuleData`/그룹 UI가 그룹 내 최고 점수(가장 많이 채워진) entry를 donor로 찾아 해당 진단의 **실제 저장값**을 즉시 동기화한다(`bkAutoSyncedFrom` 마커). 이 동기화가 없으면 화면은 대표값이 채워진 것처럼 보이지만 개별 진단의 저장값은 비어있어 `isElbowAssessmentComplete`가 미완료로 판정하는 불일치가 발생한다.

---

### 4.5 손목 모듈 (wrist)

**평가 방법론:** 독일 산재보험 기준을 준용. 팔꿈치 모듈과 동일한 **Gate-and-Flag 판정** 메커니즘을 공유하되 손목에 특화된 직업병(BK) 유형과 분기별 조사 항목을 포함.

#### BK 4유형 분기

| BK 유형 | 질환 | 핵심 분기 지표 |
|---------|------|----------------|
| BK2113 | 수근관 증후군 | 고반복/고강도 손목 유지, 손목 굴곡/배측굴곡, 진동 노출 |
| BK2101 | 건초염 (방아쇠수지, 드퀘르벵 등) | 단조 반복, 강제 배측굴곡, 회내/회외 |
| BK2103 | 관절병증 / 박리성 골연골염 | 진동 공구, 파지/가압 |
| BK2106 | Guyon canal 증후군 / 압박성 신경병증 | 직접 압박/마찰/충격 원인 |

#### 데이터 구조 (Job × Diagnosis 2차원)

팔꿈치와 동일하게 `temporalSequence`(모듈 공통) 및 `jobEvaluations[].diagnosisEntries[]`(직업×상병 단위)를 사용하며, BK2113 전용 지표 등의 필드가 포함된다.

#### 신체부담 평가 및 결과 표현

팔꿈치 모듈과 유사하게 직업별 카드 내부에 상병 엔트리를 분리하고, 공통 게이트웨이 파라미터(시간/비중/형태 등)를 통과하면 Narrative 서술형 기반의 플래그 텍스트가 자동 정리되어 출력된다.

#### 자동 BK 매핑 (`inferWristBkTypeFromDiagnosis`)

| 기준 | 추천 BK |
|------|---------|
| ICD `^G56\.0` / 수근관증후군 | BK2113 |
| ICD `^M65\.(3\|4\|8)` / 방아쇠수지, 건초염 | BK2101 |
| ICD `^M19\.04` / 진동성, 관절염 | BK2103 |
| Guyon, 척골신경 병변 | BK2106 |

BK유형 그룹 자동 동기화(`syncWristModuleData`)는 팔꿈치 모듈(§4.4)과 동일하게 동작한다 (v6.2.1).

---

### 4.6 경추 모듈 (cervical)

**평가 방법론:** 독일 산재보험 BK2109 기반 경추 질환 부담 노출 평가. 팔꿈치/손목 모듈과 유사한 **Gate-and-Flag 판정** 방식을 사용하되, 어깨 하중 운반과 비중립·정적 목 부하 2가지 노출 유형을 평가한다.

#### 노출 유형

| 노출 유형 | 설명 | 핵심 기준 |
|-----------|------|----------|
| 어깨 하중 운반 (BK2109) | 어깨 위에 무거운 하중을 지고 운반하는 작업 | 하중 ≥40kg, 교대당 1시간 이상 |
| 비중립·정적 목 부하 | 장시간 목을 20도 이상 굴곡한 상태로 유지 | 1일 1.5~2시간 이상 |

#### 데이터 구조 (척추 tasks[] 패턴)

```
modules.cervical
└── tasks[]
    └── { id, name, exposure_types[],
          load_weight_kg, carry_hours_per_shift,
          forced_neck_posture, neck_nonneutral_hours_per_day,
          combined_flexion_rotation_posture,
          precision_work, notes,
          sharedJobId }   ← 직업력 연결 (shared.jobs[].id)
```

#### 신체부담 평가 (CervicalEvaluation + TaskManager + TaskEditor + CervicalResultPanel)

**좌측 패널 — 입력 (TaskManager + TaskEditor):**
- 직업이 2개 이상이면 직업별 탭으로 작업 분리 (척추 모듈과 동일 UX)
- 노출 유형 선택 (어깨 하중 운반 / 비중립·정적 목 부하)
- 유형별 세부 입력: 하중(kg), 교대당 운반 시간, 목 비중립 자세 시간(시/일), 복합 굴곡/회전 자세, 정밀 작업 등

**우측 패널 — 결과 (CervicalResultPanel):**
- 직업별 요약: 노출 유형, 주요 flag pill, narrative 서술, 종합평가 문장

**완료 판정 (`isCervicalAssessmentComplete`):** 경추 상병이 있고, 직업력이 있고, 상병별 상태·업무관련성 평가가 채워져 있으면 완료로 판정한다. 부담 작업(`tasks[]`)이 한 건도 없는 것은 "경추부담 작업 없음"이라는 유효한 상태이지 입력 누락이 아니므로, 작업이 0건인 직업은 완료 판정에서 자연히 제외된다(작업이 있는 직업만 필수 필드 완비 여부를 확인) — v6.2.3에서 이 기준이 화면 표시 로직과 어긋나 상병 평가를 다 채워도 영원히 미완료로 남던 버그를 수정.

#### 계산 로직 (`computeCervicalCalc`) — Gate-and-Flag

```
각 task에 대해:
  1) 노출 유형 확인: shoulder_heavy_load 또는 awkward_static_neck_load
  2) BK2109 하중 판정: load_weight_kg ≥ 40 → heavy_load_met
  3) 정적 목 부하 판정: neck_nonneutral_hours_per_day ≥ 1.5~2 → static_load_met
  4) narrative + conclusionText 자동 생성
  5) riskFactorItems: warning tone 플래그(4개)만 분리 (positive/info는 제외)
```

#### 자동 상병 매핑

| 기준 | 추천 |
|------|------|
| ICD `^M50` | 경추 |
| ICD `^M48\.02` | 경추 |
| 상병명 `경추`/`목디스크`/`척수병`/`myelopathy` | 경추 |

---

### 4.2 척추 모듈 (spine)

**평가 방법론:** 요추 압박력 MDDM(BK2108) + 전신진동(BK2110, v5.1.6+) — 두 평가가 한 모듈에서 **독립적으로 공존**

척추 모듈은 요추 압박력(MDDM)과 전신진동(BK2110) 두 평가를 함께 지원한다. 패널 상단 탭(`activeSpineTab`)으로 편집 대상을 전환하지만, **계산·출력은 둘 다 수행**된다 — `computeSpineCalc`가 MDDM(top-level 평탄 필드) + WBV(`calc.vibration` 서브객체)를 함께 반환하고, 종합소견·EMR·엑셀에 각각 별도 섹션으로 나간다. 각 평가는 3상태(`mddmStatus`·`vibrationExposureStatus`: `unknown`/`none`/`present`)로 수행 여부를 관리하며 **`present`일 때만** 결과·산출물에 표시된다(MDDM 기본 `present`, WBV 기본 `unknown`). 완료 판정은 `(MDDM 유효 ‖ WBV 유효) && 상병` — 둘 중 하나만 평가해도 완료. 하위호환은 `resolveMddmStatus`/`resolveVibrationStatus`가 처리(기존 MDDM 작업·1차 WBV intervals 보존).

#### 신체부담 평가 — MDDM (SpineEvaluation + MddmEvaluation + TaskManager + TaskEditor + SpineResultPanel)

**좌측 패널 — 입력 (SpineEvaluation + TaskManager + TaskEditor):**
직업력이 2개 이상이면 직업별 탭을 표시하여 작업을 직업별로 관리. 각 작업(task)은 `sharedJobId`로 특정 직업에 연결된다. 신규 환자 생성 시 기본 작업 1개가 자동 생성됨.

| 항목 | 설명 |
|------|------|
| 자세 코드 | G1~G11 (11가지 작업 자세 분류), 카테고리별 그룹: 들기(G1-G6), 운반(G7-G9), 들고 있기(G10-G11) |
| 자세 이미지 | 들기: From→To 쌍 이미지, 운반/들고 있기: 단일 이미지 (`public/images/`) |
| 중량물 무게 (kg) | 취급 하중 |
| 빈도 (회/일) | 일일 작업 반복 횟수 |
| 시간 | 1회 작업 소요 시간 (초/분/시) |
| 보정계수 | F1: 한 손 작업(×1.9), F2: 비대칭(×1.9), F3: 몸에서 멀리-약간 굴곡(×1.3), F4: 몸에서 멀리-심한 굴곡(×1.1) |

**우측 패널 — 결과 (SpineResultPanel):**
입력값에 실시간 연동되는 MDDM 결과 대시보드:
- Summary Cards: 최대 압박력(N), 일일 누적 용량(kN·h), 평생 누적 용량(MN·h)
- Risk Gauge: 위험도 시각화 (안전/주의/위험)
- Threshold Comparison: MDDM/법원/DWS2 기준 대비 progress bar
- 직업별 누적선량 내역 (2개 이상 직업 시): 직업별 일일선량/누적선량 + 합계
- 일일→평생 용량 산출 과정 상세 (단일 직업 또는 legacy)
- 작업별 압박력, 시간, 기여도 목록
- 업무관련성 평가 등급 + 기여도 바

#### 계산 로직 (`computeSpineCalc`)

```
척추압박력: F = b + m × L  (자세별 계수 b, m + 하중 L)
일일선량:   D_r = √(Σ F²·t / 8h) · 8h  (단위: N·h, 이후 /1000 → kN·h)
  ※ F ≥ 1,900N인 작업만 합산 (남녀 공통 기준)
  ※ t, 8h 모두 시간(hour) 단위로 통일 — 8h 기준 정규화 후 8h 재곱하여 1근무일 노출량으로 환산

직업별 누적노출량:
  for each job in shared.jobs:
    jobTasks = tasks.filter(t => t.sharedJobId === job.id)
    jobDailyDose = calculateDailyDose(jobTasks)
    if jobDailyDose < dailyDoseThreshold AND 모든 작업의 F < 4,000N:
      해당 직업 평생 누적 제외 (excluded)
    else:
      jobLifetimeDose = jobDailyDose × 연간근무일수 × 해당직업 근무년수
  totalLifetimeDose = Σ(각 직업의 lifetimeDose)  (MN·h)

  ※ dailyDoseThreshold (v5.1.5+ 버전별 분기):
      v5.1.3 공식 환자: 남 4.0 / 여 3.0 kN·h
      legacy 환자:      남 2.0 / 여 0.5 kN·h  (기존 임계치 보존)

일일 노출 중증도 (v5.1.5+ 새 공식 스케일, 정연한 비례 사다리 여=남×0.75):
  남성:
    고도:     일일 >8.0 kN·h  또는 최대압박력 ≥6,000N
    중등도상: 일일 >6.0 kN·h  또는 최대압박력 ≥5,000N
    중등도하: 일일 ≥4.0 kN·h  또는 최대압박력 ≥4,000N
    경도:     그 외
  여성:
    고도:     일일 >6.0 kN·h  또는 최대압박력 ≥6,000N
    중등도상: 일일 >4.5 kN·h  또는 최대압박력 ≥5,000N
    중등도하: 일일 ≥3.0 kN·h  또는 최대압박력 ≥4,000N
    경도:     그 외
```

**4,000N 규칙:** 작업 중 하나라도 압박력 ≥ 4,000N이면 일일 누적 용량이 임계치(버전별 dailyDoseThreshold)에 미달하더라도 평생 누적 용량 계산에 포함된다.

**하위 호환:** `sharedJobId`가 없는 기존 task는 첫 번째 직업에 자동 귀속. legacy 필드(`careerYears` 등)가 존재하면 기존 단일 계산 방식 유지.

**위험 배너 (`assessRisk`, v5.1.5+ 독일 법원(BSG) 단일 기준):** `comparison.court.percent` 직접 판정.
- `> 100%` → danger ("즉각적인 개선 필요", "독일 법원(BSG) 기준 초과")
- `80% ~ 100%` → warning ("작업 환경 개선 권고", "독일 법원(BSG) 기준 근접")
- `< 80%` → safe ("현재 수준 유지", "독일 법원(BSG) 기준 충족")

**업무관련성 판정 기준 (`assessWorkRelatedness`, v5.1.5+ 독일 법원(BSG) 단일 3단계):**

| 범위 (lifetimeDoseMNh) | 남성 | 여성 | 판정 |
|-----------------------|------|------|------|
| `> courtLimit` | > 12.5 MN·h | > 8.5 MN·h | 높음 (산재 적극 권고) |
| `courtHalf ≤ x ≤ courtLimit` | 6.25 ~ 12.5 MN·h | 4.25 ~ 8.5 MN·h | 불충분 (다른 요건 고려) |
| `< courtHalf` | < 6.25 MN·h | < 4.25 MN·h | 낮음 |

기여도(workContribution) 분모 = courtLimit. KPI 카드 "평생 누적 용량" 서브 텍스트도 `독일 법원(BSG) NN%`로 표시되고, 하단 3개 비교 카드(MDDM/독일 법원/DWS2)는 그대로 모두 노출되어 참고용으로 유지된다.

#### 전신진동 평가 — BK2110 (VibrationEvaluation + VibrationIntervalManager/Editor + VibrationResultPanel, v5.1.6+)

**평가 방법론:** 독일 BK2110(장기간 주로 수직 방향 전신진동 노출로 인한 요추간판 질환) 에너지형 진동노출 모델. 간이 모드 — 진동가속도 aw를 **최소~최대 범위**로 입력받아 하한·상한 시나리오를 구간으로 산출(단일 대표축 단순화, k계수 생략).

**입력 (직업별 진동 노출 구간):**

| 항목 | 설명 |
|------|------|
| 진동가속도 aw 하한/상한 (m/s²) | 대표 주파수가중 진동가속도의 범위 |
| 1일 노출시간 | 해당 작업의 하루 총 노출시간 (시간/분/초, 단위별 max) — MDDM의 1회시간×빈도와 다름 |
| 직업 연결 | 구간은 `sharedJobId`로 직업에 연결 (MDDM task와 동일 패턴) |

**계산 로직 (`computeVibrationCalc`):**

```
구간별:        A(8) = aw · √(T_시간 / 8h)
직업 내 다구간: A(8) = √( (1/8h) · Σ aw_i²·T_i )   (에너지합)
일일 지표:      Amax(8) = 직업별 에너지합 A(8)
평생 누적용량:  DV = Σ_직업 [ Amax(8)² · 근무일수 · 근속연수 ]   (Amax(8) ≥ 0.63일 때만 산입)

다중 직업:
  amax8 = { min: max_직업(직업별 amax8.min), max: max_직업(직업별 amax8.max) }  ← 직업별 최대(동시합 아님)
  dv    = Σ_직업 직업별 DV                                                    ← 직업 간 합산

범위(min/max): awMin·awMax 각각으로 하한·상한 Amax(8)·DV를 계산해 구간으로 제시
```

**판정 기준 (BK2110 공식):** 일일 `Amax(8) ≥ 0.63 m/s²`, 평생 `DV,RI = 1400 (m/s²)²`. 경계는 이상(`>=`). 구간 status — `safe`(상한도 미만) / `warning`(구간이 기준 걸침) / `danger`(하한도 이상). 위험도(`risk`)는 **평생 DV 기준**(일일은 DV 산입 게이트). 보조 참고값: 일일 조치값 0.5, z축 한계 0.8 m/s².

**입력 유효성:** 구간 유효 조건 `awMin ≥ 0 && awMax > 0 && awMax ≥ awMin && time > 0`. 위반(상한<하한 등) 구간은 invalid로 계산 제외 + 경고 노출, 완료 불가. 직업력 없으면 구간 추가 비활성. **참고표:** 입력 패널 하단에 장비별 진동가속도(aw) 범위 차트(`public/images/wbv-acceleration-chart.png`, 접기/펼치기) — aw 입력 가이드.

**결과 (VibrationResultPanel, `present`일 때만 표시):** 일일 Amax(8) 범위 / 평생 DV 범위 Summary, 0.63·1400 기준 대비 진행바(범위), 위험 배너, 직업별 내역.

**아키텍처:** 순환참조 회피를 위해 `convertTimeToSeconds`를 leaf util `time.js`로 분리. `vibrationCalc.js`(계산·`resolveVibrationStatus`·`isVibrationComplete`), `sectionText.js`(MDDM+WBV 단일 소스 텍스트 — reportGenerator·exportService 공용)로 구성. 일괄 엑셀(`generateBatchRows`)은 MDDM `present`일 때만 작업 행 생성.

---

## 5. 기본정보 공유 모델

### 5.1 인적사항 (섹션 1)

이름, 성별, 신장, 체중, 생년월일, 재해일자
BMI와 만 나이를 자동 계산하여 표시.

### 5.2 직업력 (섹션 2)

기존에 모듈별로 분산되어 있던 직업 정보를 **공통 영역으로 통합**:

- **카드 형식**: 복수 직종 입력 가능 (추가/삭제)
- **직종명**: 프리셋 검색(PresetSearch) 지원 — `job-presets.json` 기반 자동완성 + 커스텀 프리셋 통합 검색
- **기간**: 시작일/종료일 또는 수동 입력 ("5년 3개월")
- **연간 근무일수**: 기본값 250일
- **프리셋 적용**: 활성 모듈 전체에 프리셋 데이터 자동 채움 (무릎: weight/squatting/보조변수, 어깨: 5개 노출량, 척추: 작업 목록). 각 모듈의 `presetConfig.applyToModule()`이 데이터 형태에 맞게 적용
- **커스텀 프리셋 저장**: 현재 입력된 신체부담 데이터를 프리셋으로 저장 (PresetManageModal). 모듈별 체크박스 선택, 데이터 미리보기, 기존 커스텀 프리셋 삭제 지원
- **프리셋 저장소**: `presetRepository.js` — builtin(`job-presets.json`) + custom(localStorage/Electron FS) 이중 저장, 병합 로드, JSON 내보내기/가져오기
- **신체부담평가 포함/미포함**: 직력마다 `신체부담평가 [포함] [미포함]` 라디오(기본 "포함", `shared.jobs[].excludeFromAnalysis`). 미포함 직력은 6개 모듈의 평가 화면·결과·완료 판정과 통계의 신체부담 변수에서 빠지고(입력값은 삭제하지 않아 다시 "포함"으로 바꾸면 복원), 종합소견 미리보기·엑셀·EMR의 `[직업력]`에는 포함 직력 뒤 맨 끝에 `신체부담평가에는 미포함`을 붙여 남는다. 모든 직력이 미포함이면 모듈은 "평가 대상 없음"으로 완료 처리된다. 구형 직업 필드가 남은 환자는 미포함을 설정할 수 없다. 상세는 `docs/DOMAIN_SCHEMA.md` §9.4.

### 5.3 특이사항 (섹션 3)

자유 텍스트 입력.

### 5.4 평가기관 (섹션 4)

병원명, 진료과, 의사명 — 설정(Settings)에서 기본값 지정 가능.

---

## 6. AI 분석 기능

### 6.1 동작 방식

종합소견 이후 **통합 AI 분석 탭**에서 전체 모듈의 보고서 텍스트를 프롬프트로 AI API에 전송하고, 전문의 관점의 분석 결과를 받아 표시한다. **Google Gemini**(기본)와 **Anthropic Claude** 중 선택 가능.

### 6.2 AI 모델 선택

| 모델 | ID | 특징 |
|------|----|------|
| Gemini 2.5 Flash (기본) | `gemini-2.5-flash` | 빠름/저비용, maxOutputTokens 8192 |
| Gemini 2.5 Pro | `gemini-2.5-pro` | 정밀, maxOutputTokens 65536 (thinking 포함) |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | 빠름/저비용 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6-20250514` | 정밀 |

Gemini 2.5 Pro는 thinking(추론) 기능이 기본 활성화되어 비활성화 불가. thinking 토큰이 `maxOutputTokens` 예산을 공유하므로 65536으로 설정.

### 6.3 플랫폼별 분기

| 플랫폼 | 경로 | API 키 관리 |
|--------|------|-------------|
| 웹 (Vercel) | `POST /api/analyze` → 서버리스 → Gemini/Claude API | 서버 환경변수 `GEMINI_API_KEY`, `CLAUDE_API_KEY` |
| Electron | `window.electron.analyzeAI()` → IPC → main process | 사용자 입력 키 (설정 모달) |

모델 ID 접두사(`gemini` / `claude`)로 자동 분기. 웹 환경에서 Vite 개발 서버(`npm run dev`) 사용 시 `vercel dev`를 병행 실행해야 서버리스 함수가 동작한다. 에러 핸들링: API 에러 상세 메시지(`detail`)를 사용자에게 노출.

### 6.4 통합 시스템 프롬프트

무릎과 척추 전문 지식을 하나의 시스템 프롬프트에 통합:
- **무릎:** 신체부담정도 4단계, 신체부담기여도 공식, KLG 등급, 나이/BMI 개인적 요인 등
- **척추:** MDDM 공식, G1~G11 분류, DWS2/법원/MDDM 기준, 개선 권고 등

---

## 7. 내보내기 및 미리보기

### 7.1 통합 미리보기

모든 활성 모듈의 평가 결과를 하나의 텍스트 보고서로 통합 표시한다.
`generateUnifiedReport(patient)` (`src/core/utils/reportGenerator.js`)가 환자 전체 데이터를 받아 통합 보고서 텍스트를 생성한다.

**보고서 구조:**

```
업무관련성 특별진찰 소견서

이름: 홍길동(남)
키/몸무게: 175cm / 70kg (BMI: 22.9)
생년월일: 1970-01-01
재해일자: 2024-06-15 (만 54세)

[신청 상병]
#1. M17.0 원발성 슬관절증 (양측)
#2. M51.1 요추 추간판 장애 (-)

[특이사항]
-

[직업력 및 신체부담 평가]

1. 직업력
  직력1: 건설 배근공 | 5년 3개월
  직력2: 기계 조립원 | 3년

2. 신체부담평가

  <무릎 (슬관절)>              ← 무릎 활성 시만 표시
  직종: (직종명)
  일 중량물 취급량: (kg)
  일 쪼그려 앉기 시간: (분)
  보조변수: (해당 항목)
  무릎 부담 정도: (등급)
  + 기여도 + 누적부담

  <팔꿈치 (주관절)>            ← 팔꿈치 활성 시만 표시
  [공통 시간적 선후관계]        ← 모듈 1회 입력 + 주요 flag
  [직업별 상병 Summary]         ← BK 유형, 주요 flag, narrative, 종합평가 문장

  <어깨 (견관절)>              ← 어깨 활성 시만 표시
  BK2117 설명문 + 노출 유형별 누적 시간 / 임계값 / 비율
  ** 누적 신체부담 판정 (3단: 충분/복합노출 충분/불충분)
  [직력별 기여]                 ← 2개 이상 직업 시

  <척추 (요추)>                ← 척추 활성 시만 표시 (BK2108 해석)
  [직력별 평가 결과]            ← 2개 이상 직업 시 직업별 일일선량/누적선량
  [합산 결과] + [일일 노출 중증도(고도/중등도상/중등도하/경도)]
  [기준 비교] + [tiered interpretation]
    ↑ DWS2 / 독일 법원 / MDDM 각 기준 초과 여부에 따른 해석 문장 자동 생성

[종합소견]
상병별 판정 (무릎 활성 시 KLG/업무관련성 포함)

[특이 사항 메모]
...
```

**표시 위치:**
- 종합소견 스텝: 좌측 입력 + 우측 미리보기 (2패널 레이아웃)
- AI 분석: 통합 보고서 텍스트를 프롬프트로 사용 (통합 AI 탭)
- 각 모듈 신체부담 탭: 모듈별 결과 패널(KneeResultPanel, SpineResultPanel)이 우측에 표시

### 7.2 통합 Excel 내보내기

모듈별 개별 내보내기가 아닌 **단일 시트에 모든 모듈 결과를 통합**한 EMR 소견서를 출력한다.
`src/core/utils/exportService.js`가 통합 EMR 데이터를 생성한다.

**EMR 소견서 시트 구조 (단일 시트):**

| 항목 | 내용 |
|------|------|
| 1.신청상병명 | (비워둠) |
| 2.진료기록 및 의학적 소견 | (비워둠) |
| 3.최종 확인 상병명 | 종합소견에서 상병 상태를 "확인"으로 입력한 상병만 (양측 상병은 한쪽만 확인 시 (우)/(좌) 표기, EMR `txtAppv_Sick_Cont`와 동일) |
| 4.직업적 요인 | 직업력 + 모듈별 신체부담평가 통합 |
| 5.개인적 요인 | 키/몸무게/BMI/나이/특이사항 |
| 6.종합소견 | 기여도 + 상병별 종합소견 통합 (`txtSyth1Cont`, CP949 3,950byte 한도 — 초과 시 절단 + 전송 전 확인창, v6.2.0) |
| 7.특이 사항 메모 | 특이 사항 메모 (`returnConsiderations`) — 이 엑셀 행에만 실리고, EMR 직접입력(`generateEMRFieldData`/`txtArrv1Cont`)으로는 전송되지 않는다 |

**내보내기 형식 2종:**

각 버튼(현재/선택/전체)은 드롭다운으로 형식을 선택할 수 있다.

#### A. EMR 형식 (기존)

| 모드 | 함수 | 출력 |
|------|------|------|
| 현재 환자 | `exportSingle(patient)` | 단일 .xlsx 파일 다운로드 |
| 선택 환자 | `exportSelected(patients, selectedIds)` | .zip (선택된 환자별 .xlsx) |
| 전체 환자 | `exportBatch(patients)` | .zip (전체 환자별 .xlsx) |

파일명: `업무관련성평가_{이름}_{재해일}.xlsx`
ZIP명: `업무관련성평가_{N}명_{날짜}.zip` (동명 파일은 인덱스 접미사 부여)

#### B. 일괄입력용 서식

일괄 Import 템플릿과 동일한 flat table 형태로 환자 데이터를 내보낸다. 내보낸 파일을 다시 Import하면 원본 데이터가 복원되는 roundtrip을 보장한다.

| 모드 | 함수 | 출력 |
|------|------|------|
| 현재 환자 | `exportBatchFormatSingle(patient)` | 단일 .xlsx |
| 선택 환자 | `exportBatchFormatSelected(patients, selectedIds)` | 단일 .xlsx |
| 전체 환자 | `exportBatchFormatAll(patients)` | 단일 .xlsx |
| **빈 양식(상시)** | `exportBatchTemplate()` | 헤더만 있는 빈 .xlsx |

파일명: `일괄입력용_{이름 또는 N명}_{날짜}.xlsx` / 빈 양식은 `일괄입력_양식_{날짜}.xlsx`

**빈 양식 상시 제공 (v6.1.4):** 기존 내보내기 메뉴는 환자가 있을 때만 노출되어 처음 사용자가 작성용 양식을 받을 수 없었다. `exportBatchTemplate()`은 `buildBatchWorkbook([])`로 `BATCH_HEADERS`만 담긴 빈 양식을 만들며, **상단 툴바 "일괄입력 양식" 버튼**(환자 수와 무관하게 항상 노출 — `MainHeader`의 `ExportMenu`)과 **일괄 Import 모달의 "빈 양식 다운로드"** 두 곳에서 받을 수 있다. 받은 양식의 헤더는 일괄입력용 export와 동일하여 그대로 Import 가능.

**컬럼 구성 (75열):**
- 기본정보(6): 이름, 생년월일, 재해일자, 키, 몸무게, 성별
- 기관정보(3): 병원명, 진료과, 담당의
- 기타(2): 특이사항, 특이사항메모
- 상병(7): 진단코드, 진단명, 부위, KLG(우측), KLG(좌측), Ellman(우측), Ellman(좌측)
- 직업(7): 직종명, 시작일, 종료일, 근무기간(년), 근무기간(개월), 중량물(kg), 쪼그려앉기(분)
- 무릎 보조변수(6): 계단오르내리기, 무릎비틀림, 출발정지반복, 좁은공간, 무릎접촉충격, 뛰어내리기
- 어깨 노출(6): 오버헤드(시간/일), 반복중간(시간/일), 반복빠른(시간/일), 중량물횟수(회/일), 중량물시간(초/회), 진동(시간/일)
- 팔꿈치 시간적 선후관계/진단엔트리 공통/분기(31): 팔꿈치 모듈 데이터용 열들.
- 손목 시간적 선후관계/진단엔트리 공통/분기(n): BK2113 및 손목관련 추가 구조.
- 척추 작업(7): 작업명, 자세코드(G1-G11), 작업중량(kg), 횟수/분, 시간값, 시간단위(sec/min/hr), 보정계수

**행 생성 규칙:** 척추 작업과 팔꿈치 진단 엔트리를 직업별로 그룹핑하여 같은 직업의 항목이 해당 직업 행에 배치됨. 환자별 row 수 = max(1, 상병수, 직업-작업 쌍 수, 팔꿈치 직업×상병 pair 수). merge key(이름+생년월일+재해일자)는 매 행 반복. 팔꿈치 시간적 선후관계 4열은 환자 첫 행에만 채움.

### 7.3 PDF

무릎 모듈 활성 시 보고서 미리보기 영역을 html2pdf.js로 PDF 변환.

### 7.4 일괄 입력 (Batch Import)

`BatchImportModal`에서 엑셀 파일을 읽어 복수 환자를 일괄 등록 (75열 지원). 드래그 앤 드롭 영역(`.import-zone`)은 점선 테두리 + 아이콘 + 호버/드래그 하이라이트로 시각적 가독성 확보:
- 공통 필드 → `shared.jobs[]`
- 무릎 전용 → `modules.knee.jobExtras[]`
- 어깨 전용 → `modules.shoulder.jobExtras[]`
- 팔꿈치 → `modules.elbow.jobEvaluations[].diagnosisEntries[]` (행의 직종명 + 상병코드로 `sharedJobId`/`diagnosisId` 연결, BK 유형 미지정 시 `inferElbowBkTypeFromDiagnosis`로 자동 제안)
- 척추 작업 → `modules.spine.tasks[]` (작업명, 자세코드, 중량, 횟수, 시간값/단위, 보정계수)
- 같은 행에 직종명과 척추 작업이 모두 있으면 `sharedJobId`로 해당 직업에 자동 연결
- 기존 환자와 이름 중복 시 상병/직업/작업/팔꿈치 엔트리 추가 (병합)
- 척추 작업 데이터 존재 시 spine 모듈 자동 활성화, 팔꿈치 BK 엔트리 존재 시 elbow 모듈 자동 활성화

---

## 8. 상병 자동 매핑

`diagnosisMapping.js`에서 ICD 코드와 상병명을 분석하여 적합한 모듈을 자동 추천:

| ICD 코드 패턴 | 추천 모듈 |
|---------------|-----------|
| M17, M22, M23, M70.4, M76.5, S83 | 무릎 (knee) |
| M77.0, M77.1, T75.2 | 팔꿈치 (elbow) |
| G56.0, M65.3, M65.4, M65.8, M19.04 | 손목 (wrist) |
| M75, S43, S46, M19.01 | 어깨 (shoulder) |
| M50, M48.02 | 경추 (cervical) |
| M51, M54, M47, M48, M53 | 척추 (spine) |

상병명 키워드 매칭도 병행:
- 무릎: 무릎, 반월상, 십자인대, 관절경, 슬개골
- 팔꿈치: 팔꿈치, 외측/내측 상과염, 상과염, 테니스 엘보, 골프 엘보, 주관증후군, 점액낭염, 단신경병증, 진동성 팔꿈치 관절병증
- 손목: 수근관, 방아쇠, 건초염, 손목, 손가락, 수관절, Guyon, 손저림
- 어깨: 어깨, 회전근개, 극상근, 견봉하, 충돌증후군, 오십견
- 경추: 경추, 목디스크, 척수병, myelopathy
- 척추: 요추, 척추, 추간판, 디스크, 허리통증

---

## 9. 저장 및 복원

### 9.1 수동 저장/불러오기

- `localStorage` 기반 (키 접두사: `wrEvalUnified`)
- 저장명 지정, 덮어쓰기/추가 모드 선택
- 복수 환자 데이터를 하나의 세트로 관리

### 9.2 자동 저장

- 설정된 간격(기본 30초)으로 자동 저장
- 앱 재실행 시 자동 저장 복원 제안
- 수동 저장 후 자동 저장 타이머 리셋

---

## 10. 설정

| 항목 | 옵션 | 기본값 |
|------|------|--------|
| 테마 | light / dark | light |
| 글꼴 크기 | small(14px) / medium(16px) / large(18px) | medium |
| 병원명 | 자유입력 | 근로복지공단 안산병원 |
| 진료과 | 자유입력 | 직업환경의학과 |
| 의사명 | 자유입력 | 김호길 |
| 자동저장 간격 | 초 단위 | 30 |
| Gemini API Key | (Electron 전용) | - |
| Claude API Key | (Electron 전용) | - |

---

## 11. 디렉토리 구조

```
src/
├── main.jsx                             # React 엔트리
├── App.jsx                              # 메인 앱 (위자드 로직, 상태 관리)
├── index.css                            # 글로벌 스타일 (CSS Variables)
│
├── core/                                # 공유 프레임워크
│   ├── moduleRegistry.js               # 모듈 등록/조회 API
│   ├── components/
│   │   ├── BasicInfoForm.jsx            # 인적사항 + 직업력 + 특이사항 + 평가기관
│   │   ├── DiagnosisForm.jsx            # 상병 입력 (ICD 코드/이름/부위)
│   │   ├── AssessmentStep.jsx           # 종합소견 (공유 최종 스텝)
│   │   ├── AIAnalysisPanel.jsx          # Claude AI 분석 UI
│   │   ├── PresetSearch.jsx             # 직업 프리셋 검색 (자동완성, 모듈 배지 표시)
│   │   ├── PresetManageModal.jsx        # 커스텀 프리셋 저장/관리 모달
│   │   ├── BatchImportModal.jsx         # 엑셀 일괄 입력
│   │   ├── ModuleSelector.jsx           # 모듈 선택 UI
│   │   └── SettingsModal.jsx            # 설정 모달
│   ├── hooks/
│   │   ├── useAIAnalysis.js             # AI API 분기 (웹/Electron)
│   │   └── usePatientList.js            # 환자 목록 필터/정렬
│   └── utils/
│       ├── data.js                      # 데이터 모델, 마이그레이션
│       ├── workPeriod.js                # 근무기간 계산 유틸리티
│       ├── diagnosisMapping.js          # ICD → 모듈 매핑
│       ├── common.js                    # BMI, 나이 계산 등
│       ├── reportGenerator.js           # 통합 미리보기 텍스트 생성
│       ├── exportService.js             # 통합 EMR Excel 내보내기 (single/selected/batch)
│       ├── storage.js                   # localStorage 관리
│       └── platform.js                  # 플랫폼 추상화 (alert, confirm)
│   └── services/
│       └── presetRepository.js          # 프리셋 CRUD (builtin+custom 병합, 내보내기/가져오기)
│
├── modules/
│   ├── knee/                            # 무릎 모듈
│   │   ├── index.js                     # registerModule()
│   │   ├── KneeEvaluation.jsx           # 메인 컴포넌트
│   │   ├── components/
│   │   │   ├── JobTab.jsx               # 무릎 전용 신체부담 입력
│   │   │   ├── KneeResultPanel.jsx      # 무릎 결과 패널 (기여도/누적부담/직종별)
│   │   │   ├── AssessmentTab.jsx        # KLG/업무관련성 평가 (종합소견에서 사용)
│   │   │   └── PresetSearch.jsx         # (레거시, core로 이동됨)
│   │   └── utils/
│   │       ├── data.js                  # createKneeJobExtras, KLG 옵션 등
│   │       ├── calculations.js          # computeKneeCalc, 신체부담도
│   │       └── exportHandlers.js        # 보고서 생성, Excel 내보내기
│   │
│   ├── spine/                           # 척추 모듈
│   │   ├── index.js                     # registerModule()
│   │   ├── SpineEvaluation.jsx          # 메인 컴포넌트
│   │   ├── components/
│   │   │   ├── TaskManager.jsx          # 작업 목록 관리
│   │   │   ├── TaskEditor.jsx           # 작업 편집 (자세/하중/빈도)
│   │   │   └── SpineResultPanel.jsx     # MDDM 결과 대시보드 (summary/threshold/기여도)
│   │   └── utils/
│   │       ├── data.js                  # createTask, createSpineModuleData
│   │       ├── calculations.js          # MDDM 압박력/선량/노출량 계산
│   │       ├── exportHandlers.js        # 보고서 생성, Excel 내보내기
│   │       ├── formulaDB.js             # G1~G11 자세별 계수 (b, m)
│   │       └── thresholds.js            # 성별/기준별 판정 역치
│   │
│   ├── shoulder/                        # 어깨 모듈
│   │   ├── index.js                     # registerModule()
│   │   ├── ShoulderEvaluation.jsx       # 메인 컴포넌트
│   │   ├── components/
│   │   │   ├── JobTab.jsx               # 어깨 전용 신체부담 입력 (BK2117)
│   │   │   └── ShoulderResultPanel.jsx  # BK2117 누적 기준 비교 결과 패널
│   │   └── utils/
│   │       ├── data.js                  # createShoulderJobExtras, Ellman 옵션 등
│   │       ├── calculations.js          # computeShoulderCalc, BK2117 노출 계산
│   │       └── exportHandlers.js        # EMR Excel, PDF 내보내기
│   │
│   └── elbow/                           # 팔꿈치 모듈 (BK2101/2103/2105/2106)
│       ├── index.js                     # registerModule()
│       ├── ElbowEvaluation.jsx          # 메인 컴포넌트 (Job × Diagnosis 2차원)
│       ├── components/
│       │   ├── ExposureForm.jsx         # 직업별 카드 + 상병 엔트리 입력
│       │   ├── DiseaseSpecificFields.jsx # BK 분기별 세부 필드
│       │   └── ElbowResultPanel.jsx     # 공통 선후관계 + 직업/상병 Summary
│       └── utils/
│           ├── data.js                  # BK 옵션, jobEvaluations 싱크/마이그레이션
│           ├── calculations.js          # computeElbowCalc, Gate-and-Flag 엔진
│           └── exportHandlers.js        # EMR Excel (B5~B9), PDF 내보내기
│   ├── wrist/                           # 손목 모듈 (BK2113/2101/2103/2106)
│   │   ├── index.js
│   │   ├── WristEvaluation.jsx
│   │   ├── components/
│   │   │   ├── ExposureForm.jsx
│   │   │   ├── DiseaseSpecificFields.jsx
│   │   │   └── WristResultPanel.jsx
│   │   └── utils/
│   │       ├── data.js
│   │       ├── calculations.js
│   │       └── exportHandlers.js
│   │
│   └── cervical/                        # 경추 모듈 (BK2109)
│       ├── index.js                     # registerModule()
│       ├── CervicalEvaluation.jsx       # 메인 컴포넌트 (spine 패턴, tasks[] 기반)
│       ├── components/
│       │   ├── TaskManager.jsx          # 경추 작업 목록 관리
│       │   ├── TaskEditor.jsx           # 경추 작업 편집 (노출유형/하중/자세)
│       │   └── CervicalResultPanel.jsx  # 직업별 flag + narrative + 종합평가
│       └── utils/
│           ├── data.js                  # createCervicalTask, syncCervicalModuleData
│           ├── calculations.js          # computeCervicalCalc, Gate-and-Flag 엔진
│           └── exportHandlers.js        # EMR Excel, 엑셀 요약
│
api/analyze.js                           # Vercel 서버리스 (Gemini/Claude 프록시, standalone 모드)
electron/
├── main.js                              # Electron 메인 프로세스
├── preload-standalone.js                # standalone 빌드 preload
├── preload-intranet.js                  # intranet 빌드 preload (device 등록, 감사 서명) — v5.0.0
├── build-target.json                    # standalone | intranet 분기 설정 — v5.0.0
├── audit.js                             # Ed25519 device 키페어 + 감사 서명 — v5.0.0
├── auditQueue.js                        # 디스크 큐 (전송 실패 백업) — v5.0.0
├── migrationGate.js, migrationDataReader.js   # standalone → intranet 마이그레이션 — v5.0.0
└── emr-helper/                          # EMR 자동화 (C#)
public/
├── images/                              # G1~G11 자세 이미지
├── job-presets.json                     # 직업별 부담 프리셋 DB
└── icon.ico                             # 앱 아이콘
```

### 인트라넷 모드 추가 디렉터리 (v5.0.0)

```
server/                                  # API 백엔드 — Node 20 + TS + Express
├── Dockerfile
├── migrations/                          # 33개 SQL migration (0028~0033: 통계 워크벤치·완료 추적)
├── src/
│   ├── index.ts                         # Express 진입점, 두 개의 pg pool
│   ├── config.ts                        # env 검증
│   ├── middleware/                      # auth, audit, cors, rateLimit, security
│   ├── routes/                          # auth, patients, presets, workspaces, admin,
│   │                                    # audit, devices, ai, opsStatus, videoAnalysis,
│   │                                    # stats, capabilityGrants (v7.0.0)
│   ├── stats*.ts                        # 통계 워크벤치 서버 로직 — snapshot·dataset builder·카탈로그·
│   │                                    # 공개통제·비동기 큐(statsRunsQueue/statsRunAdmission)·엔진 호출·export
│   ├── jobs/                            # workspaceRetention 등
│   ├── db/                              # patientPersons, resolveAssignedDoctor
│   └── cli/                             # seedAdmin, runRetention, seedStatsTestPatients, runStatsRunCleanup
└── package.json

services/stats-engine/                   # 통계 Python 엔진 (v7.0.0) — analyze.py/protocol.py +
│                                        # descriptive/bivariate/correlation_matrix/regression/prediction.py
packages/analytics-core/                 # @wr/analytics-core (v7.0.0) — 공유 계산·카탈로그·completion
services/backup-monitor/                 # 백업 stale 감지 + alert 컨테이너
├── Dockerfile
├── index.js
└── __tests__/isStale.test.js

backup/Dockerfile                        # backup 사이드카 (postgres + gnupg + cron)
caddy/Caddyfile                          # HTTPS + 내부 CA

shared/contracts/                        # 클라이언트 ↔ 서버 공유 타입 (zod)
└── auth.ts, patient.ts, preset.ts, stats.ts(v7.0.0), index.ts

scripts/                                 # 운영 자동화
├── backup.sh, restore.sh, audit-partition.sh
├── backup-crontab, partition-crontab
├── export-offline-package.ps1           # 오프라인 패키지 생성
├── import-images.ps1 / .sh              # docker load 일괄
├── install-prod.ps1                     # Windows 자동 설치
├── set-build-target.mjs                 # standalone/intranet 빌드 토글
├── prebuild-shared.mjs, prebuild-analytics-core.mjs   # @wr/contracts·@wr/analytics-core 선빌드 (v7.0.0)
├── verify-chart-compat.mjs              # 통계 차트 구형 Chrome 호환 검사 (v7.0.0)
└── verify-csp.mjs

src/core/auth/                           # AuthContext, authChannel, session — v5.0.0
src/core/components/statistics/          # 통계분석 워크벤치 화면 — v7.0.0
src/core/components/charts/              # 통계 차트 SVG — v7.0.0
src/core/components/                     # AdminConsoleModal, LoginModal, ChangePasswordModal,
                                         # SignupRequestModal, AccountProfileModal,
                                         # ConflictResolveModal, MigrationReportModal — v5.0.0
src/core/hooks/                          # usePatientSync, useMigration, useServerConfig,
                                         # useOpsStatus, useAIAvailable — v5.0.0
src/core/services/                       # patientServerRepository, intranetWorkspaceRepository,
                                         # patientConflictResolution, localToServerMigrator,
                                         # httpClient, analysisClient — v5.0.0

docker-compose.yml                       # 기본 compose (dev + intranet 공통)
docker-compose.prod.yml                  # 프로덕션 오버레이 (포트 미노출, healthcheck)
.env.production.example                  # 프로덕션 env 템플릿
```

**총 소스 파일:** 38개 (23 .jsx + 15 .js) — standalone 기준. 인트라넷 모드 추가분은 server/ 50+ 파일, shared/contracts 10+ 파일, src/core/{auth,components,hooks,services}/ 30+ 파일.

---

## 12. 빌드 및 배포

```bash
npm run dev              # 개발 서버 (localhost:3000)
npm run build:web        # 웹 빌드 → dist/web/
npm run build:electron   # Electron 빌드 → dist/electron/
npm run electron:dev     # Electron 개발 실행
npm run electron:build   # Electron 패키징 (NSIS, Windows x64+ia32)
```

| 배포 대상 | 방법 |
|-----------|------|
| 웹 | Vercel CLI (`vercel --prod`) — `vercel.json`에 `outputDirectory: "dist/web"` 설정 필수 |
| 데스크톱 | electron-builder → NSIS 설치 파일 |

**Vercel 설정 (`vercel.json`):**
```json
{
  "outputDirectory": "dist/web",
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

**필수 환경변수:**
- `GEMINI_API_KEY` — Google Gemini API 키 (기본 AI 모델)
- `CLAUDE_API_KEY` — Anthropic Claude API 키 (선택)

Vercel 대시보드 또는 `vercel env add`로 설정.

---

## 12.A. 인트라넷 모드 (v5.0.0 신규)

병원 인트라넷 환경에서 다중 사용자 운영을 위한 풀스택 백엔드. standalone 모드와 동일한 평가 엔진을 사용하면서 데이터 저장과 인증을 서버로 위임한다.

### 12.A.1 시스템 구성

```
                   [클라이언트 PC들 (Electron 인트라넷 빌드)]
                                      │
                                      │  HTTPS (wr.hospital.local)
                                      ▼
                              ┌──────────────┐
                              │   Caddy 2    │  ── 내부 CA 자동 발급
                              │ reverse proxy│      leaf cert 자동 갱신
                              └──────┬───────┘
                                     │ 127.0.0.1:3001 (외부 미노출)
                                     ▼
                              ┌──────────────┐       ┌────────────────┐
                              │  app server  │◀─────▶│ PostgreSQL 16  │
                              │ (Node/TS)    │       │  + audit reader│
                              └──────┬───────┘       └────────┬───────┘
                                     │                        │
                       ┌─────────────┴───────────┐    ┌───────┴────────┐
                       │  backup-monitor         │    │ backup sidecar │
                       │  (stale 감지, alert)    │    │ (cron + GPG)   │
                       └─────────────────────────┘    └────────────────┘
```

### 12.A.2 데이터베이스 스키마 (migrations 0001~0033)

| Migration | 내용 |
|---|---|
| 0001 | 초기 스키마 (users, organizations, sessions, audit_logs, devices, ...) |
| 0002 | patient_records — 환자 데이터 JSONB + assigned_doctor |
| 0003 | workspaces — 자동 저장/스냅샷 |
| 0004 | custom_presets (초기) |
| 0005 | idempotency — POST 재시도 안전 |
| 0006 | patient_no audit retention 정책 |
| 0007 | workspace retention 정책 |
| 0008 | workspace snapshot 기본값 |
| 0009 | patient_persons — 환자 person identity 별도 테이블 |
| 0010 | custom_presets 사용자별 |
| 0011 | preset unique index |
| 0012 | user_signup_requests — 비로그인 가입 요청 → admin 승인 |
| 0013 | patient_owner 인덱스 |
| 0014 | assigned_doctor 컬럼 |
| 0015 | 기존 payload에서 assigned_doctor backfill |
| 0016~0021 | 작업 영상 분석(v6.0.0) — clip/job 상태·출처/파일상태·keypoints artifact·대표 프레임·골격 검수 overlay·recipe versioning |
| 0022 | 영상 분석 추론 디바이스(GPU) 토글 — 조직 단위 auto/cpu/cuda, job별 실행 디바이스 기록 |
| 0023 | 기존 private 프리셋을 조직 공개로 backfill(프리셋 조직 공유) |
| 0024 | `patient_locks` — 환자 단위 TTL lease lock |
| 0025 | 세션 영구 쿠키 여부 컬럼(Electron은 세션 쿠키) |
| 0026 | `sessions.family_id` — refresh rotation 계보 단위 logout |
| 0027 | 고아 `patient_persons` 정리("유령 등록번호" 해제) |
| 0028 | **통계 권한** — `capabilities`(5개 키) + `user_capability_grants`(복합 FK로 조직 무결성) (v7.0.0) |
| 0029 | 환자 완료시각 추적 컬럼(`server_observed_modules_complete_at` 등) (v7.0.0) |
| 0030 | 서버 검증 완료시각 `server_verified_modules_complete_at` (v7.0.0) |
| 0031 | `stats_runs` — 통계 실행 결과 영속화(종결 상태) (v7.0.0) |
| 0032 | `stats_runs.analysis_run_id` — export 조회 키 (v7.0.0) |
| 0033 | `stats_runs` 비동기 큐 — queued/running 상태·frozen_dataset·cancel_requested_at·requeue_count (CHECK 제약 재정의 포함) (v7.0.0) |

> 마이그레이션은 서버 기동 시 미적용분이 순차 자동 적용된다(`schema_migrations`). 0028~0033은 v7.0.0 업데이트 때 한 번에 적용되며, 업데이트 전 DB 백업을 권장한다.

### 12.A.3 API 엔드포인트

| 경로 | 메서드 | 역할 |
|---|---|---|
| `/api/auth/login` | POST | 로그인 (JWT 발급, must_change_password 응답 포함) |
| `/api/auth/refresh` | POST | refresh token으로 access token 재발급 |
| `/api/auth/logout` | POST | refresh token 무효화 |
| `/api/auth/change-password` | POST | 비밀번호 변경 (must_change_password 해제) |
| `/api/auth/signup-request` | POST | 비로그인 가입 요청 |
| `/api/devices/register` | POST | Electron device 등록 (pending 상태로 insert) |
| `/api/patients` | CRUD | 환자 CRUD + 충돌 감지 (updated_at 기반 ETag) |
| `/api/presets` | CRUD | custom 직업 프리셋 |
| `/api/workspaces` | CRUD | 자동 저장 / 스냅샷 |
| `/api/audit` | POST | Electron 서명 감사 로그 수신 |
| `/api/admin/users` | CRUD | (admin) 사용자 관리 |
| `/api/admin/devices/:id/approve` | POST | (admin) device 승인 |
| `/api/admin/audit` | GET | (admin) audit log 조회 (read-only role) |
| `/api/admin/signup-requests` | CRUD | (admin) 가입 요청 처리 |
| `/api/ops/backup-status` | GET | 백업 상태 조회 |
| `/api/ai` | POST | Gemini/Claude 프록시 (서버 환경변수 키 사용) |
| `/api/stats/*` | GET/POST | 통계분석 워크벤치 (v7.0.0) — catalog·preview·analyze·runs·export, 상세는 §12.C.9. 기본 비활성(404) |
| `/api/capabilities/*` | GET/POST | capability 정의·내 grant 조회, (admin) grant 부여·회수 (v7.0.0) |

### 12.A.4 인증 / 세션

- **JWT**: ACCESS_TOKEN_SECRET / REFRESH_TOKEN_SECRET (32 bytes hex 각각)
- **must_change_password**: admin이 신규 사용자 생성 시 `true` → 첫 로그인 시 강제 변경
- **비밀번호 정책**: 10자 이상, 영문 + 숫자 + 특수문자 1개 이상
- **bcrypt**: 12라운드
- **rate limit**: login에 적용 (`middleware/rateLimit.ts`)
- **CSRF**: csrfCookie 유틸리티 (renderer 측, 인트라넷 모드만)

### 12.A.5 Electron Device 등록 / 감사

**Device 등록 흐름** (`electron/audit.js`)
1. 앱 첫 실행 → `initAudit()`이 Ed25519 키페어 생성 후 `wr-device.json`에 저장
2. 로그인 시 `setAccessToken` IPC → `tryRegister()` 호출 → `POST /api/devices/register`
3. 서버는 `pending` 상태로 insert (admin 승인 대기)
4. 관리자가 `POST /api/admin/devices/:id/approve` 호출 → `active`로 업데이트
5. `flushQueue` (5분 간격)에서 pending이면 `tryRegister()` 재시도 → 승인 후 자동 갱신

**감사 로그 서명**
- 모든 사용자 액션은 device 개인키로 Ed25519 서명
- canonical message: `{deviceId}.{ts}.{nonce}.{sortedBodyJson}`
- 서버는 `devices.public_key`로 검증, 통과 시 `audit_logs` 파티션에 insert
- 네트워크 실패 시 `auditQueue` (디스크 큐)에 저장 → `flushQueue`에서 재전송

**EMR 접근 제어**
- IS_INTRANET_BUILD + EMR 호출 → `audit.getDeviceStatus()` 검사
- `status !== 'active'`이면 EMR helper 호출 거부 (pending: 승인 대기 메시지)

### 12.A.6 백업 / 복구

**백업** (`scripts/backup.sh`, daily cron)
1. `pg_dump --format=custom` → plaintext dump
2. `gpg --encrypt --recipient $BACKUP_GPG_RECIPIENT` → `.dump.gpg`
3. `/backups/daily/wr-backup-{RUN_ID}.dump.gpg` + `_status/`, `_alerts/` 갱신
4. 성공 시 resolved alert 자동 prune, 실패 시 `_alerts/FAILED_{RUN_ID}.json` 생성

**모니터링** (`services/backup-monitor`)
- 매시간 `_status/backup-status.json` + `_alerts/*.json` 점검
- stale (마지막 성공 24h 초과) 시 alert 생성
- `/api/ops/backup-status`로 admin 콘솔에 노출

**복구** (`scripts/restore.sh`)
- 2인 인가 (`RESTORE_AUTH_TICKET` 필수)
- `GPG_PASSPHRASE` env 지원 (passphrase 있는 키 대응) — 단 권장은 복구 전용 passphrase-less 키 사용
- 임시 DB 컨테이너에서 복원 → row count 검증 → 운영 DB는 별도 절차로 교체

**복구 전용 GPG 키 정책**
- production `wr-prod_backup_gnupg` volume에는 **공개키만** 보관
- 개인키(`wr-backup-restore-private.asc`)는 USB 등 오프라인 매체에 별도 보관
- 운영 데이터는 패키지에 포함하지 않으며, secret도 패키지에 포함하지 않고 example만 제공

### 12.A.7 데이터 마이그레이션 (standalone → intranet)

기존 standalone 사용자가 인트라넷 모드로 전환 시:

1. **MigrationGate** (`electron/migrationGate.js`): 인트라넷 모드 첫 진입 시 사용자 데이터 디렉터리에 standalone 데이터가 있는지 확인
2. **migrationDataReader**: `wr-eval-data/patients/*.json`, `saved/*.json` 읽기
3. **localToServerMigrator** (`src/core/services/`): 환자 데이터를 서버 스키마로 변환 후 `/api/patients`로 일괄 업로드
4. **MigrationReportModal**: 성공/실패/스킵 항목 리포트, 사용자가 결과 확인 후 확정
5. 확정 후 standalone 데이터는 보존 (재실행 시 다시 마이그레이션되지 않도록 flag 저장)

### 12.A.8 실시간 동기화 / 충돌 해결

- **usePatientSync**: 인트라넷 모드에서 환자 목록을 주기적으로 폴링 + 다른 사용자의 변경 감지
- **patientConflictResolution**: 동일 환자를 다른 클라이언트에서 동시 편집 시 충돌 감지
  - 서버는 `updated_at`을 ETag로 사용 → PUT 시 `If-Unmodified-Since` 검증
  - 충돌 시 409 응답 → 클라이언트에서 ConflictResolveModal 표시
  - 사용자 선택: mine (내 버전으로 덮어쓰기) / theirs (서버 버전 적용) / merge (필드별 수동 병합)

### 12.A.9 관리자 콘솔 (AdminConsoleModal)

탭 구성:
1. **사용자 관리** — CRUD, 역할 변경, 비밀번호 리셋
2. **기기 관리** — pending device 승인/거부, active device 목록
3. **감사 로그** — `wr_audit_reader` read-only role로 조회, 필터 (action, user, date range)
4. **백업 상태** — 마지막 백업 시각, 성공/실패, alert 목록 (해결 처리)
5. **가입 요청** — signup-request 승인/거부
6. **통계 권한** (v7.0.0) — `/api/capabilities/grants` 기반 grant 부여·회수(사유 필수, 만료 선택)

### 12.A.10-A 환자 권한 정책 (v5.1.0 추가)

- **수정/삭제 권한**: 담당의(`assigned_doctor_user_id`) 또는 admin만 가능. 타 의사 환자는 조회만 허용
- **서버 미들웨어** `assignedDoctorOrAdmin` — `PATCH/DELETE /api/patients/:id`에 적용. 다른 org는 404(존재 누설 방지), 비담당은 403
- **클라이언트 헬퍼** `canEditPatient` / `canDeletePatient` — 로컬 모드는 단일 사용자라 항상 true, redacted는 항상 false
- 신규 환자 생성 시 doctor 세션이면 `assignedDoctorUserId` 자동 mirroring → sync 전에도 본인 환자 정상 수정
- 동기화 시 403 받은 환자는 빨간 배너 표시, 정상 sync 시 자동 해제
- StepContent 평가 영역: 비담당 환자는 capture-phase 이벤트 핸들러(클릭/키보드/입력/붙여넣기/드롭)로 편집 상호작용만 차단 — 텍스트 선택(복사)·스크롤은 허용 (v6.1.6, 이전엔 HTML `inert`로 감싸 복사·스크롤까지 막았음)

### 12.A.10-B Workspace Autosave 정책 (v5.1.1 추가)

인트라넷 모드에서는 서버 patient sync가 단일 진실원(single source of truth)이므로 로컬 workspace autosave를 비활성화.

- `workspaceAutosavePolicy` 헬퍼 (`src/core/utils/workspaceAutosavePolicy.js`) — `isIntranetWorkspaceMode`, `shouldUseWorkspaceAutosave`
- `useWorkspacePersistence`: 복구 effect가 `autosaveEnabled` 단일 의존성 기반, 인트라넷에서는 건너뜀
- `workspaceRepository`: load/save autosave에 인트라넷 가드 추가 (clear는 모드 전환 cleanup 위해 유지)
- 로컬 모드 autosave UX는 변경 없음

### 12.A.10 오프라인 배포 패키지

`scripts/export-offline-package.ps1`로 생성. 자세한 명세는 [docs/OFFLINE_DEPLOYMENT_PACKAGE.md](OFFLINE_DEPLOYMENT_PACKAGE.md) 참조.

**구성:**
- Docker 이미지: app, backup-monitor, backup + 베이스 (postgres:16-alpine, caddy:2-alpine)
- Electron 인스톨러: `직업성 질환 통합 평가 프로그램 Setup {VERSION}.exe`
- compose 파일, Caddyfile, 스크립트, 문서
- SHA256SUMS, release-manifest.json

**보안 가드:**
- `.env`, `.env.production` 실제 시크릿 파일은 패키지에서 제외
- private GPG key (`wr-backup-private.asc`, `wr-backup-restore-private.asc`)는 제외
- 운영 데이터, DB dump, volume snapshot 절대 미포함
- 시크릿 누출 가드(`Secret leak guard`) 단계가 export 스크립트에 자동 통합

### 12.A.11 T46 프로덕션 릴리즈 리허설 (v5.0.0)

**리허설 7개 섹션 (전 PASS):**

| 섹션 | 항목 | 핵심 검증 |
|---|---|---|
| 1 | Production 환경 분리 | `wr-prod_*` volume 격리, 포트 미노출 |
| 2 | 오프라인 패키지 무결성 | SHA256SUMS, secret 미포함, Electron 인스톨러 포함 |
| 3 | Admin 초기화 | seedAdmin 비대화형 파이프 입력, must_change_password 플로우 |
| 4 | Device 등록 / 승인 | doctor01 로그인 → pending → admin 승인 → active 자동 인식 |
| 5 | 백업 | pg_dump + GPG 암호화 성공, monitor "ok" |
| 6 | 복구 리허설 | 임시 DB에서 GPG 복호화 + pg_restore, row count 일치, 운영 DB 무영향 |
| 7 | 롤백 dry-run | `WR_VERSION=4.2.0`으로 compose config 검증, 파괴 명령 미실행 |

**리허설 중 발견된 개선 항목 (모두 fix 완료):**

| 항목 | 조치 |
|---|---|
| alert resolve 권한 (500 에러) | `backup.sh`의 `write_json_atomic`에 `_alerts/` 경로 감지 시 `chown 1000:1000` 추가 |
| GPG 개인키 passphrase | `restore.sh`에 `GPG_PASSPHRASE` env 지원 + 복구 전용 passphrase-less 키 발급 가이드 |

---

## 12.B. v5.1.x 운영 개선 (2026-05-20)

### 12.B.1 v5.1.0 — 다중 사용자 운영 UX 강화 + 권한 정책 + 척추 개선

v5.0.0 인트라넷 백엔드 도입 후 실제 운영에서 드러난 권한 미비점과 UX 결함 정리.

**환자 권한 정책 (서버 + UI)**
- `assignedDoctorOrAdmin` 미들웨어 → `PATCH/DELETE /api/patients/:id` 보호
- `canEditPatient` / `canDeletePatient` 클라이언트 헬퍼, `inert` 속성 차단
- 신규 환자 생성 시 담당의 `assignedDoctorUserId` 자동 mirroring

**대시보드 scope 분리**
- "내 환자 통계" ↔ "전체 통계" 토글 (인트라넷 + 로그인 시만 노출)
- 'mine' 전용: "내 미완료 평가 건수" / 'all' 전용: "의사별 환자 수 Top 5"

**다중 사용자 UX**
- 6개 차단 화면에 "로컬 모드로 전환" 버튼 (서버 장애 탈출구)
- 랜딩에 "환자 목록 보기" 버튼, 로그인 사용자 배지
- 인트라넷에서 "초기화" 버튼 숨김

**척추 모듈 개선**
- 수직분포 / 동반 척추증을 **첫 spine 진단에만** 표시, 첫 진단 삭제 시 값 자동 이송
- **작업 드래그앤드롭** — 같은 직업 탭 내에서 순서 변경 (id 기반, 선택 유지, 방향 인식 drop indicator)

**Caddy 호스트 포트 변경**
- 호스트 포트 80/443 → **8080/8443** (컨테이너 내부는 80/443 유지)
- `CORS_ORIGINS`, `.env.production.example`, 문서 전반에 `:8443` 반영

**검증**: 클라이언트 299 + 서버 369 = 668 tests pass.

**신규 문서**: `docs/UPDATE_5.1.0.md` — v5.0.x → v5.1.0 현장 업데이트 절차서 (예상 다운타임 ~10초, 롤백 무손실)

### 12.B.2 v5.1.1 — 진단별 모듈 수동 지정

자동 매핑이 실패한 진단을 모듈에 수동으로 지정할 수 있도록 정책과 UI 통합.

**진단 모델 + 매핑 정책**
- 진단에 `moduleId` 필드 추가 (`null`=자동, `'knee'/'spine'/...`=수동, `'__none__'`=해당 없음)
- `resolveDiagnosisModule()` 우선순위 단일화: `__none__` → 수동 → 자동 hint → 단일 활성 모듈 fallback
- 모든 모듈 필터를 `resolveDiagnosisModule` 기반으로 통일 (수동 지정만 하면 해당 모듈 즉시 노출)
- `MODULE_LABELS` export + `isValidDiagnosisModuleId()` 헬퍼로 유효성 기준 일원화
- 정책 회귀 보호 단위 테스트 7건 추가

**UI**
- 진단 카드에 "평가 모듈" 드롭다운 추가 — "자동 (감지: 무릎)" / 등록 모듈 / "해당 없음"
- 수동 지정 시 진단 배지에 `· 수동` 표시
- 척추/경추 수동 지정 시 방향 라디오 자동 숨김
- `IntakeWizard` 완료 시 진단의 명시 `moduleId` → `selectedModules`에 자동 병합
- `updateDiagnoses`가 수동 지정 모듈을 `activeModules`에 자동 추가 (기존 데이터 보존)

**자동 매핑 키워드 보강**
- `족관절|발목` → knee 임시 흡수 / `척골` → wrist

**인트라넷 Workspace Autosave 비활성화**
- 인트라넷에서는 서버 patient sync가 단일 진실원이므로 로컬 autosave 복구 흐름 비활성화
- `workspaceAutosavePolicy` 헬퍼 신설, `useWorkspacePersistence` + `workspaceRepository` 가드 추가

### 12.B.3 v5.1.2 — 대시보드 통계 확장 + 최근활동 timestamp 계약 정리

서버 모드 전환 후 노출된 최근활동 회귀 버그를 데이터 계약 차원에서 고치고, 대시보드 통계 카드를 의미 있게 확장.

**최근활동 timestamp 계약 (서버↔클라이언트)**
- 증상: 서버 모드에서 그날 작업한 환자가 다음 날에는 사라지고 옛 환자가 다시 최근활동 상단에 올라오는 회귀 (로컬 전용일 때는 없던 증상)
- 원인: 서버 `toResponse()`가 top-level `updatedAt`을 응답에 포함하지 않아 payload에 박힌 stale 값(또는 부재)으로 인해 클라이언트가 등록일 기준으로 폴백 정렬
- 서버 수정: `toResponse()`가 `...base` 다음에 `createdAt`(payload 우선, 없으면 DB `created_at`) + `updatedAt`(무조건 DB `updated_at`)을 명시적으로 덮어쓰도록 변경
- 클라이언트 수정: `getRecentActivityTimestamp` 헬퍼 신설 (`updatedAt → _savedAt → createdAt` 폴백, `sync.lastSyncedAt`은 동기화 시각이라 의도적으로 제외, `Date.parse()` 숫자 비교)
- `touchPatientRecord`가 모든 환자 변경 진입점에서 `updatedAt`을 일관 set하도록 보강 (이전엔 caller마다 책임이 비대칭이었음 — BatchImport, EMR sync 등에서 누락)
- 회귀 테스트: 서버 라우트 3건(top-level 포함 / stale 덮어쓰기 / createdAt 폴백) + 클라이언트 dashboardStats 4건 + GET /:id 계약 1건

**대시보드 카드 확장**
- 헤더 통합: 로그인 계정 배지를 LandingScreen에서 Dashboard 헤더의 중앙으로 이동 (좌 spacer / 중앙 배지 / 우 scope 토글 3영역 그리드)
- "내 환자" scope 카드 교체: 기존 "내 미완료 평가" → **"내 환자 평가 완료율"** (`72%` + `완료 18 / 총 25` 보조). 진행중 카드와의 중복 해소
- 신규 카드 5종 (전체·내환자 모두 적용):
  1. **성별 비율** — SVG 도넛 차트, 가운데 총 환자 수, 각 세그먼트 위에 `남 60%` 식 라벨 직접 표시 (외부 범례 없음)
  2. **평균 연령** — 전체/남/여 토글
  3. **연령대 분포** — 30대↓ / 40대 / 50대 / 60대 / 70대↑ 미니 막대, 전체/남/여 토글, 좌측 정렬
  4. **대표 직종 Top 5** — `jobs[0].jobName` 기준 ("환자 수"의 의미 보존, 모든 직력 합산 아님), 전체/남/여 토글
  5. **상병 Top 5** — `diagnoses[].code` 기준 (code 없는 항목 제외), 한 환자 동일 코드 중복 카운트 없음, 전체/남/여 토글
- `normalizeGender()` 헬퍼 — `M/F`, `남/여`, `male/female` 등 다양한 표기 정규화
- `computeAge()` 헬퍼 — `formatBirthDate` 재사용으로 YYYYMMDD도 처리, 비현실값(<0, >120) null
- `GenderToggleCard` 공통 컴포넌트, `Top5List` 헬퍼 (5행 고정 + placeholder)

**대시보드 레이아웃**
- `.dashboard-summary` 그리드: `repeat(auto-fit, minmax(200px, 1fr))` + `grid-auto-rows: minmax(170px, 1fr)` — 카드 수 증가에 자동 적응, 모든 카드 동일 높이
- 카드 컨테이너 `display: flex; height: 100%; justify-content: space-between` — 윗줄/아랫줄 미세한 높이 차 제거
- 기존 미디어쿼리 4건 제거 (auto-fit이 처리)

**테스트 버튼 가드 (인트라넷 비admin 차단)**
- LandingScreen: 인트라넷 + 비admin이면 버튼 자체 숨김 (UI 가드)
- `handleLoadTestData` 본체: 인트라넷 비admin은 early return, admin은 `showConfirm`으로 "목록 교체 + 서버 동기화 가능성" 안내 (이중 방어)
- 콘솔에서 함수 호출하는 우회 경로까지 차단

---

## 12.C. 통계분석 워크벤치 (v7.0.0 신규)

### 12.C.1 목적과 범위

대시보드(건수·월별 추이 등 운영 집계)와 별개로, 서버에 누적된 평가 데이터를 **연구 목적으로 분석**하는 화면·API. 직업환경의학 전문의가 "노출 변수와 업무관련성 판정/상병 소견의 연관성"을 검토하는 용도이며, 개별 환자의 판정을 예측·대체하는 도구가 아니다(개인별 판정 예측모형은 범위 밖).

| 구분 | 내용 |
|---|---|
| 포함 | 기술통계(Table 1 층화 포함), 이변량 검정 8종, 상관행렬, 회귀(OLS·이분 로지스틱), 예측(L2 로지스틱, 내부 검증), SVG 차트, 집계 결과 CSV |
| 제외(후속) | 행 단위·PHI 내보내기(PR5)와 step-up 재인증(PR5-B), 예측의 temporal holdout·subgroup 성능, 반복측정 쌍 검정 실행, 이변량·상관행렬 CSV, 카탈로그 잔여 필드 대량 롤아웃 |
| 제외(별도 연구) | 예측모형 외부검증 |

### 12.C.2 활성 조건과 배포 게이트

- 최종 가용성 = `STATS_WORKBENCH_ENABLED=true` **AND** `DEPLOYMENT_MODE=intranet` **AND** 통계 엔진 런타임 정상(`statsWorkbenchRuntimeState.ts`). 헬스 setter는 런타임 상태만 갱신하고 최종 값은 매번 배포모드·플래그와 AND로 재계산하므로 우회할 수 없다.
- 하나라도 어긋나면 `requireCapability`가 403이 아니라 **404**를 반환한다(기능 존재 자체를 노출하지 않음, `patientAccess.ts`의 cross-org 404 관례와 동일). 클라이언트는 `/api/config/public`의 `statsWorkbenchAvailable`로 버튼·Electron 메뉴 노출을 결정한다.
- 기본값은 `false`다. 활성화는 `.env.production`에 `STATS_WORKBENCH_ENABLED=true`를 추가하고 재기동하는 것으로 끝나며, 마이그레이션·이미지 변경은 활성화 여부와 무관하게 v7.0.0 업데이트에 포함된다([docs/UPDATE_7.0.0.md](UPDATE_7.0.0.md)).

### 12.C.3 권한 모델 (capability)

`researcher` 같은 역할을 추가하지 않고 **사용자별 권한 부여 테이블**을 둔다 — 개별 의사가 연구를 겸하는 경우를 역할로는 표현할 수 없기 때문(마이그레이션 0028). 판정 = **`capabilities.default_all_roles` ∪ 유효(미만료·미회수) `user_capability_grants`** (`requireCapability.ts`의 `hasCapability`).

| capability | default_all_roles | step-up | admin 역할 필요 | 현재 용도 |
|---|---|---|---|---|
| `stats.view` | true | – | – | 카탈로그·preview·화면 열람 |
| `stats.regression` | true | – | – | 분석 실행·폴링·취소(모든 분석 모드 공통 게이트) |
| `stats.export_results` | true | – | – | 저장된 집계 결과 CSV |
| `stats.export_limited_rows` | false | – | – | **응답 시점**에 제한 행데이터 필드 부착: 이상치 원값(`boxplot.outlierValues`), 산점도 원시 점(`scatter.points`), 회귀 관측치 진단값(`pointDiagnostics`), 원본 히스토그램(`rawHistogram` — bin 소수셀 게이트 없음, 변수 공개 조건만, 구간 경계는 보기 좋은 정수·소수 단위로 정렬되어 공개용과 다를 수 있음), 원본 범주 빈도(`rawLevels` — 범주별 게이트·"기타" 병합 없음, 변수 수준 조건만, 억제된 변수에도 부착). **기술통계(일반 + 담당의 층화)는 소수 셀(고유 인원 1~9명) 제한 자체를 풀어** 억제 없는 결과를 응답 시점에 재계산해 보낸다(`limitedDisclosure:'applied'`; 소수 담당의도 개별 그룹, total 강제 억제 없음, 결측 건수·결측 사유 분포 공개 — 이때 rawLevels는 `levels`가 이미 원본이라 붙지 않음). **회귀·이변량도 같은 방식으로 푼다**: 공개통제 ③(포함/제외 인원·레벨·상호작용·event 소수 셀)과 전체 N<10만 풀고 응답 시점에 재계산하며, 완전사례 30·EPV 10·rank 등 통계적 계산 가능 조건은 그대로라 소수 셀을 풀어도 표본이 모자라면 계산 불가 사유가 나온다. 풀고 보니 선택한 방법이 실행 불가면 `limitedDisclosure:'unavailable_method_not_executable'`로 집계본을 보낸다. 이변량은 쌍 게이트(포함/제외 인원)·A-2 방법 사유 가림·그룹/표 칸 n·제외 사유 상세·이상치 수·산점도 그리드의 소수 셀 판정을 풀되, 반복측정 게이트·그룹 수·표 차원·엔진 계산 불가는 유지하며 해제 후에도 결과가 없으면 `bivariate.unavailableReason`으로 사유를 보여 준다. 상관행렬은 성공 직후 원본 행(`frozen_dataset`)을 지우므로 조회 때 재계산할 수 없다 — 요청 시점에 제한데이터 권한자였던 실행(`requested_disclosure_profile='lift_eligible'`, `execution_digest` 입력이라 권한자·비권한자 캐시가 섞이지 않음)은 워커가 권한을 다시 확인한 뒤 엔진 1회로 일반본(`result`)과 해제본(`limited_result`, 마이그레이션 0037)을 함께 저장한다. 해제본은 일반 SELECT 컬럼 목록·CSV·캐시 hit 경로가 읽지 않으며, 조회는 조회자의 현재 권한을 확인한 뒤 조회 직후 한 번 더 확인하고 strict 감사를 쓴 다음에만 내보낸다(`statsStoredLimited.ts`). pair별 레이어1(포함/제외 인원)만 풀고 반복측정 게이트·엔진 계산 불가는 유지하며, 해제본의 억제 셀에는 `reasonCode`(`REPEATED_MEASURES_NOT_ALIGNED`/`NOT_COMPUTABLE`)가 붙고 남은 억제 셀이 있으면 `adjustedP`는 계속 비공개다. 해제본이 없는 적격 실행(워커 시점 권한 회수)은 `cacheable=false`로 종결해 캐시에 고착되지 않는다. 예측은 아직 해당 없음. 해제 수치는 `stats_runs.result`에 저장하지 않고(캐시-권한 드리프트 방지) 응답 직전 권한 재검사 후 감사(strict)와 함께 전달한다. differencing 제한 요청은 해제하지 않고, 해제에 필요한 원본(`frozen_dataset`)이 없는 실행은 `unavailable_source_missing`(재실행 필요). 관리자 콘솔 표시명 "제한 데이터 열람(원본 값·원본 분포)"(마이그레이션 0034→0035) |
| `stats.export_phi` | false | true | true | 예약 — 행 단위·PHI export는 미구현이라 노출 경로 없음 |

- 기본 허용 3종은 조직 소속 인증 사용자 전원이 **grant 없이** 사용한다. 기본 허용 권한은 grant를 회수해도 차단되지 않는다.
- grant 부여·회수는 관리자 콘솔 "통계 권한" 탭(`/api/capabilities/grants`)에서 하며 사유 필수·감사 로그 기록. 자기 자신에 대한 부여/회수도 허용되며 감사 로그에 `selfGrant`로 구분된다.
- 제한 필드를 부착한 응답은 별도 감사 로그(`limitedRowFieldsAttached`, 전달한 결과의 digest)를 남기고, 감사 로그 기록이 실패하면 응답 자체를 500으로 돌려보낸다.

### 12.C.4 아키텍처

1. **서버가 분석행을 만든다.** 클라이언트는 `AnalysisRecipe`(grain·변수 키·필터·분석 목적·모드·방법)만 보낸다. 브라우저가 만든 행은 조직 전체 포함 여부·revision·변조를 서버가 검증할 수 없기 때문이다.
2. **스냅샷**: `REPEATABLE READ`·`READ ONLY` 트랜잭션으로 조직 격리·soft-delete 배제 스냅샷을 읽고(`snapshotAsOf`), 레코드 구형식을 결정적으로 마이그레이션한 뒤 변수 계산 → 필터(AND) 순으로 데이터셋을 조립한다(`statsDatasetBuilder.ts`).
3. **공유 계산 패키지 `@wr/analytics-core`** (`packages/analytics-core`): 6개 평가 모듈의 공식·변수 추출·완료 판정을 클라이언트와 서버가 같은 코드로 import한다. 서버 이미지에는 `node_modules/@wr/analytics-core`로 vendoring된다. 레코드 완료 여부는 서버가 직접 재검증한다(`completion.ts` → `patient_records.server_verified_modules_complete_at`).
4. **canonical digest**: 키 정렬·NFC 정규화·-0/NaN 처리를 고정한 직렬화(`canonicalSerializer.ts`)로 recipe/source/result digest를 만들어 `stats_runs`에 manifest와 함께 저장한다(재현성·캐시 키).
5. **Python 통계 엔진**: app 이미지 안의 별도 venv(`/opt/stats-venv`)를 `execFile`로 spawn하는 단일 프로세스 트리(별도 컨테이너 없음). stdin/stdout JSON 프로토콜(`protocol.py`, `ENGINE_PROTOCOL_VERSION=6`), 기본 동시 1건·30초 타임아웃·SIGTERM→SIGKILL 유예 2초, 안전 타이머 초과 시 엔진을 degraded로 격리. 회귀 공분산(HC3·person-cluster CR1)·분리 판정(Konis LP)·rank 판정(one-sided Jacobi SVD)은 statsmodels가 아니라 `regression.py`가 직접 계산하고, statsmodels는 로지스틱 MLE·적합도 지표에만 쓴다. 예측은 numpy로 L2 로지스틱을 직접 구현한다(scikit-learn 미도입).
6. **의존성 고정**: `services/stats-engine/requirements.txt` — numpy 1.26.4 · scipy 1.13.0 · jsonschema 4.22.0 · statsmodels 0.14.2 · pandas 2.2.3 (pandas 상한 미고정 시 statsmodels와 충돌해 핀 고정).

### 12.C.5 데이터 모델 — 카탈로그와 grain

- **카탈로그**: 통합 83개 변수. `CATALOG_VERSION = v29-exclude-from-analysis`(analytics-core 81개) + 서버 확장 `v1-snapshot-columns`(DB 컬럼 변수 2개) → `INTEGRATED_CATALOG_VERSION = v29-exclude-from-analysis+v1-snapshot-columns`. 변수마다 타입(continuous/categorical/ordinal/date/high_cardinality/boolean)·단위·출처(raw/derived/clinician_judgment)·`availableAt`(pre_assessment/assessment/post_decision)·민감도·허용 분석 목적·공식 정책·`analysisRole`(analyzable/filter_only)·`predictionRole`(outcome/predictor)을 메타데이터로 가진다.
- **grain 3종**: `case`(사례 = 환자 1행) · `job`(직력) · `disease`(상병). grain을 늘리지 않고 3종으로 확정했다(`person` grain은 case와 계산·행 구성이 동일해 삭제). 하위 grain은 한 사람이 여러 행을 가질 수 있어 person 단위 집계가 필수이며, **case 변수는 하위 grain으로 브로드캐스트**된다(브로드캐스트는 필터 이전에 케이스 전체로 1회 계산).
- **롤업 변수**: 상병 any 판정(`diagnosis.rollup.anyHighRelatedness` — "true는 증거 하나로 확정, false는 전부 확인돼야 확정", 미판정이 섞이면 결측), 부위군 boolean 6종(`hasKnee`~`hasCervical`), `job.rollup.longestTenureYears`(대표 직력 공유), 어깨·경추·무릎 case 합계 변수(분/일·kg/일·시간 등).
- **공식 정책**: 파생 공식은 저장값을 읽지 않고 재계산한다(`recompute_current` / `recompute_recorded_version` / `stratify_by_version`). 손상된 원본 값은 결측 처리하며 엄격한 숫자 파서를 쓴다.
- **나이 변수**: 평가 시점 나이를 삭제하고 `patient.identity.ageAtInjury`(재해일자 기준 만 나이)로 교체했다(구 키 자동 치환 없음).

### 12.C.6 분석 모드

| 모드 | 방법·내용 | grain/제약 | CSV |
|---|---|---|---|
| 기술통계 | 연속형: n·평균·SD·중앙값·Q1/Q3·IQR·최소/최대·왜도·첨도·히스토그램·박스플롯, 범주형 빈도(비순서형 범주형을 단독 요청하면 소수 범주를 "기타" 하나로 합쳐 공개 — 아래 공개통제 참고), 결측 사유 분포(not_entered/not_assessed/not_applicable/structural_missing). **Table 1 층화**(`descriptive.stratifyByKey`): 담당의별/범주형 변수별, 층화 변수는 `variableKeys`에 넣을 수 없음, 소수 인원 그룹은 "기타"로 병합, **그룹 하나라도 억제되면 total도 새 객체로 교체**(그룹·total 차감 방지), 담당의는 UUID가 아니라 표시명으로 치환 | case/job/disease | 지원 |
| 이변량 | 실행 8종: `welch_t` · `mann_whitney` · `anova` · `kruskal_wallis` · `chi_square` · `fisher_exact` · `pearson_correlation` · `spearman_correlation`. `paired_t`·`wilcoxon_signed_rank`는 방법 카탈로그에 정의돼 있으나 **현재 실행 불가**(`PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING`) | **반복측정 게이트**: `personCount == rowCount`가 아니면 독립표본 방법을 `REPEATED_MEASURES_NOT_ALIGNED`로 불가 처리. 기타 사유: 변수 타입 불일치·표본 부족·그룹 수·2×2 아님·기대도수 부족(chi_square→fisher_exact 전환 제안) | 미지원(`BIVARIATE_EXPORT_NOT_SUPPORTED`) |
| 상관행렬 | 변수 C(k,2)쌍 Pearson/Spearman 일괄 + Benjamini–Hochberg FDR, 히트맵 | 변수 3개 이상 | 미지원(`CORRELATION_MATRIX_EXPORT_NOT_SUPPORTED`) |
| 회귀 | `ols_linear`(연속 outcome) · `binary_logistic`(boolean/2레벨 categorical outcome). 표준오차: person 중복이 없으면 HC3, 있으면 person-cluster CR1. 추정 3단 `ok`/`inference_withheld`/`non_estimable`(사유: 완전 행 부족·수준/파라미터 과다·파라미터당 사건 부족·상수 outcome·분산 0 predictor·rank 부족·`SEPARATION_DETECTED`·미수렴 등). 진단 플롯 4종(잔차·Q-Q·leverage·Cook's D)·VIF·condition number, 자연 3차 spline 부분효과, interaction, predictor 표준화 | 설계행렬 게이트(기준 레벨 3단 해석, EPV 분자는 사건 person 수) | 지원(계수·적합도·VIF·spline 곡선점; 관측치 진단값 제외) |
| 예측 | `l2_logistic` 1종 — Newton + step-halving, person 단위 grouped stratified K-fold CV — 외부 5-fold를 5회 반복, 내부 5-fold로 λ(로그 격자 26개) 선택과 OOF 평가를 분리 — 와 grouped bootstrap optimism 보정(Harrell, 200회). 지표: ROC-AUC(person bootstrap 1000회 95% CI)·PR-AUC·Brier·calibration intercept/slope, ROC·PR·calibration 곡선(세 곡선이 같은 구간 분할을 공유) | **지원 grain: case, disease**(job 제외, `PREDICTION_GRAIN_NOT_SUPPORTED`). outcome은 `predictionRole='outcome'`만(현재 `diagnosis.assessment.status`[disease]·`diagnosis.rollup.anyHighRelatedness`[case]). predictor는 raw 노출·인구학·평가 시점 임상소견만(`predictionRole='predictor'`); **공식 점수·`post_decision` 정보는 서버가 차단**. fold는 predictor와 무관한 기준 코호트(`cohortDigest`)에서 한 번 정해 person별로 상속(같은 사람이 train/test에 걸치지 않음). 최소 50명·사건 25명·비사건 25명·파라미터당 사건 10, 입력 상한 5000행·30열·파라미터 20개 미충족 시 `non_estimable`. **temporal holdout·subgroup 성능은 후속 필수**, 외부검증은 별도 연구 | 지원(집계, 계수 제외) |

회귀의 반복측정 처리와 이변량의 반복측정 게이트는 서로 다른 정책이다 — 회귀는 person-cluster 공분산으로 추정을 허용하고, 독립표본 이변량 검정은 행이 person과 1:1일 때만 허용한다.

### 12.C.7 공개통제·프라이버시

- **소수 셀 억제**: 최소 코호트 10명(person 단위) 미만 셀은 억제하며 부분 억제를 하지 않는다(하나라도 소수 셀이면 해당 결과 전체 생략). boolean은 결측률과 사건/비사건 분할을 연결해 억제한다.
- **히스토그램**: **공개 판정용** 원본 bin은 Node `buildOriginalHistogram`이 기준 구현이다(numpy `histogram`과 같은 공식·linspace 경계 연산 순서, 픽스처로 대조 고정). 해상도마다 "그대로 → 양 끝 소수셀 bin을 안쪽 이웃과 병합(person 합집합, 가운데 소수셀이 남거나 3구간 미만이면 실패)" 순으로 시도하고, 실패하면 lo~hi 균등 재분할(경계 배열 이진탐색)로 줄여가며(적응형 해상도, 하한값은 사다리에 항상 포함) 공개 가능한 가장 세밀한 것을 찾는다. 병합 bin은 `tailMerged`로 표시하고 화면에서 옅은 면·점선으로 구분한다. `stats.export_limited_rows` 권한자는 게이트를 거치지 않은 원본(`rawHistogram`)을 응답 시점에 받는데, 이 원본은 `buildOriginalHistogram`이 아니라 별도의 `buildNiceHistogram`으로 만들어 **구간 경계를 보기 좋은 값(폭 1·2·5×10^e의 배수)에 정렬**한다 — 같은 변수라도 공개용과 경계가 다를 수 있다. 폭은 공개용과 같은 목표 구간 수를 가장 가까운 보기 좋은 폭으로 반올림하고(클라이언트 `niceNumber`와 같은 임계값), 값이 전부 정수이거나 범위가 10 이상이면 폭 ≥ 1, 그보다 작은 비정수 범위는 소수 폭을 쓴다. 정수 데이터는 반개구간 `[k, k+1)`로 최댓값도 자기 구간을 갖고, 그 밖에는 마지막 구간만 양끝 포함한다. 정렬이 불가능하거나 검증(엄격 증가·데이터 덮음·구간 1~50)에 실패하면 균등분할로 폴백하고 그것도 유효하지 않으면 구간 수를 절반씩 줄여 어떤 입력에서도 폭 0 구간 없이 정의대로 센다. 화면은 경계 폭에 맞춘 단일 서식을 축·툴팁·표에 함께 쓰고, 가로축 눈금은 막대 경계에 두되 라벨의 좌우 범위가 겹치지 않게 솎는다.
- **범주형 소수 범주 "기타" 병합**: 범주 중 1~9명이 있으면 지금까지는 변수 전체를 억제했다(부분 억제 금지 — n·결측이 공개되어 빼기로 역산되므로). 다음을 모두 만족할 때만 소수 범주를 "기타" 하나(`other`)로 합쳐 공개한다.
  - 일반 기술통계 경로(`mergeSmallLevels` 옵션 — Table1 층화·이변량은 제외)
  - ordinal이 아님(등급 순서 보존)
  - **요청 변수가 그 범주형 하나뿐** — 다른 변수가 값이나 결측 분할로 "기타" 안을 쪼개 보여 주면 한 응답만으로 역산된다(상병 코드+부위군, `mddmStatus`+`lifetimeDoseMNh` 반례). 변수 사이 종속은 모듈마다 달라 변수 개수로 구조적으로 막는다.
  - 결측 인원이 1~9명이 아님
  
  "기타"의 인원은 person 합집합으로 세고, 1~9명이면 남은 범주 중 고유 인원이 가장 적은 것부터 끌어와 10명 이상으로 채운다. 그래서 "기타"는 10명 미만 범주뿐 아니라 채우려고 끌어온 공개 범주도 포함할 수 있고(화면·CSV 라벨 "공개 기준에 따라 병합한 범주 합계"), 권한자 원본을 표시할 때 최빈값도 원본 기준으로 다시 계산한다. 이름 붙은 범주가 2개 미만이 되면 억제한다(boolean 96/4 등). 최빈값은 "기타"를 제외하고 고르며, 동점이면 순서형은 더 낮은(경한) 등급·그 외는 값 문자열의 **코드유닛 순서**(localeCompare 금지 — 서버 로케일·브라우저 언어에 따라 갈려 서버/CSV와 권한자 원본 화면이 어긋난다)다. 권한자는 원본 범주 빈도(`rawLevels`)를 응답 시점에 받는다(변수 수준 게이트만 — 억제된 변수에도 부착, 캐시 미저장, 감사 기록). **알려진 잔여 위험**: 같은 변수를 필터를 바꿔 여러 번 조회해 빼는 차분은 조회 횟수 제한(15분 family 30회·사용자 100회)으로만 완화된다 — 이 병합은 새 공격 수단을 만들지 않지만 공개되는 변수가 늘어 적용 범위를 넓힌다(사용자가 환자 기록을 열람할 수 있는 의사로 한정된다는 전제로 수용, 근본 방어는 별도 설계 과제).
- **차분(differencing) 방지**: family(변수 조합)당 15분 창 30회, 사용자 전역 100쿼리 예산, 필터 값 종류 키당 10개 한도. 예산 초과 시 억제된다. 기술통계 + 필터 조합의 교차질의 차감 공격 방어는 범위 밖이며, 값/관계 기반 재설계는 별도 이니셔티브다.
- **요청 한도**: `POST /analyze` 사용자당 분당 20회(초과 429), 서버 동시 요청 `STATS_MAX_CONCURRENT_ANALYZE_REQUESTS`(기본 4).
- **제한 필드**: 이상치 원값·산점도 원시 점·관측치 진단값은 캐시된 결과에 저장하지 않고 **응답 시점에** `stats.export_limited_rows`를 확인한 뒤에만 부착한다(캐시 적중 응답도 동일). 권한 회수 즉시 노출이 사라진다.
- **감사**: 분석 실행·거부·내보내기·제한 필드 부착이 감사 로그에 남는다(결과 저장과 감사 기록은 원자적 트랜잭션).

### 12.C.8 비동기 실행 (마이그레이션 0031~0033)

`POST /analyze`는 먼저 동기로 실행하고(`STATS_ASYNC_SYNC_BUDGET_MS`, 기본 4초) 끝나지 않으면 **202 + `analysisRunId`**로 전환한다. 클라이언트는 `GET /runs/:id`를 폴링한다.

1. **admission**: 캐시 확인 → 진행 중 동일 실행에 합류 → quota/degraded 판정 → 예약(queued 행 생성). 사용자·조직별 동시/시간당 한도.
2. **claim/sweep**: 독립 루프가 queued 행을 claim하고(엔진 슬롯이 비어 있을 때만) heartbeat로 stale 실행을 회수한다. 재큐잉 상한 초과 시 실패 처리.
3. **finish**: `SELECT … FOR UPDATE` 재검증 후 종결 상태(succeeded/failed/cancelled)와 감사 기록을 한 트랜잭션으로 확정한다. 취소 요청은 항상 우선한다(`POST /runs/:id/cancel`).
4. 결과는 `STATS_RUNS_RESULT_TTL_HOURS`(기본 168시간) 후 서버가 주기적으로 정리한다(`jobs/statsRunCleanup.ts`, 기능이 켜져 있을 때만 동작; 수동 실행은 `server/` 디렉터리에서 `npm run cleanup:stats-runs`).

### 12.C.9 API

| 경로 | 메서드 | capability | 역할 |
|---|---|---|---|
| `/api/stats/catalog` | GET | `stats.view` | 통합 카탈로그(변수 메타데이터·`catalogVersion`) |
| `/api/stats/preview` | POST | `stats.view` | 건수·추정가능성·사용 가능 방법(`availableMethods`) — 억제 상태면 빈 목록 |
| `/api/stats/analyze` | POST | `stats.regression` | 분석 실행(200 즉시 완료 / 202 비동기 전환). 사용자당 분당 20회 |
| `/api/stats/runs/:analysisRunId` | GET | `stats.regression` | 폴링(`queued`/`running`/`succeeded`/`failed`/`cancelled`) |
| `/api/stats/runs/:analysisRunId/cancel` | POST | `stats.regression` | 취소 |
| `/api/stats/export` | POST | `stats.export_results` | 저장된 결과를 `analysisRunId`로 조회해 CSV로 포맷(재계산 없음, UTF-8 BOM) |
| `/api/capabilities/catalog` | GET | 인증 | capability 정의 목록 |
| `/api/capabilities/grants/me` | GET | 인증 | 내 grant |
| `/api/capabilities/grants` | GET/POST | admin | grant 조회·부여(사유 필수, 만료 선택) |
| `/api/capabilities/grants/:id/revoke` | POST | 인증(본인 또는 admin) | grant 회수(self-revoke 허용) |

### 12.C.10 화면 (`src/core/components/statistics/`)

- **진입**: 헤더·랜딩의 "통계분석" 버튼, Electron 메뉴 "통계분석 워크벤치"(IPC `set-stats-available`로 가용성을 main에 전파, `open-statistics`로 열기). `activeScreen` 단일 진실원으로 대시보드·평가 화면과 전환하며, 미저장 종합소견 편집 draft가 있으면 전환을 차단하고 안내한다.
- **4열 레이아웃**: 카탈로그(공통 변수 우선 정렬·그룹 접기·분석 목적 비호환 변수 비활성) · 레시피(grain·변수·필터 칩·결과변수/설명변수 역할·분석 모드/방법) · 결과(표·차트·주의문) · Inspector/리포트. 우측 패널은 4열 유지로 확정.
- **차트**(`src/core/components/charts/`, SVG): 히스토그램·박스플롯·수평 바·100% 누적 바·산점도·상관 히트맵·포레스트 플롯·잔차/진단 패널·spline 부분효과·ROC/PR/calibration 곡선. 키보드 접근 가능한 툴팁, 데이터 표 보기. 구형 Chrome 호환은 `npm run verify:chart-compat`로 검사한다.
- 서버 응답이 억제·비추정·권한 부족일 때는 이유를 화면에 안내한다(`describeStatsError.js`, `describeMethodReasonCode.js`).

### 12.C.11 운영 환경변수

| 변수 | 기본값 | compose 전달 | 설명 |
|---|---|---|---|
| `STATS_WORKBENCH_ENABLED` | false | O | 기능 전체 게이트(false면 `/api/stats/*` 404) |
| `STATS_ENGINE_TIMEOUT_MS` / `STATS_ENGINE_KILL_GRACE_MS` | 30000 / 2000 | O | 엔진 실행 타임아웃·종료 유예 |
| `STATS_ENGINE_MAX_CONCURRENCY` | 1 | O | Python worker 동시 실행 상한 |
| `STATS_MAX_CONCURRENT_ANALYZE_REQUESTS` | 4 | O | 요청 전체(스냅샷 포함) 동시 처리 상한 |
| `STATS_RUNS_RESULT_TTL_HOURS` | 168 | O | 결과 보존 시간 |
| `STATS_ASYNC_*`, `STATS_ENGINE_STDOUT/STDERR/MAX_INPUT_BYTES` | 코드 기본값 | **X** | compose가 전달하지 않아 코드 기본값으로 고정(튜닝하려면 compose `environment`에 추가 필요) |

배포 영향: app 이미지 크기 약 2.75GB(v6.5.4는 2.22GB), `/opt/stats-venv` 약 391MB(실측). 통계 엔진은 app 컨테이너의 메모리 6g·CPU 4 상한을 영상 분석과 공유한다.

### 12.C.12 개발 이력 (PR 계열)

| 계열 | PR | 내용 |
|---|---|---|
| PR0-A | #104 | capability 권한·완료시각 추적·기능 플래그 (0028·0029) |
| PR0-B1~B2 | #105~#106 | `@wr/analytics-core` 뼈대 → 6개 모듈 이관·completion.ts·coverage inventory (0030) |
| PR0-C | #107 | snapshot dataset builder + `GET /catalog` + `POST /preview` |
| PR1 | #108 | Python 통계 엔진 + `stats_runs` + `POST /analyze` (0031) |
| PR2 | #110 | 워크벤치 화면(4열) + 집계 export (0032) |
| PR3-A / PR3-B | #111 / #112 | 이변량 엔진 8종 + 공개통제 / 차트 6종 + 상관행렬 |
| PR0-B3 / B4 | #113 / #114 | 카탈로그 확장(grain 계약) / 대량 롤아웃·grain 3종 확정·히스토그램 공개통제 |
| – | #115 | 죽은 판정 변수 정리 + case-grain 롤업 3종 |
| PR4-A1 / A2 | #116 / #117 | 회귀(OLS·로지스틱) / 진단·spline·interaction·CSV |
| PR4-B1 / B2 | #118 / #120 | 비동기 job 인프라(0033) / 예측 |
| 폴리싱 | #121~#122, #125~#127, #129~#130 | UI 정합, Table 1 층화, case 합계 변수(어깨·경추·무릎), 필터 칩 제거, UX 개선 4건, 만 나이 교체(v28) |

---

## 13. 주요 개발 이력

### Phase 1: 코어 프레임워크 구축

- 플러그인 모듈 레지스트리 (`registerModule` API)
- 멀티 모듈 데이터 모델 (`shared` + `modules{}` + `activeModules[]`)
- 위자드 기반 UI (탭 → 스텝 전환)
- 상병 기반 모듈 자동 추천 (`diagnosisMapping`)
- 환자 목록 관리 (사이드바, 검색/필터/정렬/다중선택)

### Phase 2: 무릎 모듈 마이그레이션

- `wr-evaluation-claude` 코드 이식
- JobTab, AssessmentTab, KneeResultPanel 컴포넌트화
- 신체부담도 4단계 계산 로직 (`computeKneeCalc`)
- 보고서 생성 및 Excel 내보내기
- AI 분석 연동

### Phase 3: 척추 모듈 마이그레이션

- `mddm-vercel` Vanilla JS → React 변환
- MDDM 공식 DB (`formulaDB.js`) 및 판정 역치 (`thresholds.js`) 구조화
- TaskManager + TaskEditor UI
- 압박력/일일선량/누적노출량/업무관련성 계산 체인
- 보고서 생성 및 Excel 내보내기

### Phase 4: 공통 데이터 추출

- **직업력 통합**: 무릎 JobTab + 척추 평문 필드 → `shared.jobs[]` + 모듈별 extras
- `workPeriod.js` 유틸리티 추출 (기간 계산, 포맷, 파싱)
- `PresetSearch` 컴포넌트 코어로 이동
- `BasicInfoForm`에 직업력 섹션(섹션 2) 추가
- 프리셋 로딩을 App.jsx 레벨로 상승
- 데이터 마이그레이션 (`migrateJobsToShared`) 구현

### Phase 5: 종합소견 통합

- 무릎 종합소견 탭 + 척추 평가결과 탭 → 공유 종합소견 스텝으로 추출
- `AssessmentStep.jsx` 신규 생성 (모듈별 평가 내용 통합 렌더링)
- 결과 패널 간소화 (미리보기만 유지, 중복 지표 제거)
- `buildSteps()`에 공유 최종 스텝 자동 추가

### Phase 6: 통합 내보내기 및 미리보기

- 모듈별 분리 보고서 → 단일 통합 보고서로 통합 (`reportGenerator.js`)
- 모듈별 Excel 내보내기 → 단일 시트 통합 EMR 내보내기 (`exportService.js`)
- 내보내기 3모드: 현재 환자 / 선택 환자(ZIP) / 전체 환자(ZIP)
- AI 분석 프롬프트: 통합 보고서 텍스트 사용
- `[직업력]` → `[직업력 및 신체부담 평가]` 구조 변경 (직업력 + 모듈별 신체부담평가)

### Phase 7: 모듈별 결과 패널 복원

- 통합 미리보기를 종합소견 스텝으로 한정
- 무릎 신체부담 탭: `KneeResultPanel.jsx` 신규 생성 (원본 `wr-evaluation-claude` 기반, 기여도/누적부담/직종별 부담)
- 척추 신체부담 탭: `SpineResultPanel.jsx` 신규 생성 (원본 `mddm-vercel` 기반, summary cards/threshold bars/task details/업무관련성)
- 척추 모듈: 메모 입력 삭제, 기본 작업 1개 자동 생성, TaskEditor 하단 압박력 결과 표시 삭제
- 각 EvaluationComponent가 Fragment로 입력(좌)+결과(우) 2패널 자체 관리

### Phase 8: UI 개선 및 Vercel 배포

- **종합소견 2패널 레이아웃**: 좌측 입력 + 우측 미리보기 (Fragment 기반)
- **상병별 모듈 구분 렌더링**: 척추 상병은 KLG/좌우 구분 제거, `getDiagnosisModuleHint()` 활용
- **기준일자 → 재해일자** 라벨 변경
- **완료 마크 수정**: 모듈별 진단 필터링으로 교차 간섭 방지 (`isKneeAssessmentComplete`, `isSpineAssessmentComplete`)
- **보고서 출력 형식 개선**: 무릎 직종별 상세 출력, 척추 `[업무관련성]` → `[신체부담기여도]`
- **척추 자세 이미지 복원**: `formulaDB.js`에 이미지 경로 추가, 카테고리 그룹핑 (들기/운반/들고 있기)
- **MDDM 보정계수 원본 복원**: F1/F2: ×1.9, F3: ×1.3, F4: ×1.1
- **AI 분석 통합**: 모듈별 AI 탭 제거 → 공유 통합 AI 탭 (UNIFIED_AI_SYSTEM_PROMPT)
- **AI 에러 핸들링 개선**: `res.ok` 체크, 404/상태코드별 구체적 메시지
- **Vercel 배포**: `vercel.json` outputDirectory 설정, 프록시 구성, 환경변수 설정
- **엑셀 Import UI 개선**: `.import-zone` 스타일 추가 (점선 테두리, 아이콘, 호버/드래그 하이라이트)

### Phase 9: Gemini 통합 + UI 리뉴얼 + 모바일 최적화

- **Google Gemini AI 통합**: Gemini 2.5 Flash(기본)/Pro + Claude Haiku/Sonnet 선택 가능
- **Gemini 2.5 Pro thinking 대응**: maxOutputTokens 65536, 에러 상세 메시지 노출
- **UI 스타일 리뉴얼**: 보라 그라데이션 → 클린 미니멀 + 블루(`#3b82f6`) 플랫 디자인
  - 그라데이션 제거, 경량 그림자, CSS 변수 기반 accent 시스템
  - 폰트: Pretendard (CDN) + Noto Sans KR (fallback), 기본 weight 500
  - 다크모드: slate-blue 계열, 텍스트 대비 강화
- **모바일 UI 최적화**: 터치 타겟 44px, 위자드/탭 가로 스크롤, 모달 전체화면, 설정 세로 배치
- **기본정보 2패널 레이아웃**: 좌측(인적사항+직업력) + 우측(특이사항+평가기관)
- **샘플 환자 데이터**: 첫 실행 시 예시 환자(홍길동) 자동 생성 (튜토리얼/테스트용)
- **환자 목록 패널**: 높이 커스텀 조절(resize handle), 사이드바 sticky 레이아웃
- **엑셀 출력 형식 통일**: 미리보기와 동일한 형식으로 무릎/종합소견 섹션 정렬
- **Electron 이미지 경로**: 절대 → 상대 경로(`./images/`)로 수정

### Phase 10: 척추 모듈 직업별 계산 분리 + Export/Import 연동

- **척추 작업-직업 연결**: 각 task에 `sharedJobId` 필드 추가, 직업별 탭 UI로 작업 관리
- **직업별 누적선량 계산**: 직업별로 해당 작업만 모아 일일선량 개별 산출, 직업별 기간을 곱해 누적선량 합산 (`computeSpineCalc` → `jobResults[]` 반환)
- **SpineResultPanel**: 2개 이상 직업 시 직업별 누적선량 내역 섹션 + 합계 표시
- **미리보기/EMR/텍스트 보고서**: 직업별 평가 결과 표시 (`reportGenerator.js`, `exportService.js`, `exportHandlers.js`)
- **일괄입력용 Export**: 척추 작업을 해당 직업 행에 배치 (직업별 그룹핑)
- **일괄 Import**: 같은 행의 직종명으로 `sharedJobId` 자동 연결
- **하위 호환**: `sharedJobId` 없는 기존 데이터는 첫 번째 직업에 자동 귀속, legacy 필드 존재 시 기존 계산 방식 유지
- **Electron 버전 동기화**: `main.js`/`preload.js` 하드코딩 제거, `package.json` 버전 자동 참조

### Phase 11: Electron 수정 + 다크모드 개선 + UI 개선 (v2.4.1)

- **Electron preload.js 수정**: `require('../package.json')` → IPC `get-app-version`으로 대체. asar 패키징 후 상대경로 require 실패로 `window.electron` 전체가 undefined되던 근본 버그 수정 (AI 분석, 네이티브 알림, 레거시 임포트 등 모든 IPC 기능 복구)
- **구버전 데이터 임포트**: Electron main process에서 구형 무릎 프로그램(wr-evaluation)의 LevelDB(WAL) 파싱 + renderer에서 마이그레이션 UI 제공. 디버그 로깅 추가
- **구버전 통합용 내보내기**: `wr-evaluation-claude`에 36열 일괄입력용 xlsx 내보내기 기능 추가 (`batchExport.js`)
- **다크모드 전면 개선**:
  - 테두리 대비 강화: `--card-border`, `--border-color` `#334155` → `#475569`
  - 시맨틱 색상 변수 도입: `--color-safe/warning/danger/right/left` + 배경 변수 (`--color-safe-bg` 등)
  - 하드코딩 색상 제거: `AssessmentTab`, `TaskManager`, `SpineResultPanel`의 `#2b8a3e/#c92a2a/#e67700/#1971c2` → CSS 변수로 교체
  - `.panel`, `.section`에 `color: var(--text-primary)` 추가 (상속 누락 수정)
  - `.module-check-name`에 `color: var(--text-primary)` 추가
  - `.value-positive/negative/neutral` 배지 색상을 CSS 변수로 교체
- **KLG 등급 UI 컴팩트화**: 종합소견 탭에서 별도 `.klg-box` 섹션 제거, 상병명 헤더 우측에 "K-L Grade" 인라인 드롭다운으로 축소
- **EMR 종합소견(b8) 개선**: 무릎 신체부담 데이터 + 참고문헌 텍스트 삽입, `[ 업무관련성 평가 결과 ]` 소제목 추가. 미리보기에도 동일 반영

### Phase 12: 대시보드 + 데이터 관리 + Electron 파일 저장소 (v2.5.0)

- **Electron preload.js 수정**: `require('../package.json')` → IPC `get-app-version`으로 대체. asar 패키징 후 상대경로 require 실패로 `window.electron` 전체가 undefined되던 근본 버그 수정 (AI 분석, 네이티브 알림, 레거시 임포트 등 모든 IPC 기능 복구)
- **구버전 데이터 임포트**: Electron main process에서 구형 무릎 프로그램(wr-evaluation)의 LevelDB(WAL) 파싱 + renderer에서 마이그레이션 UI 제공. 디버그 로깅 추가
- **구버전 통합용 내보내기**: `wr-evaluation-claude`에 36열 일괄입력용 xlsx 내보내기 기능 추가 (`batchExport.js`)
- **다크모드 전면 개선**:
  - 테두리 대비 강화: `--card-border`, `--border-color` `#334155` → `#475569`
  - 시맨틱 색상 변수 도입: `--color-safe/warning/danger/right/left` + 배경 변수 (`--color-safe-bg` 등)
  - 하드코딩 색상 제거: `AssessmentTab`, `TaskManager`, `SpineResultPanel`의 `#2b8a3e/#c92a2a/#e67700/#1971c2` → CSS 변수로 교체
  - `.panel`, `.section`에 `color: var(--text-primary)` 추가 (상속 누락 수정)
  - `.module-check-name`에 `color: var(--text-primary)` 추가
  - `.value-positive/negative/neutral` 배지 색상을 CSS 변수로 교체
- **KLG 등급 UI 컴팩트화**: 종합소견 탭에서 별도 `.klg-box` 섹션 제거, 상병명 헤더 우측에 "K-L Grade" 인라인 드롭다운으로 축소
- **EMR 종합소견(b8) 개선**: 무릎 신체부담 데이터 + 참고문헌 텍스트 삽입, `[ 업무관련성 평가 결과 ]` 소제목 추가. 미리보기에도 동일 반영

- **대시보드 신설**: 현재 편집 중인 환자 목록 기반 통계 대시보드 추가
  - 요약 카드: 총 환자 수, 완료된 평가, 진행 중, 모듈 사용 현황
  - 월별 등록/평가 현황 막대 차트
  - 최근 활동 테이블 (등록일/평가일 분리, 환자 이름 클릭 시 편집 화면으로 즉시 이동)
  - `updatedAt` 기반 최신 수정순 정렬
- **등록일/평가일 분리**: 환자 데이터에 `createdAt`(등록), `updatedAt`(마지막 수정), `evaluationDate`(평가 완료) 세 날짜를 명확히 구분
- **목록 초기화 기능**: 대시보드 및 메인 헤더에서 현재 환자 목록 전체 초기화 버튼 추가
- **일괄 입력 등록일 컬럼 지원**: 엑셀 일괄 입력 시 `등록일`/`접수일` 열 인식하여 `createdAt` 반영
- **홍길동 자동 입력 제거**: 첫 실행 시 예시 환자 자동 생성 기능 삭제 (테스트 데이터 버튼은 유지)
- **앱 타이틀 변경**: "직업성 질환 통합 평가 프로그램" → "근골격계 질환 업무관련성 평가 및 소견서 작성 도우미"
- **홈 버튼 → 대시보드 버튼**: 네비게이션 명칭 변경
- **Electron 파일 기반 저장소 (방안 B)**:
  - `{userData}/wr-eval-data/` 하위 디렉토리 구조로 환자별 개별 JSON 파일 저장
  - `patients/{uuid}.json`, `saved/{id}.json`, `index.json`, `autosave.json`, `settings.json`
  - IPC 핸들러 13종 추가 (`fs-load-all-patients`, `fs-save-patient`, `fs-delete-patient` 등)
  - localStorage 5-10MB 제한 극복 → 수천 명 이상 환자 관리 가능
  - localStorage → 파일 마이그레이션 자동 처리 (첫 실행 시)
  - 웹 버전은 기존 localStorage 방식 유지

---

## 14. 향후 로드맵

| 우선순위 | 항목 | 설명 |
|----------|------|------|
| P0 | ~~런타임 검증~~ | ~~빌드 완료 상태, 실제 사용 시나리오 테스트~~ → Vercel 배포 완료 |
| P0 | ~~어깨 모듈~~ | ~~shoulder 모듈 추가~~ → v3.0.0 완료 |
| P0 | ~~팔꿈치 모듈~~ | ~~elbow 모듈 추가 (BK2101/2103/2105/2106)~~ → v3.2.0 완료 |
| P0 | ~~다중 사용자 / 인트라넷 백엔드~~ | ~~서버 기반 데이터 저장 + 사용자 인증 + device 등록 + 감사 로그~~ → v5.0.0 완료 |
| P0 | ~~프로덕션 릴리즈 리허설~~ | ~~T46 7개 섹션 전체 PASS, 오프라인 패키지 빌드 완료~~ → v5.0.0 완료 |
| P1 | 고관절 모듈 | hip 모듈 추가 (플러그인 패턴 활용) |
| P1 | 현장 device smoke | 병원 PC에 인트라넷 인스톨러 배포 + 의료진 device 등록 검증 |
| P1 | ~~통계분석 워크벤치~~ | ~~기술통계·이변량·상관행렬·회귀·예측 + 공개통제 + 비동기 큐~~ → v7.0.0 완료 (§12.C) |
| P2 | 통계 행 단위·PHI 내보내기 | `stats.export_limited_rows`/`stats.export_phi` 기반 행 단위 export + step-up 재인증(PR5/PR5-B) |
| P2 | 통계 예측 확장 | temporal holdout·subgroup 성능 (외부 검증은 별도 연구) |
| P3 | 통계 카탈로그 잔여 롤아웃 | 남은 필드·롤업 후보 변수화 (현재 통합 83개) |
| P2 | ~~척추 프리셋 연동~~ | ~~직업 프리셋 선택 시 MDDM 작업/변수 자동 채움~~ → v3.2.1 완료 (전 모듈 presetConfig 지원) |
| P2 | ~~EMR 데이터 추출~~ | ~~진료기록분석지/다학제회신 자동 추출~~ → v3.3.0 완료 |
| P2 | ~~다중 사용자 권한 정책~~ | ~~담당의/admin 권한 분리, 비담당 환자 차단~~ → v5.1.0 완료 |
| P2 | ~~진단별 모듈 수동 지정~~ | ~~자동 매핑 실패 진단 수동 지정 + resolveDiagnosisModule 단일 정책~~ → v5.1.1 완료 |
| P2 | 통합 PDF/Word | 통합 보고서를 PDF/Word 형식으로도 출력 |
| P2 | 백업 자동 재해 복구 훈련 | 분기별 1회 복구 전용 환경에서 실제 복원 검증 |
| P3 | 다국어 지원 (i18n) | 영어 인터페이스 추가 — 해외 직업환경의학 도구로 확장 |

### Phase 13: 어깨 모듈 구현 (v3.0.0)

- **어깨(견관절) 모듈 신설**: `src/modules/shoulder/` — BK2117(독일 직업병) 기준 누적 노출 평가 플러그인
- **BK2117 누적 계산 방식**: 일단위 노출 × 연간근무일수 × 근무년수 → 직력 전체 누적시간. 척추 MDDM과 동일한 누적 개념
- **5가지 노출 변수 입력 (JobTab)**:
  - 오버헤드 작업(시간/일), 반복동작 중간속도/고도(시간/일), 진동(시간/일) — 직접 시간 입력
  - 중량물(≥20kg) 취급 — 횟수(회/일) + 시간(초/회) 분리 입력, 내부에서 시간 환산
- **ShoulderResultPanel**: 5개 노출 유형별 누적시간/임계값/비율 테이블 + RatioBar 시각화. 반복동작 OR 조건 판정. 2개 이상 직업 시 직력별 기여 상세 표시
- **Ellman Class**: 종합소견에서 어깨 상병별 Ellman Grade 입력 드롭다운 (Grade 1/2/3/Full/N/A)
- **상병 자동 매핑**: `diagnosisMapping.js`에 M75, S43, S46, M19.01 및 어깨/견관절/회전근개 등 키워드 추가
- **종합소견/미리보기/EMR 엑셀**: 어깨 BK2117 누적 비교 데이터 포함. 어깨/척추 모듈 종합소견 섹션 추가
- **일괄입력용 서식**: 어깨 노출 6열(오버헤드, 반복중간, 반복빠른, 중량물횟수, 중량물시간, 진동) 추가 → 44열
- **대시보드 개선**:
  - 요약 카드 숫자 색상 구분: 총 환자(파란색) / 완료된 평가(초록색) / 진행 중(주황색) / 모듈 사용(회색)
  - 모듈 표시명: '어깨 (견관절)' → '어깨'

### Phase 14: 보안 하드닝 + EMR 직접입력 + UX 안정화 (v3.1.0)

- **EMR 직접입력 C# 헬퍼 전면 재작성** (`electron/emr-helper/EmrHelper.cs`):
  - `dynamic` 키워드 → `Type.InvokeMember` reflection 기반 COM 접근으로 전환
  - `[STAThread]` 추가 (COM STA 스레드 요구사항)
  - `IID_IHTMLDocument`(IOleDocument) 제거 — lResult 단일 소모 문제 해결, IHTMLDocument2만 시도
  - `--diagnose` 모드 추가 (stderr 로깅으로 현장 디버깅 지원)
  - `Microsoft.CSharp.dll` 참조 제거 (EmrHelper.csproj)
  - x86/x64 이중 빌드 → 단일 EmrHelper.exe로 통합
- **API 보안** (`api/analyze.js`):
  - Gemini API 키: URL 쿼리 `?key=` → `x-goog-api-key` 헤더 전환
  - CORS: `Access-Control-Allow-Origin: *` → 오리진 허용 목록 (localhost + `*.vercel.app` 패턴)
- **IPC 보안** (`electron/main.js`):
  - `sanitizeId()` 함수 추가 — 6개 IPC 핸들러에 경로 순회 방어 적용
  - `netRequest()` HTTP 상태코드 검사 추가 (≥400 시 에러 reject)
- **Electron 리스너 안정화** (`electron/preload.js`, `src/App.jsx`):
  - `onMenuNew`/`onGotoModule` 리스너 unsubscribe 반환값 추가
  - App.jsx에서 cleanup 함수로 메모리 누수 방지
- **React 상태 안정화** (`src/App.jsx`):
  - `handleStartIntake` stale closure 수정 (settingsRef + useRef 패턴)
  - 모듈 스텝 인덱스: 하드코딩 `3` → `buildSteps()` 기반 동적 계산
  - 단일 환자 삭제 시 확인 대화상자 추가
- **저장 안정성** (`src/core/utils/storage.js`):
  - 저장 snapshot ID: `Date.now()` → `crypto.randomUUID()`
  - `safeSetItem()` 래퍼 — `QuotaExceededError` 시 사용자 메시지 제공

### Phase 15: 팔꿈치 모듈 + 미리보기/내보내기 리팩터링 (v3.2.0)

- **팔꿈치(주관절) 모듈 신설** (`src/modules/elbow/`, Codex 구현): 독일 산재보험 BK2101(상과병변/부착부 건병증) / BK2103(골관절염/박리성 골연골염) / BK2105(점액낭염) / BK2106(주관증후군/척골신경병변) 4유형 공통 신체부담 평가
- **Job × Diagnosis 2차원 데이터 구조**: `modules.elbow.jobEvaluations[{ sharedJobId, diagnosisEntries[{ diagnosisId, selectedBkType, ... }] }]` — 다른 모듈과 달리 동일 직업 안에서도 상병별 분기가 핵심이라 `jobExtras[]`(1차원) 대신 2차원을 사용
- **공통 시간적 선후관계**: `temporalSequence`(최근 작업변화, 작업변화 시점, 증상 발생 간격, 휴가 시 호전) — 모듈 전체에 1회 입력하는 공통 섹션
- **Gate-and-Flag 판정 엔진** (`computeElbowCalc`): REQUIRED_ENTRY_FIELDS 게이트 통과 시 15+ flag 평가(core_exposure_present, daily_share_high/moderate/low, rest_unfavorable, mechanical_load_dominant, pressure_load_dominant, vibration_present, BK별 pattern_supported, bk2103_transmission_amplifier_present, temporal_fit_high/unclear). RISK_FACTOR_FLAGS 집합을 riskFactorItems로 분리하고 narrative + 종합평가 문장 자동 생성.
- **`work_pattern` 수식자**: `continuous` 시 daily_share 경계 상향(1.5h / 20% vs 기본 3h / 40%), rest_unfavorable이 `moderate` 휴식에서도 활성화
- **자동 BK 매핑**(`inferElbowBkTypeFromDiagnosis`): ICD(`^M77\.0` / `^M77\.1` → BK2101, `^T75\.2` → BK2103) + 상병명 키워드(점액낭염→BK2105, 주관증후군/척골신경/단신경병증→BK2106, 진동성 팔꿈치/골관절염/박리성 골연골염→BK2103, 상과염/테니스·골프 엘보/부착부 건병증→BK2101). `bkSelectionMode: auto | manual`로 사용자 수동 덮어쓰기 지원.
- **ElbowResultPanel**: 공통 시간적 선후관계 섹션 + 직업별 카드 내부에 상병별 Summary Card(BK 라벨, flag pill, narrative, 위험 요인 요약, 종합평가 문장)
- **팔꿈치 내보내기** (`utils/exportHandlers.js`):
  - `excelSingle`: EMR 소견서 단일 시트 B5~B9 7행 구조 — 1.신청상병명 / 2.진료기록 / 3.최종확인상병 / 4.직업력·노출 / 5.개인력·특이사항 / 6.종합평가 / 7.복귀 고려사항
  - `pdf`: html2pdf 기반 — 직업·상병 카드 + 시간적 선후관계 flag 요약
- **통합 미리보기 리팩터링** (`src/core/utils/reportGenerator.js`):
  - `genElbowBurdenSection(calc)` 신규 추가 — `< 팔꿈치(주관절) >` 섹션 생성(공통 시간적 선후관계 flag + 직업별 상병 narrative + 종합평가)
  - `genSpineBurdenSection`을 helper 함수(`formatSpineNumber`, `formatSpinePercent`, `formatSpineLimit`, `isSpineThresholdExceeded`, `getSpineThresholdStatus`, `getSpineTaskDose`, `getSpineInterpretation`)로 리팩터링해 DWS2 / 독일 법원 / MDDM 각 기준 초과 여부 기반 tiered 해석 문장 자동 생성. 척추 섹션이 BK2108을 명시적으로 참조
  - 복귀 고려사항(`returnConsiderations`) fallback을 `knee || shoulder || elbow` 3개 모듈 공유로 확장
- **일괄입력용 서식 확장** (`src/core/utils/exportService.js`):
  - 팔꿈치 시간적 선후관계 4열(최근작업변화/작업변화시점/증상발생까지기간/휴식시호전) + 진단 엔트리 27열(BK 공통 16열 + BK2101 5열 + BK2103 3열 + BK2105 2열 + BK2106 1열) 추가
  - 총 컬럼 44열 → **75열**
  - 행 생성 규칙: 팔꿈치 `elbowPairs`(직업×상병) 행 수를 `max()`에 포함해 행 확장. 시간적 선후관계 4열은 환자 첫 행에만 채움
- **코어 컴포넌트 elbow 연동**:
  - Dashboard `MODULE_LABELS`에 `elbow: '팔꿈치'` 추가
  - AssessmentStep: 팔꿈치 상병 BK 유형 자동 제안/수동 선택 UI, 공통 시간적 선후관계 입력, 업무관련성 평가 섹션 추가
  - `diagnosisMapping.js`: M77.0/M77.1/T75.2 ICD 규칙 + 팔꿈치 관련 상병명 키워드 추가, `MODULE_LABELS`에 elbow 포함
- **모듈 순서**: UI 위자드/미리보기/내보내기에서 무릎 → 팔꿈치 → 어깨 → 척추(근위 → 원위) 순으로 배치

### Phase 16: 척추/어깨 계산 개선 + 대시보드 개선 (v3.2.0)

- **척추 압박력 기준 변경**: `thresholds.singleForce` 남 2,700N / 여 2,000N → 남녀 공통 1,900N. `calculateDailyDose(tasks)` 시그니처에서 `gender` 제거
- **4,000N 규칙 도입**: `calculateLifetimeDose`에 `hasHighForceTask` 파라미터 추가 — 작업 압박력 ≥ 4,000N이면 일일 누적 용량 임계치(2.0 kN·h) 미만이어도 평생 누적 용량에 포함
- **일일 노출 중증도 분류**: `reportGenerator.genSpineBurdenSection` + `exportService.buildSpineExposureText`에 일일 노출량 뒤 고도(>4kN·h / ≥6kN) / 중등도상(>3kN·h / ≥5kN) / 중등도하(≥2kN·h / ≥4kN) / 경도 표시
- **척추 종합소견 드롭다운 2종**: `AssessmentTab.jsx`에 수직분포원리(확인/미확인) + 동반성 척추증(확인/미확인) 인라인 드롭다운 추가 (`verticalDistribution`, `concomitantSpondylosis` 필드)
- **어깨 BK2117 누적 신체부담 판정**: `genShoulderBurdenSection` + `exportService` + `exportHandlers`에 3단 해석 로직 추가 — 초과 기준 나열→충분, 복합 노출(50%↑ ≥3개 또는 75%↑ ≥2개)→충분, 미달→불충분. 기존 `anyRepetitiveExceeded` 제거
- **대시보드 모듈 사용 카드 개선**: 총합 숫자 제거 → 4개 모듈 2×2 그리드(모듈별 개별 색상). 평균 처리일수 `일` 단위를 숫자 옆 인라인으로 이동. 척추→허리 라벨 변경

### Phase 17: 프리셋 기능 강화 (v3.2.1)

- **커스텀 프리셋 생성/저장**: `PresetManageModal` — 현재 입력된 신체부담 데이터를 프리셋으로 저장. 모듈별 체크박스 선택, 데이터 미리보기, 기존 커스텀 프리셋 목록 표시/삭제
- **프리셋 저장소 신설**: `presetRepository.js` — builtin(`job-presets.json`) + custom(localStorage/Electron FS) 이중 저장소. `loadAllPresets()`로 병합 로드, `saveCustomPreset()`/`deleteCustomPreset()`으로 CRUD, JSON 내보내기/가져오기 지원
- **전 모듈 presetConfig 지원**: 각 모듈이 `presetConfig` 계약(`label`, `fields`, `extractFromModule`, `applyToModule`)을 선언하여 프리셋 시스템과 결합
  - **무릎**: 8개 필드(weight, squatting, 6개 보조변수) — flat jobExtras 패턴
  - **어깨**: 6개 노출 필드(overhead, repetitionMid, repetitionHigh, heavyLifting, liftingTime, vibration) — flat jobExtras 패턴
  - **척추**: `fields: 'tasks'` — 작업 배열 교체 패턴 (sharedJobId 기준 필터/교체)
  - **팔꿈치**: BK 유형 분기가 진단 의존적이어 v1에서는 제외
- **프리셋 검색 개선**: `PresetSearch`에 모듈 배지(ModuleBadges) 표시, 커스텀 프리셋 태그, 검색 결과 10개로 확장
- **프리셋 적용 일반화**: `handlePresetSelect`가 활성 모듈 전체를 순회하며 각 모듈의 `applyToModule()` 호출
- **중복 저장 방지**: `saveCustomPreset()`에서 id + jobName 이중 매칭으로 동일 직종 중복 생성 차단

### Phase 18: EMR 연동 + 다학제 회신 + 팔꿈치 프리셋 (v3.3.0)

- **EMR 데이터 추출 (Electron)**: `EmrHelper.cs`에 `--extract-record`/`--extract-consultation` 모드 추가 — IE COM 자동화로 진료기록분석지/진료메인 페이지에서 환자 데이터 읽기
  - `ExtractRecord`: 환자등록번호 → 환자명, 생년월일, 재해일자, 진료기록(의무기록/영상검사/수술이력), 기저질환(고혈압/당뇨), 수진이력 + 상병 목록 자동 추출
  - `ExtractConsultation`: 진료메인 FarPoint Spread에서 과별 다학제 회신 추출 → `consultReplyOrtho/Neuro/Rehab/Other` 자동 저장
  - `ReadSpreadCell`: FarPoint Spread ActiveX ByRef 파라미터 처리 (`ParameterModifier`)
  - `runHelper` 공통 래퍼: `getHelperExe()` 경로 해석 + `execFile` 타임아웃/에러 처리 통합
  - IPC 핸들러 2종 추가: `emr-extract-record`, `emr-extract-consultation`
  - preload.js에 `extractRecord`, `extractConsultation` 채널 노출
- **EMR 일괄 추출 UI**: 헤더에 `EMR 추출` 버튼 — 선택된 환자 또는 현재 환자의 `patientNo` 기반 순차 추출 + 프로그레스 바(`.emr-progress-bar`). patientNo 교차검증으로 잘못된 환자 매칭 방지
- **다학제 회신 추출 UI**: 헤더에 `다학제 추출` 버튼 — 진료메인 페이지에서 과별 회신 읽어 현재 환자에 저장. 환자 식별 확인 대화상자 포함
- **다학제 회신 EMR 입력**: `다학제 보내기` 버튼 — `generateConsultReplyFieldData()`로 과별 회신을 slot2/slot3(EMR 종합소견 2,3번 칸)에 분배 후 직접 입력. EMR 직접입력 버튼은 드롭다운에서 헤더 독립 버튼으로 이동
- **환자등록번호 필드 (`patientNo`)**: `createSharedData`에 추가, BasicInfoForm 입력 필드, Dashboard 테이블 컬럼, BatchImportModal 매핑, `dashboardStats.js` 반영
- **EMR 연동 데이터 섹션 (BasicInfoSidePanel)**: 기존 섹션 3 '특이사항' → 섹션 5로 이동, 새 섹션 3 'EMR 연동 데이터' 추가
  - 진료기록/의학적 소견 (`medicalRecord`) — AutoResizeTextarea 컴포넌트
  - 기저질환: 고혈압/당뇨병 라디오 버튼 (`highBloodPressure`, `diabetes`)
  - 수진이력 (`visitHistory`)
- **다학제 회신 섹션 (BasicInfoSidePanel)**: 새 섹션 4 — 정형외과/신경외과/재활의학과/기타 4과 회신 입력
- **EMR 소견서 개인적 요인 확장**: `buildPersonalFactorText()`에 고혈압/당뇨/수진이력/특이사항 포함. `generateEMRFieldData()`에 `txtMrecMedPovCont`(진료기록) 추가. `buildConsultReplySummary()`로 다학제 회신 요약을 종합소견 엑셀에 포함
- **팔꿈치 프리셋 지원**: `elbow/index.js`에 `presetConfig` 추가 — 공통 노출 10개 필드(`main_task_name`, `daily_exposure_hours`, `shift_share_percent`, `work_pattern` 등) 추출/적용. `_pendingPreset` 메커니즘으로 진단 엔트리 미생성 시 프리셋 대기 후 `syncElbowModuleData` 시점에 적용
- **모듈 jobExtras 자동 생성**: KneeEvaluation/ShoulderEvaluation에 `useEffect` — 직업 추가 시 누락된 jobExtras 자동 생성. SpineEvaluation에 `sharedJobId` 빈 태스크 첫 번째 직업 자동 귀속 마이그레이션. `spine/index.js`에 미귀속 태스크 폴백
- **프리셋 내보내기/가져오기 개선**: `toExportableCustomPreset()`으로 커스텀 프리셋만 정제해서 내보내기 (builtin 필드 혼입 방지). `mergePresets()`에서 `_customCategory`/`_customDescription` 보존. `importPresetsFromJSON()` 필드 정규화. `loadAllPresets()`에 `builtinError` 반환 추가
- **일괄 Import 필드 그룹 세분화**: 기존 '직업/작업'+'팔꿈치' 2개 그룹 → 직업/무릎/어깨/척추/팔꿈치 공통/팔꿈치 BK별 6개 그룹으로 분리. UI에 카드 헤더 필드 개수 배지 + 리스트 형식 적용

### Phase 19: 손목(수관절) 모듈 추가 (v3.4.0)

- **손목 모듈 신설** (`src/modules/wrist/`): 팔꿈치 모듈의 구조를 차용하여, 독일 산재보험 기준을 준용한 손목의 평가 항목(BK2113 수근관증후군, BK2101 건초염/방아쇠수지, BK2103 관절병증, BK2106 Guyon canal 증후군)을 마련함
- **Gate-and-Flag 유지**: 팔꿈치 평가 모델처럼 필수 조건 파라미터(시간, 형태, 휴식분포 등)를 검사하여 플래그화 하고 결과를 문서(Narrative)로 자동 생성
- **공유 데이터셋 적용**: `jobEvaluations[]`와 `temporalSequence`를 손목 특화 필드로 재정의.
- **통합 소견서 및 EMR 보강**: 인코딩 깨짐을 보호하기 위한 유니코드 처리가 적용된 텍스트(`reportGenerator.js`, `exportService.js`) 내보내기 구현
- **일괄 Export/Import 서식 확장**: 손목 전용 입력 지표들을 포함하여 엑셀 문서 컬럼 확장(101열 첨부)

### Phase 20: 경추(목) 모듈 추가 + 아이콘 호환성 + 프리셋 안정화 (v4.0.0)

- **경추(목) 모듈 신설** (`src/modules/cervical/`): 독일 산재보험 BK2109 기반 경추 질환 부담 노출 평가 플러그인
  - 어깨 하중 운반(≥40kg) + 비중립·정적 목 부하(≥1.5~2시간) 2가지 노출 유형 Gate-and-Flag 판정
  - `tasks[]` (sharedJobId로 직업 연결) — 척추(spine)와 동일 패턴
  - 경추간판 탈출증(M50), 경추 협착증(M48.02) 등 자동 상병 매핑
  - 종합소견에서 척추와 동일하게 좌우 구분 없는 축(Axial) 상병 처리
- **경추 프리셋 시스템 연동**: `presetConfig` — 공통 노출 7개 필드(`name`, `exposure_types`, `load_weight_kg`, `carry_hours_per_shift` 등) 추출/적용
- **통합 미리보기/EMR/엑셀**: `genCervicalBurdenSection` / `buildCervicalExposureText` 추가 — `<경추(목)>` 섹션 자동 포함
- **모듈 아이콘 Windows 7 호환성 개선**: Unicode 6.0 이하 기호로 일괄 교체
  - 경추: 👤 (Bust in Silhouette) / 어깨: 🙆 (Person Gesturing OK) / 팔꿈치: 💪 (Flexed Biceps) / 요추: ⚕️ (유지)
- **프리셋 모달 크래시 수정**: `getPresetCategory`/`getPresetDescription`에 null 안전 처리 추가 — 프리셋 저장 버튼 클릭 시 빈 화면 TypeError 해결
- **프리셋 저장 정책 개선**: 직종명+카테고리+설명 기반 identity 저장, 유사 프리셋 키워드 매칭, 모듈별 비파괴 병합

### Phase 21: 경추·척추 모듈 품질 개선 (v4.1.0)

- **경추 평가 완료 판정 완화** (`isCervicalAssessmentComplete`): 경추 task가 있는 직업에 대해서만 필드 완성 여부 체크 — 경추와 무관한 직업이 있어도 "완료" 표시 가능
- **경추 위험요인 의미론 수정** (`RISK_FACTOR_FLAGS`): `warning` tone 4개(heavy_load_present / carry_time_supported / forced_neck_posture_present / cumulative_load_supported)로 한정 — positive/info 진단 지지 플래그가 "업무관련성 위험 요인"으로 혼입되던 문제 해결
- **파생 플래그 중복 집계 제거**: `mechanical_cervical_load_dominant`를 FLAG_ORDER에서 제외, 종합 배지 전용으로 변경 — 동일 노출이 위험요인 카운트에 두 번 집계되던 문제 제거
- **isCervicalAssessmentComplete 중복 sync 제거**: 내부 `syncCervicalModuleData` 이중 호출 → `computeCervicalCalc` 단일 호출로 통합
- **고아 task 자동 정리 (경추)**: `syncCervicalModuleData`에서 삭제된 직업을 참조하는 task 제거; jobs 배열이 임시로 비는 경우 pruning 건너뜀(`shouldPrune` 가드)
- **고아 task 자동 정리 (척추)**: `SpineEvaluation` useEffect에서 삭제된 직업 참조 task 제거; 의존성 `[jobs[0]?.id]` → `[jobs]`로 확장해 직업 중간 삭제도 감지
- **프리셋 적용 시 기본 task 교체 (경추·척추)**: `applyToModule`에서 `sharedJobId`가 비어 있는 초기 기본 task를 교체 대상으로 처리 — 프리셋 적용 후 "작업 1"이 잔존하던 문제 해결
- **경추 프리셋 id 이중 생성 제거**: `applyToModule`의 불필요한 `id: createCervicalTask(...).id` 재할당 삭제

### Phase 22: 인트라넷 백엔드 + 오프라인 배포 (v5.0.0)

이전 Phase들은 모두 클라이언트 단일 앱 단위였지만, v5.0.0은 **병원 인트라넷 환경에서 다중 사용자 운영**을 위한 풀스택 백엔드 도입이 핵심. 동일 React 평가 엔진을 그대로 사용하면서 데이터 저장 / 인증 / 감사 / 백업을 모두 서버로 위임.

**Phase 22-A: 백엔드 API 서버 구축**
- `server/` 디렉토리 신설 — Node 20 + TypeScript + Express + PostgreSQL 16
- 15개 SQL migration (users, organizations, sessions, devices, audit_logs(partition), patient_records, custom_presets, workspaces, user_signup_requests 등)
- 두 개의 pg pool (메인 + audit reader)
- JWT 인증 (access 15m + refresh 7d), bcrypt 12라운드, must_change_password 정책
- 역할 기반 (admin/doctor/nurse/staff), CSRF 쿠키, rate limit
- DTO 검증: `shared/contracts/*` (zod) — 클라이언트와 타입 공유
- 테스트: server/src/**/__tests__/* (admin, auth, audit, patients, presets, workspaces, opsBackupStatus)

**Phase 22-B: Electron 인트라넷 빌드 분기**
- `electron/build-target.json` (`standalone` | `intranet`) — preload-standalone.js / preload-intranet.js 분리
- `electron/audit.js`: Ed25519 device 키페어 생성 + 감사 메시지 서명 (canonical: `{deviceId}.{ts}.{nonce}.{sortedBodyJson}`)
- `electron/auditQueue.js`: 디스크 큐로 네트워크 실패 백업, `flushQueue` 5분 주기 자동 재전송
- Device 등록 흐름: 첫 실행 시 키페어 생성 → 로그인 시 `tryRegister()` → 서버 pending → admin 승인 → active 자동 인식
- EMR 접근 제어: `IS_INTRANET_BUILD` + EMR 호출 시 `audit.getDeviceStatus()` 검사, active 아니면 차단
- `migrationGate.js` + `migrationDataReader.js`: 인트라넷 첫 진입 시 standalone 데이터 자동 마이그레이션 게이트

**Phase 22-C: 다중 사용자 UI**
- `src/core/auth/` — AuthContext, authChannel(자동 refresh), session
- `src/core/components/LoginModal.jsx`, `ChangePasswordModal.jsx`, `AccountProfileModal.jsx`
- `AdminConsoleModal.jsx` — 사용자/디바이스/감사로그/백업/가입요청 5개 탭
- `SignupRequestModal.jsx` — 비로그인 가입 요청
- `ConflictResolveModal.jsx` — 동시 편집 충돌 시 mine/theirs/merge 선택
- `MigrationReportModal.jsx` — standalone → 서버 마이그레이션 결과 리포트

**Phase 22-D: 서버 통신 / 동기화**
- `patientServerRepository`: 환자 CRUD + assigned_doctor 자동 해결 (`resolveAssignedDoctor`)
- `intranetWorkspaceRepository`: 워크스페이스 서버 저장
- `httpClient`: 자동 refresh + CSRF + 에러 매핑
- `usePatientSync`: 환자 목록 폴링 + 다른 사용자 변경 감지
- `patientConflictResolution`: ETag(updated_at) 낙관적 락
- `localToServerMigrator`: standalone localStorage/파일 → 서버 일괄 전송

**Phase 22-E: HTTPS / 내부 CA**
- `caddy/Caddyfile`: `tls internal`로 내부 CA 자동 생성 + leaf 자동 갱신
- `wr-prod-caddy-1`에서 `/data/caddy/pki/authorities/local/root.crt` 추출 → 클라이언트 PC 신뢰 등록
- 3가지 설치 방법 문서화: GUI / PowerShell Import-Certificate / certutil

**Phase 22-F: 백업 / 모니터링 / 복구**
- `backup/Dockerfile` — postgres:16-alpine + gnupg + busybox-suid (cron)
- `scripts/backup.sh` — pg_dump → GPG 암호화 → `_status/`, `_alerts/` 갱신, resolved alert prune
- `services/backup-monitor/` — 별도 컨테이너, stale 감지, alert 파일 생성
- `/api/ops/backup-status` 엔드포인트로 admin 콘솔에 노출
- `scripts/restore.sh` — 2인 인가(`RESTORE_AUTH_TICKET`) + `GPG_PASSPHRASE` env 지원
- **복구 전용 키 정책**: passphrase-less RSA 4096 별도 발급 (`wr-backup-restore-public.asc` / `*-private.asc`)

**Phase 22-G: 오프라인 배포 패키징**
- `scripts/export-offline-package.ps1` — Docker save → tar → zip 일괄
- 포함: app/backup-monitor/backup 이미지 + postgres:16-alpine + caddy:2-alpine + Electron 인스톨러 + compose + Caddyfile + 스크립트 + 문서
- SHA256SUMS, release-manifest.json 자동 생성
- 시크릿 누출 가드: `.env`, `*-private.asc`, DB dump 등 자동 검출 후 제외 확인
- `scripts/import-images.ps1` / `.sh` — docker load 일괄
- `scripts/install-prod.ps1` — Windows 자동 설치 (사전 검증 6단계 → up -d)

**Phase 22-H: T46 프로덕션 릴리즈 리허설 (전 섹션 PASS)**
- 7개 섹션: 환경 분리 / 패키지 무결성 / Admin 초기화 / Device 등록 승인 / 백업 / 복구 / 롤백 dry-run
- 발견 + fix 완료:
  - **alert resolve 권한**: `backup.sh`의 `_alerts/*.json`이 root 소유 → `chown 1000:1000` 추가
  - **GPG passphrase 비대화형 실패**: `restore.sh`에 `GPG_PASSPHRASE` env 지원 + 복구 전용 passphrase-less 키 발급 가이드
- `seedAdmin.ts` 비대화형 파이프 입력 수정 (`fs.readFileSync(0, 'utf-8').split(/\r?\n/)` 사전 읽기)
- 리허설 결과 → `docs/T46_GO_NO_GO.md` 7개 섹션 PASS 확정

**Phase 22-I: 문서 (신규 / 대폭 개정)**
- `docs/OFFLINE_DEPLOYMENT_PACKAGE.md` — 12개 섹션 단계별 설치 가이드 (Windows/Linux 분리, PowerShell 실행 정책, 인증서 등록, GPG 키 생성, 백업 활성화, 트러블슈팅)
- `docs/PRODUCTION_RELEASE_PLAN.md` — 운영 절차서 (롤백 6-2/6-3 경로 분기)
- `docs/T46_GO_NO_GO.md`, `docs/T46_IMPLEMENTATION_PLAN.md`
- `docs/OPERATIONS_RUNBOOK.md`, `docs/BACKUP_MONITORING_PLAN.md`
- `docs/INTRANET_DEPLOYMENT.md` — HTTPS / 내부 CA / 인증서 신뢰 등록
- 기존 `docs/BACKUP_RESTORE.md` 대폭 보강
- `docs/UPDATE_5.1.0.md` (v5.1.0 추가) — v5.0.x → v5.1.0 현장 업데이트 절차 (예상 다운타임 ~10초, 검증 8가지, 롤백 무손실)

### Phase 23: 다중 사용자 운영 UX 강화 + 척추 모듈 개선 (v5.1.0)

Phase 22에서 인트라넷 백엔드를 도입한 뒤 실제 다중 사용자 운영 환경에서 드러난 UX 결함과 권한 정책 미비점을 정리. 동시에 척추 모듈의 입력 효율도 개선.

**Phase 23-A: 환자 권한 정책 강화**
- **수정/삭제 권한**: 담당의(`assigned_doctor_user_id == session.userId`) 또는 admin만 (조회는 같은 organization 누구나)
- **서버 미들웨어**: 신규 `server/src/middleware/patientAccess.ts` `assignedDoctorOrAdmin(pool)` — `PATCH /api/patients/:id`, `DELETE /api/patients/:id`에 적용. 다른 org는 404(존재 누설 방지), 비담당은 403
- **클라이언트 헬퍼**: `src/core/utils/patientOwnership.js` `canEditPatient`/`canDeletePatient` — 로컬 모드는 단일 사용자라 항상 true, redacted/null patient는 항상 false (admin/로컬 무관)
- **신규 환자 자동 assigned**: `createPatientMeta`에서 인트라넷 doctor 세션이면 `meta.assignedDoctorUserId = user.id` 자동 세팅 (서버 `resolveAssignedDoctor`와 동일 로직 mirroring) → sync 전에도 본인 환자 정상 수정
- **local-only 안전망**: assigned 미정의 + createdBy == me + syncStatus == 'local-only' 시 임시 편집 허용 (assigned가 명시적 null이면 미배정 정책 유지)
- **UI 게이팅**:
  - PatientSidebar 개별 삭제 버튼: `canDeletePatient`일 때만 렌더
  - 일괄 삭제: `patients.filter(p => selectedIds.has(p.id))` 전체가 모두 삭제 가능할 때만 활성 (필터로 가려진 항목 포함)
  - StepContent: `canEditPatient === false`면 평가 영역을 `<div className="read-only-content" inert="">`로 감쌈 — HTML `inert` 속성으로 키보드 포커스/탭/스크린리더까지 차단. 부모 grid 보존(`display: contents`) + opacity 약화
  - "담당 의사가 아니므로 조회만 가능합니다" pill 배너 (스텝 탭 ↔ 콘텐츠 사이)
- **usePatientCrud 다층 방어**: `updatePatient`에 silent guard (EMR import/preset select 등 우회 경로 차단), 삭제 함수 2개 진입부에 권한 거부 alert
- **403 sync 알림**: `pushPendingPatients` 결과를 conflict/permission/error로 분류. `syncState.lastPermissionDeniedCount` 노출 → 메인 영역 빨간 배너로 "권한 없음으로 동기화되지 않은 환자: N건" 표시. push가 시도된 sync에서 0건이면 자동 clear (pull-only sync 종료부에서도 통합 정리)
- **테스트**: 서버 권한 12케이스, 클라이언트 헬퍼 11케이스 추가

**Phase 23-B: 대시보드 scope 분리 (내 환자 / 전체)**
- 인트라넷 다중 의사 환경에서 본인 담당 통계와 조직 전체 통계가 섞여 의사결정 맥락이 흐려지던 문제 해결
- **별도 state** `dashboardScope` (사이드바 `patientScope`와 분리) — 사이드바 환자 목록(서버 sync)을 건드리지 않음
- **canUseScope 게이팅**: `session?.mode === 'intranet' && !!session?.user?.id` — 로컬 모드는 토글 숨김
- **'내 환자' 판정**: dashboard 헬퍼 `isMyPatient`는 `assignedDoctorUserId` 우선, 없으면 `createdBy` 폴백
- **차별 카드**:
  - 'mine' 전용: "내 미완료 평가 건수"
  - 'all' 전용: "의사별 환자 수 Top 5" (`getDoctorPatientCounts` 신규) — 그룹 키 우선순위 `assignedDoctorUserId` top-level → `meta.assignedDoctorUserId` → `meta.createdBy`, null/미배정은 `__unassigned__` 별도 표시. 라벨은 `data.shared.doctorName` → ID 축약 폴백
- **빈 상태 처리**: 'mine'에서 0명이어도 헤더+토글 보이고 "전체 보기로 전환" 버튼 제공
- **sync 범위 불일치 배너**: 사이드바 mine sync + 대시보드 all 선택 시 안내
- 세션 변경 시 자동 reset (`getDefaultPatientScope`)

**Phase 23-C: 다중 사용자 운영 UX**
- **인트라넷 차단 화면 탈출구**: 6개 차단 화면(configLoading/configError/sessionVerifying/LoginModal/ChangePasswordModal/booting-syncing) 우상단에 신규 `SwitchToLocalButton` 컴포넌트. confirm 후 `handleSaveSettings({...settings, integrationMode: 'local'})`로 즉시 메인 UI 진입 — dev 모드에서 서버 없거나 운영에서 서버 장애 시 작업자 탈출구
- **랜딩에 "환자 목록 보기" 버튼**: 헤더 "대시보드" 클릭 후 LandingScreen에서 환자 목록으로 다시 빠져나갈 수단이 없던 문제 해결. `setShowHome(false) + setShowSidebar(true)`. 인트라넷 + (서버 환자 ≥ 1 또는 로컬 환자 ≥ 1)일 때만 노출
- **랜딩 로그인 사용자 배지**: `landing-hero` 안에 이름/역할 표시 (필드 우선순위 `name → displayName → loginId`, MainHeader와 동일 패턴). 인트라넷 모드만
- **인트라넷 "초기화" 버튼 숨김**: LandingScreen "목록 초기화" + MainHeader "초기화" 버튼이 클라이언트 state만 비우고 서버 데이터는 그대로 남는 동작이라, 다중 사용자 환경에서는 삭제처럼 오해될 수 있어 인트라넷에서만 숨김 (로컬 유지)
- **dev CORS override**: 신규 `docker-compose.override.yml` — dev 스택만 `http://localhost:3000` (Vite) origin 허용. prod compose는 영향 없음

**Phase 23-D: 척추 모듈 개선**
- **수직분포 정리 / 동반 척추증 통합**: 척추(spine) 진단마다 두 select가 반복 노출되던 것을 첫 spine 진단에만 표시
  - 신규 순수 함수 `src/core/utils/spineAssessmentMigration.js`:
    - `normalizeSpineAssessmentFields(diagnoses, isSpineDiagnosis)` — 첫 spine 진단에 빈 값이면 다른 spine 진단의 첫 non-empty 값 승계, 나머지 spine 진단들은 두 필드 제거. 변경 없으면 동일 참조 반환(무한 루프 방지). 빈 필드 안 만듦
    - `preserveDeletedSpineCommonFields(prev, next, isSpineDiagnosis)` — 첫 spine 진단 삭제 시 살아남은 첫 spine 진단으로 값 이송 (override 안 함)
  - AssessmentTab: `useCallback(isSpineDiagnosis)` + 마이그레이션 effect (eslint 억제 없음), `index === firstSpineIndex`일 때만 select UI 렌더
  - `usePatientCrud.updateDiagnoses` 래핑: 진단 변경 모든 경로(IntakeWizard/StepContent/AssessmentTab)에서 자동 보호
  - 테스트: 마이그레이션 9 + 삭제 시 이송 6 = 15케이스
- **척추 작업 순서 드래그앤드롭**: 현재 직업 탭 내에서 작업 순서를 마우스로 변경
  - HTML5 native DnD (외부 라이브러리 없음). 단일 항목/빈 탭은 draggable 자동 비활성
  - `visibleTasks` useMemo로 단일 진실원 도입 — 기존 `filteredTasks` 제거, 모든 핸들러(select/remove/reorder)가 같은 기준 사용
  - **id 기반 reorder**: index → id로 변환 후 `Set`/`Map`으로 O(n) 재구성. mod.tasks 전체 배열에서 같은 직업 task 위치만 재배치(다른 직업 순서 보존). `from === to` early return
  - 드래그 후 선택 유지: `pendingSelectId` state + useEffect로 새 visible 위치 자동 보정
  - **방향 인식 drop indicator**: source < target이면 target 하단, source > target이면 target 상단에 box-shadow inset (border-top 대신 사용 — 높이 변경 없음, active 상태와 충돌 없음)

**Phase 23-E: 기타 정리**
- `useIntegrationStatus` 등 기존 hook의 react-hooks/exhaustive-deps 경고는 의도된 stable closure로 유지 (eslint 5 warnings remain, 0 errors)
- `diagnosisMapping.js`/`reportGenerator.js`: 작은 보정(사용자 직접 수정)

### Phase 24: 진단별 모듈 수동 지정 + 인트라넷 Autosave 비활성화 (v5.1.1)

**Phase 24-A: 진단별 모듈 수동 지정**

자동 ICD 매핑이 실패한 진단(비표준 상병명, 드문 ICD 코드 등)을 특정 모듈에 수동으로 연결할 수 있도록 진단 모델과 resolve 정책을 통합.

- **진단 `moduleId` 필드**: `null`(자동) / `'knee'/'spine'/'shoulder'/'elbow'/'wrist'/'cervical'`(수동) / `'__none__'`(해당 없음)
- **`resolveDiagnosisModule(diagnosis, activeModules)` 단일 정책 함수** (`diagnosisMapping.js`):
  1. `moduleId === '__none__'` → null
  2. `moduleId` 유효 모듈 ID → 수동 지정값
  3. `getDiagnosisModuleHint(diagnosis)` 자동 hint → 결과
  4. 활성 모듈이 1개 → 단일 모듈 fallback
  5. null (구분 불가)
- **모든 모듈 필터 통일**: `isCervicalDiagnosis`, `isElbowDiagnosis`, `isWristDiagnosis`, knee/spine/shoulder 인라인 필터 전부 `resolveDiagnosisModule` 기반으로 교체 — 자동 hint 없어도 수동 지정만으로 해당 모듈 화면 즉시 노출
- **`MODULE_LABELS`** (진단 드롭다운 표시용) + **`isValidDiagnosisModuleId()`** (유효성 단일 기준) export
- **단위 테스트 7건** (`resolveDiagnosisModule` 우선순위 회귀 보호)

**UI 변경**
- 진단 카드에 `<select>` "평가 모듈" 드롭다운 추가 — 옵션: "자동 (감지: 무릎)" / 각 모듈 / "해당 없음"
- 수동 지정 시 진단 배지에 `· 수동` 표시 (자동 감지 시 기존 힌트 배지 유지)
- `isCervicalDiagnosis || isSpineDiagnosis` (= 축상병) 수동 지정 시 좌/우 라디오 자동 숨김
- **IntakeWizard 연동**: `completeIntake()` 시 `diagnoses` 배열의 명시 `moduleId` 값들을 `selectedModules`에 자동 병합 → 모듈 선택 단계를 건너뛰어도 수동 지정 모듈은 활성화
- **`updateDiagnoses` 연동**: 기존 환자 편집 시 수동 지정 모듈을 `activeModules`에 자동 추가 (기존 `modules[id]` 데이터 보존)

**자동 매핑 키워드 보강**
- `족관절|발목` → knee(임시 흡수, 전용 모듈 추가 시 분리 예정)
- `척골` → wrist

**Phase 24-B: 인트라넷 Workspace Autosave 비활성화**

- 인트라넷 모드에서 서버 patient sync가 단일 진실원이므로 로컬 autosave 복구 confirm 흐름은 개념적으로 부적절
- **`src/core/utils/workspaceAutosavePolicy.js`** 신설 — `isIntranetWorkspaceMode()`, `shouldUseWorkspaceAutosave()`
- **`useWorkspacePersistence`**: 복구 effect를 `autosaveEnabled` 단일 의존성 + `useRef` 1회 가드로 정리
- **`workspaceRepository`**: `loadAutosave` / `saveAutosave`에 인트라넷 가드 (`clear`는 모드 전환 cleanup 유지)
- **MainHeader**: 인트라넷에서 자동저장 표시 보조 가드
- 정책 헬퍼 + repository + 훅 단위 테스트 추가

### Phase 25: 척추 공식 정정 + 레거시 보존 + 여성 중증도 분리 (v5.1.3)

**공식 정정 (V513)**: 원형 MDDM 공식 `D_r = √(Σ F²·t / 8h) · 8h`와의 단위 불일치 정정. 이전 구현은 `sqrt(Σ F²·t_초) / 1000 / 60`으로 8h 정규화·재곱 누락, 시간이 초 상태로 합산되어 표기(`kN·h`)와 차원 불일치. 새 공식 결과는 이전 대비 약 ×2.83(=√8) 균일 증가.

**레거시 결과 보존**: 모듈 데이터에 `formulaVersion` 필드 신설. 환자별로 옛 공식/새 공식을 분기:
- 신규 파일 `src/modules/spine/utils/formulaVersion.js` — `SPINE_FORMULA_V513`, `SPINE_FORMULA_LEGACY` 상수만 export (상수만 필요한 파일이 계산 모듈 전체를 끌고 오지 않도록 분리)
- `calculations.js`: `calculateDailyDose(tasks, formulaVersion)`가 `calculateDailyDoseV513` / `calculateDailyDoseLegacy`로 분기. 옛 함수는 반환 키(`sumFSquaredT`, `dailyDoseNs`, `dailyDoseKNh`)까지 그대로 보존
- 신규 환자 (`createSpineModuleData`, sample data 2곳): `formulaVersion: 'v5.1.3'` 기본값
- 기존 환자 (필드 부재): legacy 공식 사용 → 일일선량·평생누적량·위험도·작업별 일일 기여 모두 v5.1.2 출력과 100% 동일
- 자동 승격 진입점: `SpineEvaluation` 사용자 task 편집 4개 핸들러(add/remove/update/reorder) + `spine/index.js` `presetConfig.applyToModule` + `BatchImportModal` (실제 task 생성/`Object.assign` 시점만)
- 자동 승격 **제외**: `SpineEvaluation`의 sharedJobId 마이그레이션 effect — 단순 열기에서 공식이 바뀌는 회귀 방지
- `computeSpineCalc` return 객체에 `formulaVersion` 포함 → 표시부에서 단일 작업 기여도도 같은 공식으로 분기

**작업별 일일 기여 표시 (`getSpineTaskDoses`)**:
- V513: 총 일일선량을 `F²·t` 비중대로 배분 → 작업별 합 = 총량 (합산 무결성, `totalWeight===0` 가드 포함)
- legacy: 기존 단일 작업 공식 `(F × √t_초) / 60000` 그대로 (이전 PDF 출력 100% 보존, 합산 무결성 포기)
- 입력 배열 index 기준 반환 — task.id/reference 비교는 `computeSpineCalc`이 task 객체를 재생성하는 흐름 때문에 fragile

**여성 중증도 경계값 분리**: `classifySpineSeverity(dailyKNh, maxForce, gender)` 신규 export
- 남성 (기존 유지): 고도 >4 kN·h 또는 ≥6,000N / 중등도상 >3 또는 ≥5,000 / 중등도하 ≥2 또는 ≥4,000 / 경도
- 여성 (신설): 고도 >3 kN·h 또는 ≥5,000N / 중등도상 >2 또는 ≥4,000 / 중등도하 ≥0.5 또는 ≥3,000 / 경도
- 임계치(`thresholds.dailyDose` 남 2.0 / 여 0.5)는 MDDM 원문값이라 별도 유지

**코드 정리**: `reportGenerator.js`·`exportService.js`에 중복되던 spine 중증도 분류 & 작업별 기여 계산 → `calculations.js`의 공통 헬퍼로 추출. 두 파일은 `getSpineTaskDoses`/`classifySpineSeverity`를 import해서 사용.

**서버 영향**: 없음 — `formulaVersion`은 JSONB payload에 자연 흡수, 스키마 마이그레이션 불필요.

> 이후 v5.1.4(척추 공식 버전 배지 UI 노출)·v5.1.5(임계치/중증도 v5.1.3 스케일 재조정 + 위험/업무관련성 BSG 단일화)는 patch 범프로, 상세 내역은 README 변경 이력 참조.

---

### Phase 26: 척추 모듈에 전신진동(BK2110) 추가 + MDDM과 공존 (v5.1.6)

척추 모듈을 요추 압박력(MDDM) 단일 평가에서 **MDDM + 전신진동(BK2110) 공존** 구조로 개편. 상세 도메인 설명은 §4.2 참조.

**상호배타 → 공존 (핵심 구조 변경)**:
- 1차 구현의 `evalMethod` 디스패처(MDDM/WBV 택일)가 종합소견·EMR·엑셀에 한 평가만 출력하던 문제를 해결. `computeSpineCalc`가 `{ ...computeMddmCalc(), mddmStatus, vibration: computeVibrationCalc() }`로 **둘 다 반환** — MDDM 평탄 필드는 top-level 유지(기존 consumer·테스트 무변경), WBV는 `calc.vibration` 서브객체. top-level `evalMethod` 제거(이를 읽던 SpineResultPanel·sectionText·exportHandlers 가드도 제거).

**3상태 토글 + 출력 게이트**:
- `mddmStatus`·`vibrationExposureStatus` 각 `unknown`(미평가)/`none`(노출없음)/`present`(노출있음). **`present`일 때만** 결과 패널·종합소견·EMR·엑셀에 표시(none·unknown은 전부 생략 — 공간 절약). 편의상 MDDM 기본 `present`, WBV 기본 `unknown`.
- 완료 판정 `isSpineAssessmentComplete` = `(isMddmComplete ‖ isVibrationComplete) && isSpineDiagnosisComplete` — 둘 중 하나만 평가해도 완료.
- 하위호환 헬퍼 `resolveMddmStatus`(calculations.js)·`resolveVibrationStatus`(vibrationCalc.js): 기존 환자(MDDM 작업 있으면 present)·1차 `evalMethod:'wbv'` 환자(intervals 있으면 WBV present, MDDM은 unknown) 마이그레이션. `createSpineModuleData`만 기본 unknown.

**전신진동 계산 엔진**:
- 신규 `vibrationCalc.js` — `intervalA8`/`combineA8`(에너지합)/`jobDV`(0.63 게이트)/`computeVibrationCalc`/`isVibrationComplete`. aw 범위(min/max)로 Amax(8)·DV를 구간 산출, 다중 직업은 Amax(8) 직업별 최대 + DV 합산. 기준 일일 0.63 / 평생 1400, risk는 평생 DV 기준.
- 순환참조 회피: `convertTimeToSeconds`를 leaf util `time.js`로 추출(calculations↔vibrationCalc 단방향).
- invalid 구간(상한<하한 등) 계산 제외 + `validation`으로 경고·완료 불가.

**UI**: SpineEvaluation을 얇은 쉘로 — 상단 탭(`activeSpineTab`)으로 MddmEvaluation/VibrationEvaluation 편집 전환, 결과 패널(SpineResultPanel + VibrationResultPanel)은 둘 다 렌더(status 게이트). 각 에디터 맨 위 3버튼 상태 토글. 신규 `VibrationIntervalManager`/`VibrationIntervalEditor`(aw 범위·1일 노출시간 단위별 max·직업력 없으면 추가 비활성)·`VibrationResultPanel`. 입력 패널 하단 장비별 aw 참고표(`public/images/wbv-acceleration-chart.png`, 접기/펼치기).

**텍스트·내보내기 단일 소스**: `sectionText.js`의 `buildSpineSectionText`가 MDDM 섹션(mddmStatus 게이트) + WBV 섹션(`buildVibrationSectionText`)을 함께 출력 → reportGenerator·exportService 무수정. exportHandlers `excelSingle`은 'MDDM 평가'·'전신진동 평가' 시트를 status별 조건부 추가. 일괄 엑셀 `generateBatchRows`는 MDDM `present`일 때만 작업 행 생성.

**기타**: `patientCompletion`이 `isComplete`에 `activeModules` 전달(진단 모듈 매핑 fallback 보강). AI 시스템 프롬프트(StepContent)에 BK2110 기준(Amax(8)≥0.63·DV 1400) 추가. cervical `generateJobNarrative` 미사용 인자 제거(lint). 신규 테스트 `vibrationCalc.test.js`, `sectionText.test.js` WBV 케이스 추가 — 전체 442개 통과, build:web 성공.

**서버 영향**: 없음 — `vibrationIntervals`·status 필드는 JSONB payload에 자연 흡수, 스키마 마이그레이션 불필요.

---

## 부록 A: MDDM 자세 코드

| 카테고리 | 코드 | 설명 | 이미지 |
|----------|------|------|--------|
| **들기 (Lifting)** | G1 | 직립 자세, 중량물 몸 가까이 | From → To 쌍 |
| | G2 | 직립 자세, 중량물 몸에서 먼 거리 | From → To 쌍 |
| | G3 | 상체 약간 구부림 (20°), 중량물 가까이 | From → To 쌍 |
| | G4 | 상체 약간 구부림 (20°), 중량물 멀리 | From → To 쌍 |
| | G5 | 상체 깊이 구부림 (45°), 중량물 가까이 | From → To 쌍 |
| | G6 | 상체 깊이 구부림 (45°), 중량물 멀리 | From → To 쌍 |
| **운반 (Carrying)** | G7 | 운반 (들고 이동) | 단일 |
| | G8 | 어깨 위로 운반 | 단일 |
| | G9 | 계단 운반 | 단일 |
| **들고 있기 (Holding)** | G10 | 서서 들고 있기 | 단일 |
| | G11 | 구부려 들고 있기 | 단일 |

## 부록 B: 무릎 평가 로직

### B.1 신체부담정도 판정 매트릭스

두 변수의 조합으로 4단계를 판정한다:
- **W**: 일일 중량물 취급량 (kg/일)
- **T**: 일일 쪼그려앉기 시간 (분/일)

| W ＼ T | T < 60 | 60 ≤ T < 120 | 120 ≤ T < 180 | T ≥ 180 |
|--------|--------|--------------|---------------|---------|
| **W < 2,000** | 경도 | 중등도하 | 중등도상 | 중등도상 |
| **2,000 ≤ W < 3,000** | 중등도하 | 중등도하 | 중등도상 | 고도 |
| **W ≥ 3,000** | 중등도하 | 중등도상 | 고도 | 고도 |

각 등급에는 점수 범위가 부여된다:

| 등급 | 최소 점수 | 최대 점수 |
|------|-----------|-----------|
| 고도 | 6.0 | 9.0 |
| 중등도상 | 3.0 | 6.0 |
| 중등도하 | 2.0 | 4.0 |
| 경도 | 1.0 | 2.0 |

### B.2 업무관련성(신체부담기여도) 산출

직종별 신체부담 점수와 근무기간을 합산한 뒤, 나이 요인과의 비율로 기여도를 산출한다:

```
각 직종 i에 대해:
  burden_i = calculatePhysicalBurden(W_i, T_i) → (minScore, maxScore)
  period_i = getEffectiveWorkPeriod(job_i)      → 근무년수

sumMin = Σ (minScore_i − 1) × period_i
sumMax = Σ (maxScore_i − 1) × period_i

ageFactor = 만나이 − 30   (만 30세 이하이면 기여도 0%)

기여도(%) = sum / (ageFactor + sum) × 100
  → min% ~ max% 범위로 산출
```

### B.3 누적 신체부담 판정

```
평균 기여도 = (min% + max%) / 2
  ≥ 50%  →  "충분함"
  < 50%  →  "불충분함"
```

## 부록 C: 주요 의존성 버전

### 클라이언트

| 패키지 | 버전 |
|--------|------|
| react | 18.2.0 |
| react-dom | 18.2.0 |
| vite | 5.0.0 |
| electron | 22.x |
| xlsx | 0.18.5 |
| html2pdf.js | 0.10.1 |

### 서버 (인트라넷 모드, v5.0.0)

| 패키지 | 버전 |
|--------|------|
| node | 20 (Docker 컨테이너) |
| typescript | 5.x |
| express | 4.x |
| pg | 8.x (PostgreSQL 드라이버) |
| bcrypt | 5.x |
| jsonwebtoken | 9.x |
| zod | 3.x (DTO 검증) |
| vitest | 1.x (테스트) |

### 통계 엔진 (v7.0.0, `services/stats-engine/requirements.txt` 고정)

| 패키지 | 버전 |
|--------|------|
| numpy | 1.26.4 |
| scipy | 1.13.0 |
| statsmodels | 0.14.2 |
| pandas | 2.2.3 (statsmodels 0.14.2 호환 위해 핀 고정) |
| jsonschema | 4.22.0 |

### 인프라

| 컴포넌트 | 버전 |
|----------|------|
| PostgreSQL | 16 (alpine) |
| Caddy | 2 (alpine) |
| Docker Engine | 24+ |
| Docker Compose | v2.17+ (`!reset` 태그 필수) |

---

## 변경 이력

### v7.1.2 (2026-10-09) — 무릎 노출 변수 직력 기간 가중평균·누적 개편 + 대표 직종명 disease grain 선택 + 제한 데이터 열람 권한자 기술통계 소수 셀 해제 + 오프라인 패키징 수정 (#143~#147)

v7.1.1 문서 반영(#142) 이후 병합된 다섯 건을 묶은 패치 릴리스다. 통계 워크벤치의 무릎 쪼그려앉기·중량물 변수가 직업력 단순합에서 직력 기간 가중평균·누적으로 바뀌었고, 대표 직종명을 상병(disease) grain에서도 고를 수 있게 되었으며, 제한 데이터 열람 권한자는 기술통계의 소수 셀 제한을 응답 시점에 해제해 볼 수 있다. 운영에는 v7.1.1까지 배포되어 있고 이 버전이 다음 배포 대상이다.

- **무릎 쪼그려앉기·중량물 변수 개편 (#146·#147, 카탈로그 v30·v31)**: 직업력 단순합이던 `knee.case.sumSquattingMinutesPerDay`·`knee.case.sumDailyLoadKg`를 삭제하고 같은 방식의 변수 4개로 교체했다. 단순합은 직력이 많을수록 값이 부풀고 기간이 반영되지 않았다.
  - **가중평균**: `knee.case.weightedSquattingMinutesPerDay`(분/일)·`knee.case.weightedDailyLoadKg`(kg/일) = Σ(노출값 × 종사 연수) ÷ Σ 종사 연수.
  - **누적**: `knee.case.cumulativeSquattingHours`(시간 = Σ 분/일 ÷ 60 × 연간 근무일 × 종사 연수)·`knee.case.cumulativeLoadTon`(톤 = Σ kg/일 ÷ 1000 × 연간 근무일 × 종사 연수). 예: 3000kg·2년 + 2000kg·8년(근무일 250) → 가중평균 2200 kg/일, 누적 5500톤.
  - **공통 규칙**: 네 변수가 한 구현을 공유한다. 신체부담평가 미포함 직력은 분자·분모에서 제외하고 전부 미포함이면 `not_applicable`, 노출값이 blank인 직력은 건너뛰며 입력한 0은 정상 0, 손상값·기간/근무일 invalid는 부분값 없이 `not_entered`+`invalid`, 노출값을 입력했는데 기간(누적은 근무일 포함)이 blank면 `not_entered`다. 종사 연수는 `job.identity.tenureYears`와 같은 엄격 규칙(`jobTenure.ts`)을 쓴다. 평가자 판정의 근거 입력값이라 예측 predictor로 허용하되 용도는 "판정 일관성 점검"이다.
  - **옛 변수**: 서버가 `UNKNOWN_VARIABLE`로 거부하고 화면이 대체 변수를 안내한다. 값의 의미가 달라 자동으로 바꾸지 않는다. 카탈로그는 analytics-core 83개(case 50 / job 19 / disease 14) + 서버 전용 2개 = 통합 85개.
- **대표 직종명 disease grain 선택 (#146)**: `job.rollup.longestTenureJobNameNormalized`는 유사식별자·고카디널리티라 case→job/disease 복제가 일괄 차단돼 있었다. 이 변수에만 `broadcastToGrains: ['disease']` 변수별 예외를 두어 상병 grain에서 선택할 수 있게 했다(일반 규칙과 job grain 차단은 그대로, 허용 목적은 연관성만). 플래그는 카탈로그 DTO 계약으로 클라이언트에 전달된다. 기술통계 억제가 고유 인원 기준이라 상병 행 복제로 소수 셀이 우회되지 않는다.
- **제한 데이터 열람 권한자의 기술통계 소수 셀 해제 (#145)**: 결측 인원이 1~9명이라는 이유로 변수 전체가 비공개되던 문제를 줄이기 위해, `stats.export_limited_rows` 권한자에게는 기술통계(일반 + 담당의 층화)의 범주별 억제·"기타" 병합·결측 연결 억제·total 강제 억제를 응답 시점에 해제한다. 캐시에는 집계 결과만 저장하고 해제는 조회자의 현재 권한으로 원본 행에서 다시 계산하며, 계산 뒤 공개·감사 직전에 권한을 재검사한다. 일반 사용자의 억제 규칙은 그대로다. 결과·미리보기 계약에 `limitedDisclosure`를 추가했고 마이그레이션 `0036`은 관리자 콘솔 권한 설명 문구만 갱신한다.
- **오프라인 패키징 수정 (#143·#144)**: 패키지에 `updates/` 디렉터리를 포함하고(설치본·`.blockmap`·`latest.yml`), 콘솔 인코딩이 cp949일 때 한글 설치본 파일명이 깨져 설치본이 패키지에서 조용히 빠지던 문제를 고쳤다(검증기 출력을 ASCII로 고정, 복사 실패 시 중단).
- **버전 상수**: `CATALOG_VERSION` v31-knee-load-weighted-cumulative, `RESULT_SCHEMA_VERSION` v11-limited-disclosure, `SUPPRESSION_RULE_VERSION` v7-discrete-other-merge(변경 없음) — 기존 분석 실행 결과는 재사용되지 않고 새 규칙으로 다시 계산된다.
- **배포 영향**: ① 마이그레이션 0036(서버 기동 시 자동 적용, 권한 설명 UPDATE만 — 운영이 v7.1.1이므로 새로 적용되는 마이그레이션은 0036 하나) ② 운영 `.env.production`의 `WR_VERSION=7.1.2` ③ 쪼그려앉기·중량물 합계 변수를 쓴 저장 레시피는 재실행 시 삭제 안내가 나오므로 새 변수로 다시 선택 ④ Electron 재설치는 필요 없다(서버 SPA 로드, EMR 헬퍼 변경 없음).
- **알려진 사항**: ① 연간 근무일은 앱이 모든 직력에 250을 기본으로 채우고(빈 입력·0도 250으로 복원, 구형 무릎 마이그레이션도 250 백필) 입력값과 기본값을 구분할 수 없어, 근무일을 확인하지 않은 직력의 누적은 250일/년 가정값으로 계산된다. 입력 여부 추적은 후속 과제다. ② 저장해 둔 통계 레시피에는 카탈로그 버전이 없어, 의미가 바뀐 변수를 다시 실행하면 값이 달라질 수 있다(실행 캐시만 버전으로 분리됨). ③ #145의 서버 통합 테스트는 실제 Postgres로 돌렸지만 #146·#147은 단위·UI 테스트와 웹 빌드까지만 확인했고 실DB 통합 테스트와 실화면 확인은 하지 않았다. ④ bcrypt 네이티브 빌드 의존 테스트, Python 모듈이 필요한 예측 smoke, 이변량·회귀 통합 일부는 이 변경과 무관하게 변경 전에도 실패한다.

### v7.1.1 (2026-10-08) — 직력별 신체부담평가 미포함 선택 + EMR·엑셀 확인 상병 내보내기 변경 + 범주형 "기타" 병합·원본 히스토그램 경계 정렬 (#137~#141)

v7.1.0 이후 병합된 다섯 건을 묶은 패치 릴리스다. 직력 단위로 신체부담 평가 대상을 고를 수 있게 되었고, EMR·엑셀의 "확인 상병" 칸이 신청 상병 복사에서 종합소견 입력 기준으로 바뀌었으며, 기술통계의 범주형·히스토그램 공개통제가 보강되었다.

- **직력별 "신체부담평가 미포함" 선택 (#140)**: 직력 카드의 직종명 옆에 `신체부담평가 [포함] [미포함]` 라디오를 두었다(기본 "포함"). 미포함 직력은 카드가 음영·점선으로 바뀌고 헤더에 배지가 붙으며, 입력 필드는 그대로 편집할 수 있다.
  - **평가·결과·완료 판정에서 제외**: 무릎·어깨·팔꿈치·손목·경추·척추 6개 모듈의 평가 화면(직력 탭·입력 카드), 결과, 완료 판정에서 미포함 직력이 빠진다. 입력해 둔 값(`jobExtras`·`jobEvaluations`·task·구간)은 지우지 않으므로 다시 "포함"으로 바꾸면 그대로 돌아온다(모듈 sync에는 항상 전체 직력을 넘기고 계산 결과 단계에서만 거른다). MDDM·전신진동은 `sharedJobId`가 없는 task·구간의 귀속(첫 직력)을 필터 전 전체 직력 기준으로 정한 뒤 미포함 직력에 귀속된 항목만 제외하며, 검증 메시지·최대값·합산·완료 판정이 같은 목록을 쓴다.
  - **직업력 출력**: 종합소견 미리보기·엑셀 "4.직업적 요인"·EMR `txtJobCusCont`/`txtSyth1Cont`의 `[직업력]`에는 미포함 직력도 남기되, 포함 직력을 먼저 두고 미포함 직력을 가장 끝에 `신체부담평가에는 미포함`을 붙여 출력한다(공통 함수 `jobHistory.js`로 세 곳을 통일). 포함 직력은 직력1..k로 모듈 블록의 직력 번호와 일치하며, 어깨 `[직력별 기여]`의 번호도 직업력 번호와 맞춘다. 미포함 직력이 없는 환자의 출력은 종전과 같다.
  - **전부 미포함**: 모듈은 "평가 대상 없음"으로 완료 처리되고(상병 평가 입력은 여전히 필요), 결과 패널과 종합소견·EMR의 모듈 블록은 "누적 신체부담 불충분" 같은 임상 결론 대신 평가 대상 없음 한 줄만 출력한다. 팔꿈치·손목의 완료 판정 순서는 상병 평가 → 직력 0개 → 전부 미포함 → 공통·직력별 입력으로 재배치했다.
  - **구형 직업 필드 보호**: `shared.jobs`와 함께 구형 직업 필드(`modules.knee.jobs`, `modules.spine`의 `jobName`·`careerYears`·`careerMonths`·`workDaysPerYear`)가 남은 환자는 직력과 연결을 확정할 수 없어 미포함 설정을 로드 시점에 해제하고 UI에서 선택을 막는다(`migratePatient`, 클라이언트 완료 판정, 서버 `verifyAllModulesComplete`, `deterministicMigrate`). 정상적으로 마이그레이션된 환자에게는 영향이 없다.
  - **영상 분석**: 새 공정의 기본 직력을 첫 "포함" 직력으로 잡고, 직력 선택 목록에 `(신체부담평가 미포함)`을 표기한다.
  - **경추 화면**: 조기 return이 hook보다 앞에 있던 기존 결함(환자 전환 시 hook 개수 변동)을 함께 수정했다.
- **통계 워크벤치: 신체부담 변수만 제외 (#141, 카탈로그 v29)**: job grain 신체부담 변수(`knee.job.*`, `shoulder.job.*`)는 미포함 직력도 행(엔터티)을 유지한 채 값만 `not_applicable`로 반환한다(데이터셋 빌더의 엔터티:관측 1:1 검증 때문에 관측을 생략하지 않는다). case 집계(무릎·어깨 합계·`relatedness`·`anyExceeded`, 경추 누적부하·비중립시간, 팔꿈치·손목 부담등급, 척추 MDDM 선량·진동 DV)는 포함 직력만 반영하고, 전부 미포함이면 `not_applicable`(미입력 `not_entered`와 구분, 노출 상태 `unknown`의 `not_assessed`보다 먼저 판정)이다. 미포함 직력의 손상값이 포함 직력의 통계에 `invalid`로 남지 않도록 품질 검증을 계산에 쓴 목록 기준으로 맞췄고, 경추는 전체 직력 기준으로 task 귀속을 확정한 뒤 미포함 직력의 task만 제거한다. 직종명·근속 같은 직업력 정보 변수(`job.identity.*`)는 미포함 직력도 그대로 집계한다. 신체부담 변수 24곳의 `dependsOn`에 `shared.jobs[].excludeFromAnalysis`를 연결하고 `CATALOG_VERSION`을 `v29-exclude-from-analysis`로 올렸다.
- **EMR·엑셀 "확인 상병"을 종합소견 입력 기준으로 (#139)**: 엑셀 "3.최종 확인 상병명"과 EMR `txtAppv_Sick_Cont`에 신청 상병 전체가 아니라 종합소견에서 상병 상태를 "확인"으로 입력한 상병만 내보낸다(낮음 사유의 "상병 미확인"은 보지 않음). 양측 상병에서 한쪽만 확인되면 `(우)`/`(좌)`를 붙이고, 단측 상병·양쪽 모두 확인·척추·경추는 방향 없이 `코드 이름`만 쓴다. 방향 미선택 상병은 제외되고, 패턴 그룹 모드에서는 원본 순번(`#N.`)을 유지한다. 확인 상병도 CP949 한도로 절단하고 절단 필드에 기록한다. 전송 전 경고는 종합소견 한도 초과와 확인 상병(0건·한도 초과)을 확인창 한 번으로 합쳐 보여준다. EMR 헬퍼는 빈 값이면 칸을 건드리지 않으므로, 확인 상병이 0건이면 EMR에 이미 입력된 값이 남는다는 점을 경고로 알린다(헬퍼 변경 없음).
- **범주형 소수 범주 "기타" 병합 + 권한자 원본 범주 빈도 (#137)**: 범주형(`high_cardinality` 포함) 기술통계에서 1~9명인 소수 범주를 "기타"로 합쳐 공개한다(합이 10명 미만이면 가장 작은 공개 범주부터 끌어와 채운다). 이름 붙은 범주가 2개 미만이면 억제하고, 최빈값은 "기타"를 제외한다. 병합은 일반 기술통계 경로에서 ordinal이 아니며 요청 변수가 그 범주형 하나뿐이고 결측 인원이 소수셀이 아닐 때만 한다(다른 변수가 "기타" 안을 쪼개 보여 소수 범주가 역산되는 것을 구조적으로 막음). `stats.export_limited_rows` 권한자에게만 응답 시점에 원본 범주 빈도(`rawLevels`)를 붙이고(결과 캐시에 저장 안 함, 붙을 때 감사 기록), 동점 최빈값은 코드유닛 순서로 고정해 서버 로케일에 따라 갈리지 않게 했다. 마이그레이션 `0035`로 권한 표시명을 "제한 데이터 열람(원본 값·원본 분포)"로 넓혔다(키 불변).
- **권한자 원본 히스토그램 경계 정렬 (#138)**: 권한자가 보는 원본 히스토그램의 구간 경계를 최솟값 기준 균등분할 대신 1·2·5 × 10^e 폭의 배수(보기 좋은 정수·소수)로 정렬하고, 정수 데이터는 반개구간 `[k, k+1)`으로 최댓값도 자기 구간을 갖게 했다. 정렬이 불가능하거나 검증에 실패하면 균등분할로, 그것도 유효하지 않으면 구간 수를 줄여 어떤 입력에서도 폭 0 구간 없이 건수 합이 맞는다. 가로축 눈금은 막대 경계 좌표에 두고 라벨 겹침을 방지한다. 공개용 히스토그램은 바뀌지 않았고(같은 변수라도 권한자 원본과 경계가 다를 수 있음, 화면에 안내), 결과 스키마·마이그레이션 변경은 없다.
- **버전 상수**: `COMPLETION_ENGINE_VERSION` v2 / `COMPLETION_SCHEMA_VERSION` 2(완료 판정 의미 변경 — 서버가 새로 검증해 기록하는 행부터 v2), `CATALOG_VERSION` v29-exclude-from-analysis, `SUPPRESSION_RULE_VERSION` v7-discrete-other-merge, `RESULT_SCHEMA_VERSION` v10-discrete-other-raw-levels — 기존 분석 실행 결과는 재사용되지 않고 새 규칙으로 다시 계산된다.
- **배포 영향**: ① 마이그레이션 0035(서버 기동 시 자동 적용, 권한 라벨·설명 UPDATE 1건) ② 운영 `.env.production`의 `WR_VERSION=7.1.1` ③ 원본 값·분포를 볼 사용자에게는 7.1.0과 같이 관리자 콘솔 "통계 권한" 탭에서 "제한 데이터 열람(원본 값·원본 분포)"을 부여(이미 부여된 사용자는 그대로 유지). Electron 재설치는 필요 없다(서버 SPA 로드, EMR 헬퍼 변경 없음) — 다만 EMR 주입으로 달라지는 확인 상병·직업력은 서버 배포 후 다음 로드부터 적용된다.
- **알려진 사항**: ① 일괄 입력 양식 엑셀은 raw 데이터 export라 미포함 직력도 행에 그대로 들어가며, 그 파일을 다시 가져오면 미포함 설정은 "포함"으로 돌아간다. ② 저장해 둔 통계 레시피를 다시 실행하면 미포함 직력이 있는 환자의 신체부담 변수 값이 달라질 수 있다(실행 캐시만 버전으로 분리됨). ③ `statsBivariateHttp` welch_t 2건·`statsRegressionHttp` 표준화 1건 통합 테스트 실패는 v7.0.0(main)에서도 동일하게 재현되는 기존 문제다 — 별도 수정 예정. ④ 서버 DB 통합 테스트와 도커 postgres 종단 확인은 이번 변경에 대해 실행하지 않았다.

### v7.1.0 (2026-10-06) — 통계 히스토그램: 양 끝 소수 구간 병합 + 권한자 원본 히스토그램 (#135)

실서버 기술통계에서 히스토그램 대부분이 "분포를 표시하기에는 공개 가능한 구간이 부족합니다"로 억제되던 문제를 고쳤다. 균등분할의 끝 구간(치우친 분포의 꼬리, 극단값)에 1~9명만 있어도 재분할 사다리(최소 3구간)가 전부 실패했기 때문이다.

- **공개 판정 (기본 사용자)**: 해상도마다 "그대로 → 양 끝 소수셀 구간을 안쪽 이웃과 병합" 순으로 시도하고, 실패하면 기존처럼 재분할 후보로 내려간다. 병합 인원은 person 합집합으로 다시 세고, 가운데에 소수셀이 남거나 3구간 미만이면 그 해상도는 실패한다(가운데 병합은 하지 않음). 병합 구간의 바깥 경계는 이미 공개되는 최솟값·최댓값이다.
- **원본 구간 기준 구현을 Node로 통일**: `buildOriginalHistogram` 하나가 집계 경로와 권한자 원본 모두를 만든다. 경계는 numpy `linspace`와 같은 연산 순서로 계산한다(기존 식은 [0,1]·5구간에서 0.6을 다른 구간에 배정). numpy 대조 픽스처 58케이스로 경계·건수 정확 일치를 고정했다. Python 엔진의 `histogram` 출력은 더 이상 쓰지 않는다(제거는 후속).
- **권한자 원본 히스토그램(`rawHistogram`)**: `stats.export_limited_rows` 권한자에게만 응답 시점에 붙인다(결과 캐시에 저장 안 함, 응답마다 감사 기록). 공개 조건은 변수 공개뿐이며 이상치 원값 게이트와 독립이다. 권한 회수는 다음 서버 응답부터 반영된다.
- **화면**: 병합 막대는 옅은 면+점선 테두리, 툴팁·표에 병합 구간 폭 표시, 세로축 제목 "구간별 관측 건수", 원본 표시 시 외부 공유 주의 안내.
- **권한 표시명 변경 (마이그레이션 0034)**: 관리자 콘솔 "통계 권한" 탭의 `stats.export_limited_rows` 표시명을 "행 단위 제한데이터 내보내기"에서 **"제한 데이터 열람(원본 값·원본 히스토그램)"**으로 바꿨다(키 불변). 이 권한은 이상치 원값·산점도 원시 점·회귀 관측치 진단값·원본 히스토그램을 함께 연다. 행 단위 파일 내보내기는 여전히 없다.
- **버전 상수**: `CHART_DISCLOSURE_POLICY_VERSION` v3-histogram-tail-merge, `RESULT_SCHEMA_VERSION` v9-histogram-tail-merge-raw — 기존 분석 실행 결과는 재사용되지 않고 새 규칙으로 다시 계산된다(버전이 다른 과거 실행 조회는 저장된 집계만 반환).
- **효과 (합성 데이터 억제율, 기존 → 변경 후)**: 로그정규 100명 99% → 13%, 정수 몰림 100명 79% → 0%, 정규 50명 68% → 10%, 극단값 1~3개 200명 100% → 60%. 극단값 분포와 30명 이하는 구조적으로 여전히 많이 억제된다(후속 후보: 수염 범위 구간 + 열린 끝 구간).
- **배포 영향**: ① 마이그레이션 0034(서버 기동 시 자동 적용, 라벨·설명 UPDATE 1건) ② 운영 `.env.production`의 `WR_VERSION=7.1.0` ③ 배포 후 원본 히스토그램을 볼 사용자에게 관리자 콘솔 "통계 권한" 탭에서 "제한 데이터 열람(원본 값·원본 히스토그램)" 부여. Electron 재설치는 필요 없다(서버 SPA 로드).
- **알려진 사항**: `statsBivariateHttp` welch_t 2건·`statsRegressionHttp` 표준화 1건 통합 테스트 실패는 v7.0.0(main)에서도 동일하게 재현되는 기존 문제다(knee.relatedness 평균 변경 후 기대값 미갱신 추정) — 별도 수정 예정.

### v7.0.0 (2026-10-05) — 통계분석 워크벤치 도입 + 권한(capability)·환자 완료시각 추적 기반 (#104~#132)

인트라넷 서버에 누적된 평가 데이터를 연구용으로 집계·분석하는 **통계분석 워크벤치**를 도입했다(PR0-A~PR4-B2 + 폴리싱, 29개 PR). 클라이언트는 `AnalysisRecipe`만 보내고 **서버가 조직 격리 스냅샷에서 데이터셋을 조립**하며, 파생 공식은 클라이언트·서버가 같은 코드를 import하는 `@wr/analytics-core`로 일원화했다. **인트라넷 전용·기본 비활성**(`STATS_WORKBENCH_ENABLED=false`면 `/api/stats/*` 전체 404). 서버·DB·배포 구조(마이그레이션 6건, Python 엔진, 공유 패키지) 변경 폭이 커 major로 표기한다.

- **권한·완료 추적 (#104, #106)**: capability 권한 모델(`capabilities` + `user_capability_grants`, 마이그레이션 0028) — `stats.view`·`stats.regression`·`stats.export_results`는 **기본값 전원 허용(grant 불필요)**, `stats.export_limited_rows`(분석 응답의 이상치 원값·산점도 원시 점·회귀 관측치 진단값 노출)는 grant 필요, `stats.export_phi`는 admin+grant+step-up 예약(행 단위·PHI 내보내기는 후속 PR5로 **미구현**). 관리자 콘솔에 "통계 권한" 탭. 환자 완료시각 추적(0029) + 서버가 클라이언트 신고 없이 직접 재검증하는 `server_verified_modules_complete_at`(0030, `completion.ts`) — 환자 저장·워크스페이스 저장·영상분석 적용 경로 전부 배선.
- **공유 계산 패키지·카탈로그 (#105~#107, #113~#115, #121, #125~#126, #130)**: `packages/analytics-core`로 6개 평가 모듈의 계산·변수 추출 이관(결정적 마이그레이션·`canonicalSerializer`·coverage inventory 275개 필드 분류). 스냅샷 데이터셋 빌더(REPEATABLE READ·READ ONLY) + `GET /api/stats/catalog`·`POST /api/stats/preview`. 카탈로그는 통합 83개 변수(`v28-age-at-injury+v1-snapshot-columns`), grain 3종(case/job/disease), 공통변수 브로드캐스트, 롤업 변수(상병 any 판정·부위군·최장 근속 등), 필터 전용 변수, 어깨·경추·무릎 case 합계 변수.
- **엔진·화면 (#108, #110)**: Python subprocess 통계 엔진(`services/stats-engine/`, 별도 venv — numpy 1.26.4·scipy 1.13.0·statsmodels 0.14.2·pandas 2.2.3), `stats_runs`(0031·0032), 4열 워크벤치 화면(카탈로그·레시피·결과·Inspector/리포트), 집계 결과 CSV 내보내기.
- **분석 기능 (#111~#112, #116~#118, #120, #122)**: 기술통계 + **Table 1 층화**(담당의별/범주형 변수별) · 이변량 8종(Welch t·Mann-Whitney·ANOVA·Kruskal-Wallis·카이제곱·Fisher exact·Pearson·Spearman; 반복측정 쌍 검정은 카탈로그만 있고 실행 불가) · 상관행렬(BH-FDR) · 회귀(OLS·이분 로지스틱, HC3/person-cluster CR1, 분리 판정, 진단 플롯 4종·VIF·spline·interaction·표준화) · 예측(L2 로지스틱, grouped CV + bootstrap optimism 보정, ROC-AUC·PR-AUC·Brier·calibration) · SVG 차트 · 비동기 실행 큐(0033, admission→claim→finish, 폴링·취소). CSV는 기술통계·회귀·예측만 지원(이변량·상관행렬은 `*_EXPORT_NOT_SUPPORTED` 400).
- **공개통제**: 최소 코호트(10명) 미만 소수 셀 억제, 히스토그램 적응형 해상도, 차분 방지(15분 창 family 30회·사용자 전역 100쿼리 예산), 분석 요청 사용자당 분당 20회, 제한 필드는 응답 시점 capability 확인 후 부착.
- **UX·기타 (#109, #123, #127~#132)**: 웹(로컬) 모드 환자 전환 시 오탐 저장 실패 경고 제거 · 영상 분석 UI 가독성(우측 검토 패널·공정 입력 카드, 6.0-19)과 문구 정리 · 통계 필터 칩 제거 UI · 분석 목적 비호환 변수 비활성·숫자 서식·회귀 라벨 · 평가 시점 나이를 **만 나이(재해일자 기준)** `patient.identity.ageAtInjury`로 교체 · 상병 입력 진단명 잘림 수정 + 코드:이름 폭 1:3 · 등록 마법사 필수값 안내(이동은 허용) · 대시보드 의사명·나이 기준 수정.
- **Electron**: 메뉴 "통계분석 워크벤치" 추가(IPC `set-stats-available`/`open-statistics`). 서버가 SPA를 서빙하므로 **기존 클라이언트도 서버 업데이트만으로 헤더/랜딩 "통계분석" 버튼으로 접근 가능** — 새 설치본은 네이티브 메뉴 항목에만 필요하다.
- **배포 영향**: ① 마이그레이션 0028~0033(서버 기동 시 순차 자동 적용 — 업데이트 전 백업 필수) ② 서버 이미지에 stats venv 추가(venv 약 391MB, app 이미지 약 2.75GB 실측 — v6.5.4는 2.22GB) ③ `.env.production`의 `WR_VERSION=7.0.0` 필수, `STATS_WORKBENCH_ENABLED=true`는 통계를 켤 때만 ④ compose가 `STATS_*` env와 `WR_GIT_COMMIT` build arg를 전달(오프라인 패키지는 자동 주입) ⑤ 절차는 [docs/UPDATE_7.0.0.md](docs/UPDATE_7.0.0.md), 오프라인 패키징은 [docs/OFFLINE_DEPLOYMENT_PACKAGE.md](docs/OFFLINE_DEPLOYMENT_PACKAGE.md) §16. 패키징 스크립트는 설치본 버전이 `package.json`과 다르면 중단하고, 안내서(`UPDATE_7.0.0.md`·`OFFLINE_DEPLOYMENT_PACKAGE.md`)를 패키지에 동봉한다.
- **릴리즈 사전 검증 (격리 컨테이너·임시 DB)**: `wr-app-server:7.0.0-pre` 이미지 빌드 성공(app 약 2.75GB·stats venv 약 391MB), `--network none` selfcheck 통과, v6.5.4 스키마(0027)와 기존 환자 데이터 위에 마이그레이션 0028~0033이 자동 적용되고 기존 행은 `draft`로 보존됨을 확인. 시험 환자 약 1,800명으로 컨테이너 대상 HTTP 종단 검증 — 기술통계·Table 1·이변량(Welch t·Pearson)·상관행렬·회귀(OLS·이분 로지스틱)·예측(L2 로지스틱, 202→폴링→완료)·비동기 취소·CSV(기술통계·Table 1·회귀 성공, 이변량·상관행렬은 `*_EXPORT_NOT_SUPPORTED` 400) 통과. 권한은 기본 3종이 grant 없이 통과하고, `stats.export_limited_rows`는 grant 전·부여 후·회수 후에 제한 필드(`pointDiagnostics`·`scatter.points`·`outlierValues`) 노출이 나타났다 사라짐을 확인. 분당 20회 한도(429)와 차분 방지 예산 억제가 실제로 동작하는 것도 관측. 롤백 호환: 구버전 6.5.4 앱이 0033 스키마 DB에서 마이그레이션 없이 기동하고 로그인·환자 목록이 정상. **미검증**: 실제 병원 데이터, Electron 실기 메뉴, 구형 Chrome(80) 실브라우저 렌더링.

### v6.5.4 (2026-09-01) — 무릎 관절염 상병 K-L Grade 입력창 숨김 수정 (#102)

종합평가 패턴 그룹화 작업(#72)에서 K-L Grade를 조건부 표시로 바꾸며 넣은 화이트리스트가 실제 무릎관절염 상병 상당수를 걸러내던 문제를 수정. 입력창이 아예 렌더되지 않아 K-L Grade를 새로 입력하거나 고칠 수 없었다(기존 저장값 자체는 보존).

- **코드 조건 확장**: `supportsKlGrade()`가 M17.0/M17.9만 인정하던 것을 M17 하위코드 전체로 확장 — M17은 전 코드가 무릎관절증(gonarthrosis)이고 M17.1~M17.5(원발성·외상후·이차성 / 편측·양측)도 모두 K-L Grade 대상이다. 같은 파일의 모듈 자동 매핑(`ICD_MODULE_MAP`)은 이미 M17 전체를 무릎으로 잡고 있어 기준이 서로 어긋나 있었다.
- **상병명 조건 확장**: "무릎"+"관절증/골관절염" 인접 표기만 받던 패턴을 공백 제거 후 비교로 바꾸고 슬관절 표기·"관절염"·조사("무릎의 관절증")·수식어("퇴행성")·영문명(gonarthrosis, osteoarthritis of knee)을 수용. 이전에는 "퇴행성 슬관절염", "슬관절 골관절염", "무릎 관절염", "무릎의 관절증", "Osteoarthritis of knee"가 전부 숨겨졌다.
- **원인 기록**: 좁은 화이트리스트의 출처는 기존 테스트가 M17.5를 "원판형 반월판"(실제로는 M23 계열)으로 잘못 단정하고 false를 고정해 둔 것 — 그 단정을 뒤집고 M17.1~M17.5·상병명 표기 변형 7종을 테스트로 고정, 오탐 방지 false 케이스(M22.4 슬개골 연골연화증, M23.2 반월판장애, M75.1 회전근개 증후군)도 추가했다.
- 카드 뷰(AssessmentTab)와 패턴 그룹 뷰(AssessmentIndividualFields)가 이 게이트 함수 하나를 공유하므로 컴포넌트 변경은 없음. 검증: vitest 전체 99개 파일 / 1326건 통과.

### v6.5.3 (2026-08-27) — 손목 영상분석 timeout 오분류 수정 + dev 서버 포트 충돌 가드 (#100)

테스트 서버에서 손목(hand-wrist) 영상 분석이 GPU 없이 CPU로만 돌며 10분 job deadline을 초과해 실패하는 문제를 조사 — 실제 원인은 예전에 남아있던 도커 `app` 컨테이너(CPU 전용 pose-venv)가 포트 3001을 선점해 GPU 있는 네이티브 dev 서버가 EADDRINUSE로 조용히 죽어있던 것. 재발 방지 및 실패 원인 가시성 개선.

- **timeout 오분류 수정**: execFile timeout(deadlineMs)으로 추론 subprocess가 kill되는 경우를 `err.killed`로 식별해 error_code를 뭉뚱그린 `INFERENCE_ERROR` 대신 `DEADLINE_EXCEEDED`로 명확히 표시(stderr가 ONNX 경고로 500자를 다 채워 실제 원인이 안 보이던 문제).
- **dev 서버 포트 사전 점검**: `dev-intranet-server.ps1` 기동 전 포트(3001) 점검 추가 — 도커 app 컨테이너가 선점 중이면 자동으로 내리고 재확인, 그 외 알 수 없는 프로세스면 즉시 에러로 중단(과거엔 EADDRINUSE로 조용히 죽어 `-NoExit` 창만 몇 시간째 방치됨).
- **down 스크립트 안전 가드**: `dev-stack-down.ps1`이 포트 소유 프로세스가 `node.exe`일 때만 강제 종료하도록 수정 — 그 외(도커 포워딩 프로세스 등)는 경고만 남기고 건너뜀(잘못하면 Docker Desktop 전체가 죽을 위험이 있었음).
- 검증: 신규 vitest 케이스 포함 22건 통과, `tsc --noEmit` 클린, 실제 환경에서 포트 충돌 재현 후 수정 → 손목 분석이 `inference_device_used=cuda`로 정상 완료 확인.

### v6.5.2 (2026-08-27) — 영상분석 flat 참고 후보 골격 검수·근거 패널 배선 (#98)

무릎/어깨(job-scope)·척추/경추(task-scope) candidate에만 있던 골격 검수·"왜 이 값?" 근거 패널이, 나머지 4개 모듈(무릎 비틀림·어깨/팔꿈치 반복·손목 반복/각도)의 candidate가 모이는 "flat 참고 후보" 리스트에는 배선돼 있지 않던 문제를 수정. evidence 데이터 자체는 서버 실분석 경로에 이미 있어(candidate도 evidenceByFeatureKey·fusion.candidates·segments를 받음) 렌더 배선만 추가.

- **골격 검수·근거 패널 배선**: flat 참고 후보의 공정별 서브행(processId 단위)에 골격 검수 버튼 + "왜 이 값?" 근거 패널 연결. 검증 불가능한 "호출 누락" 성격의 버그라 순수 헬퍼가 아닌 jsdom 렌더 테스트(신규 `FlatCandidateList` 컴포넌트 추출)로 stub 호출 여부·인자를 직접 검증.
- **Left/Right 반복시간 근거 환산식 오류 수정**: `repetitiveMediumHoursLeft/Right`·`repetitiveFastHoursLeft/Right` 4종은 candidate value가 raw ratio라 근거 패널이 비율을 환산된 시간/일 값인 것처럼 오표시(예: "0.2 시간/일 = 자세비율 0.2 × 활동 200분/일 ÷ 60")하던 문제 — 근거 패널 전달 직전에만 `candidateHoursPerDay`로 보정.
- 손목 각도 하드게이트로 "비교 시점" 버튼이 안 뜨는 것이 정상 동작임을 주석·테스트로 고정.
- 검증: 배선/환산식 보정을 일시 제거해 신규 테스트가 실제로 실패하는 것을 확인 후 원복(회귀 검출력 직접 증명). 클라이언트 전체 1326건 통과.

### v6.5.1 (2026-08-27) — 비담당 환자 조회 시 막혀 있던 조회 전용 토글 상호작용 수정 (#96)

담당 아님(read-only)으로 열람 중인 환자 화면에서 데이터 편집뿐 아니라 화면 전환용 토글까지 통째로 막혀 있던 문제를 수정. StepContent의 capture-phase 차단(blockInteraction/blockMutatingKeys)에 이미 있던 `data-readonly-allow` 탈출구를 조회 전용 컨트롤들에 적용했다.

- **종합평가**: 그룹/개별 카드 보기 전환, 그룹→개별 상병 칩 이동(그룹 카드·방향 미선택 섹션·개별 입력 항목 3곳), 구성원 펼치기/접기, 우/좌 분리 표시.
- **영상분석**: 골격 검수 열기/닫기, "왜 이 값?" 근거 패널(제안/관찰값 행).
- **척추/경추**: 작업·구간 목록 행 선택, 직력 탭, MDDM/전신진동 탭.
- **이중 용도 토글 분리**: "보기 전환"과 "저장"이 겹친 컨트롤(패턴 그룹/개별 카드, MDDM/WBV 탭, 노출 여부 미평가·노출없음·노출있음 — 실데이터이자 하위 컨텐츠 표시 게이트)은 canMutate=false일 때 저장을 시도하는 대신 로컬 오버라이드로만 화면을 전환하도록 분리, 환자 전환 시 오버라이드가 새지 않도록 리셋 effect에 patient.id 포함.
- **접근성 정리**: 컨테이너 레벨 aria-disabled(혼합 활성/비활성 컨테이너에 부적합한 패턴) 제거 — 배너·스타일로만 read-only 안내.
- 검증: 실제 프로덕션 차단 로직을 씌운 read-only 래퍼 안에서 클릭 허용/차단을 검증하는 테스트 추가, 클라이언트 전체 98개 파일/1305건 통과.

### v6.5.0 (2026-08-09) — Electron 셸 자동 업데이트(트랙 2) + 종합소견 직접 편집 오버라이드 + 특이 사항 메모 개편 (#88, #89, #90, #91, #92, #93)

v6.4.0 이후 누적된 5건의 PR을 한 번에 반영.

- **Electron 셸 자동 업데이트 도입 — 트랙 2 (#93)**: electron-updater(6.1.9, generic provider), `canary`/`latest` 채널. `/updates/update-policy.json` 관리자 on/off 스위치로만 체크가 활성화되고(파일 없음/파싱 실패/형식 오류는 전부 비활성 — fail-closed), 평상시엔 전 PC가 완전히 휴면. 종료/새로고침 draft 보호 뮤텍스에 설치 흐름 통합. Windows 네이티브 메뉴가 `MenuItem` 직접 변경으로는 갱신되지 않는 문제를 발견해 재빌드 방식으로 수정. 에어갭 export 스크립트에 SHA-512 기반 설치본/메타데이터 정합성 검증 게이트 추가. 코드서명은 후속 과제로 연기(보안 함의·승인 절차는 `docs/INTRANET_DEPLOYMENT.md` 7절). 로컬 풀스택 실측 + 실제 설치본 E2E(감지→다운로드→설치→재시작→재확인) 확인, 실제 병원 PAC·Win7/ia32·canary 실사용은 서버 배포 후 별도 진행.
- **종합소견 직접 편집 오버라이드 — B-1/B-2 (#90, #91)**: 의사가 자동 생성된 종합소견 문장을 직접 다듬어 EMR로 보낼 수 있도록 오버라이드 기능 추가(`shared.reportOptions.assessmentOverride`), 낡음(stale)/깨진 오버라이드 판정과 "자동 생성으로 되돌리기" 지원. 미저장 draft를 스텝/환자 전환·홈 이동·로그아웃·내보내기 6종 등 전 영역에서 가드(Electron은 IPC로 boolean만 동기화, 웹은 `beforeunload`). 선행 작업으로 종료/새로고침 시 네이티브 confirm 기반 exitFlow 상태 머신과 감사 로그 `_source` 분리(#90)를 먼저 배포.
- **특이 사항 메모 개편 (#89)**: 종합소견 탭의 "복귀 고려사항"을 "특이 사항 메모"로 개명하고 EMR 직접입력 전송 대상에서 제외(저장 키는 하위호환을 위해 유지). 5개 모듈에 흩어져 있던 조회 로직을 공통 `selectModuleNote()`로 통합.
- **모듈 편집 가드 stale 클로저 수정 (#88)**: 서버 동기화 환자에서 락 취득/상실 직후 `updateModuleById` 등이 메모이즈 시점의 오래된 권한 상태를 참조해 편집 가능/불가를 오판하던 문제 수정.
- **인증 부팅 루프 수정 (#92)**: 인트라넷 빌드에서 미로그인 부팅 시 401 → 무조건 토큰 갱신 시도 → 갱신 실패 → 세션 리셋이 매번 새 객체를 만들어 재-트리거되는 자기영속 루프(초당 수백 건) 수정 — local 세션은 애초에 갱신을 시도하지 않도록, 세션 리셋을 멱등화, probe effect가 객체 identity 대신 원시 필드에만 반응하도록 수정.

### v6.4.0 (2026-08-03) — 등록번호 "유령 충돌" 해소 + 생년월일 정정 경로 + 등록일 KST 타임존 표시 수정 (#85, #86)

일괄입력에서 생년월일 셀을 텍스트 서식으로 붙여넣어 `4110-02-12` 같은 오염값이 저장되면 사용자가 어떤 방법으로도 복구할 수 없던 문제와, 그 과정에서 겹쳐 있던 등록번호 재사용/삭제 관련 결함들을 함께 수정(#85). 별도로 환자 등록일이 KST 자정~오전 사이에 하루 전날로 표시되던 표시 버그도 수정(#86).

- **정정 API 신규**: `POST /api/patients/:id/identity-correction` — 담당의/관리자 + If-Match + 락 게이트, 활성 case가 여럿이면 관리자 전용으로 전체 case의 birth_date/payload/revision을 함께 갱신.
- **달력 검증 공통화**: `shared/contracts/patientDates.ts` — 클라이언트·서버가 같은 규칙(실재 날짜·1900 이상·KST 기준 오늘 이하)으로 검증하고 canonical 형식으로 정규화, BatchImport 미리보기·POST/PATCH·workspace 저장 전 구간에 적용.
- **고아 person 정리**: 등록번호 변경/공란 전환/삭제 시 옛 person이 활성 상태로 번호를 계속 점유하던 결함들을 트랜잭션 내에서 함께 해제하도록 수정, 기존 오염 데이터 일괄 해제 migration(0027) 포함.
- **동시성**: 정정 락 검사 TOCTOU, workspace upsert ↔ DELETE 경합, 등록번호 교환 시 데드락(`withDeadlockRetry`)을 실 PostgreSQL로 재현 후 수정.
- **등록일 표시(#86)**: `createdAt`(UTC ISO) 문자열 앞 10자를 그대로 잘라 쓰던 사이드바 등록일 표시·정렬/필터·대시보드 최근 활동을, 공용 유틸 `toLocalDateString`(`src/core/utils/common.js`)으로 통일해 항상 로컬(KST) 캘린더 날짜로 표시하도록 수정.
- 검증: 서버 624 / 클라이언트 1097 tests pass, 실 PostgreSQL 12건(락 통과/차단, 번호 해제·재사용, 데드락 재현·재시도) 확인.

### v6.3.3 (2026-08-03) — 종합소견 그룹 형식 미리보기를 개별 형식과 통일 (#83)

종합평가에서 패턴 그룹 선택 시 미리보기(및 EMR/엑셀 출력에 공유되는 `formatGroupedAssessment`)가 `[상병 확인 · 업무관련성 높음] N개`처럼 그룹명·구성원 수를 대괄호로 맨 앞에 표시하던 것을, 개별 종합소견과 같은 순서(상병 목록 → 상병 상태/업무관련성 → 낮음 사유)로 변경. 좌/우 표기는 상병 목록 줄에 이미 있어 상태 줄 앞에 중복 표시하지 않는다.

### v6.3.2 (2026-08-01) — zod record 타입 optional 처리에 맞춘 테스트 수정 (#80)

zod 3.x는 enum 키 `z.record()`라도 값 타입에 `| undefined`를 포함해 추론한다(런타임 파싱 결과가 모든 enum 키를 다 갖는다는 보장이 없어서 — 실제로 안전한 설계). `squatDuration`/`overheadHours` 같은 features 접근이 항상 존재를 가정하고 있어 `tsc --noEmit`에서 possibly undefined 오류가 나던 것을 두 테스트 파일에 non-null assertion을 추가해 해소. CI에 typecheck 게이트가 없어 그동안 방치돼 있었다.

### v6.3.1 (2026-08-01) — Electron 종료 후 로그인 유지 문제 + logout 동시성 경쟁 조건 수정 (#79)

Electron 앱을 X 버튼/메뉴 종료/Ctrl+Q로 닫아도 재실행 시 자동 로그인되던 문제와, 그 과정에서 발견된 서버 세션 동시성 버그들을 함께 수정.

- **클라이언트**: 로그인 시 `rememberMe` 플래그 전송(Electron=false, 웹=true 유지) → 서버가 Electron 세션은 리프레시 쿠키를 세션 쿠키(만료시각 없음)로 발급해 앱 재시작 시 자동 로그인되지 않게 함. 앱 시작 시 레거시(업데이트 이전) 영구 쿠키 정리. 정상 종료(X/메뉴/Ctrl+Q) 시 렌더러 경유 IPC 핸드셰이크로 서버 로그아웃 시도(single-flight, 3초 타임아웃 백스톱). `logout()`이 `_retry:true`로 401-refresh 인터셉터를 타지 않도록 함(서버가 refresh 쿠키만으로 revoke하므로 액세스 토큰 refresh 불필요). `useAuthSync`에 auth epoch 가드 추가 — 로그아웃 이후 뒤늦게 도착한 refresh 결과나 크로스탭 브로드캐스트가 세션을 되살리지 못하도록 방어.
- **서버**: `POST /api/auth/logout`을 refresh 쿠키 기반 인증으로 재작성(auth/csrf 미들웨어 제거) — 액세스 토큰 없이도 동작, 만료된 세션도 즉시 revoke 가능. `sessions.family_id` 도입 + `rotateSession`/`revokeSessionFamily` 모두 family 단위 advisory lock(`pg_advisory_xact_lock`) 적용 — 동시 refresh 두 개가 같은 토큰으로 경합하거나, logout이 예전 세대 토큰을 든 채 동시 refresh가 새 세대 세션을 만드는 경우에도 세션이 살아남지 않도록 직렬화. CSRF 검증을 `revokeSessionFamily` 트랜잭션 안으로 이동 — 별도 사전조회의 grace window 불일치로 오래된 토큰이 CSRF 검증 없이 family를 revoke할 수 있던 구멍을 닫음. `hashToken`/`generateToken`을 `tokenHash.ts`로 분리(`csrf.ts` ↔ `sessionStore.ts` 순환 참조 회피).
- 검증: 클라이언트 AuthContext/useAuthSync/LoginModal 신규 테스트 포함 전체 vitest 통과(3회 연속 확인), 서버 mock 유닛 테스트 전체 통과 + 실제 Postgres 동시 커넥션 통합 테스트(`sessionStore.integration.test.ts`) 신규 — 두 경쟁 조건(같은 토큰 동시 rotation, 이전/현재 세대 간 logout↔refresh 경합) 모두 수정 전 상태로 되돌려 실패 재현 후 수정 복원해 통과까지 확인. 서버/루트 typecheck 클린, lint 0 errors.

### v6.3.0 (2026-08-01) — 환자 단위 편집 락(TTL lease lock) 구현 (#78)

동일 계정 다중 클라이언트 동시 편집 시 "저장 안 됨" 사고에 대응하는, 서버가 실제로 강제하는 환자 단위 편집 락(§2, §12.A 인트라넷 아키텍처 확장). 기존 revision 기반 optimistic lock은 최종 안전망으로 그대로 유지한다.

- **서버**: `patient_locks` 테이블(migration 0024) — `lease_token_hash`로만 소유권 판정, `client_instance_id` 자기매칭으로 F5 복구 지원, TTL 만료로 스윕 잡 없이 자연 정리. `server/src/db/patientLocks.ts` — acquire/renew/force/peek/release + 쓰기 게이트(`checkLockForWrite`), `patient_records` FOR UPDATE 앵커로 락 관련 트랜잭션 전체를 직렬화. `patients.ts`(§Server 라우터)에 `POST`/`DELETE`/`GET /:id/lock` 신설, patch/delete/assignPatient에 앵커+게이팅 배선, 소프트 삭제 시 락 행 정리. `videoAnalysis.ts` applyJob에도 동일 게이팅. `LOCK_ENFORCEMENT_MODE`(off/observe/enforce) 3단계 롤아웃 플래그 — off는 기존 동작과 완전 동일(추가 쿼리 없음).
- **프론트**: `usePatientLock`(신규) — 환자를 열면 즉시 acquire 시도(별도 peek 불필요, 423 응답 자체에 holder 정보 포함), `ttlMs/4` renew 하트비트, force-takeover, 세대번호로 stale 응답 방지, 창 포커스/탭 활성화/30초 주기 안전망 + 지수 백오프(30초~5분)·연타 방지로 'lost'/'held-by-other' 상태 재시도. `usePatientSync`가 `getPushEligibility`로 락 상태에 따라 활성 환자만 push 게이팅, `flushPatient`는 독자 PATCH 대신 기존 autosync 큐에 합류(cycleId 태깅 + 커밋 배리어로 stale snapshot 재전송 방지). `useSyncStatusSummary`(신규) — 충돌/락상실/저장대기/오프라인 건수를 동시에 반환하는 전역 동기화 배너용 훅. `App.jsx`에 usePatientLock↔usePatientSync 브리지, 세션 identity 변화 시 토큰 일괄 초기화, 환자 전환 가드, held-by-other/lost 배너 + 강제 획득 버튼. `StepContent`/`usePatientCrud`/`usePresetManagement`는 자체 계산 대신 `canMutateActivePatient`(권한 AND 락 보유)를 신뢰.
- **외부(코덱스) 리뷰 3라운드**로 배포(enforce 모드) 전 발견·수정한 결함: TOCTOU 권한 검사 레이스, `clock_timestamp()` 미사용(TTL이 트랜잭션 시작 시각에 고정), observe 모드 감사로그 누락과 force-takeover 이전 보유자 미기록, GET .../lock 응답 스키마 미포장, 만료 경계 레이스에서 `peekLock()`의 `null`을 LockRow로 위장하던 버그(호출부 TypeError/500 유발 가능), 영상 분석 최종 apply에 leaseToken 누락(423 오탐), `syncPaused`가 실제로는 자동 push를 막지 못하던 문제, 프리셋 모달이 락 가드 바깥에서 열리던 문제, local-only 환자의 `syncPaused` 재진입 영구 정지, `<StrictMode>` 중복 acquire.
- 검증: mock 단위 테스트 90건 + 실제 두 DB 커넥션으로 acquire 경합·FOR UPDATE 직렬화를 검증하는 통합 테스트(`TEST_DATABASE_URL` 있을 때만 실행), 실 브라우저 두 개 동시 편집 수동 검증.

### v6.2.4 (2026-08-01) — 경추/팔꿈치/손목 모듈 저장 무한루프 수정 (#77)

`syncCervicalModuleData`/`syncElbowModuleData`/`syncWristModuleData`(§4.4, §4.5, §4.6)가 `JSON.stringify`로 변경 여부를 비교하는데, 정규화 과정에서 객체 키가 고정 순서로 재정렬되면서 원본과 키 순서만 달라도 `changed=true`로 오판했다. PostgreSQL JSONB는 키 삽입 순서를 보존하지 않아 서버 왕복 시마다 이 오판이 반복되어 동일 payload가 계속 재저장되는 무한 루프가 발생했다.

- 키 순서에 무관한 `stableStringify()`를 `core/utils/common.js`에 추가하고 세 모듈의 `serialize()`에 적용. 회귀 테스트 추가.

### v6.2.3 (2026-07-30) — 경추 모듈 부담 작업 0건 시 완료 배지 오판정 수정

경추 상병 평가(상병 상태·업무관련성)를 다 채워도 부담 작업을 하나도 입력하지 않으면(= "경추부담 작업 없음", 유효한 상태) 환자 목록 사이드바가 영원히 미완료(빨간 점)로 남던 문제 수정.

- **원인**: `isCervicalAssessmentComplete()`(§4.6, 사이드바 완료 배지 판정)가 화면 표시 로직과 별개로 자체 완료 기준을 갖고 있었는데, 모든 직업의 작업 수가 0건이면 무조건 `false`를 반환하는 조기 반환문이 있었음 — 부담 작업이 실제로 없는 정상 케이스와 "작업 입력을 깜빡한" 케이스를 구분하지 못했음.
- **수정**: 조기 반환문 제거 — 작업이 0건인 직업은 입력 누락 판정에서 제외(빈 배열은 자연히 완료로 처리)하고, 상병 평가만 채워지면 완료로 판정하도록 변경. 화면에 표시되는 "경추부담 작업 없음" 처리와 판정 기준을 일치시킴.
- **변경 파일**: `cervical/utils/calculations.js`, 신규 `cervical/utils/__tests__/calculations.test.js`(회귀 테스트 7건).
- 검증: 클라이언트 964 tests pass(신규 7건), `npm run lint` 0 errors, `build:web` 통과. Playwright로 실제 환자(경추 상병만, 작업 0건, 상병 평가만 입력) 생성해 사이드바 완료(초록 점) 표시 확인.

### v6.2.2 (2026-07-30) — 종합소견 미리보기 그룹/개별 탭 정리 + 낮음 사유 그룹 구분 표시

종합평가 패턴 그룹화(v6.2.0) 도입 후 실사용 피드백을 반영해 미리보기 탭 구성과 그룹 카드 표시를 다듬음.

- **미리보기 탭 명칭·연동 정리** (§3.3): "EMR 종합소견"/"통합 리포트 초안" 탭을 "종합소견(그룹)"/"종합소견(개별)"로 이름을 바꾸고, 좌측 패턴 그룹/개별 카드 토글을 바꾸면 미리보기 탭도 자동으로 따라가도록 연동(수동으로 다른 탭을 눌러 비교하는 것은 계속 허용). 두 탭 모두 CP949 byte 게이지를 표시(기존에는 그룹 탭에만 있었음). `generateUnifiedEMR(patient, groupOutputOverride)`에 override 파라미터를 추가해 저장된 `reportOptions` 값과 무관하게 그룹/개별 두 형식을 동시에 계산 — EMR 직접입력이 실제로 전송하는 내용(`reportOptions.groupAssessmentResults` 기준)이 항상 현재 활성 탭의 내용과 일치함을 회귀 테스트로 고정.
- **낮음 사유 그룹 제목 구분** (§3.3.1): 상병 상태·업무관련성은 같지만 낮음 사유만 달라 별도 그룹으로 갈린 카드들이 제목이 똑같아 보여 헷갈리던 문제 — 업무관련성이 낮음인 그룹은 제목 뒤에 "낮음 사유 N" 연번을 붙여 구분. 그룹 카드 하단 캐션은 "낮음 사유" → "낮음 사유 상세"로 문구 변경.
- **그룹 카드 구성원 기본 펼침** (§3.3.1): 그룹을 펼쳐야 상병 구성원이 보이던 기본값을 반전 — 이제 기본으로 펼쳐져 보이고, "구성원 접기" 버튼으로 감출 수 있음.
- **손목/팔꿈치 요약 가독성**: EMR 종합소견의 손목/팔꿈치 직업별 노출 요약(`buildExposureSummary`)에 직업명이 표시되지 않아 어느 직업 얘기인지 헷갈리던 문제 — 직업명 헤더(`[직업명]`)를 추가하고 직업이 바뀔 때마다 줄바꿈.
- **변경 파일**: `AssessmentGroupView.jsx`, `AssessmentStep.jsx`, `emrReport.js`(`generateUnifiedEMR` override + `buildExposureSummary` 직업명 헤더).
- 검증: 클라이언트 957 tests pass(신규 4건), `npm run lint` 0 errors, `build:web`/`build:electron` 통과. Electron/서버 무변경.

### v6.2.1 (2026-07-30) — 손목/팔꿈치 BK유형 그룹 자동 동기화 수정

동일 `selectedBkType`으로 묶인 상병 카드(`BkGroupCard`)가 대표값(`pickRepresentativeEntry`)만 화면에 보여주고, 개별 진단의 실제 저장 entry는 비어있는 채로 남을 수 있는 구조적 결함을 수정. 입력 순서(① 신규 상병이 기존 필드 그룹에 자동 합류 ② 개별 카드(`EntryCard`)에서 BK유형을 처음 수동 선택 ③ 진단코드 수정으로 자동추론 BK유형이 바뀜)에 따라 화면은 다 채운 것처럼 보여도 `isElbowAssessmentComplete`/`isWristAssessmentComplete`가 미완료로 판정하는 불일치가 발생했다.

- **세 경로 모두 동기화 대상 포함**: `syncElbowModuleData`/`syncWristModuleData`의 신규 entry 판정을 `isNew`(entry가 새로 생성됨) 하나에서 `isNew || bkTypeJustChanged`(자동추론 BK유형이 기존 값에서 바뀌었고 아직 아무 필드도 채워지지 않음)로 확장. `EntryCard`의 BK유형 select `onChange`에도 `findGroupDonorEntry`(그룹 내 최고점수 entry 탐색) 공용 헬퍼를 배선 — 기존에는 `resetElbowBranchFields`만 호출해 그룹 합류를 감지하지 못했다.
- **donor 선택 기준 정합화**: 데이터 계층(`syncXxxModuleData`)의 donor 선택을 `.find()`(첫 매치) → 최고 점수(`scoreDiagnosisEntry` 최댓값) 기준으로 변경, UI의 `pickRepresentativeEntry`와 동일 기준으로 정렬. 동기화 발생 시 `bkAutoSyncedFrom` 마커를 저장하고 그룹 카드에 "○○ 상병에 △△ 상병과 동일한 값이 자동 적용되었습니다" 안내 배너 표시(사용자가 해당 진단 필드를 직접 편집하면 `updateDiagnosisEntry`가 마커를 자동 제거).
- **mismatch 경고 정정**: 기존 "기존 상병별 입력값이 통합되었습니다"(사실과 다른 과거형 단정, 실제로는 화면 표시만 대표값이고 저장값은 그대로 다름)를 "실제 저장값이 서로 다릅니다"로 정정하고, "표시된 대표값을 전체 상병에 적용" 복구 버튼(`applyRepresentativeToAll`) 추가.
- **변경 파일**: `elbow/utils/data.js`, `wrist/utils/data.js`(동기화 로직), `ElbowEvaluation.jsx`/`WristEvaluation.jsx`(마커 제거), `elbow/components/ExposureForm.jsx`, `wrist/components/ExposureForm.jsx`(`findGroupDonorEntry` 공용 헬퍼 + UI 배선), `elbow/utils/calculations.js`/`wrist/utils/calculations.js`(`BK_META_FIELDS`에 `bkAutoSyncedFrom` 추가 — 오탐 방지).
- 검증: `npm run lint` 0 errors, `npm run build:web` 통과, 클라이언트 953 tests pass. Electron/서버 무변경.

### v6.2.0 (2026-07-30) — 종합평가 패턴 그룹화 + EMR byte 절감 + K-L/Ellman 조건부 표시 (#72)

상병이 50건을 넘어가면 종합소견 좌측 패널에서 우/좌 개별 클릭이 과도해지고, EMR 종합소견(`txtSyth1Cont`)이 CP949 3,950byte 한도를 넘어 잘리는 문제를 해결.

- **종합평가 패턴 그룹화** (§3.3.1): `assessmentGroups.js` — 상병+방향(평가단위) 단위 패턴 그룹 계산/일괄 적용/Undo/개별·그룹 형식 텍스트 생성을 매번 진단 데이터에서 재계산하는 엔진 신설. `AssessmentGroupView`(그룹 카드 목록, 방향 미선택 상병 별도 카드) + `AssessmentPatternEditor`(그룹 일괄 입력) + `AssessmentIndividualFields`(K-L/Ellman/척추 공통 항목 개별 입력) 신규 컴포넌트, `AssessmentTab`/`AssessmentStep`/`StepContent` 배선.
- **EMR byte 절감**: `emrText.js`로 CP949 byte 계산/절단 유틸을 `exportService.js`에서 분리(중복 제거) + `emrReport.js`로 EMR 텍스트 생성 레이어를 분리(xlsx 의존성 없이 미리보기 화면이 가볍게 import 가능). `reportGenerator.js`/`emrReport.js`가 `shared.reportOptions.groupAssessmentResults` 옵션에 따라 개별/그룹 출력 포매터를 통합, b6 신체부담 평가 요약본(`buildExposureSummary`, 척추 `buildSpineSectionSummary`)을 추가해 b8(종합소견) 분량을 축소. `useEMRIntegration.js`에 EMR 전송 전 종합소견이 한도를 초과하면 확인창 추가.
- **K-L/Ellman 조건부 표시**: `diagnosisMapping.js`의 `supportsKlGrade`/`supportsEllmanClass` — 무릎관절증(M17.0/M17.9)·회전근개(M75.1) 등 조건에 맞는 상병에만 K-L Grade/Ellman Class 입력창을 표시.
- **하위호환**: 기존 환자는 `reportOptions` 미설정 시 출력이 그대로 유지(불변 회귀 테스트로 고정), 그룹 뷰 자체는 이 옵션과 무관하게 항상 열려 있어 기존 환자의 미완료 건도 그룹 화면에서 바로 일괄 입력 가능.
- **후속 수정 (같은 PR 내 리뷰 반영)**: 방향 미선택 비축성 상병이 그룹 화면엔 잡히는데 실제 출력(`formatGroupedAssessment`)에서는 통째로 빠지던 결함(`findUnassignedSideDiagnoses` 단일 소스화), 양측 미완료 상병이 그룹 출력 헤더에 1개로 축소 표시되던 회귀(헤더 개수를 `stats.incompleteCount` 기준으로 통일), EMR byte 게이지가 반올림 판정으로 3,951byte(한도 초과)를 100%="주의"로 오판정하던 문제(`classifyEmrByteStatus`가 실제 byte로 직접 비교), 완료 그룹 재수정 모달이 항상 빈 값으로 열리던 문제(완료 그룹은 균일한 값으로 폼 프리필) 등을 함께 수정.
- 검증: 상세는 커밋 이력(PR #72) 참조.

### v6.1.6 (2026-07-10) — 환자 목록 의사별 필터 + 비담당 환자 열람성(복사/스크롤) 개선 + EMR 디바이스 rate-limit 수정

인트라넷 다중 사용자 환경에서 보고된 세 가지 불편 반영: ① 환자 목록 필터가 "내 담당"/"전체" 둘뿐이라 특정 동료 의사의 환자만 골라 볼 수 없음(대시보드 통계는 이미 의사별 드롭다운 지원) ② 비담당 환자를 조회할 때 HTML `inert` 속성이 텍스트 선택(복사)과 스크롤까지 막아, 내용이 길면 아예 읽을 수조차 없었음 ③ EMR 디바이스 rate-limit이 관리자 승인 후에도 "장치 등록 필요"를 계속 표시.

- **환자 목록 의사별 필터 드롭다운**: `PatientSidebar`의 "내 담당"/"전체" 버튼 토글을 `Dashboard`와 동일한 패턴의 `<select>`(전체/내 담당/의사별/미배정)로 교체. 서버 `GET /api/patients?scope=<의사UUID>`·`GET /api/patients/doctor-counts`(의사 명부)는 이미 완비돼 있어 프론트만 수정. `App.jsx`의 `onScopeChange` 정규화 로직이 admin의 의사별/미배정 선택을 무조건 `all`로 되돌리던 기존 버그를 `normalizePatientScopeForSession`으로 교체해 수정. 명부 로딩 상태를 `doctorRosterStatus: 'loading' | 'ready' | 'error'`로 명시적으로 구분해(기존엔 빈 배열 하나로 로딩 전/정상 빈 결과/조회 실패를 구분 못함) scope 유효성 가드가 정상 빈 명부(마지막 의사의 환자 전원 재배정 등)를 로딩 중으로 오인하지 않게 함. `Dashboard.jsx`의 자체 가드(→`all` 복귀)를 제거하고 `App.jsx`의 통합 가드(→`getDefaultPatientScope` 복귀)로 일원화해 두 컴포넌트 간 정책 충돌을 없앰. roster 가드 로직은 `src/core/utils/patientScope.js`로 순수 함수 분리.
- **비담당 환자 복사·스크롤 허용**: `StepContent.jsx`가 비담당 환자 조회 시 전체 콘텐츠를 `<div inert>`로 감싸던 것을 capture-phase 이벤트 핸들러(`onClickCapture`/`onKeyDownCapture`/`onBeforeInputCapture`/`onInputCapture`/`onChangeCapture`/`onPasteCapture`/`onCutCapture`/`onDropCapture`/`onSubmitCapture`)로 교체 — 편집 상호작용(클릭, 폼 컨트롤 값 변경, 붙여넣기, 드롭)만 차단하고 텍스트 선택(복사)·스크롤(휠/키보드)은 그대로 허용. `<select>`/숫자·날짜 input의 방향키·증감 키처럼 click이나 beforeinput 없이 값이 바뀌는 경로는 keydown 단계에서 선제 차단. `data-readonly-allow` 속성으로 향후 조회 전용 컨트롤 예외 통로 마련. 서버(`assignedDoctorOrAdmin` 403)와 `usePatientCrud`의 silent guard가 실제 데이터 변경의 최종 방어선은 그대로 유지.
- **프리셋 적용 권한 가드 보강**: `usePresetManagement`의 `handlePresetSelect`가 `canEditPatient` 검사 없이 `setPatients`를 직접 호출해(UI 차단을 우회하면 비담당 환자에도 프리셋이 적용될 수 있던 경로) 담당의 권한 가드를 함수 초입 + `setPatients` 내부 2단으로 추가. 비담당 환자에 적용 시도하면 거짓 성공 알림("프리셋이 적용되었습니다") 없이 명확한 차단 알림을 표시.
- **EMR 디바이스 등록 rate-limit 자기악순환 방지**: `electron/audit.js`의 `tryRegister()`가 5분 flush 주기 그대로 서버에 재등록 확인을 보내 시간당 12회로 서버 한도(5회/시간/사용자)를 항상 초과했고, 429 응답을 하드 실패로 오인해 상태를 `error`로 강등 — 관리자가 승인해도 클라이언트가 "장치 등록 필요"를 계속 표시했다. 재시도 간격을 20분으로 늘려 한도 안에 들어오게 하고, 429는 상태를 유지한 채 조용히 재시도하도록 수정.
- **테스트 인프라 신규 도입**: 이 저장소에 컴포넌트/훅을 실제 렌더링해 검증하는 테스트가 없었음(기존 관례는 컴포넌트에서 export한 순수 함수만 테스트) — `jsdom` + `@testing-library/react`/`user-event`를 devDependency로 추가하고 `vitest.config.js`에 `@vitejs/plugin-react` + `.test.jsx` 포함을 추가(파일별 `// @vitest-environment jsdom` opt-in, 기존 순수 함수 테스트는 계속 빠른 `node` 환경 유지). jsdom이 `<select>` 방향키·number input 스피너 같은 네이티브 위젯 동작 자체를 구현하지 않는다는 걸 실측으로 확인해, 그런 경우엔 "DOM 표시값 불변"이 아니라 `event.defaultPrevented`를 직접 검증하는 방식으로 테스트를 설계(로직을 일부러 깨서 실패하는지까지 검증). `patientScope.js`/`StepContent`/`PatientSidebar`/`usePresetManagement`에 대한 신규 테스트 36건 추가.
- 검증: 클라이언트 `npx vitest run` 872 tests pass(신규 36건 포함), `npm run build:web` 통과. 서버 라우트 무변경 — 인트라넷 Electron 클라이언트는 서버를 `loadURL`로 로드하는 구조라(프론트 번들을 자체 포함하지 않음) **인트라넷 설치본 재배포 불필요, 서버 이미지만 재배포하면 프론트엔드 변경이 즉시 반영됨.** (EMR rate-limit 수정은 `electron/audit.js` 변경 포함 → 해당 항목만 인트라넷 설치본 재배포 시 반영됨.)

### v6.1.5 (2026-07-10) — 영상분석 어깨 반복 시간합 계산기 + 공정별 값 표시 (6.0-16·6.0-17)

사용자 테스트 중 발견된 두 요청 반영: ①`repetitiveMediumHours`/`repetitiveFastHours`가 계약·모듈 필드·집계·환산까지 전부 배선돼 있는데 계산기만 없던 문제 ②결과 패널이 직업 단위 공정 가중합 1개 값만 보여줘 공정(작업)별 분해값을 원하는 요청.

- **6.0-16 어깨 반복 시간합 계산기**: 사이클(연속 half-swing 2개)의 온셋 간격(이 사이클 시작 turning-point → 다음 사이클 시작 turning-point)을 순간빈도 r=60000/간격ms로 medium(4≤r<15)/fast(r≥15)로 밴딩·귀속(마지막 사이클은 자체 구간). `feature_calc.py`에 순수함수 `band_ratios_from_segments` 분리, 연속 관측 구간(run) 경계를 넘어 half-swing이 잘못 한 사이클로 묶이지 않도록 `repetition_count`가 run 경계를 함께 반환. 좌/우 독립 계산 후 기존 계약 키인 main 2키(mode auto)는 밴드별 독립 max(좌,우), 신규 candidate 4키(Left/Right)는 raw ratio 그대로 노출. 어깨 반복 계열 6키 전부 "상지반복(10~15fps)" 프로필에서만 요청·생성·표시되도록 신규 `videoFeatureProfiles.js`가 프로필 정책 단일 source로 요청 생성·mock 생성·candidate 필터 세 지점에 배선.
- **6.0-17 공정별 값 표시**: 직업 단위 제안(무릎·어깨) 각 행 아래 공정별 분해 서브행 추가 — 기여값(직업 합계에 이 공정이 보탠 몫, 집계와 동일 산식 재사용) + 원값(공정 자체 per-day) 병기, 서브행 합은 항상 직업 합계와 정합. flat 참고 후보(어깨·팔꿈치·손목 반복/peak + 신규 Left/Right 4키)는 featureKey별로 그룹핑해 헤더 1개 + 공정별 서브행으로 재구성(이전엔 공정마다 라벨이 중복 노출). `VideoAnalysisDataSchema`에 optional `processFeatureAggregationMode`(`shareWeighted`|`absolutePerDay`) 신규 — 기존에는 집계 호출 인자일 뿐 저장되지 않아 리로드 후 서브행 기여값 재계산이 틀어지는 문제를 해결(구 데이터는 서브행 생략 + fallback 안내로 fail-safe).
- 검증: Python(services/pose-inference) 전체 PASS(버스트-휴지 혼합귀속·gap 경계 회귀 포함) + 클라이언트 836 tests pass + server 544 tests pass, `build:web`/`lint`(0 errors) 통과. dev 라이브(Playwright, mock intranet 서버)로 공정 2개(점유율·활동시간 상이) 구성 시 서브행 기여값 합이 직업 합계와 정확히 산술 일치함을 실측(예: 1.2h+0.8h=2h). 브라우저 리로드 E2E는 mock 서버가 patients CRUD 미구현이라 JSON 직렬화 왕복 스키마 테스트로 대체.
- 파라미터(minAmplitudeDeg 등, 기존 shoulderRepetitionRate와 동일 시작값)는 6.0-B2 정확도 검증 전까지 잠정. 상세는 `docs/VIDEO_ANALYSIS_IMPLEMENTATION_PLAN.md` 6.0-16/6.0-17 항목. **Electron 셸 무변경 → 인트라넷 설치본 재배포 불필요(서버 이미지만 갱신)** — `repetitiveMediumHours`/`FastHours` 메인 2키는 계약에 이미 등록돼 있던 기존 키라 구버전 Electron 클라이언트도 이미 요청 중이었고(값만 새로 채워짐), 신규 Left/Right 4키·서브행 UI·`processFeatureAggregationMode`는 구버전 클라가 모르는 채로 안전하게 무시됨(zod 기본 동작 — 알 수 없는 필드는 strip). 오프라인 패키지의 `electron/` 폴더는 v6.1.4 인스톨러를 그대로 재사용.

### v6.1.4 (2026-06-30) — EMR 재해일자 매칭 회귀 수정 + 일괄입력 빈 양식 다운로드

v6.1.3 라이브 검증에서 발견된 재해일자 매칭 회귀를 수정하고, 처음 사용자를 위한 일괄입력 빈 양식 다운로드를 상시 노출.

- **EMR 재해일자 매칭 회귀 수정**: EMR 페이지 VBScript 핸들러 시그니처는 `SSRHPLANLIST_DblClick(iCol, iRow)`=(열, 행)이고 행은 1-based인데, v6.1.3 리팩터에서 `(row, 1)`로 호출해 **iRow가 항상 1로 고정** → 매 반복 행 1만 재로딩, 행 2·3은 한 번도 선택하지 못해 일치 재해일자를 못 찾고 1번으로 폴백했음. `SelectRowAndReadDate`의 execScript를 `SSRHPLANLIST_DblClick(0, row)`로 복구(원본 파라미터 순서) + 행 스캔을 1-based로(행 1 먼저 → 불일치 시 행 2..scanCount 순회 → 폴백 행 1).
- **사용자 입력 재해일자 보존**: renderer(`useEMRIntegration`)가 추출 결과의 `accidentDate`를 `injuryDate`에 항상 덮어쓰던 것을 **미입력 시에만 자동 채움**으로 변경 — 매칭 기준으로 입력한 재해일자가 불일치 폴백(1번 항목)으로 덮어써지지 않도록.
- **일괄입력 빈 양식 상시 제공**: `exportBatchTemplate()`(헤더만 있는 빈 양식)을 상단 툴바 "일괄입력 양식" 버튼 + 일괄 Import 모달 "빈 양식 다운로드"에 추가. `ExportMenu`의 early-return 제거로 환자 0명에서도 노출(§7.2-B 참조).
- 검증: C# 빌드 0 errors / 0 warnings, 클라이언트 812 tests pass. 오프라인 패키지(906MB·v6.1.4) 빌드. **Electron/C# 헬퍼 변경 포함 → 인트라넷 설치본 재배포 필요.**

### v6.1.3 (2026-06-30) — EMR 추출 재해일자별 신청건 매칭 + 성별 자동입력 + 직접입력 바이트 한도 완화

같은 환자라도 재해일자가 다른 여러 신청건이 EMR 입력내역에 존재할 수 있어, 환자 재해일자와 일치하는 건만 가져오도록 추출 로직을 개선. (이후 v6.1.4에서 회귀 수정)

- **재해일자별 신청건 매칭**: EMR 추출 시 입력내역 그리드(`SSRHPLANLIST`)를 순회해 환자 재해일자와 일치하는 행만 로드. 재해일자 미입력 시 1번 항목 + "재해일자가 다른 신청건이 있습니다" 경고, 일치 건 없으면 1번 항목 + 경고(`multipleEntries`/`injuryDateMismatch` 플래그). `renderer → preload → main → C# helper` 4단에 재해일자 전달. 배치 모드 stale-grid 방지 witness(`txtSsnNo` — `PtInfoSetting()`이 동기적으로 비우는 필드가 새 환자 조회로 다시 채워질 때까지 폴링) + 고정 Sleep 대신 변경감지 폴링. 추출 IPC 타임아웃 30s→120s.
- **성별 자동 추출**: `txtSex`(남/여 정확 매칭) 우선, 비어 있으면 주민번호 7번째 숫자(1·3·5·7=남, 2·4·6·8=여)로 파생 → 앱 `male`/`female` 매핑.
- **직접입력 바이트 한도 완화**: 소견서 필드 주입(`generateEMRFieldData`/`generateConsultReplyFieldData`)의 절단을 UTF-8(`Blob`, 한글 3바이트)에서 **CP949 근사(ASCII=1·그 외=2)·한도 3950**으로 교체. EMR 필드 실제 한도가 CP949 4000바이트라 UTF-8 기준 4000은 한글을 ~2,600바이트에서 잘랐으나, 이제 4000 한도 내에서 더 많이 들어감(전송 문자열은 동일 — 측정 방식만 변경).
- 검증: C# 빌드 0 errors, 클라이언트 812 tests pass(바이트 절단 테스트 포함).

### v6.1.2 (2026-06-30) — 직업 프리셋 조직 공유

직업 노출 프리셋을 개인(private) 저장에서 **조직 공유(organization)** 로 확장. 신규 사용자가 동료의 프리셋을 검색·적용해 바로 활용할 수 있게 한다.

- **저장 토글**: 저장 모달에 공개범위 선택(인트라넷 기본=조직 공유, 로컬/Electron은 숨김·private 고정). 소유 기반 "수정 vs 신규" 매칭으로 동료 행을 PATCH하다 403 나는 것을 차단, 비소유 프리셋 편집 진입 시 읽기전용.
- **목록 UI**: 검색 드롭다운·조회 모달에 `own/shared/builtin` 소스 분류 → 소유자 배지("조직 공유 · 이름")·읽기전용(비소유는 적용/복제만)·소스 필터·정렬. 서버 `listPresets`에 `users` 조인으로 소유자명 노출, `presetRepository` PATCH `visibility` 갱신 갭 수정.
- **관리자 '프리셋 공유' 탭**: 조직 전체 프리셋을 보고 **선택형 양방향**(조직 공유 ↔ 비공개)으로 일괄/개별 전환(`GET/POST /api/admin/presets[/visibility]`, ids dedupe·`visibility<>target` skip·org-scope·감사 로그에 requested/updated id 분리).
- **마이그레이션 0023**: 기존 private 프리셋을 일괄 조직 공유로 백필(직전까지 visibility가 하드코딩 private였으므로 "선택이 아닌 강제"였던 데이터를 소급 전환). ⚠️ 토글 UI와 **동일 릴리스로만** 배포(주석 명시).
- 검증: 클라 테스트(presetRepository 10 신규 포함) + 서버 라우트 테스트(presets/admin 신규 포함) pass, `build:web`·server build·lint 0 errors. 라이브 dev 스택에서 2계정 공유·0023 백필·관리자 전환 검증. **Electron 셸 무변경 → 인트라넷 설치본 재배포 불필요(서버 이미지만 갱신).**

> **영상분석(M4) 상세는 `docs/VIDEO_ANALYSIS_IMPLEMENTATION_PLAN.md` 참조.** 아래 v6.0.0~v6.1.1 항목은 요약이며, 추론 파이프라인·레시피 검증·키포인트 계약·게이팅 정책의 전체 명세는 해당 문서에 있다.

### v6.1.1 (2026-06-28) — 영상분석 처리시간 안정화 + 추론 디바이스(GPU) 토글 + overlay 가독성 (6.0-12)

손목(wholebody) 추론 처리시간 deadline 일관화(클라 폴링이 추론보다 먼저 포기하던 "분석 실패" 해결 — 서버 deadline 단일 진실원천 `config.video.jobDeadlineMs`) + 조직별 추론 디바이스 토글(`inference_device` auto/cpu/cuda, 관리자 콘솔 탭 + 공정별 실행 배지) + 검수 overlay 손 keypoint 가독성 개선. 마이그레이션 0022. 검증: 서버 517 / 클라 794 tests pass. **Electron 셸 무변경 → 서버 이미지만 갱신.**

### v6.1.0 (2026-06-28) — 영상분석 손목(wholebody) + 상지 반복빈도 candidate

근골격계 부담작업 영상분석에 손목/손가락(wholebody 포즈)·상지 반복빈도를 "참고용 candidate"(자동입력 없음, 게이팅은 6.0-B2 검증 후)로 추가. 손목은 "손목·손" 프로필 클립만 on-demand wholebody 추론(rtmw-dw-l-m, body17+hand42=59점; 굴곡=측면·편위=정면 시점 하드 게이트), 어깨/팔꿈치 반복빈도(cycles/min) candidate. 에어갭 manifest pose role 분리(`pose-body`/`pose-wholebody`), app 이미지 +약 114MB. body17 경로 회귀 0. 검증: 서버 91+ / 클라 789 tests pass. (M4 6.0-10·6.0-11)

### v6.0.0 (2026-06-22) — M4 영상분석 시범 운영(참고용) + 에어갭 패키징

근골격계 부담작업 영상분석(자세 추정)을 "참고용 시범 운영"으로 활성화하고 에어갭 오프라인 배포 패키지를 완성. (M4 6.0-9)

- **영상분석 요약**: 레시피 버전관리(`analysis_recipe` — 코드 commit·가중치 sha·키포인트 계약 기록, 서버 apply 시 권위 검증, 미검증은 fail-closed) + Python 포즈 추론(rtmlib/onnxruntime-cpu)을 app 이미지에 동봉(`.onnx` SHA256 대조). 시범 정책 B(미검증 배너 + 수정사유 `editReason` 피드백, 자동 게이팅 비활성). 전체 명세는 `docs/VIDEO_ANALYSIS_IMPLEMENTATION_PLAN.md`.
- **오프라인 패키지**: `scripts/export-offline-package.ps1` — 실파일 sha 검증·dirty 가드·`WR_GIT_COMMIT` 주입·`release-manifest.json`(videoInference 출처) 생성. compose에 `video_uploads` 볼륨 + 추론 mem/cpu 제한.
- **대시보드**: 관리자 의사별 통계 드롭다운 + 위험도 '낮음' 사유 7항목 분할.
- 검증: 서버 513 / 클라이언트 770 tests pass, docker build + `--network none` 추론 smoke 통과.

### v5.1.8 (2026-06-13) — 보안 점검 적용: AI 프록시 모델 allowlist + Electron IPC 보강 + PDF 푸터 이스케이프

전체 코드 리뷰(보안/리팩터링/정리) 1차 적용분. 즉시 적용 가능한 보안 보강과 정리 작업.

- **AI 프록시 모델 allowlist** (`api/analyze.js`): 허용된 Gemini/Claude 모델 외 요청은 400 반환 — 비용 탈취·경로 조작 방지.
- **Electron IPC 보강** (`electron/main.js`): `fs-migrate` 핸들러 3곳에 `sanitizeId()` 적용(path traversal 방지), `set-access-token`에 `isAllowedSender` origin 검사 추가.
- **PDF 푸터 XSS 방지**: elbow/wrist/shoulder 모듈 export의 PDF 푸터에 `escapeHtml` 적용 (knee는 기존부터 적용됨).
- **정리**: 미사용 `electron/preload.js`, `types/placeholder.d.ts`, `artifacts/elbow_module_structure.md` 삭제 + CLAUDE.md/AGENTS.md/README.md의 구조 참조를 `preload-intranet.js`/`preload-standalone.js`로 갱신.
- 검증: 클라이언트 446 tests pass, `npm run build:web` 통과. package.json 버전 미변경.

#### 2차 적용분 (2026-06-15) — 코드 구조 리팩터링 + 종합소견 Excel 일괄입출력

- **BatchImportModal 모듈화**: 587줄짜리 `handleImport`를 knee/shoulder/elbow/wrist/
  cervical/spine 6개 모듈의 `registerModule().batchImportConfig(columns/applyRow)`로
  분리, 공통 헬퍼는 `src/core/utils/batchImportHelpers.js`로 이동.
- **App.jsx 오케스트레이션 분할**: 987줄 → 624줄. 신규 훅 5개(`useAuthSync`,
  `useAppSettings`, `useEvaluationDateSync`, `useElectronMenuEvents`,
  `useConflictResolution`) + `AppModals.jsx` 컴포넌트로 순수 이동(로직 변경 없음).
- **AI 호출 모델 상수 공유**: 레포 루트에 `ai-models.config.cjs` 신설
  (ALLOWED_MODELS / DEFAULT_CLAUDE_MODEL / DEFAULT_GEMINI_MODEL / CLAUDE_MAX_TOKENS /
  GEMINI_MAX_OUTPUT_TOKENS) — `api/analyze.js`(ESM)와 `electron/main.js`(CJS) 양쪽의
  하드코딩 제거 후 공용 참조.
- **createTestPatients lazy 분리**: `src/core/utils/data.js`(859줄)의 테스트 데이터
  생성 로직을 `src/core/fixtures/createTestPatients.js`로 이동, `usePatientCrud.js`에서
  동적 import로 로드 — 빌드 시 별도 청크(`createTestPatients-*.js`)로 분리.
- **종합소견 Excel 일괄내보내기·일괄입력**: "일괄입력 형식" 엑셀(`BATCH_HEADERS`/
  `generateBatchRows`)의 'Ellman(좌)' 컬럼 뒤에 **상병상태(우/좌)·업무관련성(우/좌)·
  업무관련성낮음사유(우/좌)·수직분포원리·동반척추증** 8개 컬럼 추가.
  재import 시 `batchImportHelpers.js`의 `applyDiagnosisAssessment`가 값을 진단에
  반영(spine 전용 필드는 `moduleId === 'spine'`일 때만). 기존 환자·기존 진단의
  평가값만 갱신되는 재import도 "가져올 데이터가 없습니다"로 막히지 않도록
  `stats.updatedAssessments` 카운터를 완료 조건에 추가했고, 기존 값과 동일한
  평가값은 갱신 건수에서 제외.
- **문서**: CLAUDE.md에 cervical/wrist/server(11개 라우터)/shared-contracts 섹션 추가,
  `docs/VERCEL_AI_PROXY_HARDENING.md` 신규(운영자용 Vercel 보안 설정 가이드).
- 검증: vitest 471 passed, `npm run build:web` / `build:electron` 통과, `npm run lint` 0 errors.

### v5.1.7 (2026-06-04) — 척추 dailyDose 임계치·중증도 사다리 하향 (임상 피드백)

v5.1.3 공식 환자의 일일선량 임계치가 너무 높다는 피드백 반영.
- **임계치 (`thresholds.dailyDose.v513`)**: 남 5.5 / 여 3.5 → **남 4.0 / 여 3.0 kN·h** (legacy 남 2.0 / 여 0.5 불변).
- **중증도 dailyDose 사다리 (`classifySpineSeverity`)**: 임계치=중등도하 진입값이 한 몸이라 사다리 전체를 정연한 비례(여=남×0.75)로 하향 — 남 `4.0 / 6.0 / 8.0`, 여 `3.0 / 4.5 / 6.0` (중등도하/중등도상/고도). 압박력(N) 경계(6000/5000/4000)와 단일 사다리 "모든 환자 일괄 적용" 구조는 불변.
- **변경 파일**: `thresholds.js`, `calculations.js`(classifySpineSeverity), `__tests__/calculations.test.js`(경계값 가드 보강), PRD 현행 스펙. package.json 버전 미변경.

### v5.1.5 (2026-05-29) — 척추 임계치·중증도 v5.1.3 스케일 재조정 + 위험/업무관련성 BSG 단일화

v5.1.3 일일선량 공식 정정으로 `dailyDoseKNh` 값 자릿수와 분포가 바뀐 뒤에도 임계치·중증도·위험/업무관련성 분기는 옛 공식 기준 그대로였음. 새 공식 스케일에 맞춰 일괄 재조정하고, 동시에 KPI/위험/업무관련성 패널이 비교 대상으로 삼는 기준을 독일 법원(BSG) 단일로 통일.

**1. 일일선량 임계치 버전별 분기 (`thresholds.dailyDose`)**
- v5.1.3: 남 5.5 / 여 3.5 kN·h
- legacy: 남 2.0 / 여 0.5 kN·h (보존)
- `calculateLifetimeDose(..., formulaVersion)`이 환자의 `formulaVersion`을 보고 버전 키(`v513`/`legacy`)로 임계치 선택. 두 호출부(직업별/legacy 단일직업) 모두 전달.

**2. 중증도 분류 (`classifySpineSeverity`) — 모든 환자 일괄 적용**
- 남: 고도 `>10 kN·h | ≥6,000N` / 중등도상 `>8.0 | ≥5,000` / 중등도하 `≥5.5 | ≥4,000` / 경도
- 여: 고도 `>8.0 | ≥6,000N` / 중등도상 `>5.5 | ≥5,000` / 중등도하 `≥3.5 | ≥4,000` / 경도

**3. KPI 카드 "평생 누적 용량" 비교 기준 DWS2 → 독일 법원(BSG)**
- `SpineResultPanel.jsx`: sub `독일 법원(BSG) ${comparison.court.percent}%`, highlight = `court.percent ≥ 80`
- 하단 3개 비교 카드(MDDM/독일 법원/DWS2)는 그대로 유지 — 참고용으로 모두 노출
- `isV513`에 따라 `dailyDoseThreshold` 변수를 하나로 추출해 KPI 일일 카드 sub와 단일 직업 누적 카드 "일일 임계치" 5곳을 일관 표시

**4. 위험 배너 (`assessRisk`) — court 단일 기준 직접 판정**
- mddm/dws2 status를 함께 보던 다단 분기 → `comparison.court.percent` 단일 직접 판정
- `> 100%` danger, `80~100%` warning, `< 80%` safe
- `comparison.court.status`(100~120%를 warning으로 보는 정의)와 의미가 달라 percent 기반으로 직접 판정

**5. 업무관련성 평가 (`assessWorkRelatedness`) — court 단일 3단계**
- `> courtLimit` → 높음 / `courtHalf ≤ x ≤ courtLimit` → 불충분(다른 요건 고려) / `< courtHalf` → 낮음
- 기여도 분모 = courtLimit (이전엔 dws2Limit)
- 기존 `insufficient` 레벨 제거, 배지 매핑 자연 호환(high/medium/low)

**6. LandingScreen 중복 버튼 정리**
- intranet 모드에서 "환자 목록 보기"와 "작업 목록 돌아가기"가 동시에 보이던 문제를, `patients.length === 0`일 때만 "환자 목록 보기"를 노출하도록 변경. 서버에 환자가 있고 로컬엔 0명인 케이스의 진입 경로는 유지.

**7. 경추(목) 모듈 결과 패널 정리**
- "BK2109 위험 요인" / "업무관련성 위험 요인" 라벨 불일치를 **"확인된 목 부위 부담 지표"**로 통일.
- 표시 항목을 `riskFactorItems`(BK2109 한정 4개) → `flagItems`(확인된 모든 양성 flag)로 확장. 부담평가/종합소견 미리보기·EMR 텍스트·통합 Excel 모두 동일 라벨/항목 적용.
- `generateJobNarrative`의 첫 줄 `직업: {jobName}` 제거 → SummaryCard 제목/reportGenerator의 `- 직력N:`이 이미 직업명을 제공하던 중복 제거.

**8. 종합소견/내보내기에서 척추 "적용 공식" 텍스트 제거**
- 외부로 나가는 EMR 텍스트와 PDF 척추 섹션 헤더에서 `[적용 공식: MDDM v5.1.3 (정정) / MDDM 레거시 …]` 라인 삭제. 화면 내 SpineResultPanel 배지는 유지 — 임상가 화면 확인용은 그대로, 외부 산출물에선 비공개.

**9. AssessmentTab 오타 수정**
- "수직분포 정리" → "수직분포 원리"

**변경 파일:**
- `src/modules/spine/utils/thresholds.js`: `dailyDose`를 `{ legacy, v513 }` 객체로 구조 변경
- `src/modules/spine/utils/calculations.js`: `calculateLifetimeDose`(+formulaVersion), `classifySpineSeverity`, `assessRisk`, `assessWorkRelatedness`
- `src/modules/spine/components/SpineResultPanel.jsx`: `dailyDoseThreshold` 추출 + 5곳 치환, KPI BSG 전환
- `src/core/components/LandingScreen.jsx`: "환자 목록 보기" 노출 조건
- `src/core/components/AssessmentTab.jsx`: "수직분포 원리"
- `src/modules/cervical/components/CervicalResultPanel.jsx`: SummaryCard 라벨/항목
- `src/modules/cervical/utils/calculations.js`: `generateJobNarrative` 첫 줄 제거
- `src/core/utils/reportGenerator.js`: cervical 섹션 라벨/항목 통일, spine 섹션 "적용 공식" 라인 제거
- `src/core/utils/exportService.js`: cervical 섹션 라벨/항목 통일, spine 섹션 "적용 공식" 라인 제거
- `src/modules/spine/utils/__tests__/calculations.test.js`: import 확장, `classifySpineSeverity` 재작성, `assessRisk`/`assessWorkRelatedness`/`calculateLifetimeDose 버전 분기` 3개 describe 신설

**영향 범위:** 환자 데이터 스키마 변경 없음. legacy 환자도 spine 작업을 편집하면 기존 `promoteSpineFormula`로 자동 v5.1.3 승격되어 새 임계치/공식이 함께 적용됨(공식과 임계치를 묶어서 일관). 397 tests pass.

### v5.1.4 (2026-05-28) — 척추 공식 버전 UI 노출

v5.1.3에서 환자별로 legacy/v5.1.3 공식이 분기되지만 UI에 표시되지 않아 임상가가 어느 공식 적용 중인지 알 수 없던 문제 해결. 계산 로직 변경 없음(순수 표시 추가).

**변경:**
- `src/modules/spine/components/SpineResultPanel.jsx`: "MDDM 결과" 제목 옆 배지 추가
  - v5.1.3: `MDDM v5.1.3` (초록), 정정된 MDDM 공식 적용 안내
  - legacy: `MDDM 레거시` (호박색), v5.1.2 결과 보존 중 + 입력 편집 시 자동 승격 안내
  - 마우스 오버 시 `title` 속성으로 tooltip 노출
- `src/index.css`: `.spine-formula-badge` 스타일 (is-v513 / is-legacy 두 variant)
- `src/core/utils/reportGenerator.js`: PDF 척추 섹션 헤더에 `[적용 공식: MDDM v5.1.3 (정정)]` 또는 `[적용 공식: MDDM 레거시 (v5.1.2 이전 결과 보존)]` 라인 추가
- `src/core/utils/exportService.js`: EMR 텍스트에도 동일 라인 추가

**배포 사유:**
- v5.1.3을 이미 배포한 상태에서 같은 태그 덮어쓰기를 피하기 위해 patch 범프
- 의료 도구에서 "같은 버전 = 같은 동작" 보장 유지 (Docker 이미지 태그도 5.1.4 신규 생성)

**영향 범위:** 계산 함수·반환 키·환자 데이터 스키마 변경 없음. 기존 환자 결과 동일하게 유지되며 단지 어느 공식인지 표시만 추가됨. 380 tests pass.

### v5.1.3 (2026-05-28) — 척추 공식 정정 + 레거시 보존 + 여성 중증도 분리

**1. 공식 정정**: `calculateDailyDose`를 원형 MDDM 공식 `D_r = √(Σ F²·t / 8h) · 8h`로 재작성 (8h 정규화·재곱 누락, 시간이 초로 합산되던 단위 불일치 해결). 동일 입력에 대해 새 공식 결과는 이전 대비 약 ×2.83(=√8) 증가.

**2. 레거시 결과 보존**: 모듈 데이터에 `formulaVersion` 필드 신설. 기존 환자(필드 부재)는 옛 공식 그대로 → 일일선량·평생누적량·위험도·**작업별 일일 기여**까지 이전 PDF/EMR 출력과 100% 동일. spine 작업을 실제로 추가/수정/삭제·드래그 reorder·프리셋 적용·BatchImport로 task 생성한 시점에 자동으로 `v5.1.3`으로 승격. sharedJobId 자동 정리(단순 열기) 경로에서는 승격 안 함 — "열기만 했는데 공식이 바뀜" 회귀 방지.

**3. 작업별 일일 기여 표시 방식**:
- v5.1.3 환자: 총 일일선량을 `F²·t` 비중대로 배분 → 작업별 합 = 총량 (합산 무결성)
- legacy 환자: 기존 단일 작업 공식 `(F × √t_초) / 60000` 그대로 유지 (이전 출력 보존)

**4. 여성 중증도 경계값 분리**: 종합소견의 일일 노출 중증도 4단계 기준이 남녀 공통 → 남녀 분리. 남성은 기존 동일, 여성은 더 민감한 기준(0.5 / 2.0 / 3.0 kN·h, 3,000 / 4,000 / 5,000 N).

**파일 변경**:
- 신규: `src/modules/spine/utils/formulaVersion.js` (상수만 분리)
- `calculations.js`: `calculateDailyDose(tasks, formulaVersion)` 분기, `getSpineTaskDoses(tasksInJob, formulaVersion)`·`classifySpineSeverity(dailyKNh, maxForce, gender)` 신규 export, `computeSpineCalc` return에 `formulaVersion` 포함
- `SpineEvaluation.jsx`: 사용자 task 편집 4개 핸들러에 `promoteSpineFormula` 헬퍼로 자동 승격
- `spine/index.js`: `presetConfig.applyToModule` return에 `formulaVersion` 추가
- `BatchImportModal.jsx`: 실제 task 생성/`Object.assign` 시점에만 승격
- `core/utils/data.js`: 샘플 데이터 2곳에 `formulaVersion: 'v5.1.3'` 추가
- `reportGenerator.js`·`exportService.js`: 로컬 `getSpineTaskDose` + 인라인 중증도 분류 삭제, 공통 헬퍼 import

**임계치/서버 영향**: `thresholds.dailyDose` (남 2.0 / 여 0.5 kN·h)·`thresholds.lifetimeDose` 그대로 유지 (MDDM 원문값). 서버 patient 스키마 변경 없음 — JSONB payload에 새 필드 자연 흡수.

**Out of scope**: legacy 환자 PDF 재출력 시 안내 toast/배지는 별도 결정.

### v5.1.2 (2026-05-26) — 대시보드 통계 확장 + 최근활동 timestamp 계약 정리

서버 모드 전환 후 노출된 최근활동 회귀 버그 (다음 날 옛 환자가 다시 상단으로 올라옴)를 데이터 계약 차원에서 수정. 대시보드 카드 의미 강화 + 인트라넷 테스트 버튼 가드.

**서버↔클라이언트 timestamp 계약**
- 서버 `toResponse()`: `...base` 다음 줄에서 `updatedAt`(DB `updated_at`으로 무조건 덮어쓰기, stale payload 차단) + `createdAt`(payload 값 우선, 없으면 DB `created_at`)을 명시
- 클라이언트 `getRecentActivityTimestamp` 헬퍼: `updatedAt → _savedAt → createdAt` 폴백, `sync.lastSyncedAt` 제외, `Date.parse()` 숫자 비교
- `touchPatientRecord`가 모든 환자 변경 진입점에서 `updatedAt`을 일관 set (이전엔 caller별로 비대칭)
- 회귀 테스트: 서버 4건, 클라이언트 4건

**대시보드 카드 확장**
- 헤더 3영역(좌 spacer / 중앙 로그인 배지 / 우 scope 토글)로 통합
- 내 환자 scope 마지막 카드: "내 미완료 평가" → **"내 환자 평가 완료율"**
- 신규 카드 5종: 성별 비율 (SVG 도넛, 세그먼트 위 라벨 직접 표시), 평균 연령, 연령대 분포 (30대↓~70대↑), 대표 직종 Top 5, 상병 Top 5 — 모두 전체/남/여 토글
- 신규 헬퍼: `normalizeGender`, `computeAge` (`formatBirthDate` 재사용으로 YYYYMMDD도 처리)
- `.dashboard-summary` 그리드: `repeat(auto-fit, minmax(200px, 1fr))` + `grid-auto-rows: minmax(170px, 1fr)` — 카드 수 증가에도 적응, 모든 카드 동일 높이

**테스트 버튼 가드**
- 인트라넷 비admin: UI 버튼 숨김 + 핸들러 early return (이중 방어)
- 인트라넷 admin: `showConfirm`으로 "목록 교체 + 서버 동기화 가능성" 안내

### v5.1.0 (2026-05-20) — 다중 사용자 운영 UX 강화 + 권한 정책 + 척추 모듈 개선

v5.0.0 인트라넷 백엔드 도입 후 실제 다중 사용자 운영에서 드러난 UX 결함과 권한 미비점을 정리. 척추 모듈 입력 효율도 개선.

**환자 권한 정책 (서버 + UI)**
- 신규 미들웨어 `assignedDoctorOrAdmin` — `PATCH/DELETE /api/patients/:id`는 담당의 또는 admin만 허용 (다른 org 404, 비담당 403). 인계(`POST /:id/assignment`)는 현행 admin 전용 유지
- 신규 헬퍼 `src/core/utils/patientOwnership.js` (`canEditPatient`, `canDeletePatient`) — 로컬 모드 단일 사용자라 항상 true, redacted/null patient는 admin/로컬 무관 항상 false
- 신규 환자 생성 시 doctor 세션이면 `meta.assignedDoctorUserId = user.id` 자동 mirroring → sync 전에도 본인 환자 정상 수정
- local-only 안전망: assigned 미정의 + createdBy == me 시 임시 편집 허용
- PatientSidebar 삭제 버튼 게이팅 + 일괄 삭제는 patients 전체 기준 권한 검사
- StepContent 평가 영역을 `inert` div로 감싸 키보드 포커스/탭/스크린리더까지 차단
- `usePatientCrud.updatePatient` silent guard (EMR/preset/conflict resolve 등 우회 경로 차단)
- sync 403 분리 처리: `lastPermissionDeniedCount` 빨간 배너로 명시 표시, 정상 sync 시 자동 clear (pull-only sync 포함)
- 테스트: 서버 12 + 클라 11 = 23 신규

**대시보드 scope 분리**
- 헤더 우상단 토글로 "내 환자 통계" ↔ "전체 통계" 전환 (인트라넷 + 로그인 시만 노출)
- 별도 `dashboardScope` state — 사이드바 환자 목록 sync는 건드리지 않음
- 'mine' 전용 카드: "내 미완료 평가 건수"
- 'all' 전용 카드: "의사별 환자 수 Top 5" (`getDoctorPatientCounts` 신규, 미배정 그룹 별도 표시)
- 빈 상태에서도 헤더+토글 보이고 "전체 보기로 전환" 버튼 제공
- 세션 변경 시 자동 reset

**다중 사용자 운영 UX**
- 신규 `SwitchToLocalButton` — 인트라넷 6개 차단 화면(configLoading/configError/sessionVerifying/LoginModal/ChangePasswordModal/booting-syncing) 우상단 탈출구. 서버 없거나 장애 시 즉시 로컬 전환
- 랜딩에 **"환자 목록 보기"** 버튼 추가 — 헤더 "대시보드" 클릭 후 랜딩에서 환자 목록으로 빠져나갈 수단 마련
- 랜딩 로그인 사용자 배지 (이름/역할) — 인트라넷만
- 인트라넷에서 "초기화" 버튼 숨김 (클라이언트 state만 비우는 동작이라 다중 사용자 환경에서는 삭제처럼 오해될 수 있음). 로컬 모드는 유지
- 신규 `docker-compose.override.yml` — dev 스택만 `http://localhost:3000` CORS 허용

**척추 모듈 개선**
- 수직분포 / 동반 척추증을 **첫 spine 진단에만** 표시 (이전: 진단마다 반복)
- 자동 마이그레이션: 기존 여러 진단에 흩어진 값을 첫 진단으로 통합, 나머지는 필드 제거. 첫 진단 삭제 시 살아남은 spine 진단으로 값 자동 이송
- **척추 작업 드래그앤드롭** — HTML5 native, 현재 직업 탭 내에서만, id 기반 재구성으로 다른 직업 순서 보존. 드래그 후 선택 유지. 방향 인식 drop indicator (위/아래)
- `visibleTasks` 단일 진실원 — 모든 핸들러(select/add/remove/reorder) 일관 기준
- 테스트 15 신규

**검증**: 클라이언트 299 + 서버 369 = 668 tests pass. lint 0 errors. 빌드 성공.

### v5.0.0 (2026-05-16) — 인트라넷 백엔드 + 다중 사용자 모드 + 오프라인 배포

병원 인트라넷 환경 운영을 위한 풀스택 백엔드 도입. 동일 평가 엔진 + 새로운 빌드 타깃 분리 (standalone | intranet).

**백엔드 API 서버 (신규)**
- **Node 20 + TypeScript + Express**, PostgreSQL 16 (15개 migration)
- **인증**: JWT access(15m) + refresh(7d), bcrypt 12라운드, must_change_password 강제 흐름
- **역할 기반 접근**: admin / doctor / nurse / staff
- **두 개의 DB 커넥션 풀**: 메인 (wr_user) + 감사 read-only (wr_audit_reader)
- **DTO 검증**: shared/contracts/* (zod) — 클라이언트와 타입 공유
- **idempotency**: POST 재시도 안전 (migration 0005)
- **테스트**: server/src/**/__tests__/* — admin, auth, audit, patients, presets, workspaces, opsBackupStatus

**Electron 인트라넷 빌드 (신규)**
- **build-target.json**: standalone / intranet 분기 (preload 파일 분리)
- **Device 등록**: 앱 첫 실행 시 Ed25519 키페어 생성, 서버에 공개키 등록 (pending → admin 승인 → active)
- **감사 로그 서명**: 모든 사용자 액션 → device 개인키로 서명 → 서버 검증 → audit_logs 파티션 insert
- **auditQueue**: 네트워크 실패 시 디스크 큐, `flushQueue` (5분 간격)에서 자동 재전송
- **자가 치유**: pending 상태에서도 flushQueue가 tryRegister 재시도 → 승인 후 자동 active 인식
- **EMR 접근 제어**: device active 상태일 때만 EMR helper 호출 허용

**다중 사용자 UI (신규)**
- **AuthContext + authChannel**: 토큰 관리, 자동 refresh, 로그아웃
- **LoginModal**: 인트라넷 모드 진입점
- **ChangePasswordModal**: must_change_password 강제 흐름
- **AccountProfileModal**: 본인 정보 / 비밀번호 변경
- **AdminConsoleModal**: 사용자 관리, device 승인, 감사 로그, 백업 상태, 가입 요청
- **SignupRequestModal**: 비로그인 가입 요청
- **ConflictResolveModal**: 동시 편집 충돌 시 mine/theirs/merge 선택
- **MigrationReportModal**: standalone → 서버 데이터 마이그레이션 결과

**서버 통신 / 동기화**
- **patientServerRepository**: 환자 CRUD (assigned_doctor 자동 해결, payload backfill)
- **intranetWorkspaceRepository**: 워크스페이스 서버 저장
- **usePatientSync**: 환자 목록 폴링 + 변경 감지
- **patientConflictResolution**: ETag(updated_at) 기반 낙관적 락
- **httpClient**: 자동 refresh + CSRF 쿠키 + 에러 매핑
- **localToServerMigrator**: standalone localStorage/파일 → 서버 일괄 마이그레이션

**HTTPS / 내부 CA**
- **Caddy 2** `tls internal` — 내부 CA 자동 생성 + 서버 leaf 인증서 자동 발급/갱신
- **클라이언트 신뢰 등록**: `caddy-root.crt` 추출 → `certutil -addstore -user Root` 또는 GUI 설치

**백업 / 모니터링 / 복구**
- **backup 사이드카** (postgres:16-alpine + gnupg + cron): daily pg_dump + GPG 암호화
- **backup-monitor** (별도 컨테이너): stale 감지, alert 파일 생성, `/api/ops/backup-status`로 노출
- **restore.sh**: 2인 인가(`RESTORE_AUTH_TICKET`) + `GPG_PASSPHRASE` env 지원
- **복구 전용 키 정책**: passphrase-less RSA 4096 별도 발급, 운영 volume에는 공개키만

**오프라인 배포 패키지** (`scripts/export-offline-package.ps1`)
- Docker save → tar → zip 일괄 생성 (app + backup-monitor + backup + postgres:16-alpine + caddy:2-alpine)
- Electron 인스톨러 + compose + Caddyfile + 스크립트 + 문서 포함
- SHA256SUMS, release-manifest.json 자동 생성
- 시크릿 누출 가드: `.env`, `*-private.asc`, DB dump 등 자동 제외 확인

**설치 자동화 스크립트**
- `import-images.ps1` / `.sh` — docker load 일괄
- `install-prod.ps1` — Windows 자동 설치 (사전 검증 6단계 → up -d)

**T46 프로덕션 릴리즈 리허설 (전 섹션 PASS)**
1. Production 환경 분리 (`wr-prod_*` volume 격리)
2. 오프라인 패키지 무결성 (SHA256, secret 미포함, Electron 인스톨러 포함)
3. Admin 초기화 (seedAdmin 비대화형 파이프 입력, must_change_password 플로우)
4. Device 등록 / 승인 (doctor01 pending → admin 승인 → active 자동 인식)
5. 백업 (pg_dump + GPG 암호화, monitor "ok")
6. 복구 리허설 (임시 DB에서 GPG 복호화 + pg_restore, row count 일치, 운영 DB 무영향)
7. 롤백 dry-run (`WR_VERSION=4.2.0` compose config 검증, 파괴 명령 미실행)

**리허설 중 발견 + fix 완료**
- **alert resolve 권한**: `backup.sh` `write_json_atomic`에 `_alerts/*` 생성 후 `chown 1000:1000` → admin 콘솔 "해결" 버튼 500 에러 수정
- **GPG passphrase**: `restore.sh`에 `GPG_PASSPHRASE` env 지원 + 복구 전용 passphrase-less 키 발급 가이드 추가

**문서 (신규 / 대폭 개정)**
- `docs/OFFLINE_DEPLOYMENT_PACKAGE.md` — 12개 섹션 단계별 설치 가이드 (Windows/Linux 분리, PowerShell 실행 정책 포함)
- `docs/PRODUCTION_RELEASE_PLAN.md` — 운영 절차서 (롤백 6-2/6-3 경로 분기)
- `docs/T46_GO_NO_GO.md`, `docs/T46_IMPLEMENTATION_PLAN.md`
- `docs/OPERATIONS_RUNBOOK.md`, `docs/BACKUP_MONITORING_PLAN.md`
- `docs/INTRANET_DEPLOYMENT.md` — HTTPS / 내부 CA / 인증서 신뢰 등록 3가지 방법

**리팩터링 / 개선**
- `seedAdmin.ts` 비대화형 파이프 입력 지원 수정 (`fs.readFileSync(0, 'utf-8').split(/\r?\n/)` 사전 읽기)
- 프리셋 UI 한국어 라벨화 (custom → "내 프리셋", builtin → "기본 프리셋")
- 인트라넷 모드에서 마이그레이션 직후 랜딩↔환자목록 튕김 해결
- Electron Standalone 인스톨러에서도 마이그레이션 IPC 지원 (`feature/intranet-backend`)

### v4.2.1 (2026-04-27) — 대시보드 & 환자 관리 기능 강화

**대시보드 기능 확장**
- **StackedBarChart 컴포넌트 신설**: 업무관련성 평가 결과별 세분화 차트
  - 높음(≥50% 업무관련성) / 낮음(<50%) / 미평가 3개 세그먼트로 구성
  - 범례 인라인 표시 (색상 점 + 라벨)
  - 누적 막대 형식으로 전체 분포 직관화
- **BarChart 컴포넌트 개선**
  - `caption` prop 추가 (시간 범위 및 설명)
  - 차트 틀 레이아웃 최적화
- **통계 함수 확대** (`dashboardStats.js`)
  - 모듈별 / 평가결과별(높음/낮음/미평가) 세분화 계산
  - 기간별 추이 분석 함수 신설

**환자 목록 검색·필터·정렬 대폭 강화** (PatientSidebar)
- **정렬 기능** (6가지 방식)
  | 정렬 방식 | 기본값 | 설명 |
  |---------|------|------|
  | 기본 (등록 순서) | ↑ | 등록일 오름차순 |
  | 이름 | ↑ | 가나다 순 |
  | 환자번호 | ↑ | 숫자 순 |
  | 생년월일 | ↑ | 최고령/최저령 |
  | 등록일 | ↓ | 최근 등록 우선 |
  | 평가일 | ↓ | 최근 평가 우선 |
  - **인라인 정렬 토글**: 헤더 클릭 → 현재 정렬 방식 표시 + 오름/내림 토글
  - **기본값 설정**: 각 정렬 방식별 초기 방향 정의 (`DEFAULT_SORT_DIRECTION`)

- **고급 필터** (4가지 조건)
  | 필터 | 입력 방식 | 설명 |
  |------|---------|------|
  | 모듈 필터 | 드롭다운 | 특정 모듈이 활성된 환자만 선택 (all/knee/spine/...) |
  | 직업 필터 | 자동완성 입력 | 환자 직업력에 포함된 직업명 검색 |
  | 등록일 범위 | Date 범위 | 등록일 Start ~ End 선택 |
  | 평가일 범위 | Date 범위 | 평가일(마지막 수정) Start ~ End 선택 |
  - **필터 상태 기억**: 정렬/필터 변경 시 실시간 업데이트
  - **필터 초기화**: `ADVANCED_FILTER_DEFAULTS` 객체로 한 번에 리셋

- **직업 자동완성** (`JobFilterCombobox` 컴포넌트)
  - **전체 직업 목록 추출**: 현재 환자 목록의 모든 직업 수집 + 가나다 정렬
  - **입력 중 제안**: 입력값 포함 직업 최대 10개 제시
  - **키보드 네비게이션**:
    - ↑↓: 제안 항목 선택 (자동 스크롤)
    - Enter: 선택한 항목 확정
    - Esc: 제안 패널 닫기
  - **마우스 클릭**: 제안 항목 클릭 → 자동 선택
  - **문서 외 클릭**: 제안 패널 자동 닫기

**UI/UX 개선**
- **날짜 입력 범위**: `1900-01-01` ~ `2099-12-31` (모든 평가 대상 가능)
- **날짜 포맷**: 표시는 YYYY-MM-DD (인라인, 짧은 형식)
- **필터 폼 레이아웃**: `.filter-group` CSS 클래스로 필드 그룹화
- **다크모드 호환성**: 모든 신규 UI 요소에 CSS 변수 적용 (`--text-muted`, `--color-safe`, `--accent` 등)

**코드 구조**
- **usePatientList** 훅 확대: 필터링/정렬 로직 모듈화
- **dashboardStats.js**: 세분화 통계 함수 신설
  - `computeModuleStats()`: 모듈별 환자 분포
  - `computeRiskStats()`: 업무관련성 높음/낮음/미평가 분포
  - `computeTrendData()`: 기간별 추이
- **PatientSidebar 내부 컴포넌트 분리**:
  - `JobFilterCombobox`: 직업 자동완성 로직 캡슐화
  - 필터 폼 섹션: 각 필터별 컨트롤 독립 관리

### v4.2.0 (2026-04-25) — 아키텍처 리팩터링

**App.jsx 대규모 분리 리팩터링**
- **목표**: Monolithic App.jsx를 컴포넌트와 훅으로 분리하여 유지보수성·테스트 가능성 향상
- **새로운 UI 컴포넌트** (`src/core/components/`)
  - `LandingScreen.jsx`: 홈 화면 및 환자 목록 표시
  - `IntakeWizard.jsx`: 신규 환자 생성 3단계 위자드 (기본정보 → 상병 입력 → 모듈 선택)
  - `PatientSidebar.jsx`: 환자 목록 사이드바 (검색/필터/정렬)
  - `MainHeader.jsx`: 상단 헤더 (환자 정보, 설정, 내보내기 도구)
  - `StepContent.jsx`: 활성 스텝의 콘텐츠 렌더러 (공유/모듈별 스텝 분기)
  - `StepIndicator.jsx`: 위자드 진행 표시기 (현재 스텝 강조)
  - `SaveLoadModals.jsx`: 저장/로드 모달 (SaveModal, LoadModal 내보내기)
- **새로운 사용자 정의 훅** (`src/core/hooks/`)
  - `useEMRIntegration.js`: EMR 통합 상태 및 동기화 관리
  - `useExportHandlers.js`: 엑셀/PDF/HTML 내보내기 로직 통합
  - `useIntakeWizard.js`: 신규 환자 위자드 상태 및 검증
  - `usePatientCrud.js`: 환자 생성/조회/수정/삭제 작업
  - `usePresetManagement.js`: 프리셋 로드/저장/삭제 및 캐싱
  - `useStepNavigation.js`: 스텝 네비게이션 및 진행 상태 관리
  - `useWorkspacePersistence.js`: 워크스페이스 자동 저장/복구
- **새로운 유틸리티** (`src/core/utils/`)
  - `steps.js`: `buildSteps(activeModules)` 함수로 활성 모듈에 따른 동적 스텝 생성
- **개선 사항**
  - App.jsx 파일 크기 1500+ 줄 → 200줄 이하로 축소
  - 로직별 관심사 분리로 코드 이해도·유지보수성 향상
  - 개별 훅·컴포넌트 단위 테스트 작성 가능
  - 번들 코드 스플릿 최적화 기반 마련

**경추 모듈 계산 로직 최적화** (`src/modules/cervical/`)
- 완료 판정 완화: task가 있는 직업에 대해서만 필드 완성 체크
- RISK_FACTOR_FLAGS를 warning tone 4개로 한정 (positive/info 혼입 제거)
- 파생 플래그 중복 집계 제거로 성능 향상
- 고아 task 자동 정리 (jobExtras에서 orphan 제거)
- 프리셋 적용 시 sharedJobId 없는 기본 task 교체로 안정성 개선
- 컴포넌트 재구성: ExposureForm/DiseaseSpecificFields → TaskManager/TaskEditor (spine 패턴 동일화)

### v4.1.0 (2026-04-24) — 경추·척추 품질 개선 + 문서 업데이트

**경추 모듈 개선**
- 완료 판정 완화: task가 있는 직업에만 필드 완성 체크 적용
- RISK_FACTOR_FLAGS 정규화: warning tone 4개로 한정
- 파생 플래그 중복 집계 제거
- 고아 task 자동 정리 (직업 삭제 시 고아 task 정리)
- 프리셋 적용 안정성: sharedJobId 없는 기본 task 자동 교체

**척추 모듈 개선**
- isCervicalAssessmentComplete 중복 syncCervicalModuleData 호출 제거
- 고아 task 자동 정리 useEffect 추가

**문서 업데이트**
- PRD.md: 데이터 모델 및 디렉토리 구조 최신화
- README.md: 빌드/실행 명령어 및 모듈 추가 절차 명확화
- CLAUDE.md: 지원 모듈 목록 확대 (손목 모듈 추가)
| jszip | 3.10.1 |
