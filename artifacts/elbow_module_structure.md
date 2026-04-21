# 팔꿈치(Elbow) 모듈 구조 분석 및 스키마틱 정리

손목(Wrist) 모듈 개발의 벤치마크를 위해 기존 팔꿈치(Elbow) 모듈의 구조, 데이터 흐름, 컴포넌트 계층, 상태 관리 등을 도식화 및 요약한 문서입니다.

## 1. 파일 및 디렉토리 구조

팔꿈치 모듈은 `src/modules/elbow/` 아래에 독립적인 도메인 로직을 갖춘 모듈화된 형태로 구현되어 있습니다.

```text
src/modules/elbow/
├── index.js                     # 모듈 레지스트리 등록 (`registerModule`) 및 설정
├── ElbowEvaluation.jsx          # 메인 UI(루트 컴포넌트), 데이터 동기화 및 렌더링
├── components/                  # UI 컴포넌트 폴더
│   ├── ExposureForm.jsx         # 직업수(직력)마다 반복되는 폼 UI, 공통 노출 요인 입력
│   ├── DiseaseSpecificFields.jsx# BK 유형(질병코드)에 따른 세부 노출 요인 분기 입력 필드
│   └── ElbowResultPanel.jsx     # 시간적 선후관계 입력 및 최종 평가 결과/위험 요인 플래그(Flag) 렌더링
└── utils/                       # 비즈니스 로직, 상태 초기화, 계산 폴더
    ├── data.js                  # 상수 선언(Enum), 데이터 기본값 생성(Factory), 진단명 기반 형태 추론 로직, 상태 동기화(`syncElbowModuleData`)
    ├── calculations.js          # 위험도 평가 로직, `computeElbowCalc`, 상태별 플래그 추출 방식 정의
    └── exportHandlers.js        # 엑셀 다운로드 등 내보내기/리포팅 데이터 매핑 처리
```

## 2. 상태(State) 데이터 구조 (`moduleData`)

데이터는 사용자 직업(Job)과 진단서(Diagnosis)의 교차 배열(`jobEvaluations`)로 다뤄집니다. `moduleData` 객체가 `syncElbowModuleData` 함수를 거치며 기본정보 탭(shared)과 동기화됩니다.

```javascript
moduleData = {
  // 모듈의 공통 데이터 (모든 직업에서 공유하는 시간적 선후관계 등)
  temporalSequence: { 
    recent_task_change: '',      // 최근 작업 변화
    task_change_date: '',
    symptom_onset_interval: '',
    improves_with_rest: '',      // 휴식 시 호전 여부
  },
  
  // 직업 리스트 - 각 직업(Job) 단위로 평가 데이터를 격리
  jobEvaluations: [
    {
      sharedJobId: 'job-123',
      
      // 직업 내의 진단명(Diagnosis)별 평가 엔트리
      diagnosisEntries: [
        {
          diagnosisId: 'diag-456',
          selectedBkType: 'BK2101', // 추론/선택된 산재 상병 유형
          bkSelectionMode: 'auto', 
          
          /* --- 공통 핵심 노출 지표 --- */
          main_task_name: '드릴 작업',
          direct_anatomic_link: 'yes',
          exposure_types: ['repetition', 'force'], 
          daily_exposure_hours: 4,
          // ... 기타 공통 입력 필드 (days_per_week, work_pattern 등)
          
          /* --- 질환별 분기 지표 (BK-Specific) --- */
          // 선택된 selectedBkType에 따라 아래 필드 중 일부만 활성화 및 검증됨
          bk2101_cycle_seconds: 10,
          bk2101_monotony: 'yes',
          // bk2103_..., bk2105_..., bk2106_...
        }
      ]
    }
  ]
}
```

## 3. UI 및 컴포넌트 계층 구조 (Component Hierarchy)

`<ElbowEvaluation>`을 루트로 하여, **직업(Jobs) ➔ 진단별 분기(Diagnosis Entries)** 방향으로 폼(Form)이 전개됩니다.

- **`ElbowEvaluation`** (루트)
  - **Data Sync**: `useEffect`와 `syncElbowModuleData`를 활용하여 `shared.jobs` 혹은 `shared.diagnoses`가 추가/수정될 때마다 내부 상태인 `jobEvaluations`를 최신 상태로 유지(없는 건 만들고, 사라지면 지움).
  - List of **`ExposureForm`** (직업마다 1개씩 렌더링)
    - List of **`EntryCard`** (해당 직업 안에서, 해당하는 팔꿈치 상병코드 갯수만큼 렌더링)
      - 공통 노출(시간, 비중, 노출유형 등) 렌더링
      - **`DiseaseSpecificFields`**: 선택된 `selectedBkType`에 따라 동적으로 노출 세부 항목 필드 렌더러 변환
  - **`ElbowResultPanel`** (하단)
    - **`TemporalSequenceForm`**: 시간적 선후관계 입력 폼
    - 평가 결과(Narrative, RiskFlags, BurdenGrade) 요약 패널 

## 4. 데이터 플로우 & 생명주기 (Data Flow)

1. **초기화 및 동기화 (`data.js`)**
   - **`syncElbowModuleData()`**: 핵심 엔진입니다. 전역 상태(기본 정보 탭의 `sharedJobs`, `diagnoses`)를 가져와서 `moduleData` 배열과 1:1 구조를 맞춥니다.
   - **`inferElbowBkTypeFromDiagnosis()`**: 진단명이나 코드를 정규식으로 판별해 `BK2101`(테니스엘보), `BK2103`(박리성 등) 등을 자동 추론합니다.
2. **상태 업데이트 (`ElbowEvaluation.jsx`)**
   - UI에서 `onChangeEntry` 호출 ➔ 단일 diagnosisEntry를 패치(Patch)하여 부모로 전달 ➔ `App.jsx`에 있는 상태관리 시스템(`updateModule`)으로 상태 변경 적용.
3. **위험도 계산 (`calculations.js`)**
   - **`computeElbowCalc()`**: `moduleData`를 모두 읽어들여 직업별/진단명별로 플래그(위험 요인별 도달/미도달 상태)를 판독합니다.
   - **`computeDiagnosisFlags()`**: `daily_share_high`, `mechanical_load_dominant` 등의 규칙 기반 불리언 객체(`flags`)를 토해냅니다.
   - **`generateNarrative()`**: 작성된 객관적 지표들을 자연어(문장형 요약)로 포매팅하여 보여줍니다.
4. **결과 노출 (`calculations.js`의 FLAG_META)`**
   - 도출된 플래그 배열을 `FLAG_META`를 활용해 "Positive/Warning/Neutral" 색상 배지와 설명으로 뷰(Result Panel)에 출력.

## 5. 손목(Wrist) 모듈 개발을 위한 착안점 (Takeaways)

손목(Wrist) 모듈을 만들 땐 이 팔꿈치 모듈 코드를 통째로 베이스 템플릿으로 삼아 아래 항목을 집중적으로 치환 및 변형하게 됩니다.

1. **상병 체계 치환 (`data.js`)**: `BK2101`(팔꿈치) 대신 손목과 관련된 상병코드(`BK2102` 손목터널증후군, `BK2104` 건염 등)로 변경. `infer...` 정규식 로직 수정.
2. **분기 필드 및 데이터 명칭 변환**: `bk2101_cycle_seconds` -> `bk2102_cycle_seconds`와 같이 특정 상병에 맞춘 필드 이름 수정 및 UI폼(`DiseaseSpecificFields`) 교체.
3. **위험 평가 로직 변경 (`calculations.js`)**: 손목의 경우 '직접 압박(팔꿈치 대고 평면 작업)'보다 '꺾임(비중립 자세)', '핀치 그립(Pinch grip)', '진동 노출' 등이 핵심인 경우가 많습니다. 산재 인정 기준에 맞춘 조건문(`computeDiagnosisFlags`) 튜닝.
4. **공통 필드 프리셋(`index.js`)**: 직업(Job) 리스트에서 "손목 공통 노출"이라는 툴팁이나 프리셋 시스템을 별도로 구성합니다.

## 6. 플래그(Flag) 기반 위험도 판정 및 내러티브 생성 로직

입력된 정량/정성 데이터를 바탕으로 `calculations.js`의 `getElbowBurdenGrade`와 `getRiskFactorSentence` 함수에서 다음과 같이 위험도(Burden Grade)와 종합 결론 문장(Risk Factor Sentence)을 산출합니다.

### 6.1. 위험 요인(Risk Factor) 플래그 카운트
단순한 정보성 플래그(예: `core_exposure_unclear`, `temporal_fit_unclear`)는 제외하고, 실제 **부담을 가중시키는 핵심 위험 플래그** 14개(`RISK_FACTOR_FLAGS`)가 몇 개 발현되었는지를 합산하여 `riskFactorCount`를 구합니다.
주요 카운트 대상 플래그: `core_exposure_present`(핵심 노출), `daily_share_high/moderate`(노출 시간), `mechanical_load_dominant`(기계적 부담), `XXX_pattern_supported`(질병별 양상 부합 여부) 등.

### 6.2. 고도 부담 하이패스 (High Burden Gate)
점수에 상관없이 다음 3가지 핵심 조건이 **모두** 만족(`AND` 조건)되면 즉시 **'고도'** 부담으로 판정합니다 (`isHighBurdenGateSatisfied`):
1. `core_exposure_present` (핵심 노출 확인)
2. `daily_share_high` (일일 노출량 높음)
3. `hasBkPatternSupported` (해당 질환별 세부 양상 조건에 부합하는가)
=> **출력 문장**: *"핵심 노출 확인, 일일 노출량 높음, 질환별 패턴 지지 조건을 모두 만족하여 팔꿈치 부위 부담이 고도인 작업입니다."* 

### 6.3. 개수 기반 위험도(Burden Grade) 및 일반 문장 생성
위의 하이패스 조건에 해당하지 않을 경우, 순수하게 `riskFactorCount` 개수를 기준으로 판정합니다.
- **5개 이상**: 고도
- **3~4개**: 중등도
- **2개**: 경도
- **0~1개**: 부담 작업 아님

=> **출력 문장 (2개 이상)**: *"확인된 위험 요인이 [N]개로 팔꿈치 부위 부담이 [고도/중등도/경도]인 작업입니다."*
=> **출력 문장 (0~1개)**: *"확인된 위험 요인이 [N]개로 팔꿈치 부위 부담 작업이 아닙니다."*

## 7. 손목 관련 상병(BK2101, BK2103, BK2106) 특화 플래그 및 발현 조건

사용자 폼에서 입력받은 데이터를 기반으로 각 질환 유형별로 어떤 기준일 때 핵심 위험 플래그(패턴 지지)가 켜지는지(`computeDiagnosisFlags` 로직)를 정리했습니다. 손목 모듈 구축 시 이 로직이 직접적인 벤치마크 대상이 됩니다.

### 7.1. BK2101 (상과병변 / 부착부 건병증) ➔ [손목: 건염 계열에 대응]
반복과 힘이 복합될 때 부담이 가중되는 질환으로, **반복 동작(repetition)**과 다른 기계적 요인이 결합될 때 패턴 플래그가 켜집니다.
*   **추가 정보 플래그 `bk2101_high_freq_example`**: 시간당 반복 횟수가 10,000회 이상일 때 켜짐
*   **패턴 지지 플래그 `bk2101_pattern_supported`**: 
    1. 핵심 노출 유형에 `'repetition'(반복 동작)`이 포함되어 있고, (`AND`)
    2. 아래 조건 중 하나 이상을 만족할 때 (`OR`)
        * `force_level`(힘 사용)이 'moderate(중등도)' 또는 'high(고강도)'
        * `awkward_posture_level`(비중립 자세)이 'frequent(빈번)'
        * `static_holding_level`(단조로운 같은 자세 유지)이 'frequent(빈번)'
        * 강제적 손 배측굴곡(`bk2101_forced_dorsal_extension`) 여부가 'yes'
        * 반복/급작스러운 회내·회외(`bk2101_prosupination`) 여부가 'yes'

### 7.2. BK2103 (골관절염) ➔ [손목: 수근관절 등 관절염에 대응]
진동하는 공구 사용이 주된 요인인 질환입니다.
*   **패턴 지지 플래그 `bk2103_pattern_supported`**:
    *   `vibration_exposure`(진동 공구 노출)가 'present(있음)' 이고, 동시에 진동 공구 종류(`bk2103_vibration_tool_type`)를 1개 이상 선택했을 때 켜짐.
*   **위험 가중 플래그 `bk2103_transmission_amplifier_present`**: 
    *   공구를 강하게 쥐거나 누르는 작업(`bk2103_tool_pressing`)이 'yes' 이거나, 강하게 쥐는 동작(`bk2103_frequent_high_force_grip`)이 'yes'일 때 켜짐. (진동 전달이 증폭되는 상황)

### 7.3. BK2106 (주관증후군 / 단신경병증) ➔ [손목: 수근관증후군(CTS) 등에 대응]
반복적인 기계적 힘이나 강력한 꺾임, 그리고 주변부의 직접 압박/마찰이 주 요인인 신경 압박 질환입니다.
*   **패턴 지지 플래그 `bk2106_pattern_supported`**: 아래 조건 중 하나를 만족할 때 켜짐 (`OR`)
    1. `mechanical_load_dominant` (기계적 부담 우세)가 true일 때. (힘 사용이 중등도/고강도이거나, 비중립 자세가 빈번할 때)
    2. `static_holding_level`(특정 관절자세 장시간 유지)이 'frequent(빈번)'
    3. `direct_pressure_level`(직접 압박/마찰/충격)이 'frequent(빈번)'
