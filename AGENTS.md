# 직업성 질환 통합 평가 시스템 (wr-evaluation-unified)

## 프로젝트 개요
직업환경의학 전문의를 위한 통합 평가 도구. 무릎(슬관절) + 척추(MDDM) 평가를 모듈식으로 결합.
향후 고관절, 어깨 등 추가 예정 → 플러그인 아키텍처.

- **기술 스택**: React 18 + Vite 5 + CSS Variables
- **배포**: 웹(Vercel) + 데스크톱(Electron) 동시 지원
- **원본 소스**: `mddm-vercel` (척추, Vanilla JS → React 마이그레이션), `wr-evaluation-Codex` (무릎, React)

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
│   ├── components/          # BasicInfoForm, DiagnosisForm, AIAnalysisPanel, ModuleSelector, SettingsModal
│   ├── hooks/               # useAIAnalysis (web/electron 자동 분기), usePatientList
│   └── utils/               # storage, platform, common, data
├── modules/
│   ├── knee/                # 무릎 모듈 (KneeEvaluation, JobTab, AssessmentTab, KneeResultPanel)
│   └── spine/               # 척추 MDDM 모듈 (SpineEvaluation, TaskManager, TaskEditor, ResultDashboard)
api/analyze.js               # Vercel 서버리스 (Codex API 프록시)
electron/                    # main.js + preload.js (IPC 기반 AI 호출)
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
});
```

그리고 `src/App.jsx`에서 `import './modules/<name>'` 추가.

## 데이터 모델

```javascript
Patient = {
  id, moduleId,
  data: {
    shared: { name, gender, height, weight, birthDate, evaluationDate, hospitalName, department, doctorName, diagnoses },
    module: { /* 모듈별 고유 데이터 */ }
  }
}
```

## AI API 분기

- **웹**: `fetch('/api/analyze')` → Vercel 서버리스 → Codex API (서버 환경변수 CLAUDE_API_KEY)
- **Electron**: `window.electron.analyzeAI()` → IPC → main process → 직접 Codex API (사용자 입력 키)
- 분기 로직: `src/core/hooks/useAIAnalysis.js`

## 주의사항

- localStorage 키 접두사: `wrEvalUnified`
- 자세 이미지: `public/images/` (G1-G11)
- 직업 프리셋: `public/job-presets.json`
- index.html은 프로젝트 루트에 위치 (Vite 요구사항)

## AI 협업 워크플로

### Plan-First 기본 원칙

- 코드 변경 작업은 기본적으로 항상 계획부터 시작한다.
- 구현, 수정, 리팩터링, 패치, 파일 편집은 사용자가 명시적으로 실행을 지시한 경우에만 수행한다.
- 명시적 실행 요청의 예시는 `고쳐줘`, `수정해줘`, `구현해줘`, `패치해줘`, `파일 편집해줘`처럼 실제 변경 의도가 분명한 표현으로 본다.
- 명시적 지시가 없으면 분석, 원인 파악, 설계 검토, 영향도 확인, 버그 추적, 변경안 제안과 계획 제안까지만 수행한다.
- 사용자가 문제를 설명하거나 파일을 보여주며 `참고해봐`, `왜 이런지 봐줘`, `어떻게 할지 보자`처럼 요청한 경우에는 구현 요청으로 해석하지 않고 분석과 계획만 수행한다.
- 애매한 요청은 구현 요청으로 해석하지 않는다.
- 사용자의 최신 명시적 구현 지시가 있을 때만 실제 수정으로 전환한다.
- 그 전까지는 탐색, 재현, 읽기, 검색, 빌드, 테스트 같은 비파괴 작업만 허용한다.

