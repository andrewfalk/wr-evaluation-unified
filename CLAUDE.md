# 직업성 질환 통합 평가 시스템 (wr-evaluation-unified)

## 프로젝트 개요
직업환경의학 전문의를 위한 통합 평가 도구. 무릎(슬관절) + 팔꿈치(BK2101/2103/2105/2106) + 어깨(BK2117) + 척추(MDDM) 평가를 모듈식으로 결합.
향후 고관절 등 추가 예정 → 플러그인 아키텍처.

- **기술 스택**: React 18 + Vite 5 + CSS Variables
- **배포**: 웹(Vercel) + 데스크톱(Electron) 동시 지원
- **원본 소스**: `mddm-vercel` (척추, Vanilla JS → React 마이그레이션), `wr-evaluation-claude` (무릎, React)

## 빌드 & 실행

```bash
npm run dev              # 개발 서버 (Vite, localhost:3000)
npm run build:web        # 웹 빌드 → dist/web/
npm run build:electron   # Electron 빌드 → dist/electron/
npm run electron:dev     # Electron 개발 실행
npm run electron:build   # Electron 패키징 (electron-builder)
vercel deploy            # Vercel 배포
```

## 디렉토리 구조

```
src/
├── core/                    # 공유 프레임워크
│   ├── moduleRegistry.js    # registerModule(), getModule(), getAllModules()
│   ├── components/          # BasicInfoForm, DiagnosisForm, AIAnalysisPanel, PresetSearch, PresetManageModal, Dashboard, BatchImportModal, SettingsModal
│   ├── hooks/               # useAIAnalysis (web/electron 자동 분기), usePatientList
│   ├── services/            # presetRepository (프리셋 CRUD, builtin+custom 병합)
│   └── utils/               # storage, platform, common, data
├── modules/
│   ├── knee/                # 무릎 모듈 (KneeEvaluation, JobTab, AssessmentTab, KneeResultPanel)
│   ├── shoulder/            # 어깨 모듈 (ShoulderEvaluation, JobTab, ShoulderResultPanel)
│   ├── elbow/               # 팔꿈치 모듈 (ElbowEvaluation, ExposureForm, ElbowResultPanel)
│   └── spine/               # 척추 MDDM 모듈 (SpineEvaluation, TaskManager, TaskEditor, ResultDashboard)
api/analyze.js               # Vercel 서버리스 (Gemini/Claude API 프록시)
electron/                    # main.js + preload.js + emr-helper/ (IPC: AI 호출 + EMR 연동)
```

## 모듈 추가 방법

`src/modules/<name>/index.js`에서 `registerModule()` 호출:

```javascript
import { registerModule } from '../../core/moduleRegistry';
registerModule({
  id: 'new-module',
  name: '표시 이름',
  icon: '아이콘',
  description: '설명',
  createModuleData: () => ({ /* 초기 데이터 */ }),
  EvaluationComponent: MyComponent,
  computeCalc: computeFn,
  isComplete: checkFn,
  exportHandlers: { excelSingle: exportFn },
  presetConfig: {                          // 프리셋 시스템 연동 (선택)
    label: '프리셋 표시명',
    fields: [{ key: 'fieldKey', label: '라벨', type: 'number' }],
    extractFromModule(moduleData, sharedJobId) { /* → 프리셋 데이터 */ },
    applyToModule(moduleData, sharedJobId, presetData) { /* → 수정된 moduleData */ },
  },
});
```

그리고 `src/App.jsx`에서 `import './modules/<name>'` 추가.

## 데이터 모델

```javascript
Patient = {
  id, phase,
  data: {
    shared: { patientNo, name, gender, height, weight, birthDate, injuryDate, evaluationDate,
              hospitalName, department, doctorName, specialNotes, diagnoses[], jobs[],
              medicalRecord, highBloodPressure, diabetes, visitHistory,
              consultReplyOrtho, consultReplyNeuro, consultReplyRehab, consultReplyOther },
    modules: { knee: {}, shoulder: {}, elbow: {}, spine: {} },
    activeModules: ['knee', 'spine', ...]
  }
}
```

## AI API 분기

- **웹**: `fetch('/api/analyze')` → Vercel 서버리스 → Gemini(기본)/Claude API (서버 환경변수 GEMINI_API_KEY / CLAUDE_API_KEY)
- **Electron**: `window.electron.analyzeAI()` → IPC → main process → 직접 Gemini/Claude API (사용자 입력 키)
- 분기 로직: `src/core/hooks/useAIAnalysis.js`

## 주의사항

- localStorage 키 접두사: `wrEvalUnified`
- 자세 이미지: `public/images/` (G1-G11)
- 직업 프리셋: `public/job-presets.json`
- index.html은 프로젝트 루트에 위치 (Vite 요구사항)

## 코드 탐색 · 수정 원칙 (토큰 절약)

코드를 읽거나 수정하기 전 반드시 다음 순서를 따를 것:

1. **사전 보고**: 그래프를 쓸지 말지, 이유를 한 줄로 먼저 알릴 것
   - 예: "그래프로 `callers_of` 확인 후 해당 라인만 읽겠습니다"
   - 예: "위치가 명확해서 Grep으로 바로 가겠습니다"
2. **그래프 우선**: code-review-graph MCP(`file_summary`, `callers_of`, `importers_of` 등)로 대상 함수/노드의 파일·행 번호를 먼저 특정
3. **부분 Read**: `offset` / `limit`으로 필요한 범위만 읽을 것 — **파일 전체 Read 금지**
   - 예외: 파일이 매우 짧거나 전체를 재작성해야 하는 경우
4. **매번 보고**: 그래프를 읽었는지·안 읽었는지, 왜 그랬는지 매 작업마다 명시

