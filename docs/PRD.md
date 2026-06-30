# PRD: 직업성 질환 통합 평가 시스템 (wr-evaluation-unified)

> **Version:** 6.1.0
> **Last Updated:** 2026-06-28
> **Status:** M4 영상분석 시범 운영(참고용, 미검증 배너) + 손목(wholebody)·상지 반복빈도 candidate / 인트라넷 운영 중

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
| 테스트 | Vitest (renderer + electron) |

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
    │             workPeriodOverride, workDaysPerYear }
    ├── modules
    │   ├── knee                        ← 무릎 전용
    │   │   ├── jobExtras[]             ← 직종별 신체부담 (sharedJobId로 연결)
    │   │   │   └── { sharedJobId, weight, squatting,
    │   │   │         stairs, kneeTwist, startStop,
    │   │   │         tightSpace, kneeContact, jumpDown }
    │   │   └── returnConsiderations    ← 복귀 고려사항
    │   ├── spine                       ← 척추 전용
    │   │   └── tasks[]                 ← MDDM 작업 목록
    │   │       └── { id, name, posture, weight, frequency,
    │   │             timeValue, timeUnit, correctionFactor, force,
    │   │             sharedJobId }     ← 직업력 연결 (shared.jobs[].id)
    │   ├── shoulder                    ← 어깨 전용
    │   │   ├── jobExtras[]             ← 직종별 신체부담 (sharedJobId로 연결)
    │   │   │   └── { sharedJobId, overheadHours, repetitiveMediumHours,
    │   │   │         repetitiveFastHours, heavyLoadCount, heavyLoadSeconds,
    │   │   │         vibrationHours, evidenceSources[] }
    │   │   └── returnConsiderations    ← 복귀 고려사항
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
    │       └── returnConsiderations    ← 복귀 고려사항
    │   ├── wrist                       ← 손목 전용 (Job × Diagnosis 2차원)
    │   │   ├── temporalSequence        ← 공통 시간적 선후관계 (모듈 전체 1회 입력)
    │   │   ├── jobEvaluations[]        ← 직업별 × 상병별 엔트리
    │   │   └── returnConsiderations    ← 복귀 고려사항
    │   └── cervical                    ← 경추 전용 (spine 패턴과 동일)
    │       └── tasks[]                 ← 경추 작업 목록
    │           └── { id, name, exposure_types[], load_weight_kg,
    │                 carry_hours_per_shift, forced_neck_posture,
    │                 neck_nonneutral_hours_per_day,
    │                 combined_flexion_rotation_posture,
    │                 precision_work, notes,
    │                 sharedJobId }     ← 직업력 연결 (shared.jobs[].id)
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
- **무릎 상병:** KLG 등급 입력 (좌/우) + 상태 확인 + 업무관련성 평가
- **팔꿈치/손목 상병:** BK 유형(자동 제안/수동) + 공통 시간적 선후관계 + 상태 확인 + 업무관련성 평가
- **어깨 상병:** Ellman Class 입력 (좌/우) + 상태 확인 + 업무관련성 평가
- **척추 상병:** 수직분포원리(확인/미확인) + 동반성 척추증(확인/미확인) 드롭다운 + 상태 확인 + 업무관련성 평가 (좌우 구분 없음)
- **경추 상병:** 척추와 동일하게 좌우 구분 없는 축(Axial) 상병으로 처리 + 상태 확인 + 업무관련성 평가
- 복귀 고려사항 (무릎/팔꿈치/손목/어깨/경추 모듈 활성 시)

**우측 패널 — 미리보기:**
- 전체 모듈 결과를 텍스트 보고서로 통합 표시 (패널 높이를 꽉 채움)

상병별로 `getDiagnosisModuleHint()`를 사용하여 무릎/척추를 자동 구분하고, 해당 모듈에 맞는 입력 UI를 렌더링한다.

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

[복귀 관련 고려사항]
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
| 3.최종 확인 상병명 | 상병별 확인 상태 + 업무관련성 |
| 4.직업적 요인 | 직업력 + 모듈별 신체부담평가 통합 |
| 5.개인적 요인 | 키/몸무게/BMI/나이/특이사항 |
| 6.종합소견 | 기여도 + 상병별 종합소견 통합 |
| 7.복귀 관련 고려사항 | 복귀 고려사항 |

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

파일명: `일괄입력용_{이름 또는 N명}_{날짜}.xlsx`

**컬럼 구성 (75열):**
- 기본정보(6): 이름, 생년월일, 재해일자, 키, 몸무게, 성별
- 기관정보(3): 병원명, 진료과, 담당의
- 기타(2): 특이사항, 복귀고려사항
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
├── migrations/                          # 15개 SQL migration
├── src/
│   ├── index.ts                         # Express 진입점, 두 개의 pg pool
│   ├── config.ts                        # env 검증
│   ├── middleware/                      # auth, audit, cors, rateLimit, security
│   ├── routes/                          # auth, patients, presets, workspaces, admin,
│   │                                    # audit, devices, ai, opsStatus
│   ├── jobs/                            # workspaceRetention 등
│   ├── db/                              # patientPersons, resolveAssignedDoctor
│   └── cli/                             # seedAdmin, runRetention
└── package.json

services/backup-monitor/                 # 백업 stale 감지 + alert 컨테이너
├── Dockerfile
├── index.js
└── __tests__/isStale.test.js

backup/Dockerfile                        # backup 사이드카 (postgres + gnupg + cron)
caddy/Caddyfile                          # HTTPS + 내부 CA

shared/contracts/                        # 클라이언트 ↔ 서버 공유 타입 (zod)
└── auth.ts, patient.ts, preset.ts, index.ts

scripts/                                 # 운영 자동화
├── backup.sh, restore.sh, audit-partition.sh
├── backup-crontab, partition-crontab
├── export-offline-package.ps1           # 오프라인 패키지 생성
├── import-images.ps1 / .sh              # docker load 일괄
├── install-prod.ps1                     # Windows 자동 설치
├── set-build-target.mjs                 # standalone/intranet 빌드 토글
└── verify-csp.mjs

src/core/auth/                           # AuthContext, authChannel, session — v5.0.0
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

### 12.A.2 데이터베이스 스키마 (migrations 0001~0015)

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

### 12.A.10-A 환자 권한 정책 (v5.1.0 추가)

- **수정/삭제 권한**: 담당의(`assigned_doctor_user_id`) 또는 admin만 가능. 타 의사 환자는 조회만 허용
- **서버 미들웨어** `assignedDoctorOrAdmin` — `PATCH/DELETE /api/patients/:id`에 적용. 다른 org는 404(존재 누설 방지), 비담당은 403
- **클라이언트 헬퍼** `canEditPatient` / `canDeletePatient` — 로컬 모드는 단일 사용자라 항상 true, redacted는 항상 false
- 신규 환자 생성 시 doctor 세션이면 `assignedDoctorUserId` 자동 mirroring → sync 전에도 본인 환자 정상 수정
- 동기화 시 403 받은 환자는 빨간 배너 표시, 정상 sync 시 자동 해제
- StepContent 평가 영역을 HTML `inert`로 감싸 비담당 환자의 키보드/포커스/스크린리더 접근 차단

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

### 인프라

| 컴포넌트 | 버전 |
|----------|------|
| PostgreSQL | 16 (alpine) |
| Caddy | 2 (alpine) |
| Docker Engine | 24+ |
| Docker Compose | v2.17+ (`!reset` 태그 필수) |

---

## 변경 이력

### v6.1.2 (2026-06-30) — 직업 프리셋 조직 공유

직업 노출 프리셋을 개인(private) 저장에서 **조직 공유(organization)** 로 확장. 신규 사용자가 동료의 프리셋을 검색·적용해 바로 활용할 수 있게 한다.

- **저장 토글**: 저장 모달에 공개범위 선택(인트라넷 기본=조직 공유, 로컬/Electron은 숨김·private 고정). 소유 기반 "수정 vs 신규" 매칭으로 동료 행을 PATCH하다 403 나는 것을 차단, 비소유 프리셋 편집 진입 시 읽기전용.
- **목록 UI**: 검색 드롭다운·조회 모달에 `own/shared/builtin` 소스 분류 → 소유자 배지("조직 공유 · 이름")·읽기전용(비소유는 적용/복제만)·소스 필터·정렬. 서버 `listPresets`에 `users` 조인으로 소유자명 노출, `presetRepository` PATCH `visibility` 갱신 갭 수정.
- **관리자 '프리셋 공유' 탭**: 조직 전체 프리셋을 보고 **선택형 양방향**(조직 공유 ↔ 비공개)으로 일괄/개별 전환(`GET/POST /api/admin/presets[/visibility]`, ids dedupe·`visibility<>target` skip·org-scope·감사 로그에 requested/updated id 분리).
- **마이그레이션 0023**: 기존 private 프리셋을 일괄 조직 공유로 백필(직전까지 visibility가 하드코딩 private였으므로 "선택이 아닌 강제"였던 데이터를 소급 전환). ⚠️ 토글 UI와 **동일 릴리스로만** 배포(주석 명시).
- 검증: 클라 테스트(presetRepository 10 신규 포함) + 서버 라우트 테스트(presets/admin 신규 포함) pass, `build:web`·server build·lint 0 errors. 라이브 dev 스택에서 2계정 공유·0023 백필·관리자 전환 검증. **Electron 셸 무변경 → 인트라넷 설치본 재배포 불필요(서버 이미지만 갱신).**

### v6.1.1 (2026-06-28) — 영상분석 처리시간 안정화 + 추론 디바이스(GPU) 토글 + overlay 가독성 (6.0-12)

손목(wholebody) 라이브 검증에서 "분석 실패(processing)"로 끝나던 문제 해결(클라이언트 폴링이 wholebody CPU 추론보다 먼저 포기 → 서버 deadline 기반으로 일관화) + 조직별 추론 디바이스 토글 + 검수 overlay 손 keypoint 가독성 개선.

- **처리시간 deadline 일관화(Part A)**: `config.video.jobDeadlineMs`(기본 600s)·`sweepGraceMs`·`queueWaitMs` 단일 진실원천. 워커가 전체 job deadline을 infer/feature subprocess에 엄격 분배(합이 deadline 초과 불가, 2×timeout 버그 차단), `sweepStale`도 동일 값에서 파생. 클라 `pollJob`을 queued/processing 예산 분리 + `POLL_TIMEOUT` 구조화(상태로 뭉개지 않고 phase별 메시지). `/api/config/public`로 노출.
- **추론 디바이스(GPU) 토글(Part B)**: 조직 설정 `inference_device`(auto/cpu/cuda) — auto=GPU 가능 시 사용·실패 시 CPU 폴백, cuda=강제(실패 시 job error). python `infer_clip --device` + `probe_device.py`(GPU 감지, Node가 아닌 추론 Python 환경에서). 워커가 실행 디바이스를 job에 기록, 관리자 콘솔 "추론 디바이스" 탭 + 검수 화면 공정별 실행 배지(GPU/CPU/CPU폴백). 기본 auto·동작 변경 없는 opt-in.
- **검수 overlay 가독성**: wholebody 손 keypoint(한 손 21점)가 몸 점과 같은 크기로 그려져 뭉치던 것을 ~1/3로 축소(손가락 관절 식별).
- 검증: 서버 517 / 클라 794 / poseKeypoints 18 tests pass, 마이그레이션 0022(추론 디바이스 컬럼), `build:web`·typecheck·lint 0 errors. 라이브 스택(마이그레이션·워커 claim·브라우저) 통과. **Electron 셸 무변경 → 인트라넷 설치본 재배포 불필요(서버 이미지만 갱신).**

### v6.1.0 (2026-06-28) — 영상분석 손목(wholebody) + 상지 반복빈도 candidate

근골격계 부담작업 영상분석에 손목/손가락(wholebody 포즈)과 상지 반복빈도를 "참고용 candidate"로 추가. 손목은 전부 candidate(자동입력 없음) — 게이팅 활성(자동제안)은 정확도 검증(6.0-B2) 통과 후. (M4 6.0-10·6.0-11)

- **손목 영상분석(6.0-10)**: "손목·손(고프레임)" 프로필 클립만 wholebody 포즈(rtmw-dw-l-m, 133점 추출 → body17+hand42=59점 저장, face·feet drop) on-demand 추론. 손목 굽힘 반복(cycles/min)·굴곡/편위 peak 각도를 candidate로 노출하되, **굴곡=측면·편위=정면 클립에서만**(시점 하드 게이트). body17 경로·기존 feature 무변경(회귀 0).
- **상지 반복빈도(6.0-11)**: 어깨 상완거상·팔꿈치 굴곡 반복(cycles/min) candidate — phase-independent half-swing 카운팅 + 저fps Nyquist 경고.
- **에어갭 모델 교체**: manifest pose role 분리(`pose-body`/`pose-wholebody`, 레거시 `pose`=body 하위호환), recipe가 클립별 사용 모델 식별(`poseSha256`·`modelVersion`). app 이미지 +약 114MB(wholebody 가중치 baking).
- 검증: 서버 91+ / 클라이언트 789 tests pass, `npm run build:web`·typecheck 통과, body17 회귀 0.

### v6.0.0 (2026-06-22) — M4 영상분석 시범 운영(참고용) + 에어갭 패키징

근골격계 부담작업 영상분석(자세 추정 기반)을 "참고용 시범 운영"으로 활성화하고, 에어갭 인트라넷 서버용 오프라인 배포 패키지를 완성. (M4 6.0-9)

- **레시피 버전관리(§8.11)**: 분석 산출물에 `analysis_recipe`(코드 commit·가중치 sha·키포인트 계약)를 기록. 서버가 apply 시 레시피를 권위 검증(suffix diff·canonical prefix 불변·exact-set·서버 상수 대조·provenance 필수)하고, 미검증(unverified)은 fail-closed로 차단.
- **에어갭 컨테이너화**: Python 포즈 추론(rtmlib/onnxruntime-cpu)을 app 이미지에 동봉, baked 가중치의 실제 `.onnx` SHA256을 manifest와 대조해 불일치 시 fail-closed(`model_loader.verified_model_shas`). `server/Dockerfile` glibc(bookworm) 통일.
- **오프라인 패키지**: `scripts/export-offline-package.ps1` — 실파일 sha 검증·dirty 가드·`WR_GIT_COMMIT` 주입·`release-manifest.json`(videoInference 출처) 생성. compose에 `video_uploads` 볼륨 + 추론 mem/cpu 제한.
- **시범 운영 정책 B**: 영상분석 결과에 "미검증(참고용)" 배너 표시 + 제안 행 수정 시 수정사유(`editReason`) 입력 → 피드백 수집. 정확도 검증·임계값 배선 전까지 자동 게이팅은 비활성.
- **대시보드**: 관리자 의사별 통계 드롭다운 + 위험도 '낮음' 사유 7항목 분할.
- 검증: 서버 513 / 클라이언트 770 tests pass, `npm run build:web` 통과, docker build + `--network none` 추론 smoke 통과.

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
