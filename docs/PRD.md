# PRD: 직업성 질환 통합 평가 시스템 (wr-evaluation-unified)

> **Version:** 4.0.0
> **Last Updated:** 2026-04-23
> **Status:** MVP 개발 완료 / Vercel 배포 완료

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
    │   └── cervical                    ← 경추 전용 (Job × Diagnosis 2차원)
    │       ├── jobEvaluations[]        ← 직업별 × 상병별 엔트리
    │       └── returnConsiderations    ← 복귀 고려사항
    └── activeModules: ['knee', 'spine', 'shoulder', 'elbow', 'wrist', 'cervical']
```

**공통/전용 분리 원칙:**
직종명·기간·연간근무일수 등 여러 모듈에서 공통으로 필요한 정보는 `shared.jobs[]`에, 쪼그려앉기 시간·중량물 무게 등 모듈 고유 정보는 `modules.<id>.jobExtras[]`에 저장한다. `sharedJobId`로 1:1 매핑된다.

**팔꿈치/손목 모듈 예외 — Job × Diagnosis 2차원 구조:**
팔꿈치와 손목은 동일 직업 내에서도 상병별로 BK 분기별 지표가 달라지기 때문에 `jobExtras[]`(직업 1차원) 대신 `jobEvaluations[].diagnosisEntries[]`(직업 × 상병 2차원) 구조를 사용한다. `sharedJobId`로 `shared.jobs[]`와 연결되고, `diagnosisId`로 `shared.diagnoses[]`와 연결된다.

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

#### 데이터 구조 (Job × Diagnosis 2차원)

```
modules.cervical
├── jobEvaluations[]
│   └── { sharedJobId,
│         diagnosisEntries[{
│           diagnosisId, main_task_name,
│           exposure_types[],
│           load_weight_kg, carry_hours_per_shift,
│           forced_neck_posture, neck_flexion_hours_per_day,
│           combined_flexion_rotation_posture,
│           precision_work, notes }] }
└── returnConsiderations
```

#### 신체부담 평가 (ExposureForm + DiseaseSpecificFields + CervicalResultPanel)

**좌측 패널 — 입력 (ExposureForm + DiseaseSpecificFields):**
- 직업별 카드 내부에 해당 직업의 경추 상병 엔트리 카드들을 나열
- 노출 유형 선택 (어깨 하중 운반 / 비중립·정적 목 부하)
- 유형별 세부 입력: 하중(kg), 교대당 운반 시간, 목 굴곡 시간, 복합 자세, 정밀 작업 등

**우측 패널 — 결과 (CervicalResultPanel):**
- 직업별 → 상병별 요약: 노출 유형, 주요 flag pill, narrative 서술, 종합평가 문장

#### 계산 로직 (`computeCervicalCalc`) — Gate-and-Flag

```
각 diagnosisEntry에 대해:
  1) 노출 유형 확인: shoulder_heavy_load 또는 awkward_static_neck_load
  2) BK2109 하중 판정: load_weight_kg ≥ 40 → heavy_load_met
  3) 정적 목 부하 판정: neck_flexion_hours_per_day ≥ 1.5~2 → static_load_met
  4) narrative + conclusionText 자동 생성
  5) riskFactorItems 분리
```

#### 자동 상병 매핑

| 기준 | 추천 |
|------|------|
| ICD `^M50` | 경추 |
| ICD `^M48\.02` | 경추 |
| 상병명 `경추`/`목디스크`/`척수병`/`myelopathy` | 경추 |

---

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
  ※ F ≥ 1,900N인 작업만 합산 (남녀 공통 기준)

직업별 누적노출량:
  for each job in shared.jobs:
    jobTasks = tasks.filter(t => t.sharedJobId === job.id)
    jobDailyDose = calculateDailyDose(jobTasks)
    if jobDailyDose < 2.0kN·h AND 모든 작업의 F < 4,000N:
      해당 직업 평생 누적 제외 (excluded)
    else:
      jobLifetimeDose = jobDailyDose × 연간근무일수 × 해당직업 근무년수
  totalLifetimeDose = Σ(각 직업의 lifetimeDose)  (MN·h)

일일 노출 중증도:
  고도:     일일 >4kN·h 또는 최대압박력 ≥6,000N
  중등도상: 일일 >3kN·h 또는 최대압박력 ≥5,000N
  중등도하: 일일 ≥2kN·h 또는 최대압박력 ≥4,000N
  경도:     그 외
```

**4,000N 규칙:** 작업 중 하나라도 압박력 ≥ 4,000N이면 일일 누적 용량이 임계치(2.0 kN·h)에 미달하더라도 평생 누적 용량 계산에 포함된다.

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
│       ├── index.js
│       ├── WristEvaluation.jsx
│       ├── components/
│       │   ├── ExposureForm.jsx
│       │   ├── DiseaseSpecificFields.jsx
│       │   └── WristResultPanel.jsx
│       └── utils/
│           ├── data.js
│           ├── calculations.js
│           └── exportHandlers.js
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
| P1 | 고관절 모듈 | hip 모듈 추가 (플러그인 패턴 활용) |
| P2 | ~~척추 프리셋 연동~~ | ~~직업 프리셋 선택 시 MDDM 작업/변수 자동 채움~~ → v3.2.1 완료 (전 모듈 presetConfig 지원) |
| P2 | ~~EMR 데이터 추출~~ | ~~진료기록분석지/다학제회신 자동 추출~~ → v3.3.0 완료 |
| P2 | 통합 PDF/Word | 통합 보고서를 PDF/Word 형식으로도 출력 |
| P3 | 다중 사용자 | 서버 기반 데이터 저장 + 사용자 인증 |

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
  - `jobEvaluations[]` 2차원 구조 (팔꿈치/손목과 동일 패턴)
  - 경추간판 탈출증(M50), 경추 협착증(M48.02) 등 자동 상병 매핑
  - 종합소견에서 척추와 동일하게 좌우 구분 없는 축(Axial) 상병 처리
- **경추 프리셋 시스템 연동**: `presetConfig` — 공통 노출 7개 필드(`main_task_name`, `load_weight_kg`, `carry_hours_per_shift` 등) 추출/적용. `_pendingPreset` 대기 메커니즘으로 진단 엔트리 미생성 시 프리셋 보관 후 `syncCervicalModuleData` 시점에 적용
- **통합 미리보기/EMR/엑셀**: `genCervicalBurdenSection` / `buildCervicalExposureText` 추가 — `<경추(목)>` 섹션 자동 포함
- **모듈 아이콘 Windows 7 호환성 개선**: Unicode 6.0 이하 기호로 일괄 교체
  - 경추: 👤 (Bust in Silhouette) / 어깨: 🙆 (Person Gesturing OK) / 팔꿈치: 💪 (Flexed Biceps) / 요추: ⚕️ (유지)
- **프리셋 모달 크래시 수정**: `getPresetCategory`/`getPresetDescription`에 null 안전 처리 추가 — 프리셋 저장 버튼 클릭 시 빈 화면 TypeError 해결
- **프리셋 저장 정책 개선**: 직종명+카테고리+설명 기반 identity 저장, 유사 프리셋 키워드 매칭, 모듈별 비파괴 병합

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
