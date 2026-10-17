# Vercel AI 프록시 운영 보안 설정 가이드

> 이 문서는 `api/analyze.js`(웹/Vercel AI 프록시)를 **운영에 올리기 전에 Vercel 대시보드에서
> 반드시 등록해야 하는 환경변수**와, 코드로 해결할 수 없는 플랫폼 설정을 정리한 가이드입니다.
> **7.1.4부터 설정이 빠지면 AI 분석이 닫힙니다(503, fail-closed).** 배포 전에 아래 "배포 전 점검"을 먼저 끝내세요.

## 배경

`api/analyze.js`(Vercel 서버리스)는 웹 클라이언트의 AI 분석 요청을 받아 서버 환경변수
(`GEMINI_API_KEY` / `CLAUDE_API_KEY`)로 Gemini/Claude API를 호출하는 프록시입니다.
이 엔드포인트는 **로그인 없이 공개로 호출**되므로 다음이 모두 필요합니다.

- 비용 남용 방지: 호출 빈도·일일 총량 제한
- 환자 정보 보호: 외부 벤더로 나가는 내용을 서버가 통제

7.1.4에서 코드가 바뀐 점 (이전에는 없던 것):

| 영역 | 이전 | 7.1.4 |
|---|---|---|
| 요청 본문 | 클라이언트가 보낸 임의 `prompt`/`systemPrompt`를 그대로 벤더에 전달 | 비식별 구조화 입력(`input`)만 받고, **프롬프트는 서버가 직접 조립**. 임의 문자열 본문은 400 |
| 외부 벤더로 나가는 내용 | 환자 보고서 전문(이름·생년월일·병원·의사 포함) | 숫자·열거형 값뿐(이름·직종명·상병명·메모 없음). 보고서 전문은 외부 경로에서 거부 |
| 출처 | CORS 헤더만 설정(403 없음) | Origin 허용 목록 밖/없음 → 403 |
| 클라이언트 구분 | 없음 | `X-WR-Client` 토큰 필터 |
| 호출 빈도 | 제한 없음 | Upstash Redis: IP 분당 10·일당 100 + 전역 일일 예산 |
| 업스트림 오류 | 벤더 오류 메시지/`detail`을 그대로 반환, 원본 응답 JSON 반환 | 상세 비노출, `{ text }`만 반환, 60초 제한 시간·1MB 응답 상한 |

## 필수 환경변수

Vercel 대시보드 → 프로젝트 → **Settings → Environment Variables**. **Production뿐 아니라 Preview에도
같은 변수를 등록하세요.** 빠지면 그 환경의 AI 분석은 아래 표의 응답으로 닫힙니다.

| 변수 | 용도 | 비워 두면 |
|---|---|---|
| `GEMINI_API_KEY` / `CLAUDE_API_KEY` | 벤더 API 키(기존) | 해당 업체 모델 호출이 503 `AI_NOT_CONFIGURED` |
| `WEB_AI_CLIENT_TOKEN` | 서버가 검사하는 클라이언트 토큰 | **503** `AI_PROXY_NOT_CONFIGURED` (헤더가 없어도 통과시키지 않음) |
| `VITE_WEB_AI_TOKEN` | **빌드 시** 웹 번들에 들어가는 토큰. `WEB_AI_CLIENT_TOKEN`과 **같은 값** | 클라이언트가 헤더를 못 보내 403 `CLIENT_NOT_ALLOWED` |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 속도 제한 저장소 | **503** `RATE_LIMIT_UNAVAILABLE` (제한 없이 열어 두지 않음) |
| `WEB_AI_DAILY_BUDGET` | (선택) 하루 전체 AI 호출 상한. 기본 2000 | 기본값 2000 |
| `APP_ORIGIN` | (선택) 커스텀 도메인을 쓸 때 `https://도메인` | 아래 "Origin 허용 목록" 참고 |

토큰은 충분히 긴 임의 문자열을 쓰세요(예: `openssl rand -hex 24`). **`VITE_` 변수는 빌드 때 번들에 박히므로
토큰을 바꾸면 다시 배포(빌드)해야 합니다.**

### Upstash Redis 만들기

1. https://upstash.com 에서 Redis 데이터베이스를 만든다(리전은 Vercel 함수 리전과 가까운 곳).
2. 데이터베이스의 **REST API** 탭에서 `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`을 복사한다.
3. Vercel에 두 변수를 등록한다(Vercel Marketplace의 Upstash 연동을 쓰면 자동 등록된다).

설정할 값은 URL·토큰 두 개뿐입니다. `wr-ai:`는 사용자가 입력하는 값이 아니라 코드가 만드는 키 이름의 앞부분입니다. 첫 호출 때
`wr-ai:budget:global:<날짜번호>`, `wr-ai:ip-day:<IP>:<날짜번호>`, `wr-ai:ip-min:<IP>:<분번호>`가 자동으로 생기고, 분당 키는
약 2분, 예산 키는 약 1일, 일당 키는 약 2일 뒤 만료됩니다. 요청 1번당 Redis 명령을 최대 3번(분당 → 일당 → 전역 예산 순서)
쓰므로 무료 플랜의 일일 명령 수 한도를 넘지 않는지만 확인하세요. 한도를 넘어 Redis가 응답하지 않으면 요청은 503으로 닫힙니다.

### Origin 허용 목록

`api/analyze.js`는 다음 Origin만 허용합니다. **그 밖의 Origin이나 Origin 헤더가 없는 요청(curl 등)은 403입니다.**

- `http://localhost:3000`, `http://127.0.0.1:3000` — **production 배포에서는 제외**(preview/dev에서만)
- `APP_ORIGIN`
- Vercel이 제공하는 배포 도메인: `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`

커스텀 도메인(예: `https://wr.example.org`)으로 서비스한다면 반드시 `APP_ORIGIN`에 등록하세요.
등록하지 않으면 그 도메인에서의 AI 분석이 403 `ORIGIN_NOT_ALLOWED`로 막힙니다.

## 응답 코드 (문제 진단용)

| 상태 | `error.code` | 의미 / 조치 |
|---|---|---|
| 400 | `INVALID_REQUEST` | 본문 형식 오류(`details`에 경로·코드만). 옛 클라이언트(prompt 본문)는 여기서 막힘 → 새 번들로 재배포 |
| 400 | `MODEL_NOT_ALLOWED` | 허용 목록 밖 모델 |
| 403 | `ORIGIN_NOT_ALLOWED` | Origin 허용 목록 확인(`APP_ORIGIN`) |
| 403 | `CLIENT_NOT_ALLOWED` | `X-WR-Client` 토큰 불일치 — `VITE_WEB_AI_TOKEN`과 `WEB_AI_CLIENT_TOKEN`이 같은지, 토큰 변경 후 재빌드했는지 |
| 429 | `RATE_LIMITED` | IP/전역 한도 초과(`Retry-After` 초) |
| 429 | `AI_UPSTREAM_RATE_LIMITED` | 벤더 쪽 한도 초과 |
| 503 | `AI_PROXY_NOT_CONFIGURED` | `WEB_AI_CLIENT_TOKEN` 미설정 |
| 503 | `RATE_LIMIT_UNAVAILABLE` | Upstash 미설정, Redis 장애, 또는 Redis가 **2초 안에 응답하지 않음**(시간 초과도 열어 두지 않고 닫는다) |
| 503 | `AI_NOT_CONFIGURED` | 해당 업체 API 키 미설정 |
| 502 | `AI_UPSTREAM_ERROR` | 벤더 오류(상세는 Vercel 함수 로그의 `kind`/`status`에서만 확인) |
| 504 | `AI_TIMEOUT` | 벤더 응답 60초 초과 |

### Vercel 자체 500 (`FUNCTION_INVOCATION_FAILED`)

본문이 JSON이 아니라 `A server error has occurred … FUNCTION_INVOCATION_FAILED`이면 위 표의 응답이 아니라
**함수가 로드되지 못한 것**입니다(우리 코드가 응답을 만들기 전). 대시보드 → Deployments → 해당 배포 → Logs에서
오류 메시지를 확인하세요. 2026-10 PR #167 미리보기에서 한 번 발생했습니다.

- 원인: `api/analyze.js`가 `shared/dist/*.js`(ESM)를 import했다. 루트 `package.json`에 `"type":"module"`이 없어 Vercel이 함수를
  CommonJS로 변환하고("Node.js functions are compiled from ESM to CommonJS"), import가 `require()`가 되는데
  `shared/package.json`이 `"type":"module"`이라 ESM인 파일을 `require()`하게 된다. `require(esm)`을 지원하지 않는
  Node(20.19·22.12 미만)에서는 `ERR_REQUIRE_ESM`으로 로드가 실패한다. 로컬 Node 24에서는 되어서 테스트를 통과한다.
- **지켜야 할 것**: `api/analyze.js`는 계약을 `shared/dist/*.cjs`(CommonJS 빌드)에서만 가져온다. `.js`로 바꾸지 말 것.
  새 모듈을 import할 때도 그 파일이 CommonJS로 `require()` 가능한지 확인한다.
- 재발 방지 테스트: `scripts/__tests__/vercelAnalyzeCjsLoad.test.mjs` — `require(esm)`을 끈 Node에서 함수를 CJS로 변환해
  로드하고 핸들러를 한 번 호출한다.

## 한계 (이 설정이 막지 못하는 것)

### 왜 `X-WR-Client` 토큰을 인증 수단으로 쓰지 않는가 — 2026-10 결정 변경

이 토큰은 프론트엔드 번들에 들어가므로 **비밀이 아닙니다.** 번들을 열어 보면 누구나 값을 알 수 있어 진짜
인증이 되지 못합니다. 2026-06-12 리뷰에서는 그래서 채택하지 않았지만, 2026-10 계획에서 **인증이 아닌 "필터"
목적으로 도입**하기로 결정했습니다.

- 목적: 토큰을 모르는 봇·스캐너·단순 스크립트를 걸러 낸다. 번들을 분석해 값을 꺼내는 공격자는 통과한다.
- **실질적인 보호는 Origin 허용 목록 + Upstash 속도 제한 + 전역 일일 예산 + 모델 허용 목록 + 서버 조립 프롬프트**입니다.
- Origin 헤더도 브라우저 밖에서는 위조할 수 있습니다. 결국 최악의 경우에도 **하루 호출 수는 전역 일일 예산을 넘지 못합니다**
  (`WEB_AI_DAILY_BUDGET`). 비용 상한을 운영 판단으로 정하세요.
- 토큰이 유출되었다고 판단되면 `WEB_AI_CLIENT_TOKEN`·`VITE_WEB_AI_TOKEN`을 새 값으로 바꾸고 재배포하세요.

### 환자 정보

외부 벤더로 나가는 입력은 서버 스키마가 숫자·열거형만 허용하도록 강제하므로(이름·생년월일·직종명·상병명·메모를
담을 키가 없음) 클라이언트가 변조되어도 식별정보를 실어 보낼 수 없습니다. 다만 **나이·성별·키·몸무게·상병 코드 조합은
재식별 가능성이 0이 아닙니다**(계획 D6에서 수용). 더 줄이고 싶으면 `demographics`를 구간화하는 것을 별도로 검토하세요.

## 1. Vercel Deployment Protection

Vercel 대시보드 → 프로젝트 → **Settings → Deployment Protection**에서 설정.

- **Standard Protection**: Preview 배포에 대해 Vercel 로그인 또는 공유 링크를 요구. Production 배포에는 기본적으로
  영향이 적으므로, Preview URL이 외부에 노출되지 않도록 하는 최소 조치로 우선 적용 권장.
- **Vercel Authentication**: 모든 배포(Preview 포함)에 대해 Vercel 계정 로그인을 요구. 내부 검토용 배포가 많다면 고려.
- 이 프로젝트의 `api/analyze.js`는 **Production에서 일반 사용자가 호출해야 하므로**, Production 자체에 로그인 보호를
  걸면 정상 사용이 막힙니다. Deployment Protection은 주로 **Preview 배포 노출 방지** 목적으로 적용하세요.
- Preview에서 AI 분석을 시험하려면 Protection을 우회하는 방법(공유 링크/우회 토큰)이 필요하고, 위 환경변수가
  **Preview에도** 등록되어 있어야 합니다.

## 2. WAF / Rate Limit (Vercel Firewall) — 보조 수단

코드의 Upstash 속도 제한이 1차 방어이고, 아래는 **그 앞단의 보조**입니다(Pro 플랜 이상).

- **Rate Limiting 규칙**: `/api/analyze` 경로에 대해 IP 기준 요청 수 제한(예: 1분당 N회)을 Vercel Firewall에서 추가하면
  Redis 호출 자체를 줄일 수 있습니다.
- Firewall 규칙은 코드의 제한보다 **느슨하게** 두어, 정상 사용자를 이중으로 막지 않게 하세요.

## 3. 모니터링

- Vercel 대시보드의 **Usage** 탭에서 `api/analyze` 함수 호출 수/에러율을 주기적으로 확인. 급격한 증가는 남용 신호일 수 있음.
- 함수 로그에서 `[ai] upstream failure` (벤더 오류 `kind`/`status`)와 `[ai] rate limit backend failure` (Redis 장애)를 확인.
- Gemini/Claude 콘솔의 API 사용량 알림(billing alert)을 설정해 두면, Vercel 설정과 무관하게 비용 급증을 조기에 인지할 수 있음.
- Upstash 콘솔 Data Browser에서 `wr-ai:*`로 검색하면 `wr-ai:budget:global:<날짜번호>` 키의 값이 그날 전체 호출 수입니다.
  (분당 키는 약 2분 뒤 사라지고, 비어 보이면 새로고침·Scan을 누르거나 환경변수 URL이 이 데이터베이스의 것인지 확인하세요.)

## 배포 전 점검 (체크리스트)

1. [ ] Vercel **Production**과 **Preview** 모두에 `WEB_AI_CLIENT_TOKEN`, `VITE_WEB_AI_TOKEN`(같은 값), `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `GEMINI_API_KEY`/`CLAUDE_API_KEY` 등록
2. [ ] 커스텀 도메인을 쓰면 `APP_ORIGIN` 등록
3. [ ] 배포 후 실제 브라우저에서 AI 분석 1회 성공 확인(모델별 Gemini/Claude 각 1회)
4. [ ] 브라우저 밖에서 차단되는지 확인 — 아래 모두 403이어야 정상:
   ```
   curl -i -X POST https://<도메인>/api/analyze -H "Content-Type: application/json" -d '{"input":{}}'
   curl -i -X POST https://<도메인>/api/analyze -H "Origin: https://<도메인>" -H "Content-Type: application/json" -d '{"input":{}}'   # 토큰 없음 → 403 CLIENT_NOT_ALLOWED
   ```
5. [ ] 일일 예산(`WEB_AI_DAILY_BUDGET`)을 비용 상한에 맞게 조정
6. [ ] 벤더 콘솔에 billing alert 설정
