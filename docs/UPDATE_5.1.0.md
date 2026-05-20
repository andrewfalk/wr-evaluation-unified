# v5.0.x → v5.1.0 업데이트 절차

이미 v5.0.0 또는 v5.0.1이 운영 중인 인트라넷 서버를 v5.1.0으로 업데이트하는 절차.

## 무엇이 바뀌나

- **서버**: 환자 권한 미들웨어 추가 (`PATCH/DELETE /api/patients/:id`는 담당의 또는 admin만)
- **클라이언트(Electron)**: 권한 UI 게이팅, 대시보드 scope 분리, 척추 모듈 개선, 인트라넷 차단 화면 탈출구
- **네트워크 포트**: Caddy 호스트 매핑이 80/443 → **8080/8443** 으로 변경됨 (호스트의 80/443이 다른 프로세스에 점유된 환경 대응). Electron `DEFAULT_INTRANET_URL`도 `:8443` 명시
- **DB 스키마 변경**: 없음 (`assigned_doctor_user_id` 기존 컬럼 활용)
- **환경변수 변경**: **`CORS_ORIGINS` 값에 `:8443` 포함 필수** (예: `https://wr.hospital.local:8443`). 기존 v5.0.x에서 `https://wr.hospital.local`로 설정해 두었다면 반드시 수정
- **인증서 변경**: 없음 (Caddy 내부 CA 그대로, 컨테이너 내부 listen 포트도 443/80 그대로 — 호스트 매핑만 변경)

## 예상 다운타임

- **서버**: ~10초 (app 컨테이너만 재생성. postgres/caddy/backup/backup-monitor는 영향 없음)
- **클라이언트 PC**: 의사별 5분 이내 (Electron 인스톨러 재실행 → 자동 업그레이드)

## 사전 준비

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

### 4) (필수) .env.production CORS_ORIGINS 수정

기존 운영 환경의 `.env.production`의 `CORS_ORIGINS` 값에 **포트 `:8443` 추가** 필요:

```
# 수정 전
CORS_ORIGINS=https://wr.hospital.local

# 수정 후
CORS_ORIGINS=https://wr.hospital.local:8443
```

빠뜨리면 Electron 클라이언트가 서버에 접속할 때 CORS 거부 (HTTP 403)로 막힙니다.

### 5) (필수 시) Windows 방화벽 인바운드 규칙

5.0.x 운영 시 80/443 인바운드만 열어두었다면 **TCP 8080, 8443**도 인바운드 허용 필요. PowerShell 관리자 권한:

```powershell
New-NetFirewallRule -DisplayName "WR Caddy HTTPS (8443)" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow
New-NetFirewallRule -DisplayName "WR Caddy HTTP (8080)"  -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

---

## 업데이트 절차

### A. 서버 업데이트

서버에서 PowerShell 관리자 권한으로:

```powershell
cd wr-evaluation-unified-5.1.0-intranet

# 1. 새 Docker 이미지 로드 (postgres/caddy base 이미지도 포함되어 있으나 기존과 같은 태그면 docker가 자동으로 skip)
.\scripts\import-images.ps1

# 2. 현재 운영 중인 .env.production 위치 확인 (보통 기존 설치 디렉토리)
#    예: C:\wr-evaluation-unified\.env.production
#    이 .env는 손대지 않음. 새 패키지의 .env.production.example은 참고용

# 3. 새 compose 파일 적용 + app 컨테이너만 재생성
#    -p wr-prod : 기존 프로젝트 이름 (기존 볼륨/네트워크 유지)
#    --env-file : 기존 운영 .env 경로
docker compose `
  -p wr-prod `
  --env-file C:\path\to\.env.production `
  -f docker-compose.yml -f docker-compose.prod.yml `
  up -d app

# 4. 백업 프로필도 같이 운영 중이면 한 줄 더 (선택)
docker compose -p wr-prod `
  --env-file C:\path\to\.env.production `
  -f docker-compose.yml -f docker-compose.prod.yml `
  --profile backup up -d
```

**`up -d app` 동작**:
- app 이미지 태그가 바뀌었음을 감지 → 컨테이너 재생성 (`Recreate`)
- postgres/backup/backup-monitor는 이미지 변경 없으므로 그대로 유지
- **caddy는 포트 매핑(80/443 → 8080/8443) 변경 감지로 재생성됨** — 잠시 다운(수 초). 호스트 80을 점유 중인 다른 프로세스와 충돌 안 해 안전

### B. 서버 헬스 체크

```powershell
# 컨테이너 상태
docker ps --filter "name=wr-prod" --format "table {{.Names}}\t{{.Status}}"

# app health (컨테이너 내부에서)
docker exec wr-prod-app-1 wget -qO- http://localhost:3001/health
# → {"ok":true,...}

# Caddy 경유 HTTPS 헬스체크 (호스트에서)
curl.exe -k -o NUL -w "8443: %{http_code}`n" https://localhost:8443/health
# → 8443: 200 이면 정상 (인증서 경고는 -k로 무시)

# 새 권한 미들웨어 동작 확인 (admin 토큰 필요 — 운영자 본인 계정으로 로그인 후 DevTools에서)
# 다른 의사 담당 환자에 PATCH 직접 호출 → 403 응답이 와야 정상
```

`docker logs wr-prod-app-1 --tail 50`으로 부팅 에러 없는지 확인.

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
# 1. 기존 5.0.1 패키지 디렉토리로 이동 (보관 중이어야 함)
cd wr-evaluation-unified-5.0.1-intranet

# 2. 5.0.1 이미지가 이미 로컬에 있으면 (docker images로 확인) skip 가능. 아니면:
.\scripts\import-images.ps1

# 3. compose 재실행 (이미지 태그가 바뀌어 자동 다운그레이드)
docker compose -p wr-prod `
  --env-file C:\path\to\.env.production `
  -f docker-compose.yml -f docker-compose.prod.yml `
  up -d app
```

**DB는 변경 없음이라 롤백 시 데이터 손실 없음.**

클라이언트 PC: Setup 5.0.1.exe 재실행 (NSIS 다운그레이드 동작).

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
