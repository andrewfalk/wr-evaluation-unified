# 전체 코드베이스 리팩터링 밑그림 v2 (2026-10-15 작성 · 2026-10-18 갱신 — 진단 기준 main 5604f36·v7.1.3, Phase H 완료 시점 main 77e6686·v7.1.4)

> **정본**: 저장소 `docs/REFACTORING_ROADMAP.md` · **상태**: 계획 확정(2026-10-15, Codex 리뷰 5회 반영) · **Phase H(7.1.4 보안 핫픽스) 코드·릴리스 문서 main 머지 완료**(PR #159~#172, 2026-10-18, HEAD `77e6686`, 버전 7.1.4 — 업데이트 피드 서명 HF8 포함, 메모리 `project_phase_h_hotfix_plan`) · **7.1.4는 미배포**(Electron 설치본 빌드 → 서명 키로 패키징 → `docs/UPDATE_7.1.4.md` 릴리스 게이트 → 운영 배포는 사용자 몫) · **트랙 P(성능) 추가(2026-10-16)** · 운영은 v7.1.3 배포 완료·정상 구동(2026-10-16 사용자 확인) · **새 세션 시작점**: 맨 아래 "착수 순서" — 7.1.4 배포 게이트 확인 후 Phase 0 착수, 각 Phase는 착수 시 세부 플랜(플랜 모드 + codex 루프)을 다시 세운다. 근거 라인(file:line)은 부록 B 기준이며 코드가 바뀌면 재확인할 것.

## Context

- 요청: "코드베이스 전체를 리팩터링한다면 어떤 식으로 진행하는 게 좋을까 — 큰 밑그림" + "검토 중 발견한 **보안 헛점을 반드시 포함해 보완하면서** 리팩터링".
- 배경: 지난 1년(425 커밋)간 통계 워크벤치·영상분석·직력 제외·권한자 해제 등 기능이 집중 추가되며 거대 파일(App.jsx 1,002 / patients.ts 1,680 / statsEngine.ts 1,454 / main.js 1,396), 쌍둥이 모듈(팔꿈치↔손목 2,000줄×2), 의학 서술 텍스트 3벌, 서버 계층 부재(라우트 안 SQL 193곳, `patient_records` 쓰기 경로 7개), 플랫폼 분기 산재가 누적됨. 안전망은 테스트 ~4,100케이스로 두텁지만 **CI가 없고 .jsx는 린트된 적이 없으며 src/는 타입검사 0**.
- 보안 점검(읽기 전용): Critical 0 / High 5 / Medium 10 / Low 17. 핵심은 ① 워크스페이스 저장으로 조직 내 임의 환자 덮어쓰기(인가 우회) ② 외부 AI 벤더로 PHI 전문 전송 + Vercel 프록시 무인증 ③ 자동업데이트 미서명. 세션/CSRF/org 스코프/파라미터화 SQL/업로드 검증/통계 억제는 잘 되어 있음(보존 대상).
- 목표: (1) 운영 중 항상 배포 가능한 상태로 (2) 보안 결함을 먼저 닫고 (3) 플러그인 경계·계층·단일 소스를 복원해 고관절 등 다음 모듈을 core 수정 없이 붙일 수 있게 (4) 그 과정에서 클라이언트를 TS로 점진 전환.

**검토 이력**: Codex CLI 리뷰 루프 5회(2026-10-15, 읽기 전용 샌드박스, 저장소 대조) — 지적 20건(7→5→2→3→3) 전부 반영. 주요 수정: HF1 두 단계 upsert+advisory lock·revision 검사·leaseToken 계약·`saved/skipped/conflicts/lockedByOther` 응답, HF7 외부 벤더는 서버측 구조화 프롬프트만(자유서술 불가)·공용 코드를 `@wr/contracts`로, HF8 `files[]` 전수 비교·채널별 yml 서명·`crypto.verify(null,…)`, P0-7 `exports` 조건+Node16+Docker 같은 PR, S7 `correctIdentity` 앵커 예외, S8 namespace를 enqueue·sweep·캐시·합류·유일 인덱스까지, M6 암호화 범위 전체+이관 리더, M9 DB 역할 3분리, E4 `zod` 유지. 남은 세부는 각 Phase 착수 시 세부 플랜+루프로 재검증.

## 사용자 결정 (확정)

| # | 결정 | 영향 |
|---|---|---|
| D1 | 유지 배포 형태: **Electron 인트라넷(운영) · Electron 독립형 · Vercel 웹**. mock-intranet 개발 서버는 **유지하되 정리** | 플랫폼 5축 유지, 어댑터로 집중 |
| D2 | **Win7 호환 유지, 하한은 Chrome 109**(Win7 마지막 크롬) | vite target `chrome109`, browserslist 기반 lint. ⚠ 2026-06 현장 크롬에서 `Object.hasOwn`(93+)이 깨진 기록 → **현장 PC 1대 `chrome://version` 확인을 target 상향 머지 게이트로**(P0-5) |
| D3 | 클라이언트 **TS 점진 전환**(allowJs+checkJs → 분할/수정하는 파일부터 .ts/.tsx) | C11 규칙 |
| D4 | **main에 소형 PR 연속**, 기능 개발 병행 | PR 3종 라벨(move/safe/flagged), freeze window 규칙 |
| D5 | 보안 hotfix-first 항목은 **7.1.4 보안 패치로 먼저** 릴리스·배포(운영 7.1.3 → 7.1.4; 7.1.3은 2026-10-16 배포 완료·정상 구동) | Phase H |
| D6 | AI PHI: **외부 벤더(Gemini/Claude)만 비식별, 내부 LLM은 전문 허용** | HF7 |
| D7 | Vercel 웹 AI: **배포 비밀키 + rate limit + origin 403**로 유지(번들 토큰의 한계 인지) | HF7(b) |
| D8 | 코드서명 당장 불가 → **대안**: 배포 전용 Ed25519 키로 채널별 피드 yml(`latest.yml`·`canary.yml`) 서명·앱 검증 + updates 폴더 권한 최소화 (electron-updater는 업그레이드하지 않음 — 해당 권고가 미서명 설치본·무토큰 피드에는 적용되지 않고 Electron 22 호환 위험만 추가) | HF8 ✅ (**7.1.4에 편입**, 2026-10-18 — PC 셸 교체를 1회로 줄이려는 사용자 결정) |

## 진단 요약 (근거는 부록 B)

1. **안전망 공백**: CI 0, `eslint.config.mjs`에 `files` 없어 .jsx 134개 미린트, 루트 tsconfig가 src/를 포함 안 함, DB·Python 테스트는 기본 실행에서 조용히 skip, 로컬 Python 스택이 운영 핀과 다름, 포매터 없음·CRLF 276파일.
2. **빌드 분열**: npm workspaces 없이 4개 npm 트리·락파일. `@wr/*`를 루트 vitest만 소스로, 나머지(Vite·tsc·서버 tsc/vitest/tsx)는 dist로 해석 → stale dist·zod 이중 인스턴스·"테스트는 통과, 빌드는 실패". 지정자 2종(`@contracts` vs `@wr/contracts`).
3. **서버 계층 부재**: 라우트 안 `.query(` 193곳, `patient_records` 쓰기 경로 7개(완료추적·person 규칙 3벌 복제), 수동 BEGIN/COMMIT 18곳, 인가 검사 수작업(조직 검사 24회·담당의 규칙 5벌·락/If-Match 파서 3벌), `.catch(() => 500)` 64곳이 에러를 **로그 없이** 폐기, `stats*.ts` 55파일 평면 나열, 테스트 하네스 복붙(`makePool` 24벌, 가짜 pool이 쿼리 순서에 결합).
4. **클라이언트 god component + 경계 붕괴**: App.jsx(useState 22·훅 22·effect 9, `AppModals` 62 props), `patients` 쓰기 주체 10곳, core가 모듈 내부를 30곳 import(일괄 export·EMR 텍스트·통합 보고서가 6모듈 하드코딩), 의학 서술 텍스트 3벌(BK2117 규칙 4곳), 팔꿈치↔손목 쌍둥이(문구 이미 드리프트), 플랫폼 판정 산재(`window.electron` 60곳·인트라넷 판정 6벌·`getBaseUrl` 3벌), 주석이 참조하는 parity 골든 테스트가 **존재하지 않음**, index.css 4,051줄 단일.
5. **Electron 모놀리스**: main.js 책임 13개·IPC 29채널 중 standalone 전용 핸들러가 인트라넷 빌드에도 등록, preload가 raw IPC 이벤트를 페이지에 전달, AI 프록시가 `ALLOWED_MODELS` 검사 누락, PHI JSON을 `%TEMP%`에 기록, asar에 테스트·빌드 중간물·node_modules 60개.
6. **Node↔Python 이중 소스**: stats 프로토콜이 TS zod와 Python jsonschema 수기 이중화(버전 리터럴 7곳), 히스토그램 binning 양쪽 구현, pose CLI 인자 수기 중복. `CATALOG_VERSION` 수동 범프 가드 없음.
7. **문서 부패**: ARCHITECTURE_DIAGRAM·API_CONTRACT stale, 127파일이 존재하지 않는 계획서를 인용, changelog README/PRD 이중, ADR 없음.

## 기대 효과 (완료 시점 전/후)

| 영역 | 지금 | 완료 후 | 체감 |
|---|---|---|---|
| **보안** | 워크스페이스 저장으로 조직 내 임의 환자 덮어쓰기 가능, 외부 AI에 PHI 전문 전송, 웹 프록시 무인증, 업데이트 미서명, 임시비번으로 전체 API, preload raw IPC, xlsx/multer CVE, 감사 로그 앱 계정이 수정 가능, 독립형 PHI 평문 | 쓰기는 담당의·락·revision 3중 검사, 외부 AI는 비식별 구조화 값만(자유서술 불가), 웹은 토큰+rate limit+예산 상한, 업데이트 피드 서명 검증, 강제 비번 변경, IPC 타깃별 등록+sender 검증, CVE 0, 감사 테이블 INSERT 전용 역할, 독립형 저장본 암호화, 세션 절대 만료·계정별 잠금, 신규 라우트 fail-closed | 32건 종결(수용 2건 제외), 침해 시 피해 범위가 "한 계정·한 환자"로 축소 |
| **정확성** | 에러 64곳이 로그 없이 500, 의학 서술 텍스트 3벌(이미 문구 드리프트), `patient_records` 쓰기 규칙 7벌, 개발 서버가 운영/테스트 run 가로챔, 마이그레이션 조용한 드리프트 | 중앙 에러 핸들러+requestId 로그, 서술 단일 소스(소견서·EMR·Excel 문구 동일 보장), 쓰기 경로 1개(완료추적·person·락 규칙 전 경로 동일), 큐 namespace 격리, 체크섬, graceful shutdown | 운영 장애 원인 추적 가능, "출력물끼리 다른" 사고 재발 방지 |
| **확장성** | 고관절 모듈 추가 시 core ≥5파일 수정(export·EMR·보고서·일괄 import·fixture), 모듈 계약 검증 없음 | `src/modules/hip/` + analytics-core 모듈 1개만, core 수정 0(DoD에 더미 모듈로 증명), 매니페스트 검증으로 누락 즉시 실패 | 신규 부위 모듈 1~2주 → 수일 |
| **변경 비용** | App.jsx 1,002·patients.ts 1,680·statsEngine.ts 1,454·main.js 1,396·index.css 4,051, 같은 파일에 기능 PR 충돌, 쌍둥이 모듈은 버그 수정 2회 | App.jsx ≤200·라우트 ≤400·stats/ 폴더·main.js ≤150·CSS 기능별, elbow/wrist 순수층 1벌, 플랫폼 분기 1곳(60곳→1) | PR당 영향 반경·리뷰 시간 감소, 같은 버그를 두 번 고치는 일 없음 |
| **안전망** | CI 0, .jsx 미린트, src 타입검사 0, DB·Python 테스트 조용히 skip, 테스트 하네스 24벌(쿼리 순서 결합), vitest/빌드 해석 분열 | 모든 PR에 lint(.jsx)·typecheck(src 포함)·~4,400케이스·pytest·docker 빌드·컨테이너 기동, 골든 10종, 하네스 1벌(SQL 재배치해도 안 깨짐), workspaces 단일 해석 | "테스트는 통과, 빌드는 실패"·"수동으로 돌리는 걸 잊음" 소멸, src TS ≥80%로 깨진 import/props를 컴파일러가 잡음 |
| **운영** | 버전 4곳 수기, asar 81.6MB(테스트·중간물·60 패키지 포함), build-target 출하 사고 가능, 백업 export 미출하, access log 없음 | 범프 스크립트+CI 검증, asar <40MB, 타깃은 빌드 메타로 고정, 출하 목록 테스트, pino access log | 설치/업데이트 다운로드 절반, 릴리스 실수 자동 차단 |
| **문서** | 아키텍처·API 계약 stale, 127파일이 없는 계획서 인용, changelog 이중 | ADR + 생성된 라우트 표 + CHANGELOG 단일 | 다음 세션/기여자가 코드 주석의 인용을 따라갈 수 있음 |

**사용자(의사) 체감 변화**: 화면·기능은 동작 불변 원칙으로 거의 그대로. 달라지는 것 — 워크스페이스 저장 시 "제외/충돌" 알림, 외부 AI 소견 프롬프트가 비식별로 바뀜(내부 LLM은 그대로), 임시 비밀번호 즉시 변경 강제, 설치 파일 축소. 성능은 목표가 아니라 **별도 트랙 P로 추적**(기준선 측정 후 압축·캐시 헤더·지연 로딩부터 — 아래 "트랙 P" 섹션).

**대가**: 5–6개월·140–180 PR, 기간 중 기능 개발 속도 일부 저하, 7.1.4 보안 패치 배포(업데이트 서명 포함 — PC 셸 교체 1회), 운영 변경(DB 역할 분리·서명 키 보관·Caddy PKI 권고) 필요. 그대로 남는 리스크: Electron 22/Win7(수용), 내부 CA(운영 결정).

## 로드맵 개요

| Phase | 내용 | PR≈ | 기간≈ | 선행 |
|---|---|---|---|---|
| **H** | 7.1.4 보안 핫픽스(업데이트 피드 서명 HF8 포함) → 릴리스·배포 — ✅ **코드·릴리스 문서 머지 완료**(실제 14 PR: 코드 13 + docs 1, 2026-10-16~18), 배포 대기 | 10–12 | 1–2주 | – |
| **0** | 안전망: CI·lint·checkJs·workspaces·줄끝·골든 G1–G10·서버 하네스·Python 핀 | 20–25 | 2–3주 | H 배포 후 착수 권장(병행 가능) |
| **1** | 서버: 에러/인가 조합/라우트 분할/`patient_records` 단일 경로/stats 폴더/큐/종료/체크섬 + 보안 bundle | 35–45 | 4–6주 | 0 |
| **2** | 클라이언트: 플랫폼 어댑터/요청 계층/App 분해/스토어/매니페스트/경계/서술/쌍둥이/거대 컴포넌트/CSS/TS | 45–60 | 6–8주 | 0, E0 |
| **3** | Electron·패키징: main 분할/조건부 IPC/preload base/asar/build-target/버전 스크립트 | 12–15 | 2–3주 | 0(E0는 즉시) |
| **4** | 계약·Python: zod→JSON Schema 단일 소스/카탈로그 가드/analytics-core 쌍둥이/tsup glob | 8–10 | 2주 | 0 |
| **5** | 문서·위생: ADR/stale 문서/CHANGELOG/dead 삭제/계획서 인용 치환 | 8–10 | 1–2주 | 각 Phase 뒤 |
| **P** | **성능 트랙(횡단)**: 기준선 측정(P0-13) → 압축·캐시 헤더/지연 로딩(quick win 21·22) → 리팩터링 부산물 효과 명시(C4·E4) → 변경분 upsert·delta sync·상주 워커·PDF 교체(선택) | 6–10 | 해당 Phase에 병행 | 0(측정) |

1·3·4는 서로 독립(병렬 가능), 2는 0+E0 뒤. 총 ≈140–180 PR, 5–6개월(기능 개발 병행 기준). 각 Phase 착수 시 그 Phase의 세부 계획을 별도 플랜 모드로 다시 세운다(이 문서는 밑그림).

**공통 규칙**: PR 라벨 **`move`**(이동만, 로직 diff 0, `git diff -M --color-moved`로 리뷰, 당일 머지) / **`safe`**(동작 불변, 골든 스냅샷 변경 0) / **`flagged`**(동작 변경: ADR 한 줄 + 골든 갱신 + 승인). 크기 S≤200 / M≤800 / L>800 diff. 리팩터링 PR은 버전 범프 금지(릴리스는 별도 docs PR — 기존 관례).

---

## Phase H — 7.1.4 보안 핫픽스 (리팩터링 착수 전) — ✅ 코드 머지 완료(2026-10-18)

> **진행 상태(2026-10-18, Phase H 코드 머지 완료)**: 세부 구현 계획 확정(별도 플랜 + codex 루프 3회, 3회차 NO_ISSUES — 메모리 `project_phase_h_hotfix_plan`), 사용자 확정 결정 4건(Vercel rate limit = Upstash + env 미설정 시 503 fail-closed · 웹 번들 토큰 `X-WR-Client` 도입 · HF8 포함 유지 · 외부 AI 프롬프트에서 직종명 완전 제외). **HF1~HF9 전부 main 머지 완료**(PR #159~#167 + HF8 #169~#172 + 릴리스 docs #168, 2026-10-16~18, 버전 7.1.4 — 개별 결과는 아래 "Phase H 구현 결과" 표). 머지 순서: HF1(#159) → HF2(#160) → HF4+HF9 서버(#161) → HF3+HF9 Electron(#162) → HF5(#163) → HF6(#164) → HF7-1(#165)·7-2(#166)·7-3(#167) → HF8-1(#169)·8-2(#170)·8-3(#172, 후속 #171) → docs 7.1.4(#168). **HF8은 원래 7.1.5였으나 사용자 결정(2026-10-18)으로 7.1.4에 편입**(7.1.5에서 또 셸을 교체하지 않으려고). 세부 계획에서 정정된 사실: PATCH 충돌은 409 `currentRevision`(412 아님) · 락 토큰은 워크스페이스 본문 `lockTokens` 필드(`X-Lock-Token` 헤더는 단일 환자용) · `mustChangePassword`는 JWT 클레임(예외 경로는 `/api/auth/{me,change-password}`뿐 — logout·csrf·refresh는 인증 미들웨어를 거치지 않음) · preload `on*`는 7곳 · `setPermissionRequestHandler` 부재. **아래 표는 2026-10-15 밑그림 원문이며, 구현에서 달라진 점은 표 뒤 "Phase H 구현 결과" 절과 세부 플랜이 우선한다.**

모두 소형 PR → 버전 범프 docs PR(package.json·lock·README.md:3·docs/PRD.md:3-4 + `docs/UPDATE_7.1.4.md`; ✅ #168 머지) → Electron 설치본 빌드 → 서명 키로 오프라인 패키지 재생성 → 릴리스 게이트 → 배포(사용자, 미실행). 운영은 **7.1.3 배포 완료(2026-10-16, 정상 구동)** → 7.1.4는 핫픽스 변경분만 나감(마이그 0036·0037은 이미 적용됨).

> 아래 표는 **2026-10-15 밑그림 원문**이다(행의 ✅는 머지 완료 표시). 구현에서 달라진 점은 표 뒤 "Phase H 구현 결과" 절이 우선한다.

| # | 결함 | 수정 | 파일 | 검증 |
|---|---|---|---|---|
| HF1 | **H1** 워크스페이스 저장이 조직 내 임의 환자를 덮어씀 — ✅ **완료(PR#159, 2026-10-16)** | `upsertPatientRecord`(workspaces.ts:268-430)를 **두 단계 upsert**로 교체: 트랜잭션 시작 시 `pg_advisory_xact_lock(hashtext($id))`로 환자 id별 직렬화 → `SELECT … FOR UPDATE`로 존재 확인 → 기존 행이면 담당의-or-admin 검사(`middleware/patientAccess.ts:19-36` 술어 재사용) + 락 게이트(`patients.ts:233-263` 로직; **환자별 leaseToken 전달 계약을 같은 핫픽스에 추가** — 현재 `intranetWorkspaceRepository.js:66-74`는 락 토큰을 안 보내고 `patientLocks.ts:274-280`은 활성 락의 토큰 일치를 요구해 enforce 모드에서 본인 편집 환자 저장도 거부됨(Codex 지적): 클라이언트가 `lockTokenStore`의 토큰을 `patients[].leaseToken`으로 동봉, 서버는 본인 락+토큰 일치 허용·타인 락은 `lockedByOther[]`로 거부) + **revision 검사**(스냅샷 환자가 가진 서버 `sync.revision`(`patientRecords.js:3-75` 메타)과 행 `revision` 비교 — 불일치면 덮어쓰지 않고 `conflicts[]`로 보고, PATCH의 If-Match 충돌(`patients.ts:851`)과 같은 의미; Codex 지적: 현재 `:387-388`은 revision을 올리며 무조건 payload를 덮어써 더 새로운 진료 데이터가 유실됨) 재검증 후 UPDATE, 없으면 INSERT. 현재의 단일 `INSERT … ON CONFLICT DO UPDATE`(:367-397)는 폐기 — 두 요청이 모두 "없음"을 본 뒤 ON CONFLICT 경로로 비담당 요청이 담당 환자를 덮을 수 있음(Codex 지적). 비소유 환자는 **건너뛰고 응답에 `skipped[]` 보고**(저장 전체 실패 X), 환자별 감사 기록. **응답 계약**: `{ saved: [{id, revision}], skipped: [id], conflicts: [{id, serverRevision}], lockedByOther: [{id, holder}] }`(현재 `:648`은 스냅샷 목록만 반환 — Codex 지적: 성공한 환자의 권위 revision을 돌려주지 않으면 다음 저장/PATCH가 자기 저장과 충돌). 클라이언트(`intranetWorkspaceRepository.js:75-76` → `usePatientSync`의 ack 머지 `mergePushedPatientAck` 재사용)는 `saved[]`의 revision을 해당 환자 `sync`에 반영하되 저장 중 발생한 편집(dirty)은 보존. `flagged` | `server/src/routes/workspaces.ts`, `middleware/patientAccess.ts`, `shared/contracts/workspace.ts`, `src/core/services/intranetWorkspaceRepository.js`, `src/core/hooks/useWorkspacePersistence.js` | 라우트 테스트: 간호 계정이 비담당 환자 포함 저장 → 해당 환자 payload 불변 + skipped; 담당의는 현행 동작; **stale revision 저장 → payload 불변 + conflicts**; enforce 모드에서 본인 락+토큰 저장 성공·타인 락 환자 lockedByOther; 저장 성공 후 클라이언트 `sync.revision` 갱신 → 직후 PATCH가 412 없이 통과(저장 중 편집 보존 확인). **실DB 동시성 테스트**: 비담당·담당 계정의 동시 최초 저장 → 담당 payload 보존(기존 교훈: mock 통과만으로 끝내지 않음) |
| HF2 | **M1** 임시비번 강제변경 미적용 — ✅ **완료(PR#160, 2026-10-16)** | 인증 미들웨어(`createAuthMiddleware`) 안에서 JWT `mustChangePassword`면 `/api/auth/{me,change-password}` 외 403 `PASSWORD_CHANGE_REQUIRED`(logout·csrf·refresh는 이 미들웨어를 거치지 않아 예외 불필요); Electron은 임시비번 토큰으로 디바이스 등록 요청을 보내지 않음(분당 1회 IP 제한 소비 방지) | `server/src/middleware/auth.ts:53-61`, `routes/auth.ts` | 미들웨어 테스트 + 클라이언트 `ChangePasswordModal` 흐름 수동 확인 |
| HF3 | **M4** preload raw IPC 노출 + standalone 핸들러 무조건 등록 — ✅ **완료(PR#162, HF9 Electron 포함, 2026-10-17)** | 두 preload의 `on*` 11곳을 `(_e, ...a) => cb(...a)` 래퍼(해제용 map 보관)로; main.js `analyze-ai`(:693)·`load-legacy-data`(:778)·`fs-*`(:981-1144)는 `buildTarget==='standalone'`일 때만 등록; 모든 `ipcMain.handle`에 `event.senderFrame.url` origin 검사(EMR/마이그레이션 게이트 일반화) | `electron/preload-{intranet,standalone}.js`, `electron/main.js` | `electron/__tests__/ipcRegistration.test.js`(가짜 ipcMain: 타깃별 채널 집합), preload 단위 테스트(가짜 ipcRenderer: 콜백이 event 객체를 받지 않음) |
| HF4 | **L7** PHI 응답 디스크 캐시 가능 — ✅ **완료(PR#161, 2026-10-17)** | `app.use('/api', (…) => res.set('Cache-Control','no-store'))` 라우터 앞 한 줄(ETag 유지 — If-Match와 공존) | `server/src/index.ts:41` 부근 | supertest 헤더 테스트 |
| HF5 | **M8** multer 1.x CVE 4건 — ✅ **완료(PR#163, 2026-10-17)** | multer 2.0.2+, `limits: {fields, parts, fieldSize}` 추가, `@types/multer` 정렬 | `server/package.json:32`, `server/src/workers/videoUpload.ts:32` | videoAnalysis 테스트 + 업로드 수동 1회 |
| HF6 | **M7** xlsx 0.18.5 CVE 2건 — ✅ **완료(PR#164, 2026-10-17)** | `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`(동일 API, lock에 integrity 고정) | `package.json:52` | 기존 export/import 테스트 + 일괄 import·Excel 출력 수동 roundtrip |
| HF7 | **H2·H3·L1·L9(모델명)** AI 경로 — ✅ **완료(PR#165·#166·#167, 2026-10-17)** | **원칙: 외부 벤더 경로에서는 클라이언트가 보낸 자유 문자열 프롬프트를 절대 전달하지 않고, 전송 경계(서버/서버리스/Electron main)가 허용된 구조화 필드로만 프롬프트를 조립**(클라이언트 플래그 `deidentified:true`는 보장이 아님 — Codex 지적). (a) `shared/contracts/aiAnalysis.ts`: `AiAnalysisInputSchema`(`.strict()`): `ageYears`(만 나이)·`gender`·`activeModules`·진단 코드·모듈별 노출 지표(숫자/열거)·소견 요약 필드. 이름·생년월일·등록번호·병원/의사명·재해일 **필드 자체가 없음**; 자유서술(특이사항 등 — `BasicInfoForm.jsx:455-456`의 임의 문자열이 `reportGenerator.js:244`에서 보고서에 그대로 들어감)은 **외부 벤더 경로에서는 opt-in으로도 전송하지 않음**(정규식 필터로는 영문 이름·임의 등록번호·생년월일 문장을 못 거름 — Codex 지적; D6 원칙 보장 위해 외부는 검증된 구조화 값(숫자·열거·코드)만), 내부 LLM 경로에서만 `fullReport`/`freeText`로 허용. `reportGenerator.js:232-282`의 프롬프트 조립은 `buildAiInput(patient)`(구조화 입력 생성, 클라이언트)과 `shared/contracts/aiPrompt.ts`의 `buildPrompt(input, {external})`(입력 → 프롬프트 텍스트, 서버·서버리스·Electron 공용; tsup으로 `shared/dist/aiPrompt.{js,cjs}` 생성)로 분리. (b) `server/src/routes/ai.ts`: 요청 본문은 `AiAnalysisInputSchema`만 수용(`prompt` 문자열 필드 제거). 외부 벤더(`config.aiProvider` external)면 `buildPrompt(input, {external:true})`로 서버가 조립; 내부 LLM이면 `buildPrompt(input, {external:false})` + 선택적 `fullReport` 문자열 허용(D6). rate limit(`middleware/rateLimit.ts`), 입력 크기 상한, timeout, `err.message` 에코 제거(:135). (c) `api/analyze.js`: 동일 스키마·동일 빌더(외부 모드 고정), `X-WR-Client`≠`WEB_AI_CLIENT_TOKEN`(빌드 `VITE_WEB_AI_TOKEN`) → 403, Origin 허용목록 외 403, `@upstash/ratelimit`(IP 분/일 + 전역 일일 예산). (d) Electron 독립형 `main.js:693-775`: 동일 스키마·빌더(외부 모드) + `ALLOWED_MODELS` 검사(`aiModels.ts`) + 모델명 URL 경로 검증. (e) **공용 코드는 루트 `lib/`가 아니라 `@wr/contracts` 패키지에 두고, 패키징을 같은 PR에서**(Codex 지적 3건: asar `files`(`electron-builder.base.yml:5-9`)·`server/Dockerfile:125` COPY에 `lib/`가 없고, 서버는 `/app/dist/routes`에서 실행되어(`server/tsconfig.json:9-10`, `Dockerfile:76`) 루트 `lib` 상대경로가 `/lib`로 해석되며, tsup은 고정 엔트리라 파일 추가만으론 dist에 안 나옴): `shared/contracts/{aiAnalysis,aiPrompt,aiRequest,aiModels}.ts`(Node 16 호환 출력)를 `shared/tsup.config.ts:4-14` 고정 엔트리에 추가 + `shared/contracts/index.ts` 재수출 + `exports` 서브패스 확인(glob 전환은 K4). 소비 경로: 서버 `import { buildPrompt } from '@wr/contracts/aiPrompt'`(Docker는 이미 `node_modules/@wr/contracts`에 dist 복사 — `Dockerfile:132-140`), Electron main `require(path.join(app.getAppPath(), 'shared/dist/aiPrompt.cjs'))`(`electron-builder.base.yml` `files`에 `shared/dist/**`·`shared/package.json` 추가; zod는 루트 dependencies — E4에서도 유지), Vercel `api/analyze.js`는 `../shared/dist/aiPrompt.js`(`prebuild:web`이 dist 생성, 파일 추적 자동 포함 — preview에서 확인). 루트 `ai-models.config.cjs`의 allowlist는 `aiModels.ts`로 이전(파일 삭제, builder `files`·`api/analyze.js:50` import 갱신). `flagged` | `shared/contracts/{aiAnalysis,aiPrompt,aiRequest,aiModels}.ts`(신규), `shared/tsup.config.ts`, `shared/contracts/index.ts`, `src/core/utils/reportGenerator.js`, `src/core/services/analysisClient.js`, `server/src/routes/ai.ts`, `server/src/routes/config.ts`, `api/analyze.js`, `electron/main.js`, `electron-builder.base.yml`, `server/Dockerfile`, `vercel.json`(env) | 계약 테스트: 스키마가 name/birthDate/patientNo/hospitalName/doctorName 키를 거부(`.strict()`); 빌더 골든: 외부 모드 프롬프트에 식별 필드 부재; 서버: `prompt` 문자열 본문 → 400, 외부 벤더 설정에서 `fullReport`/`freeText` 필드 포함 요청 → 400(필드 자체 거부); Vercel preview: 토큰 없음 403·초과 429; **설치본(독립형 NSIS) + 컨테이너 기동 후 AI 분석 1회 실행**(`shared/dist` 포함·`@wr/contracts/aiPrompt` 해석 실측), `asar list`에 `shared/dist/aiPrompt.cjs` 존재 확인 |
| HF8 (~~7.1.5~~ → **7.1.4 편입**) | **H4** 업데이트 미서명 — ✅ **완료(PR#169·#170·#171·#172, 2026-10-18)**. 아래 수정 칸의 `electron/updater.js` 분리와 electron-updater 6.3+ 업그레이드는 **실제로 하지 않았다**("Phase H 구현 결과" 참조) | `scripts/sign-update-feed.mjs`(오프라인 Ed25519 개인키로 **패키지가 생성하는 모든 채널 yml**(`latest.yml` + `canary.yml` 등 `export-offline-package.ps1:383`이 출하하는 것 전부)의 **바이트 전체**를 각각 서명 → `<channel>.yml.sig`; 채널 누락 시 스크립트 실패), `updates.ts`가 `.sig` 서빙, `electron/updater.js`: `autoDownload=false`, `update-available(info)` 시 **`updateFeed.js:15`가 실제 선택한 채널의 yml**+대응 `.sig`를 직접 fetch(Codex 지적: latest만 서명하면 canary 채널 클라이언트는 영구 차단) → `crypto.verify(null, ymlBytes, publicKey, sig)`(**Ed25519는 알고리즘 인자가 `null`** — `electron/audit.js:170`의 서명 호출과 대칭; `'ed25519'`를 넘기면 `ERR_CRYPTO_INVALID_DIGEST`) → 검증된 yml을 `js-yaml`로 파싱한 문서와 `info`를 **전수 비교**: `version`·`path`·`sha512`·`releaseDate`·**`files[]`의 각 `url`/`sha512`/`size`**(electron-updater는 실제 다운로드에 `files[].url/sha512`를 사용 — `Provider.js:90`, `AppUpdater.js:495` — 최상위 `sha512`만 비교하면 우회됨, Codex 지적). 하나라도 불일치·`.sig` 부재·파싱 실패 → 중단+감사 로그; 모두 일치할 때만 `downloadUpdate()`. 다운로드 후 electron-updater의 sha512 검사는 그대로 2차 방어. ~~electron-updater 6.3+ 업그레이드~~(하지 않음). 공개키는 앱에 내장. 릴리스 절차(서명 단계·키 보관)·`./updates` 쓰기 권한 최소화 문서화. `flagged` | `electron/main.js:119-300`(→ `electron/updater.js`), `server/src/routes/updates.ts`, `scripts/{sign-update-feed.mjs,export-offline-package.ps1}`, `docs/PRODUCTION_RELEASE_PLAN.md` | `updateFeed` 테스트 확장: 서명 불일치·`files[].sha512`만 변조·`url` 변조·`.sig` 부재 각각 다운로드 거부, 정상 피드 허용, **canary 채널 선택 시 `canary.yml`+`canary.yml.sig` 검증·canary→latest 전환**; Node 16(Electron 22) 런타임에서 `crypto.verify(null, …)` 실측; 설치본 업데이트 경로 수동(latest·canary 각 1회) |
| HF9 | 소형 보안 quick win 묶음 — ✅ **완료(서버 부분 PR#161, Electron 부분 PR#162, 2026-10-17)** | `.dockerignore`에 `*.asc`·`wr-backup*`·`target_webpage*`; `csrf.ts:8` `EXEMPT_PATHS` dead code(`req.originalUrl` 기준); Electron `setPermissionRequestHandler` 전부 거부 + 독립형 `will-navigate`/`setWindowOpenHandler` 가드(`main.js:310-321`, :519-527) | `.dockerignore`, `server/src/middleware/csrf.ts`, `electron/main.js` | 기존 테스트 + 수동 |

### Phase H 구현 결과 (2026-10-18)

| PR | 머지 | 내용 | 밑그림과 달라진 점 |
|---|---|---|---|
| #159 HF1 | 10-16 `77eedf1` | 워크스페이스 저장에 담당의·revision·편집 락 검사, 두 단계 upsert | 충돌은 409 `currentRevision`(412 아님), 락 토큰은 본문 `lockTokens`. 외부 리뷰 3라운드로 보강: 저장 직후 본인 환자가 읽기 전용이 되던 문제(`assignedDoctorUserId` 반영)·스냅샷 보정이 삭제나 더 최신 저장을 덮던 회귀(원자적 SQL + 버전 조건)·자동 PATCH와의 겹침(충돌 자동 해제는 `kind:'push'` 저장 충돌에만). 실DB 통합 17건 |
| #160 HF2 | 10-16 `b3764a2` | JWT `mustChangePassword`면 `/api/auth/{me,change-password}` 외 403 | Electron은 임시 비밀번호 토큰으로 디바이스 등록 요청 자체를 생략(분당 1회 IP 제한 소비 방지) |
| #161 HF4+HF9 서버 | 10-17 `f20bd8d` | `/api` 응답 `no-store`, `csrf.ts` 죽은 예외 제거, `.dockerignore` | – |
| #162 HF3+HF9 Electron | 10-17 `ad6909c` | `ipcGuard.js`(타깃별 등록·sender 검증)·`navigationGuard.js`·`permissionPolicy.js`, 두 preload에서 이벤트 객체 제거 | 권한은 전부 거부가 아니라 `clipboard-sanitized-write`만 허용(관리자 콘솔 임시 비밀번호 복사). 새 창은 `openExternal` 없이 전부 deny. `blob:` 내비게이션은 허용(내보내기). preload `on*`는 11곳이 아니라 7곳 |
| #163 HF5 | 10-17 `84544b0` | multer `^2.4.0`, 영상 업로드 `files:1`·`fields:0` | `parts`는 생략(총 파트가 이미 1개로 묶임). 실측으로 재현된 실제 차이는 끊긴 업로드의 임시 파일 누수 제거 |
| #164 HF6 | 10-17 `2a2562c` | xlsx 0.20.3(SheetJS CDN 타르볼) | ESM 네임스페이스 재정의 불가로 `vi.spyOn(XLSX,…)` → `vi.mock`, Node 스크립트는 `XLSX.set_fs(fs)` 필요. 빌드 PC는 `cdn.sheetjs.com` 접근 필요 |
| #165~#167 HF7 | 10-17 `3340fc3`·`c5d203c`·`b8a75b3` | AI 3경로(인트라넷·Vercel·Electron 독립형)가 `.strict()` 구조화 입력(숫자·열거형)만 받고 전송 경계가 프롬프트를 조립. Vercel은 Origin 403 + `X-WR-Client` 토큰 + Upstash 속도 제한·일일 예산(fail-closed) | 계약은 `aiModels`/`aiAnalysis`/`aiPrompt` 3파일(요청 봉투 검증은 `electron/aiRequest.js`). Vercel 함수는 `shared/dist/*.cjs`를 import(Vercel이 `api/*.js`를 CJS로 변환 → ESM dist는 Node 20.18/22.11에서 `ERR_REQUIRE_ESM`, 미리보기 `FUNCTION_INVOCATION_FAILED`로 재현). Upstash는 시간 초과를 예외가 아니라 `reason:'timeout'` 반환값으로 알리므로 장애로 처리. 인트라넷 AI 서버 경로는 운영이 `AI_PROVIDER=none`이라 휴면(내부 LLM 도입 시 compose AI 환경변수 전달 등 별도 PR) |
| #169~#172 HF8 | 10-18 `5096b1b`·`fa3445f`·`bf36e33`·`9fe8afc` | 업데이트 피드 Ed25519 서명 — 검증 모듈·서명 도구(`--generate-keypair`/`--sign`/`--verify`)·공개 키 내장, 셸이 서명을 확인한 뒤에만 `downloadUpdate()`(`autoDownload=false`), 패키징에 서명 → 사전 검증 → 쌍 복사 → 재검증 | 7.1.4에 편입. electron-updater 업그레이드와 `electron/updater.js` 분리는 하지 않음(검증은 순수 모듈 `updateFeedVerify.js` + `main.js` 연결). yml을 파싱해 electron-updater의 `info`와 `isDeepStrictEqual`로 전체 비교. 공개 키 목록이 비면 모든 업데이트 거부(fail-closed), 키 교체를 위해 복수 키 지원. 패키징은 `-UpdateSigningKey`(기본 필수)·`-AllowUnsignedUpdateFeed`. 서명 통과 뒤 다운로드가 연속 실패해도 재시도 간격이 늘도록 실패 횟수 초기화를 `update-downloaded` 시점으로 이동(#171) |
| #168 docs | 10-18 `77e6686` | 버전 7.1.4, README·PRD 변경 이력, `docs/UPDATE_7.1.4.md` | 마이그레이션 없음(0037 그대로) |

**남은 것 · 수용한 한계(배포 전 확인)**

- **릴리스 게이트 미통과**: Electron 설치본 수동 점검 전부와 서명 업데이트의 실기기 시험(성공 + yml 변조·`.sig` 삭제·다른 키 거부)은 아직 실행하지 않았다. 통과 전에는 7.1.4를 배포하지 않는다(`docs/UPDATE_7.1.4.md`).
- **7.1.3 → 7.1.4 전환은 서명 보호 밖**: 7.1.3 이하 셸에는 검증기가 없다. 코드서명(Authenticode)도 여전히 없다. 서명 키를 분실하면 모든 PC의 셸을 재배포해야 하고, 교체는 새 공개 키를 셸 목록에 먼저 추가하는 과도기 릴리스를 거친다.
- **운영 전제**: Vercel Production·Preview에 `WEB_AI_CLIENT_TOKEN`·`VITE_WEB_AI_TOKEN`(같은 값)과 Upstash env가 없으면 웹 AI는 503으로 닫힌다. 미리보기에서는 실제 AI 호출까지 확인했고, 운영 주소에서의 호출은 미확인이다.
- **구 셸 + 7.1.4 서버 조합**: 디바이스가 active가 아닌 PC에서 임시 비밀번호로 로그인하면 디바이스 등록이 최대 20분 늦어진다(앱 재시작으로 해소). 사용자 결정으로 서버 예외 없이 유지하고 안내서에 명시했다.

**M10(내부 CA 전역 신뢰)**는 코드가 아니라 운영 변경(병원 PKI 또는 name-constrained CA, 또는 Electron 핀) → `docs/INTRANET_DEPLOYMENT.md`에 권고 절차 추가(Phase 5 D2), 실행은 사용자 결정.

---

## Phase 0 — 안전망 (전부 병행 가능; P0-3·P0-10 → G5 순서만 고정)

| # | 목표 | 파일/내용 | 재사용 | 위험/크기 | 검증 |
|---|---|---|---|---|---|
| P0-1 | GitHub Actions CI 6 job: 루트 vitest / 서버 vitest(postgres:16 service + `TEST_DATABASE_URL` + `migrate`) / pytest(Python 3.11, 운영 핀) / lint(루트+서버) / typecheck / `build:web` + docker build | `.github/workflows/ci.yml` | `server/src/db/migrate.ts`, `docker-compose.yml` | L/M | no-op PR에서 전부 green |
| P0-2 | 조용한 skip 금지 | `server/src/testing/env.ts` `requireIntegrationEnv()`; `skipIf(!TEST_DATABASE_URL)` 15파일을 "CI면 실패, 로컬은 skip+경고"로 | – | L/S | `CI=1` env 누락 시 실패 |
| P0-3 | `createApp(deps)` 추출(`move`) — 테스트가 실제 app을 띄울 수 있게 | `server/src/app.ts`(신규), `index.ts`는 부팅만; `db/client.ts:3` 즉시 pool 생성 제거 → `createPool(config)` | `createConfig` | L/M | 서버 1,602케이스, docker |
| P0-4 | **.jsx 린트** + 베이스라인 | `eslint.config.mjs`: `files: ['**/*.{js,jsx,mjs,cjs}']`, `parserOptions.ecmaFeatures.jsx`; 기존 위반은 ESLint 9.24+ bulk suppressions(`--suppress-all`)로 `eslint-suppressions.json` 베이스라인, CI에서 증가 금지·주간 `--prune-suppressions`. 대상에 `electron/`·`api/`·`shared/`·`packages/` 추가 | 설치본 ESLint ^9.39 | L/S | `npx eslint src/App.jsx`가 "ignored" 아님 |
| P0-5 | **브라우저 하한 고정** | `package.json` `browserslist: ["chrome 109"]`, `vite.config.js:41` target `chrome109`, `eslint-plugin-compat`, `stylelint` + `stylelint-no-unsupported-browser-features`, `scripts/verify-chart-compat.mjs` 퇴역. **머지 게이트: 현장 Win7 PC 1대 `chrome://version` 확인**(<109면 그 값으로; <93이면 `Object.hasOwn` 금지 유지) | – | L/M | lint 0, `build:web` |
| P0-6 | checkJs 점진 | `tsconfig.client.json`(`allowJs+checkJs+strict`, `target ES2019`, `lib ES2019+DOM`, `jsx react-jsx`, `moduleResolution Bundler`), 실패 파일에 `// @ts-nocheck` 코드모드 + `scripts/ts-ratchet.mjs`(개수 증가 금지), `src/types/global.d.ts`(`window.electron`, `__APP_GIT_COMMIT__`), 루트 `typecheck`를 `tsc -b`(references) | JSDoc 64태그 | L/S | CI typecheck |
| P0-7 | **`@wr/*` 해석 통일 — npm workspaces + always-dist(+watch)** 3단계: (a) 지정자 통일(`@contracts`→`@wr/contracts`, `@analytics-core`→`@wr/analytics-core` 코드모드, vite/vitest/tsconfig alias 동시 수정) (b) 서버 `pretest`/`pretypecheck`에 패키지 빌드 추가 (c) 루트 `workspaces: ["shared","packages/*","server"]`, 하위 lock 3개 삭제, zod `^3.25.76` 단일 호이스트, alias 전부 삭제, `scripts/dev.mjs`(tsup --watch ×2 + vite), `vercel.json` installCommand. **서버 모듈 해석은 같은 PR에서 함께 정렬**(Codex 지적: `moduleResolution: Node16`만 바꾸면 TS5110, `module`까지 맞춰도 ESM 타입 선언 때문에 TS1479): `shared/package.json`·`packages/analytics-core/package.json` `exports`를 `{ "import": {"types": "./dist/*.d.ts", "default": "./dist/*.js"}, "require": {"types": "./dist/*.d.cts", "default": "./dist/*.cjs"} }` 형태로(tsup이 이미 `.d.cts` 생성) + 서버 tsconfig `module: Node16` + `moduleResolution: Node16` + paths 삭제 → `npm --prefix server run typecheck`·`build`·vitest 통과를 머지 조건으로; 실패 시 폴백 = `node10` 유지하고 paths만 워크스페이스 심링크 경로로 갱신. **Docker도 같은 PR**(Codex 지적: hoisting으로 루트 `node_modules`에 설치되는데 최종 이미지는 `server/node_modules`만 복사 — `server/Dockerfile:126`): builder 단계에서 루트 `npm ci --include-workspace-root --workspaces` → 빌드 → `npm prune --omit=dev --include-workspace-root --workspaces`; 최종 이미지에 루트 `node_modules`(심링크 `@wr/*` 포함)·`shared/{package.json,dist}`·`packages/analytics-core/{package.json,dist}`·`server/{package.json,dist,node_modules?}`를 경로 구조 그대로 COPY. CI docker job에서 `docker compose up` + `/health` 200 + `/api/config/public` 응답으로 **컨테이너 기동 검증** | `distSmoke.test.ts` | (c) M/L | docker build + 컨테이너 기동 + Vercel preview + asar 검사 |
| P0-8 | 줄끝·포매터 | PR1 `git add --renormalize .`(README 인덱스 CRLF 해소) + `.editorconfig`; PR2 `.prettierrc` + "수정 파일만 포맷" 규칙, 디렉터리별 전체 포맷은 `.git-blame-ignore-revs` 등록 freeze 커밋 | `.gitattributes` | L/S | `git ls-files --eol | grep i/crlf` = 0 |
| P0-9 | **골든/특성화 테스트**(PR당 1개, 현재 출력 그대로 동결) | G1 6모듈 `computeCalc`×픽스처 → 파일 스냅샷 · G1b 6모듈 `batchImportConfig.applyRow` · G2 `generateBatchRows` 헤더 전체+행(현 테스트는 앞 7열만) · G3 `reportGenerator`/`emrReport` 서술 텍스트 · G4 모듈별 `exportHandlers`(XLSX spy→`sheet_to_json`, html2pdf mock→HTML) · G5 supertest on `createApp`+실DB: patients/workspaces/videoAnalysis apply 응답 스냅샷(uuid·시각 정규화) · G6 statsEngine 요청 빌더 5종 본문 · G7 Electron 추출 PR마다 헬퍼 스냅샷 · **G8 `src/modules/{elbow,wrist}/utils/__tests__/legacyParity.characterization.test.js` 재생성**(`syncXModuleData` ≡ `normalizeXModuleData`, 클라 계산 ≡ analytics-core) · G9 `App.smoke.test.jsx`(jsdom, fetch stub: 랜딩→픽스처 로드→환자 전환; **Phase 2 선행**) · G10 preload 공통 11키 parity | `src/core/fixtures/createTestPatients.js`, `fixtures_kneeSpinePatients.json`, `toMatchFileSnapshot` | L/S–M | 스냅샷 커밋 후 CI |
| P0-10 | 서버 vitest 프로젝트 분리 | unit / integration(`*.integration.test.ts`, `globalSetup`에서 migrate, singleThread, 전용 DB `wr_test`), dev DB `wr_evaluation` 지정 9파일 정리 | `runMigrations` | L/S | `test:integration` |
| P0-11 | 서버 공용 하네스(신규 테스트부터) | `server/src/testing/{fakePool,app,tokens,configMock}.ts`(`__tests__` 밖 → include glob 회피, `tsconfig.build.json` exclude). `createFakePool({handlers})`: SQL 조각 정규식+파라미터 술어로 라우팅, 미매치 SQL throw — **쿼리 순서 탈결합** | `generateAccessToken`, `createApp` | L/S | G5가 사용 |
| P0-12 | Python 재현 | `services/stats-engine/{requirements-dev.txt,pyproject.toml}`(pytest·ruff), `.python-version`(3.11), 루트 `test:py`, pose `requirements.txt` `==` 핀 | – | L/S | pytest 234+47 |
| P0-13 | **성능 기준선**(트랙 P 선행) | ① 인트라넷 빌드 cold/warm 네트워크 전송량·Lighthouse(DevTools) ② 라우트별 p95(S9 access log 전엔 임시 타이머 미들웨어) ③ `statsEngine` spawn→첫 바이트 vs 계산 시간 로그 ④ React Profiler commit 시간(환자 100·500명 픽스처) → `docs/PERF_BASELINE.md`에 기록. 트랙 P 항목은 이 수치 대비 효과를 적는다 | `src/core/fixtures/createTestPatients.js` | L/S | 수치 4종 기록 |

보안 훅(Phase 0): gitleaks action, `npm audit` 보고 job, Dependabot 디렉터리 확장(`/server`,`/shared`,`/packages/*`, pip)(L16).

---

## Phase 1 — 서버 (S1 → S2∥ → S3 → S4 → S5∥S6 → S7 → S8 → S9 → S10∥ → S11)

| # | 목표 | 파일/내용 | 재사용 | 위험/크기 | 검증 |
|---|---|---|---|---|---|
| S1 | **asyncHandler + 중앙 에러 매퍼**(64 swallow 제거) | `server/src/http/{asyncHandler,errors}.ts`: `AppError(status, code)` 계층 + `toAppError(err)`(zod→400 INVALID_BODY, 23505→409, 40P01 재시도, 기존 Identity*/PatientLock*/StatsEngine* 클래스 매핑 — 현행 상태코드 보존), `app.ts` 에러 미들웨어(envelope `{code,error,issues?,requestId}` 유지, pino+requestId 로깅), `/api/*` JSON 404. 라우트 11파일 각 1 PR로 `.catch(()=>500)` 치환, `internalError` 11벌 삭제 | `pino`(선언만 됨), `withDeadlockRetry`(patients.ts:157) | L/S×11 | `grep -rc "res.status(500)" routes` → 0, G5 불변 |
| S2 | config/env 통일 | `config/schema.ts` zod 파싱; `db/client.ts:3`→`config.databaseUrl`; `process.env` 우회 8파일 제거(ESLint 금지, `config/` 밖); Python/스크립트 기본 경로 cwd→`__dirname` 기준 | `createConfig` | L/S | `config.test.ts`, docker 기동 |
| S3 | 하네스 이관 + 순서 탈결합 | `makePool` 24·`makeApp` 18·config mock 27 → `testing/*`; 순서형은 호환 shim으로 파일별 점진. **S7이 SQL 순서를 바꾸는 라우트(patients/workspaces/videoAnalysis apply/locks)는 재목킹 대신 통합(실DB)로 이관** | P0-11 | M(테스트만)/L 분할 | 통과 케이스 ±0 |
| S4 | **인가 조합**(한 번만 정의) | `http/authz.ts`: `requireAuth(deps)`·`requireOrg()`(24곳 → 1)·`requireAdmin()`·`requireCapability(deps,key)`(stats 가용성 결합 해제)·`requireFeature(isOpen,{hide})`·`requirePatientAccess(deps,'read'|'write')`(5벌 → 1, `req.patient` 부착)·`requireLockToken()`(If-Match+X-Lock-Token 파서 3벌 → 1)·`requireCsrf()`; `videoAnalysis.ts:85` 로컬 `SessionInfo` 삭제(`as unknown as` 11 제거), `req.sessionInfo!` 51 → 타입 좁힘; admin/opsStatus는 `router.use(auth, adminOnly())`로 fail-closed | `middleware/{auth,patientAccess,adminOnly,requireCapability,rateLimit}.ts` | M/M | 미들웨어 테스트 + G5 |
| S5 | 라우트 분할(`move`) | `routes/admin/{devices,audit,users,signupRequests,orgSettings,presets,workspacesPurge}.ts`, `routes/patients/{read,write,locks,assignment,identity,schemas}.ts`, `routes/videoAnalysis/{clips,jobs,apply,access}.ts`; `withDeadlockRetry`→`db/`(라우트 간 import 제거) | – | L/L(기계적) | 테스트 불변, 파일 ≤400줄 |
| S6 | stats/ 폴더 이동 → 분할 | ① `git mv` 55파일 → `server/src/stats/{engine,recipe,dataset,disclosure,queue,export,policy,routes}/` + import 코드모드 ② `statsEngine.ts` → `engine/{protocol,responseSchemas,limits,subprocess,runners/*}.ts` ③ `validateRecipe`(420줄) → `recipe/validate/*.ts`, `SUPPORTED_GRAINS` 단일 export(`routes/stats.ts:42` 주석 동기화 제거) ④ `StatsRunRow` 재선언 제거 | tsc가 검증기 | L/L | stats 테스트 80개 + G6 |
| S7 | **`patient_records` 7경로 수렴**(경로당 1 PR, SQL verbatim 복사 → 마지막에 dedupe) | `db/patientRecordsRepo.ts`(`VISIBLE_BY_ID` 9벌 → 1, `selectForUpdate/insert/updatePayload/softDelete/setAssignment/upsertFromSnapshot`), `domain/patients/patientRecordsService.ts`(`upsert/patch/assign/softDelete/correctIdentity/applyVideoAnalysis/applyWorkspaceSnapshot/lock.*` — 본문 = `withDeadlockRetry(withWriteTransaction(anchor FOR UPDATE → lockGate → person 해결 → completion 컬럼 → UPDATE → audit))`). 순서: ① workspaces.ts:368(HF1 로직 흡수) ② videoAnalysis :977 ③ patients POST :723 ④ PATCH :921(**H**: FOR UPDATE·락 — 실DB 재현 필수) ⑤ DELETE :1053 ⑥ assignment :1382 ⑦ patientIdentityCorrection.ts:182 — **단일 앵커 FOR UPDATE 규칙의 예외**(Codex 지적: `patientIdentityCorrection.ts:79`가 같은 person의 전체 case를 정렬 순서로 잠그므로 앵커를 먼저 잡으면 다른 case를 정정하는 요청과 순환 대기). 정렬 잠금·집합 재검증·전체 case 락 검사를 그대로 보존한 채 `service.correctIdentity`로 감싸기만 하고, 리포지토리의 쓰기 함수만 공유 | `withWriteTransaction`, `completionTracking.ts`, `db/patientPersons.ts`, `resolveAssignedDoctor.ts` | ④ H, ⑦ M(잠금 순서 불변), 나머지 M | `grep -l "INTO patient_records\|UPDATE patient_records"` → repo 1파일; `patientLocks.integration` |
| S8 | 큐 namespace 범위(claim뿐 아니라 **enqueue·sweep·모든 상태 전이**) | 마이그 0038(`stats_runs.queue_namespace NOT NULL DEFAULT 'default'`·`claimed_by`), `STATS_QUEUE_NAMESPACE`(운영 'default', 개발서버·테스트는 각자 값). enqueue(`handlePostAnalyze`)가 행에 namespace 기록; `claimNextQueuedRun`·**sweeper 2종(`statsRunsQueue.ts:334` 대기시간 초과 `QUEUE_WAIT_EXCEEDED`, `:621` stale 회수)**·finish/cancel/timeout 등 워커의 모든 UPDATE에 `AND queue_namespace = $ns`(Codex 지적: claim만 분리하면 개발 워커 sweep이 개발 설정 대기시간으로 운영 run을 종결시킴). video 워커 동일(`video_analysis_jobs`). **admission·캐시·합류·쿼터·유일성도 namespace 키에 포함**(Codex 지적: `statsRunAdmission.ts:147,163,230`과 `0031_stats_runs.sql:56,66`의 유일 인덱스가 (organization_id, digest)만 사용 → 운영 요청이 개발 run에 합류하거나 개발 결과를 재사용 가능): 유일 인덱스를 `(organization_id, digest, queue_namespace)`로 교체, `ON CONFLICT` 대상·결과 캐시 조회·running 합류·쿼터 집계에 `queue_namespace = $ns` 조건 추가, 테스트: 같은 digest가 ns별로 독립 실행·독립 결과. `index.ts:139` 워커 게이트를 `statsWorkbenchRuntimeState.ts:20`과 **같은 함수**로. **교차 namespace 불변 통합 테스트**: ns A 워커(짧은 대기시간)가 ns B의 queued/running 행을 어떤 경로로도 변경하지 못함. `flagged` | `statsRunsQueue.integration` | M/M | 실DB 통합(불변 테스트 포함) |
| S9 | graceful shutdown + 관측 | `boot.ts`: SIGTERM/SIGINT → `server.close()` → 워커 `stop()` → 타이머 정지 → `pool.end()`(10s); requestId, pino-http(redact: authorization/cookie/body), access log | P0-3 | L/M | compose stop 내 종료 |
| S10 | 마이그레이션 체크섬 | `migrate.ts` sha256 컬럼(0038), 적용 파일 변경 시 부팅 실패(1릴리스 `MIGRATION_CHECKSUM_MODE=warn`), `scripts/check-migrations-immutable.mjs` CI | – | L/S | 통합 프로젝트 |
| S11 | 의존성 | `drizzle-orm` 제거, supertest 7, `pino` 실제 사용(console.* 78 → logger), Node 20 EOL → Docker node:22 검토 | – | L/S | CI |

보안 bundle(Phase 1): M2 계정별 backoff/lockout(DB) + 실패 감사에 해시 login ID(`rateLimit.ts`, `audit.ts:124-140`) · M3 세션 절대 수명(예 12h)+유휴 타임아웃, 웹 세션 쿠키 기본(`sessionStore.ts:76,216`, `auth.ts:57-66`, `LoginModal.jsx:24`) · L2 본문 한도 라우트별(기본 ~100KB, 환자/워크스페이스/autosave만 상향; `index.ts:38`) · L3 `/api/auth/refresh`·`/api/audit/emr` rate limit · L4 가입 요청 항상 202 + org 연결 · L5 JWT alg 고정·비밀키 강도 검사·미사용 `REFRESH_TOKEN_SECRET` 제거 · L6 비밀번호 최대 길이 · L10 Python 자식 env 최소화(PATH/CUDA/TMP만 — GPU 경로 회귀 주의) · L11 EMR 감사 nonce (device,nonce) unique + 서버 필드 마지막 spread · L12 환자 삭제 시 autosave 정리·retention dry-run·seed 운영 가드 · L13 compose 기본값(`changeme`·0.0.0.0·trust-proxy)·`0004_audit_role.sql:15` 비번 · L14 CSV TAB/CR 이스케이프 · L17 Caddy 로그 query string 제거 · **M9 DB 역할 분리**(Codex 지적: 기본 compose에서 앱이 초기 슈퍼유저 `wr_user`로 접속(`docker-compose.yml:32,56`)하므로 트리거/역할만 추가해도 앱이 해제 가능): `wr_owner`(마이그레이션·객체 소유, 슈퍼유저 아님) / `wr_app`(런타임, 소유권 없음, `audit_logs`는 INSERT만·TRUNCATE/UPDATE/DELETE 불가) / `wr_audit_reader` 3역할, 부트스트랩 슈퍼유저는 역할 생성에만 사용. `MIGRATION_DATABASE_URL`(owner)로 마이그레이션을 compose `migrate` 1회성 서비스(또는 부팅 전 단계)에서 실행하고 `DATABASE_URL`(app)은 런타임만 — `index.ts:98` 부팅 시 자동 마이그레이션을 owner 자격으로 분리. 차단 트리거 + 해시체인/write-once export는 그 위에. 운영 전환 절차(역할 생성 SQL, 비밀 2종)를 UPDATE 안내서에 명시, `flagged` · 검증 응답 4종 통일(`flagged`).

---

## Phase 2 — 클라이언트 (선행: G1–G4·G8·G9, P0-5·P0-6, E0)

| # | 목표 | 파일/내용 | 재사용 | 위험/크기 |
|---|---|---|---|---|
| C1 | **플랫폼 어댑터** | `src/platform/{runtime,bridge,dataMode,dialogs}.ts` + `PlatformProvider`: `getBridge()`가 `window.electron`을 읽는 **유일한** 파일; `Runtime {host, buildTarget(preload가 명시, E0), dataMode, apiBaseUrl, serverFeatures}`; 인트라넷 판정 6벌 → `resolveDataMode` 1벌(진리표 parity 테스트 선행), `getBaseUrl` 3벌+JSX 5곳 → `resolveApiBaseUrl`(순서 session→settings→'' 고정); `window.electron` 60곳/14파일 코드모드(3–4 PR) + ESLint `no-restricted-globals` | `utils/platform.js` | L/M |
| C2 | 요청 계층 | `src/core/api/apiClient.ts`(401-refresh 1벌·CSRF 재시도 1벌·에러 추출 1벌; `httpClient.js`는 shim), `ApiError`, `useAsync/useRequest`(수제 loading/error ~13곳), 리소스별 리포지토리(patients/workspaces/presets/admin/stats/video), raw fetch 5곳 제거, `src/core/storage/keys.ts` 키 레지스트리(`authChannel.js` `wr-auth-*` → 접두사 통일, 1릴리스 구키 읽기) | `httpClient.test.js` | L/M |
| C3 | **App.jsx 분해 순서** | ① `WorkspaceScreen.jsx`(:783–998 `move`, dead `{false&&}`·`StepContent.jsx:150–156` 미사용 props 정리) ② `useScreenRouter`(:94–98,:543–553,:658–764) ③ `ModalHost`(불리언 8→`modal:{name,payload}` 슬라이스, `AppModals` 62 props → 0; 모달은 `useAuth/usePatientStore/usePresets`로 자급) ④ `useUnsavedDraftGuard`(:101–132,:444–464 — 6곳 중복 가드 → 액션 `meta.leavesDraft` 미들웨어) ⑤ `usePatientScope`(:71–72,:139–148,:290–335; `jobFilter` ''/'all' 잠복 버그는 별도 `flagged`) ⑥ 브리지 4곳→C1 ⑦ `PatientStoreProvider`(C4) ⑧ `AuthProvider`가 `useAuthSync` 흡수(:592–650; 부팅 무한루프 이력 → 마지막) | G9, `AuthContext.test.jsx` | ①② L/S, ③④⑤ L/M, ⑦ M/M |
| C4 | **환자 상태 컨테이너** — 리듀서 기반 외부 스토어(`useSyncExternalStore`, 의존성 0; context+useReducer는 `usePatientSync`의 ref 미러링 7개를 못 없애 기각) | `src/core/state/patientStore/{store,reducer,actions,selectors,draftGuard,Provider}.ts`; 액션은 쓰기 주체 10곳에서 도출(`patient/update`, `patients/add|replaceAll|append|removeMany`, `conflict/*`, `sync/applyPushResults|reconcilePulled|pause|resume`, `ui/selectPatient`, `selection/set`, `filters/patch`, `draft/set`, `modal/*`); `touchPatientRecord` 6형 → 리듀서 `finalizeWrite` 1곳(외부 import ESLint 금지); `useEvaluationDateSync` effect-writes-state 제거(`withSyncedEvaluationDate`를 `patient/update` 안에서 동기 적용, `clock` 주입). **첫 단계**: App.jsx:70을 `usePatientsCompat()`(`patients/__legacySet` shim)로 교체 → 훅당 1 PR로 명명 액션 이전 → shim 호출 0이면 삭제 | `usePatientSync.test.js`, `patientServerRepository.test.js`(+ pull 페이지네이션/interval/debounce 테스트 선작성) | M/M×5 |
| C5 | 매니페스트 typedef + 검증 | `src/core/modules/manifest.ts`(`ModuleManifest`: 기존 키 + `labels{side,status,reason,aux}` · `narrative{sectionText,summary,legend}` · `batchExport{columns,cells}` · `assessmentFields` · `color`; `presetConfig.fields`는 `'tasks'` 문자열 대신 `{key:'tasks',type:'taskList'}`), `registerModule`이 `validateManifest`(1차 warn → 2차 throw), 6모듈 전부 import하는 레지스트리 테스트 | `analyticsRegistry.ts` 검증 패턴 | L/S |
| C6 | **플러그인 경계 복원**(core→modules 30 import → 0) | (a) 공용 어휘 core로: `getSideText` 8벌→`src/core/i18n/sideLabels`, `LOW_REASON_OPTIONS`→`core/assessment/`, `KLG_OPTIONS`→knee `assessmentFields`, `AUX_LABELS`→knee `labels.aux`, `FALLBACK_PRESETS`→`core/presets/fallbackPresets` (b) `generateBatchRows`의 `row.push` ~95 → `CORE_COLUMNS + modules.flatMap(m=>m.batchExport.columns)`(G2로 헤더 순서 고정) (c) `BatchImportModal.jsx:18–140` 필드 스키마 → `batchImportConfig`에서 파생 (d) `createTestPatients.js` 866줄 → 모듈별 fixtures (e) ESLint `no-restricted-imports` `**/modules/*` in `src/core` | G2, G3, G4 | M/L(provider당 PR) |
| C7 | **서술 텍스트 단일 소스** | 모듈 `narrative` 1벌을 exportHandlers/`reportGenerator`/`emrReport`(:38·:211 내부 중복 포함)가 호출; BK2117 `over50>=3||over75>=2` 4곳·무릎 4단계 범례 4곳 → analytics-core 상수/함수. G3가 소비처별 현재 문구를 기록 → 통일 PR은 임상 승인 + ADR(`flagged`) | G3 | M/M |
| C8 | 쌍둥이 전략 | knee↔shoulder: `_shared/JobExtrasEvaluation`(주석 1줄 차) + `upsertJobExtra` 헬퍼 즉시. elbow↔wrist: **순수/데이터 층은 `createUpperLimbModule(config)` 팩토리**(`_shared/upperLimb/{applyRow,presetFields,dataFactories}`; 문구 차이('경미'/'경도')는 config 표로 명시, 두 config의 키 집합 동일성 테스트; G1b·G8 보호), **컴포넌트(ExposureForm 41/570·DiseaseSpecificFields 63·ResultPanel 41 diff)는 쌍둥이 유지 + `twinParity.test.js`**(이름 정규화 diff를 허용 hunk 스냅샷과 비교, 새 드리프트에 실패) → 기능 작업으로 건드릴 때 매개변수화(wrist 테스트 0이라 강제 팩토리는 분기만 늘림). `SummaryCard` 4벌→1, "직력N"·`${y}년 ${m}개월`·250 → `jobHistory`/`workPeriod` 단일 | G1, G8 | L–M/M |
| C9 | 거대 컴포넌트 분할(테스트 많은 순, 분할 = `.tsx` 전환) | 1 `VideoAnalysisStep`(헬퍼 ~40개 :47–613 → `services/video*`, `EvidencePanel`:377·`FlatCandidateList`:443 파일화, 훅 3개(업로드/탐지·실행·적용/롤백), `MOCK_BUNDLE`↔`videoServerApply.js:9` 중복 제거) 2 `StatisticsWorkbench`(useState 31 → `useReducer`+`workbenchTransitions.js`, 테스트 픽스처 6벌 → 1) 3 `ResultPanel`/`RecipePanel`(라벨 사전 → `statistics/labels`, 카드·`MethodPicker`·`FilterEditor` 파일화, useMemo 9 → 훅) 4 `AdminConsoleModal`(탭 스모크 테스트 먼저 → `admin/*Tab.tsx` + `adminRepository` + `useRequest`; inline `requestJson` 25 → 0) 5 `Dashboard`(수제 차트 3개 → `charts/`, 라벨/색 → 매니페스트) 6 `BatchImportModal`(`services/batchImport.ts` 순수화) 7 `SettingsModal`(`DEFAULT_INTRANET_URL` `:8443` 단일 상수 `flagged`) | 기존 컴포넌트 테스트, `workbenchTransitions.test.js` | L–M/컴포넌트당 2–3 PR |
| C10 | CSS | ① `index.css` 4,051줄 → `@import` 목록 + 접두사별 co-located `*.css`(`move`; 빌드 산출 CSS diff = 공백만) ② 토큰(`styles/tokens.css`: 색·간격·radius·타이포), raw hex 174·inline hex 18 → 토큰(`flagged` 시각), 다크모드는 `[data-theme="dark"]{--token}` 오버라이드만(stylelint로 `[data-theme] .x` 금지) ③ 신규 분할 컴포넌트만 CSS Modules(Vite 5 빌드타임 치환, Chrome 109 안전) ④ `elbow-`/`wrist-` 111블록 → C8과 함께 `.ul-` 1벌 | P0-5 stylelint | L/①L ②M |
| C11 | TS 전환 규칙 | 신규 = TS; 분할되거나 PR이 파일의 ≥30% 줄을 바꾸면 `.ts/.tsx`; 테스트 있는 leaf util은 rename-only PR(≤5파일) 허용; 변환 순서 ① `moduleRegistry.ts`(C5) ② `platform/*` ③ `api/apiClient` ④ `state/patientStore` ⑤ `services/patientRecords` ⑥ `storage/keys` ⑦ 모듈 `index`(C8); 전환율 ≥80%에 `tsconfig.client.json` `files`→glob; 신규 코드 `any` 0 | P0-6 | – |

보안 bundle(Phase 2): M5 독립형 API 키 localStorage(`analysisClient.js:4–14`) → Electron main `safeStorage` IPC(Phase 3 E2와 동시) · **M6 독립형 PHI 저장본 전부 암호화**(Codex 지적: `patients/*.json`만 하면 이름이 든 index(`main.js:1004`)·저장 스냅샷(`:1054`)·autosave(`:1066`)가 평문으로 남고, 인트라넷 이관 리더(`migrationDataReader.js:31`)가 암호화본을 못 읽음): `electron/main/fs/secureStore.js` 한 곳이 `{v:1, enc:'safeStorage', data}` 봉투로 patients/index/items/autosave/settings(API 키 포함, M5)를 읽고 씀, 최초 기동 시 평문 → 암호화 1회 이관(백업 보관 후 삭제), `migrationDataReader`·레거시 import 경로가 평문/암호화 둘 다 읽기, `safeStorage.isEncryptionAvailable()` false면 기동 차단 대신 경고+평문 유지 기록. 웹은 "로컬 데이터 삭제"·경고 · L15 웹 CSP(`vercel.json` 헤더 + `index.html` SRI) · `react/no-danger` 베이스라인 0 · `authChannel` 탭 간 refresh 락 테스트.

---

## Phase 3 — Electron·패키징

| # | 목표 | 파일/내용 | 선행 | 위험/크기 | 검증 |
|---|---|---|---|---|---|
| E0 | preload에 `buildTarget` 리터럴 노출(추가만) | `preload-{intranet,standalone}.js` | – | L/S | G10 |
| E1 | `main.js` `move` 분할 | `electron/main/{bootstrap,buildTarget,windows,menu,updater,dialogs,exitFlow,lifecycle}.js`, `main/ipc/{index,ui,ai,fs,legacyImport,emr,migration,auth}.js`, `main/emr/{helperRunner,phiTempFile,payload}.js`(`execEmrInject`가 `runHelper` 재구현 → 통합), `main/legacyImport/levelDbReader.js`(:778–940 순수), AI 프록시는 `@wr/contracts`의 `aiAnalysis/aiPrompt/aiModels`(`api/analyze.js`·서버와 공용 — HF7에서 도입)와 HF7이 만든 `electron/aiRequest.js`(요청 봉투 검증)만 호출하는 얇은 `main/ipc/ai.js`; main.js ≤150줄; PR마다 G7 | G7 | M/L(≈6 PR) | 82 테스트 + 두 타깃 `electron:dev` 스모크 |
| E2 | 조건부 IPC + sender 검증(HF3를 구조화 — HF3가 `electron/ipcGuard.js`의 `createIpcRegistrar`로 먼저 도입했고, E2는 `main/ipc/*` 분할에 맞춰 `registerIpc`로 재구성) | `registerIpc({target, deps})`: 공통(ui, emr) / standalone(fs 16, ai, legacyImport) / intranet(auth, migration); `guardedHandle(channel, {allowedOrigin}, fn)`; `ipcRegistration.test.js` | E1 | M/S | 채널 집합 테스트 |
| E3 | preload base 공유 | sandbox preload는 로컬 `require` 불가 → `scripts/build-preload.mjs`(esbuild, vite 동봉) → `electron/preload/{base,standalone,intranet}.js` → `electron/dist/preload-*.js`; 브리지 인터페이스(`BridgeBase` + `StandaloneBridge`/`IntranetBridge`, 네임스페이스 `fs/ai/emr/auth/migration`), 평탄 키는 1릴리스 호환 | E1, C1 | M/M | 두 타깃 스모크 |
| E4 | asar 내용 | `electron-builder.base.yml` `files`: `!electron/__tests__/**`, `!electron/emr-helper/**`(exe는 extraResources), `!public/**`(아이콘 경로 `main.js:322`), 렌더러 전용 deps(react/xlsx/jszip/html2pdf) → devDependencies — **`zod`·`js-yaml`은 dependencies에 유지**(`js-yaml`은 HF8의 업데이트 피드 검증이 Electron main에서 런타임에 `require`; zod는 Codex 지적: Electron main이 HF7의 `shared/dist/*.cjs` 계약을 통해 런타임에 `require('zod')`; 대안은 계약을 esbuild로 main용 단일 파일에 번들); `scripts/check-asar-contents.mjs` CI(`__tests__`·`.cs`·`obj/` 0, `shared/dist/aiPrompt.cjs`·`node_modules/zod`·`node_modules/js-yaml` 존재, <40MB) | P0-7(c), HF7 | M/S | `electron-builder --dir` + 검사 + **설치본에서 AI 호출 1회 실측** |
| E5 | `build-target.json` 제거 | 각 builder yml `extraMetadata.buildTarget` → `require('../package.json').buildTarget ?? WR_BUILD_TARGET`, `set-build-target.mjs` 삭제 | E1 | L/S | asar extract 확인 |
| E6 | 버전 일관성 스크립트 | `scripts/bump-version.mjs`(package.json·lock·README.md:3·docs/PRD.md:3-4·`UPDATE_<v>.md` 스텁) + `check-version-consistency.mjs` CI | – | L/S | CI |
| E7 | 백업 export 스크립트 출하 | `export-offline-package.ps1` 복사 목록(≈:330·:355)에 `export-backup-snapshot.ps1`·`register-backup-export-task.ps1`·`docs/BACKUP_EXPORT_OPS.md` | – | L/S | 패키지 manifest 테스트 |

보안 bundle(Phase 3): L8 EMR 헬퍼 대상 창 host allowlist(`EmrHelper.cs:437-455`) + PHI를 stdin(`--json-stdin`)으로(1차: `userData/tmp/emr-<uuid>.json` 0600 + finally 삭제) · M5/M6 safeStorage 저장소 · L9 잔여(모델명 검증) · H5 Win7 `no-sandbox` 위험 문서화 + 최신 Windows용 현행 Electron 빌드 검토(ADR).

---

## Phase 4 — 계약·Python

| # | 목표 | 파일/내용 | 선행 | 위험/크기 |
|---|---|---|---|---|
| K1 | **Node↔Python 프로토콜 단일 소스(zod → JSON Schema 생성)** | ① `shared/contracts/statsEngineProtocol.ts`(요청 6 shape + 응답 zod 이관, `STATS_ENGINE_PROTOCOL_VERSION`) ② `scripts/gen-engine-schema.mts`(zod-to-json-schema) → `services/stats-engine/schema/{request,response}.schema.json`·`limits.json`·`version.json` 커밋, CI `--check` ③ `protocol.py:66–350` dict → JSON 로드(`jsonschema` 이미 의존), `analyze.py:28` + `{"const": 6}` 7곳 → `version.json` ④ `statsEngineLimits.consistency.test.ts` regex 비교 → limits.json ⑤ pose: `buildInferClipArgs()` 타입드 빌더 + argparse 플래그 집합 parity 테스트, `videoAnalysisWorker.ts:157–170` inline cast → `PoseKeypointsSchema.parse` | G6, P0-12 | L(④까지 테스트만)/M |
| K2 | `CATALOG_VERSION` 범프 가드 | `__tests__/catalogVersion.guard.test.ts`(메타데이터 canonical digest ↔ `catalog.digest.json`; digest 변경+버전 불변 → 실패, `npm run catalog:snapshot`), `catalog.ts:118–304` 190줄 changelog → `docs/CATALOG_CHANGELOG.md` | – | L/S |
| K3 | analytics-core elbow/wrist 통합 | `derived.golden.test.ts` 먼저 → `modules/upperLimb/derivedFactory.ts`(moduleId·BK 집합·branch fields 매개변수), extractors 팩토리, `legacyNormalize` 4벌 → 1(G8), 변수당 3곳 수기 → metadata-driven extractor 맵; 클라 상수 미러(`src/modules/*/utils/data.js:4–87`) → analytics-core re-export(C6 뒤) | G8, C6 | M/L(3 PR) |
| K4 | tsup 엔트리 glob + 레지스트리 싱글턴 | `shared/tsup.config.ts` `entry: ['contracts/*.ts']`(video* 5파일 누락 즉시 해소), analytics-core `splitting:true` 또는 단일 엔트리로 레지스트리 1벌, `distSmoke`가 `exports` 광고 경로 전부 검증, ESLint로 `@wr/analytics-core/*` 서브패스 import 금지 | P0-7 | L/S |
| K5 | Python 위생 | ruff·pytest 설정, 3.11 CI, pose 핀, 프로토콜 리터럴 개수 테스트 | P0-12 | L/S |

보안 bundle(Phase 4): pose CLI 인자 단일 소스, 입력 상한 Python 측 parity, 서브프로세스 인자 검증.

---

## Phase 5 — 문서·위생

| # | 내용 |
|---|---|
| D1 | `docs/adr/0001-….md` + 템플릿; Phase 0–4 결정 백필(workspaces, Chrome 109, 에러 envelope, patientRecordsService, 서술 canonical 문구, 큐 namespace, 체크섬, buildTarget 주입, 프로토콜 단일 소스, AI 비식별 정책, 업데이트 서명 대안, Win7 수용 리스크) |
| D2 | stale 문서: ARCHITECTURE_DIAGRAM 재생성, INTRANET_API_CONTRACT → `scripts/gen-route-table.mjs` 생성물, DOMAIN_SCHEMA/MODULE_STORAGE_CONVENTIONS 헤더, OPERATIONS_RUNBOOK에 BACKUP_*·M10 PKI 권고 통합, AGENTS.md → CLAUDE.md 포인터, **CLAUDE.md 정정**(AI 분기는 `services/analysisClient.js`; 서버 vitest는 dist 해석), mock-intranet 정리(`mock-intranet-server.cjs` 스텁 삭제, `shared/dist` 직접 import → 패키지, 스택 런처 3개 → 1) |
| D3 | `CHANGELOG.md` 단일(Keep a Changelog), README 1줄 상태+링크, PRD는 요구사항만(1회 이관 freeze 커밋) |
| D4 | dead 삭제: scripts `Test-EMR-Hook.ps1`·`verify-shoulder-roundtrip.mjs`·`dev-intranet-stack.ps1`·`verify-csp.mjs`(→ `csp.test.ts`)·`verify-chart-compat.mjs`; 파일 `knee/components/PresetSearch.jsx`·`spine/utils/time.js`·`core/components/ModuleSelector.jsx`; 생성물 `.code-review-graph/wiki/*.md` 30개 untrack; `.sln/.csproj`(ps1이 정본); 루트 `.xlsm` → `docs/templates/`; `packages/analytics-core/coverage/` 개명 |
| D5 | `scripts/replace-plan-citations.mjs`(계획서 § → ADR id, 없는 8개는 인용만 제거) — 영역 분할 PR 직후 디렉터리별 실행, CI grep 가드 |

---

## 트랙 P — 성능 (횡단 트랙, 2026-10-16 추가)

원칙: ① **기준선 측정(P0-13) 없이 효과 주장 금지** ② 동작 불변(`safe`)이 아닌 항목은 `flagged` ③ 보안 항목과 충돌 금지(HF4 `/api` no-store 유지, 압축은 `/api/auth/*` 제외) ④ **Phase H 범위에 끼워 넣지 않음**(Phase H는 2026-10-18 코드 머지 완료 — HF1 #159가 머지돼 P-4는 착수 가능).

점검에서 기각한 가설: `index.html:8-13`의 Google Fonts·jsDelivr 링크는 서버 CSP(`style-src 'self'`, `middleware/csp.ts:17`)가 차단하므로 에어갭 망에서 요청 자체가 나가지 않음 → 렌더 지연 없음(대신 시스템 폰트 폴백 중; 자체 호스팅은 L15·타이포 일관성 항목).

| # | 후보 | 근거 | 기대 효과(기준선 대비, 추정) | 위험/크기 | 배치 |
|---|---|---|---|---|---|
| P-1 | **응답 압축 + 정적 자산 캐시 헤더** | `caddy/Caddyfile`에 `encode` 없음(Express도 compression 없음), `server/src/index.ts:72` `express.static` 옵션 없음(Cache-Control 미발행), 로컬 빌드 main JS 1,851KB·xlsx 415KB·jspdf 148KB 비압축 | 전송량 약 1/3~1/4, 재방문 자산 재검증 0. Electron 인트라넷도 서버 URL 로드(`main.js:518`)라 동일 | L/S | Quick win 21, 즉시 |
| P-2 | **무거운 라이브러리 지연 로딩 + 화면 단위 code splitting** | 정적 import 14곳(6모듈 exportHandlers·exportService·BatchImportModal·batchImportHelpers), `vite.config.js` manualChunks는 xlsx를 분리만 할 뿐 초기 로드 포함 | 초기 JS 1.85MB → ~0.9–1.1MB(압축 전); 통계/영상/관리 미사용자는 해당 코드 미수신 | L–M/M | Quick win 22(HF6 #164 머지 완료 → 착수 가능), C6/C9와 자연 통합 |
| P-3 | **환자 스토어 셀렉터 구독**(C4 부산물) | `patients` 교체마다 App 전체 리렌더 — `React.memo` 사용 파일 2개, `StepContent` 32 props·`AppModals` 62 props·`PatientSidebar` 522줄 전체 재렌더 | 환자 수백 명에서 입력 지연 체감 개선 | 계획된 작업 | C3/C4 — DoD에 Profiler commit 시간 추가 |
| P-4 | **워크스페이스 저장 시 변경분만 upsert** | 저장마다 전체 환자를 `patient_records`에 upsert(`workspaces.ts` `Promise.allSettled`) | 환자 500명 저장 = 트랜잭션 500 → 변경분 수 개. HF1이 revision 비교를 넣었으므로 "revision·payload 해시 동일 → skip" 소형 추가 | L/S | **착수 가능**(HF1 #159 머지 완료) — 후속 소형 PR 또는 S7 |
| P-5 | **증분 동기화(delta pull)** | `usePatientSync.js:14-16` 5분마다·scope 변경마다 전량 pull(100건/페이지), 목록 응답이 payload 전체 포함(`patients.ts:117-120`), `updated_since`/ETag 없음 | 주기 pull O(전체)→O(변경분). 인덱스 `patient_records_org_updated` 기존재, 삭제는 tombstone 필요 | M/M(`reconcilePulledPatients` authoritative delete와 결합) | Phase 2 후반(C4 이후) |
| P-6 | **Python 통계 엔진 상주 워커(warm pool)** | 요청마다 `spawn(python analyze.py)`(`statsEngine.ts:1142`) → numpy/scipy/statsmodels import를 매 요청 지불(preview debounce 호출마다) | 분석·미리보기에서 기동 고정비 제거(측정 선행: 빈 요청 왕복 vs 계산) | M/M(상주 메모리 ~124MiB/프로세스, 요청 간 격리·timeout/abort·재기동 설계) | Phase 4(K1 이후) 선택 |
| P-7 | **PDF 생성 방식 교체** — html2pdf(html2canvas 래스터) → Electron `webContents.printToPDF`(벡터)·웹 print CSS | 래스터 PDF는 느리고 용량 큼 | 생성 시간·파일 크기 대폭 감소, 텍스트 선택 가능 | M/M `flagged`(출력 레이아웃 변화 → 임상 확인, G4 골든 갱신) | C7 이후 |
| P-8 | 클라이언트 로드 시 마이그레이션 2회 실행 제거 | `storage.js:31,41,110,118` + `workspaceRepository.js:72` | 소(환자 수 비례 CPU) | L/S | C2/C4 정리 시 |
| P-9 | asar 81.6MB → <40MB | 이미 계획 | 설치·업데이트 다운로드 절반, 기동 시 asar 읽기 감소 | – | E4 |

보류(비권장): 인증 미들웨어의 매 요청 세션 DB 조회 캐시(즉시 폐기 보장과 상충) · pg pool `max:10`·워커 폴링 2초(인트라넷 규모에 충분).

**트랙 P DoD**: `docs/PERF_BASELINE.md` 기준선 4종 기록 → P-1·P-2 후 cold load 전송량 ≥50% 감소·초기 JS ≤1MB(압축 전) 확인 → C4 후 환자 500 픽스처 입력 commit 시간 기록 → P-6 착수 여부는 "빈 요청 왕복" 측정값으로 결정.

## 보안 항목 추적표 (32건 → Phase) — Phase H에서 11건 종결(2026-10-18, ✅ 표시)

| ID | 요약 | Phase/단계 |
|---|---|---|
| H1 | 워크스페이스 저장 임의 환자 덮어쓰기 | ✅ **HF1(#159)** → S7-① 구조화 |
| H2 | Vercel AI 프록시 무인증 | ✅ **HF7(c)(#167)** |
| H3 | 외부 AI 벤더 PHI 전문 | ✅ **HF7(a)(b)(#165·#166·#167)** |
| H4 | 업데이트 미서명 + electron-updater CVE | ✅ **HF8(#169~#172, 7.1.4 편입)** — 피드 서명 검증 도입. electron-updater 권고 2건은 미서명 설치본·무토큰 피드 구성에 해당하지 않아 업그레이드하지 않고 수용. 코드서명(Authenticode)은 여전히 없음 |
| H5 | Electron 22 EOL·no-sandbox | 수용 리스크, Phase 3 문서화·ADR |
| M1 | 임시비번 강제변경 미적용 | ✅ **HF2(#160)** |
| M2 | 계정별 brute-force 보호 없음 | S4 뒤 Phase 1 bundle |
| M3 | 세션 무기한 갱신 | Phase 1 bundle |
| M4 | preload raw IPC·무조건 등록 | ✅ **HF3(#162)** → E2 |
| M5 | API 키 평문 | Phase 2/3 bundle(safeStorage) |
| M6 | PHI at rest 평문(웹·독립형) | Phase 2/3 bundle |
| M7 | xlsx CVE | ✅ **HF6(#164)** |
| M8 | multer CVE | ✅ **HF5(#163)** |
| M9 | 감사 테이블 앱 계정이 수정 가능 | Phase 1 bundle(마이그) |
| M10 | 내부 CA 전역 신뢰 | 운영 권고(D2), 사용자 결정 |
| L1 | 서버 AI 프록시 한도/누출 | ✅ **HF7(b)(#166)** |
| L2 | 본문 10MB 인증 전 파싱 | Phase 1 bundle |
| L3 | refresh·audit/emr rate limit | Phase 1 bundle |
| L4 | 가입 ID 노출·org 미연결 | Phase 1 bundle |
| L5 | JWT alg·비밀키 강도·미사용 secret | Phase 1 bundle |
| L6 | 비밀번호 최대 길이 | Phase 1 bundle |
| L7 | PHI 응답 no-store | ✅ **HF4(#161)** |
| L8 | EMR 헬퍼 대상 휴리스틱·%TEMP% PHI | Phase 3 bundle |
| L9 | permission handler·nav guard·모델명 | ✅ **HF9**(handler/guard, #162) + HF7(d)(모델명, #167) |
| L10 | Python 자식 env 상속 | Phase 1 bundle |
| L11 | 감사 nonce 메모리·spread 순서 | Phase 1 bundle |
| L12 | autosave 잔존·retention dry-run·seed 가드 | Phase 1 bundle |
| L13 | compose 기본값·reader 비번 | Phase 1 bundle |
| L14 | CSV TAB/CR | Phase 1 bundle |
| L15 | 웹 CSP/SRI | Phase 2 bundle |
| L16 | Dependabot 범위·미사용 deps | Phase 0 훅 + S11 |
| L17 | Caddy 로그 query string | Phase 1 bundle |
| Info | admin 라우터 레벨 가드 · CSRF dead code · `===` 비교 | S4 · ✅ **HF9**(#161) · S4 |

---

## 목표 아키텍처 요약 (상세는 각 Phase 착수 시 플랜)

```
src/app/{App.tsx, providers/AppProviders.tsx, router/ScreenRouter.tsx, screens/*, modals/ModalHost.tsx}
src/platform/{runtime,bridge,dataMode,dialogs}.ts        # window.electron은 bridge.ts만
src/core/state/patientStore/*                              # useSyncExternalStore 리듀서 스토어
src/core/api/{apiClient,errors,useAsync}.ts + repositories/*
src/core/modules/manifest.ts                               # ModuleManifest + validateManifest
src/modules/_shared/upperLimb/*                            # elbow/wrist 순수층 팩토리
src/styles/{tokens,base}.css + 기능별 co-located css

server/src/app/{createApp,boot,deps}.ts                    # Deps {config,pool,auditPool,logger,clock,idGen,statsEngine,python}
server/src/http/{asyncHandler,errorHandler,validate,authz,requestId}.ts + errors/AppError.ts
server/src/domain/patients/{patientRecordsService,patientRecordsRepository,patientVisibility}.ts   # patient_records 유일 writer
server/src/stats/{engine,recipe,dataset,disclosure,queue,export,policy,routes}/
server/src/testing/{fakePool,app,tokens,configMock}.ts

shared/contracts/{statsEngineProtocol,protocolVersion,poseInference}.ts → services/stats-engine/schema/*.json (생성물)
electron/main/{bootstrap,…,ipc/*,emr/*,fs/*} + electron/preload/{base,standalone,intranet}.js (esbuild)
shared/contracts/{aiAnalysis,aiPrompt,aiModels}.ts  # AI 입력 계약(.strict) + 프롬프트 빌더 + 모델 allowlist — 서버·Vercel·Electron 공용(dist로 배포, HF7 ✅; Electron 요청 봉투 검증은 electron/aiRequest.js)
루트 package.json workspaces: ["shared","packages/*","server"]
```

핵심 인터페이스(요지): `createApp(deps: Deps): Express` / `AppError(status, code, message, details?)` + `toAppError(err)` / `requirePatientAccess(deps, 'read'|'write')` / `PatientRecordsService.{upsert,patch,assign,softDelete,correctIdentity,applyVideoAnalysis,applyWorkspaceSnapshot,lock}` / `ModuleManifest`(기존 키 + `labels/narrative/batchExport/assessmentFields/color`) / `Runtime {host, buildTarget, dataMode, apiBaseUrl, serverFeatures}` / `BridgeBase` + `StandaloneBridge`/`IntranetBridge` / `registerIpc({target, deps})`.

---

## Quick wins (각 ≤1일, 즉시 가능)

| # | 항목 | 파일 |
|---|---|---|
| 1 | ESLint `files` + suppressions 베이스라인(P0-4) | `eslint.config.mjs` |
| 2 | ✅ `.dockerignore` `*.asc` 등(HF9, #161) | `.dockerignore` |
| 3 | ✅ `EXEMPT_PATHS` dead code(HF9, #161) | `server/src/middleware/csrf.ts` |
| 4 | ✅ `ai.ts:135` 누출 → 공통 envelope(HF7, #166) | `server/src/routes/ai.ts` |
| 5 | ✅ Electron AI 프록시 `ALLOWED_MODELS`(HF7 d, #167) | `electron/main.js:693` |
| 6 | `db/client.ts` → `config.databaseUrl` | `server/src/db/client.ts` |
| 7 | 훅 결함: dead `prebuild`, `electron:build` prebuild 2회, 서버 `pretest/pretypecheck` | `package.json`, `server/package.json` |
| 8 | `.editorconfig` + README renormalize | 루트 |
| 9 | 백업 export 스크립트 출하(E7) | `scripts/export-offline-package.ps1` |
| 10 | `SettingsModal.jsx:6` `:8443` ↔ `main.js:24` 통일(`flagged`) | 2파일 |
| 11 | asar에서 `electron/__tests__`·`emr-helper/obj` 제외 | `electron-builder.base.yml` |
| 12 | `drizzle-orm` 제거, `engines`/.nvmrc(20), `.python-version`(3.11) | `server/package.json`, 루트 |
| 13 | pytest 스크립트 + `requirements-dev.txt` | `services/stats-engine/` |
| 14 | `videoAnalysis.ts:85` `SessionInfo` 삭제, `statsExportHandler.ts:27` `StatsRunRow` import | 2파일 |
| 15 | preload parity 테스트(G10) + `buildTarget` 노출(E0) | `electron/` |
| 16 | `shared/tsup.config.ts` video* 5 엔트리 | 1파일 |
| 17 | `index.ts:139` 워커 게이트 ↔ `statsWorkbenchRuntimeState.ts:20` 일치 | `server/src/index.ts` |
| 18 | 생성물 untrack(wiki 30개), dead 파일 3개·스크립트 2개 삭제 | D4 일부 |
| 19 | CLAUDE.md 부정확 서술 정정 | `CLAUDE.md` |
| 20 | ✅ `/api` `Cache-Control: no-store`(HF4, #161) | `server/src/index.ts` |
| 21 | **응답 압축 + 정적 자산 캐시 헤더**(P-1): Caddy `encode zstd gzip`(`/api/auth/*`는 BREACH 보수로 제외), `express.static(WEB_DIR, {immutable:true, maxAge:'1y'})`는 해시 자산(`/assets/*`)만·`index.html`은 `no-cache` | `caddy/Caddyfile`, `server/src/index.ts:72` |
| 22 | **무거운 라이브러리 지연 로딩**(P-2): xlsx·html2pdf.js·jszip를 내보내기/가져오기 시점 `import()`, 통계·영상·관리·일괄 import 화면 `React.lazy` — **HF6(xlsx 0.20.3 교체)와 같은 파일을 건드리므로 HF6 머지 후**(✅ HF6 #164 머지 완료 → 착수 가능) | 6모듈 `utils/exportHandlers.js`, `core/utils/exportService.js`, `BatchImportModal.jsx`, `App.jsx` |

---

## 기능 PR ↔ 리팩터링 PR 충돌 방지

- **큰 파일 분할(`move`) 먼저, 당일 착륙**(아침 열고 당일 머지; 안 끝나면 더 쪼갬). `App.jsx`/`patients.ts`/`statsEngine.ts`/`main.js`/`index.css`를 건드리는 기능 PR은 분할 전 대기, 후 rebase.
- **freeze window**: PR 제목 `[freeze App.jsx 10/21]`, 최대 24h, 대상 C3-①⑦⑧·S5·S7-③④·S6-①·E1·C10-①·D5. 창 후 `scripts/codemod-imports.mjs`(경로 변경 맵)로 기능 브랜치 자체 rebase.
- **안정 seam**: 공개 팩토리 시그니처(`createPatientsRouter(pool)` 등), `registerModule` 매니페스트 키(추가만), `window.electron` 키(추가만)는 Phase 종료까지 유지; re-export shim은 1릴리스 유지 후 `no-restricted-imports` deprecation으로 제거.
- 진행 중 기능이 있는 파일은 리팩터링 보류("2주 no-touch" 목록 유지); 리팩터링 브랜치 수명 ≤2일. 주간 리듬: 월·화 `move`/freeze, 수~금 `safe` + 기능.
- 모든 리팩터링 PR = 전체 CI(통합·docker 포함); `flagged`는 두 Electron 타깃 수동 스모크 추가. 동시성 수정은 실DB로 실패 재현 후 복원(기존 교훈).

---

## 검증 전략 · 완료 정의

| Phase | 자동 | 수동 | DoD |
|---|---|---|---|
| H | HF별 단위/라우트 테스트(간호 계정 비담당 덮어쓰기 불가 · 임시비번 403 · preload 콜백에 event 없음 · `/api` no-store · 외부 벤더 미비식별 400 · 웹 토큰 없음 403/초과 429 · 서명 불일치 다운로드 거부) | 7.1.4 설치본 릴리스 게이트(`docs/UPDATE_7.1.4.md`: 설치·EMR·AI·일괄 import roundtrip·서명 업데이트 실기기 시험), Vercel preview | 7.1.4 운영 배포 완료(HF8 포함; 코드 머지는 완료, 배포는 게이트 통과 후) |
| 0 | CI 6 job green, G1–G10 존재, suppressions 수 추세 ↓, `git ls-files --eol` CRLF 0 | 현장 PC 크롬 버전 확인 | `.jsx` 린트됨·src typecheck 켜짐·`@wr/*` 단일 해석·skip 0 |
| 1 | 서버 unit/integration 프로젝트, G5/G6 불변, `grep res.status(500)` 0, `patient_records` 쓰기 파일 1 | 실DB 동시성(PATCH/락/claim), Tier-3(docker postgres → dev-intranet-server.ps1 → `npm run dev`) | 라우트 ≤400줄·하네스 단일·`stats/` 트리·체크섬 활성·SIGTERM 정상 종료·보안 bundle 종결 |
| 2 | G1–G4·G8·G9 불변, lint: core→modules 0·`window.electron` 어댑터 외 0·stylelint 0, `typecheck:client` 전 파일 | 두 Electron 타깃 + Vercel preview 스모크, 다크모드 육안, Chrome 109 환경 1회 | `App.jsx` ≤200줄·매니페스트 검증·서술 단일 소스 ADR·twin parity·src TS ≥80% |
| 3 | Electron 테스트 82+·`ipcRegistration`·asar 검사·버전 일관성 | 설치본 2종 설치·업데이트 경로 | `main.js` ≤150줄·타깃별 IPC·`build-target.json` 없음·asar <40MB |
| 4 | 스키마 생성 diff 0·pytest parity·catalog 가드·distSmoke | – | `protocol.py` dict 0·버전 리터럴 1곳·elbow/wrist 팩토리 |
| 5 | `계획서(` grep 0, 링크 체크 | – | ADR 전부·stale 문서 0·CHANGELOG 단일 |

**프로그램 DoD**: 위 전부 + 보안 32건 각 Phase에서 종결 + 운영 1릴리스(7.2.0) 무회귀 배포 + 고관절 모듈 추가 시 core 수정 0임을 더미 모듈로 증명.

## 리스크 · 열린 항목

- **Chrome 109 가정 리스크**(D2): 현장 확인 전 target 상향 금지. 확인 결과 <109면 그 값으로 browserslist 설정, <93이면 `Object.hasOwn` 금지 유지.
- **HF1 동작 변경**: 비담당 환자는 워크스페이스 저장에서 제외(`skipped[]`), stale revision은 덮어쓰지 않음(`conflicts[]`) → 클라이언트가 둘 다 사용자에게 알려야 함(토스트 + 충돌은 기존 `ConflictResolveModal` 경로로 유도) — 7.1.4에 포함. 워크스페이스 저장이 더 이상 "최신본 강제 반영"이 아니므로 UPDATE 안내서에 명시.
- **7.1.4는 Electron 셸 변경을 포함한다**: 7.1.3 안내서는 "재설치 불필요"였지만 HF2(`audit.js`)·HF3·HF9·HF7 독립형이 셸을 바꾼다 → 설치본 교체/자동 업데이트 필요(서버만 올리면 서버 측 보호만 적용). **7.1.4 서버 + 7.1.3 이하 셸** 조합에서는 디바이스 상태가 active가 아닌 PC에서 임시 비밀번호로 로그인할 때 디바이스 등록 요청(=관리자 승인 대기열 등록)이 최대 20분 지연된다(앱 재시작으로 해소; 서버는 등록을 항상 pending→관리자 승인으로 처리). 사용자 결정(2026-10-16)으로 서버 예외 없이 유지하고 UPDATE_7.1.4 안내서에 명시 — 셸을 먼저 배포하거나 신규 계정 발급을 셸 교체 뒤로 미룬다.
- **HF6 xlsx URL 의존성**: 오프라인 패키지 빌드는 연결된 PC에서 수행(lock integrity로 재현성 확보). 대안 exceljs 전환은 Phase 2 C6/C9에서 재검토.
- **HF8 서명 키 운영**: 개인키는 서버 밖(릴리스 PC) 보관, 분실 시 앱 재배포 필요 → 절차 문서 필수. 검증은 `files[]` 포함 전수 비교여야 하며(최상위 sha512만 비교 시 우회), 앱에 내장된 공개키가 바뀌면 그 전 버전은 새 피드를 거부하므로 키 교체는 "구키로 서명한 과도기 릴리스"를 거친다. **구현(#169~#172)**: yml을 파싱해 electron-updater의 `info`와 `isDeepStrictEqual`로 전체 비교(`files[]` 포함), 셸의 공개 키는 목록(복수 지원)이며 비면 모든 업데이트를 거부한다. 서명 키는 저장소·클라우드 동기화 폴더 밖에 보관하고(패키징 스크립트가 경고), 비밀 키와 암호는 오프라인 백업한다. **7.1.3 → 7.1.4 전환은 서명 보호 밖**이다.
- **HF7 구조화 입력 전환은 계약 변경**: 내부 LLM 사용 조직은 `fullReport` 옵션으로 현행 품질 유지(D6), 외부 벤더 조직은 프롬프트 품질이 바뀌므로 7.1.4 UPDATE 안내서에 명시. 클라이언트·서버·서버리스·Electron 4곳이 같은 빌더(`@wr/contracts` `aiPrompt`)를 쓰는지 계약 테스트로 고정(3곳의 import 경로가 다르므로 각 배포물에서 실측 — 완료: 서버는 `@wr/contracts`, Vercel은 `shared/dist/*.cjs`, Electron은 asar 안의 `shared/dist/*.cjs` 3개 + `zod`). 운영 전제와 내부 LLM 보류는 위 "Phase H 구현 결과" 참조.
- **S7 upsert 경로**: HF1의 두 단계 upsert(advisory lock → FOR UPDATE → 인가 재검증)를 `patientRecordsService.upsert`의 표준 패턴으로 승계(ON CONFLICT 단일문 금지).
- **S7-④ PATCH 수렴**: FOR UPDATE 앵커·락 경합 — 실DB 재현 테스트 없이는 머지 금지.
- **C8 컴포넌트 쌍둥이 유지**는 타협(에이전트 간 이견: 전면 팩토리 vs 유지). wrist 테스트 0이 해소되면 재평가.
- **H5·M10**은 코드로 못 닫음(수용/운영) — ADR과 운영 문서로 기록.
- mock-intranet은 유지·정리(D2); Tier-2 검증 경로 보존.
- **마이그레이션 번호 충돌 주의**: 이 문서의 S8(큐 namespace)·S10(체크섬)은 "0038"로 적었지만, 이월된 "권한 설명 문구 갱신" 마이그레이션(메모리 `project_limited_disclosure_all_modes`)도 0038을 예정 → 착수 시 `server/migrations/`의 다음 빈 번호를 쓰고 문서 번호를 갱신한다(체크섬 S10 도입 전까지는 번호 중복이 조용히 지나갈 수 있음).

## 착수 순서 (새 세션 시작점)

1. (완료) 결정 D1–D8과 정정 사항(서버 vitest=dist, AI 분기=analysisClient.js)을 메모리에 저장함.
2. **Phase H 코드·릴리스 문서 main 머지 완료**(2026-10-18, PR #159~#172, HEAD `77e6686`, 버전 7.1.4). 세부 결과는 Phase H 섹션 "구현 결과", 계획은 메모리 `project_phase_h_hotfix_plan`.
3. **7.1.4 배포(사용자 몫)**: `npm run electron:build:intranet`(EMR 헬퍼 때문에 dotnet 필요) → `export-offline-package.ps1 -UpdateSigningKey "<비밀 키>"`(암호가 걸린 키면 같은 창에 `WR_UPDATE_SIGNING_PASSPHRASE` 설정) → `docs/UPDATE_7.1.4.md` 릴리스 게이트(설치본 수동 점검 + 서명 업데이트 실기기 시험) 통과 → 운영 배포. 서명 비밀 키와 암호는 오프라인 백업.
4. Phase 0은 H 배포와 병행 가능하되, 충돌 최소화를 위해 CI(P0-1)·ESLint(P0-4)·줄끝(P0-8)부터.
5. 각 Phase 완료 시 이 문서의 해당 표에 "완료(PR#, 날짜)"를 기록하고 메모리 `project_refactoring_roadmap`을 갱신한다.

---

# 부록 A — 현황 지표 (그래프 + 라인 집계, 2026-10-15 main 5604f36 — Phase H 머지 이전 스냅샷, Phase 0 착수 시 재집계)

| 영역 | 파일 | 총 줄 | 테스트 줄 | 제품 코드(≈) |
|---|---|---|---|---|
| src/core (클라이언트 공유) | 245 | 42,126 | 15,571 | 26.5k |
| src/modules (6개 평가 모듈) | 73 | 9,068 | 1,683 | 7.4k |
| server/src | 226 | 52,347 | 29,859 | 22.5k |
| server/migrations | 37 | 1,084 | – | 1.1k (0001~0037) |
| packages/analytics-core | 106 | 18,347 | 7,469 | 10.9k |
| shared/contracts | 27 | 5,308 | 2,459 | 2.8k |
| electron | 18 | 3,715 | 452 | 3.3k (+ EmrHelper.cs 1,471) |
| scripts | 25 | 3,845 | 197 | 3.6k |
| services/stats-engine | 24 | 5,073 | 2,642 | 2.4k (protocol 622·prediction 512·regression 510·bivariate 334) |
| services/pose-inference | 24 | 3,911 | 1,208 | 2.7k (feature_calc 600·infer_clip 584) |

그래프: 872 파일 / 12,123 노드 / 135,857 엣지, 함수 4,591 · 테스트 노드 6,431. src/는 .jsx 132 + .js 184, TS 0. CSS: `src/index.css` 4,051 + statistics-workbench.css 429 + charts.css 83. 추적 파일 978, 15.7MiB.

거대 파일(제품): `server/src/routes/patients.ts` 1,680 · `statsEngine.ts` 1,454 · `routes/admin.ts` 1,100 · `routes/videoAnalysis.ts` 1,090 · `routes/workspaces.ts` 726 · `shared/contracts/stats.ts` 1,765 · `src/core/components/VideoAnalysisStep.jsx` 1,464(컴포넌트 함수 850) · `AdminConsoleModal.jsx` 1,312 · `statistics/ResultPanel.jsx` 1,261 · `RecipePanel.jsx` 1,030 · `StatisticsWorkbench.jsx` 747 · `Dashboard.jsx` 670 · `src/App.jsx` 1,002(App 함수 932, out-degree 187, 무테스트) · `electron/main.js` 1,396 · `EmrHelper.cs` 1,471 · `src/core/fixtures/createTestPatients.js` 867.

거대 테스트: `patients.test.ts` 2,839 · `videoAnalysis.test.ts` 1,486 · `admin.test.ts` 1,163 · `stats.test.ts` 926 · `workspaces.test.ts` 914 · `audit.test.ts` 724 — 허브 노드 상위 10개 중 5개가 테스트의 `makePool/makeApp/orgToken/q`.

churn(2026년 425커밋, 제품 코드): App.jsx 73 · package.json 61 · index.css 48 · exportService.js 29 · server/index.ts 28 · electron/main.js 28 · VideoAnalysisStep.jsx 27 · reportGenerator.js 22 · stats.ts(contract) 21 · server/config.ts 21 · patients.ts 20.

미테스트 핫스팟(그래프): `App`(189) · `createAdminRouter`(119) · `VideoAnalysisStep`(108) · `elbow/index.js::applyRow`(101) · `wrist/index.js::applyRow`(100) · `AdminConsoleModal::load`(94) · `createPatientsRouter`(93) · `buildPredictionCsv`(91). (`usePatientSync`는 부분 테스트 있음 — 그래프 오탐.)

# 부록 B — 상세 진단 (탐색 결과, file:line 근거 — 2026-10-15 진단 기준. Phase H에서 닫힌 항목[multer·xlsx·AI 프록시·preload IPC·CSRF dead code·업데이트 서명 등]은 당시 서술이며 현재 코드와 다르다)

- **클라이언트/Electron**:
  - `src/App.jsx`(App 함수 68–999): useState 22·useRef 7·커스텀 훅 22·useEffect 9, 스토어/리듀서 없음. 자연 경계 8개: ①부트/인증 게이트(:592–650, `useAuthSync`는 AuthProvider로) ②화면 라우터(`activeScreen`/`showHome`/intake/statistics :94–98,:543–553,:658–764) ③환자 scope+roster 훅(:71–72,:139–148,:290–335) ④환자 워크스페이스 provider(patients/activeId/selection/filters/CRUD/sync/lock/conflict, `handleSwitchPatient` :373–426) ⑤모달 컨트롤러(불리언 8개+`modalsProps` 62키 :562–587) ⑥미저장 초안 가드(:101–132,:444–464) ⑦Electron 브리지(:200–202,:438,:444,:557) ⑧`<WorkspaceScreen>`(:783–998). 컨텍스트는 `AuthContext` 하나뿐인데 `session`을 61파일에 prop으로 전달, `StepContent` 32 props·`MainHeader` 26·`AppModals` 62키. dead: `{false && …}`(:897–905), `StepContent.jsx:150–156`의 미사용 props 5개.
  - 상태/데이터 흐름: `patients` = `useState([])`(App.jsx:70) 쓰기 주체 10곳(usePatientCrud 4·useConflictResolution 4·usePatientSync 3·useWorkspacePersistence 3·useEMRIntegration 2·…), `touchPatientRecord` 호출 스타일 6종. `useEvaluationDateSync.js:7–24`가 effect에서 파생 상태를 되써서 dirty→서버 push 유발. `usePatientSync.js` 599줄(prop 7개 ref 미러링, debounce·5분 interval·pull·flush barrier), 머지 로직이 훅과 `patientServerRepository.js`(:375,:404,:449,:515)에 분산. 마이그레이션 로드 시 2회 실행(`storage.js:31,41,110,118` + `workspaceRepository.js:72`). localStorage 키가 7개 모듈에 산재(`authChannel.js`는 `wr-auth-*`로 접두사 규약 위반). **잠복 버그**: `jobFilter` 기본값이 `''`(App.jsx:47, PatientSidebar.jsx:19) vs `'all'`(usePatientList.js:6,:68, PatientSidebar.jsx:236) — `usePatientList.js:103`의 `jobFilter.trim()`이 'all'을 포함 검색으로 처리, App이 항상 ''를 넘겨 가려짐.
  - 모듈 균일성: 6모듈 모두 `registerModule` 호출하나 `createDiagnosis`(knee·shoulder만), `videoMappingConfig`(elbow·wrist 없음), `presetConfig.fields`(배열 vs 문자열 'tasks' — `PresetManageModal.jsx:263,284,312,342` 분기), `exportHandlers.pdf`(spine·cervical 없음), 평가 컴포넌트 prop 시그니처 8종, `tabs` id 상이. 레지스트리 검증·매니페스트 typedef 없음(`moduleRegistry.js:14–16`). **쌍둥이**: elbow↔wrist(이름 정규화 후 diff: exportHandlers 4줄/154, ExposureForm 41/570 — 문구 드리프트('경미' vs '경도'), ResultPanel 41, DiseaseSpecificFields 63, data.js 91, index.js 66), `applyRow`(`elbow/index.js:126–211` ≡ `wrist/index.js:116–203`), `PRESET_COMMON_FIELDS`+extract/apply 동일. knee↔shoulder: Evaluation 컴포넌트 주석 1줄 차이, `jobExtras` upsert 골격 동일. `getSideText` 8벌, `SummaryCard` 4벌, "직력N: name (X.X년)" ~8곳, `${y}년 ${m}개월` 생성 4곳+정규식 파싱(`parseWorkPeriodOverride` 있는데도), 연 근무일 250 기본값 3곳. dead: `knee/components/PresetSearch.jsx`(134줄), `spine/utils/time.js`, `core/components/ModuleSelector.jsx`.
  - **플러그인 경계 붕괴**: core가 모듈 내부를 30 import 라인에서 참조(`emrReport.js:6–12`, `reportGenerator.js:2–12`, `exportService.js:3–6`, `assessmentGroups.js:6–7`, `AssessmentTab.jsx:2–3`, `usePresetManagement.js:6` — knee가 사실상 공용 라이브러리). 일괄 Excel 포맷 3벌(`exportService.js` BATCH_HEADERS :96–124 + `generateBatchRows` :133–366 `row.push` ~95 / 모듈별 `batchImportConfig.columns` / `BatchImportModal.jsx:18–140`), 테스트는 앞 7열만. **의학 서술 텍스트 3벌**(모듈 exportHandlers / `reportGenerator.js` / `emrReport.js`(내부 `buildExposureSection`:38·`buildExposureSummary`:211 중복)) — BK2117 규칙 `over50>=3||over75>=2` 4곳, 무릎 4단계 범례 4곳.
  - analytics-core와의 병렬 사본: 계산식 자체는 중복 아님(`src/modules/*/utils/calculations.js`는 re-export shim). 그러나 상수/팩토리(`elbow/utils/data.js:4–87` ≡ `analytics-core/modules/elbow/constants.ts:12–84`, wrist·cervical 동일 8심볼)와 정규화기(`syncElbowModuleData` vs `normalizeElbowModuleData`)가 병렬, 완료 판정 레지스트리 2개(`patientCompletion.js` vs `completion.ts`). **주석이 참조하는 골든 `utils/__tests__/legacyParity.characterization.test.js`는 존재하지 않음.**
  - 거대 컴포넌트 분할 지점: `VideoAnalysisStep.jsx`(순수 헬퍼 ~40개 :47–613, `EvidencePanel`:377·`FlatCandidateList`:443, useState 16, `MOCK_BUNDLE`:40이 `videoServerApply.js:9` 중복). `AdminConsoleModal.jsx`(탭 9개 inline, useState 65·useEffect 10, `requestJson` inline 25, baseUrl 재유도 9). `ResultPanel.jsx` 1,261(라벨 사전 :18–111이 RecipePanel과 중복). `RecipePanel.jsx`(useMemo 9). `StatisticsWorkbench.jsx`(useState 31, `workbenchTransitions.js` 순수 전이 존재). `Dashboard.jsx`(수제 차트 3개가 `charts/` 중복, `MODULE_LABELS/COLORS` 레지스트리 중복). `SettingsModal.jsx:6` `DEFAULT_INTRANET_URL`에 :8443 없음 ≠ `main.js:24`.
  - 요청/데이터 접근: `httpClient.js` 401-refresh 3회·CSRF 재시도 2회·에러 추출 4회 반복; loading/error ~13곳 수제; `getBaseUrl` 3벌+JSX 5곳; raw `fetch` 5곳. AI 분기는 `services/analysisClient.js:39–81`(CLAUDE.md의 `useAIAnalysis` 서술 부정확), 독립형 API 키 localStorage 직접(:4–14).
  - 플랫폼 분기 5축 산재: `isElectron()` 호출 2곳뿐, `window.electron` 60곳/14파일, `isElectronFS` 2벌, 인트라넷 판정 6벌(App.jsx:139·useServerConfig.js:20·useIntegrationStatus.js:9·integrationStatus.js:10·workspaceRepository.js:32·workspaceAutosavePolicy.js:1; 76곳/33파일), 렌더러가 빌드 타깃을 preload 키 존재로 추측(`App.jsx:456`).
  - 스타일: `index.css` 4,051줄(톱레벨 클래스 737, `elbow-` 58·`wrist-` 53·`video-/va-` 129·`admin-` 51), 토큰 28개(`var(--…)` 740 vs raw hex 174), 다크모드 `data-theme` + 산발 override(index.css:1757,2480), inline `style={{}}` 149(hex 18).
  - TypeScript: src/에 TS 0. 루트 tsconfig include `src/**/*.ts(x)` 매치 0, allowJs/checkJs false → `typecheck`는 shared/packages만. JSDoc 64태그/15파일.
  - 호환 하한: `vite.config.js:41` chrome80(2026-06-03 f53eec4 Win7 흰화면 수정), `crypto.randomUUID()` 43곳/11파일(폴백은 usePatientLock.js:44만), `verify-chart-compat.mjs`는 Chrome 109 기준·charts/만.
  - Electron: `main.js` 책임 13개(빌드타깃 :27–34·상태 IPC :41–75·자동업데이트 :119–300·창/종료·메뉴 :520–610·부트·다이얼로그·AI 프록시 :693–775(`api/analyze.js:75–140`과 중복, `ALLOWED_MODELS` 누락)·LevelDB 파서 :778–940·fs-* 16(:944–1148)·마이그레이션 스냅샷·EMR 헬퍼(:1193–1382, `execEmrInject`가 `runHelper` 재구현, PHI JSON `os.tmpdir()`)·라이프사이클). IPC 29채널 중 standalone 전용이 무조건 등록. preload 2종 11키 중복. `electron/__tests__` 82케이스는 순수 모듈만, `audit.js`·`auditQueue.js`·핸들러 무테스트.
  - 테스트: src 111파일 ~1,408케이스, setupFiles·공유 render 헬퍼·`__mocks__` 없음, `vi.mock` 78/43파일, StatisticsWorkbench 테스트 6개 fixture 재선언. 무테스트: App.jsx·AdminConsoleModal·Dashboard·PresetManageModal·BatchImportModal·SettingsModal·`authChannel.js`(276줄)·wrist/shoulder 모듈 자체 테스트 0. `createTestPatients.js`(866줄)는 **프로덕션 기능**(usePatientCrud.js:283 동적 import).

- **서버/공유계약/analytics-core/Python**:
  - 계층 부재: 라우트 `.query(` 193곳(patients 61·admin 34·videoAnalysis 30·capabilityGrants 21·auth 16·workspaces 16·presets 8). `patient_records` 쓰기 7경로(patients.ts:723,921,1053,1382·workspaces.ts:368·videoAnalysis.ts:977·patientIdentityCorrection.ts:182 + seed CLI). `withWriteTransaction`은 stats 5곳만, 수동 BEGIN 18곳. 가시성 술어 9곳, `deleted_at IS NULL` 45곳/10파일, 완료추적 컬럼 7개 8곳 나열. `workspaces.ts:8` ← `patients.ts:157 withDeadlockRetry`.
  - 에러: `.catch(() => res.status(500).json(internalError()))` 64곳, `internalError` 11벌, 라우트 `console.error` 1개, `ai.ts:135` `err.message` 누출, 23505 매핑 7곳, `instanceof`→status inline 18. `pino` 미사용(console.* 78).
  - 횡단관심사: `middleware/{auth,patientAccess,csrf,adminOnly,requireCapability,rateLimit,audit}.ts` 존재하나 라우트별 수작업 — org 검사 24곳, 담당의 규칙 5벌, 락 게이트·If-Match 3벌, videoAnalysis 자체 `SessionInfo`+`as unknown as` 11, `req.sessionInfo!` 51, `csrf.ts:8 EXEMPT_PATHS` dead, `requireCapability`가 stats 가용성 결합, 검증 응답 4종, 플래그 적용 4종, audit 클로저 3벌·`writeAuditLog` 46 직접 호출.
  - 구조: `stats*.ts` 55개·12.1k줄 평면. `statsEngine.ts` 1,453 = 프로토콜 타입(:17–130)+zod 응답 6종(:135–840)+입력상한+출력검증+서브프로세스(:1002–1333)+러너 6벌(:1340–1453). `validateRecipe` 420줄(:199–618), grain 목록 `routes/stats.ts:42` 주석 동기화. `statsExportHandler.ts:27` `StatsRunRow` 재선언. admin.ts 6 서브도메인(GPU probe Python 스폰 :819–832 포함).
  - 팩토리: `createXxxRouter(pool)` 위치 인자, deps 객체 없음, config 싱글턴 22파일, 시계 주입 없음, 유일 seam `createVideoAnalysisWorker(pool, deps)`. `index.ts` app 조립+부팅(:95–162), import만으로 pg pool 생성(`db/client.ts:3`), SPA fallback이 `/api` 404를 HTML로, shutdown/request-id/access log 없음.
  - DB: drizzle 미사용. 마이그 0001~0037 연속·down 없음·체크섬 없음, 부팅 자동 실행(:98), 0034~0036이 같은 설명 3회 UPDATE. `process.env` 우회 8파일, Python 경로 `cwd` 기준(config.ts:10–27). 큐 2벌 전역 claim(`statsRunsQueue.ts:291`), `index.ts:139` flag만 vs `statsWorkbenchRuntimeState.ts:20` flag+intranet.
  - 테스트 하네스: 공유 유틸 0. `makePool` 24·`makeApp` 18·config mock 27·`generateAccessToken` 26, 형태 3종, "첫 query=auth" 순서 결합, include glob이 헬퍼 공유 방해. 통합 16개 `skipIf(!TEST_DATABASE_URL)` 혼합, 마이그 미실행, dev DB 지정 9개, 9개가 자체 워커 기동.
  - 빌드/링크: workspaces 없음 → 4 트리·락. 클라 vite/tsc=dist·루트 vitest=소스; **서버 tsc/tsx/vitest 전부 dist**. root `typecheck/lint`, server `test/typecheck/lint` 전 prebuild 없음. 지정자 `@contracts` vs `@wr/contracts`. dev zod 이중(shared/node_modules/zod). shared tsup 엔트리 video* 5 누락. analytics-core tsup 19엔트리 `splitting:false` → 레지스트리 복제(`dist/index.js` knee만·`catalog.js` 9·`completion.js` 6). 훅: `prebuild` 미발화, `electron:build` prebuild 2회.
  - 계약 드리프트: 서버 로컬 zod 미러(`patients.ts:60–84`, `workspaces.ts:16–26`; "런타임 의존 없음" 사유는 `validatePastDate` import로 이미 거짓). Node↔Python: TS(`statsEngine.ts:19–840`) vs Python jsonschema(`protocol.py:66–350`), 버전 `6` Python 7곳, parity는 상수 4개 regex. 히스토그램 TS/numpy 양쪽(parity fixture). pose CLI 인자 수기, 워커 keypoints inline cast(`videoAnalysisWorker.ts:157–170`).
  - analytics-core: elbow/wrist 쌍둥이(derived 769/776, diff 211; extractors diff 16), legacyNormalize 4벌, 변수당 3곳 수기, `CATALOG_VERSION`(`catalog.ts:305` 'v31') 수동 + 190줄 주석 changelog, 가드 없음.
  - Python: stats-engine 13 pytest(설정·npm 스크립트 없음), pose 7 스크립트. 운영 핀 3.11/numpy 1.26 vs 로컬 3.14/numpy 2.5.
  - 타입/린트: server strict·`any` 0(양호), `as unknown as` 16·`sessionInfo!` 51. shared/·packages/ 미린트, Python 린터 없음, **CI 없음**.

- **도구·빌드·테스트·CI·문서·위생**: CI 0(`.github/dependabot.yml`만, 루트 npm만). `eslint.config.mjs` `files` 없음 → .jsx 134 미린트. 루트 tsconfig src 미포함. vitest 2 config(루트 기본 node, 46파일 jsdom opt-in; 서버 alias 없음). 케이스: src ~1,408·shared ~274·analytics-core ~740·electron ~72·server ~1,602(통합 ~160)·pytest 234·pose 47·Playwright 6. 포매터 없음, 워킹트리 CRLF 276/mixed 2, README 인덱스 CRLF. CSP는 helmet(`style-src 'unsafe-inline'`), Electron Win7 `no-sandbox`, 코드서명 없음. asar 81.6MB(테스트·`.cs`·`obj/`·`public/` 중복·node_modules 60). `build-target.json` gitignore이나 asar 포함. 버전 4곳 수기(package.json·lock·README.md:3·PRD.md:3-4)+UPDATE_<v>.md+`.env.production` WR_VERSION. 백업 export 스크립트 2개+문서 미출하. scripts/ 30개(dead: `mock-intranet-server.cjs`·`Test-EMR-Hook.ps1`; 0참조: `verify-shoulder-roundtrip.mjs`·`dev-intranet-stack.ps1`·`regenerate-sample-batch-import.mjs`). 문서: PRD·PRODUCTION_RELEASE_PLAN 최신, ARCHITECTURE_DIAGRAM(2026-04-09)·INTRANET_API_CONTRACT(2/15 라우터)·DOMAIN_SCHEMA/MODULE_STORAGE 헤더·OPERATIONS_RUNBOOK·AGENTS.md stale, changelog README(157KB)·PRD(288KB) 이중, ADR 없음, 127파일이 계획서 인용(8/10 부재). 저장소: `.code-review-graph/wiki` 30개 추적, `.sln`, 루트 `.xlsm`, `analytics-core/coverage/`(실 소스), 루트 ignore된 GPG 개인키(.dockerignore 미포함), 로컬 브랜치 13개 stale. 의존성: express 4.22·vitest 1.6.1·supertest 6(deprecated)·multer 1.4.5-lts.2·xlsx 0.18.5·electron 22·electron-updater 6.1.9·zod 3.25.76×3·Docker node:20(EOL).

- **보안 점검 상세(32건 + 양호 항목)**: 본문 "보안 항목 추적표" 및 Phase H/bundle 항목 참조. 양호(보존): refresh 토큰 해시+HttpOnly/SameSite=Strict/Secure, token family 회전+재사용 탐지(`sessionStore.ts:184-225`), 매 요청 DB 세션 재검사, access token 메모리 전용; bcrypt 12+더미 해시, 이력 5; CSRF 세션 결합, 상태변경 GET 없음; 전 쿼리 org 스코프(타 org 404), FK `grant_user_in_org`; **SQL 전부 파라미터화**; 업로드 난수명·magic byte·크기·realpath 격리; 서브프로세스 배열 인자·stdin·timeout, Python에 eval/pickle/shell=True 없음; Helmet CSP·CORS 허용목록·non-root 컨테이너; Electron contextIsolation/sandbox·origin 락·EMR 디바이스 승인·Ed25519 safeStorage·감사 큐 암호화; 통계 억제 서버측·export 억제본·run 가시성; `dangerouslySetInnerHTML` 0·PDF 템플릿 escape; 백업 GPG(공개키만 서버)·restore YES·`.env` 제외·seed 기본 자격증명 없음.
