# v7.1.4 → v7.1.5 업데이트 절차 (운영 패치 — 앱 루프백 게시)

이미 v7.1.4가 운영 중인 인트라넷 서버를 v7.1.5로 올리는 절차. 형식은 [UPDATE_7.1.4.md](UPDATE_7.1.4.md)·[UPDATE_7.1.3.md](UPDATE_7.1.3.md)를 따른다.

> **이번 릴리스는 서버 전용 패치다(앱 코드·Electron 셸·DB 스키마 변경 없음).** 관리자 콘솔의 IP가 모두 같은 값으로 찍히는 문제를 고치기 위해 Caddy를 Windows 호스트 서비스로 옮기는 작업의 **1단계**로, **앱을 서버 PC 안에서만 닿는 `127.0.0.1:<포트>`에 게시**한다. 사용자 접속 방식(`https://wr.hospital.local:8443`)과 화면은 바뀌지 않는다. 접속자 실제 IP 기록은 아직 바뀌지 않는다(다음 단계).
>
> **운영이 아직 v7.1.3이면 이 문서보다 먼저 [UPDATE_7.1.4.md](UPDATE_7.1.4.md)를 따른다.** 7.1.4(셸 교체가 있는 보안 핫픽스)를 배포·관찰한 뒤 7.1.5를 올려야, 이번 변경(앱 게시)만 따로 검증할 수 있다.

## 무엇이 바뀌나

- **앱 포트 게시**: `docker-compose.prod.yml`이 앱(컨테이너 3001)을 **`127.0.0.1:3001`에만 게시**한다(이전: 게시 없음). 다른 PC에서는 이 포트에 접속할 수 없고, 외부 진입점은 계속 Caddy(8443/8080) 하나다. 이후 단계에서 Windows에서 도는 Caddy가 이 포트로 앱에 연결한다.
  - 호스트 주소(`127.0.0.1`)는 compose 파일에 고정돼 있고 바꿀 수 있는 것은 포트 번호(`WR_APP_PORT`)뿐이다. 주소를 넣으면(`WR_APP_PORT=0.0.0.0:3001`) compose가 오류로 멈춘다.
  - 3001을 이 서버의 다른 프로그램이 쓰고 있으면 앱이 기동하지 못한다 → 아래 "사전 준비 3)"의 점검이 미리 알려 준다.
- **새 스크립트** (패키지 `scripts\`):
  - `check-app-publish.ps1` — 업데이트 전 **읽기 전용** 점검(아래 "사전 준비 3)"). 아무것도 바꾸지 않는다.
  - `backup-caddy-ca.ps1` — Caddy 내부 CA 키 백업(7.1.4 패키지에는 없던 스크립트). 아직 CA 키를 백업하지 않았다면 이번에 함께 한다(아래 "업데이트 절차 C").
- **DB 스키마**: **변경 없음**(0037까지, 37행 그대로). 그래도 업데이트 전 백업은 유지한다.
- **환경변수**: `.env.production`에서
  - **`WR_VERSION=7.1.5` (필수)**.
  - `WR_APP_PORT`(선택) — 앱 루프백 게시 포트 번호. 없으면 3001. **숫자만** 적는다(따옴표·주석 금지).
  - 예전 `DEV_PORT=127.0.0.1:3001` 줄이 있으면 그대로 둬도 된다(운영에서는 무시된다).
  - 그 밖의 값(`STATS_*`·`AI_*` 등)은 그대로 둔다.
- **클라이언트(Electron)**: **설치본 교체 불필요.** 셸은 7.1.4와 같다. 이번 패키지에는 설치본이 없다(서버 전용 패키지) — 신규 PC에는 7.1.4 패키지의 설치본을 쓴다.
- **`updates/` 폴더**: 서버 전용 패키지라 새 패키지의 `updates/`는 **비어 있다**. compose의 `./updates`는 새 패키지 폴더 기준이므로, **7.1.4 폴더의 `updates/`를 통째로 옮겨야** 신규 PC 설치·자동 업데이트 피드가 그대로 유지된다(아래 "업데이트 절차 A" 2번).
- **웹(Vercel)**: 변경 없음.

## 예상 다운타임

- **서버**: 수십 초(app 컨테이너 재생성). 마이그레이션이 없다. postgres·caddy는 영향 없음.
- **클라이언트 PC**: 작업 없음. 열려 있던 화면은 새로고침하면 된다.

## 사전 준비

### 0) 현재 운영 환경 정보 파악

```powershell
docker compose ls
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"      # → wr-app-server:7.1.4 이어야 한다 (7.1.3이면 UPDATE_7.1.4.md 먼저)
$installDir = docker inspect wr-prod-app-1 --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
Get-Content (Join-Path $installDir ".env.production") | Select-String "WR_VERSION|WR_APP_PORT|DEV_PORT"
docker info --format '{{.OperatingSystem}}'                         # → Docker Desktop (아래 점검이 이 값을 본다)
docker compose version
```

### 1) 패키지 이송·무결성 검증

- `release\wr-evaluation-unified-7.1.5-intranet.zip`을 서버로 복사하고 압축을 푼다.
- 무결성 검증은 [UPDATE_5.1.0.md](UPDATE_5.1.0.md) "2) 무결성 검증"(SHA256SUMS)과 같다. `release-manifest.json`의 `version`이 7.1.5이고 이미지 3종이 모두 7.1.5 태그인지 확인한다. 이 패키지에는 Electron 설치본이 없다(`electron/PLACEHOLDER.txt`) — 정상이다.

### 2) (필수) 업데이트 직전 DB 백업

```powershell
docker compose -p wr-prod --profile backup run --rm backup /scripts/backup.sh
```

### 3) (필수) .env.production 수정 + 앱 포트 점검

```
# === WR_VERSION (필수) ===
# 수정 전:   WR_VERSION=7.1.4
# 수정 후:   WR_VERSION=7.1.5
```

수정한 뒤 **새 PowerShell 창**에서(이전 창에 시험용 환경변수가 남아 있지 않도록) 새 패키지 폴더로 이동해 점검을 실행한다. 읽기 전용이라 아무것도 바꾸지 않는다.

```powershell
cd C:\wr\wr-evaluation-unified-7.1.5-intranet
.\scripts\check-app-publish.ps1 -EnvFile "<운영 .env.production 절대경로>" -ProjectName wr-prod
# → 마지막 줄 "App port pre-check passed." 이면 진행한다
```

| 점검 결과 | 뜻·조치 |
|---|---|
| `Port 3001 is free` | 정상(첫 적용). 진행한다 |
| `Port 3001 is held by this project's app container` | 정상(이미 적용된 상태에서 다시 실행). 진행한다 |
| `Port 3001 is used by another container` / `already used by <프로세스>` | 다른 프로그램이 3001을 쓴다. `.env.production`에 `WR_APP_PORT=13001`처럼 비어 있는 번호를 적고 점검을 다시 실행한다 |
| `These variables are set in this shell ...` | 이 창에 `WR_APP_PORT` 등이 설정돼 있다. 새 PowerShell 창에서 다시 실행한다 |
| `WR_APP_PORT ... must be a port number only` | 값에 주소·따옴표·주석이 있다. 숫자만 남긴다 |
| `does not publish the app at all` | 이전 패키지 폴더에서 실행했다. 7.1.5 폴더에서 실행한다 |
| `Docker Engine ... is older than 28.0.0` | `docker info`가 Docker Desktop이 아니라고 보고한 경우다. **진행하지 말고** 위 "0)"의 `docker info --format '{{.OperatingSystem}}'` 값을 확인한다(이 서버는 Docker Desktop이어야 한다) |

---

## 업데이트 절차

### A. 서버 업데이트

서버에서 PowerShell 관리자 권한으로(위 점검과 같은 창):

```powershell
# 1. 새 패키지 폴더로 이동
cd C:\wr\wr-evaluation-unified-7.1.5-intranet

# 2. 7.1.4 폴더의 updates/ 를 통째로 옮긴다(이번 패키지의 updates/ 는 비어 있다).
#    설치본·.blockmap·latest.yml·latest.yml.sig(+ update-policy.json, canary 파일)가 한 벌로 옮겨져야 한다.
#    yml만 옮기면 7.1.4 셸이 모든 업데이트를 거부한다.
Copy-Item "<7.1.4 폴더>\updates\*" ".\updates\" -Recurse
Get-ChildItem .\updates

# 3. 새 Docker 이미지 로드
.\scripts\import-images.ps1

# 4. 로드된 이미지 확인 (wr-app-server / wr-backup-monitor / wr-backup 모두 7.1.5)
docker images | Select-String "wr-app-server|wr-backup"

# 5. 컨테이너 재생성
docker compose `
  -p wr-prod `
  --env-file <운영 .env.production 절대경로> `
  -f docker-compose.yml -f docker-compose.prod.yml `
  --profile backup up -d
```

정상이면 `Recreate wr-prod-app-1`(및 backup-monitor/backup)이 출력된다. Caddy는 설정이 같아 재생성되지 않을 수 있다(정상).

### B. 서버 헬스 체크

```powershell
# 1. app 이미지 태그
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"      # → wr-app-server:7.1.5

# 2. 앱 게시가 루프백에만 있는지 ★이번 릴리스의 핵심★
docker ps --filter "name=wr-prod-app-1" --format "{{.Ports}}"      # → 127.0.0.1:3001->3001/tcp  (0.0.0.0 이나 [::] 가 보이면 실패)
Get-NetTCPConnection -State Listen -LocalPort 3001 | Select-Object LocalAddress, OwningProcess   # → LocalAddress 127.0.0.1 만

# 3. 마이그레이션 — 새로 적용되는 것이 없다 (0037 그대로, 37행)
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select count(*), max(filename) from schema_migrations"

# 4. app health / 루프백 게시 / Caddy 경유
docker exec wr-prod-app-1 wget -qO- http://localhost:3001/health
curl.exe -s -o NUL -w "loopback 3001: %{http_code}`n" http://127.0.0.1:3001/health
curl.exe -k -o NUL -w "8443: %{http_code}`n" https://localhost:8443/health

# 5. updates/ (2번에서 옮긴 7.1.4 피드)
curl.exe -k https://localhost:8443/updates/latest.yml        # → version: 7.1.4
curl.exe -k https://localhost:8443/updates/latest.yml.sig    # → base64 한 줄
```

**다른 PC에서** 앱 포트가 막혀 있는지 확인한다(서버 주소는 실제 IP로):

```powershell
Test-NetConnection <서버 IP> -Port 3001     # → TcpTestSucceeded : False  (True면 즉시 롤백)
Test-NetConnection <서버 IP> -Port 8443     # → TcpTestSucceeded : True
```

### C. Caddy 내부 CA 키 백업 (아직 하지 않았다면)

다음 단계(호스트 Caddy 전환)의 전제다. CA 키를 잃으면 모든 PC에 루트 인증서를 다시 설치해야 한다. 절차는 [PRODUCTION_RELEASE_PLAN.md](PRODUCTION_RELEASE_PLAN.md) 7-1:

```powershell
.\scripts\backup-caddy-ca.ps1
```

### D. 관찰 기간 (다음 단계로 가기 전)

며칠 동안(업무일 1회 이상, 가능하면 서버 정기 재부팅 1회 포함) 다음을 확인한다. 이상이 없어야 다음 단계(호스트 Caddy 시범)로 넘어간다.

- 앱 기동 실패·재시작 반복이 없다(`docker ps`의 상태, `docker logs wr-prod-app-1 --tail 100`).
- 재부팅 뒤에도 `127.0.0.1:3001` 게시가 다시 생기고 다른 PC에서는 막혀 있다(위 B-2, 다른 PC 확인).
- 같은 서버의 다른 프로그램에 영향이 없다.

---

## 검증 시나리오

| 시나리오 | 기대 결과 |
|---|---|
| 기존 환자 열기·저장, 로그인·로그아웃 | 7.1.4와 같다 |
| 설치본(7.1.4 셸)으로 접속 | 인증서 오류 없이 접속, EMR 연동 정상 |
| 서버에서 `http://127.0.0.1:3001/health` | 200 |
| 다른 PC에서 `<서버 IP>:3001` | 접속 거부 |
| 관리자 콘솔 감사 로그의 IP | **아직 모두 같은 값(정상)** — 실제 IP 기록은 다음 단계에서 바뀐다 |

> **사전 검증한 것**: 개발 PC에서 7.1.4 이미지 + 7.1.5 compose로 검증 스택을 띄워 루프백 `/health` 200·LAN 주소 거부·8443 200·재실행·이전 패키지로 롤백(게시 소멸)을 확인. 운영과 같은 Compose v2.22.0 공식 바이너리로 설정 해석(기본·포트 변경·비루프백 주입 중단·옛 `DEV_PORT` 무시)을 확인. 점검 스크립트를 Windows PowerShell 5.1로 정상·오류 경우 모두 실행. **하지 못한 것**: 운영 서버의 Docker Desktop(구버전)에서의 실제 기동, 운영 `docker info`의 OperatingSystem 값, 실제 다른 PC에서의 접속 거부 확인(개발 PC는 자기 LAN 주소로만 확인).

---

## 롤백 절차

### 1) 앱 이미지·compose 되돌리기

7.1.4 패키지 폴더의 compose는 앱을 게시하지 않으므로, 그 폴더에서 기동하면 원래 상태가 된다(아직 호스트 Caddy를 쓰지 않으므로 안전하다).

```powershell
# .env.production: WR_VERSION=7.1.5 → 7.1.4   (WR_APP_PORT 줄은 남겨 둬도 7.1.4 compose가 무시한다)
cd C:\wr\wr-evaluation-unified-7.1.4-intranet
docker images | Select-String "wr-app-server:7.1.4"      # 없으면 그 폴더에서 .\scripts\import-images.ps1
docker compose -p wr-prod --env-file <env경로> -f docker-compose.yml -f docker-compose.prod.yml --profile backup up -d
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}} {{.Ports}}"      # → wr-app-server:7.1.4 3001/tcp (호스트 게시 없음)
```

- 스키마 변경이 없어 DB는 그대로 둔다.
- 셸은 바꾸지 않았으므로 PC 쪽 작업은 없다. 7.1.4 폴더의 `updates/`는 그대로 남아 있다.

### 2) DB 복원

이번 릴리스는 DB를 바꾸지 않으므로 필요하지 않다. 다른 이유로 필요하면 [BACKUP_RESTORE.md](BACKUP_RESTORE.md)를 따른다.

---

## 알려진 함정·한계

### `up -d` 했는데 앱이 기동하지 않음 (포트 사용 중 오류 — "port is already allocated" / "ports are not available")
**원인**: 3001(또는 `WR_APP_PORT`)을 다른 프로그램이 쓰고 있다. 사전 점검을 건너뛰었거나 점검 뒤에 다른 프로그램이 포트를 잡았다. **해결**: `.env.production`에 비어 있는 번호로 `WR_APP_PORT`를 적고 점검 → `up -d`를 다시 실행한다. 급하면 롤백 절차 1)로 7.1.4로 되돌린다.

### 다른 PC에서 3001에 접속된다
**원인**: 있어서는 안 되는 상태다(compose 파일이 바뀌었거나 다른 프로그램이 3001을 전 주소로 연다). **해결**: 즉시 롤백 절차 1)을 실행하고 `docker ps`의 Ports와 `Get-NetTCPConnection -LocalPort 3001`로 리스너 주인을 확인한다.

### 셸 환경변수가 env 파일을 덮어씀
**원인**: Compose는 셸에 설정된 변수를 `--env-file`보다 우선한다. `WR_APP_PORT`·`WR_CADDY_HTTPS_BIND`·`WR_CADDY_HTTP_BIND`를 셸에 설정한 창에서 `up -d`하면 env 파일과 다른 구성이 된다. **해결**: 새 PowerShell 창에서 실행한다. 점검 스크립트가 이 경우를 거부한다.

### `updates/`가 비어 신규 PC 설치·자동 업데이트가 안 됨
**원인**: 서버 전용 패키지라 `updates/`가 비어 있고, compose의 `./updates`는 새 폴더 기준이다. **해결**: 7.1.4 폴더의 `updates/`를 통째로 옮긴다(업데이트 절차 A 2번).

### 감사 로그 IP가 여전히 모두 같다
**원인**: 정상이다. 이번 릴리스는 준비 단계이고, 실제 IP 기록은 다음 단계(Windows 호스트 Caddy)에서 바뀐다.

---

## 참고

- 변경 이력: [README.md](../README.md) 변경 이력 v7.1.5, [PRD.md](PRD.md) v7.1.5
- 앱 포트 점검 기준: [PRODUCTION_RELEASE_PLAN.md](PRODUCTION_RELEASE_PLAN.md) "app 포트 노출 확인", CA 키 백업 7-1
- 이전 단계: [UPDATE_7.1.4.md](UPDATE_7.1.4.md)(7.1.3 → 7.1.4, 셸 교체·배포 전 점검 포함)
