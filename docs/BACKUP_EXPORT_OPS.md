# 백업 스냅샷 반출 운영 매뉴얼

이 문서는 **로컬 디스크에 반출용 백업 스냅샷을 만들고, 그 작업을 자동 스케줄로 운영**하기 위한 절차를 정리합니다.

대상 스크립트:
- `scripts\export-backup-snapshot.ps1` — 백업 스냅샷을 만드는 핵심 스크립트
- `scripts\register-backup-export-task.ps1` — 위 스크립트를 윈도우 작업 스케줄러에 등록하는 도우미

> 사용 환경: 서버 PC, **관리자 권한 PowerShell**, ASCII 경로(예: `C:\wr\wr-evaluation-unified-5.1.0-intranet`).

---

## 목차

1. [개념 정리](#1-개념-정리)
2. [수동 스냅샷 만들기](#2-수동-스냅샷-만들기)
3. [자동 스케줄 등록](#3-자동-스케줄-등록)
4. [등록된 작업 확인](#4-등록된-작업-확인)
5. [등록된 작업 삭제](#5-등록된-작업-삭제)
6. [로그/결과 파일 확인](#6-로그결과-파일-확인)
7. [반출 절차](#7-반출-절차)
8. [트러블슈팅](#8-트러블슈팅)

---

## 1. 개념 정리

### 1-1. 산출물 3종 세트

스크립트가 한 번 실행되면 `C:\wr\backup-exports\`에 다음 3개 파일이 생깁니다.

| 파일 | 용도 |
|---|---|
| `wr-backup-snapshot-<mode>-<timestamp>.tar.gz` | 백업 본체 (GPG 암호화 유지) |
| `<같은이름>.tar.gz.sha256` | 무결성 체크섬 |
| `<같은이름>.tar.gz.README.txt` | 반출 신청서에 그대로 옮겨 적을 영문 메타데이터 |

### 1-2. 모드 (Mode)

| Mode | 묶는 내용 | 권장 주기 |
|---|---|---|
| `week` | 최근 7일치 daily/`*.dump.gpg` + `_status` + `_alerts` | 주 1회 |
| `month` | 최근 31일치 daily/`*.dump.gpg` + `_status` + `_alerts` | 월 1회 |
| `all` | daily + monthly + yearly + `_status` + `_alerts` 전체 | 분기 1회 |

### 1-3. wrapper 파일

작업 스케줄러는 `.ps1`을 직접 호출하기에 명령행/인용/로그 처리가 까다롭습니다. 그래서 등록 스크립트는 그 사이에 `.cmd` 파일 하나를 자동 생성합니다:

```
scripts\run-WR-Backup-Export-<frequency>.cmd
```

이 파일이 하는 일:
1. 패키지 루트로 `cd`
2. `powershell.exe`로 `export-backup-snapshot.ps1` 호출
3. **stdout/stderr 전체를 로그 파일에 리다이렉트**

자동 생성/덮어쓰기되므로 직접 수정할 필요는 없습니다.

### 1-4. 로그 파일

```
C:\wr\backup-exports\logs\WR-Backup-Export-<frequency>.log
```

매 실행마다 시작/종료 시각, 명령, 출력 전부가 누적됩니다. 자동 실행이 실패했을 때 원인 파악의 1차 단서입니다.

---

## 2. 수동 스냅샷 만들기

스케줄 등록 없이 즉시 한 번 생성하고 싶을 때.

```powershell
cd C:\wr\wr-evaluation-unified-5.1.0-intranet

# 주간 (기본)
.\scripts\export-backup-snapshot.ps1

# 월간
.\scripts\export-backup-snapshot.ps1 -Mode month

# 분기 (전체)
.\scripts\export-backup-snapshot.ps1 -Mode all
```

옵션:

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `-Mode` | `week` | `week` / `month` / `all` |
| `-OutputDir` | `C:\wr\backup-exports` | 산출물 저장 위치 |
| `-ProjectName` | `wr-prod` | Docker Compose 프로젝트명 |
| `-EnvFile` | `.\.env.production` | 이미지 태그 자동 감지용 |
| `-Image` | (env에서 자동) | 명시적으로 docker 이미지 지정 |
| `-SkipBackupHealthCheck` | (off) | `backup-status.json`이 success가 아니어도 강제 실행 (비권장) |

---

## 3. 자동 스케줄 등록

`register-backup-export-task.ps1`은 위 수동 명령을 윈도우 작업 스케줄러에 등록합니다.

### 3-1. 기본 사용법

**관리자 권한 PowerShell** 필수.

```powershell
cd C:\wr\wr-evaluation-unified-5.1.0-intranet

# 매주 월요일 09:00 → 주간 스냅샷
.\scripts\register-backup-export-task.ps1 -Frequency weekly

# 매월 1일 09:00 → 월간 스냅샷
.\scripts\register-backup-export-task.ps1 -Frequency monthly

# 분기 1일(1/4/7/10월 1일) 09:00 → 전체 스냅샷
.\scripts\register-backup-export-task.ps1 -Frequency quarterly
```

세 개를 동시에 등록해도 충돌 없음. 각각 다음 이름으로 등록됩니다:
- `WR-Backup-Export-weekly`
- `WR-Backup-Export-monthly`
- `WR-Backup-Export-quarterly`

### 3-2. 시간/모드 변경

```powershell
# 매주 화요일 같은 패턴은 미지원 — 기본 월요일 사용. 시간만 자유.
.\scripts\register-backup-export-task.ps1 -Frequency weekly -At 06:30

# 모드를 명시적으로
.\scripts\register-backup-export-task.ps1 -Frequency monthly -At 23:00 -Mode all
```

### 3-3. 실행 계정 옵션

기본은 **현재 로그인한 관리자 계정**으로 실행됩니다. 등록 시 비밀번호 프롬프트가 한 번 뜹니다 (저장 후 사용자 로그오프 상태에서도 동작).

SYSTEM 계정으로 실행하려면 (대부분의 Docker Desktop 환경에서는 SYSTEM이 Docker에 접근하지 못해 실패합니다 — **비권장**):

```powershell
.\scripts\register-backup-export-task.ps1 -Frequency weekly -RunAsSystem
```

### 3-4. 등록 직후 반드시 테스트

자동 실행은 화면이 안 보이기 때문에, 등록 후 **즉시 한 번 수동 실행**해서 로그를 확인하는 게 안전합니다.

```powershell
# 즉시 실행
schtasks /Run /TN "WR-Backup-Export-weekly"

# 약 30초~수 분 후 로그 확인 (Mode에 따라 소요 시간 다름)
Get-Content "C:\wr\backup-exports\logs\WR-Backup-Export-weekly.log" -Tail 60
```

로그 끝부분에 다음이 보이면 성공:
```
Backup export snapshot ready (local disk)
============================================================
  File      : wr-backup-snapshot-week-YYYYMMDD_HHMMSS.tar.gz
  ...
Run end  : ...  (exit 0)
```

`C:\wr\backup-exports\`에 `.tar.gz` 3종 세트가 보이는지도 확인.

---

## 4. 등록된 작업 확인

### 4-1. 빠른 목록

```powershell
schtasks /Query /TN "WR-Backup-Export-weekly"
```

### 4-2. 상세 정보 (다음 실행 시각, 마지막 결과 등)

```powershell
schtasks /Query /TN "WR-Backup-Export-weekly" /V /FO LIST
```

### 4-3. PowerShell로 우리 작업만 모아 보기

```powershell
Get-ScheduledTask -TaskName "WR-Backup-Export-*" |
    Select-Object TaskName, State |
    Format-Table -AutoSize

Get-ScheduledTaskInfo -TaskName "WR-Backup-Export-weekly" |
    Select-Object LastRunTime, LastTaskResult, NextRunTime
```

- `State` — `Ready` (예약 대기) / `Running` / `Disabled`
- `LastTaskResult` — `0`이면 성공, 그 외는 실패 코드

### 4-4. GUI

```powershell
taskschd.msc
```

좌측 트리 → **작업 스케줄러 라이브러리** 클릭 → 우측에 `WR-Backup-Export-*` 보임.

---

## 5. 등록된 작업 삭제

### 5-1. 하나만 삭제

```powershell
schtasks /Delete /TN "WR-Backup-Export-weekly" /F
```

옵션:
- `/F` — 확인 프롬프트 없이 강제 삭제

### 5-2. 세 가지 모두 삭제

```powershell
'weekly','monthly','quarterly' | ForEach-Object {
    schtasks /Delete /TN "WR-Backup-Export-$_" /F 2>$null
}
```

없는 작업은 자동으로 무시됩니다.

### 5-3. wrapper / 로그까지 같이 정리 (선택)

작업 삭제는 wrapper 파일과 로그를 자동 삭제하지 않습니다. 같이 정리하려면:

```powershell
# wrapper (다음 등록 시 어차피 덮어쓰므로 남겨도 무방)
Remove-Item "C:\wr\wr-evaluation-unified-5.1.0-intranet\scripts\run-WR-Backup-Export-weekly.cmd" `
    -Force -ErrorAction SilentlyContinue

# 로그
Remove-Item "C:\wr\backup-exports\logs\WR-Backup-Export-weekly.log" `
    -Force -ErrorAction SilentlyContinue
```

---

## 6. 로그/결과 파일 확인

### 6-1. 가장 최근 실행 로그

```powershell
Get-Content "C:\wr\backup-exports\logs\WR-Backup-Export-weekly.log" -Tail 80
```

### 6-2. 산출물 목록

```powershell
Get-ChildItem "C:\wr\backup-exports" -Filter "wr-backup-snapshot-*" |
    Sort-Object LastWriteTime -Descending |
    Select-Object Name, Length, LastWriteTime |
    Format-Table -AutoSize
```

### 6-3. 최근 SHA256 검증

```powershell
$snap = Get-ChildItem "C:\wr\backup-exports" -Filter "*.tar.gz" |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
$expected = (Get-Content "$($snap.FullName).sha256").Split(' ')[0].ToLower()
$actual   = (Get-FileHash -LiteralPath $snap.FullName -Algorithm SHA256).Hash.ToLower()
if ($expected -eq $actual) { 'OK' } else { 'MISMATCH' }
```

---

## 7. 반출 절차

산출물은 자동으로 USB에 옮겨지지 않습니다. 반출은 **승인 프로그램을 통한 수동 절차**입니다.

1. **반출 승인 프로그램**을 실행
2. 다음 3개 파일을 첨부/등록:
   - `wr-backup-snapshot-<mode>-<timestamp>.tar.gz`
   - `<같은이름>.tar.gz.sha256`
   - `<같은이름>.tar.gz.README.txt`
3. 신청서에 README의 내용 그대로 옮겨 적기:
   - 파일명
   - 크기
   - SHA256 해시
   - 내용 분류 / 암호화 여부 / 반출 사유
4. 승인 → 별도 매체(USB)로 이동
5. USB에서 SHA256 재검증:
   ```powershell
   (Get-FileHash "<USB경로>\<파일명>" -Algorithm SHA256).Hash
   ```
6. **GPG 개인키는 절대 같은 USB에 함께 반출하지 말 것** — 분리 보관

---

## 8. 트러블슈팅

### 8-1. 등록은 성공인데 자동 실행이 안 됨

가장 흔한 원인: **SYSTEM 계정에서 Docker Desktop 접근 불가**.

확인:
```powershell
Get-Content "C:\wr\backup-exports\logs\WR-Backup-Export-weekly.log" -Tail 30
```

`Docker is not running.` 류 메시지가 보이면 → 작업을 삭제 후 `-RunAsSystem` 없이(기본) 다시 등록.

```powershell
schtasks /Delete /TN "WR-Backup-Export-weekly" /F
.\scripts\register-backup-export-task.ps1 -Frequency weekly
```

### 8-2. "backup-status.json is missing"

백업이 한 번도 성공한 적 없거나 backup volume이 비어 있는 상태입니다.

먼저 백업이 실제로 돌고 있는지 확인:
```powershell
docker logs wr-prod-backup-1 --tail 30
docker compose -f docker-compose.yml -f docker-compose.prod.yml `
    --env-file .env.production -p wr-prod ps
```

문제 해결 후 수동 백업 한 번:
```powershell
docker compose -f docker-compose.yml -f docker-compose.prod.yml `
    --env-file .env.production -p wr-prod `
    --profile backup run --rm backup sh /scripts/backup.sh
```

성공하면 export 재시도.

### 8-3. "Last backup is 'failed'. Aborting export."

가장 최근 백업이 실패한 상태입니다. **export 자체를 막은 것이 정상**입니다 — 실패한 백업을 반출하면 안 되니까요.

먼저 백업 실패 원인 해결 → 다음 백업이 success가 되면 export 자동 정상화. 

긴급히 이전 성공분만이라도 반출하려면 (드물게만 사용):
```powershell
.\scripts\export-backup-snapshot.ps1 -Mode week -SkipBackupHealthCheck
```

README에 `[!]` 마커로 우회 사실이 기록됩니다.

### 8-4. "Path contains non-ASCII character"

설치 경로에 한글이 들어가 있습니다 (예: `C:\Users\한글이름\...`).

해결: 패키지를 ASCII 경로(`C:\wr\...`)로 옮긴 뒤 그 위치에서 재실행.

### 8-5. wrapper 파일이 삭제됐어요

`scripts\run-WR-Backup-Export-*.cmd`가 사라지면 자동 실행이 실패합니다.

복구: 같은 옵션으로 등록 스크립트를 다시 실행 (덮어쓰기 등록).

```powershell
.\scripts\register-backup-export-task.ps1 -Frequency weekly
```

---

## 자주 쓰는 명령 모음 (치트시트)

```powershell
# === 등록 ===
.\scripts\register-backup-export-task.ps1 -Frequency weekly
.\scripts\register-backup-export-task.ps1 -Frequency monthly
.\scripts\register-backup-export-task.ps1 -Frequency quarterly

# === 즉시 실행 (테스트) ===
schtasks /Run /TN "WR-Backup-Export-weekly"

# === 확인 ===
schtasks /Query /TN "WR-Backup-Export-weekly" /V /FO LIST
Get-ScheduledTask -TaskName "WR-Backup-Export-*"

# === 로그 ===
Get-Content "C:\wr\backup-exports\logs\WR-Backup-Export-weekly.log" -Tail 60

# === 삭제 ===
schtasks /Delete /TN "WR-Backup-Export-weekly" /F

# === 수동 스냅샷 (스케줄 없이) ===
.\scripts\export-backup-snapshot.ps1 -Mode week
.\scripts\export-backup-snapshot.ps1 -Mode month
.\scripts\export-backup-snapshot.ps1 -Mode all
```
