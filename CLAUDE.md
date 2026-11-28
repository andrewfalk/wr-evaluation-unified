# 직업성 질환 통합 평가 시스템 (wr-evaluation-unified)

직업환경의학 전문의용 통합 평가 도구. 무릎·어깨·팔꿈치·척추·경추·손목 6개 모듈을 플러그인 방식으로 결합한다.

- **기술 스택**: React 18 + Vite 5 + CSS Variables, 서버는 Express + PostgreSQL, 통계 엔진은 Python
- **배포 3형태**: 웹(Vercel) · 독립형 Electron · 인트라넷(서버 + Electron 셸)
- **브라우저 하한 Chrome 108**(Win7 Chrome 109·설치본 Electron 22) — 그보다 새 기능은 `verify:browser-compat`가 `check`에서 막는다

이 파일에는 코드에서 바로 알 수 없는 규칙과 위치만 적는다. 폴더·라우터·필드 목록은 여기에 베끼지 말고 코드를 본다.

## 명령

```bash
npm run dev              # Vite(localhost:3000, /api는 3001로 프록시) + @wr/contracts·@wr/analytics-core watch(클라이언트는 dist로 해석)
npm run check            # 병합 전 로컬 검증 묶음(lint·typecheck·test 루트+서버·build:web·verify:*) — CI 대신(로드맵 D9)
npm run check:full       # check + 실DB 통합 테스트(일회용 Docker PostgreSQL) + 운영 버전 pytest + 의존성 audit + gitleaks
                         #   — DB·동시성·통계 엔진·마이그레이션 변경 PR과 릴리스 전
npm run verify:secrets   # gitleaks로 git 이력 검사(Docker, 약 30초) — 공개 저장소이므로 push 전에
npm run typecheck        # 루트 + 클라이언트 TS(strict) + 클라이언트 JS(완화 checkJs)
npm run build:web        # → dist/web/        (build:electron → dist/electron/)
npm run electron:dev     # 독립형 Electron 개발 실행 (인트라넷 셸은 electron:dev:intranet)
```

서버 스크립트는 `server/package.json`(`dev`·`migrate`·`seed:admin`·`retention` 등), 그 밖의 스크립트는 루트 `package.json`을 본다.

## 어디에 무엇이 있나

```
src/app/                  # 앱 셸(App.tsx)·화면·라우터·모달
src/core/                 # 공유 프레임워크 — src/modules를 import하지 않는다
src/modules/<id>/         # 평가 모듈 6개, 등록 순서는 src/modules/index.ts
src/platform/             # 웹/Electron 분기(bridge.ts) — window.electron은 여기서만
packages/analytics-core/  # @wr/analytics-core — 모듈 계산·변수 카탈로그(클라이언트·서버 공유)
shared/contracts/         # @wr/contracts — 클라이언트·서버 공유 zod 스키마
server/src/routes/        # 인트라넷 서버 라우터 (통계는 server/src/stats/)
server/migrations/        # DB 마이그레이션
services/stats-engine/    # 통계 Python 엔진
electron/                 # main.js + preload 2종 + emr-helper/
api/analyze.js            # Vercel 서버리스(AI 프록시)
```

자세한 내용은 문서를 본다: 구조도 `docs/ARCHITECTURE_DIAGRAM.md`, 리팩터링 현황·결정(D1~D9) `docs/REFACTORING_ROADMAP.md`,
모듈 저장 규칙 `docs/MODULE_STORAGE_CONVENTIONS.md`, 설계 결정 `docs/adr/`, 운영 `docs/OPERATIONS_RUNBOOK.md`·`docs/INTRANET_DEPLOYMENT.md`.

## 모듈 추가 방법

`src/modules/<name>/index.ts`에서 `registerModule()` 호출:

```javascript
import { registerModule } from '../../core/moduleRegistry';
registerModule({
  id: 'new-module',
  name: '표시 이름',
  icon: '아이콘',
  description: '설명',
  shortName: '짧은 이름',                  // 선택 — 대시보드 모듈 칸·최근 활동 표(없으면 칸은 name, 표는 id)
  color: 'var(--accent)',                  // 선택 — 대시보드 모듈 칸의 숫자 색(없으면 var(--accent))
  createModuleData: () => ({ /* 초기 데이터 */ }),
  EvaluationComponent: MyComponent,
  computeCalc: computeFn,
  isComplete: checkFn,
  tabs: [{ id: 'main', label: '평가' }],   // 필수 — 탭마다 평가 단계 하나
  presetConfig: {                          // 프리셋 시스템 연동 (선택)
    label: '프리셋 표시명',
    fields: [{ key: 'fieldKey', label: '라벨', type: 'number' }],  // type: number·boolean·string, 작업 목록형은 [{ key: 'tasks', type: 'taskList' }]
    extractFromModule(moduleData, sharedJobId) { /* → 프리셋 데이터 */ },
    applyToModule(moduleData, sharedJobId, presetData) { /* → 수정된 moduleData */ },
  },
  batchImportConfig: {                     // BatchImportModal 일괄 import 연동 (선택)
    columns: { fieldKey: ['엑셀헤더후보1', 'header_candidate2'] },  // findCol 후보 목록
    applyRow({ patient, row, diagnosis, job, colMap, getCell, rowIndex }) {
      // colMap[key] + getCell(row, index)로 셀 값을 읽어 patient.data.modules[id]에 반영
      // 데이터가 없으면 즉시 return (hasXxxData 가드)
    },
  },
});
```

그리고 `src/modules/index.ts`에 `import './<name>';` 한 줄 추가(이 파일의 순서가 화면 목록·일괄 가져오기 순서다).
등록할 때 `src/core/modules/manifest.ts`의 `validateManifest()`가 매니페스트를 검사한다 — 필수 키(`tabs` 포함)가 없거나
모르는 키·잘못된 타입이 있거나 같은 id를 다시 등록하면 throw한다(개발 모드의 같은 id 재등록만 교체 허용, HMR용).

## 데이터 모델

```javascript
Patient = { id, phase, data: {
  shared: { /* 인적사항·diagnoses[]·jobs[]·진료기록 등 — 필드는 shared/contracts/patient.ts */ },
  modules: { knee: {}, shoulder: {}, elbow: {}, spine: {}, cervical: {}, wrist: {} },
  activeModules: ['knee', 'spine', ...]
} }
```

- `shared.jobs[].excludeFromAnalysis`가 `true`면 그 직력은 신체부담평가(모듈 평가·결과·통계 신체부담 변수)에서 빠지고 직업력 출력에는 남는다.
  판정은 항상 `=== true`이며 필드를 직접 읽지 말고 `packages/analytics-core/jobScope.ts` 헬퍼를 쓴다.

## 지켜야 할 규칙

- **골든(특성화) 테스트** (`**/__goldens__/*.json`, `src/core/fixtures/goldenEnv.js`): 계산·출력 결과를 그대로 얼려 둔 것. 리팩터링 PR에서 실패하면 동작이 바뀐 것이니 코드를 고친다 — **골든을 갱신하지 않는다**. 의도한 출력 변경(기능 PR)만 `npx vitest run -u <테스트 파일>`로 갱신하고 PR에 diff와 이유를 적는다. 입력 `src/core/fixtures/goldenPatients.json`은 재생성하지 않는다(새 사례는 추가).
- **구조 래칫** (`scripts/arch-baseline.json` ↔ `src/__tests__/architecture.ratchet.test.js`): 값은 줄어들기만 한다. 올리지 말고, 줄였으면 `node scripts/arch-metrics.mjs --lower`. core→modules import·`window.electron` 직접 참조·raw `fetch`는 0이다.
- **TS 점진 전환**(로드맵 D3): 새 파일과 분할·수정하는 파일은 `.ts`/`.tsx`로. 새 `@ts-nocheck`는 `scripts/ts-ratchet.mjs`가 막는다.
- **마이그레이션**: 머지된 `server/migrations/*.sql`은 고치지 않고 다음 번호로 추가한다(`verify:migrations-immutable`).
- **공유 패키지**(`@wr/contracts`·`@wr/analytics-core`)를 바꾸면 테스트만으로 끝내지 말고 `npm run check`까지 돌린다(서버 tsc·Vite 빌드는 dist로 해석).
- localStorage 키 접두사 `wrEvalUnified`(`src/core/storage/keys.ts`), 자세 이미지 `public/images/`(G1-G11), 직업 프리셋 `public/job-presets.json`, `index.html`은 프로젝트 루트(Vite 요구사항).

## AI API 분기

- **웹**: `fetch('/api/analyze')` → Vercel 서버리스 → Gemini(기본)/Claude API (서버 환경변수 `GEMINI_API_KEY`/`CLAUDE_API_KEY`)
- **독립형 Electron**: `src/platform/bridge.ts` → IPC → main process → 직접 Gemini/Claude API (사용자 입력 키)
- **인트라넷**: `/api/ai/analyze` → 서버가 내부 LLM 또는 승인된 외부 벤더로 프록시
- 분기 로직: `src/core/services/analysisClient.js` (`src/core/hooks/useAIAnalysis.js`가 호출)

## 코드 탐색 · 수정 원칙 (토큰 절약)

코드를 읽거나 수정하기 전 반드시 다음 순서를 따를 것:

1. **사전 보고**: 그래프를 쓸지 말지, 이유를 한 줄로 먼저 알릴 것
   - 예: "그래프로 `callers_of` 확인 후 해당 라인만 읽겠습니다"
   - 예: "위치가 명확해서 Grep으로 바로 가겠습니다"
2. **그래프 우선**: code-review-graph MCP(`file_summary`, `callers_of`, `importers_of` 등)로 대상 함수/노드의 파일·행 번호를 먼저 특정
3. **부분 Read**: `offset` / `limit`으로 필요한 범위만 읽을 것 — **파일 전체 Read 금지**
   - 예외: 파일이 매우 짧거나 전체를 재작성해야 하는 경우
4. **매번 보고**: 그래프를 읽었는지·안 읽었는지, 왜 그랬는지 매 작업마다 명시
