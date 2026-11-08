# v7.1.6 → v7.2.0 업데이트 절차 (서버 리팩터링 1차 + 보안 강화)

이미 v7.1.6이 운영 중인 인트라넷 서버를 v7.2.0으로 올리는 절차. 형식은 [UPDATE_7.1.6.md](UPDATE_7.1.6.md)를 따른다.

> **이번 릴리스는 서버 전용 패키지다(Electron 셸 변경 없음, 설치본 교체 불필요).** 서버 코드 구조를 크게 정리했지만(동작은 골든 테스트로 고정), **보안 강화로 로그인·세션 동작이 바뀌고 DB 마이그레이션 4개(0038~0041)가 적용된다.** 업데이트 전 DB 백업이 필수이고, Docker 이미지 구조가 바뀌었으므로 **개발 PC에서 아래 "배포 전 점검"을 통과한 패키지로만 배포한다.**
>
> 이 문서는 운영 서버가 **호스트 Caddy(host 모드, [PRODUCTION_RELEASE_PLAN.md](PRODUCTION_RELEASE_PLAN.md) 9-3 전환 완료)** 상태라고 본다. 아직 Docker Caddy가 8443을 쓰고 있다면 같은 절차에서 호스트 Caddy 확인 줄(B-5)만 건너뛴다.

## 무엇이 바뀌나

### 사용자·관리자에게 보이는 변화

| 변화 | 내용 |
|---|---|
| 로그인 실패 잠금 | 같은 아이디로 비밀번호를 **5번 틀리면 1분** 잠긴다. 잠금이 반복되면 2배씩 늘어 **최대 15분**. 화면에 "이 아이디가 잠시 잠겼습니다. N분 후 다시 시도하세요"가 나온다(서버 응답 429 `LOGIN_LOCKED`). 실패 기록은 마지막 실패 뒤 24시간이 지나면 지워진다. |
| 세션 수명 | 로그인 후 **12시간**이 지나면 다시 로그인한다(사용 중이어도). **24시간** 쓰지 않으면 끝난다(이전에는 유휴 7일, 절대 수명 없음). |
| 배포 직후 재로그인 | 업데이트 때 마이그레이션 0040이 기존 세션에도 12시간 규칙을 적용한다 — **로그인한 지 12시간이 넘은 세션은 업데이트 직후 다시 로그인**한다. |
| 웹 로그인 유지 | 웹(브라우저) 로그인 화면에 **"로그인 유지"** 체크박스가 생겼다. 켜지 않으면 브라우저를 닫을 때 로그아웃된다(기본 꺼짐). 설치본(Electron)은 이전과 같다. |
| 가입 요청 | 아이디 중복 여부와 상관없이 **항상 같은 접수 메시지**가 나온다(아이디 존재 여부를 알려 주지 않기 위해). |
| 관리자 콘솔 가입 요청 | 승인·거절할 때 처리한 관리자의 조직이 기록된다. 조직 관리자는 **자기 조직이 처리한 요청과 아직 처리되지 않은 요청만** 본다(조직 없는 관리자는 전체). 이미 처리된 기존 요청은 처리한 관리자의 조직으로 채워진다. |
| 새 비밀번호 | 최대 128자. |
| 요청 크기 한도 | 경로별로 나뉘었다 — 환자·워크스페이스·자동저장·영상 분석 적용 10MB, AI 분석 2MB, 통계 1MB, 나머지 256KB. 평소 사용에는 영향이 없다(500명 워크스페이스 실측 1.5~4MB). |
| 오류 응답 | 없는 `/api/...` 경로는 JSON 404, 통계 워크벤치가 꺼져 있으면 `/api/stats/...`는 로그인 전에 404, 조직 없는 계정의 일부 요청 400 → 403. 앱 화면 동작은 같다. |

### 서버 운영

- **DB 마이그레이션**(첫 기동 때 자동 적용, 41행이 된다):
  - `0038_emr_audit_nonces` — EMR 감사 로그의 nonce 재사용을 DB에서 막는 테이블
  - `0039_login_backoff` — 로그인 아이디별 실패 기록(아이디는 해시로만 저장)
  - `0040_session_absolute_expiry` — 세션 절대 만료 열(기존 세션은 같은 계보의 첫 로그인 + 12시간으로 채움)
  - `0041_signup_request_organization` — 가입 요청의 처리 조직 열(기존 처리분은 처리한 관리자의 조직으로 채움)
- **마이그레이션 체크섬**: 마이그레이션 러너가 `schema_migrations`에 `checksum` 열을 직접 추가하고(번호 마이그레이션이 아님), 기존 37행은 첫 기동 때 현재 파일 기준으로 채운다. 이후 기동마다 적용된 파일이 바뀌었는지 비교한다. **7.2.0은 `docker-compose.yml`에 `MIGRATION_CHECKSUM_MODE: warn`이 고정돼 있어 경고만 남긴다**(7.3.0부터 불일치 시 기동 실패).
- **환경변수** — `.env.production`에서 바꿀 것은 **`WR_VERSION=7.2.0`(필수)** 하나다. 그 밖:
  - `ACCESS_TOKEN_SECRET`: **32바이트 미만이면 서버가 기동하지 않는다.** 아래 "사전 준비 3)"의 명령으로 길이를 먼저 확인한다(설치 때 `openssl rand -hex 32`로 만들었으면 64자라 문제없다).
  - `REFRESH_TOKEN_SECRET`: 7.2.0은 더 이상 읽지 않고 compose도 넘기지 않는다. **그래도 지우지 않는다** — 7.1.6의 compose가 이 값을 필수로 요구하므로 7.1.6으로 롤백할 때 필요하다. 7.2.0이 자리 잡은 뒤(다음 릴리스 때) 지운다.
  - `MIGRATION_CHECKSUM_MODE`: `.env`에 넣지 않는다(compose에 고정값, `.env` 값은 컨테이너에 전달되지 않는다).
  - 세션 시간(`ACCESS_TOKEN_TTL`·`REFRESH_TOKEN_TTL`·`SESSION_ABSOLUTE_TTL`)은 compose가 컨테이너에 넘기지 않아 **`.env`로 바꿀 수 없다** — 기본값(15분·24시간·12시간)으로 동작한다.
- **Docker 이미지 구조**: npm workspaces로 바뀌어 앱 이미지 안의 작업 폴더가 `/app/server`가 됐다. 기존 운영 명령(`docker compose -p wr-prod exec app node dist/cli/...`)은 그대로 동작한다. 서버 개발용 의존성이 이미지에서 빠졌다.
- **운영 CLI**:
  - `runRetention`(DB 보존 정리)은 운영(`NODE_ENV=production`)에서 `--yes` 없이 실행하면 **지울 개수만 세고 지우지 않는다**(dry-run). 실제 삭제는 `--yes`.
  - `seedAdmin`은 운영에서 관리자 계정이 이미 있으면 **입력을 받기 전에 거부**한다(꼭 필요하면 `--force`).
- **환자 삭제**: 삭제한 환자가 자동저장 스냅샷에 남지 않도록 같이 정리한다.
- **화면(웹 자산)**: 서버가 제공하므로 PC는 새로고침만 하면 된다. 브라우저 하한은 **Chrome 108**(설치본 Electron 22 = Chromium 108)로 고정됐다 — 배포 전 점검 3)에서 현장 버전을 확인한다.
- **클라이언트(Electron)**: **설치본 교체 불필요.** 셸 코드는 7.1.4 이후 그대로다. 서버 전용 패키지라 새 패키지의 `updates/`는 비어 있다 — **7.1.6 폴더의 `updates/`를 통째로 옮긴다**(업데이트 절차 A 2번).
- **웹(Vercel, 외부)**: 운영 서버와 무관하다. 빌드 설치 명령(`vercel.json`)이 바뀌었으므로 다음 Vercel 배포 뒤 첫 화면과 AI 분석 1회를 확인한다.

## 예상 다운타임

- **서버**: 1분 안팎(컨테이너 재생성 + 마이그레이션 4개 — 모두 작은 테이블). 호스트 Caddy는 앱이 뜰 때까지 502를 돌려주다가 저절로 정상이 된다.
- **사용자**: 로그인한 지 12시간이 넘은 사용자는 다시 로그인한다. 열려 있던 화면은 새로고침한다.

---

## 배포 전 점검 (릴리스 게이트) — 통과 전에는 배포하지 않는다

개발 PC에서 한다. Phase 0 W3(npm workspaces·Dockerfile 재구성) 뒤 첫 릴리스라 **오프라인 패키지 리허설이 필수**다(로드맵 착수 순서 5번).

### 1) 패키지 만들기

```powershell
git switch main; git pull --ff-only
npm run check:full                                              # 전 단계 PASS
.\scripts\export-offline-package.ps1 -AllowMissingElectronInstaller   # 서버 전용 — 설치본·서명 키 불필요
# → release\wr-evaluation-unified-7.2.0-intranet(.zip)
```

`release-manifest.json`에서 `version`이 7.2.0, 이미지 3종(`wr-app-server`·`wr-backup-monitor`·`wr-backup`)이 7.2.0 태그, `electron/PLACEHOLDER.txt`가 있는지 본다.

### 2) 검증 스택 리허설

검증 스택 DB(`wr-verify_*` 볼륨)가 7.1.x 때 만든 것이면 그대로 두고 올려 **업그레이드 경로**를 확인한다(`purge`하지 않는다).

```powershell
# 서버 전용 패키지라 updates/ 가 비어 있다 — 마운트 확인용 시험 파일을 하나 둔다(리허설 뒤 지운다)
Set-Content release\wr-evaluation-unified-7.2.0-intranet\updates\rehearsal.txt ok

pwsh -File scripts/verify-stack.ps1 up -PackageDir release\wr-evaluation-unified-7.2.0-intranet -LoadImages
pwsh -File scripts/verify-stack.ps1 status
pwsh -File scripts/verify-stack.ps1 accept
```

| 확인 | 기대 결과 |
|---|---|
| app 로그의 `[migrate]` | `Recorded checksums for 37 previously applied migration(s).` → `Applied: 0038_…` ~ `0041_…`, `changed since they were applied` 경고 **없음** |
| 로그인·로그아웃(웹 "로그인 유지" 켬/끔) | 정상. 끈 채로 브라우저를 닫았다 열면 로그인 화면 |
| 시험 계정으로 비밀번호 5번 틀리기 | 6번째 시도에 "잠시 잠겼습니다" 안내, 1분 뒤 올바른 비밀번호로 로그인 |
| 환자 열기·저장, 워크스페이스 저장, 자동저장 | 정상 |
| 통계 분석 1회(통계를 켠 경우) | 결과 표시 |
| 영상 분석(켠 경우) | 짧은 영상 1개 분석 → 적용 |
| `https://<도메인>:8443/updates/rehearsal.txt` | 200(`updates/` 마운트 — 실제 피드는 운영에서 옮긴 뒤 B-6에서 확인) |
| 설치본(7.1.4 셸)으로 접속 | 로그인·EMR 연동 정상 |
| `verify-stack accept` | 출발지별 감사 IP·로그인 제한 버킷·8 KiB 헤더 통과 |

### 3) 현장 브라우저 버전 (운영 서버, 관리자 PowerShell — 읽기 전용)

화면의 빌드 하한이 Chrome 108이다. 호스트 Caddy 접속 기록에서 108 미만이 없는지 본다.

```powershell
Get-Content C:\ProgramData\wr-caddy\logs\access.log |
  Select-String -Pattern 'Chrome/(\d+)\.' |
  ForEach-Object { [int]$_.Matches[0].Groups[1].Value } |
  Group-Object | Sort-Object { [int]$_.Name } | Format-Table Name, Count
# → 모든 Name(주 버전)이 108 이상이어야 한다(설치본은 108, Windows 7 Chrome은 109)
```

108 미만이 있으면 배포하지 않고 그 PC의 브라우저를 먼저 올린다(또는 설치본을 쓰게 한다).

---

## 사전 준비 (운영 서버)

### 0) 현재 운영 환경 정보 파악

```powershell
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}} {{.Ports}}"   # → wr-app-server:7.1.6 127.0.0.1:3001->3001/tcp
$installDir = (docker inspect wr-prod-app-1 --format '{{json .Config.Labels}}' | ConvertFrom-Json).'com.docker.compose.project.working_dir'
$installDir                                                              # → 7.1.6 패키지 폴더(아래 updates/ 이관 원본)
Get-Service wr-caddy                                                     # → Running (host 모드)
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select count(*), max(filename) from schema_migrations"
# → 37|0037_stats_runs_limited_result.sql
```

### 1) 패키지 이송·무결성 검증

- `release\wr-evaluation-unified-7.2.0-intranet.zip`을 서버로 복사하고 압축을 푼다.
- 무결성 검증은 [UPDATE_5.1.0.md](UPDATE_5.1.0.md) "2) 무결성 검증"(SHA256SUMS)과 같다. `release-manifest.json`에서 `version`이 7.2.0, 이미지 3종이 모두 7.2.0 태그인지 확인한다. Electron 설치본이 없는 것(`electron/PLACEHOLDER.txt`)은 정상이다.

### 2) (필수) 업데이트 직전 DB 백업

이번에는 마이그레이션이 있으므로 반드시 한다.

```powershell
docker ps --filter "name=wr-prod-backup-1" --format "{{.Names}} {{.Status}}"   # → wr-prod-backup-1 Up ...
docker exec wr-prod-backup-1 sh /scripts/backup.sh
```

### 3) (필수) .env.production 수정 + 비밀키 길이·앱 포트 점검

```
# === WR_VERSION (필수) ===
# 수정 전:   WR_VERSION=7.1.6
# 수정 후:   WR_VERSION=7.2.0
#
# REFRESH_TOKEN_SECRET 은 지우지 않는다(7.1.6 롤백에 필요). MIGRATION_CHECKSUM_MODE 는 넣지 않는다.
```

수정한 뒤 **새 PowerShell 창**에서 새 패키지 폴더로 이동해 점검한다(읽기 전용 — 비밀키 값은 출력하지 않고 길이만 본다).

```powershell
cd C:\wr\wr-evaluation-unified-7.2.0-intranet
$envFile = '<운영 .env.production 절대경로>'      # 이후 모든 명령에 이 변수를 쓴다

# ACCESS_TOKEN_SECRET 바이트 길이 — 32 이상이어야 서버가 기동한다.
# env 파일 줄을 직접 읽지 않고, compose가 컨테이너에 실제로 넘길 값(따옴표·인라인 주석·셸 변수까지 해석한 값)을 읽는다.
$cfg = docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml --profile backup config --format json | ConvertFrom-Json
$len = [Text.Encoding]::UTF8.GetByteCount([string]$cfg.services.app.environment.ACCESS_TOKEN_SECRET)
Remove-Variable cfg                                # 해석된 설정에는 비밀값이 들어 있다 — 화면에 출력하지 않는다
$len                                               # → 64(openssl rand -hex 32) 등 32 이상
if ($len -lt 32) { throw "ACCESS_TOKEN_SECRET 이 $len 바이트입니다 — 아래 방법으로 바꾸기 전에는 업데이트를 진행하지 않는다(0 이면 위 config 명령의 오류부터 본다)" }

.\scripts\check-app-publish.ps1 -EnvFile $envFile -ProjectName wr-prod
# → 마지막 줄 "App port pre-check passed." 이면 진행한다
```

**32 미만이면** 새 값을 만들어 `.env.production`의 `ACCESS_TOKEN_SECRET`을 바꾼다(PowerShell 5.1 가능):

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

이 값은 15분짜리 접속 토큰의 서명에만 쓰이므로, 바꾸면 이미 발급된 접속 토큰만 무효가 되고 앱이 자동으로 새로 받는다(세션은 유지된다). 7.1.6으로 롤백해도 새 값을 그대로 쓰면 된다.

---

## 업데이트 절차

### A. 서버 업데이트

서버에서 PowerShell 관리자 권한으로(위 점검과 같은 창):

```powershell
# 1. 새 패키지 폴더로 이동
cd C:\wr\wr-evaluation-unified-7.2.0-intranet

# 2. 7.1.6 폴더의 updates/ 를 통째로 옮긴다(이번 패키지의 updates/ 는 비어 있다).
#    설치본·.blockmap·latest.yml·latest.yml.sig(+ update-policy.json, canary 파일)가 한 벌로 옮겨져야 한다.
#    원본 경로는 이 창에서 다시 구한다. 아직 재생성 전이라 7.1.6 폴더가 나온다.
$installDir = (docker inspect wr-prod-app-1 --format '{{json .Config.Labels}}' | ConvertFrom-Json).'com.docker.compose.project.working_dir'
$installDir                                                                  # → 7.1.6 패키지 폴더여야 한다(지금 폴더가 나오면 이미 재생성한 것 — 7.1.6 폴더 경로를 직접 넣는다)
if (-not (Test-Path "$installDir\updates\latest.yml") -or -not (Test-Path "$installDir\updates\latest.yml.sig")) { throw "원본 updates 가 없습니다: $installDir\updates — 여기서 멈추고 경로를 확인한다" }
Copy-Item "$installDir\updates\*" ".\updates\" -Recurse -ErrorAction Stop
Get-ChildItem .\updates                                                      # → latest.yml·latest.yml.sig·설치본이 보여야 한다. 아니면 5번(재생성)으로 가지 않는다

# 3. 새 Docker 이미지 로드
.\scripts\import-images.ps1

# 4. 로드된 이미지 확인 (wr-app-server / wr-backup-monitor / wr-backup 모두 7.2.0)
docker images | Select-String "wr-app-server|wr-backup"

# 5. 컨테이너 재생성 (host 모드: env 의 WR_CADDY_* 값 때문에 Docker Caddy 는 루프백에 머문다 — 9-4)
docker compose `
  -p wr-prod `
  --env-file $envFile `
  -f docker-compose.yml -f docker-compose.prod.yml `
  --profile backup up -d
```

### B. 서버 헬스 체크

```powershell
# 1. app 이미지 태그와 루프백 게시
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}} {{.Ports}}"   # → wr-app-server:7.2.0 127.0.0.1:3001->3001/tcp

# 2. 마이그레이션 — 41행, 체크섬이 모두 채워짐
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select count(*), max(filename), count(*) filter (where checksum is null) from schema_migrations"
# → 41|0041_signup_request_organization.sql|0

# 3. 부팅 로그의 마이그레이션 줄
docker logs wr-prod-app-1 --since 15m 2>&1 | Select-String "\[migrate\]"
# → Recorded checksums for 37 previously applied migration(s).
#   Applied: 0038_emr_audit_nonces.sql … Applied: 0041_signup_request_organization.sql
#   "changed since they were applied" 경고가 있으면 "알려진 함정" 참고(서버는 계속 동작한다)

# 4. app health / 루프백 / 8443(호스트 Caddy)
docker exec wr-prod-app-1 wget -qO- http://localhost:3001/health
curl.exe -s -o NUL -w "loopback 3001: %{http_code}`n" http://127.0.0.1:3001/health
curl.exe -k --resolve wr.hospital.local:8443:127.0.0.1 -o NUL -w "8443: %{http_code}`n" https://wr.hospital.local:8443/health

# 5. 호스트 Caddy 상태(새 패키지 폴더에서 — PRODUCTION_RELEASE_PLAN 9-4)
.\caddy-host\install-caddy-host.ps1 -Status -EnvFile $envFile

# 6. updates/ (옮긴 피드)
curl.exe -k --resolve wr.hospital.local:8443:127.0.0.1 https://wr.hospital.local:8443/updates/latest.yml        # → version: 7.1.4
curl.exe -k --resolve wr.hospital.local:8443:127.0.0.1 https://wr.hospital.local:8443/updates/latest.yml.sig    # → base64 한 줄
```

### C. 통계 워크벤치 확인 (`STATS_WORKBENCH_ENABLED=true`인 경우)

```powershell
docker exec wr-prod-app-1 /opt/stats-venv/bin/python /app/stats-engine/analyze.py --selfcheck
# → stats-engine selfcheck OK

curl.exe -k --resolve wr.hospital.local:8443:127.0.0.1 https://wr.hospital.local:8443/api/config/public
# → "statsWorkbenchAvailable": true
```

통계 카탈로그·결과 규칙은 7.1.6과 같아 이전 실행 결과 캐시가 그대로 쓰인다.

### D. 클라이언트 PC

작업 없음. 새로고침(또는 앱 재시작)하면 새 화면이 로드된다. 로그인한 지 12시간이 넘은 사용자는 다시 로그인한다. 웹으로 쓰는 사용자에게 "로그인 유지" 체크박스를 알린다.

---

## 검증 시나리오

| 시나리오 | 기대 결과 |
|---|---|
| 로그인·로그아웃, 기존 환자 열기·저장, 워크스페이스 저장 | 7.1.6과 같다 |
| 시험 계정으로 비밀번호 5번 틀리기 | "이 아이디가 잠시 잠겼습니다. N분 후…" — 1분 뒤 올바른 비밀번호로 로그인 |
| 웹에서 "로그인 유지" 끄고 로그인 → 브라우저 닫았다 열기 | 로그인 화면 |
| 설치본(7.1.4 셸)으로 접속 | 인증서 오류 없이 접속, EMR 연동 정상 |
| 가입 요청 보내기 | 접수 메시지. 관리자 콘솔에서 보이고 승인·거절 가능 |
| 관리자 콘솔 감사 로그의 IP | 실제 PC 주소(7.1.6 host 모드와 같다), 로그인 실패 감사에 아이디 해시 |
| 통계 분석(켠 경우) | 결과 표시 |
| 다른 PC에서 `<서버 IP>:3001` | 접속 거부 |

> **사전 검증한 것**(개발 PC, 코드 수준): 서버 단위 1,858건·실DB 통합 221건·운영 버전 pytest 260건·루트 3,731건(`npm run check:full`), 계산·출력·API 응답·통계 엔진 요청 골든 불변, 0037 상태 DB에서 체크섬 열 추가·backfill·0038~0041 적용이 한 번에 되는 것(통합 테스트). **아직 하지 않은 것**: 위 "배포 전 점검"의 패키지 리허설(이 문서와 함께 진행), 운영 서버(구버전 Docker Desktop·Compose v2.22.0)에서의 실제 업데이트.

---

## 롤백 절차

### 1) 앱 이미지만 되돌리기 (대부분의 경우 충분)

0038~0041과 체크섬 열은 **7.1.6 코드와 함께 써도 문제없다**(새 테이블·새 열만 추가했고 새 열에는 기본값이 있다). 그래서 DB는 그대로 두고 7.1.6 폴더의 compose로 기동한다.

```powershell
# .env.production: WR_VERSION=7.2.0 → 7.1.6  (REFRESH_TOKEN_SECRET 이 남아 있어야 한다 — 7.1.6 compose 필수값)
cd <7.1.6 패키지 폴더>
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml --profile backup up -d
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}} {{.Ports}}"      # → wr-app-server:7.1.6 127.0.0.1:3001->3001/tcp
```

- 7.1.6 compose도 Caddy 게시 주소 변수(`WR_CADDY_*_BIND`)를 지원하므로 host 모드가 유지된다.
- 되돌린 동안은 7.1.6 동작이다(로그인 잠금 없음, 세션 유휴 7일 — 0040의 절대 만료 열은 무시된다).
- 나중에 다시 7.2.0으로 올리면 그대로 이어진다(마이그레이션은 이미 적용돼 있고, 체크섬도 남아 있다).

### 2) DB 복원 (스키마·데이터 자체에 문제가 있을 때만)

사전 준비 2)의 백업으로 복원한다. 절차는 [PRODUCTION_RELEASE_PLAN.md](PRODUCTION_RELEASE_PLAN.md) 6절. 백업 이후에 저장된 내용은 사라지므로 1)로 해결되지 않을 때만 한다.

---

## 알려진 함정·한계

### 사용자가 "아이디가 잠시 잠겼다"며 로그인하지 못함
**원인**: 같은 아이디로 5번 이상 틀렸다. **해결**: 안내된 시간(최대 15분)을 기다린 뒤 올바른 비밀번호로 로그인한다. 관리자 콘솔에 잠금 해제 기능은 없고, **관리자가 비밀번호를 초기화해도 잠금 시간은 그대로다**(잠금이 끝난 뒤 임시 비밀번호로 로그인). 성공하면 실패 기록이 지워진다.

### 업데이트 직후 여러 사용자가 다시 로그인함
**원인**: 정상이다. 0040이 로그인한 지 12시간이 넘은 세션을 끝냈다.

### 웹에서 브라우저를 닫을 때마다 로그인하라고 함
**원인**: 7.2.0부터 웹은 기본이 세션 쿠키다. **해결**: 로그인 화면에서 "로그인 유지"를 켠다(그래도 12시간·24시간 규칙은 같다).

### 서버가 기동하지 않고 로그에 `ACCESS_TOKEN_SECRET must be at least 32 bytes`
**원인**: 비밀키가 짧다. **해결**: 사전 준비 3)의 방법으로 새 값을 넣고 `up -d`를 다시 한다.

### 부팅 로그에 `Applied migration file(s) changed since they were applied`
**원인**: DB에 기록된 체크섬과 이미지 안의 마이그레이션 파일이 다르다. 7.2.0은 경고만 하고 계속 동작한다. **해결**: 파일 이름을 개발 담당에게 알린다. 7.3.0부터는 이 상태면 서버가 기동하지 않으므로 그 전에 원인을 정리한다. 첫 기동에서는 나오지 않는 것이 정상이다(첫 기동은 체크섬을 채우기만 한다).

### 부팅 로그에 `Applied migration file(s) not found`
**원인**: DB에 이 이미지에 없는 마이그레이션이 적용돼 있다(예: 더 새 버전을 올렸다가 이미지만 되돌림). 경고만 하고 계속 동작한다.

### 관리자 콘솔에 어떤 가입 요청이 안 보임
**원인**: 다른 조직의 관리자가 이미 처리한 요청은 그 조직에만 보인다. 대기 중인 요청은 모든 관리자에게 보인다.

### `.env.production`의 세션 시간 값을 바꿨는데 반영되지 않음
**원인**: compose가 `ACCESS_TOKEN_TTL`·`REFRESH_TOKEN_TTL`·`SESSION_ABSOLUTE_TTL`을 컨테이너에 넘기지 않는다. 지금은 기본값(15분·24시간·12시간) 고정이다.

### `runRetention`을 실행했는데 아무것도 지워지지 않음
**원인**: 7.2.0부터 운영에서는 `--yes` 없이 실행하면 dry-run이다. 출력된 개수를 확인한 뒤 `--yes`로 다시 실행한다.

### 이번 릴리스에 없는 보안 항목
Python 자식 프로세스의 환경변수 최소화(L10), compose 기본값 정리(L13 — `changeme` 기본값 등, 운영 compose는 이미 필수값을 요구), Caddy 로그의 쿼리 문자열 제거(L17 — 호스트 Caddy 설정은 이미 제거함)는 GPU·검증 스택 확인이 필요해 다음 릴리스로 미뤘다.

---

## 참고

- 변경 이력: [README.md](../README.md) 변경 이력 v7.2.0, [PRD.md](PRD.md) v7.2.0
- 리팩터링 계획과 진행: [REFACTORING_ROADMAP.md](REFACTORING_ROADMAP.md) Phase 0·Phase 1, 보안 항목 추적표
- 호스트 Caddy 운영: [PRODUCTION_RELEASE_PLAN.md](PRODUCTION_RELEASE_PLAN.md) 9-4, 롤백·복원 6절
- 이전 단계: [UPDATE_7.1.6.md](UPDATE_7.1.6.md)(7.1.5 → 7.1.6)
