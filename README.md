# 직업성 질환 통합 평가 시스템 (wr-evaluation-unified)

> **Version:** 3.3.0 | **Status:** MVP 개발 완료 / Vercel 배포 완료

직업환경의학 전문의가 **업무상 질병 인정 여부를 판단**할 때 사용하는 통합 평가 도구.
무릎(슬관절), 척추(요추 MDDM), 팔꿈치(주관절 BK2101/2103/2105/2106), 어깨(견관절 BK2117) 평가를 지원하며, 향후 고관절 등을 플러그인 형태로 확장할 수 있다.

## 기술 스택

| 영역 | 기술 |
|------|------|
| 프론트엔드 | React 18, CSS Variables (다크모드 지원) |
| 빌드 | Vite 5 |
| 데스크톱 | Electron 21 + electron-builder (NSIS) |
| 웹 배포 | Vercel (서버리스) |
| AI | Google Gemini API (기본) + Claude API (Vercel 서버리스 / Electron IPC) |
| 내보내기 | xlsx (엑셀), html2pdf.js (PDF), jszip |
| 폰트 | Pretendard (CDN), Noto Sans KR (fallback) |

## 빌드 & 실행

```bash
npm install               # 의존성 설치
npm run dev               # 개발 서버 (localhost:3000)
npm run build:web         # 웹 빌드 → dist/web/
npm run build:electron    # Electron 빌드 → dist/electron/
npm run electron:dev      # Electron 개발 실행
npm run electron:build    # Electron 패키징 (NSIS, Windows)
```

### Vercel 배포

```bash
npm i -g vercel
vercel login
vercel --prod --scope <your-scope>
vercel env add GEMINI_API_KEY    # Gemini AI 분석용 (기본)
vercel env add CLAUDE_API_KEY    # Claude AI 분석용 (선택)
```

## 핵심 아키텍처

### 플러그인 모듈 시스템

각 평가 모듈은 `src/modules/<name>/index.js`에서 `registerModule()`을 호출하여 자기 자신을 등록한다.

```javascript
registerModule({
  id: 'knee',
  name: '무릎 (슬관절)',
  icon: '🦵',
  EvaluationComponent,    // 메인 UI 컴포넌트
  createModuleData,       // 초기 데이터 팩토리
  computeCalc,            // 계산/점수 산출 함수
  isComplete,             // 완료 판정 함수
  exportHandlers,         // 내보내기 핸들러
  tabs: [{ id: 'job', label: '신체부담 평가' }],
  presetConfig: {         // 프리셋 시스템 연동 (선택)
    label, fields,
    extractFromModule(moduleData, sharedJobId) { ... },
    applyToModule(moduleData, sharedJobId, presetData) { ... },
  },
});
```

**새 모듈 추가:**
1. `src/modules/<name>/` 디렉토리 생성
2. `index.js`에서 `registerModule()` 호출
3. `src/App.jsx`에 `import './modules/<name>'` 한 줄 추가
4. (선택) `src/core/utils/diagnosisMapping.js`에 ICD 코드 매핑 추가

### 데이터 모델

```
Patient
├── id, phase
└── data
    ├── shared                     ← 모듈 공통
    │   ├── patientNo, name, gender, height, weight, birthDate, injuryDate
    │   ├── hospitalName, department, doctorName
    │   ├── medicalRecord, highBloodPressure, diabetes, visitHistory
    │   ├── consultReplyOrtho/Neuro/Rehab/Other  ← 다학제 회신
    │   ├── diagnoses[]            ← 상병 목록 { id, code, name, side }
    │   └── jobs[]                 ← 직업력 { id, jobName, startDate, endDate, ... }
    ├── modules
    │   ├── knee                   ← 무릎 전용 (jobExtras[], returnConsiderations)
    │   ├── shoulder               ← 어깨 전용 (jobExtras[], returnConsiderations)
    │   ├── elbow                  ← 팔꿈치 전용 (jobEvaluations[], temporalSequence)
    │   └── spine                  ← 척추 전용 (tasks[] — sharedJobId로 직업 연결)
    └── activeModules: ['knee', 'spine', 'shoulder', 'elbow']
```

## UI 흐름 (위자드)

```
[공유] 기본정보 → 상병 입력 → 모듈 선택
[무릎] 🦵 신체부담 평가
[팔꿈치] 🦾 신체부담 평가
[어깨] 💪 신체부담 평가
[척추] 🦴 신체부담 평가
[공유] 종합소견 → AI 분석
```

### 종합소견

좌우 2패널 레이아웃:
- **좌측**: 상병별 상태 확인 및 업무관련성 평가 (무릎: KLG/좌우 구분, 어깨: Ellman Class/좌우 구분, 팔꿈치: BK 유형 자동 제안/수동 + 공통 시간적 선후관계, 척추: 수직분포원리/동반성 척추증 확인 + 업무관련성)
- **우측**: 전체 모듈 결과 통합 미리보기

## 평가 모듈

### 무릎 모듈 (knee)

한국 산재보상보험법 근골격계 질환 업무관련성 평가 기준 적용.

- **입력**: 쪼그려앉기 시간, 중량물 무게, 보조변수 6개
- **결과**: 신체부담기여도(%), 누적신체부담 판정, 직종별 부담등급 (고도/중등도상/중등도하/경도)

### 팔꿈치 모듈 (elbow)

독일 산재보험 BK2101/2103/2105/2106 기반 공통 신체부담 평가. 임계값/스코어가 아닌 **Gate-and-Flag 판정** 방식.

| BK 유형 | 질환 |
|---------|------|
| BK2101 | 상과병변 / 부착부 건병증 |
| BK2103 | 팔꿈치 골관절염 / 박리성 골연골염 |
| BK2105 | 팔꿈치 점액낭염 |
| BK2106 | 주관증후군 / 척골신경병변 |

- **데이터 구조**: `jobEvaluations[]` (직업 × 상병 2차원 entry) + 모듈 전체 공통 `temporalSequence` 1회 입력
- **자동 BK 매핑**: ICD(M77.0/M77.1/T75.2) + 상병명 키워드(상과염, 테니스·골프엘보, 주관증후군, 점액낭염, 진동성 팔꿈치 관절병증). 수동 선택 지원(`bkSelectionMode: auto | manual`)
- **입력**: 핵심 동작 연결성, 공통 노출유형(반복/힘/비중립 자세), 1일 노출시간, 하루 작업 비중, 작업 형태, 휴식 분포, BK 분기별 세부 필드
- **판정**: 공통 필수 입력 게이트 통과 시 15+ flag(daily_share_high/moderate/low, rest_unfavorable, core_exposure_present, BK별 pattern_supported, temporal_fit_high 등). `work_pattern === 'continuous'` 시 daily_share 임계값 상향(1.5h/20% vs 3h/40%)
- **결과**: 상병별 위험 요인 목록 + narrative 서술 + 종합평가 문장

### 어깨 모듈 (shoulder)

독일 직업병 BK2117 기준 — 어깨 근골격계 질환 누적 노출 평가.

- **입력**: 오버헤드 작업, 반복동작(중간/고도), 중량물 취급(횟수+시간), 손-팔 진동 (각 직업별 일일 노출량)
- **계산**: 일일노출 × 연간근무일수 × 근무년수 → 직력 전체 누적시간 합산
- **결과**: 5개 노출 유형별 BK2117 임계값 대비 누적시간/비율 비교
- **누적 신체부담 판정**: 임계값 초과 항목이 1개 이상이면 "충분", 초과 없이 50%↑ ≥3개 또는 75%↑ ≥2개이면 "복합 노출 고려 충분", 그 외 "불충분"

| 노출 유형 | 임계값 |
|-----------|--------|
| 오버헤드 작업 | 3,600시간 |
| 반복동작 중간속도 | 38,000시간 |
| 반복동작 고도 | 9,400시간 |
| 중량물(≥20kg) | 200시간 |
| 손-팔 진동 | 5,300시간 |

### 척추 모듈 (spine)

MDDM (Mainz-Dortmund Dose Model) 독일 직업성 요추 질환 평가 모델 적용.

- **입력**: 작업 자세 G1~G11 (들기/운반/들고 있기 3개 카테고리), 중량물 무게, 빈도, 시간, 보정계수
- **직업별 관리**: 2개 이상 직업 시 직업별 탭으로 작업 분리, 각 직업별 일일선량/누적선량 개별 산출 후 합산
- **압박력 최소 기준**: 남녀 공통 1,900N (기준 미만 작업은 일일 선량 제외)
- **4,000N 규칙**: 작업 중 하나라도 압박력 ≥ 4,000N이면 일일 누적 용량 임계치(2.0 kN·h) 미만이어도 평생 누적 용량 계산에 포함
- **일일 노출 중증도**: 고도(일 >4kN·h 또는 최대 ≥6kN) / 중등도상(>3kN·h 또는 ≥5kN) / 중등도하(≥2kN·h 또는 ≥4kN) / 경도
- **종합소견**: 수직분포원리(확인/미확인) + 동반성 척추증(확인/미확인) 드롭다운
- **결과**: 최대 압박력(N), 일일 누적 용량(kN·h) + 중증도, 평생 누적 용량(MN·h), 직업별 누적선량 내역, 업무관련성 등급

| 기준 | 남성 | 여성 |
|------|------|------|
| DWS2 연구 기준 | 7.0 MN·h | 3.0 MN·h |
| 독일 법원 기준 | 12.5 MN·h | 8.5 MN·h |
| MDDM 기준 | 25 MN·h | 17 MN·h |

## AI 분석

통합 AI 분석 탭에서 **Google Gemini**(기본) 또는 **Anthropic Claude**를 선택하여 분석.

| 모델 | 특징 |
|------|------|
| Gemini 2.5 Flash (기본) | 빠름/저비용 |
| Gemini 2.5 Pro | 정밀 (thinking 기능 내장) |
| Claude Haiku 4.5 | 빠름/저비용 |
| Claude Sonnet 4.6 | 정밀 |

| 플랫폼 | 경로 | API 키 관리 |
|--------|------|-------------|
| 웹 (Vercel) | `POST /api/analyze` → 서버리스 | 서버 환경변수 `GEMINI_API_KEY` / `CLAUDE_API_KEY` |
| Electron | `window.electron.analyzeAI()` → IPC | 사용자 입력 키 (설정 모달) |

## 내보내기

각 Excel 버튼(현재/선택/전체)은 드롭다운으로 형식 선택 가능:

| 형식 | 모드 | 출력 |
|------|------|------|
| **EMR 형식** | 현재/선택/전체 | EMR 소견서 `.xlsx` (선택/전체는 `.zip`) |
| **일괄입력용** | 현재/선택/전체 | flat table `.xlsx` (75열, roundtrip 지원) |
| PDF | - | 보고서 미리보기 영역 PDF 변환 |

일괄 Import: 엑셀 파일에서 복수 환자 일괄 등록 (드래그 앤 드롭, 무릎+어깨+척추 작업+팔꿈치 BK 엔트리+등록일 포함)

## 디렉토리 구조

```
src/
├── App.jsx                          # 메인 앱 (위자드 로직, 상태 관리)
├── index.css                        # 글로벌 스타일 (CSS Variables)
├── core/                            # 공유 프레임워크
│   ├── moduleRegistry.js           # 모듈 등록/조회 API
│   ├── components/                 # BasicInfoForm, DiagnosisForm, AssessmentStep,
│   │                               # AIAnalysisPanel, PresetSearch, PresetManageModal,
│   │                               # BatchImportModal, SettingsModal 등
│   ├── hooks/                      # useAIAnalysis, usePatientList
│   ├── services/                   # presetRepository (프리셋 CRUD, builtin+custom 병합)
│   └── utils/                      # data, diagnosisMapping, reportGenerator,
│                                   # exportService, storage, platform 등
├── modules/
│   ├── knee/                       # 무릎 모듈
│   │   ├── components/             # JobTab, KneeResultPanel, AssessmentTab
│   │   └── utils/                  # calculations, data, exportHandlers
│   ├── spine/                      # 척추 모듈
│   │   ├── components/             # TaskManager, TaskEditor, SpineResultPanel
│   │   └── utils/                  # calculations, formulaDB, thresholds, data
│   ├── shoulder/                   # 어깨 모듈 (BK2117)
│   │   ├── components/             # JobTab, ShoulderResultPanel
│   │   └── utils/                  # calculations, data, exportHandlers
│   └── elbow/                      # 팔꿈치 모듈 (BK2101/2103/2105/2106)
│       ├── ElbowEvaluation.jsx
│       ├── components/             # ExposureForm, DiseaseSpecificFields, ElbowResultPanel
│       └── utils/                  # calculations, data, exportHandlers
api/analyze.js                       # Vercel 서버리스 (Gemini/Claude API 프록시)
electron/                            # main.js + preload.js (IPC 기반 AI 호출)
public/images/                       # G1~G11 자세 이미지
```

## 상병 자동 매핑

ICD 코드 기반 모듈 자동 추천:

| ICD 코드 패턴 | 추천 모듈 |
|---------------|-----------|
| M17, M22, M23, M70.4, M76.5, S83 | 무릎 (knee) |
| M77.0, M77.1, T75.2 | 팔꿈치 (elbow) |
| M75, S43, S46, M19.01 | 어깨 (shoulder) |
| M51, M54, M47, M48, M50, M53 | 척추 (spine) |

## 향후 로드맵

| 우선순위 | 항목 | 설명 |
|----------|------|------|
| P1 | 고관절 모듈 | hip 모듈 추가 (플러그인 패턴 활용) |
| P2 | ~~척추 프리셋 연동~~ | ~~직업 프리셋 선택 시 MDDM 작업/변수 자동 채움~~ → v3.2.1 완료 |
| P2 | ~~EMR 데이터 추출~~ | ~~진료기록분석지/다학제회신 자동 추출~~ → v3.3.0 완료 |
| P2 | 통합 PDF/Word | 통합 보고서를 PDF/Word 형식으로도 출력 |
| P3 | 다중 사용자 | 서버 기반 데이터 저장 + 사용자 인증 |

---

## 변경 이력

### v3.3.0 (2026-04-20)
- **EMR 데이터 추출 (Electron)**: `EmrHelper.cs`에 진료기록분석지(`--extract-record`) / 다학제회신(`--extract-consultation`) 추출 모드 추가. IE COM 자동화로 환자명, 생년월일, 재해일자, 진료기록, 기저질환, 수진이력, 상병 목록, 과별 회신 자동 읽기
- **EMR 일괄 추출 UI**: 선택된 환자 또는 현재 환자의 환자등록번호 기반 순차 추출 + 프로그레스 바. patientNo 교차검증 포함
- **다학제 회신 추출/입력**: `다학제 추출` 버튼으로 과별 회신 읽기 → `다학제 보내기` 버튼으로 EMR 종합소견 2,3번 칸에 입력
- **환자등록번호 (`patientNo`)**: 기본정보 입력, 대시보드 테이블, 일괄 Import에 등록번호 컬럼 추가
- **EMR 연동 데이터 섹션**: 기본정보 사이드패널에 진료기록/기저질환(고혈압·당뇨)/수진이력 입력 섹션 추가 (섹션 3)
- **다학제 회신 섹션**: 정형외과/신경외과/재활의학과/기타 4과 회신 입력 (섹션 4). AutoResizeTextarea 적용
- **EMR 소견서 확장**: 개인적 요인에 고혈압/당뇨/수진이력 포함, 진료기록 필드(`txtMrecMedPovCont`) 직접입력 지원, 다학제 회신 요약을 종합소견 엑셀에 포함
- **팔꿈치 프리셋 지원**: 공통 노출 10개 필드 추출/적용, `_pendingPreset` 대기 메커니즘
- **모듈 jobExtras 자동 생성**: 무릎/어깨 직업 추가 시 자동 생성, 척추 미귀속 태스크 폴백
- **프리셋 내보내기/가져오기 개선**: 커스텀 프리셋만 정제 내보내기, category/description 보존
- **일괄 Import 필드 그룹 세분화**: 직업/무릎/어깨/척추/팔꿈치 공통/팔꿈치 BK별 6개 그룹으로 분리
- **EmrHelper 공통 래퍼**: `runHelper()` 함수로 EMR 헬퍼 실행 경로/타임아웃/에러 처리 통합

### v3.2.1 (2026-04-16)
- **커스텀 프리셋 생성/저장**: `PresetManageModal` — 현재 입력된 신체부담 데이터를 프리셋으로 저장. 모듈별 선택, 데이터 미리보기, 커스텀 프리셋 삭제 지원
- **프리셋 저장소 신설**: `presetRepository.js` — builtin(`job-presets.json`) + custom(localStorage/Electron FS) 이중 저장소, 병합 로드, JSON 내보내기/가져오기
- **전 모듈 presetConfig 지원**: 무릎(8개 필드), 어깨(6개 노출량), 척추(작업 배열 교체) — 각 모듈이 `extractFromModule`/`applyToModule` 계약으로 프리셋 시스템 연동
- **프리셋 검색 개선**: 모듈 배지 표시, 커스텀 프리셋 태그, 검색 결과 10개 확장
- **중복 저장 방지**: id + jobName 이중 매칭

### v3.2.0 (2026-04-16)
- **팔꿈치(주관절) 모듈 신설**: `src/modules/elbow/` — BK2101/2103/2105/2106 4유형 분기, Gate-and-Flag 판정, 공통 시간적 선후관계(모듈 전체 1회 입력), 직업 × 상병 2차원 `jobEvaluations[]` 구조
- **자동 BK 매핑**: ICD(M77.0, M77.1, T75.2) + 상병명 키워드(상과염/테니스·골프엘보/주관증후군/점액낭염/진동성 팔꿈치 관절병증). 수동 선택(`bkSelectionMode: auto | manual`) 지원
- **`work_pattern` 수식자**: `continuous` 시 daily_share 임계값 상향(1.5h/20% vs 3h/40%), rest_unfavorable이 `moderate` 휴식에서도 활성화
- **팔꿈치 결과**: ElbowResultPanel — 공통 시간적 선후관계 flag + 직업/상병별 Summary Card(BK 라벨, flag pill, narrative, 종합평가 문장)
- **팔꿈치 내보내기**: EMR 소견서 단일 시트 B5~B9 7행 구조(`excelSingle`) + html2pdf 기반 PDF
- **통합 미리보기**: `genElbowBurdenSection` 추가(`< 팔꿈치(주관절) >` 섹션). 척추 섹션은 helper 함수로 리팩터링되어 DWS2/법원/MDDM tiered 해석 문장 자동 생성
- **일괄입력용 서식 확장**: 팔꿈치 시간적 선후관계 4열 + BK 엔트리 27열(BK유형/선택방식/문제작업명/핵심동작/공통노출/세부지표 16열 + BK 분기 11열) 추가 → **총 75열**
- **복귀 고려사항 공유**: knee/shoulder/elbow 3개 모듈이 `returnConsiderations`를 공유하도록 fallback 확장
- **척추 압박력 기준 변경**: 남 2,700N / 여 2,000N → 남녀 공통 1,900N. 작업 압박력 ≥4,000N이면 일일 용량 임계치 미만이어도 평생 누적 포함
- **척추 일일 노출 중증도 표시**: 미리보기/엑셀에 일일 노출량 뒤 고도/중등도상/중등도하/경도 4단계 표시
- **척추 종합소견 드롭다운**: 수직분포원리(확인/미확인) + 동반성 척추증(확인/미확인)
- **어깨 누적 신체부담 판정**: 미리보기/엑셀/PDF에 BK2117 설명문 + 3단 해석(초과→충분, 복합노출→충분, 미달→불충분)
- **대시보드 개선**: 모듈 사용 카드 2×2 그리드(모듈별 개별 색상), 평균 처리일수 단위 인라인, 척추→허리 라벨 변경

### v3.1.0 (2026-04-04)
- **EMR 직접입력 개선**: C# EmrHelper를 reflection 기반 COM 접근으로 전면 재작성 — `dynamic` 키워드 제거, `[STAThread]` 추가, IHTMLDocument2 단일 시도로 lResult 소모 문제 해결, `--diagnose` 모드 추가
- **보안 하드닝**: Gemini API 키를 URL 쿼리에서 `x-goog-api-key` 헤더로 전환, CORS 오리진 허용 목록 적용(`*` 제거), IPC 경로 순회 방어(`sanitizeId`), `netRequest()` HTTP 상태코드 검사 추가
- **상태/UX 안정화**: Electron 메뉴 리스너 cleanup 추가, `handleStartIntake` stale closure 수정(useRef 패턴), 모듈 스텝 인덱스 동적 계산(하드코딩 `3` 제거), 단일 환자 삭제 시 확인 대화상자
- **저장 안정성**: 저장 snapshot ID를 `Date.now()` → `crypto.randomUUID()`로 변경, localStorage `QuotaExceededError` 처리(`safeSetItem` 래퍼)
- **빌드 정리**: EmrHelper 단일 빌드로 통합(x86/x64 이중 빌드 제거)

### v3.0.0 (2026-03-30)
- **어깨(견관절) 모듈 신설**: BK2117 독일 직업병 기준 누적 노출 평가 — 5개 노출 유형(오버헤드, 반복동작 중간/고도, 중량물, 진동) 직력 전체 누적 계산
- **중량물 입력 방식**: 횟수(회/일) + 시간(초/회) 분리 입력 → 내부 시간(시간/일) 자동 환산
- **어깨 종합소견**: Ellman Class(Grade 1/2/3/Full) 입력 + 상병별 좌/우 업무관련성 평가
- **종합소견 / 미리보기**: 어깨·척추 신체부담 섹션 추가 (기존에 무릎 섹션만 있던 문제 수정)
- **상병 자동 매핑**: 어깨 ICD 코드(M75 등) + 견관절/회전근개 등 키워드 추가
- **일괄입력용 서식**: 어깨 노출 6열 추가 → 44열
- **대시보드 개선**: 요약 카드 숫자 색상 구분 (총 환자/완료/진행 중/모듈), 모듈명 간소화

### v2.5.0 (2026-03-28)
- **대시보드 신설**: 현재 환자 목록 기반 통계(요약 카드, 월별 차트, 최근 활동 테이블) — 환자 이름 클릭 시 편집 화면으로 즉시 이동
- **등록일/평가일 분리**: `createdAt`(등록) / `updatedAt`(마지막 수정) / `evaluationDate`(평가 완료) 명확히 구분
- **목록 초기화**: 대시보드 및 메인 헤더에서 현재 환자 목록 전체 초기화
- **일괄 입력 등록일 컬럼 지원**: `등록일`/`접수일` 열 인식 (37열)
- **Electron 파일 기반 저장소**: 환자별 개별 JSON 파일(`{userData}/wr-eval-data/`) → localStorage 5-10MB 제한 극복, 수천 명 이상 관리 가능. 웹은 기존 localStorage 유지
- **앱 타이틀 변경**: "근골격계 질환 업무관련성 평가 및 소견서 작성 도우미"
- **홍길동 자동 입력 제거**: 첫 실행 시 예시 환자 자동 생성 삭제 (테스트 데이터 버튼은 유지)

### v2.4.1 (2026-03-26)
- **Electron IPC 복구**: preload.js의 `require('../package.json')` asar 경로 버그 수정 → 모든 IPC 기능 정상화
- **구버전 데이터 임포트**: LevelDB 파싱 + 마이그레이션 UI, 구버전 통합용 xlsx 내보내기 추가
- **다크모드 전면 개선**: 테두리 대비 강화, 시맨틱 색상 변수 도입, 하드코딩 색상 제거
- **KLG 등급 UI 컴팩트화**: 상병명 헤더 우측 인라인 드롭다운으로 축소
- **EMR 종합소견(b8) 개선**: 무릎 신체부담 데이터 + 참고문헌 삽입

상세 PRD는 [docs/PRD.md](docs/PRD.md)를 참고하세요.
