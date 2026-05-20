# v5.0.x → v5.1.0 업데이트 절차

이미 v5.0.0 또는 v5.0.1이 운영 중인 인트라넷 서버를 v5.1.0으로 업데이트하는 절차.

## 무엇이 바뀌나

- **서버**: 환자 권한 미들웨어 추가 (`PATCH/DELETE /api/patients/:id`는 담당의 또는 admin만)
- **클라이언트(Electron)**: 권한 UI 게이팅, 대시보드 scope 분리, 척추 모듈 개선, 인트라넷 차단 화면 탈출구
- **네트워크 포트**: Caddy 호스트 매핑이 80/443 → **8080/8443** 으로 변경됨 (호스트의 80/443이 다른 프로세스에 점유된 환경 대응). Electron `DEFAULT_INTRANET_URL`도 `:8443` 명시
- **DB 스키마 변경**: 없음 (`assigned_doctor_user_id` 기존 컬럼 활용)
- **환경변수 변경**: `.env.production`에서 두 항목 수정 필수
  - **`WR_VERSION=5.1.0`** ← compose가 `wr-app-server:${WR_VERSION}` 형태로 이미지를 찾으므로 이 값을 안 바꾸면 5.1.0 이미지 로드해도 컨테이너는 계속 구버전 사용
  - **`CORS_ORIGINS=https://wr.hospital.local:8443`** ← 포트 명시. 기존이 `https://wr.hospital.local`이면 Electron 5.1.0이 CORS 403 받음
- **인증서 변경**: 없음 (Caddy 내부 CA 그대로, 컨테이너 내부 listen 포트도 443/80 그대로 — 호스트 매핑만 변경)

## 예상 다운타임

- **서버**: ~10초 (app 컨테이너만 재생성. postgres/caddy/backup/backup-monitor는 영향 없음)
- **클라이언트 PC**: 의사별 5분 이내 (Electron 인스톨러 재실행 → 자동 업그레이드)

## 사전 준비

### 0) 현재 운영 환경 정보 파악 (제일 먼저)

업데이트 명령에 필요한 값들을 모두 확인:

```powershell
Write-Host "=== 1. Compose 프로젝트 이름 ===" -ForegroundColor Cyan
docker compose ls
# NAME 컬럼이 'wr-prod'인지 확인 → -p 값

Write-Host "`n=== 2. 현재 app 컨테이너 이미지 ===" -ForegroundColor Cyan
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"
# 예: wr-app-server:5.0.1 ← 업데이트 후 5.1.0이 되어야 함

Write-Host "`n=== 3. 현재 운영 .env.production 경로 ===" -ForegroundColor Cyan
$installDir = docker inspect wr-prod-app-1 --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
Write-Host "Install dir: $installDir"
Get-ChildItem -Path $installDir -Filter ".env*" -ErrorAction SilentlyContinue
# 예: C:\wr\wr-evaluation-unified-5.0.1-intranet\.env.production

Write-Host "`n=== 4. .env.production의 핵심 값 ===" -ForegroundColor Cyan
$envPath = Join-Path $installDir ".env.production"
Get-Content $envPath | Select-String "WR_VERSION|CORS_ORIGINS"
```

위 출력에서 얻는 값들 — 다음 단계에서 그대로 씀:
- `-p` 값: `wr-prod`
- env 파일 경로: 예) `C:\wr\wr-evaluation-unified-5.0.1-intranet\.env.production`
- 현재 `WR_VERSION` / `CORS_ORIGINS` (4번에서 수정 필요 여부 확인)

### 1) 패키지 이송
- `release\wr-evaluation-unified-5.1.0-intranet.zip` (350MB)를 USB 또는 인트라넷 파일 공유로 서버에 복사
- 압축 해제: `wr-evaluation-unified-5.1.0-intranet\` 폴더 생성

### 2) (권장) 무결성 검증

서버에서:

```powershell
cd wr-evaluation-unified-5.1.0-intranet

# UTF-8로 한국어 파일명 정상 처리
$utf8 = New-Object System.Text.UTF8Encoding $false
$lines = [System.IO.File]::ReadAllLines("$pwd\SHA256SUMS", $utf8)
foreach ($line in $lines) {
  if (-not $line) { continue }
  $h, $f = ($line -split '  ', 2)
  $actual = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $h.ToLower()) { Write-Warning "MISMATCH: $f" }
}
Write-Host "Verified $($lines.Count) files"
```

또는 Linux/WSL: `sha256sum -c SHA256SUMS`

### 3) (강력 권장) 업데이트 직전 DB 백업

업데이트 전 한 번 더 백업하면 만일의 롤백이 깔끔합니다. 운영 중인 백업 서비스 활용:

```powershell
docker compose -p wr-prod --profile backup run --rm backup /scripts/backup.sh
```

`_status\last-success.txt`에 새 백업 시각이 찍히는지 확인.

### 4) (필수) .env.production 수정 — 두 항목

0번 단계에서 찾은 env 파일을 메모장으로 열어 두 값을 수정:

```powershell
notepad "C:\wr\wr-evaluation-unified-5.0.1-intranet\.env.production"
# (실제 경로는 0번 단계 출력값 사용)
```

```
# === WR_VERSION (필수) ===
# 수정 전:   WR_VERSION=5.0.1
# 수정 후:   WR_VERSION=5.1.0
#
# 이 값을 안 바꾸면 docker compose가 wr-app-server:5.0.1 이미지로 컨테이너를 만들기 때문에
# 5.1.0 이미지가 로드되어 있어도 업데이트가 적용되지 않음 (가장 흔한 실수)

# === CORS_ORIGINS (필수) ===
# 수정 전:   CORS_ORIGINS=https://wr.hospital.local
# 수정 후:   CORS_ORIGINS=https://wr.hospital.local:8443
#
# Electron 5.1.0 클라이언트가 :8443 origin으로 접속하므로 서버 화이트리스트에 포트 포함 필수.
# 빠뜨리면 클라이언트가 CORS 거부(HTTP 403)로 막힘.
```

수정 후 다시 확인:
```powershell
Get-Content "<env경로>" | Select-String "WR_VERSION|CORS_ORIGINS"
# WR_VERSION=5.1.0
# CORS_ORIGINS=https://wr.hospital.local:8443
```

### 5) (필수 시) Windows 방화벽 인바운드 규칙

5.0.x 운영 시 80/443 인바운드만 열어두었다면 **TCP 8080, 8443**도 인바운드 허용 필요. PowerShell 관리자 권한:

```powershell
New-NetFirewallRule -DisplayName "WR Caddy HTTPS (8443)" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow
New-NetFirewallRule -DisplayName "WR Caddy HTTP (8080)"  -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

---

## 업데이트 절차

### A. 서버 업데이트

**중요**: 사전 준비 4번에서 `WR_VERSION=5.1.0`과 `CORS_ORIGINS=...:8443` 수정을 마쳤는지 다시 한 번 확인. 안 했으면 아래 명령을 실행해도 컨테이너가 재생성되지 않음.

서버에서 PowerShell 관리자 권한으로:

```powershell
# 1. 새 패키지 폴더로 이동 (compose 파일을 이 폴더에서 읽음)
cd C:\wr\wr-evaluation-unified-5.1.0-intranet

# 2. 새 Docker 이미지 로드 (postgres/caddy base 이미지는 기존 태그와 같으면 skip)
.\scripts\import-images.ps1

# 3. 로드된 이미지 확인 (wr-app-server:5.1.0 보여야 함)
docker images | Select-String "wr-app-server"

# 4. app 컨테이너 재생성
#    -p             : 기존 프로젝트 이름 (사전 준비 0번에서 확인한 값, 보통 wr-prod)
#    --env-file     : 기존 운영 .env.production 절대경로 (0번 출력값 그대로)
#    -f             : compose 파일 (현재 폴더의 5.1.0 버전)
#    실제 경로는 본인 환경에 맞게 수정
docker compose `
  -p wr-prod `
  --env-file C:\wr\wr-evaluation-unified-5.0.1-intranet\.env.production `
  -f docker-compose.yml -f docker-compose.prod.yml `
  up -d app

# 5. 백업 프로필도 운영 중이면 한 줄 더 (선택)
docker compose `
  -p wr-prod `
  --env-file C:\wr\wr-evaluation-unified-5.0.1-intranet\.env.production `
  -f docker-compose.yml -f docker-compose.prod.yml `
  --profile backup up -d
```

**정상 동작 시 출력에 "Recreate wr-prod-app-1"이 보여야 함**. 만약 app 관련 출력이 없으면:
- `.env.production`의 `WR_VERSION`이 아직 5.0.x로 남아 있을 가능성 높음 → 4단계 출력 다시 확인

**`up -d app` 동작**:
- app 이미지 태그가 바뀌었음을 감지 → 컨테이너 재생성 (`Recreate`)
- postgres/backup/backup-monitor는 이미지 변경 없으므로 그대로 유지
- **caddy는 포트 매핑(80/443 → 8080/8443) 변경 감지로 재생성됨** — 잠시 다운(수 초). 호스트 80을 점유 중인 다른 프로세스와 충돌 안 해 안전

> **참고**: 매번 5.0.1 폴더의 env를 참조하는 게 헷갈리면 한 번 복사해 두는 게 편함:
> ```powershell
> Copy-Item "C:\wr\wr-evaluation-unified-5.0.1-intranet\.env.production" `
>           "C:\wr\wr-evaluation-unified-5.1.0-intranet\.env.production"
> ```
> 그러면 다음부터 `--env-file .env.production` (상대경로)로 짧게 가능.

### B. 서버 헬스 체크

```powershell
# 1. ★가장 중요★ app 이미지 태그가 실제로 5.1.0인지 확인
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"
# → wr-app-server:5.1.0  이어야 정상
# → wr-app-server:5.0.1 이면 업데이트 실패 (WR_VERSION 수정 빠뜨림 — A 단계 다시)

# 2. 전체 컨테이너 상태
docker ps --filter "name=wr-prod" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

# 3. app health (컨테이너 내부에서)
docker exec wr-prod-app-1 wget -qO- http://localhost:3001/health
# → {"ok":true,...}

# 4. Caddy 경유 HTTPS 헬스체크 (호스트에서)
curl.exe -k -o NUL -w "8443: %{http_code}`n" https://localhost:8443/health
# → 8443: 200 이면 정상 (인증서 경고는 -k로 무시)

# 5. 부팅 로그 확인
docker logs wr-prod-app-1 --tail 50
# 에러 없이 "Server listening on port 3001" 류 메시지 보여야 정상
```

권한 미들웨어 동작 확인은 의사 계정으로 클라이언트에서 검증 (다음 섹션 검증 시나리오).

### C. 클라이언트 PC 업데이트 (의사들 데스크톱)

각 PC에서:

1. **기존 앱 종료** (작업 중인 미저장 데이터는 자동저장에 의존 — 가능하면 명시적 저장 후 종료)
2. `직업성 질환 통합 평가 프로그램 Setup 5.1.0.exe` 실행
3. NSIS 인스톨러가 5.0.1 위에 자동 업그레이드 (설치 위치 변경 X)
4. 첫 실행 시 기존 로그인 세션 유지 — 재로그인 불필요

---

## 검증 시나리오

업데이트 후 운영자 본인 계정으로:

| 시나리오 | 기대 결과 |
|---|---|
| testuser 로그인 → 자기 환자 수정/삭제 | 정상 |
| testuser 로그인 → testuser2 환자 보기 | 정상 (조회만, "담당 의사가 아니므로 조회만 가능합니다" 배너) |
| testuser 로그인 → testuser2 환자 수정 시도 | 입력 비활성 (`inert`), 삭제 버튼 안 보임 |
| admin 로그인 → 모든 환자 수정/삭제 | 정상 |
| 헤더 "대시보드" 클릭 → 랜딩 → "환자 목록 보기" 버튼 | 메인 워크스페이스 + 사이드바 자동 열림 |
| 대시보드 우상단 토글 "내 환자 통계" ↔ "전체 통계" | 정상 전환 (인트라넷+로그인일 때만 노출) |
| 척추 평가 화면에서 작업 드래그앤드롭 | 같은 직업 탭 내 순서 변경 |
| 척추 진단 2개+ 시 "수직분포 정리/동반 척추증" | 첫 진단에만 표시 |

---

## 롤백 절차

문제 발생 시 v5.0.1로 즉시 롤백:

```powershell
# 1. .env.production 되돌리기 (메모장)
#    WR_VERSION=5.1.0  → WR_VERSION=5.0.1
#    CORS_ORIGINS=https://wr.hospital.local:8443  → 기존 값 (포트 없으면 없는 채로)
notepad C:\wr\wr-evaluation-unified-5.0.1-intranet\.env.production

# 2. 기존 5.0.1 패키지 디렉토리로 이동
cd C:\wr\wr-evaluation-unified-5.0.1-intranet

# 3. 5.0.1 이미지가 로컬에 있는지 확인 (보통 그대로 남아 있음)
docker images | Select-String "wr-app-server:5.0.1"
# 없으면 .\scripts\import-images.ps1 (5.0.1 패키지에서)

# 4. compose 재실행 (5.0.1 폴더의 옛 yml 사용)
docker compose `
  -p wr-prod `
  --env-file .\.env.production `
  -f docker-compose.yml -f docker-compose.prod.yml `
  up -d app

# 5. 확인
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"
# → wr-app-server:5.0.1
```

**DB는 변경 없음이라 롤백 시 데이터 손실 없음.**

**포트도 자동 롤백**: 5.0.1의 docker-compose.yml은 80:80, 443:443 매핑이라 caddy도 옛 설정으로 재생성됨. 단 호스트 80을 다른 프로세스가 여전히 점유 중이면 caddy가 다시 바인딩 실패할 수 있음 — 이 경우 사용자가 5.0.x 운영 중에 직접 수정해 둔 ports 변경이 5.0.1 폴더 yml에 그대로 남아 있는지 확인.

클라이언트 PC: Setup 5.0.1.exe 재실행 (NSIS 다운그레이드 동작).

---

## 알려진 함정 (실제 경험)

업데이트 중 실제로 막힌 사례들. 같은 실수 반복 방지용.

### "Couldn't find env file: ...\.env.production"
**원인**: 5.1.0 폴더에는 `.env.production`이 없는데 `--env-file .env.production` (상대경로)을 줌.
**해결**: 0번 단계에서 찾은 절대경로를 그대로 사용. 또는 5.0.x 폴더 env를 5.1.0 폴더에 복사 (위 참고 박스).

### `up -d app` 실행했는데 app 컨테이너 안 보이고 5.0.1 그대로
**원인**: `.env.production`의 `WR_VERSION`이 5.0.x로 남아 있음. compose가 `wr-app-server:${WR_VERSION}` → `wr-app-server:5.0.1`로 해석해서 "이미 그 이미지로 떠 있음"으로 판단 → 재생성 안 함.
**해결**: 사전 준비 4번대로 `WR_VERSION=5.1.0`으로 수정 후 다시 `up -d app`.

### `docker ps` 명령만 하고 업데이트 됐다고 착각
**원인**: `up -d app` 대신 `ps`(목록 조회)만 실행.
**해결**: 끝이 `up -d app`인지 다시 확인.

### Electron 클라이언트가 서버에 접속 안 됨 / 일부 API가 CORS 403
**원인**: `.env.production`의 `CORS_ORIGINS`에 `:8443`이 빠짐. 서버는 떠 있지만 Electron이 보내는 `Origin: https://wr.hospital.local:8443` 헤더와 안 맞아 거부.
**해결**: 사전 준비 4번대로 `CORS_ORIGINS=https://wr.hospital.local:8443` 수정 후 `up -d app`.

### Caddy가 포트 80 바인딩 실패 (`Ports are not available`)
**원인**: 호스트 80을 다른 프로세스가 점유 중. 5.1.0은 이미 호스트 8080/8443으로 매핑하므로 발생 안 해야 하지만, 5.0.x 시절 caddy 컨테이너가 80에 묶인 채 잔존한 경우.
**해결**: `docker compose -p wr-prod ... up -d caddy` 한 번 더 명시 실행해 강제 재생성.

---

## 알려진 주의사항

### 비담당 환자 동기화 실패 (403)
업데이트 후, 의사가 다른 사람 담당 환자에 대해 이미 dirty 데이터(미저장 변경)를 가지고 있다면 sync 시 403 받음. 클라이언트에 **"권한 없음으로 동기화되지 않은 환자: N건"** 빨간 배너가 표시되고 다음 정상 sync 시 자동 사라짐. 정책상 의도된 동작 — admin이 해당 환자의 담당 의사를 재배정하면 해소.

### 클라이언트만 5.0.1, 서버 5.1.0인 경우
구 클라이언트가 PATCH/DELETE 호출 시 서버가 403으로 차단. 사용자에게는 일반 에러로 보일 수 있어, 가능하면 서버 + 클라이언트 동시 업데이트 권장.

---

## 참고

- 패키지: `release\wr-evaluation-unified-5.1.0-intranet.zip` (350MB)
- Git commit: 5a2402d
- 변경 이력: `docs/PRD.md` v5.1.0 섹션, `README.md` 변경 이력 v5.1.0
- 기존 신규 설치 가이드: `docs/OFFLINE_DEPLOYMENT_PACKAGE.md`
- 백업/복구: `docs/BACKUP_RESTORE.md`
