# v7.1.3 → v7.1.4 업데이트 절차 (보안 핫픽스)

이미 v7.1.3이 운영 중인 인트라넷 서버를 v7.1.4로 올리는 절차. 형식은 [UPDATE_5.1.0.md](UPDATE_5.1.0.md)·[UPDATE_7.0.0.md](UPDATE_7.0.0.md)·[UPDATE_7.1.1.md](UPDATE_7.1.1.md)·[UPDATE_7.1.3.md](UPDATE_7.1.3.md)를 따른다.

> **이번 릴리스는 보안 핫픽스다(기능 추가 없음, DB 마이그레이션 없음).** 7.1.3과 다른 점 세 가지: ① **Electron 설치본(셸)을 교체해야 한다** — 7.1.3은 "재설치 불필요"였지만 이번에는 `main.js`·preload가 바뀌었다 ② **업데이트 피드 서명(HF8)이 이 릴리스에 포함된다** — 패키지는 서명 키로 만들어야 하고, 7.1.4 셸부터는 서명이 없는 피드를 모두 거부한다(셸 교체를 PC마다 두 번 하지 않도록 7.1.5로 미루지 않고 합쳤다) ③ **"배포 전 점검(릴리스 게이트)"을 통과하기 전에는 배포하지 않는다** — Electron 설치본에서만 확인되는 항목이 있다.
> 운영이 v7.1.3이 맞는지는 아래 "0) 현재 운영 환경 정보 파악"으로 먼저 확인한다. v7.1.1 이하에서 올라오는 경우는 이 문서가 아니라 [UPDATE_7.1.3.md](UPDATE_7.1.3.md)(그리고 그 이전 문서)를 먼저 따른다.

## 무엇이 바뀌나

- **서버(=클라이언트 화면 포함)**: 서버가 SPA를 서빙하므로 서버 업데이트만으로 화면이 바뀐다.
  - **워크스페이스 저장 인가(HF1, #159)**: 저장은 환자별로 담당의(또는 관리자)·서버 revision·편집 락을 확인하고, 통과하지 못한 환자는 서버 기록을 덮어쓰지 않는다(저장 목록에는 남는다). 저장 직후 알림에 제외된 환자 수가 나올 수 있다(아래 "동작 변경").
  - **임시 비밀번호 강제 변경(HF2, #160)**: 비밀번호를 초기화받은 계정은 비밀번호를 바꾸기 전에는 `/api/auth/me`·`/api/auth/change-password` 외 모든 API가 403 `PASSWORD_CHANGE_REQUIRED`다.
  - **`/api` 응답 `Cache-Control: no-store`(HF4, #161)**, 죽은 CSRF 예외 경로 제거, `.dockerignore` 보강.
  - **영상 업로드 multer 2.4.0(HF5, #163)**: `files: 1`·`fields: 0` 제한. 정상 업로드 동작은 같다.
  - **AI 경로 비식별 구조화 입력(HF7-1~2, #165·#166)**: `/api/ai/analyze`가 `{ input, fullReport? }`만 받고 프롬프트는 서버가 조립한다. **운영은 `AI_PROVIDER=none`이라 이 경로는 휴면이다**(내부 LLM 도입 전까지 변화 없음).
  - **`/updates/`에 서명 파일(`.sig`)이 함께 서빙된다(HF8, #169~#172)**: 서버는 서명을 만들지도 검증하지도 않고 파일을 그대로 내려줄 뿐이다. 서버에 서명 키·암호·새 환경변수는 필요 없다.
  - 자세한 내용: [README.md](../README.md) 변경 이력 v7.1.4
- **DB 스키마**: **변경 없음.** 마이그레이션 0037까지(37행)가 그대로다. 7.1.3 때와 달리 서버 기동 시 새로 적용되는 마이그레이션이 없다. 그래도 **업데이트 전 백업은 유지한다.**
- **환경변수**: `.env.production`에서
  - **`WR_VERSION=7.1.4` (필수)** — compose가 `wr-app-server`·`wr-backup-monitor`·`wr-backup` 세 이미지를 모두 `:${WR_VERSION}`으로 찾는다. 안 바꾸면 7.1.4 이미지를 로드해도 컨테이너는 구버전을 계속 쓴다.
  - `AI_TIMEOUT_MS`(선택, 비우면 기본 60000) — AI 호출 1건의 제한 시간(ms). `AI_PROVIDER=none`인 운영에서는 영향 없다.
  - `STATS_*`는 **기존 값을 그대로 둔다**. 그 밖의 새 환경변수는 없다.
- **이미지 크기**: 7.1.3과 비슷할 것으로 예상한다(app 이미지 약 2.75GB 안팎). 패키지 생성 후 실제 크기를 확인한다. 새 이미지를 로드하는 동안 이전 이미지도 남아 있으므로 서버 디스크 여유를 확인한다.
- **네트워크·인증서**: 서버 쪽 변경 없음 (Caddy·포트 8080/8443 그대로). 단 **패키지·이미지를 만드는 PC는 `cdn.sheetjs.com`에 접근할 수 있어야 한다**(xlsx 0.20.3을 이 주소의 타르볼로 받는다). 운영 서버는 이미지를 로드할 뿐이라 접근이 필요 없다.
- **서명 키(릴리스 PC 전용)**: 패키지를 만드는 PC에서 `export-offline-package.ps1 -UpdateSigningKey "<비밀키.pem>"`로 만든다(암호로 보호된 키면 같은 창에서 `WR_UPDATE_SIGNING_PASSPHRASE` 설정). 키가 없으면 패키징이 실패하고, 서명 없이 만든 패키지의 셸은 업데이트를 모두 거부한다. 절차·키 관리(분실·교체)는 [INTRANET_DEPLOYMENT.md](INTRANET_DEPLOYMENT.md) 7-6. **키·암호는 서버·`.env.production`·저장소·클라우드 동기화 폴더에 두지 않는다.**
- **`updates/` 폴더**: compose의 `./updates`는 **새 패키지 폴더 기준**이다. 이전(7.1.3) 폴더의 `update-policy.json`·`canary.yml`은 새 폴더에서 보이지 않으므로 아래 "업데이트 절차 A" 2번을 따른다. 새 패키지의 `updates/`에는 설치본·`.blockmap`·`latest.yml` 외에 **`latest.yml.sig`가 있다 — 폴더를 통째로 복사하고, yml만 따로 복사하지 않는다**(`.sig`가 없으면 7.1.4 셸이 모든 업데이트를 거부한다).
- **클라이언트(Electron)**: **설치본 교체가 필요하다.** 서버만 올려도 SPA 화면은 바뀌지만, 다음은 셸 안에 있어 설치본을 바꿔야 적용된다.
  - IPC 송신자 검증·독립형 전용 채널 비등록·preload 이벤트 객체 차단·권한/내비게이션 가드(HF3·HF9, #162)
  - 임시 비밀번호 상태에서 EMR 디바이스 등록 요청을 보내지 않고 변경 직후 등록(HF2)
  - (독립형) 모델명 허용 목록·60초 제한·응답 오류 비노출(HF7-3, #167)
  - **업데이트 피드 서명 검증(HF8, #169·#170·#171)**: 자동 업데이트가 받는 `<channel>.yml`의 Ed25519 서명을 셸에 내장된 공개 키로 확인한 뒤에만 설치본을 내려받는다(`autoDownload=false` + 서명 게이트). 서명이 없거나 틀리면 다운로드하지 않고 메뉴에 "업데이트 서명 검증 실패 (n회)"가 표시되며 15분 → 1시간 간격으로 다시 확인한다.
  - EMR 헬퍼(`EmrHelper.cs`)는 바뀌지 않았다. 신규 PC에는 패키지의 7.1.4 설치본을 쓴다.
- **웹(Vercel)**: 서버 업데이트와 별개로 `main` 머지 시 자동 배포된다. #167 머지(2026-10-17)로 새 함수가 이미 반영됐다. 아래 "웹(Vercel) 확인" 참고.

## 예상 다운타임

- **서버**: 수십 초 (app 컨테이너 재생성). 마이그레이션이 없어 7.1.3 때보다 짧다. postgres/caddy는 영향 없음.
- **클라이언트 PC**: 서버 화면은 새로고침으로 반영. **셸 교체는 설치본 교체 시 앱 재시작이 필요하다.** 작업 중이던 환자 화면은 저장 후 진행한다.

## 배포 전 점검 (릴리스 게이트) — 통과 전에는 배포하지 않는다

머지는 배포가 아니므로 문서·코드는 이미 `main`에 있다. 아래는 **7.1.4 최종 설치본으로 한 번에** 수행하는 점검이며 아직 실행하지 않았다(Electron 설치본이 필요해 PR마다 하지 않았다).

**인트라넷 설치본**

- [ ] 임시 비밀번호 계정으로 로그인 → 비밀번호 변경 모달만 사용 가능 → 변경 → **EMR 디바이스 등록 요청이 즉시 들어가 관리자 승인 대기열에 보인다** (HF2)
- [ ] 메뉴 이벤트(새 환자·모듈 이동·통계 열기·종료 요청)와 앱 버전 표시가 정상 (HF3 — preload 인자·`sendSync` 경로)
- [ ] 개발자 도구에서 `window.electron`에 `fs*`·`analyzeAI`가 **없다** (HF3)
- [ ] 관리자 콘솔의 임시 비밀번호 복사 버튼이 클립보드로 복사한다 (HF9 — 권한 핸들러)

**독립형 설치본**

- [ ] 파일 열기/저장(`fs-*`), Excel·PDF 내보내기, 메뉴 이벤트가 정상 (HF3·HF9 — `blob:` 내비게이션 허용 확인)
- [ ] AI 분석을 **실제 키로 1회** 실행해 결과가 나온다 (HF7-3)

**업데이트 피드 서명 (HF8)** — 7.1.4 설치본 **두 개**(예: 7.1.4와 시험용 다음 버전)와 로컬 서버의 `updates/`로 확인한다.

- [ ] 패키지가 서명 키로 만들어졌다: `release-manifest.json`의 `electronInstaller.updateFeedSigned`가 `true`이고 `electron/`·`updates/`에 `latest.yml.sig`가 있다
- [ ] `node scripts/sign-update-feed.mjs --verify --dir <updates 폴더> --channel latest`가 "서명 검증 성공"
- [ ] **정상 업데이트**: 7.1.4 셸이 서명된 더 높은 버전의 피드를 받아 설치본을 내려받고 설치 확인 창까지 진행한다(`update-policy.json`을 켠 상태)
- [ ] **거부**: `latest.yml`을 한 글자 바꾸거나, `latest.yml.sig`를 지우거나, 다른 키로 서명하면 → 다운로드하지 않고 메뉴에 "업데이트 서명 검증 실패 (n회)", 앱 사용자 데이터 폴더의 `updater.log`에 `UPDATE_FEED_REJECTED:…`, 재시도 간격이 15분 → 1시간으로 늘어난다
- [ ] 서명 키·암호가 서버·`.env.production`·저장소에 없다

**서버·웹**

- [ ] 서버 업데이트 후 워크스페이스 저장(본인 환자 / 비담당 환자 포함 / 저장 직후 같은 환자 편집) — 아래 "검증 시나리오"
- [ ] 영상 업로드 1회, Excel 일괄 가져오기·내보내기 1회 (multer·xlsx 교체)
- [ ] 웹 운영 주소에서 AI 분석 1회 — 아래 "웹(Vercel) 확인"

## 사전 준비

### 0) 현재 운영 환경 정보 파악

compose 프로젝트 이름(`-p`, 보통 `wr-prod`)과 운영 `.env.production` 경로, 현재 `WR_VERSION`을 확인한다([UPDATE_5.1.0.md](UPDATE_5.1.0.md) "0)"과 동일).

```powershell
docker compose ls
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"      # → wr-app-server:7.1.3 이어야 한다 (그 외면 이 문서의 전제가 다르다)
$installDir = docker inspect wr-prod-app-1 --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
Get-Content (Join-Path $installDir ".env.production") | Select-String "WR_VERSION|STATS_|AI_"
```

### 1) 패키지 이송·무결성 검증

- `release\wr-evaluation-unified-7.1.4-intranet.zip`을 서버로 복사하고 압축을 푼다(이미지 로드 시 app 이미지 약 2.75GB 이상의 디스크 여유 필요).
- 무결성 검증은 [UPDATE_5.1.0.md](UPDATE_5.1.0.md) "2) 무결성 검증"(SHA256SUMS)과 동일. `release-manifest.json`의 `version`이 7.1.4인지, 이미지 3종이 모두 7.1.4 태그인지, `electron/`의 `latest.yml` 버전이 7.1.4인지 확인한다. 또한 `electronInstaller.updateFeedSigned`가 `true`이고 `electron/`·`updates/`에 `latest.yml.sig`가 있는지 확인한다 — `false`이거나 `.sig`가 없으면 이 패키지의 셸은 업데이트를 모두 거부하므로 서명 키로 다시 만든다.

### 2) (필수) 업데이트 직전 DB 백업

```powershell
docker compose -p wr-prod --profile backup run --rm backup /scripts/backup.sh
```

`_status\last-success.txt`에 새 백업 시각이 찍히는지 확인한다. 마이그레이션이 없어 DB 복원이 필요해질 가능성은 낮지만 관례대로 유지한다(아래 "롤백 절차").

### 3) (필수) .env.production 수정

```
# === WR_VERSION (필수) ===
# 수정 전:   WR_VERSION=7.1.3
# 수정 후:   WR_VERSION=7.1.4
```

`STATS_*`·`AI_PROVIDER`는 기존 값을 그대로 둔다. 수정 후 다시 확인:

```powershell
Get-Content "<env경로>" | Select-String "WR_VERSION|AI_PROVIDER"
```

---

## 업데이트 절차

### A. 서버 업데이트

서버에서 PowerShell 관리자 권한으로:

```powershell
# 1. 새 패키지 폴더로 이동
cd C:\wr\wr-evaluation-unified-7.1.4-intranet

# 2. (이전 폴더의 updates/ 에 정책·canary 파일을 둔 적이 있을 때만) 새 폴더의 updates/ 로 옮긴다.
#    자동 업데이트를 켠 적이 없다면(update-policy.json 없음) 생략.
Test-Path "<이전 폴더>\updates\update-policy.json"
Copy-Item "<이전 폴더>\updates\update-policy.json" ".\updates\"      # 있을 때만
# canary 롤아웃을 진행 중이던 경우에만 canary.yml 과 그 설치본도 함께 옮긴다

# 3. 새 Docker 이미지 로드
.\scripts\import-images.ps1

# 4. 로드된 이미지 확인 (wr-app-server / wr-backup-monitor / wr-backup 모두 7.1.4)
docker images | Select-String "wr-app-server|wr-backup"

# 5. 컨테이너 재생성 — 세 이미지가 모두 7.1.4 태그로 바뀌므로 app만이 아니라 전체를 올린다
docker compose `
  -p wr-prod `
  --env-file <운영 .env.production 절대경로> `
  -f docker-compose.yml -f docker-compose.prod.yml `
  --profile backup up -d
```

정상이면 `Recreate wr-prod-app-1`(및 backup-monitor/backup)이 출력된다. app 관련 출력이 없으면 `WR_VERSION`이 아직 이전 값으로 남아 있는 것이다.

### B. 서버 헬스 체크

```powershell
# 1. ★가장 중요★ app 이미지 태그
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"      # → wr-app-server:7.1.4

# 2. 전체 컨테이너 상태
docker ps --filter "name=wr-prod" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

# 3. 마이그레이션 — 이번에는 새로 적용되는 것이 없다 (0037 그대로, 37행)
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select count(*), max(filename) from schema_migrations"
# → 37|0037_stats_runs_limited_result.sql

# 4. 부팅 로그 확인
docker logs wr-prod-app-1 --tail 60 | Select-String "migrate|error"
# → 새 [migrate] Applied 줄이 없어야 한다

# 5. app health / Caddy 경유 헬스
docker exec wr-prod-app-1 wget -qO- http://localhost:3001/health
curl.exe -k -o NUL -w "8443: %{http_code}`n" https://localhost:8443/health

# 6. updates/ 마운트
curl.exe -k https://localhost:8443/updates/latest.yml
# → version: 7.1.4 이 포함된 YAML (404면 새 폴더의 updates/ 에 파일이 없는 것)
curl.exe -k https://localhost:8443/updates/latest.yml.sig
# → base64 한 줄(88자). 404면 새 폴더의 updates/ 에 .sig가 없는 것 — 이 상태에서는 7.1.4 셸이 모든 업데이트를 거부한다
```

통계 워크벤치(`STATS_WORKBENCH_ENABLED=true`)는 이번에 코드·카탈로그·결과 스키마가 바뀌지 않았다. 기존 분석 결과 캐시도 그대로 재사용된다. 필요하면 [UPDATE_7.1.3.md](UPDATE_7.1.3.md) "C. 통계 워크벤치 확인"을 그대로 쓴다.

### C. 클라이언트 PC — Electron 설치본 교체

- **신규 PC**: 패키지의 7.1.4 설치본(`직업성 질환 통합 평가 프로그램 Setup 7.1.4.exe`)을 설치한다.
- **기존 PC**: 7.1.4 설치본으로 교체한다(수동 설치 또는 Electron 자동 업데이트 — `update-policy.json`·canary 채널, [INTRANET_DEPLOYMENT.md](INTRANET_DEPLOYMENT.md) "자동 업데이트"). 서버 화면은 새로고침만으로 바뀌지만 셸 보안 가드는 교체해야 적용된다.
- **권장 순서**: 서버 업데이트 → **모든 PC의 셸 교체가 끝날 때까지 임시 비밀번호 발급·관리자 비밀번호 초기화를 미룬다**(아래 "알려진 함정·한계"의 조합 한계). 7.1.4 셸과 7.1.3 서버의 조합은 코드상 호환되도록 했지만 실제 조합 시험은 하지 않았다.
- **서명 검증은 7.1.4 이상 셸에서만 동작한다.** 7.1.3 이하 PC는 검증기가 없어 서명 없는 피드로 7.1.4를 받는다 — **이 한 번의 전환은 서명 보호 밖**이다. 자동 업데이트로 배포하는 동안의 보안 예외 승인은 [INTRANET_DEPLOYMENT.md](INTRANET_DEPLOYMENT.md) 7-6을 따르고, 고위험 PC는 설치본을 수동으로 설치하는 편이 안전하다. 7.1.4 이후의 업데이트부터는 서명이 검증된다.

---

## 검증 시나리오

| 시나리오 | 기대 결과 |
|---|---|
| 기존 환자 열기·저장 | 정상(기존 데이터 보존) |
| 담당의 본인 환자를 포함해 워크스페이스 저장 → 곧바로 같은 환자 편집 | 저장 알림에 제외 안내 없음. 이어지는 자동 저장이 충돌 없이 진행되고 환자가 읽기 전용으로 잠기지 않는다 |
| **담당의가 아닌** 환자를 포함해 워크스페이스 저장 | "담당의가 아니어서 환자 데이터가 서버에 반영되지 않은 환자 N명 (저장 목록에는 포함됨)" 안내. 그 환자의 서버 기록은 바뀌지 않는다 |
| 다른 PC에서 먼저 수정·저장한 환자를 오래된 상태로 저장 | "서버에 더 새로운 버전이 있어 반영되지 않은 환자 N명 — 충돌을 해결한 뒤 다시 저장하세요". 충돌 해결 화면으로 이동 |
| 다른 사용자가 편집 중인 환자를 포함해 저장(`LOCK_ENFORCEMENT_MODE=enforce`) | "다른 사용자가 편집 중이라 반영되지 않은 환자 N명" |
| 관리자가 비밀번호를 초기화한 계정으로 로그인 | 비밀번호 변경 화면만 사용 가능. 그 사이 다른 API는 403 `PASSWORD_CHANGE_REQUIRED`. 변경 후 정상 사용, EMR 디바이스 등록이 즉시 진행(7.1.4 셸) |
| 로그인 후 개발자 도구 Network에서 `/api/patients` 응답 헤더 | `Cache-Control: no-store` |
| 영상 업로드 1회 | 정상 |
| Excel 일괄 가져오기·내보내기 1회 | 정상(xlsx 교체 확인) |
| (7.1.4 셸) 서명된 더 높은 버전 피드가 `updates/`에 있고 정책을 켬 | 설치본을 내려받고 설치 확인 창이 뜬다 |
| (7.1.4 셸) `updates/`에 yml만 있고 `.sig`가 없음 | 다운로드하지 않고 "업데이트 서명 검증 실패 (n회)". `updater.log`에 `UPDATE_FEED_REJECTED:signature-file-missing` |
| (7.1.4 셸) 서명한 뒤 yml이 바뀜 | 거부. `UPDATE_FEED_REJECTED:signature-mismatch`. 연속 거부 시 재시도 15분 → 1시간 |
| (7.1.4 셸) 서명은 통과했는데 다운로드가 연속 실패 | "업데이트 다운로드 실패 (n회)"로 횟수가 쌓여 재시도 15분 → 1시간(다운로드 중에는 "업데이트 다운로드 중 (이전 실패 N회)") |
| (AI 활성화 환경만) 직력 31개 이상·상병 21개 이상·직력별 작업/구간 31개 이상 환자에서 AI 분석 | 거부되고 사유 메시지가 나온다 (이전에는 일부가 누락된 채 분석) |
| 운영(`AI_PROVIDER=none`)의 AI 분석 | 403 — 7.1.3과 같다(내부 LLM 도입 전까지 휴면) |

### 웹(Vercel) 확인

웹은 서버 업데이트와 무관하게 `main`에 반영된다. 새 함수는 환경변수가 없으면 열어 두지 않고 503으로 닫는다(fail-closed). 환경변수는 Production과 Preview 양쪽에 등록해야 하고(`WEB_AI_CLIENT_TOKEN`·`VITE_WEB_AI_TOKEN`은 같은 값, `UPSTASH_REDIS_REST_URL/TOKEN`, `GEMINI_API_KEY`/`CLAUDE_API_KEY`), `VITE_WEB_AI_TOKEN`은 빌드 때 번들에 들어가므로 값을 바꾸면 재배포해야 한다. 절차·응답 코드 표·한도 조정 방법은 [VERCEL_AI_PROXY_HARDENING.md](VERCEL_AI_PROXY_HARDENING.md)에 있다. 커스텀 도메인을 쓰면 `APP_ORIGIN` 등록이 필수다.

> **사전 검증한 것**: 미리보기 배포에서 환경변수 등록 후 AI 분석 실제 호출 성공(PR #167 확인). **하지 못한 것**: 운영 주소에서의 AI 호출, Claude·Gemini 업체별 확인, Electron 설치본(독립형 포함) 점검 전부, 운영 이미지·패키지 빌드와 `--network none` 환경 동작, 병원 EMR 실제 주입(이번 릴리스는 EMR 코드를 바꾸지 않았다).

---

## 롤백 절차

롤백은 **앱 이미지 되돌리기**와 **DB 복원**을 구분한다. 마이그레이션이 없으므로 대부분 앱 이미지만 되돌리면 충분하다.

### 1) 앱 이미지만 되돌리기

```powershell
# .env.production: WR_VERSION=7.1.4 → 7.1.3
cd C:\wr\wr-evaluation-unified-7.1.3-intranet      # 이전 패키지 폴더 (updates/ 도 그 폴더 기준으로 되돌아간다)
docker images | Select-String "wr-app-server:7.1.3"      # 없으면 이전 패키지에서 .\scripts\import-images.ps1
docker compose -p wr-prod --env-file <env경로> -f docker-compose.yml -f docker-compose.prod.yml --profile backup up -d
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"      # → wr-app-server:7.1.3
```

- 스키마 변경이 없어 DB는 그대로 둔다. 7.1.4가 저장한 워크스페이스 스냅샷에는 확정 revision·담당의 정보가 함께 기록되어 있으며, 7.1.3 앱은 이 필드를 이미 알고 있다. **다만 7.1.3 앱을 7.1.4가 쓴 DB에서 실제로 돌려 확인하지는 않았다.**
- 완전한 롤백은 **Electron 셸도 7.1.3 설치본으로 되돌려야** 한다. 서버만 되돌리면 7.1.4 셸 + 7.1.3 서버 조합이 된다.
- 7.1.3 패키지의 `updates/`에는 `.sig`가 없다. **7.1.4 셸은 서명 없는 피드를 받지 않으므로**, 롤백한 상태에서 자동 업데이트를 쓰려면 서명된 새 패키지(7.1.4 이상)의 `updates/`를 올려야 한다. 업데이트가 꺼져 있으면(`update-policy.json` 없음) 무관하다.

### 2) DB 복원 (스키마/데이터 자체에 문제가 있을 때만)

[BACKUP_RESTORE.md](BACKUP_RESTORE.md) 절차로 **업데이트 전 백업**을 복원한다. 복원하면 **그 백업 시각 이후의 모든 변경이 사라진다.** 복원 후에는 `WR_VERSION`도 이전 값으로 되돌려야 하며, 복원 전에 현재 DB를 별도로 한 번 더 백업해 두는 것을 권장한다.

---

## 알려진 함정·한계

### `up -d` 실행했는데 컨테이너가 이전 버전 그대로
**원인**: `.env.production`의 `WR_VERSION`이 이전 값으로 남아 있음. **해결**: 사전 준비 3번대로 수정 후 다시 실행.

### 새 패키지로 바꿨는데 자동 업데이트 정책/canary 설정이 사라짐
**원인**: compose의 `./updates`는 compose 파일이 있는 패키지 폴더 기준이다. **해결**: 이전 폴더 `updates/`에서 새 폴더 `updates/`로 옮긴다(업데이트 절차 A 2번).

### 7.1.4 서버 + 7.1.3 이하 셸에서 임시 비밀번호 로그인 직후 EMR 장치 등록이 늦어짐
**조건**: 그 PC의 장치 상태가 아직 `active`가 아닐 때(신규 PC·승인 대기·오류)만 해당한다. 이미 `active`인 PC는 영향이 없다.
**원인**: 구 셸은 로그인 직후 장치 등록 요청을 보내는데, 서버가 임시 비밀번호 상태의 요청을 403으로 거절한다. 구 셸은 이를 오류로 보고 약 20분 동안 재시도하지 않는다.
**해결**: 앱을 재시작하면 즉시 해소된다. 예방은 **셸 교체가 끝날 때까지 임시 비밀번호 발급을 미루는 것**이다. 7.1.4 셸에는 이 문제가 없다. (서버가 등록을 항상 `pending`으로 만들어 관리자 승인을 거치므로 신규 장치는 원래도 즉시 EMR을 쓸 수 없다. 이 동작은 의도한 것이 아니라 엄격한 강제의 부작용이며 예외를 두지 않기로 결정했다.)

### 워크스페이스를 저장했는데 일부 환자가 "반영되지 않았다"고 나옴
**원인**: 정상 보호 동작이다. 담당의가 아닌 환자, 서버에 더 새로운 버전이 있는 환자, 다른 사용자가 편집 중인 환자는 서버 기록을 덮어쓰지 않는다(저장 목록에는 포함된다). **해결**: 담당의 배정을 확인하거나, 충돌 해결 화면에서 어느 쪽을 쓸지 정한 뒤 다시 저장한다. 담당의가 지정되지 않은(NULL) 환자는 관리자만 저장할 수 있다.

### 비밀번호를 초기화받은 사용자가 로그인은 되는데 아무것도 못 함
**원인**: 의도된 동작이다(`PASSWORD_CHANGE_REQUIRED`). 비밀번호 변경 화면에서 바꾸면 풀린다.

### AI 분석이 "입력이 너무 많다"는 사유로 거부됨
**원인**: AI 입력은 직력 30개·상병 20개·직력별 작업/구간 30개까지만 받는다. 이전에는 상한을 넘으면 일부가 조용히 빠진 채 분석됐다. **해결**: 평가에 포함할 직력·상병을 줄이거나, 해당 환자는 AI 분석을 쓰지 않는다. (운영은 AI가 휴면이라 현재는 해당 없다.)

### 웹에서 AI 분석이 "설정되지 않았습니다"(503)
**원인**: 같은 문구가 세 가지 원인에서 나온다 — `WEB_AI_CLIENT_TOKEN`·Upstash 접속 정보·고른 업체의 API 키 중 하나가 해당 배포에 없다. 환경변수는 **새 배포부터** 적용되므로 등록 후 재배포해야 한다. **해결**: 브라우저 개발자 도구 Network의 응답 `error.code`로 어느 것인지 확인한다([VERCEL_AI_PROXY_HARDENING.md](VERCEL_AI_PROXY_HARDENING.md) 응답 코드 표).

### `updates/`에 yml만 복사했더니 모든 PC가 업데이트를 거부함
**원인**: 7.1.4 셸은 `<channel>.yml.sig`가 없으면 피드를 믿지 않는다. **해결**: yml만 따로 복사하지 말고 패키지의 `updates/`를 통째로 복사한다. 서버에서 확인: `curl.exe -k https://localhost:8443/updates/latest.yml.sig`가 404면 없는 것이다.

### 메뉴에 "업데이트 서명 검증 실패 (n회)"가 뜸
**원인**: 업데이트가 켜진 PC가 받은 피드의 서명을 확인하지 못했다. 사유는 앱 사용자 데이터 폴더의 `updater.log`에 `UPDATE_FEED_REJECTED:<사유>`로 남는다 — `signature-file-missing`(`.sig` 없음), `signature-mismatch`(서명한 뒤 yml이 바뀌었거나 셸이 신뢰하지 않는 키로 서명), `info-mismatch(<필드>)`(PC가 받은 정보와 서명된 yml이 다름), `no-public-key`(셸에 공개 키가 없음), `feed-unavailable`·`verification-error`(yml을 받지 못함·네트워크 오류), `bad-signature-format`(`.sig` 형식 깨짐). **해결**: 서버 `updates/`의 yml과 `.sig`가 같은 릴리스의 쌍인지, 서명 키가 셸에 내장된 키와 짝인지 확인한다(`node scripts/sign-update-feed.mjs --verify --dir <updates 폴더> --channel latest`). yml과 `.sig`를 올리는 몇 초 사이에 확인한 PC는 일시적으로 어긋나 거부되고 15분 뒤 다시 확인한다(정상).

### 서명 키를 분실했거나 유출이 의심됨
**분실**: 새 키 쌍을 만들어 공개 키를 내장한 새 설치본을 **모든 PC에 수동으로 재배포**해야 한다(기존 셸은 새 서명을 신뢰할 수 없다). **유출 의심**: 새 공개 키를 목록에 추가한 셸을 먼저 배포하고, 모든 PC가 그 셸이 된 뒤 새 키로 서명한 다음 옛 키를 뺀다. 절차는 [INTRANET_DEPLOYMENT.md](INTRANET_DEPLOYMENT.md) 7-6 "키 관리". 비밀 키 파일과 암호는 따로 오프라인 백업해 두어야 한다.

### 설치본 자체의 코드서명(Authenticode)은 여전히 없음
피드 서명은 "누가 설치본을 올렸는가"를 막지만 설치본 발행자 검증 단계 자체는 없다. `/updates/` 쓰기 권한 최소화·접근 감사·보안 예외 승인은 [INTRANET_DEPLOYMENT.md](INTRANET_DEPLOYMENT.md) 7-6을 따른다.

### 내부 LLM
GPU 미확보로 병원 내부 LLM은 아직 없고, 운영은 `AI_PROVIDER=none`이다. 도입 시점에 `docker-compose.yml`의 `AI_INTERNAL_ENDPOINT`·`AI_INTERNAL_MODEL` 전달, 컨테이너에서 LLM 호스트로 가는 네트워크, `AI_TIMEOUT_MS` 상향, 내부 호출의 인증 부재(망 분리·접근 통제 확인), `aiFullReportAllowed`가 켜져 보고서 전문이 내부 LLM으로 전송됨을 확인해야 한다.

---

## 참고

- 변경 이력: [README.md](../README.md) 변경 이력 v7.1.4, [PRD.md](PRD.md) v7.1.4
- 업데이트 피드 서명(절차·키 관리·운영 주의): [INTRANET_DEPLOYMENT.md](INTRANET_DEPLOYMENT.md) 7-6
- 웹 AI 프록시 운영 설정: [VERCEL_AI_PROXY_HARDENING.md](VERCEL_AI_PROXY_HARDENING.md), 이전 단계 절차: [UPDATE_7.1.3.md](UPDATE_7.1.3.md)·[UPDATE_7.1.1.md](UPDATE_7.1.1.md)·[UPDATE_7.0.0.md](UPDATE_7.0.0.md)
- 신규 설치 가이드: [OFFLINE_DEPLOYMENT_PACKAGE.md](OFFLINE_DEPLOYMENT_PACKAGE.md), 백업/복구: [BACKUP_RESTORE.md](BACKUP_RESTORE.md)
