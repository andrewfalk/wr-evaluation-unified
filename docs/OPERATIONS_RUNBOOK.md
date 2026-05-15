# 운영 런북 (Operations Runbook)

## 1. 백업 모니터링 구조

```
[backup 컨테이너]          [backup-monitor 컨테이너]      [app 컨테이너]
  crond 02:00 → backup.sh    매 1시간 체크                  /api/admin/ops/backup-status
        ↓                          ↓                              ↓
  backup_data 볼륨 (공유)          ↓                         관리자 콘솔 > 운영 상태 탭
  /backups/daily/*.gpg       _status/monitor-report.json    ops-alert-banner (5분 폴링)
  /backups/_status/          _alerts/FAILED_*.json
  /backups/_alerts/
```

### 파일 위치

| 파일 | 역할 |
|------|------|
| `/backups/_status/backup-status.json` | 최근 백업 실행 상태 (running / success / failed) |
| `/backups/_status/backup-status-dry.json` | dry-run 전용 상태 (운영 상태와 분리) |
| `/backups/_status/monitor-report.json` | 모니터 최근 판정 결과 (summary, isStale, openAlerts) |
| `/backups/_status/.last_success` | 마지막 실제 성공 시각 (ISO-8601 텍스트) |
| `/backups/_status/.last_failure` | 마지막 실제 실패 시각 (ISO-8601 텍스트) |
| `/backups/_alerts/FAILED_<runId>.json` | 실패 alert 파일 (runId = YYYYmmdd_HHMMSS) |

### summary 값 의미

| summary | 의미 | 배너 |
|---------|------|------|
| `ok` | 정상 | 없음 |
| `stale` | 마지막 성공이 36h 초과 (백업 지연) | **표시** |
| `alert_open` | 미처리 실제 장애 alert 존재 | **표시** |
| `stale_and_alert` | 지연 + 미처리 alert | **표시** |
| `dry_run_alert_open` | 검증용 dry-run alert만 존재 (정상) | 없음 |

---

## 2. 경보 수신 → 조치 절차

### 2-1. 배너 확인

관리자 로그인 후 화면 상단에 다음 배너가 표시되면 이상이 감지된 것입니다:

> **백업 이상 감지 — 관리자 콘솔 > 운영 상태 탭에서 확인하세요**

배너를 클릭하면 관리자 콘솔이 열리고 **운영 상태** 탭으로 이동합니다.

### 2-2. 원인 파악

운영 상태 탭에서 확인:
- **요약 상태**: `stale` / `alert_open` / `stale_and_alert`
- **마지막 성공 시각**: 36시간 이상 경과 여부
- **실패 원인 (`reasonClass`)**:

| reasonClass | 의미 | 확인 사항 |
|-------------|------|----------|
| `pg_dump_failed` | pg_dump 실패 | PostgreSQL 상태, 디스크 용량 |
| `gpg_encrypt_failed` | GPG 암호화 실패 | GPG 키 유효성, 키링 상태 |
| `promote_failed` | 월간/연간 복사 실패 | 볼륨 마운트, 권한 |
| `pruning_failed` | 보존 정책 정리 실패 | 디스크 용량 |
| `unknown` | 초기화 중 또는 미분류 실패 | 컨테이너 로그 확인 |

### 2-3. 로그 확인

```powershell
# 최근 backup 실행 로그
docker compose --profile backup logs --tail=100 backup

# backup-monitor 로그
docker compose logs --tail=50 backup-monitor

# 상태 파일 직접 확인
docker compose exec app cat /backups/_status/backup-status.json
docker compose exec app cat /backups/_status/monitor-report.json
docker compose exec app ls /backups/_alerts/
```

### 2-4. 복구 조치

**케이스 A — pg_dump 실패 (DB 접속 불가)**
```powershell
# PostgreSQL 상태 확인
docker compose ps postgres
docker compose exec postgres pg_isready -U wr_user -d wr_evaluation

# 재기동
docker compose restart postgres
docker compose restart backup
```

**케이스 B — GPG 키 만료/누락**
```powershell
# 현재 등록된 키 목록 확인
docker compose --profile backup run --rm backup gpg --list-keys

# 새 공개 키 임포트
docker compose --profile backup run --rm backup \
  gpg --import /tmp/new-key.asc

# BACKUP_GPG_RECIPIENT 환경변수가 올바른지 .env 확인
```

**케이스 C — 디스크 용량 부족**
```powershell
# 볼륨 사용량 확인
docker system df -v

# 오래된 백업 수동 정리 (일별 30일, 월별 12개월, 연별 5년 기준)
docker compose exec backup ls -lh /backups/daily/
```

**케이스 D — 단순 지연 (stale, 실제 실패 아님)**
```powershell
# 수동으로 즉시 백업 실행
docker compose --profile backup run --rm backup sh /scripts/backup.sh

# 성공 확인
docker compose exec app cat /backups/_status/backup-status.json
```

### 2-5. Alert 처리 (관리자 콘솔 UI 또는 API)

```powershell
# UI: 관리자 콘솔 > 운영 상태 탭 > [확인] / [해결 완료] 버튼

# API 직접 호출 (TOKEN은 관리자 Bearer 토큰)
$RUN_ID = "20260513_020000"   # alert 파일명에서 확인
$BASE   = "https://wr.hospital.local"
$TOKEN  = "..."

# 확인 처리
Invoke-RestMethod -Method POST `
  -Uri "$BASE/api/admin/ops/backup-alerts/$RUN_ID/ack" `
  -Headers @{ Authorization = "Bearer $TOKEN" }

# 해결 완료
Invoke-RestMethod -Method POST `
  -Uri "$BASE/api/admin/ops/backup-alerts/$RUN_ID/resolve" `
  -Headers @{ Authorization = "Bearer $TOKEN" }
```

> **주의**: `acknowledgedAt` + `resolvedAt`이 모두 설정되고 파일 생성 후 90일이 경과한 alert만 자동 삭제됩니다. 해결 전까지 alert 파일은 보존됩니다.

---

## 3. 복구 절차

데이터베이스 복구는 [BACKUP_RESTORE.md](BACKUP_RESTORE.md)를 참조하세요.

---

## 4. Step 14 검증 절차

배포 전 백업 모니터링 파이프라인이 정상 작동하는지 확인합니다.

### 4-1. dry-run 실패 alert 생성 (fail-closed 확인)

```powershell
# 실패 alert 생성 — DB/GPG 건드리지 않음
docker compose --profile backup run --rm `
  -e BACKUP_DRY_RUN=1 `
  -e BACKUP_DRY_RUN_FAIL_REASON=gpg_encrypt_failed `
  -e BACKUP_DIR=/tmp/wr-backup-test `
  backup sh /scripts/backup.sh

# 생성 확인
docker compose exec app ls /backups/_alerts/
docker compose exec app cat /backups/_alerts/FAILED_*.json
# → dryRun: true, purpose: "step14_verification", reasonClass: "gpg_encrypt_failed" 확인
```

### 4-2. monitor가 alert를 감지했는지 확인

```powershell
# monitor는 1시간마다 체크 — 즉시 확인하려면 컨테이너 재시작
docker compose restart backup-monitor

# 30초 후 리포트 확인
Start-Sleep -Seconds 30
docker compose exec app cat /backups/_status/monitor-report.json
# → summary: "alert_open" 또는 "stale_and_alert" 확인
```

### 4-3. 관리자 UI 배너 확인

1. 관리자 계정으로 앱에 로그인
2. 화면 상단에 "백업 이상 감지" 배너가 표시되는지 확인
3. 배너 클릭 → 관리자 콘솔 > 운영 상태 탭 자동 이동
4. 미처리 alert 목록에서 해당 runId 확인

### 4-4. ack/resolve 처리

1. 운영 상태 탭 > [확인] 버튼 → `acknowledgedAt` 설정 확인
2. [해결 완료] 버튼 → `resolvedAt` 설정 확인
3. `openAlerts` 목록에서 해당 alert 사라짐 확인
4. 배너 사라짐 확인

### 4-5. 성공 status-file 기록 검증 (인프라 확인)

```powershell
# DB 없이 status 파일 쓰기만 검증
docker compose --profile backup run --rm `
  -e BACKUP_DRY_RUN=1 `
  -e BACKUP_DIR=/tmp/wr-backup-test `
  backup sh /scripts/backup.sh

# backup-status-dry.json 확인 (backup-status.json은 미변경)
docker compose exec app cat /backups/_status/backup-status-dry.json
# → status: "success", dryRun: true
```

### 4-6. Step 14 PASS 기준

- [ ] dry-run 실패 alert 파일 생성 (`dryRun: true, purpose: "step14_verification"`)
- [ ] monitor-report.json에 `summary: "alert_open"` 이상 반영
- [ ] 관리자 UI 배너 표시
- [ ] 운영 상태 탭에서 alert 목록 확인
- [ ] ack/resolve 처리 후 배너 사라짐
- [ ] `backup-status.json` (운영 파일)은 dry-run으로 미변경

---

## 5. 정기 점검 항목

| 주기 | 항목 | 확인 방법 |
|------|------|----------|
| 매일 | 어제 백업 성공 여부 | 관리자 콘솔 > 운영 상태 탭 |
| 매주 | 월간 백업 파일 존재 | `docker compose exec app ls /backups/monthly/` |
| 매월 | 복구 테스트 (선택) | BACKUP_RESTORE.md 절차 |
| 분기 | GPG 키 만료 일자 확인 | `docker compose --profile backup run --rm backup gpg --list-keys` |
| 연 1회 | 연간 백업 파일 존재 | `docker compose exec app ls /backups/yearly/` |

---

## 6. Step 14 검증 증적 (2026-05-15)

| 항목 | 결과 | 비고 |
|------|------|------|
| dry-run 실패 alert 생성 | ✅ PASS | `FAILED_20260515_062108.json`, `dryRun: true`, `purpose: "step14_verification"`, `reasonClass: "gpg_encrypt_failed"` |
| monitor-report.json 반영 | ✅ PASS | `summary: "alert_open"` — backup-monitor 재시작 후 30초 내 확인 |
| 관리자 UI 배너 표시 | ✅ PASS | 관리자 로그인 시 "백업 이상 감지" 배너 표시 |
| ack/resolve 처리 | ✅ PASS | UI [확인]/[해결 완료] 버튼 → 배너 즉시 해제 (live summary 재계산) |
| 운영 status 파일 오염 없음 | ✅ PASS | `backup-status.json` 미변경, `backup-status-dry.json`에만 기록 |
| 판정 | **Conditional PASS** | 외부 알림(Slack/이메일) 없음 — IT 협조 시 T46에서 추가 |

### 미확인 항목 (실제 운영 배포 전 완료 권장)

- [ ] 실제 GPG 백업 1회 성공 → `backup-status.json status: "success"`, `monitor-report.json summary: "ok"` 확인
- [ ] 복구 테스트 (BACKUP_RESTORE.md 절차)
