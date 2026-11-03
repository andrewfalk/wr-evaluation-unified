# v7.1.5 → v7.1.6 업데이트 절차 (운영 패치 — 호스트 Caddy 도구)

이미 v7.1.5가 운영 중인 인트라넷 서버를 v7.1.6으로 올리는 절차. 형식은 [UPDATE_7.1.5.md](UPDATE_7.1.5.md)를 따른다.

> **이번 릴리스는 서버 전용 패치다(앱 코드·Electron 셸·DB 스키마 변경 없음).** 관리자 콘솔의 IP가 모두 같은 값으로 찍히는 문제를 고치기 위해 Caddy를 Windows 호스트 서비스로 옮기는 작업의 **2·3단계 도구**를 패키지에 담는다. **이 업데이트 자체는 접속 방식을 바꾸지 않는다** — 업데이트가 끝나도 8443은 지금처럼 Docker Caddy가 서비스한다. 호스트 Caddy 시범 설치(2단계)와 8443 전환(3단계)은 업데이트를 마치고 관찰한 뒤 **따로 시간을 잡아** [PRODUCTION_RELEASE_PLAN.md](PRODUCTION_RELEASE_PLAN.md) 9절대로 한다.
>
> **운영이 아직 v7.1.4이면 이 문서보다 먼저 [UPDATE_7.1.5.md](UPDATE_7.1.5.md)를 따른다.** 7.1.5(앱 루프백 게시)를 배포·관찰한 뒤 7.1.6을 올려야, 호스트 Caddy가 연결할 앱 뒷문(`127.0.0.1:<WR_APP_PORT>`)이 검증된 상태에서 시작한다.

## 무엇이 바뀌나

- **새 패키지 폴더 `caddy-host\`** (설치 전까지는 아무 동작도 하지 않는다):
  - `caddy.exe` — Caddy 공식 Windows 바이너리 **2.11.7**. 코드 서명이 없다. 빌드 PC가 저장소의 고정 SHA-512로 검증해 넣었고, 그 값은 `release-manifest.json`의 `caddyHost.exeSha512`에 있다(보안 프로그램 허용 요청에 쓴다).
  - `install-caddy-host.ps1` — 호스트 Caddy 서비스(`wr-caddy`)의 시범 설치(`-Install`)·상태(`-Status`)·8443 전환(`-Cutover`)·되돌리기(`-Rollback`)·앱 포트 반영(`-Reconfigure`)·제거(`-Uninstall`). Windows PowerShell 5.1에서 동작하고 `-WhatIf`로 미리 점검할 수 있다.
  - `Caddyfile.host.template` — 설치 스크립트가 도메인·포트·경로를 채워 서비스 설정을 만드는 틀(관리 API 끔, HTTP/3 끔, 로그의 URL 쿼리 문자열 제거).
- **`scripts\backup-caddy-ca.ps1 -SourceDir`** — 호스트 Caddy 서비스가 쓰는 CA 사본(`C:\ProgramData\wr-caddy\data`)도 같은 형식으로 암호화 백업한다(관리자 창 필요). 볼륨 백업(기존 사용법)은 그대로다.
- **`scripts\export-backup-snapshot.ps1`·`register-backup-export-task.ps1`** — 백업 반출 스크립트가 이번 패키지부터 `scripts\`에 들어 있다(7.1.5 패키지에는 없었다). 이전 패키지 폴더에서 작업을 등록했다면 [BACKUP_EXPORT_OPS.md](BACKUP_EXPORT_OPS.md) "패키지 업데이트와 무관하게 유지하기"를 본다.
- **운영 문서**: [PRODUCTION_RELEASE_PLAN.md](PRODUCTION_RELEASE_PLAN.md) 9절(호스트 Caddy 전환·롤백·복구), 7-1(호스트 CA 사본 백업·상황별 복구), 1절 방화벽 포트 정정(8443/8080). 7.1.5 안내서의 5.1 호환 명령 정정(#180)도 포함된다.
- **DB 스키마**: **변경 없음**(0037까지, 37행 그대로).
- **환경변수**: `.env.production`에서 **`WR_VERSION=7.1.6` (필수)** 만 바꾼다. `WR_CADDY_HTTPS_BIND`·`WR_CADDY_HTTP_BIND`는 **직접 넣지 않는다** — 8443 전환(9-3) 때 설치 스크립트가 넣고, 롤백 때 되돌린다.
- **클라이언트(Electron)**: **설치본 교체 불필요.** 셸은 7.1.4와 같다. 서버 전용 패키지라 새 패키지의 `updates/`는 비어 있다 — **7.1.5 폴더의 `updates/`를 통째로 옮긴다**(아래 "업데이트 절차 A" 2번).
- **웹(Vercel)**: 변경 없음.

## 예상 다운타임

- **서버**: 수십 초(app·backup 컨테이너 재생성 — 패키지 폴더가 바뀌어 caddy도 다시 만들어질 수 있다). 마이그레이션이 없다.
- **클라이언트 PC**: 작업 없음. 열려 있던 화면은 새로고침하면 된다.

## 사전 준비

### 0) 현재 운영 환경 정보 파악

```powershell
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}} {{.Ports}}"   # → wr-app-server:7.1.5 127.0.0.1:3001->3001/tcp (7.1.4 이면 UPDATE_7.1.5.md 먼저)
$installDir = (docker inspect wr-prod-app-1 --format '{{json .Config.Labels}}' | ConvertFrom-Json).'com.docker.compose.project.working_dir'
$installDir                                                              # → 7.1.5 패키지 폴더(아래 updates/ 이관 원본)
docker compose version
```

### 1) 패키지 이송·무결성 검증

- `release\wr-evaluation-unified-7.1.6-intranet.zip`을 서버로 복사하고 압축을 푼다.
- 무결성 검증은 [UPDATE_5.1.0.md](UPDATE_5.1.0.md) "2) 무결성 검증"(SHA256SUMS)과 같다. `release-manifest.json`에서 다음을 확인한다: `version`이 7.1.6, 이미지 3종이 모두 7.1.6 태그, `caddyHost.included`가 `true`이고 `caddyHost.version`이 `2.11.7`. 이 패키지에는 Electron 설치본이 없다(`electron/PLACEHOLDER.txt`) — 정상이다.

### 2) (필수) 업데이트 직전 DB 백업

```powershell
docker ps --filter "name=wr-prod-backup-1" --format "{{.Names}} {{.Status}}"   # → wr-prod-backup-1 Up ...
docker exec wr-prod-backup-1 sh /scripts/backup.sh
```

### 3) (필수) .env.production 수정 + 앱 포트 점검

```
# === WR_VERSION (필수) ===
# 수정 전:   WR_VERSION=7.1.5
# 수정 후:   WR_VERSION=7.1.6
```

수정한 뒤 **새 PowerShell 창**에서 새 패키지 폴더로 이동해 점검을 실행한다(읽기 전용).

```powershell
cd C:\wr\wr-evaluation-unified-7.1.6-intranet
$envFile = '<운영 .env.production 절대경로>'      # 이후 모든 명령에 이 변수를 쓴다
.\scripts\check-app-publish.ps1 -EnvFile $envFile -ProjectName wr-prod
# → 마지막 줄 "App port pre-check passed." 이면 진행한다
```

점검 결과별 조치는 [UPDATE_7.1.5.md](UPDATE_7.1.5.md) "사전 준비 3)"의 표와 같다. 7.1.5가 이미 돌고 있으므로 보통 `Port 3001 is held by this project's app container`(정상)가 나온다.

---

## 업데이트 절차

### A. 서버 업데이트

서버에서 PowerShell 관리자 권한으로(위 점검과 같은 창):

```powershell
# 1. 새 패키지 폴더로 이동
cd C:\wr\wr-evaluation-unified-7.1.6-intranet

# 2. 7.1.5 폴더의 updates/ 를 통째로 옮긴다(이번 패키지의 updates/ 는 비어 있다).
#    설치본·.blockmap·latest.yml·latest.yml.sig(+ update-policy.json, canary 파일)가 한 벌로 옮겨져야 한다.
#    원본 경로는 이 창에서 다시 구한다(새 창을 열었으면 0)의 $installDir 는 없다). 아직 재생성 전이라 7.1.5 폴더가 나온다.
$installDir = (docker inspect wr-prod-app-1 --format '{{json .Config.Labels}}' | ConvertFrom-Json).'com.docker.compose.project.working_dir'
$installDir                                                                  # → 7.1.5 패키지 폴더여야 한다(지금 폴더가 나오면 이미 재생성한 것 — 7.1.5 폴더 경로를 직접 넣는다)
if (-not (Test-Path "$installDir\updates\latest.yml") -or -not (Test-Path "$installDir\updates\latest.yml.sig")) { throw "원본 updates 가 없습니다: $installDir\updates — 여기서 멈추고 경로를 확인한다" }
Copy-Item "$installDir\updates\*" ".\updates\" -Recurse -ErrorAction Stop
Get-ChildItem .\updates                                                      # → latest.yml·latest.yml.sig·설치본이 보여야 한다. 아니면 5번(재생성)으로 가지 않는다

# 3. 새 Docker 이미지 로드
.\scripts\import-images.ps1

# 4. 로드된 이미지 확인 (wr-app-server / wr-backup-monitor / wr-backup 모두 7.1.6)
docker images | Select-String "wr-app-server|wr-backup"

# 5. 컨테이너 재생성
docker compose `
  -p wr-prod `
  --env-file $envFile `
  -f docker-compose.yml -f docker-compose.prod.yml `
  --profile backup up -d
```

### B. 서버 헬스 체크

```powershell
# 1. app 이미지 태그와 루프백 게시
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}} {{.Ports}}"   # → wr-app-server:7.1.6 127.0.0.1:3001->3001/tcp

# 2. 마이그레이션 — 새로 적용되는 것이 없다 (0037 그대로, 37행)
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select count(*), max(filename) from schema_migrations"

# 3. app health / 루프백 / Caddy 경유 (8443은 여전히 Docker Caddy)
docker exec wr-prod-app-1 wget -qO- http://localhost:3001/health
curl.exe -s -o NUL -w "loopback 3001: %{http_code}`n" http://127.0.0.1:3001/health
curl.exe -k --resolve wr.hospital.local:8443:127.0.0.1 -o NUL -w "8443: %{http_code}`n" https://wr.hospital.local:8443/health

# 4. updates/ (옮긴 피드)
curl.exe -k --resolve wr.hospital.local:8443:127.0.0.1 https://wr.hospital.local:8443/updates/latest.yml        # → version: 7.1.4
curl.exe -k --resolve wr.hospital.local:8443:127.0.0.1 https://wr.hospital.local:8443/updates/latest.yml.sig    # → base64 한 줄
```

다른 PC에서 앱 포트가 막혀 있는지(3001 연결 안 됨, 8443 연결됨)는 [UPDATE_7.1.5.md](UPDATE_7.1.5.md) "B. 서버 헬스 체크"의 방법과 같다.

### C. 호스트 Caddy 준비물 확인 (읽기 전용, 아무것도 설치하지 않는다)

2단계(시범) 전에 서버에서 미리 확인해 둔다.

```powershell
# 1. caddy.exe 가 매니페스트의 SHA-512 와 같은가
$m = Get-Content .\release-manifest.json -Raw | ConvertFrom-Json
(Get-FileHash .\caddy-host\caddy.exe -Algorithm SHA512).Hash -eq $m.caddyHost.exeSha512.ToUpper()   # → True

# 2. 보안 프로그램이 실행을 막지 않는가 (버전만 출력하고 끝난다)
.\caddy-host\caddy.exe version                                                                   # → v2.11.7 ...
```

`caddy.exe version`이 막히거나 경고가 뜨면 2단계로 가지 말고 보안 프로그램 담당자와 먼저 협의한다(허용 기준: `caddyHost.exeSha512`, 설치 경로 `C:\ProgramData\wr-caddy\bin\caddy.exe`, 서비스 `wr-caddy` — PRODUCTION_RELEASE_PLAN 9-1).

### D. Caddy 내부 CA 키 백업 (아직 하지 않았다면)

호스트 Caddy 설치(2단계)의 전제다. 절차는 [PRODUCTION_RELEASE_PLAN.md](PRODUCTION_RELEASE_PLAN.md) 7-1:

```powershell
.\scripts\backup-caddy-ca.ps1 -EnvFile $envFile
```

### E. 다음 단계 (별도 일정)

업데이트 뒤 며칠 관찰(앱 재시작 반복 없음, 재부팅 뒤 루프백 게시 유지)한 다음, [PRODUCTION_RELEASE_PLAN.md](PRODUCTION_RELEASE_PLAN.md) 9절을 따른다.

1. **9-1 사전 준비** — 클라이언트 PC의 루트 SHA-256 지문, CA 백업 아카이브·`.info.txt`, 보안 프로그램 협의.
2. **9-2 시범 설치(2단계)** — 9443/9080에서 `wr-caddy`를 띄우고 다른 PC에서 잘못된 로그인 1회 → 감사 로그에 그 PC의 실제 IP가 남는지 확인. 8443·사용자 영향 없음.
3. **9-3 8443 전환(3단계, 점검 창 약 15분)** — `-Cutover`. 실패하면 스스로 Docker Caddy로 돌아간다. 사후 확인 목록대로 점검.

---

## 검증 시나리오

| 시나리오 | 기대 결과 |
|---|---|
| 기존 환자 열기·저장, 로그인·로그아웃 | 7.1.5와 같다 |
| 설치본(7.1.4 셸)으로 접속 | 인증서 오류 없이 접속, EMR 연동 정상 |
| 서버에서 `http://127.0.0.1:3001/health` | 200 |
| 다른 PC에서 `<서버 IP>:3001` | 접속 거부 |
| 관리자 콘솔 감사 로그의 IP | **업데이트 직후에는 아직 모두 같은 값(정상)** — 9-3 전환 뒤부터 실제 PC 주소 |
| `.\caddy-host\caddy.exe version` | 버전 출력(보안 프로그램이 막지 않음) |

> **사전 검증한 것**: 개발 PC의 검증 스택(`verify-stack.ps1`, 7.1.5 패키지 + 이 릴리스의 스크립트)에서 관리자 리허설로 시범 설치·8443 전환·전체 `up -d` 뒤 host 모드 유지·앱 포트 변경(`-Reconfigure`)·롤백·재전환·제거, 전환 도중 강제 종료(중단된 전환)와 그 복구, 기동 실패 시 자동 복귀, 동시 실행 잠금, 거부 시험(셸 변수·손으로 바꾼 env·override 누락 등)을 확인했다. 감사 로그 IP가 출발지별(서버 루프백·LAN 주소)로 남고, 로그인 제한 버킷이 출발지별로 나뉘며(`verify-stack accept`), 8 KiB 헤더가 통과했다. `backup-caddy-ca -SourceDir`로 받은 아카이브를 풀어 호스트 사본·볼륨 백업과 바이트 단위로 같음을 확인했다. Windows PowerShell 5.1과 PowerShell 7 모두에서 실행했다. **하지 못한 것**: 운영 서버(구버전 Docker Desktop·Compose v2.22.0)에서의 실제 설치·전환, 서버 보안 프로그램의 반응, 실제 다른 PC 여러 대에서의 IP 기록, 운영 서버 재부팅 시 서비스·Docker 기동 순서. 그래서 2단계(시범)를 먼저 하고 관찰한다.

---

## 롤백 절차

### 1) 7.1.6 업데이트만 되돌리기 (호스트 Caddy를 아직 설치하지 않았을 때)

7.1.5 패키지 폴더의 compose로 기동하면 원래 상태가 된다.

```powershell
# .env.production: WR_VERSION=7.1.6 → 7.1.5
cd <7.1.5 패키지 폴더>
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml --profile backup up -d
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}} {{.Ports}}"      # → wr-app-server:7.1.5 127.0.0.1:3001->3001/tcp
```

스키마 변경이 없어 DB는 그대로 둔다. PC 쪽 작업은 없다.

### 2) 호스트 Caddy를 시범 설치(9-2)했거나 8443을 전환(9-3)한 뒤

- **호스트 Caddy만 되돌리기**: [PRODUCTION_RELEASE_PLAN.md](PRODUCTION_RELEASE_PLAN.md) 9-5(`-Rollback -EnvFile $envFile`) 또는 시범 단계면 `-Uninstall`.
- **앱을 7.1.5로 되돌려야 하면**: 7.1.5의 compose도 Caddy 게시 주소 변수(`WR_CADDY_*_BIND`)를 지원하므로 host 모드에서도 위 1)처럼 7.1.5 폴더에서 `up -d` 할 수 있다(host 모드가 유지된다). 다만 그 뒤에 호스트 Caddy를 롤백하려면 스크립트가 실행 중인 caddy 컨테이너의 폴더와 대조하므로, 7.1.6 폴더의 스크립트에 `-ComposeDir <7.1.5 패키지 폴더>`를 함께 준다.
  ```powershell
  cd C:\wr\wr-evaluation-unified-7.1.6-intranet
  .\caddy-host\install-caddy-host.ps1 -Rollback -EnvFile $envFile -ComposeDir <7.1.5 패키지 폴더>
  ```
- **7.1.4 이하 폴더의 compose로 되돌려야 하면 반드시 호스트 Caddy `-Rollback`을 먼저** 한다(그 compose에는 게시 주소 변수가 없어 Docker Caddy가 8443을 다시 잡으려다 `wr-caddy`와 부딪친다).

---

## 알려진 함정·한계

### `updates/`가 비어 신규 PC 설치·자동 업데이트가 안 됨
**원인**: 서버 전용 패키지라 `updates/`가 비어 있고, compose의 `./updates`는 새 폴더 기준이다. **해결**: 7.1.5 폴더의 `updates/`를 통째로 옮긴다(업데이트 절차 A 2번).

### 셸 환경변수가 env 파일을 덮어씀
**원인**: Compose는 셸에 설정된 변수를 `--env-file`보다 우선한다. **해결**: 새 PowerShell 창에서 실행한다. `check-app-publish.ps1`과 `install-caddy-host.ps1`이 이 경우를 거부한다.

### `caddy.exe version`이 차단·격리됨
**원인**: 서명 없는 실행 파일이라 보안 프로그램이 막을 수 있다. **해결**: 2단계로 가지 않는다. `release-manifest.json`의 `caddyHost.exeSha512`와 설치 경로로 허용을 받은 뒤 다시 확인한다. 업데이트 자체(컨테이너)에는 영향이 없다.

### 감사 로그 IP가 여전히 모두 같다
**원인**: 정상이다. 이 업데이트는 도구만 담는다. 실제 IP 기록은 9-3 전환 뒤부터다.

### `WR_CADDY_HTTPS_BIND` 등을 직접 넣고 싶다
**하지 않는다.** 이 값은 `-Cutover`가 전환 기록(`C:\ProgramData\wr-caddy\state\host-mode.json`)과 함께 넣고 `-Rollback`이 되돌린다. 손으로 넣으면 다음 `up -d`에서 Docker Caddy가 루프백으로 옮겨 가 8443이 비고, 스크립트도 손으로 바꾼 값으로 보고 거부한다.

---

## 참고

- 변경 이력: [README.md](../README.md) 변경 이력 v7.1.6, [PRD.md](PRD.md) v7.1.6
- 호스트 Caddy 절차: [PRODUCTION_RELEASE_PLAN.md](PRODUCTION_RELEASE_PLAN.md) 9절, CA 키 백업·복구 7-1
- 이전 단계: [UPDATE_7.1.5.md](UPDATE_7.1.5.md)(7.1.4 → 7.1.5, 앱 루프백 게시)
