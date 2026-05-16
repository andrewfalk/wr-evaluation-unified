# 오프라인 배포 패키지 명세

인터넷이 차단된 병원 인트라넷 환경에서 `wr-evaluation-unified`를 설치하기 위한 자급 패키지 명세입니다.

---

## 목차

1. [패키지 구조](#1-패키지-구조)
2. [포함 항목 / 제외 항목](#2-포함-항목--제외-항목)
3. [패키지 생성 절차](#3-패키지-생성-절차)
4. [패키지 검증](#4-패키지-검증)
5. [설치 절차 (air-gapped 환경)](#5-설치-절차-air-gapped-환경)
6. [release-manifest.json 명세](#6-release-manifestjson-명세)

---

## 1. 패키지 구조

패키지 루트 디렉터리가 곧 `docker compose` 실행 디렉터리입니다.
Docker Compose는 볼륨 상대경로(예: `./caddy/Caddyfile`, `./scripts/backup.sh`)를
**compose 파일이 위치한 디렉터리** 기준으로 해석하므로, compose 파일과 참조 파일들이
모두 같은 루트에 있어야 합니다.

```
release/wr-evaluation-unified-{VERSION}-intranet/
│
│  # ── compose 실행 루트 ──────────────────────────────────────────────────
├── docker-compose.yml             # 기본 compose (repo 루트 파일과 동일)
├── docker-compose.prod.yml        # production override
├── .env.production.example        # 비밀값 제외 예시 (실제값 없음)
│
│  # ── compose가 참조하는 상대경로 파일들 ──────────────────────────────────
├── caddy/
│   └── Caddyfile                  # ./caddy/Caddyfile — Caddy reverse proxy 설정
│
├── scripts/
│   ├── backup.sh                  # ./scripts/backup.sh — 백업 실행
│   ├── restore.sh                 # ./scripts/restore.sh — 복구 실행
│   ├── audit-partition.sh         # ./scripts/audit-partition.sh
│   ├── backup-crontab             # ./scripts/backup-crontab
│   ├── partition-crontab          # ./scripts/partition-crontab
│   ├── import-images.ps1          # Windows: docker load 래퍼 (추가 제공)
│   ├── import-images.sh           # Linux: docker load 래퍼 (추가 제공)
│   └── install-prod.ps1           # Windows: 최초 설치 안내 (추가 제공)
│
│  # ── 오프라인 이미지 ──────────────────────────────────────────────────────
├── images/
│   └── wr-images.tar              # docker save: app + backup-monitor + backup
│                                  # postgres:16-alpine, caddy:2-alpine 포함 여부:
│                                  #   인터넷 가능 환경 → 제외 (공식 이미지 pull)
│                                  #   완전 air-gapped → 포함 필수
│
│  # ── 문서 ──────────────────────────────────────────────────────────────
├── docs/
│   ├── INTRANET_DEPLOYMENT.md
│   ├── BACKUP_RESTORE.md
│   ├── OPERATIONS_RUNBOOK.md
│   └── PRODUCTION_RELEASE_PLAN.md
│
│  # ── Electron 설치 파일 ──────────────────────────────────────────────────
├── electron/
│   └── 직업성 질환 통합 평가 프로그램 Setup {VERSION}.exe
│                                          # electron-builder 기본 파일명 (artifactName 미설정)
│                                          # 실제 파일명은 release-manifest.json의 electronInstaller.fileName 참조
│                                          # 미완성 시: PLACEHOLDER.txt만 포함
│
├── SHA256SUMS                     # 패키지 내 모든 파일의 SHA256 해시
└── release-manifest.json          # 버전, git commit, 이미지 목록, 빌드 시각
```

> **Electron 인트라넷 빌드 상태**: 인트라넷 Electron 빌드는 별도 작업으로 진행 중.
> 빌드 완료 전 패키지는 `electron/` 디렉터리에 `PLACEHOLDER.txt`만 포함됨.

---

## 2. 포함 항목 / 제외 항목

### ✅ 포함

| 항목 | 이유 |
|---|---|
| `images/wr-images.tar` | air-gapped 환경에서 docker pull 불가 |
| `compose/*.yml`, `config/Caddyfile` | 서비스 정의 |
| `.env.production.example` | 운영자가 채울 비밀값 template |
| `scripts/backup.sh`, `restore.sh` 등 | 운영 자동화 |
| `docs/*.md` | 설치/운영 지침 |
| `SHA256SUMS`, `release-manifest.json` | 무결성 검증 |

### ❌ 제외 (절대 포함 금지)

| 항목 | 이유 |
|---|---|
| `.env`, `.env.production` | 실제 secret 포함 |
| DB dump / volume snapshot | 환자 PHI (개인건강정보) |
| GPG private key | 복구 키 — 오프라인 매체 별도 보관 |
| `node_modules/`, `dist/` (빌드 중간 산출물) | 불필요한 크기 증가 |
| git history (`.git/`) | 내부 개발 정보 |
| CI/CD credentials | 인증 정보 |

---

## 3. 패키지 생성 절차

`scripts/export-offline-package.ps1` 실행 (Turn 2에서 구현):

```powershell
# 버전 지정 (package.json 기준 자동 감지 또는 수동 지정)
scripts\export-offline-package.ps1 -Version "4.2.1"

# 또는 git tag 기준 자동 감지
scripts\export-offline-package.ps1
```

**스크립트 처리 순서:**

1. Docker image build (app, backup-monitor, backup)
2. `docker save`로 `images/wr-images.tar` 생성
3. compose / config / scripts / docs 복사
4. Electron installer 복사 (없으면 PLACEHOLDER.txt 생성)
5. `SHA256SUMS` 생성 (`Get-FileHash -Algorithm SHA256`)
6. `release-manifest.json` 생성

**생성 결과 경로:**

```
release/wr-evaluation-unified-{VERSION}-intranet.zip
release/wr-evaluation-unified-{VERSION}-intranet/   (압축 해제본)
```

---

## 4. 패키지 검증

패키지 수신 측에서 설치 전 무결성을 확인:

```powershell
# SHA256 검증 (PowerShell)
$manifest = Get-Content release\wr-...\SHA256SUMS | ForEach-Object {
    $parts = $_ -split '\s+', 2
    @{ Hash = $parts[0]; File = $parts[1] }
}
$allOk = $true
foreach ($entry in $manifest) {
    $actual = (Get-FileHash "release\wr-...\$($entry.File)" -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $entry.Hash) {
        Write-Warning "MISMATCH: $($entry.File)"
        $allOk = $false
    }
}
if ($allOk) { Write-Host "모든 파일 검증 PASS" }
```

```bash
# Linux
cd release/wr-evaluation-unified-{VERSION}-intranet
sha256sum -c SHA256SUMS
```

**확인 기준:**
- 모든 파일 `OK`
- `.env`, DB dump, private key가 패키지에 없음
- `release-manifest.json`의 version이 설치 대상 버전과 일치

---

## 5. 설치 절차 (air-gapped 환경)

> 패키지 루트 디렉터리에서 모든 명령을 실행합니다.
> compose 파일과 참조 파일(`caddy/`, `scripts/`)이 모두 같은 루트에 있으므로
> 별도 파일 복사 없이 바로 실행 가능합니다.

### Linux 서버

```bash
# 1. 패키지 전송 (USB 또는 내부망 파일 서버)
scp wr-evaluation-unified-4.2.1-intranet.zip admin@server:/opt/wr/

# 2. 압축 해제 및 이동
cd /opt/wr
unzip wr-evaluation-unified-4.2.1-intranet.zip
cd wr-evaluation-unified-4.2.1-intranet   # ← 여기가 패키지 루트이자 compose 실행 디렉터리

# 3. SHA256 검증
sha256sum -c SHA256SUMS

# 4. Docker 이미지 로드
bash scripts/import-images.sh

# 5. 비밀값 준비 (파일 복사 없이 루트에 이미 있음)
cp .env.production.example .env.production
chmod 600 .env.production
# 편집기로 모든 빈 값을 채운다

# 6. 설치 (PRODUCTION_RELEASE_PLAN.md 3절 참조)
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file .env.production \
  -p wr-prod \
  up -d
```

### Windows 서버 (PowerShell)

```powershell
# 1. 압축 해제
Expand-Archive wr-evaluation-unified-4.2.1-intranet.zip -DestinationPath C:\wr\

# 2. 패키지 루트로 이동 (여기가 compose 실행 디렉터리)
Set-Location C:\wr\wr-evaluation-unified-4.2.1-intranet

# 3. Docker 이미지 로드
.\scripts\import-images.ps1

# 4. 비밀값 준비 (파일 복사 없이 루트에 이미 있음)
Copy-Item .env.production.example .env.production
# 메모장 등으로 편집: notepad .env.production

# 5. 설치
docker compose `
  -f docker-compose.yml `
  -f docker-compose.prod.yml `
  --env-file .env.production `
  -p wr-prod `
  up -d
```

---

## 6. release-manifest.json 명세

```json
{
  "version": "4.2.1",
  "gitCommit": "abc1234def5678...",
  "gitBranch": "main",
  "buildTime": "2026-05-15T09:00:00Z",
  "builderHost": "build-server-01",
  "images": [
    {
      "name": "wr-app-server",
      "tag": "4.2.1",
      "imageId": "sha256:..."
    },
    {
      "name": "wr-backup-monitor",
      "tag": "4.2.1",
      "imageId": "sha256:..."
    },
    {
      "name": "wr-backup",
      "tag": "4.2.1",
      "imageId": "sha256:..."
    }
  ],
  "baseImages": [
    "postgres:16-alpine",
    "caddy:2-alpine"
  ],
  "electronInstaller": {
    "included": false,
    "reason": "인트라넷 Electron 빌드 미완성 — 별도 빌드 후 포함 예정"
  },
  "checksum": "SHA256SUMS",
  "releaseNotes": "docs/CHANGELOG.md"
}
```

**필수 필드:**

| 필드 | 타입 | 설명 |
|---|---|---|
| `version` | string | 패키지 버전 (semver) |
| `gitCommit` | string | 빌드 기준 commit SHA |
| `buildTime` | string | ISO 8601 빌드 시각 |
| `images[].name` | string | Docker image 이름 |
| `images[].tag` | string | Docker image tag |
| `images[].imageId` | string | `sha256:...` 전체 image ID (로컬 빌드 기준, registry push 전에는 RepoDigest 없음) |
| `electronInstaller.included` | boolean | Electron 설치 파일 포함 여부 |
