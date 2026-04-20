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

## AI 협업 워크플로

- 기본 협업 규칙은 `docs/AI_AGENT_WORKFLOW.md`를 따른다.
- 실질적인 코드 변경이 발생하면 메인 에이전트가 구현 후 리뷰 전용 하위 에이전트를 분기할 수 있다.
- 변경 영향이 넓거나 실행 검증이 중요하면 검증 전용 하위 에이전트를 추가로 분기할 수 있다.
- 리뷰 하위 에이전트는 읽기 전용이며, 버그/회귀/데이터 손실/검증 누락만 본다.
- 검증 하위 에이전트는 빌드, 테스트, 스모크 체크 같은 실행 검증만 담당한다.
- 최종 리뷰 정리와 사용자 응답은 항상 메인 에이전트가 맡는다.
- 리뷰 전용 프롬프트 템플릿은 `docs/AI_REVIEW_AGENT_PROMPT.md`를 참고한다.
- 검증 전용 프롬프트 템플릿은 `docs/AI_VERIFY_AGENT_PROMPT.md`를 참고한다.
