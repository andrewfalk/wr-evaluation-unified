# 인트라넷 백엔드 서버 통합 계획 (v10 — 착수안)

## 정책 변경 사항 (확정)

**EMR helper 노출 정책 (의도된 변경)**
- 초기 검토에서는 인트라넷 빌드에서 EMR helper 미노출이 제안되었으나, 최종 결정은 **EMR helper API 유지 + origin 게이트 + per-install device token 서명으로 보호**.
- 이유: EMR helper는 의사 PC의 IE EMR 업무화면을 직접 조작하는 핵심 기능으로 서버가 대체 불가. 인트라넷 모드에서 통째로 차단하면 도구 가치를 깨뜨림.
- 트레이드오프: 원격 페이지(`https://wr.hospital.local`)에 로컬 EMR 조작 권한이 부여됨 → XSS 발생 시 EMR 권한도 함께 노출. 이를 막기 위해 다층 방어:
  1. **preload origin 게이트**: `location.origin`이 화이트리스트일 때만 `window.electron.injectEMR` 등 바인딩
  2. **main process ipcMain handler 검증**: `event.sender.getURL()` 화이트리스트 검사, 외부 origin은 즉시 거부 + audit
  3. **CSP 강제**: `connect-src 'self'`, `script-src 'self'`로 외부 스크립트 로드/외부 fetch 차단
  4. **입력 검증**: 사용자 입력은 zod 스키마로 검증, 모듈 데이터도 마찬가지
  5. **`dangerouslySetInnerHTML` 전면 금지**: ESLint rule(`react/no-danger`)로 강제
  6. **의존성 감사**: `npm audit` CI 게이트, GitHub Dependabot 활성화, 취약점 발견 시 즉시 패치
  7. **Trusted Types** (점진 도입): CSP `require-trusted-types-for 'script'` 추가하여 sink-level 보호. 도입 비용이 있으므로 Phase 6+ 별도 작업으로

## Context

**왜 이 작업을 하는가**
- 직업환경의학 통합 평가 시스템(`wr-evaluation-unified`)은 환자 데이터를 브라우저 localStorage / Electron 로컬 파일에만 보관 중. 다중 사용자·중앙 관리·감사 추적·기관 단위 권한 모두 불가.
- 환자 PHI는 외부 클라우드 저장이 법적/병원 정책상 불가능 → **병원 인트라넷 망 안에 자체 서버**.
- 클라이언트엔 이미 인트라넷 호출 골격(`intranetWorkspaceRepository`, `session`, `AuthContext`, `SettingsModal` 서버 URL UI)과 환자 동기화 메타(`patient.sync`, `patient.meta`)가 약 60% 수준으로 마련됨.
- 본 계획은 제미나이 1·2차 + 코덱스 1·2·3·4차의 **6중 리뷰**를 반영한 최종안.

---

## 권장 아키텍처 (확정)

**온프레미스 Node.js + PostgreSQL, 환자 1급 모델, 서버 capability 기반 운영 정책, Electron same-origin 단일화**

```
[병원 인트라넷 망]
  ├─ 서버 PC/VM
  │    └─ docker-compose
  │         ├─ wr-app-server (Node 20, Express + TypeScript)
  │         │    └─ 정적 자산 dist/web/ 도 같이 서빙
  │         ├─ postgres:16  (volume + 일일 pg_dump)
  │         └─ caddy (내부 CA HTTPS, 자동 cert reload)
  │
  ├─ 의사 PC (브라우저)  → https://wr.hospital.local (same-origin)
  ├─ 의사 PC (Electron, 인트라넷 모드)
  │    → BrowserWindow.loadURL('https://wr.hospital.local')
  │       (EMR helper API 유지 + preload/main process 양쪽 origin 게이트)
  ├─ 의사 PC (Electron, 외부망 모드, 기존 동작 유지) → 로컬 자산 + EMR helper + 직접 AI
  │
  └─ (옵션) 병원 AD/LDAP (추후 어댑터)
```

---

## 확정된 결정사항

| 항목 | 결정 |
|---|---|
| 인증 | 자체 계정 + 추후 AD/LDAP. `AuthProvider` 추상화, 1차 `LocalDbAuthProvider`(bcrypt) |
| AI | **인트라넷 모드는 외부 LLM 기본 금지**. `/api/ai/analyze`는 ① 내부 LLM 또는 ② 병원 승인 + 비식별화 + 별도 계약이 있는 외부 LLM에만 한해 활성. 클라는 항상 same-origin 호출 |
| 코드 위치 | 현재 repo 안 `server/` + **`shared/contracts/` 별도 순수 폴더**. server/client/mock 모두 shared만 단방향 import |
| 검색 컬럼 | 확장 (name, patient_no, birth_date, evaluation_date, diagnoses_codes, jobs_names, active_modules, owner/org, updated_at) |
| 운영 모드 | 서버 `/api/config/public` + `/api/auth/me` capability 분리. **config 실패 시 intranet 모드는 localFallbackAllowed=false 강제** |
| 토큰 저장 | refresh = HttpOnly+Secure+SameSite=Strict 쿠키, csrf = non-HttpOnly+Secure+SameSite=Strict 쿠키, access = 메모리 |
| Electron 인증 모드 | 인트라넷 빌드 = `loadURL(https://wr.hospital.local)` + **EMR helper API 유지 + origin 게이트**. 외부망 빌드 = 기존 동작 그대로 |
| Workspace 의미 | snapshot 보존. 기본 로드는 **snapshot**, `?view=current`로 현재 환자 상태 비교 가능 |
| 감사 범위 | mutating + **read도 포함**: patient GET/search, workspace load, export, login success/fail, auth refresh fail |

---

## 채택된 반영 사항 (다중 리뷰 통합)

### 채택 (모두)

1. **`shared/contracts/`로 격상 (v3 수정)**
   - `wr-evaluation-unified/shared/contracts/*.ts` 별도 순수 zod 스키마 폴더.
   - server, client, mock-intranet-server.mjs 모두 이쪽만 import. server↔client 직접 의존 없음.
   - Vite alias: `@contracts` → `./shared/contracts`. server tsconfig paths도 동일.

2. **CSRF 새로고침 시나리오 해결**
   - `wr_csrf`는 **non-HttpOnly + Secure + SameSite=Strict + Path=/** 쿠키.
   - 앱 부팅 시 `document.cookie`에서 csrf 값 read → `httpClient`가 모든 mutating 요청에 `X-CSRF-Token` 자동 첨부.
   - 보조 endpoint `POST /api/auth/csrf` (refresh 쿠키 인증) → csrf 토큰 재발급. 쿠키가 사라진 예외 상황 대응.
   - **CSRF 미들웨어 예외 규칙**: `/api/auth/csrf`는 csrf 쿠키가 없는 상황에서 호출되므로 CSRF 미들웨어를 **명시적 예외**로 둠. 보호 수단 = ① HttpOnly refresh 쿠키 인증(SameSite=Strict로 cross-site 자동 차단) ② same-origin 강제(Origin 헤더 검증) ③ rate limit(분당 10회/IP). 이 endpoint만이 유일한 예외이며, 나머지 mutating은 모두 X-CSRF-Token 강제.
   - 새로고침 흐름: 페이지 reload → access 메모리 손실 → httpClient 첫 요청 401 → `/api/auth/refresh` (HttpOnly refresh 쿠키 + X-CSRF-Token 헤더) → 새 access + (필요 시) 새 csrf 쿠키.

3. **Electron preload/EMR 보안 경계 (EMR helper 유지)**
   - **EMR helper(`injectEMR`, `extractRecord`, `extractConsultation`)는 의사 PC의 IE EMR 업무화면을 직접 조작하는 핵심 기능이며 서버가 대체 불가.** 인트라넷 모드에서도 그대로 노출.
   - 보안 게이트(다층):
     - **preload-intranet.js**: 부팅 시 `location.origin`이 `WR_INTRANET_URL` 화이트리스트와 일치할 때만 `window.electron`에 EMR API 바인딩. 일치하지 않으면 빈 객체 노출.
     - **main process ipcMain handler**: `emr-inject`/`emr-extract-record`/`emr-extract-consultation` 진입 시 `event.sender.getURL()`을 화이트리스트 검사. 외부 origin이면 즉시 거부 + audit 기록.
     - **BrowserWindow 옵션**: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`. `will-navigate`/`setWindowOpenHandler`로 외부 origin 이동 차단.
   - `electron/preload-intranet.js`, `electron/preload-standalone.js` 두 파일로 분리. 인트라넷 빌드는 EMR + 최소 환경 API만, 외부망 빌드는 기존 풀 API.
   - EMR 호출 자체를 서버 audit_logs에 기록 — **main process가 per-install device token으로 서명 후 직접 `/api/audit/emr` 전송** (T15/T34 참조). 렌더러 우회 불가.

4. **AI 정책 표현 정밀화**
   - 인트라넷 모드 default: `aiEnabled=false`, 외부 LLM 호출 절대 금지.
   - 외부 LLM 활용은 **별도의 명시적 조건 충족 시에만**: ① 병원 IRB/IT 보안 승인서 ② PHI 비식별화 파이프라인 통과 ③ 벤더 BAA/DPA 계약. 이 조건은 서버 env (`AI_EXTERNAL_VENDOR_APPROVED=true` + `AI_DEIDENTIFY_REQUIRED=true`)로 게이트.
   - 내부 LLM(Ollama/vLLM/사내 GPU)은 비식별화 강제 없이 허용 가능. 두 경우 모두 클라이언트는 `/api/ai/analyze` 한 곳만 호출.

5. **감사 로그 범위 확장**
   - 기록 대상: 로그인 성공/실패, 로그아웃, refresh 성공/실패, **patient GET/search/export**, workspace load(snapshot 또는 current 표시), workspace save/delete, autosave PUT/DELETE, patient POST/PATCH/DELETE, AI 분석 호출, 서버 설정 변경, 관리자 audit 조회.
   - 필드 그대로: actor_user_id, actor_org_id, action, target_type, target_id, outcome, ip, user_agent, extra(jsonb).
   - read 이벤트는 요청 빈도가 높으므로 audit_logs는 파티셔닝 검토(월별, Phase 1.5).

6. **Workspace snapshot 로드 정책 명확화 + 삭제 영향**
   - `GET /api/workspaces/:id` → **snapshot_payload 그대로** 반환 (저장 당시 환자 묶음).
   - `GET /api/workspaces/:id?view=current` → snapshot의 patient_ids로 patient_records 현재값 조회. "이 워크스페이스를 만들 때부터 환자가 어떻게 변했는지 비교" 용도.
   - 기본 동작은 snapshot. 사용자 멘탈 모델("저장본")과 일치.
   - **환자 soft delete 영향**: 환자 삭제 시 모든 워크스페이스의 `snapshot_payload` 내 해당 환자 entry는 **redacted 표시**됨(name/patient_no/birth_date 등 PHI 필드 제거, `redacted: true` 플래그). 즉 "저장본 보존" UX는 삭제되지 않은 환자에 대해서만 완전. **UI에 명시 안내**: 워크스페이스 로드 시 redacted entry는 회색 처리 + "[삭제된 환자] 식별정보가 제거되었습니다" 표시. 5년 retention 후 워크스페이스 자체 자동 cleanup.
   - `POST /api/workspaces`는 그 시점의 환자 배열을 snapshot_payload로 통째 보관.

7. **CORS production 강화**
   - production 화이트리스트: 인트라넷 도메인만 (`https://wr.hospital.local` 등).
   - `null` origin, `file://`, `app://` 모두 **production에서 거부**.
   - dev 전용 origin(`http://localhost:5173`)은 `NODE_ENV !== 'production'`에서만 허용.
   - 인트라넷 모드 Electron이 same-origin이므로 production CORS는 사실상 닫혀 있음.

8. **Phase 0~1 main 머지 조건 명확화**
   - 머지 조건: `npm run build:web` + `npm run electron:build`(현행) + `npm run lint` + `npm test`(zod 스키마 포함) + `npm run typecheck` 모두 0 exit + `cd shared && npm run build` 선행. Phase 2 이후부터 `electron:build:{standalone,intranet}` 분기(T35).
   - PR 체크리스트에 위 항목 강제.

9. **내부 CA 인증서 배포 절차 (Phase 1.5)**
   - 문서: `docs/INTRANET_DEPLOYMENT.md` 신설.
   - 내용: 내부 CA 발급, Caddy 자동 인증서 갱신, **클라이언트 PC에 CA 루트 인증서 설치**(Windows 신뢰 저장소, Electron의 `app.commandLine.appendSwitch('ignore-certificate-errors-spki-list', ...)` 또는 `request.on('certificate-error')` 처리), 1년 만료 알림, 갱신 절차.
   - 인증서 미설치 PC에서는 https://wr.hospital.local 접근이 차단됨을 운영팀에 명시.

10. **Config 실패 시 fail-closed 기본값**
    - 클라이언트 부팅 흐름: `/api/config/public` 호출 → 응답 받기 전까지 모든 mutating 요청 보류.
    - 응답 실패 + `session.mode === 'intranet'` (또는 `settings.integrationMode === 'intranet'`) → **즉시 localFallbackAllowed=false 강제**, "서버 연결 실패" 모달, 새 데이터 작성 잠금. 절대 자동 로컬 저장으로 떨어지지 않음.
    - 외부망/dev 모드에서만 config 실패 시 기존 로컬 동작.

---

## 단계별 실행 계획

### Phase 0 — 정리 (반나절~1일)
- `shared/contracts/*.ts`에 zod 스키마 추출 (workspace, autosave, patient, session, auth, config). 듀얼 빌드(tsup) → `dist/{esm,cjs}/`.
- root `package.json`에 zod dependency, `prebuild:web`로 shared build 자동 선행.
- Vite alias `@contracts` → `shared/contracts/dist/esm`(client). server tsconfig paths → `dist/cjs`.
- `mock-intranet-server.cjs`를 `mock-intranet-server.mjs`로 마이그레이션 후 zod 검증.
- `intranetWorkspaceRepository.js`가 `@contracts/workspace`로 응답 파싱.
- `wrEvalUnifiedDeviceId` 발급 ([storage.js](src/core/utils/storage.js)).
- **머지 조건**: `lint`/`test`/`typecheck`/`build:web`/`electron:build`(현행) 모두 0 exit + shared build 선행.

### Phase 1 — 백엔드 골격 + 호환 API + 인증 (2~3주)
> **일정 리스크**: 인증·DB·audit·workspace adapter·Docker·admin seed·device token 등 포함. 2주는 낙관, 실측은 3주에 가까움. 일정 압박 시 Phase 1.5로 이연 가능한 작업: T22(백업 runbook), T23(audit reader 분리), T24(파티셔닝).

**디렉토리**
```
wr-evaluation-unified/
├─ src/                             # 기존 클라이언트
├─ shared/
│   └─ contracts/                   # ★ 단일 진실: zod schemas, 순수 (browser/node 양쪽 안전)
├─ server/                          # 독립 npm 프로젝트
│   ├─ package.json                 # express, pg, drizzle-orm, zod, pino, helmet, bcrypt, cookie-parser
│   ├─ tsconfig.json                # paths: @contracts/* → ../shared/contracts/dist/cjs/*
│   ├─ src/
│   │   ├─ index.ts
│   │   ├─ config.ts                # env 로드, deploymentMode 결정, AI vendor approval 게이트
│   │   ├─ auth/
│   │   │   ├─ AuthProvider.ts
│   │   │   ├─ LocalDbAuthProvider.ts
│   │   │   ├─ sessionStore.ts
│   │   │   └─ csrf.ts              # double-submit, /api/auth/csrf 재발급
│   │   ├─ routes/
│   │   │   ├─ auth.ts              # login, logout, me, refresh, csrf
│   │   │   ├─ config.ts            # /api/config/public
│   │   │   ├─ workspaces.ts        # snapshot 기본, ?view=current 옵션
│   │   │   ├─ autosave.ts          # ?deviceId 필수
│   │   │   └─ ai.ts                # /api/ai/analyze 프록시
│   │   ├─ middleware/
│   │   │   ├─ session.ts
│   │   │   ├─ csrf.ts
│   │   │   ├─ audit.ts             # mutating + read(patient/workspace) 자동 로깅
│   │   │   ├─ failClosed.ts
│   │   │   └─ csp.ts
│   │   └─ db/
│   ├─ migrations/0001_init.sql
│   └─ Dockerfile
├─ docker-compose.yml
└─ vite.config.js (alias @contracts)
```

**DB 스키마 (Phase 1)**
- `users(id, login_id UNIQUE, password_hash, name, role, organization_id, created_at, last_login_at, disabled_at)`
- `sessions(id, user_id, refresh_token_hash, csrf_token_hash, expires_at, revoked_at, user_agent, ip)`
- `patient_records(id, organization_id, owner_user_id, name, patient_no, birth_date, evaluation_date, active_modules text[], diagnoses_codes text[], jobs_names text[], updated_at, created_at, revision int, deleted_at, payload jsonb)` + 인덱스 (트리그램, GIN)
- `workspaces(id, organization_id, owner_user_id, name, created_at, patient_ids uuid[], snapshot_payload jsonb)` — **snapshot 보존**
- `autosaves(user_id, device_id, organization_id, saved_at, payload jsonb, PK(user_id, device_id))`
- `audit_logs(...)` — append-only via app role

**구현할 엔드포인트**
- `POST /api/auth/login` → HttpOnly `wr_refresh` + non-HttpOnly `wr_csrf` 쿠키 set, body `{user, accessToken, accessExpiresAt}`
- `POST /api/auth/refresh` → 쿠키 검증 + X-CSRF-Token 검증 → 회전
- `POST /api/auth/logout` → revoke + clear cookies
- `POST /api/auth/csrf` → csrf 쿠키만 재발급
- `GET /api/auth/me` → user, org, capabilities (authed)
- `GET /api/config/public` → `{ mode, aiEnabled, localFallbackAllowed, serverTime }` (no-auth)
- `GET/POST /api/workspaces`, `DELETE /api/workspaces/:id` — snapshot Adapter
- `GET /api/workspaces/:id` (snapshot) / `?view=current` (현재 patient_records)
- `GET/PUT/DELETE /api/autosave?deviceId=`
- `POST /api/ai/analyze` (capability 활성 시만)

**보안**
- helmet + CSP `default-src 'self'; connect-src 'self'; script-src 'self'; img-src 'self' data: blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'` (blob:은 html2pdf/export 다운로드용)
  - **TODO (Phase 6+)**: `style-src 'unsafe-inline'`을 nonce 기반으로 전환. 현재 React 18 + CSS Variables 구조에서 인라인 스타일 사용처 점진 정리 후 강화.
- CORS: production 화이트리스트(인트라넷 도메인만), `null`/`file://`/`app://` 거부. dev origin은 NODE_ENV gate.
- rate limit: login 5회/분/IP
- CSRF: refresh/logout/모든 mutating에 X-CSRF-Token 검증

### Phase 1.5 — 운영 강화 (4~6일)
- Caddy + 내부 CA 자동 발급 컨테이너 구성.
- **`docs/INTRANET_DEPLOYMENT.md`**: 내부 CA 루트 인증서 클라이언트 PC 설치 절차 (Windows 신뢰 저장소), Electron certificate 처리, 갱신 알림.
- `wr_audit_reader` role + 별도 connection pool.
- `/admin/audit` 조회 페이지.
- audit_logs 월별 파티셔닝(읽기 빈도 대비).
- 서버 다운 감지 글로벌 배너 + 새 환자 작성 잠금.

### Phase 2 — 클라이언트 결합 (1.5주)

**수정 파일**
| 파일 | 변경 |
|---|---|
| [AuthContext.jsx:10](src/core/auth/AuthContext.jsx#L10) | `login`, `logout` 액션. 부팅 시 `wr_csrf` 쿠키 read |
| [session.js](src/core/auth/session.js) | refresh를 localStorage에서 제거. access만 메모리. csrf는 쿠키 read |
| [httpClient.js:13](src/core/services/httpClient.js#L13) | `credentials: 'include'`, mutating에 X-CSRF-Token 자동, 401 → 1회 refresh → 실패 시 logout |
| [workspaceRepository.js:35](src/core/services/workspaceRepository.js#L35) | `localFallbackAllowed`로 분기. **config 실패 + intranet 모드 → false 강제** |
| [analysisClient.js:45](src/core/services/analysisClient.js#L45) | 인트라넷 모드: aiEnabled=false → 거부. 활성 시 `/api/ai/analyze` only |
| [SettingsModal.jsx:176-257](src/core/components/SettingsModal.jsx#L176-L257) | 운영 모드 read-only |
| [storage.js](src/core/utils/storage.js) | deviceId 발급 |
| [vite.config.js](vite.config.js) | alias `@contracts` |

**Electron 빌드 분기**
- `electron/preload-standalone.js` (기존 풀 API: EMR helper + AI + EMR extract 등)
- `electron/preload-intranet.js` (EMR helper API + `appVersion`/`platform` 최소셋. AI 직접 호출 API는 미노출 — 서버 프록시 사용)
- `electron/main.js`:
  - `WR_BUILD_TARGET=intranet` 시 `loadURL(env.WR_INTRANET_URL)` + intranet preload 사용
  - 모든 EMR 관련 ipcMain handler 진입에 `event.sender.getURL()` origin 검증 추가 (인트라넷 모드 한정)
  - `will-navigate`/`setWindowOpenHandler`로 외부 origin 이동 차단
- `package.json` scripts: `electron:build:standalone`, `electron:build:intranet`.

**신설 파일**
- `src/core/components/LoginModal.jsx`
- `src/core/hooks/useServerConfig.js` — `/api/config/public` fetch + 부팅 게이팅
- `src/core/hooks/useAIAvailable.js`
- `src/core/utils/csrfCookie.js` — wr_csrf 쿠키 read

### Phase 2.5 — Mock 서버 UI 수동 검증 (완료)

**목적**: Phase 2 완료 후 실서버 없이 `npm run mock:intranet` + `npm run dev` 조합으로 인트라넷 모드 전체 UI를 실제처럼 돌리고, 수동 시나리오로 한 차례 검증한다.

**실행 방법**

```bash
# 터미널 1
npm run mock:intranet     # localhost:3001 (mock API)

# 터미널 2
npm run dev               # localhost:3000 → Vite가 /api/* → 3001 프록시
```

브라우저: `http://localhost:3000` (또는 `settings.apiBaseUrl`에 `http://localhost:3001` 직접 지정)

**구현 내역 (`scripts/mock-intranet-server.mjs`)**

| 항목 | 내용 |
|---|---|
| 포트 | 기본값 3002 → 3001 (Vite 프록시 타겟과 통일) |
| 쿠키 헬퍼 | `parseCookies`, `setAuthCookies`, `clearAuthCookies` |
| 환경 변수 | `MOCK_MUST_CHANGE_PASSWORD=true` — ChangePasswordModal 경로 테스트 |
| 신규 엔드포인트 | `GET /api/config/public`, `POST /api/auth/csrf`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/change-password`, `POST /api/ai/analyze` |
| CORS | `Access-Control-Allow-Origin: *` → 요청 Origin 에코 + `Access-Control-Allow-Credentials: true` (cross-origin 직접 요청 지원) |

**구현 중 발견 · 수정된 버그**

1. **useServerConfig StrictMode 무한 loading** — React StrictMode가 effect를 두 번(실행→cleanup→재실행) 돌릴 때 `lastFetchedUrlRef.current = baseUrl`이 이미 세팅되어 두 번째 effect가 dedup에 걸려 fetch를 안 보냄 → cleanup 시 `lastFetchedUrlRef.current = null`로 리셋하도록 수정
2. **useServerConfig 타임아웃 없음** — 도달 불가 URL로 `fetch`가 무한 대기 → `AbortController` + `setTimeout(8000)`으로 타임아웃 추가 (`AbortSignal.timeout()` 보다 호환성 넓음)
3. **mock 서버 CORS** — `credentials: 'include'` + `Access-Control-Allow-Origin: *` 조합은 브라우저가 cross-origin 요청을 차단함 → 요청 Origin을 에코하는 방식으로 수정

**수동 검증 시나리오**

| ID | 시나리오 | 확인 항목 |
|---|---|---|
| A | 로그인 + 기본 흐름 | LoginModal 표시 → 로그인 → Settings read-only, AI 버튼 비활성(`aiEnabled:false`) |
| B | 세션 유지 (새로고침) | F5 후 LoginModal 없이 바로 앱 진입 (`/api/auth/csrf` → 세션 복구) |
| C | 워크스페이스 저장/불러오기 | 환자 추가 → 저장 → `.mock-intranet/db.json` 기록 → 새로고침 후 불러오기 동일 |
| D | 로그아웃 | 로그아웃 → LoginModal 재등장, 워크스페이스 저장 시도 → 로그인 모달 |
| E | ChangePasswordModal | `MOCK_MUST_CHANGE_PASSWORD=true npm run mock:intranet` → 로그인 직후 모달 강제. `currentPassword=wrong` 에러 경로. DevTools Network에서 `X-CSRF-Token` 헤더 확인 |
| F1 | fail-closed (서버 처음부터 dead) | mock 서버 없이 접속 → 8초 후 "서버 응답 시간 초과" 에러 화면, 로컬 저장 잠금 |
| F2 | fail-closed (로그인 후 서버 종료) | 로그인 후 `Ctrl+C` → 워크스페이스 저장 실패 알림, localStorage 오염 없음 |

**완료 기준**: 시나리오 A~F2 모두 통과, E에서 DevTools Network로 `X-CSRF-Token` 헤더 확인.

---

### Phase 3 — 환자 1급 API + 양방향 동기화 (1.5주)
- 서버: `GET/POST /api/patients`, `GET/PATCH/DELETE /api/patients/:serverId`
  - PATCH는 `If-Match: <revision>` 필수
  - POST batch는 `Idempotency-Key`
  - DELETE는 `?revision=N`
- 클라: `src/core/services/patientServerRepository.js` 신설. patient.sync 활용.
- 동기화: 5분 주기 + window focus pull, 변경 즉시 push. 충돌 모달.

### Phase 4 — 운영 보안 강화 (3~4일)
- audit 미들웨어가 mutating + read(patient/workspace/export) 모두 기록.
- on-prem CSP 검증.
- mutating 정책 차등 검증.

### Phase 5 — 마이그레이션 도구 (3일)
- `LocalToServerMigrator`: localStorage 4개 키(presets 제외) → POST /api/patients (Idempotency-Key=local id).
- 결과 리포트 모달.

---

## 검증 방법

1. **계약**: zod 스키마 단일 소스, supertest로 mock vs 실서버 응답 동일성.
2. **로그인**: 잘못된 비번 → 401, access 만료 → cookie refresh 성공, refresh 만료 → 로그인 모달, CSRF 누락 → 403.
3. **새로고침**: F5 후 첫 mutating 요청이 401 → /api/auth/refresh 자동(쿠키+csrf) → 통과. csrf 쿠키 삭제 시 `/api/auth/csrf` 재발급.
4. **Electron 인트라넷 + EMR**: BrowserWindow https URL 직접 로드 → EMR helper API 정상 동작. 외부 origin에서 임의로 ipc 호출 시 거부 + audit 기록. 외부 origin navigation 차단.
5. **Electron 외부망**: 기존 EMR helper + AI 직접 호출 동작 유지.
6. **환자 1급 동기화**: 동시 PATCH → 409, 충돌 모달.
7. **fail-closed**: docker stop → 저장 실패 알림, localStorage 미오염. **`/api/config/public` 응답 못 받으면 intranet 모드는 절대 로컬로 안 떨어짐**.
8. **AI 다층 차단**:
   - aiEnabled=false → UI 비활성
   - CSP `connect-src 'self'`로 외부 fetch 차단
   - `/api/ai/analyze` 부재 또는 비활성 → 404/403
   - 외부 LLM 활성은 `AI_EXTERNAL_VENDOR_APPROVED + AI_DEIDENTIFY_REQUIRED` env 둘 다 true일 때만
9. **CSRF**: 쿠키만 + 헤더 누락 → 403. 쿠키 + 헤더 mismatch → 403.
10. **Workspace snapshot**: 환자 A → workspace 저장 → 환자 A 수정 → workspace 다시 열면 저장 시점 그대로. `?view=current`로 현재값 비교.
11. **공유 스키마 방향**: server에서 `src/` import 시도 → 빌드 실패. client/server/mock 모두 `shared/contracts/`만 import.
12. **CORS**: production에서 null/file/app origin 거부, 인트라넷 도메인만 허용.
13. **CA 인증서 미설치 PC**: https://wr.hospital.local 접근 시 인증서 경고 → 운영 절차 따라 CA 설치 후 정상 접근.
14. **마이그레이션**: 로컬 5명 → 인트라넷 → 5명 모두 서버 + sync.serverId, 재실행 중복 없음.
15. **감사 로그**: read(patient GET/search/export, workspace load) + mutating + login success/fail + refresh fail 모두 기록. 앱 role SELECT 거부, audit reader role만 가능.
16. **autosave 멀티 디바이스**: PC A/B 동시 작성 시 device_id별 분리.
17. **CSP blob: 동작**: PDF export(html2pdf), Excel 다운로드, 이미지 미리보기 등 blob: URL 흐름이 정상 동작하는지 확인. connect-src는 닫혀 있어도 블록되지 않아야 함.
18. **다중 탭 refresh race**: 두 탭에서 동시 401 → 한 쪽만 refresh, 다른 쪽은 BroadcastChannel로 새 access 받아 재시도 → 모두 통과.
19. **EMR audit (server-side)**: 렌더러가 audit POST를 우회해도 main process가 보낸 EMR audit row가 audit_logs에 존재해야 함.
20. **초기 admin 부트스트랩**: 빈 DB → seed CLI 실행 → admin 로그인 가능. 또는 setup token 출력 → 브라우저로 첫 admin 생성.

---

## 브랜치 전략

**현재 main은 v4.2.1 안정 배포 가능 상태**. 백엔드 통합은 2~6주 규모이고 클라이언트 동작이 큰 폭으로 바뀌는 시기가 있으므로 격리.

```
main (v4.2.1 → v4.2.x 핫픽스만)
  │
  ├─ Phase 0: feature/contracts-zod
  │     머지 조건: npm run lint ✓ npm test ✓ npm run typecheck ✓ npm run build:web ✓ npm run electron:build(현행) ✓
  │     → main 머지
  │
  ├─ Phase 1: feature/server-skeleton (server/ 추가 + shared/dist 의존 + Docker 도입)
  │     머지 조건: server unit test ✓ + supertest 호환 API ✓ + 클라 빌드 2종(build:web/electron:build) ✓ — 빌드 게이트로 안정성 보장
  │     → main 머지
  │
  └─ feature/intranet-backend (통합 브랜치)
        ├─ feat/auth-context-login        (Phase 2)
        ├─ feat/http-csrf-interceptor     (Phase 2)
        ├─ feat/electron-intranet-build   (Phase 2)
        ├─ feat/patient-server-repo       (Phase 3)
        ├─ feat/audit-and-csp             (Phase 4)
        └─ feat/local-to-server-migrator  (Phase 5)
```

**원칙**
- Phase 0~1은 main 직접 머지 (위 빌드 조건 통과 시).
- Phase 2~5는 `feature/intranet-backend` 격리.
- Phase별 sub-branch로 PR 단위 검토·롤백.
- 통합 브랜치는 **주 1회 main rebase**로 발산 차단.
- 최종 통합: `--no-ff merge`로 main, 단일 진입점 보존.
- 태그: Phase 1 머지 시 `v4.3.0-server-skeleton`, 최종 통합 시 `v5.0.0` (스토리지 모델 메이저 변경).

**핫픽스 정책**
- main 핫픽스는 다음 주 rebase로 통합 브랜치가 자동 흡수.
- 통합 브랜치 자체 핫픽스는 sub-branch에서 cherry-pick to main.

---

## 작업 큐 (턴별 명령용, v8 기준)

**사용법**: 사용자가 `T01 진행해` 식으로 호출 → Claude가 그 단위만 구현. 단위는 PR 1개 또는 1~2시간 분량. 의존성(`deps`)은 선행 완료 필수.

규모 라벨: **S** = 30분 이하 / **M** = 1~2시간 / **L** = 반나절 이상.

**1차 릴리스 제외 항목 (명시)**: `wrEvalUnifiedCustomPresets` (직업 프리셋)는 1차 마이그레이션에서 제외, 로컬 보존. 향후 별도 Phase에서 `custom_presets` 테이블/API 추가 예정.

### Phase 0 — 계약 추출 (브랜치: `feature/contracts-zod`)
| ID | 작업 | 영향 | 검증 | deps | 규모 |
|---|---|---|---|---|---|
| T00a | **npm scripts/typecheck/Dependabot 추가** (ESLint 변경 없음): root에 `test`(vitest), `typecheck`(tsc --noEmit), `prebuild`(shared build), `prebuild:web`, `prebuild:electron` 정의. shared build가 build:web/electron:build 실행 전 무조건 선행 + Dependabot 설정 | `package.json`, `.github/dependabot.yml` | `npm run typecheck && npm test` 통과, `npm run build:web` 시 shared 자동 빌드 확인 | — | S |
| T00b | **ESLint + react/no-danger 도입 + 기존 위반 정리**: 먼저 `grep -r "dangerouslySetInnerHTML" src/` 결과 확인 → 위반 0이면 rule만 추가, 위반 ≥1이면 안전 sanitizer(DOMPurify) 또는 비-HTML 렌더 방식으로 교체 후 rule 활성. ESLint config + `lint` script 추가 | `.eslintrc.json`, 위반 발견 시 해당 컴포넌트 | `npm run lint` 통과, no-danger 위반 0 | T00a | S~M (위반 수에 비례) |
| T01 | `shared/contracts/` 폴더 + zod 의존성(**root package.json + shared/package.json 양쪽**) + 듀얼 빌드(tsup) + tsconfig | `shared/contracts/`, `shared/package.json`, `shared/tsup.config.ts`, root `package.json` | `cd shared && npm run build` → `dist/{esm,cjs}/` 산출물 생성, root에서 `import { ... } from '@contracts/...'` 컴파일 통과 | T00a | S |
| T02 | workspace/autosave/auth/config/patient zod 스키마 작성 + unit test | `shared/contracts/{workspace,autosave,auth,config,patient}.ts`, `shared/contracts/__tests__/*` | `vitest` unit test | T01 | M |
| T03 | `mock-intranet-server.cjs` → `mock-intranet-server.mjs` 마이그레이션 + 응답 zod 검증 | `mock-intranet-server.mjs`, `package.json` script | mock 서버 부팅 + 기존 호출 정상 동작 | T01, T02 | S |
| T04 | Vite alias `@contracts` → **`shared/contracts/dist/esm`(client 전용)**, server tsconfig paths → **`dist/cjs`** 고정. `intranetWorkspaceRepository`가 응답을 zod로 파싱 | `vite.config.js`, `server/tsconfig.json`, `src/core/services/intranetWorkspaceRepository.js` | `npm run build:web` + `npm run electron:build`(기존) + 클라 동작 확인. mock(.mjs)는 dist/cjs 사용 | T03 | M |
| T05 | `wrEvalUnifiedDeviceId` 발급 로직 | `src/core/utils/storage.js` | unit test | — | S |

### Phase 1 — 서버 골격 (브랜치: `feature/server-skeleton`)
| ID | 작업 | 영향 | 검증 | deps | 규모 |
|---|---|---|---|---|---|
| T06 | `server/` npm 프로젝트 초기화 (express, pg, drizzle-orm, zod, pino, helmet, bcrypt, cookie-parser, vitest, supertest) + tsconfig paths(`@contracts/*` → `../shared/contracts/dist/cjs/*` 또는 `src/*`) | `server/package.json`, `server/tsconfig.json`, `server/src/index.ts` | `cd server && npm run dev` 부팅 | T01 | S |
| T07 | `0001_init.sql` 마이그레이션 (users/sessions/patient_records/workspaces/autosaves/audit_logs + 인덱스) + 마이그레이션 러너 | `server/migrations/0001_init.sql`, `server/src/db/migrate.ts` | `psql -f` 적용 + 스키마 검증 쿼리 | T06 | M |
| T08 | `config.ts`: env 로드, `deploymentMode`, AI vendor approval 게이트 | `server/src/config.ts` | unit test | T06 | S |
| T09 | `LocalDbAuthProvider` + bcrypt + `sessionStore` (refresh/csrf hash, rotation, revoke). **rotation 시 직전 refresh token을 30초 grace window 동안 유효 유지** (다중 탭/프로세스 race 보강 — T27의 BroadcastChannel 보완) | `server/src/auth/*` | unit test로 grace window 시나리오: 직전 토큰 30초 내 재사용 시 200, 30초 후 재사용 시 401 | T07 | M |
| T10 | `csrf.ts`: double-submit token 발급/검증 미들웨어 + `/api/auth/csrf` 재발급 endpoint | `server/src/auth/csrf.ts`, `server/src/middleware/csrf.ts` | unit test | T09 | S |
| T11 | `routes/auth.ts`: login/logout/refresh/me/csrf + HttpOnly+SameSite=Strict 쿠키 set | `server/src/routes/auth.ts` | supertest | T10 | M |
| T12 | `routes/config.ts`: `/api/config/public` | `server/src/routes/config.ts` | supertest | T08 | S |
| T13 | 보안 미들웨어: helmet + 커스텀 CSP(blob: 허용) + CORS 화이트리스트(production 닫힘) + rate limit | `server/src/middleware/{csp,cors,rateLimit}.ts` | curl 헤더 검사 + null/file origin 거부 확인 | T06 | M |
| T14 | `audit.ts` 미들웨어: mutating + read(patient/workspace/export) 자동 로깅 | `server/src/middleware/audit.ts` | supertest로 audit_logs INSERT 확인 | T07 | M |
| T15a | **Device registration API**: `POST /api/devices/register` (사용자 세션 + 공개키 + `build_target='intranet'` + 디바이스 메타). pending 상태로 저장. **남용 방지**: ① rate limit(분당 1회/IP, 시간당 5회/사용자) ② Origin 검증(인트라넷 도메인 또는 Electron app:// only) ③ User-Agent 검증(Electron 패턴 매칭, 일반 브라우저는 거부 가능 — 단 강력 보안은 아님, admin UI 보조 표시용) ④ admin UI에 origin/UA/IP 메타 표시. 테이블 신설: `devices(id, user_id, organization_id, public_key, build_target, status('pending'/'active'/'revoked'), approved_by, approved_at, registered_at, revoked_at, last_seen_at, register_origin, register_ua, register_ip)` | `server/src/routes/devices.ts`, `server/migrations/0002_devices.sql`, `server/src/middleware/rateLimit.ts` | supertest로 (a) 정상 등록 → 200 + pending (b) rate limit 초과 → 429 (c) 외부 origin → 403 | T11 | M |
| T15b | **Admin device approval UI + API**: `/admin/devices` 페이지(목록 + 메타 + 승인/거부 버튼) + `POST /api/admin/devices/:id/approve` / `POST /api/admin/devices/:id/revoke`. 의심 메타(예: 일반 브라우저 UA)는 빨간 배지 + 경고 메시지로 강조 | `server/src/routes/admin.ts`, `src/core/components/AdminDevicesPage.jsx` | (a) admin이 승인 → status='active' + approved_by/at 기록 (b) revoke → status='revoked' + 해당 device의 audit 호출 401 (c) 일반 사용자 접근 → 403 | T15a, T23 | M |
| T15c | **EMR audit endpoint + Ed25519 서명 검증**: `POST /api/audit/emr` — main이 Ed25519 서명(`X-WR-Device-Id`, `X-WR-Device-Sig`(base64), `X-WR-Device-Ts`) + `X-WR-Source: electron-main`(식별 메타). 서버 검증: ① device 서명 ② 일반 사용자 세션 ③ **session.user_id ≡ device.user_id ≡ device.organization_id 일치**, 불일치 시 401 + 별도 audit 액션 `device_user_mismatch` | `server/src/routes/audit.ts` | supertest로 (a) approved device 정상 서명 → 200 (b) pending device → 401 (c) 잘못된 서명 → 401 (d) revoked → 401 (e) session.user ≠ device.user → 401 (f) 일반 쿠키 + 서명 없음 → 401 | T15a, T15b, T14 | M |
| T16 | **Admin 부트스트랩 CLI**: `npm run server:seed:admin` (인자 없이 실행 → **stdin prompt로 비번 입력**, shell history 미노출). seed로 생성된 admin은 DB에 `must_change_password=true` 플래그 | `server/src/cli/seedAdmin.ts`, `server/migrations/0001_init.sql`(must_change_password 컬럼) | 빈 DB → seed 실행 → 로그인 가능, 사용자에 must_change_password=true | T11 | S |
| T16b | **`POST /api/auth/change-password` 서버 endpoint**: 현재 비번 검증 + 새 비번 정책(길이 ≥10, 영숫자+특수, 이전 5개와 중복 금지) + 변경 후 `must_change_password=false` + 모든 기존 sessions revoke (현재 세션 제외) | `server/src/routes/auth.ts`, `server/src/auth/passwordPolicy.ts` | supertest로 (a) 정상 변경 → 200 + 다른 세션 revoke (b) 현재 비번 오류 → 401 (c) 정책 위반 → 400 | T11 | S |
| T17 | `routes/workspaces.ts` Adapter (snapshot 보존 + patient_records 분해 + `?view=current`) | `server/src/routes/workspaces.ts` | supertest로 `mock-intranet-server.mjs`와 응답 동일성 비교 | T07, T11 | M |
| T18 | `routes/autosave.ts` (`?deviceId=` 필수) | `server/src/routes/autosave.ts` | supertest | T07, T11 | S |
| T19 | `Dockerfile` + `docker-compose.yml` (app + postgres) + 정적 자산 `dist/web/` 서빙 | `server/Dockerfile`, `docker-compose.yml`, `server/src/index.ts` | `docker compose up`으로 풀 스택 부팅 + 호환 API/auth 동작 확인 (EMR audit는 별도 검증) | T11, T12, T13, T17, T18 | M |

### Phase 1.5 — 운영 강화 (브랜치: `feature/server-ops`)
| ID | 작업 | 영향 | 검증 | deps | 규모 |
|---|---|---|---|---|---|
| T20 | Caddy 컨테이너 + 내부 CA 자동 인증서 발급 | `caddy/Caddyfile`, `docker-compose.yml` | https://wr.hospital.local 접근 + 체인 확인 | T19 | M |
| T21 | `docs/INTRANET_DEPLOYMENT.md`: 내부 CA 루트 클라이언트 PC 설치/갱신 절차 + 1년 만료 알림 | `docs/INTRANET_DEPLOYMENT.md` | 문서 리뷰 | T20 | S |
| T22 | **Backup/Restore runbook**: `pg_dump` 일일 cron + GPG 암호화 + 외부 격리 매체 보관 + 분기 1회 복구 리허설. **권한 매트릭스**: GPG 키 보관자(병원 정보보안팀), 복구 승인자(시스템 관리자 + 보안팀 2인 승인), 복구 테스트는 production DB가 아닌 비식별화된 샘플 사용. **Retention 정책**: 일일 백업 30일 보관, 월간 백업 1년, 연간 백업 5년(audit과 정합), 이후 GPG 암호화 폐기 절차(매체 복호화 키 파기 + 매체 물리 파쇄). **GPG key rotation**: 매년 1회 rotation, 이전 키는 5년 보관 후 파기 | `scripts/backup.sh`, `scripts/restore.sh`, `docs/BACKUP_RESTORE.md`, `docker-compose.yml` (cron sidecar) | 백업 → 다른 환경에서 복구 → 데이터 일치 검증 + runbook 권한 매트릭스 + retention/rotation 일정 리뷰 | T19 | M |
| T23 | `wr_audit_reader` role + connection pool 분리 + `/admin/audit` 조회 페이지 | `server/migrations/0002_audit_role.sql`, `server/src/routes/admin.ts` | role별 권한 SQL 검증 | T14 | M |
| T24 | audit_logs 월별 파티셔닝 + 자동 파티션 cron | `server/migrations/0003_audit_partition.sql`, `scripts/audit-partition.sh` | 파티션 자동 생성 확인 | T23 | S |

### Phase 2 — 클라이언트 결합 (통합 브랜치: `feature/intranet-backend`)
| ID | 작업 | 영향 | 검증 | deps | 규모 |
|---|---|---|---|---|---|
| T25 | `useServerConfig` hook + 부팅 게이팅 + config 실패 시 fail-closed (intranet 모드는 localFallbackAllowed=false 강제) | `src/core/hooks/useServerConfig.js`, `src/App.jsx` | mock 서버 down 시 fallback 차단 확인 | T12 | M |
| T26 | `csrfCookie` util + `httpClient` 인터셉터 (credentials, X-CSRF-Token, 401 → refresh 1회) | `src/core/utils/csrfCookie.js`, `src/core/services/httpClient.js` | 새로고침 후 첫 요청 → refresh 자동 | T11 | M |
| T27 | **다중 탭 refresh race 해소**: BroadcastChannel(`wr-auth`) 신설, refresh 진행 중 lock + 결과 broadcast → 다른 탭은 새 access 받아 재시도 | `src/core/services/httpClient.js`, `src/core/auth/authChannel.js` | 두 탭 동시 401 → 한 번만 refresh, 모두 통과 | T26 | M |
| T28 | `AuthContext` `login`/`logout` 액션 + session에서 refresh/localStorage 분리 | `src/core/auth/AuthContext.jsx`, `src/core/auth/session.js` | 로그인 → 새로고침 → 세션 유지 | T27 | M |
| T29 | `LoginModal` + isAuthenticated 가드 | `src/core/components/LoginModal.jsx`, `src/App.jsx` | 비로그인 시 모달 강제 | T28 | S |
| T29b | **ChangePasswordModal** + 로그인 직후 `me.must_change_password=true`이면 강제 노출, 변경 전까지 다른 UI 차단 | `src/core/components/ChangePasswordModal.jsx`, `src/core/auth/AuthContext.jsx` | seed admin으로 첫 로그인 → 모달 강제 + 변경 후 정상 진입 | T16b, T29 | S |
| T30 | `workspaceRepository.shouldFallbackToLocal` → server config 기반 분기 | `src/core/services/workspaceRepository.js` | docker stop 시 저장 실패 알림, 로컬 미오염 | T25 | S |
| T31 | `useAIAvailable` + AI 패널/버튼 가시성 + `analysisClient`를 `/api/ai/analyze`로 | `src/core/hooks/useAIAvailable.js`, `src/core/services/analysisClient.js` | aiEnabled=false 시 UI 비활성 + CSP 외부 fetch 차단 | T25 | M |
| T32 | `SettingsModal` 운영 모드 read-only + `/api/auth/me` 연결 확인 | `src/core/components/SettingsModal.jsx` | UI 토글 비활성 확인 | T25 | S |
| T33 | Electron preload 분리(`preload-standalone.js` / `preload-intranet.js`) + EMR origin 게이트 (preload + ipcMain 양쪽) | `electron/preload-*.js`, `electron/main.js` | 인트라넷 빌드에서 EMR 동작, 외부 origin sender ipc 거부 | T26 | M |
| T34 | **EMR audit (main process + Ed25519 서명 + 암호화 로컬 fallback + 세션 만료 대응)**: ipcMain handler가 EMR 호출 전후 main process에서 (a) `session.defaultSession.cookies`로 wr_refresh+wr_csrf 추출 (b) `safeStorage`에서 device private key 로드 (c) Ed25519 서명 → `/api/audit/emr` 전송 + main pino 로그. **첫 실행 시** device 미등록이면 `/api/devices/register` 호출 후 admin 승인 대기 모달(승인 전 EMR 호출 차단). 서버 전송 실패 시 `%APPDATA%/wr-evaluation-unified/audit-emr-pending.enc`에 **electron `safeStorage`로 암호화** 후 누적. **최소 필드만 저장**: actor_user_id, actor_org_id, action, target_id_hash(sha256(patient.id)), at, outcome, sender_origin, device_signature. 부팅 시·5분 주기 재전송 → 성공 라인 즉시 fsync 후 안전 삭제. **재전송 시 세션 만료 대응**: 큐 entry에 actor snapshot이 함께 보관되어 있으므로 device 서명만으로 서버가 받되, audit row의 `extra.session_missing=true` + `extra.actor_from_queue=true` 플래그로 표시. **safeStorage 복호화 실패 정책**: 깨진 파일을 `audit-emr-pending-corrupt-{ts}.bin`으로 rename, pino error 로그, 서버에 별도 audit 액션(`audit_queue_corrupt`)으로 관리자 알림, 새 빈 큐 시작 | `electron/main.js`, `electron/audit.js`, `electron/auditQueue.js` | (a) 렌더러 audit POST 우회해도 server audit_logs에 main 측 row 존재 (b) 서버 down 시 로컬 큐 암호화 확인(평문 read 거부) (c) 복구 시 자동 재전송 + 큐 파일 비워짐 (d) safeStorage 손상 시 corrupt 파일 보존 + 관리자 알림 audit row 생성 (e) 강제 로그아웃 후 재전송 시 session_missing 플래그 기록 | T15a, T15b, T15c, T33, T35 | M |
| T35 | `package.json` scripts `electron:build:standalone` / `electron:build:intranet` + `WR_BUILD_TARGET` env | `package.json`, `electron/main.js` | 두 빌드 모두 성공 + 분기 동작 | T33 | S |

### Phase 2.5 — Mock UI 검증 (통합 브랜치: `feature/intranet-backend`)

| ID | 작업 | 영향 | 검증 | deps | 규모 | 상태 |
|---|---|---|---|---|---|---|
| T-mock | mock 서버 auth stub 추가 (포트 3001, 쿠키 헬퍼, 7개 엔드포인트, CORS 수정) + `useServerConfig` StrictMode freeze 수정 + AbortController 타임아웃 + SettingsModal 로그아웃 버튼 | `scripts/mock-intranet-server.mjs`, `src/core/hooks/useServerConfig.js`, `src/core/services/httpClient.js`, `src/core/components/SettingsModal.jsx` | 시나리오 A~F2 수동 통과 | T25~T35 | M | ✅ **완료** |

---

### Phase 3 — 환자 1급 API + 동기화 (통합 브랜치 계속)
| ID | 작업 | 영향 | 검증 | deps | 규모 |
|---|---|---|---|---|---|
| T36 | 서버 `routes/patients.ts`: GET list/search, GET one, POST(Idempotency-Key 저장 테이블), PATCH(If-Match), DELETE(?revision=). **파생 컬럼은 zod 검증 후 앱 서버에서 명시 계산** | `server/src/routes/patients.ts`, `server/migrations/0004_idempotency.sql` | supertest 충돌/멱등 시나리오 | T11, T14, T17 | M |
| T36b | **환자 soft delete 시 snapshot PHI 비식별화 + retention 정책** (T36 DELETE 구현과 함께): `DELETE /api/patients/:id` 시 모든 `workspaces.snapshot_payload` 내 해당 환자 entry를 비식별화(name/patient_no/birth_date 필드 redact, payload 본문 제거, `redacted: true` 플래그). 워크스페이스 retention = 5년 후 자동 cleanup 잡. 관리자 강제 삭제 `DELETE /api/admin/workspaces/:id/purge` 제공 | `server/src/routes/patients.ts`, `server/src/routes/admin.ts`, `server/src/jobs/workspaceRetention.ts`, `server/migrations/0005_workspace_retention.sql` | (a) 환자 삭제 후 워크스페이스 조회 시 해당 entry redacted 표시 + UI 회색 처리 (b) 5년 경과 워크스페이스 cleanup 잡 동작 (c) admin purge + audit 기록 | T36 | M |
| T37 | 클라 `patientServerRepository.js` + `patient.sync` 활용 push/pull | `src/core/services/patientServerRepository.js` | 다중 클라이언트 동시 PATCH → 409 + 충돌 모달 | T36, T28 | M |
| T38 | 백그라운드 동기화: 5분 주기 + window focus pull + 즉시 push | `src/core/hooks/usePatientSync.js`, `src/App.jsx` | 두 PC에서 동기화 시각 확인 | T37 | M |
| T39 | 충돌 해결 모달 (내 버전/서버 버전/병합) | `src/core/components/ConflictResolveModal.jsx` | 강제 충돌 시나리오 | T37 | M |

### Phase 4 — 보안/감사 강화 (통합 브랜치 계속)
| ID | 작업 | 영향 | 검증 | deps | 규모 |
|---|---|---|---|---|---|
| T40 | mutating 정책 차등(PATCH=If-Match, POST batch=Idempotency-Key, DELETE=?revision=) 클라 측 강제 | `src/core/services/httpClient.js`, `patientServerRepository.js` | If-Match 누락 시 400 검증 | T36 | S |
| T41 | CSP/CORS production 검증 스크립트 (blob: 동작 포함) | `scripts/verify-csp.mjs` | npm script 헤더 검사 자동화 | T13 | S |

### Phase 5 — 마이그레이션 (통합 브랜치 마무리)
| ID | 작업 | 영향 | 검증 | deps | 규모 |
|---|---|---|---|---|---|
| T42 | `LocalToServerMigrator`: localStorage 4개 키(presets 제외) → POST /api/patients (Idempotency-Key=local id) | `src/core/services/localToServerMigrator.js`, 진입점 hook | 로컬 환자 5명 → 인트라넷 전환 → 서버 5명 + 재실행 중복 없음 | T36, T28 | M |
| T43 | 마이그레이션 결과 리포트 모달 + 실패 보류 큐 + **presets 로컬 보존 안내 강화**: "직업 프리셋은 이 PC에만 저장됩니다. 다른 PC에서도 사용하려면 [프리셋 export] 후 새 PC에서 [import] 하세요" 명시 + export/import 버튼 링크. **운영 모드 settings에 "프리셋 로컬 저장 허용" 플래그를 명시적으로 표시** (운영 정책상 환자 PHI는 아니지만 사용자 업무 데이터가 PC에 남는다는 사실을 정보보안팀이 인지하도록) | `src/core/components/MigrationReportModal.jsx`, `src/core/components/SettingsModal.jsx` | 부분 실패 시나리오 + presets 안내 + export/import 동선 + Settings에 옵트인 표시 | T42 | S |

### 머지 게이트
- **전제 조건 (T00에서 정의)**: root `package.json`에 `test`(vitest), `lint`(eslint), `typecheck`(tsc --noEmit), `build:web`(vite build), `electron:build`(현행) 스크립트 실재. server에는 `test`(vitest), `lint`, `typecheck` 실재.
- 각 Phase 종료 시: 해당 Phase 모든 T## 통과 + 다음 모두 0 exit:
  - `npm run lint`
  - `npm test`
  - `npm run typecheck` ← `shared/contracts/*.ts` + 향후 `server/*.ts` 등 신규 TS 파일 전용. 기존 JS/JSX는 `npm run lint`(ESLint)가 커버
  - `npm run build:web`
  - `npm run electron:build` (Phase 0/1) 또는 `electron:build:{standalone,intranet}` (Phase 2 이후, T35에서 정의)
  - `cd server && npm test && npm run lint && npm run typecheck`
- 통합 브랜치 → main 머지 직전: 전체 검증 항목(위 "검증 방법") 수동 점검표.
