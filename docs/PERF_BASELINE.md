# 성능 기준선 (P0-13)

트랙 P(압축·캐시 헤더·지연 로딩 등, `docs/REFACTORING_ROADMAP.md` "트랙 P")의 효과를 비교하는 기준 수치다.
**트랙 P 항목은 이 문서의 같은 도구·같은 조건으로 전/후를 다시 재서 그 차이를 PR에 적는다** — 기준선 없이 효과를 주장하지 않는다.

- 측정일: 2026-11-07
- 측정 커밋: `c48cb42` (main `4ca369f` + 측정 도구·계측 커밋). 앱 동작은 main과 같다(계측은 환경변수로만 켜짐).
- 측정 스택: 이 커밋으로 만든 시험용 오프라인 패키지(`export-offline-package.ps1 -Version 7.1.6-perf`)를
  `scripts/verify-stack.ps1 up -StatsEngineTiming`으로 띄운 8443 스택(Docker Caddy). 기동 시 패키지 매니페스트의
  이미지 ID 대조 통과, 앱 이미지 `Config.Env`의 `WR_GIT_COMMIT`이 측정 커밋과 같음을 확인, 컨테이너 안
  `STATS_ENGINE_TIMING=1` 확인.
- 측정 PC: 개발용 노트북 1대(모바일 8코어 16스레드 CPU, 메모리 16 GB, Windows 11, Docker Desktop/WSL2).
  브라우저는 Playwright 1.61 번들 Chromium(헤드리스). 서버와 브라우저가 **같은 PC**라 네트워크 지연은 거의 0이다 —
  병원 LAN에서는 전송량 차이가 더 크게 체감된다.
- 반복: 각 항목 3~5회(표에 적음) 중앙값. 괄호 안은 반복 간 최소~최대.

## 1. 전송량·첫 화면 로딩

### 1-a. 웹 빌드 청크 크기 (`node scripts/perf/bundle-size.mjs`)

`npm run build:web` 결과(`dist/web`). "초기"는 `index.html`이 직접 참조하는 파일(첫 화면에 반드시 받음), "나중"은 동적 import.

| 파일 | 구분 | 원본 KiB | gzip KiB | brotli KiB |
| --- | --- | --- | --- | --- |
| `assets/index-*.js` (앱 본체) | 초기 | 1152.9 | 310.9 | 203.7 |
| `assets/xlsx-*.js` | 초기 | 480.7 | 156.6 | 130.4 |
| `assets/vendor-*.js` (react·react-dom) | 초기 | 137.7 | 44.2 | 38.7 |
| `assets/index-*.css` | 초기 | 121.8 | 20.7 | 17.5 |
| `index.html` | 초기 | 3.4 | 1.7 | 1.3 |
| `assets/exportService-*.js` | 나중 | 106.9 | 33.8 | 29.6 |
| `assets/createTestPatients-*.js` | 나중 | 24.7 | 6.7 | 5.6 |

| 구분 | 파일 수 | 원본 KiB | gzip KiB | brotli KiB |
| --- | --- | --- | --- | --- |
| 초기 로드 | 5 | **1896.4** | 534.1 | 391.5 |
| 나중 로드 | 2 | 131.6 | 40.5 | 35.3 |
| 그 밖의 정적 파일(자세 이미지·xlsx 양식 등) | 22 | 1962.9 | — | — |

관찰: 초기 JS가 1.77 MB(원본)이고, 그중 `xlsx`(481 KiB)는 엑셀 내보내기·일괄 입력에서만 쓰는데 첫 화면에 함께 실린다(manualChunks로 분리만 돼 있고 지연 로딩은 아님).

### 1-b. 실제 배포 경로 첫 화면 (`node scripts/perf/page-load.mjs --runs 5`)

`https://wr.hospital.local:8443/` (인트라넷 모드 첫 화면 = 로그인 전 화면). CDP `encodedDataLength`(헤더 포함, 실제 전송 바이트).

| 방문 | 요청 수 | 전송 KiB | 304 | 캐시에서 | DOMContentLoaded ms | load ms |
| --- | --- | --- | --- | --- | --- | --- |
| cold(새 브라우저 컨텍스트, 첫 방문) | 10 | **1904** | 0 | 0 | 103 | 103 (95~149) |
| warm(같은 컨텍스트 재방문) | 10 | 0.9 | **6** | 0 | 24 | 24 (23~27) |

304는 실제 네트워크 상태(CDP `responseReceivedExtraInfo.statusCode`)로 센다 — 재검증된 응답은 `responseReceived`에 캐시와 병합한 200으로 나오기 때문이다.

관찰:
- **압축이 전혀 없다**: cold 전송량(1904 KiB)이 초기 로드 원본 합(1896 KiB)과 같다 — Express·Caddy 어느 쪽도 gzip/brotli를 하지 않는다. gzip이면 약 534 KiB, brotli면 약 392 KiB(1-a).
- **해시 파일도 매번 재검증한다**: 정적 자산 응답이 `Cache-Control: public, max-age=0`이라 재방문 때 `index.html`·해시가 붙은 JS·CSS 4개·`job-presets.json`이 모두 조건부 요청(304)으로 다시 확인된다(나머지 4건은 `no-store`인 `/api` 호출). 내용이 바뀌지 않는 `assets/*-<hash>.*`는 장기 캐시(immutable)로 왕복 자체를 없앨 수 있다.
- cold 첫 회가 수 초로 튀는 경우는 Chromium 첫 기동·TLS 첫 연결이 섞인 값이다(중앙값에는 영향 없음).
- Lighthouse 점수는 도구 세션에서 GUI DevTools를 쓸 수 없어 이 수치로 대신한다.

## 2. API 응답 시간 (`node scripts/perf/api-latency.mjs --iterations 30`)

시험 조직에 환자 300명(`seed:stats-test-patients --count 300`)을 넣고 Caddy 경유(HTTPS)로 30회 반복. 클라이언트 측 시간(요청 전송 → 본문 수신 완료).

| 단계 | 요청 | 건수 | p50 ms | p95 ms | 최대 ms |
| --- | --- | --- | --- | --- | --- |
| patients.list | `GET /api/patients?limit=50` | 30 | 11.1 | 12.6 | 28.2 |
| patients.get | `GET /api/patients/:id` | 30 | 5.3 | 6.6 | 9.2 |
| patients.patch | `PATCH /api/patients/:id` (같은 data, If-Match) | 30 | 8.8 | 13.1 | 18.5 |
| workspaces.list | `GET /api/workspaces` | 30 | 6.8 | 8.2 | 8.8 |
| workspaces.create | `POST /api/workspaces` (환자 20명) | 1 | 42.0 | — | — |
| workspaces.save | `PUT /api/workspaces/:id` (환자 20명 덮어쓰기) | 29 | 23.5 | 26.4 | 81.1 |
| stats.catalog | `GET /api/stats/catalog` | 30 | 6.3 | 9.2 | 9.5 |
| stats.preview | `POST /api/stats/preview` (기술통계, 변수 1개) | 30 | 49.4 | 53.7 | 63.4 |
| stats.analyze(cached) | `POST /api/stats/analyze` (같은 recipe, DB 캐시 적중) | 29 | 55.1 | 59.7 | 78.2 |
| stats.analyze(첫 실행) | 같은 recipe, 캐시 없음 — Python 엔진 실행 | 1 | **679** | — | — |

관찰:
- 오류 0건. 읽기 API는 모두 p95 15 ms 이하.
- 통계 `preview`·`analyze`(캐시 적중)도 약 50 ms가 든다 — 엔진을 부르지 않는 경로인데도 스냅샷·데이터셋 구성 비용이 있다(환자 300명 기준).
- 캐시 없는 첫 분석은 679 ms(1회 관측: 같은 스택의 앞선 실행). 그중 엔진 프로세스는 371 ms(아래 3절 서버 로그) — 나머지는 데이터셋 구성·결과 저장.
- 운영 수치가 필요하면 운영 서버의 호스트 Caddy access log에서 `node scripts/perf/access-log-latency.mjs --log <access.log>`로 라우트별 p50/p95를 낸다(집계만 출력, IP·쿼리 없음 — 이번 기준선에는 포함하지 않음).

## 3. 통계 엔진 기동 vs 계산 (`node scripts/perf/engine-timing.mjs --container wr-verify-app-1 --runs 5`)

G6 골든 요청 본문(`server/src/__tests__/__goldens__/stats-engine-requests.json`)을 서버와 같은 봉투로 감싸 **앱 컨테이너 안**(운영과 같은 Python·패키지 버전)에서 `analyze.py`에 넣었다. Python이 `STATS_ENGINE_TIMING=1`일 때 직접 잰 구간 + 드라이버의 spawn→종료. 단위 ms, 5회 중앙값.

| 요청(G6) | 인터프리터 기동 | import | parse | 계산 | 직렬화 | spawn→종료 |
| --- | --- | --- | --- | --- | --- | --- |
| descriptive | 16.8 | 256.2 | 17.9 | 1.8 | 0.1 | 347 (340~462) |
| descriptiveStratified | 17.1 | 251.8 | 17.9 | 4.1 | 0.1 | 341 (332~363) |
| bivariatePearson | 17.2 | 252.1 | 16.9 | 0.9 | 0.0 | 334 (327~340) |
| bivariateWelch | 17.2 | 250.5 | 17.0 | 0.6 | 0.0 | 335 (325~354) |
| regressionOls | 16.9 | 246.5 | 17.8 | 1.1 | 0.0 | 331 (328~335) |
| prediction | 17.1 | 249.6 | 20.8 | **9366.9** | 0.2 | 9710 (9683~9730) |

관찰:
- 예측을 뺀 모든 분석에서 **프로세스 시간의 약 75%가 모듈 import(numpy·scipy 등, ≈250 ms)**이고 실제 계산은 1~4 ms다. spawn→종료와 Python 구간 합의 차이(≈55 ms)는 인터프리터 종료·파이프 정리.
- 예측(교차검증)만 계산이 지배적(≈9.4초).
- 실제 API 경로에서도 같은 계측이 동작함을 확인했다 — `docker compose logs app`의 `[stats-engine] timing {...}`(첫 분석 1건: 인터프리터 20 ms·import 279 ms·계산 1 ms·총 371 ms).

## 4. 화면 렌더링 (`node scripts/perf/render-timing.mjs --counts 100,500 --runs 3`)

로컬 모드 웹 빌드(같은 커밋)를 측정 전용 정적 서버로 열고, 결정적 N명(`src/core/fixtures/generatePatients.js` — 골든 환자 29명 복제)을 자동저장으로 복원했다. 브라우저 `performance.now` 기준 ms, 3회 중앙값.

- 기동: 탐색 시작 → 앱이 자동저장 복원 확인을 묻는 순간
- 복원 렌더: 확인 → 환자 목록에 N개 카드가 모두 그려짐
- 환자 전환: 마지막 환자 카드 클릭 → 기본정보 폼에 그 환자 번호가 보임
- 대시보드: '대시보드' 클릭 → 최근 목록 표가 그려짐

| 빌드 | 환자 수 | 기동 | 복원 렌더 | 환자 전환 | 대시보드 |
| --- | --- | --- | --- | --- | --- |
| 운영 빌드 | 100 | 348 (337~528) | 108 (106~112) | 19 (17~23) | 37 (36~47) |
| 운영 빌드 | 500 | 358 (355~362) | **191** (185~200) | 38 (37~46) | 80 (77~80) |

React commit 시간 — React 프로파일링 빌드(`scripts/perf/vite.profiling.config.mjs`, react-dom → react-dom/profiling, 앱 코드 수정 없이 DevTools 훅으로 루트 `actualDuration` 수집):

| 환자 수 | 복원 commit | 환자 전환 commit | 대시보드 commit |
| --- | --- | --- | --- |
| 100 | 1회 / 21.1 ms | 2회 / 합 7.7 ms(최대 7.6) | 1회 / 11.1 ms |
| 500 | 1회 / 51.4 ms | 2회 / 합 24.9 ms(최대 24.9) | 1회 / 39.6 ms |

(프로파일링 빌드의 벽시계 시간은 운영 빌드와 거의 같았다: 500명 복원 190 ms·전환 47 ms·대시보드 78 ms.)

관찰: 환자 수에 비례해 늘어나는 구간은 복원 렌더(100→500명: 108→191 ms)와 대시보드(37→80 ms)·환자 전환(19→38 ms). 환자 전환이 환자 수에 따라 느려지는 것은 선택한 환자만 바뀌는데도 목록 전체가 다시 그려지기 때문으로 보인다(C4 대상 — 확인은 C4에서).

### P-8 전후(REFACTORING_ROADMAP Phase 2 P2-20, 2026-11-14)

로드 시 형식 마이그레이션(`migratePatient`)이 `storage.js` → `workspaceRepository` → `useWorkspacePersistence` 세 층에서 3번 돌던 것을 1번(가장 아래 `storage.js`)으로 줄였다. 같은 PC·같은 방법(`render-timing.mjs --counts 500`, 운영 빌드, 중앙값):

| 측정 | 기동 | 복원 렌더 | 환자 전환 | 대시보드 |
| --- | --- | --- | --- | --- |
| 전(main `e101a2c`, 3회) | 376.5 | 202.1 | 49.1 | 88.6 |
| 후(3회) | 375.6 | 225.8 | 52.2 | 89.1 |
| 후(5회) | 370.7 | 214.6 | 50.7 | 92.7 |

결론: **이 측정으로는 차이가 구분되지 않는다(잡음 범위)** — 같은 코드도 회차마다 복원 렌더가 185~228 ms로 흔들리고, 줄인 일(500명 × 순수 함수 2회)은 렌더·확인창 흐름에 비해 작다. 복원 commit(프로파일링 빌드)도 58.8 → 60.3·60.9 ms로 같은 범위. P-8의 효과는 시간보다 "마이그레이션 경계가 한 곳"이라는 구조에 있다(업로드 경로 회귀 방지 테스트는 `localToServerMigrator.legacyPush.test.js`). (전 측정의 프로파일링 빌드는 다시 빌드하지 않은 옛 산출물이라 표에서 뺐다.)

## 다시 재는 방법

```bash
npm run build:web
npx vite build --config scripts/perf/vite.profiling.config.mjs
node scripts/perf/bundle-size.mjs
node scripts/perf/render-timing.mjs --counts 100,500 --runs 3
```

배포 경로(1-b·2·3절)는 측정할 커밋으로 시험 패키지를 새로 만들어 띄운다(기존 버전 폴더·이미지 태그를 덮어쓰지 않게 버전 꼬리표를 붙인다):

```powershell
.\scripts\export-offline-package.ps1 -Version 7.1.6-perf -AllowMissingElectronInstaller -AllowUnsignedUpdateFeed -NoZip -ExcludeBaseImages
pwsh -File scripts/verify-stack.ps1 up -PackageDir release\wr-evaluation-unified-7.1.6-perf-intranet -LoadImages -StatsEngineTiming
docker image inspect wr-app-server:7.1.6-perf --format '{{range .Config.Env}}{{println .}}{{end}}'   # WR_GIT_COMMIT = 측정 커밋인지
```

- 1-b: `node scripts/perf/page-load.mjs --runs 5`
- 2: 시험 계정(`docker exec -i wr-verify-app-1 node dist/cli/seedAdmin.js` — stdin으로 조직·ID·비밀번호·이름, 첫 로그인 뒤 비밀번호 변경 필요)과 환자(`node dist/cli/seedStatsTestPatients.js --org <id> --count 300`)를 넣고
  `WR_PERF_LOGIN_ID`·`WR_PERF_PASSWORD` 환경변수 + `NODE_EXTRA_CA_CERTS=<시험 스택 Caddy 루트 인증서>`로 `node scripts/perf/api-latency.mjs --iterations 30`.
  **운영 서버에 돌리지 않는다**(환자 수정·워크스페이스 저장·분석 기록을 만든다).
- 3: `node scripts/perf/engine-timing.mjs --container wr-verify-app-1 --runs 5`

## 한계

- 한 PC에서 서버·브라우저를 함께 돌린 값이라 네트워크 지연이 없다. 병원 PC(Win7·Chrome 109 등)와 LAN에서는 1-b의 전송량 차이가 더 크게 나타난다.
- Lighthouse 점수·실제 페인트 시점은 재지 않았다(헤드리스 Playwright 수치로 대신). 렌더 시간은 "DOM에 그려짐"을 `requestAnimationFrame` 간격으로 확인한 값이다.
- API 응답 시간은 시험 DB(환자 300명) 기준이다. 운영 규모는 `access-log-latency.mjs`로 따로 집계한다.
- 캐시 없는 통계 분석 첫 실행은 1회만 관측했다.
