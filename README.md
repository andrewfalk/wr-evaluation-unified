# 직업성 질환 통합 평가 시스템 (wr-evaluation-unified)

> **Version:** 2.1.0 | **Status:** MVP 개발 완료 / Vercel 배포 완료

직업환경의학 전문의가 **업무상 질병 인정 여부를 판단**할 때 사용하는 통합 평가 도구.
무릎(슬관절)과 척추(요추 MDDM) 평가를 지원하며, 향후 고관절·어깨 등을 플러그인 형태로 확장할 수 있다.

## 기술 스택

| 영역 | 기술 |
|------|------|
| 프론트엔드 | React 18, CSS Variables (다크모드 지원) |
| 빌드 | Vite 5 |
| 데스크톱 | Electron 21 + electron-builder (NSIS) |
| 웹 배포 | Vercel (서버리스) |
| AI | Claude API (Vercel 서버리스 프록시 / Electron IPC) |
| 내보내기 | xlsx (엑셀), html2pdf.js (PDF), jszip |

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
vercel env add CLAUDE_API_KEY    # AI 분석용 API 키 설정
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
  tabs: [{ id: 'job', label: '신체부담 평가' }]
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
    │   ├── name, gender, height, weight, birthDate, injuryDate
    │   ├── hospitalName, department, doctorName
    │   ├── diagnoses[]            ← 상병 목록 { id, code, name, side }
    │   └── jobs[]                 ← 직업력 { id, jobName, startDate, endDate, ... }
    ├── modules
    │   ├── knee                   ← 무릎 전용 (jobExtras[], returnConsiderations)
    │   └── spine                  ← 척추 전용 (tasks[])
    └── activeModules: ['knee', 'spine']
```

## UI 흐름 (위자드)

```
[공유] 기본정보 → 상병 입력 → 모듈 선택
[무릎] 🦵 신체부담 평가
[척추] 🦴 신체부담 평가
[공유] 종합소견 → AI 분석
```

### 종합소견

좌우 2패널 레이아웃:
- **좌측**: 상병별 상태 확인 및 업무관련성 평가 (무릎: KLG/좌우 구분, 척추: 구분 없음)
- **우측**: 전체 모듈 결과 통합 미리보기

## 평가 모듈

### 무릎 모듈 (knee)

한국 산재보상보험법 근골격계 질환 업무관련성 평가 기준 적용.

- **입력**: 쪼그려앉기 시간, 중량물 무게, 보조변수 6개
- **결과**: 신체부담기여도(%), 누적신체부담 판정, 직종별 부담등급 (고도/중등도상/중등도하/경도)

### 척추 모듈 (spine)

MDDM (Mainz-Dortmund Dose Model) 독일 직업성 요추 질환 평가 모델 적용.

- **입력**: 작업 자세 G1~G11 (들기/운반/들고 있기 3개 카테고리), 중량물 무게, 빈도, 시간, 보정계수
- **결과**: 최대 압박력(N), 일일 누적 용량(kN·h), 평생 누적 용량(MN·h), 업무관련성 등급

| 기준 | 남성 | 여성 |
|------|------|------|
| DWS2 연구 기준 | 7.0 MN·h | 3.0 MN·h |
| 독일 법원 기준 | 12.5 MN·h | 8.5 MN·h |
| MDDM 기준 | 25 MN·h | 17 MN·h |

## AI 분석

통합 AI 분석 탭에서 전체 평가 데이터를 Claude API에 전송하여 전문의 관점의 분석 결과를 제공.

| 플랫폼 | 경로 | API 키 관리 |
|--------|------|-------------|
| 웹 (Vercel) | `POST /api/analyze` → 서버리스 | 서버 환경변수 `CLAUDE_API_KEY` |
| Electron | `window.electron.analyzeAI()` → IPC | 사용자 입력 키 (설정) |

## 내보내기

| 모드 | 출력 |
|------|------|
| 현재 환자 | 단일 `.xlsx` 파일 |
| 선택 환자 | `.zip` (선택된 환자별 `.xlsx`) |
| 전체 환자 | `.zip` (전체 환자별 `.xlsx`) |
| PDF | 보고서 미리보기 영역 PDF 변환 |

일괄 Import: 엑셀 파일에서 복수 환자 일괄 등록 (드래그 앤 드롭 지원)

## 디렉토리 구조

```
src/
├── App.jsx                          # 메인 앱 (위자드 로직, 상태 관리)
├── index.css                        # 글로벌 스타일 (CSS Variables)
├── core/                            # 공유 프레임워크
│   ├── moduleRegistry.js           # 모듈 등록/조회 API
│   ├── components/                 # BasicInfoForm, DiagnosisForm, AssessmentStep,
│   │                               # AIAnalysisPanel, BatchImportModal, SettingsModal 등
│   ├── hooks/                      # useAIAnalysis, usePatientList
│   └── utils/                      # data, diagnosisMapping, reportGenerator,
│                                   # exportService, storage, platform 등
├── modules/
│   ├── knee/                       # 무릎 모듈
│   │   ├── components/             # JobTab, KneeResultPanel, AssessmentTab
│   │   └── utils/                  # calculations, data, exportHandlers
│   └── spine/                      # 척추 모듈
│       ├── components/             # TaskManager, TaskEditor, SpineResultPanel
│       └── utils/                  # calculations, formulaDB, thresholds, data
api/analyze.js                       # Vercel 서버리스 (Claude API 프록시)
electron/                            # main.js + preload.js (IPC 기반 AI 호출)
public/images/                       # G1~G11 자세 이미지
```

## 상병 자동 매핑

ICD 코드 기반 모듈 자동 추천:

| ICD 코드 패턴 | 추천 모듈 |
|---------------|-----------|
| M17, M22, M23, M70.4, M76.5, S83 | 무릎 (knee) |
| M51, M54, M47, M48, M50, M53 | 척추 (spine) |

## 향후 로드맵

| 우선순위 | 항목 | 설명 |
|----------|------|------|
| P1 | 고관절 모듈 | hip 모듈 추가 (플러그인 패턴 활용) |
| P1 | 어깨 모듈 | shoulder 모듈 추가 |
| P2 | 척추 프리셋 연동 | 직업 프리셋 선택 시 MDDM 작업/변수 자동 채움 |
| P2 | 통합 PDF/Word | 통합 보고서를 PDF/Word 형식으로도 출력 |
| P3 | 다중 사용자 | 서버 기반 데이터 저장 + 사용자 인증 |

---

상세 PRD는 [docs/PRD.md](docs/PRD.md)를 참고하세요.
