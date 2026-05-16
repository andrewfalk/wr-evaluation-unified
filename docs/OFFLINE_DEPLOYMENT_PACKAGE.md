# 오프라인 배포 패키지 명세 및 설치 가이드

인터넷이 차단된 병원 인트라넷 환경에서 `wr-evaluation-unified v5.0.0`을 설치하기 위한
자급 패키지 명세와 단계별 설치 절차입니다.

> **이 문서를 보고 있다면**: 패키지 압축 파일(`wr-evaluation-unified-5.0.0-intranet.zip`)을
> 이미 수령한 상태입니다. 이 문서 하나만 따라가면 서버 기동부터 클라이언트 PC 설정까지
> 완료할 수 있도록 작성되었습니다.

---

## 목차

1. [패키지 구조](#1-패키지-구조)
2. [포함 항목 / 제외 항목](#2-포함-항목--제외-항목)
3. [사전 준비 — 서버 PC](#3-사전-준비--서버-pc)
4. [설치 절차 — Windows 서버 (권장)](#4-설치-절차--windows-서버-권장)
5. [설치 절차 — Linux 서버](#5-설치-절차--linux-서버)
6. [서비스 초기화 (공통)](#6-서비스-초기화-공통)
7. [클라이언트 PC 설정 — Electron 앱 설치](#7-클라이언트-pc-설정--electron-앱-설치)
8. [클라이언트 PC 설정 — 인증서 신뢰 등록](#8-클라이언트-pc-설정--인증서-신뢰-등록)
9. [백업 설정](#9-백업-설정)
10. [패키지 무결성 검증](#10-패키지-무결성-검증)
11. [release-manifest.json 명세](#11-release-manifestjson-명세)
12. [트러블슈팅](#12-트러블슈팅)

---

## 1. 패키지 구조

```
wr-evaluation-unified-5.0.0-intranet/    ← 이 디렉터리가 compose 실행 루트
│
│  ── compose 파일 ──────────────────────────────────────────────────────────
├── docker-compose.yml                   # 기본 compose 정의
├── docker-compose.prod.yml              # 프로덕션 오버레이 (포트 미노출, HTTPS)
├── .env.production.example              # 환경변수 템플릿 (비밀값 없음)
│
│  ── compose가 참조하는 설정 파일 ───────────────────────────────────────────
├── caddy/
│   └── Caddyfile                        # HTTPS 리버스 프록시 설정
│
├── scripts/
│   ├── backup.sh                        # 백업 실행 스크립트
│   ├── restore.sh                       # DB 복구 스크립트
│   ├── audit-partition.sh               # 감사 로그 파티셔닝
│   ├── backup-crontab                   # 백업 cron 스케줄
│   ├── partition-crontab                # 파티션 cron 스케줄
│   ├── import-images.ps1                # Windows: Docker 이미지 로드
│   ├── import-images.sh                 # Linux: Docker 이미지 로드
│   └── install-prod.ps1                 # Windows: 설치 자동화 스크립트
│
│  ── Docker 이미지 ──────────────────────────────────────────────────────────
├── images/
│   └── wr-images.tar                    # app + backup-monitor + backup 이미지
│                                        # (postgres:16-alpine, caddy:2-alpine 포함 여부는
│                                        #  release-manifest.json의 baseImages 확인)
│
│  ── 문서 ───────────────────────────────────────────────────────────────────
├── docs/
│   ├── OFFLINE_DEPLOYMENT_PACKAGE.md    # 이 문서
│   ├── INTRANET_DEPLOYMENT.md           # 인증서/HTTPS 상세
│   ├── BACKUP_RESTORE.md                # 백업·복구 상세
│   ├── OPERATIONS_RUNBOOK.md            # 운영 런북
│   └── PRODUCTION_RELEASE_PLAN.md       # 릴리즈 절차서
│
│  ── Electron 클라이언트 설치 파일 ─────────────────────────────────────────
├── electron/
│   └── 직업성 질환 통합 평가 프로그램 Setup 5.0.0.exe
│
├── SHA256SUMS                           # 전체 파일 SHA256 해시 (무결성 검증용)
└── release-manifest.json                # 버전, git commit, 이미지 목록, 빌드 시각
```

---

## 2. 포함 항목 / 제외 항목

### 포함

| 항목 | 이유 |
|---|---|
| `images/wr-images.tar` | air-gapped 환경에서 docker pull 불가 |
| `docker-compose.yml`, `docker-compose.prod.yml` | 서비스 정의 |
| `caddy/Caddyfile` | HTTPS 설정 |
| `.env.production.example` | 운영자가 채울 비밀값 템플릿 |
| `scripts/*.sh`, `scripts/*.ps1` | 운영 자동화 |
| `docs/*.md` | 설치·운영 지침 |
| `electron/*.exe` | 클라이언트 앱 설치 파일 |
| `SHA256SUMS`, `release-manifest.json` | 무결성 검증 |

### 절대 포함 금지

| 항목 | 이유 |
|---|---|
| `.env.production` (실제 비밀값) | ACCESS_TOKEN_SECRET 등 민감 정보 |
| DB dump / volume 스냅샷 | 환자 개인건강정보(PHI) |
| GPG 개인키 (`*-private.asc`) | 복구 키 — USB 등 오프라인 매체 별도 보관 |
| `node_modules/`, `dist/` | 불필요한 크기 증가 |
| `.git/` | 내부 개발 정보 |

---

## 3. 사전 준비 — 서버 PC

### 3-1. 필수 소프트웨어

| 소프트웨어 | 최소 버전 | 확인 방법 |
|---|---|---|
| Docker Engine | 24.0 이상 | `docker --version` |
| Docker Compose | v2.17 이상 | `docker compose version` |
| PowerShell | 5.1 이상 (Windows) | `$PSVersionTable.PSVersion` |

> Docker Desktop(Windows)을 설치하면 Docker Engine + Compose가 함께 설치됩니다.

> **PowerShell 버전**: Windows 10 / 11 / Server 2019 이상에는 PowerShell 5.1이 기본 내장되어 있습니다. 별도 설치가 필요 없습니다.

### 3-2. PowerShell 스크립트 실행 정책 설정 (Windows 10/11 필수)

Windows는 기본적으로 `.ps1` 스크립트 실행을 차단합니다.
설치 스크립트(`install-prod.ps1`, `import-images.ps1`)를 실행하기 전에 **반드시** 아래 명령을 먼저 실행해야 합니다.

**PowerShell을 관리자 권한으로 열고:**

```powershell
# 현재 실행 정책 확인
Get-ExecutionPolicy

# Restricted (기본값) 이면 아래 명령으로 변경
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
# 확인 메시지가 나오면 Y 입력
```

변경 후 확인:

```powershell
Get-ExecutionPolicy -Scope CurrentUser
# RemoteSigned 가 출력되면 정상
```

> **실행 정책이란?** 악성 스크립트로부터 시스템을 보호하기 위한 Windows 보안 설정입니다.
> `RemoteSigned`는 로컬 스크립트는 허용하고 인터넷에서 내려받은 스크립트는 서명 요구합니다.
> 설치 완료 후 원래 값(`Restricted`)으로 되돌리려면:
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser Restricted
> ```

> **"이 시스템에서 스크립트를 실행할 수 없습니다"** 오류가 발생하면 위 절차를 먼저 수행한 것인지 확인하세요.

### 3-2. 네트워크 설정

병원 내 **모든 클라이언트 PC**에서 서버 도메인이 해석되어야 합니다.

**방법 A — 병원 DNS 서버에 A 레코드 추가 (권장)**

```
wr.hospital.local  →  서버 IP (예: 192.168.1.100)
```

**방법 B — 각 클라이언트 PC의 hosts 파일 편집 (소규모 환경)**

Windows: 메모장을 **관리자 권한**으로 열고 아래 파일 편집:
```
C:\Windows\System32\drivers\etc\hosts
```
맨 아래에 추가:
```
192.168.1.100   wr.hospital.local
```

### 3-3. 방화벽

서버에서 다음 포트 인바운드 허용 (클라이언트 망 → 서버):

| 포트 | 프로토콜 | 용도 |
|---|---|---|
| 80 | TCP | HTTP (HTTPS 리다이렉트용) |
| 443 | TCP | HTTPS (Electron 앱 + 브라우저) |

서버 PC에서 PowerShell을 관리자 권한으로 실행 (시작 메뉴 → PowerShell 우클릭 → "관리자 권한으로 실행")
아래 두 줄 실행:

netsh advfirewall firewall add rule name="WR-HTTP" dir=in action=allow protocol=TCP localport=80
netsh advfirewall firewall add rule name="WR-HTTPS" dir=in action=allow protocol=TCP localport=443
완료되면 확인 메시지가 뜹니다. 이후 클라이언트 PC에서 브라우저로 http://서버IP 접속해서 연결되는지 테스트해보면 됩니다.

서버 PC에서 ipconfig 실행하면 됩니다.

IPv4 주소: 192.168.x.x  ← 이게 서버 IP
단, 서버 IP가 DHCP로 자동 할당되면 재부팅 시 바뀔 수 있으니 고정 IP(Static IP)로 설정해두는 게 좋습니다. 안 그러면 클라이언트 PC들이 접속 못하게 됩니다.

고정 IP 설정은 네트워크 설정 → 어댑터 속성 → IPv4 → 수동 입력으로 하면 됩니다.

> 앱 서버 포트(3001)는 외부에 노출되지 않습니다. Caddy가 443→3001 프록시 역할을 합니다.

---

## 4. 설치 절차 — Windows 서버 (권장)

### 4-1. 패키지 압축 해제

```powershell
# 패키지를 C:\wr\ 아래에 설치하는 예시
Expand-Archive wr-evaluation-unified-5.0.0-intranet.zip -DestinationPath C:\wr\

# 패키지 루트로 이동 (이후 모든 명령은 이 디렉터리에서 실행)
Set-Location C:\wr\wr-evaluation-unified-5.0.0-intranet
```

### 4-2. 무결성 검증

```powershell
# SHA256SUMS의 각 파일을 실제 해시와 비교
$errors = 0
Get-Content SHA256SUMS | ForEach-Object {
    $parts = $_ -split '\s+', 2
    $expectedHash = $parts[0]
    $filePath     = $parts[1] -replace '/', '\'
    if (-not (Test-Path $filePath)) {
        Write-Warning "MISSING: $filePath"
        $errors++
        return
    }
    $actual = (Get-FileHash $filePath -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expectedHash) {
        Write-Warning "MISMATCH: $filePath"
        $errors++
    }
}
if ($errors -eq 0) { Write-Host "모든 파일 검증 PASS" -ForegroundColor Green }
else               { Write-Host "$errors 개 파일 검증 실패 — 패키지를 재수령하세요." -ForegroundColor Red }
```

### 4-3. 환경변수 파일 작성

```powershell
# 템플릿 복사
Copy-Item .env.production.example .env.production
```

메모장으로 `.env.production`을 열어 아래 값을 **반드시** 모두 채웁니다:

```
notepad .env.production
```

| 변수 | 설명 | 생성 방법 |
|---|---|---|
| `ACCESS_TOKEN_SECRET` | JWT 서명 키 (32바이트 hex) | 아래 명령 참조 |
| `REFRESH_TOKEN_SECRET` | Refresh JWT 키 (32바이트 hex) | 아래 명령 참조 |
| `POSTGRES_PASSWORD` | DB 비밀번호 (32바이트 hex 권장) | 아래 명령 참조 |
| `AUDIT_DB_PASSWORD` | 감사 로그 읽기 전용 계정 비밀번호 | 직접 설정 |
| `WR_DOMAIN` | 서버 도메인 (예: `wr.hospital.local`) | 직접 설정 |
| `CORS_ORIGINS` | 허용 origin (예: `https://wr.hospital.local`) | 직접 설정 |
| `BACKUP_GPG_RECIPIENT` | GPG 공개키 fingerprint | 9절 참조 |
| `WR_VERSION` | 이미지 태그 | `5.0.0` 고정 |

**랜덤 시크릿 생성 (PowerShell):**

```powershell
# ACCESS_TOKEN_SECRET
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })

# REFRESH_TOKEN_SECRET (한 번 더 실행)
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })

# POSTGRES_PASSWORD
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

> 세 값을 **모두 다르게** 설정하세요. 같은 값을 사용하면 보안이 취약해집니다.

### 4-4. Docker 이미지 로드

```powershell
.\scripts\import-images.ps1
```

완료 후 이미지가 로드되었는지 확인:

```powershell
docker images | Select-String "wr-"
# wr-app-server        5.0.0   ...
# wr-backup-monitor    5.0.0   ...
# wr-backup            5.0.0   ...
```

### 4-5. 자동 설치 스크립트 실행

```powershell
.\scripts\install-prod.ps1
```

스크립트가 자동으로 다음을 수행합니다:
1. Docker 데몬 및 Compose 버전 확인
2. `.env.production` 유효성 검사 (빈 값, changeme 플레이스홀더 감지)
3. Compose config 검증
4. 기존 volume 상태 확인
5. `docker compose up -d` 실행

> **실행 전 확인**: PowerShell 실행 정책이 `RemoteSigned`이어야 합니다. 아직 설정하지 않았다면 3-2절을 먼저 수행하세요.

### 4-6. 서비스 상태 확인

```powershell
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production -p wr-prod ps
```

모든 서비스가 `healthy` 또는 `running` 상태인지 확인합니다:

```
NAME                        STATUS
wr-prod-app-1               healthy
wr-prod-caddy-1             healthy
wr-prod-postgres-1          healthy
wr-prod-backup-monitor-1    running
```

> Caddy가 처음 기동될 때 내부 CA를 생성하고 인증서를 발급합니다. 약 10~30초 소요됩니다.
> 이 시간 동안 `https://wr.hospital.local` 접속이 안 될 수 있습니다 — 잠시 기다리세요.

---

## 5. 설치 절차 — Linux 서버

### 5-1. 패키지 전송 및 압축 해제

```bash
# 패키지를 서버로 전송 (USB에서 복사하거나 scp 사용)
scp wr-evaluation-unified-5.0.0-intranet.zip admin@192.168.1.100:/opt/wr/

# 서버 접속
ssh admin@192.168.1.100

# 압축 해제
cd /opt/wr
unzip wr-evaluation-unified-5.0.0-intranet.zip

# 패키지 루트로 이동 (이후 모든 명령은 이 디렉터리에서 실행)
cd wr-evaluation-unified-5.0.0-intranet
```

### 5-2. 무결성 검증

```bash
sha256sum -c SHA256SUMS
# 모든 파일이 OK로 표시되어야 합니다.
# FAILED가 있으면 패키지를 재수령하세요.
```

### 5-3. 환경변수 파일 작성

```bash
cp .env.production.example .env.production
chmod 600 .env.production  # 소유자만 읽기/쓰기
nano .env.production        # 또는 vi .env.production
```

| 변수 | 설명 | 생성 방법 |
|---|---|---|
| `ACCESS_TOKEN_SECRET` | JWT 서명 키 | `openssl rand -hex 32` |
| `REFRESH_TOKEN_SECRET` | Refresh JWT 키 | `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | DB 비밀번호 | `openssl rand -hex 32` |
| `AUDIT_DB_PASSWORD` | 감사 로그 읽기 전용 계정 비밀번호 | 직접 설정 |
| `WR_DOMAIN` | 서버 도메인 (예: `wr.hospital.local`) | 직접 설정 |
| `CORS_ORIGINS` | 허용 origin (예: `https://wr.hospital.local`) | 직접 설정 |
| `BACKUP_GPG_RECIPIENT` | GPG 공개키 fingerprint | 9절 참조 |
| `WR_VERSION` | 이미지 태그 | `5.0.0` 고정 |

```bash
# 랜덤 시크릿 생성 예시
openssl rand -hex 32   # ACCESS_TOKEN_SECRET용
openssl rand -hex 32   # REFRESH_TOKEN_SECRET용 (다시 실행)
openssl rand -hex 32   # POSTGRES_PASSWORD용 (다시 실행)
```

### 5-4. Docker 이미지 로드

```bash
bash scripts/import-images.sh

# 확인
docker images | grep wr-
# wr-app-server        5.0.0   ...
# wr-backup-monitor    5.0.0   ...
# wr-backup            5.0.0   ...
```

### 5-5. 서비스 기동

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file .env.production \
  -p wr-prod \
  up -d
```

### 5-6. 서비스 상태 확인

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production -p wr-prod ps
```

모든 서비스가 `healthy` 또는 `running` 상태인지 확인합니다.

---

## 6. 서비스 초기화 (공통)

서비스가 기동된 후 아래 초기화 작업을 **최초 1회** 수행합니다.
이후 업그레이드 시에는 불필요합니다.

> 이하 명령에서 `$compose`는 다음 문자열의 축약입니다:
> ```
> docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production -p wr-prod
> ```

### 6-1. 감사 로그 DB 계정 비밀번호 동기화

migration이 기본 비밀번호로 `wr_audit_reader` 계정을 생성합니다.
`.env.production`의 `AUDIT_DB_PASSWORD` 값과 일치시켜야 합니다.

**Windows:**
```powershell
$auditPw = (Get-Content .env.production | Where-Object { $_ -match '^AUDIT_DB_PASSWORD=' }) -replace '^AUDIT_DB_PASSWORD=',''
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production -p wr-prod `
  exec postgres psql -U wr_user -d wr_evaluation `
  -c "ALTER ROLE wr_audit_reader PASSWORD '$auditPw';"
```

**Linux:**
```bash
AUDIT_PW=$(grep '^AUDIT_DB_PASSWORD=' .env.production | cut -d= -f2)
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production -p wr-prod \
  exec postgres psql -U wr_user -d wr_evaluation \
  -c "ALTER ROLE wr_audit_reader PASSWORD '${AUDIT_PW}';"
```

### 6-2. 관리자 계정 초기 생성

```bash
# 비밀번호 정책: 최소 10자, 영문+숫자+특수문자 포함
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production -p wr-prod \
  exec -it app node dist/cli/seedAdmin.js
```

화면의 안내에 따라 입력합니다:
- 병원/기관명
- 로그인 ID (예: `wradmin`)
- 비밀번호 (최초 로그인 후 변경 필요)
- 표시 이름 (예: `시스템 관리자`)

> **비밀번호 예시**: `Admin@2026!!` (10자 이상, 영문+숫자+특수문자)

생성 완료 후 즉시 `https://wr.hospital.local`에 접속하여 비밀번호를 변경합니다.

### 6-3. 관리자 계정 첫 로그인 확인

브라우저에서:
1. `https://wr.hospital.local` 접속
2. 생성한 ID/비밀번호로 로그인
3. 비밀번호 변경 화면이 표시되면 새 비밀번호 설정
4. 관리자 콘솔 → 사용자 관리에서 의료진 계정 생성

### 6-4. 일반 사용자(의료진) 계정 생성

관리자 콘솔 → 사용자 관리 → 사용자 추가:
- 역할: `doctor` / `nurse` / `staff` 중 선택
- 로그인 ID, 비밀번호, 이름 입력

---

## 7. 클라이언트 PC 설정 — Electron 앱 설치

Electron 앱을 사용하는 **모든 클라이언트 PC**에서 아래 절차를 수행합니다.

### 7-1. 설치 파일 복사

패키지의 `electron/` 디렉터리에서 설치 파일을 클라이언트 PC로 복사합니다:
```
직업성 질환 통합 평가 프로그램 Setup 5.0.0.exe
```

USB, 공유 폴더 등 사용 가능한 방법으로 복사하세요.

### 7-2. 설치

1. `직업성 질환 통합 평가 프로그램 Setup 5.0.0.exe` 더블클릭
2. "Windows가 PC를 보호했습니다" 창이 뜨면 → **추가 정보** 클릭 → **실행** 클릭
3. 설치 완료

### 7-3. 앱 최초 실행 및 서버 연결 설정

1. 앱 실행
2. 로그인 화면에서 **서버 주소 설정** 또는 **설정** 메뉴 진입
3. 서버 URL 입력: `https://wr.hospital.local`
4. 연결 확인

> 서버 인증서가 신뢰되지 않으면 연결이 거부됩니다. **반드시 8절 인증서 설치를 먼저 완료**하세요.

### 7-4. Device 등록

Electron 앱은 처음 로그인 시 자동으로 **device 등록 요청**을 서버에 전송합니다.
관리자가 콘솔에서 승인하기 전까지는 앱 사용은 가능하지만 EMR 연동 기능은 비활성화됩니다.

**관리자 승인 절차:**
1. `https://wr.hospital.local` → 관리자 콘솔 로그인
2. **기기 관리** 탭 → 대기 중인 기기 목록 확인
3. 해당 기기 **승인** 클릭

승인 후 약 5분 이내에 Electron 앱이 자동으로 활성 상태를 인식합니다.
(앱을 재시작하면 즉시 반영됩니다.)

---

## 8. 클라이언트 PC 설정 — 인증서 신뢰 등록

이 서버는 Caddy가 자동 생성한 **내부 CA 인증서**를 사용합니다.
브라우저와 Electron 앱이 이 인증서를 신뢰하도록 각 클라이언트 PC에 CA 인증서를 설치해야 합니다.

> **왜 필요한가?** Let's Encrypt 등 공인 CA는 인터넷 접속이 필요합니다. 인트라넷 환경에서는
> 서버가 직접 내부 CA 역할을 하므로, 클라이언트에게 "이 CA를 신뢰하라"고 한 번 알려줘야 합니다.

### 8-1. 서버에서 CA 인증서 추출

**서버에서 실행** (Windows):
```powershell
docker exec wr-prod-caddy-1 cat /data/caddy/pki/authorities/local/root.crt > caddy-root.crt
```

**서버에서 실행** (Linux):
```bash
docker exec wr-prod-caddy-1 cat /data/caddy/pki/authorities/local/root.crt > caddy-root.crt
```

생성된 `caddy-root.crt` 파일을 USB 등으로 모든 클라이언트 PC에 배포합니다.

### 8-2. 클라이언트 PC에 CA 인증서 설치

클라이언트 PC(Windows)에서 다음 중 한 가지 방법으로 설치합니다.

**방법 A — GUI (비기술 사용자 권장)**

1. `caddy-root.crt` 파일을 더블클릭
2. **인증서 설치** 클릭
3. 저장소 위치: **로컬 컴퓨터** 선택 → **다음**
   - "로컬 컴퓨터"가 보이지 않으면 관리자 권한으로 다시 시도
4. **모든 인증서를 다음 저장소에 저장** 선택 → **찾아보기**
5. **신뢰할 수 있는 루트 인증 기관** 선택 → **확인** → **다음** → **마침**
6. 보안 경고 창 → **예** 클릭

**방법 B — PowerShell (관리자 권한 필요)**

```powershell
# PowerShell을 관리자 권한으로 실행 후:
Import-Certificate -FilePath ".\caddy-root.crt" -CertStoreLocation Cert:\LocalMachine\Root
```

**방법 C — certutil (비관리자 계정, 현재 사용자에만 적용)**

```cmd
certutil -addstore -user Root caddy-root.crt
```

### 8-3. 설치 확인

```powershell
Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like "*Caddy*" -or $_.Issuer -like "*local*" }
```

출력에 Caddy 관련 인증서가 표시되면 성공입니다.

이후 Chrome, Edge, Electron 앱에서 `https://wr.hospital.local` 접속 시 **인증서 경고 없이** 접속됩니다.

> **Firefox 사용 시**: Firefox는 Windows 신뢰 저장소를 사용하지 않습니다.
> Firefox 설정 → 개인 정보 및 보안 → 인증서 보기 → 가져오기에서 `caddy-root.crt`를 별도로 설치하세요.

---

## 9. 백업 설정

백업은 **GPG 공개키로 암호화**되어 저장됩니다. 사전에 복구 전용 GPG 키페어를 준비해야 합니다.

> **복구 전용 키**: passphrase 없이 생성된 전용 키페어를 사용합니다.
> 기존 개인키에 passphrase가 있으면 비대화형 자동 복구가 불가능합니다.

### 9-1. 복구 전용 GPG 키페어 생성 (개발 PC 또는 별도 PC에서 1회)

패키지를 생성한 PC에 GPG가 설치되어 있어야 합니다. (Gpg4win 설치 권장)

```powershell
# 키 생성 파라미터 파일 작성
$keyParams = "%echo Generating WR restore-only key`r`nKey-Type: RSA`r`nKey-Length: 4096`r`nSubkey-Type: RSA`r`nSubkey-Length: 4096`r`nName-Real: WR Restore Key`r`nName-Comment: restore-only no-passphrase`r`nName-Email: wr-restore@hospital.local`r`nExpire-Date: 2y`r`n%no-protection`r`n%commit`r`n%echo Done`r`n"
[System.IO.File]::WriteAllText("$env:TEMP\wr-keygen.txt", $keyParams, [System.Text.Encoding]::ASCII)

# 키 생성
gpg --batch --gen-key "$env:TEMP\wr-keygen.txt"

# fingerprint 확인 (BACKUP_GPG_RECIPIENT에 사용)
gpg --fingerprint wr-restore@hospital.local
```

```powershell
# 공개키 export (서버에 등록할 파일)
gpg --armor --export wr-restore@hospital.local > wr-backup-restore-public.asc

# 개인키 export (USB에 보관, 절대 서버에 저장 금지)
gpg --armor --export-secret-keys wr-restore@hospital.local > wr-backup-restore-private.asc
```

> **개인키(`wr-backup-restore-private.asc`) 보관 원칙**
> - 암호화된 USB 드라이브에 저장
> - 서버나 네트워크 공유 폴더에 절대 저장 금지
> - 분실 시 기존 백업 복구 불가 → 사본을 안전한 장소에 2개 이상 보관

### 9-2. .env.production에 fingerprint 설정

`gpg --fingerprint` 출력에서 fingerprint를 복사하여 `.env.production`에 입력합니다:

```
BACKUP_GPG_RECIPIENT=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

fingerprint는 공백 없이 40자리 hex입니다. (예: `44173BF9F4620B7C8A52497557B64C0AE415FC28`)

### 9-3. 서버에 GPG 공개키 등록

**Windows:**
```powershell
Get-Content wr-backup-restore-public.asc | docker run --rm -i `
  -v wr-prod_backup_gnupg:/root/.gnupg alpine `
  sh -c "apk add --no-cache gnupg -q && gpg --batch --import"
```

**Linux:**
```bash
cat wr-backup-restore-public.asc | docker run --rm -i \
  -v wr-prod_backup_gnupg:/root/.gnupg alpine \
  sh -c "apk add --no-cache gnupg -q && gpg --batch --import"
```

### 9-4. 백업 서비스 활성화

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production -p wr-prod \
  --profile backup up -d
```

### 9-5. 백업 수동 실행 (동작 확인)

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production -p wr-prod \
  --profile backup run --rm backup sh /scripts/backup.sh
```

출력에 `Status: success`가 표시되면 백업이 정상 동작합니다.

자동 백업은 **매일 새벽 2시** (서버 로컬 시간 기준)에 실행됩니다.

---

## 10. 패키지 무결성 검증

패키지 수령 시 또는 설치 전에 반드시 확인합니다.

### Windows (PowerShell)

```powershell
$errors = 0
Get-Content SHA256SUMS | ForEach-Object {
    $parts = $_ -split '\s+', 2
    $expectedHash = $parts[0]
    $filePath     = $parts[1] -replace '/', '\'
    if (-not (Test-Path $filePath)) {
        Write-Warning "MISSING: $filePath"; $errors++; return
    }
    $actual = (Get-FileHash $filePath -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expectedHash) {
        Write-Warning "MISMATCH: $filePath"; $errors++
    }
}
if ($errors -eq 0) { Write-Host "모든 파일 검증 PASS" -ForegroundColor Green }
else               { Write-Host "$errors 개 검증 실패" -ForegroundColor Red }
```

### Linux

```bash
sha256sum -c SHA256SUMS
```

### 추가 확인 항목

```powershell
# release-manifest.json에서 버전 확인
Get-Content release-manifest.json | ConvertFrom-Json | Select-Object version, gitCommit, buildTime
```

- `version`: `5.0.0`이어야 함
- `electronInstaller.included`: `true`이어야 함

---

## 11. release-manifest.json 명세

```json
{
  "version": "5.0.0",
  "gitCommit": "abc1234...",
  "gitBranch": "main",
  "buildTime": "2026-05-16T00:00:00Z",
  "builderHost": "build-server-01",
  "images": [
    { "name": "wr-app-server",     "tag": "5.0.0", "imageId": "sha256:..." },
    { "name": "wr-backup-monitor", "tag": "5.0.0", "imageId": "sha256:..." },
    { "name": "wr-backup",         "tag": "5.0.0", "imageId": "sha256:..." }
  ],
  "baseImages": ["postgres:16-alpine", "caddy:2-alpine"],
  "electronInstaller": {
    "included": true,
    "fileName": "직업성 질환 통합 평가 프로그램 Setup 5.0.0.exe"
  },
  "checksum": "SHA256SUMS"
}
```

| 필드 | 설명 |
|---|---|
| `version` | 패키지 버전 (semver) |
| `gitCommit` | 빌드 기준 commit SHA |
| `buildTime` | ISO 8601 빌드 시각 (UTC) |
| `images[].imageId` | `sha256:...` 전체 image ID |
| `electronInstaller.included` | Electron 설치 파일 포함 여부 |

---

## 12. 트러블슈팅

### 서버 시작 후 `https://wr.hospital.local` 접속 불가

**증상**: 브라우저에서 "연결할 수 없음" 또는 timeout

1. 서비스 상태 확인:
   ```powershell
   docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production -p wr-prod ps
   ```
   모든 서비스가 `healthy`인지 확인. 아직 `starting`이면 30초 기다린 후 재확인.

2. Caddy 로그 확인:
   ```powershell
   docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production -p wr-prod logs caddy --tail=50
   ```

3. DNS/hosts 설정 확인:
   ```powershell
   nslookup wr.hospital.local
   # 또는
   ping wr.hospital.local
   ```
   서버 IP가 출력되어야 합니다.

---

### 브라우저에서 "인증서 오류" 또는 "연결이 비공개로 설정되어 있지 않음"

**원인**: Caddy 내부 CA 인증서가 클라이언트 PC에 설치되지 않음

**해결**: 8절 절차에 따라 `caddy-root.crt`를 설치합니다.

설치 후에도 오류가 지속되면:
- 브라우저를 **완전히 종료** 후 재실행
- Chrome: `chrome://restart` 주소로 이동하여 재시작

---

### Electron 앱에서 서버 연결 실패

1. 브라우저에서 `https://wr.hospital.local` 접속이 되는지 먼저 확인
2. 인증서가 설치되어 있는지 확인 (8절)
3. 앱 설정에서 서버 URL이 `https://wr.hospital.local`인지 확인 (`http://`가 아닌 `https://`)

---

### `docker compose up` 실패 — `.env.production` 관련 오류

```
invalid interpolation format
```

**원인**: 환경변수 값에 `$` 문자가 포함된 경우 Docker Compose가 변수 치환으로 해석

**해결**: 비밀번호에 `$` 문자를 사용하지 않거나, `$$`로 이스케이프합니다.

---

### `docker load` 실패 — 이미지 파일 손상

```
invalid argument "images/wr-images.tar": no such file or directory
```

1. `images/` 디렉터리에 `wr-images.tar`가 존재하는지 확인
2. SHA256SUMS로 파일 무결성 검증 (10절)
3. 파일이 손상된 경우 패키지를 재수령하여 처음부터 다시 설치

---

### 감사 로그 조회 오류 (관리자 콘솔)

**원인**: `wr_audit_reader` DB 계정 비밀번호가 `.env.production`의 `AUDIT_DB_PASSWORD`와 불일치

**해결**: 6-1절의 `ALTER ROLE` 명령을 다시 실행합니다.

---

### 백업 상태 "FAILED (gpg_encrypt_failed)"

**원인**: GPG 공개키가 등록되지 않았거나 fingerprint가 불일치

1. fingerprint 확인:
   ```powershell
   docker run --rm -v wr-prod_backup_gnupg:/root/.gnupg alpine sh -c "apk add gnupg -q && gpg --list-keys"
   ```
2. `.env.production`의 `BACKUP_GPG_RECIPIENT` 값과 일치하는지 확인
3. 불일치 시 9-2, 9-3절 재수행

---

### "이 시스템에서 스크립트를 실행할 수 없습니다" (PowerShell)

**원인**: Windows 기본 실행 정책(`Restricted`)이 `.ps1` 실행을 차단

**해결**: 3-2절의 실행 정책 변경 명령을 먼저 수행합니다.

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

확인 메시지에서 **Y** 를 입력한 후 다시 스크립트를 실행하세요.

---

### 도움이 필요한 경우

이 문서로 해결되지 않는 문제는 아래 문서를 추가로 참고하세요:

- `docs/INTRANET_DEPLOYMENT.md` — HTTPS/인증서 상세
- `docs/BACKUP_RESTORE.md` — 백업·복구 상세
- `docs/OPERATIONS_RUNBOOK.md` — 운영 중 발생하는 일반적인 문제
- `docs/PRODUCTION_RELEASE_PLAN.md` — 릴리즈 및 업그레이드 절차
