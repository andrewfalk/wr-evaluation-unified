# PRD: 직업성 질환 통합 평가 시스템 (wr-evaluation-unified)

> **Version:** 2.4.1
> **Last Updated:** 2026-03-26
> **Status:** MVP 개발 완료 / Vercel 배포 완료

---

## 1. 제품 개요

### 1.1 목적

직업환경의학 전문의가 **업무상 질병 인정 여부를 판단**할 때 사용하는 통합 평가 도구.
현재 무릎(슬관절)과 척추(요추 MDDM) 평가를 지원하며, 향후 고관절·어깨 등 추가 부위를 플러그인 형태로 확장할 수 있는 아키텍처로 설계되었다.

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

### 1.4 기술 스택

| 영역 | 기술 |
|------|------|
| 프론트엔드 | React 18, CSS Variables (다크모드 지원) |
| 빌드 | Vite 5 |
| 데스크톱 | Electron 21 + electron-builder (NSIS) |
| 웹 배포 | Vercel (서버리스) |
| AI | Google Gemini API + Claude API (Vercel 서버리스 프록시 / Electron IPC 직접 호출) |
| 내보내기 | xlsx (엑셀), html2pdf.js (PDF), jszip |
| 폰트 | Pretendard (CDN), Noto Sans KR (fallback) |

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
    │   ├── name, gender, height, weight, birthDate
    │   ├── injuryDate, evaluationDate
    │   ├── hospitalName, department, doctorName
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
    │   └── spine                       ← 척추 전용
    │       └── tasks[]                 ← MDDM 작업 목록
    │           └── { id, name, posture, weight, frequency,
    │                 timeValue, timeUnit, correctionFactor, force,
    │                 sharedJobId }     ← 직업력 연결 (shared.jobs[].id)
    └── activeModules: ['knee', 'spine']
```

**공통/전용 분리 원칙:**
직종명·기간·연간근무일수 등 여러 모듈에서 공통으로 필요한 정보는 `shared.jobs[]`에, 쪼그려앉기 시간·중량물 무게 등 모듈 고유 정보는 `modules.<id>.jobExtras[]`에 저장한다. `sharedJobId`로 1:1 매핑된다.

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
[척추] 🦴 신체부담 평가
[공유] 종합소견 → AI 분석
```

`buildSteps(activeModules)` 함수가 활성 모듈에 따라 동적으로 스텝 목록을 생성한다.

### 3.3 종합소견 스텝 (공유 최종 스텝)

모든 모듈의 평가 결과를 **좌우 2패널 레이아웃**으로 표시한다:

**좌측 패널 — 입력:**
- **무릎 상병:** KLG 등급 입력 (좌/우) + 상태 확인 + 업무관련성 평가
- **척추 상병:** 상태 확인 + 업무관련성 평가 (KLG/좌우 구분 없음)
- 복귀 고려사항 (무릎 모듈 활성 시)

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

### 4.2 척추 모듈 (spine)

**평가 방법론:** MDDM (Mainz-Dortmund Dose Model) — 독일 직업성 요추 질환 평가 모델

#### 신체부담 평가 (SpineEvaluation + TaskManager + TaskEditor + SpineResultPanel)

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
일일선량:   D = √(Σ F²·t) / 1000 / 60  (kN·h)

직업별 누적노출량 (v2.4.0):
  for each job in shared.jobs:
    jobTasks = tasks.filter(t => t.sharedJobId === job.id)
    jobDailyDose = calculateDailyDose(jobTasks, gender)
    jobLifetimeDose = jobDailyDose × 연간근무일수 × 해당직업 근무년수
  totalLifetimeDose = Σ(각 직업의 lifetimeDose)  (MN·h)
```

**하위 호환:** `sharedJobId`가 없는 기존 task는 첫 번째 직업에 자동 귀속. legacy 필드(`careerYears` 등)가 존재하면 기존 단일 계산 방식 유지.

**업무관련성 판정 기준:**

| 기준 | 남성 | 여성 | 판정 |
|------|------|------|------|
| DWS2 연구 기준 | 7.0 MN·h | 3.0 MN·h | 높음 (산재 적극 권고) |
| 독일 법원 기준 | 12.5 MN·h | 8.5 MN·h | 중등도 |
| MDDM 기준 | 25 MN·h | 17 MN·h | 참고 |
| MDDM 50% | 12.5 MN·h | 8.5 MN·h | 낮음 |
| MDDM 50% 미만 | — | — | 불충분 |

---

## 5. 기본정보 공유 모델

### 5.1 인적사항 (섹션 1)

이름, 성별, 신장, 체중, 생년월일, 재해일자
BMI와 만 나이를 자동 계산하여 표시.

### 5.2 직업력 (섹션 2)

기존에 모듈별로 분산되어 있던 직업 정보를 **공통 영역으로 통합**:

- **카드 형식**: 복수 직종 입력 가능 (추가/삭제)
- **직종명**: 프리셋 검색(PresetSearch) 지원 — `job-presets.json` 기반 자동완성
- **기간**: 시작일/종료일 또는 수동 입력 ("5년 3개월")
- **연간 근무일수**: 기본값 250일
- **프리셋 연동**: 무릎 모듈 활성 시 프리셋 선택으로 weight/squatting 자동 채움

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

  <척추 (요추)>                ← 척추 활성 시만 표시
  [직력별 평가 결과]            ← 2개 이상 직업 시 직업별 일일선량/누적선량
  [합산 결과] + [기준 비교] + [신체부담기여도]

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

**컬럼 구성 (36열):**
- 기본정보(6): 이름, 생년월일, 재해일자, 키, 몸무게, 성별
- 기관정보(3): 병원명, 진료과, 담당의
- 기타(2): 특이사항, 복귀고려사항
- 상병(5): 진단코드, 진단명, 부위, KLG(우측), KLG(좌측)
- 직업(7): 직종명, 시작일, 종료일, 근무기간(년), 근무기간(개월), 중량물(kg), 쪼그려앉기(분)
- 무릎 보조변수(6): 계단오르내리기, 무릎비틀림, 출발정지반복, 좁은공간, 무릎접촉충격, 뛰어내리기
- 척추 작업(7): 작업명, 자세코드(G1-G11), 작업중량(kg), 횟수/일, 시간값, 시간단위(sec/min/hr), 보정계수

**행 생성 규칙:** 척추 작업을 직업별로 그룹핑하여 같은 직업의 작업이 해당 직업 행에 배치됨. 환자별 row 수 = max(1, 상병수, 직업-작업 쌍 수). merge key(이름+생년월일+재해일자)는 매 행 반복.

### 7.3 PDF

무릎 모듈 활성 시 보고서 미리보기 영역을 html2pdf.js로 PDF 변환.

### 7.4 일괄 입력 (Batch Import)

`BatchImportModal`에서 엑셀 파일을 읽어 복수 환자를 일괄 등록 (36열 지원). 드래그 앤 드롭 영역(`.import-zone`)은 점선 테두리 + 아이콘 + 호버/드래그 하이라이트로 시각적 가독성 확보:
- 공통 필드 → `shared.jobs[]`
- 무릎 전용 → `modules.knee.jobExtras[]`
- 척추 작업 → `modules.spine.tasks[]` (작업명, 자세코드, 중량, 횟수, 시간값/단위, 보정계수)
- 같은 행에 직종명과 척추 작업이 모두 있으면 `sharedJobId`로 해당 직업에 자동 연결
- 기존 환자와 이름 중복 시 상병/직업/작업 추가 (병합)
- 척추 작업 데이터 존재 시 자동으로 spine 모듈 활성화

---

## 8. 상병 자동 매핑

`diagnosisMapping.js`에서 ICD 코드와 상병명을 분석하여 적합한 모듈을 자동 추천:

| ICD 코드 패턴 | 추천 모듈 |
|---------------|-----------|
| M17, M22, M23, M70.4, M76.5, S83 | 무릎 (knee) |
| M51, M54, M47, M48, M50, M53 | 척추 (spine) |

상병명 키워드 매칭도 병행: 슬관절, 무릎, 반월상, 추간판, 디스크, 협착증 등.

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
│   │   ├── PresetSearch.jsx             # 직업 프리셋 검색 (자동완성)
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
│   └── spine/                           # 척추 모듈
│       ├── index.js                     # registerModule()
│       ├── SpineEvaluation.jsx          # 메인 컴포넌트
│       ├── components/
│       │   ├── TaskManager.jsx          # 작업 목록 관리
│       │   ├── TaskEditor.jsx           # 작업 편집 (자세/하중/빈도)
│       │   └── SpineResultPanel.jsx     # MDDM 결과 대시보드 (summary/threshold/기여도)
│       └── utils/
│           ├── data.js                  # createTask, createSpineModuleData
│           ├── calculations.js          # MDDM 압박력/선량/노출량 계산
│           ├── exportHandlers.js        # 보고서 생성, Excel 내보내기
│           ├── formulaDB.js             # G1~G11 자세별 계수 (b, m)
│           └── thresholds.js            # 성별/기준별 판정 역치
│
api/analyze.js                           # Vercel 서버리스 (Claude API 프록시)
electron/
├── main.js                              # Electron 메인 프로세스
└── preload.js                           # IPC 브릿지
public/
├── images/                              # G1~G11 자세 이미지
├── job-presets.json                     # 직업별 부담 프리셋 DB
└── icon.ico                             # 앱 아이콘
```

**총 소스 파일:** 38개 (23 .jsx + 15 .js)

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

---

## 14. 향후 로드맵

| 우선순위 | 항목 | 설명 |
|----------|------|------|
| P0 | ~~런타임 검증~~ | ~~빌드 완료 상태, 실제 사용 시나리오 테스트~~ → Vercel 배포 완료 |
| P1 | 고관절 모듈 | hip 모듈 추가 (플러그인 패턴 활용) |
| P1 | 어깨 모듈 | shoulder 모듈 추가 |
| P2 | 척추 프리셋 연동 | 직업 프리셋 선택 시 MDDM 작업/변수 자동 채움 |
| P2 | 통합 PDF/Word | 통합 보고서를 PDF/Word 형식으로도 출력 |
| P3 | 다중 사용자 | 서버 기반 데이터 저장 + 사용자 인증 |
| P3 | 통계 대시보드 | 누적 평가 데이터 기반 역학 분석 |

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

| 패키지 | 버전 |
|--------|------|
| react | 18.2.0 |
| react-dom | 18.2.0 |
| vite | 5.0.0 |
| electron | 21.4.4 |
| xlsx | 0.18.5 |
| html2pdf.js | 0.10.1 |
| jszip | 3.10.1 |
