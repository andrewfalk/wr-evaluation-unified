# Vercel AI 프록시 운영 보안 설정 가이드

> 이 문서는 **코드 변경이 아닌 운영자가 Vercel 대시보드/인프라에서 직접 적용해야 하는
> 설정**을 정리한 가이드입니다. 레포 코드만으로는 적용할 수 없습니다.

## 배경

`api/analyze.js`(Vercel 서버리스)는 웹 클라이언트의 AI 분석 요청을 받아 서버
환경변수(`GEMINI_API_KEY` / `CLAUDE_API_KEY`)로 Gemini/Claude API를 호출하는
프록시입니다. 이 엔드포인트는 인증되지 않은 외부 요청에도 응답하므로, 비용
남용(과도한 호출로 API 사용량 청구) 및 무분별한 트래픽으로부터 보호할 운영 조치가
필요합니다.

### 왜 브라우저 발신 토큰을 인증 수단으로 쓰지 않는가

`AI_PROXY_TOKEN` 류의 토큰을 프론트엔드 코드/빌드에 포함시켜 `api/analyze.js`가
검증하는 방식은 **비밀로 취급할 수 없습니다** — 브라우저에 전달되는 모든 값은
누구나 열람 가능하므로, 이런 토큰은 진짜 인증이 되지 못하고 공격자가 그대로
재사용할 수 있습니다. 따라서 이 방식은 2026-06-12 리뷰에서 **채택하지 않기로
결론**났습니다. 대신 아래의 플랫폼 레벨 보호를 사용합니다.

## 1. Vercel Deployment Protection

Vercel 대시보드 → 프로젝트 → **Settings → Deployment Protection**에서 설정.

- **Standard Protection**: Preview 배포에 대해 Vercel 로그인 또는 공유 링크를
  요구. Production 배포에는 기본적으로 영향이 적으므로, Preview URL이 외부에
  노출되지 않도록 하는 최소 조치로 우선 적용 권장.
- **Vercel Authentication**: 모든 배포(Preview 포함)에 대해 Vercel 계정 로그인을
  요구. 내부 검토용 배포가 많다면 고려.
- 이 프로젝트의 `api/analyze.js`는 **Production에서 일반 사용자가 호출해야 하므로**,
  Production 자체에 로그인 보호를 걸면 정상 사용이 막힙니다. Deployment
  Protection은 주로 **Preview 배포 노출 방지** 목적으로 적용하고, Production의
  AI 프록시 보호는 아래 2번(rate limit) 위주로 진행합니다.

## 2. WAF / Rate Limit (Vercel Firewall)

Vercel 대시보드 → 프로젝트 → **Security / Firewall** 탭에서 설정 (Pro 플랜 이상
필요할 수 있음).

- **Rate Limiting 규칙**: `/api/analyze` 경로에 대해 IP 기준 요청 수 제한
  (예: 1분당 N회)을 생성. Vercel Firewall UI에서 path pattern + 임계값을
  직접 지정 가능.
- **Edge Config + KV 카운터 패턴** (Firewall 미사용 시 대안): `api/analyze.js`
  핸들러 내부에서 요청 IP/세션 기준으로 Vercel KV(또는 Upstash Redis)에 카운터를
  증가시키고, 임계값 초과 시 429 응답. 이 방식은 **코드 변경이 필요**하므로,
  현재 백로그에서는 "운영자가 Firewall 룰로 우선 적용"을 권장하고, KV 기반
  구현은 Firewall만으로 부족할 때 별도 작업으로 검토.
- 현재 `api/analyze.js`는 `prompt.length > 50000` 체크와 `ALLOWED_MODELS`
  allowlist(`ai-models.config.cjs`)로 단일 요청당 비용 상한은 일부 제한하고
  있으나, **요청 빈도 제한은 없음** — 이 문서의 설정으로 보완 필요.

## 3. 모니터링

- Vercel 대시보드의 **Usage** 탭에서 `api/analyze` 함수 호출 수/에러율을
  주기적으로 확인. 급격한 증가는 남용 신호일 수 있음.
- Gemini/Claude 콘솔의 API 사용량 알림(billing alert)을 설정해 두면, Vercel
  설정과 무관하게 비용 급증을 조기에 인지할 수 있음.
