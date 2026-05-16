# 백업 모니터링 구현 계획 (T45 Step 14)

## 배경

T45 Step 14 기준: "백업 실패 시 운영자에게 자동 알림 체계 작동 확인"

외부 IT 협조(이메일/Slack 연동) 없이 구현하는 **1+3 방안**:
- **파일 기반 증적**: `backup.sh`가 `/backups/_status/`, `/backups/_alerts/`에 JSON 파일 원자적 기록
- **내부 모니터 서비스**: 별도 컨테이너가 주기적으로 alert 파일과 stale 여부를 감지
- **서버 API**: `/api/admin/ops/backup-status` — 모니터 컨테이너의 판단을 앱에 노출
- **관리자 UI**: 전역 배너 + ops 상태 페이지

외부 의존성 없음. 관리자가 앱에 로그인하면 배너로 알림.

---

## 파일 스키마

### `_status/backup-status.json` (운영 전용, dry-run 미기록)

```json
{
  "status": "running | success | failed",
  "runId": "20260513_020000",
  "job": "daily-backup",
  "dryRun": false,
  "lastStartedAt": "2026-05-13T02:00:00Z",
  "lastFinishedAt": "2026-05-13T02:01:23Z",
  "lastSuccessAt": "2026-05-13T02:01:23Z",
  "lastFailureAt": null,
  "reasonClass": null
}
```

`reasonClass` 가능값: `pg_dump_failed | gpg_encrypt_failed | promote_failed | pruning_failed | unknown`

### `_status/backup-status-dry.json` (dry-run 전용)

동일 스키마, `dryRun: true`. 모니터와 UI는 이 파일을 운영 상태로 취급하지 않음.

### `_alerts/FAILED_<runId>.json`

```json
{
  "type": "backup_failed",
  "severity": "critical",
  "runId": "20260513_020000",
  "dryRun": false,
  "purpose": null,
  "reasonClass": "gpg_encrypt_failed",
  "createdAt": "2026-05-13T02:00:45Z",
  "acknowledgedAt": null,
  "acknowledgedBy": null,
  "resolvedAt": null,
  "resolvedBy": null
}
```

dry-run 실패 시: `dryRun: true, purpose: "step14_verification"`.

---

## Step 14 검증 커맨드

```sh
# 실패 alert 생성 (DB/GPG 건드리지 않음)
docker compose run --rm \
  -e BACKUP_DRY_RUN=1 \
  -e BACKUP_DRY_RUN_FAIL_REASON=gpg_encrypt_failed \
  backup

# 성공 status-file 쓰기 검증
docker compose run --rm \
  -e BACKUP_DRY_RUN=1 \
  backup
```

---

## 구현 단계

### Step 1 — backup.sh 상태/알림 파일 기록 ✅ DONE (Codex 리뷰 반영 포함)

**파일**: [scripts/backup.sh](../scripts/backup.sh)

- `_status/`, `_alerts/` 디렉토리 자동 생성
- EXIT 트랩 + `BACKUP_OK` 플래그로 성공/실패 판단 (`set -e` 호환)
- 실행 시작 즉시 `status: "running"` 기록 (hung 감지용)
- `BACKUP_STEP` 변수로 실패 단계 추적 → `reasonClass` 매핑
- 원자적 쓰기 (`tmp → mv`)
- dry-run은 `backup-status-dry.json`에만 기록, 운영 파일 불변
- `BACKUP_DRY_RUN_FAIL_REASON` 환경변수: dry-run 실패 시뮬레이션
- `.last_success` / `.last_failure` 사이드카 파일로 cross-run 시각 유지
- dry-run은 사이드카 파일 미갱신
- prune: `acknowledgedAt` + `resolvedAt` 모두 설정 + 90일 경과한 alert만 삭제

---

### Step 2 — backup-monitor 서비스 구현 ✅ DONE

**신규 파일**:
- [services/backup-monitor/index.js](../services/backup-monitor/index.js) — CommonJS, `require.main === module` 가드로 라이브러리/진입점 겸용
- [services/backup-monitor/Dockerfile](../services/backup-monitor/Dockerfile) — `node:20-alpine`, npm 설치 없음
- [services/backup-monitor/__tests__/isStale.test.js](../services/backup-monitor/__tests__/isStale.test.js) — 8 케이스 PASS

**`monitor-report.json` 스키마**:
```json
{
  "checkedAt": "2026-05-13T03:00:00Z",
  "isStale": false,
  "staleThresholdHours": 36,
  "lastSuccessAt": "2026-05-13T02:01:23Z",
  "openAlerts": [],
  "summary": "ok | stale | alert_open | stale_and_alert"
}
```

**순수 함수** (테스트 대상):
```js
// isStale: corrupt/invalid date → Number.isFinite 체크 → fail-closed(true 반환)
function isStale(lastSuccessAt, nowMs, thresholdHours) { ... }

// computeSummary: real(비 dry-run) alert 기준으로 summary 계산
// dry-run alert는 openAlerts에는 포함되지만 summary를 'alert_open'으로 올리지 않음
// summary: 'ok' | 'stale' | 'alert_open' | 'stale_and_alert' | 'dry_run_alert_open'
function computeSummary(stale, realAlertCount, totalAlertCount) { ... }

module.exports = { isStale, computeSummary };
```

**alert 읽기**: `_alerts/FAILED_*.json` 전체 → `resolvedAt === null`인 것만 openAlerts로 포함.
summary 계산 시 `dryRun: true` alert는 realAlertCount에서 제외.

**테스트**: 16 케이스 (isStale 9 + computeSummary 7)

---

### Step 3 — docker-compose.yml 연결 ✅ DONE

**수정 파일**: `docker-compose.yml`

- `backup-monitor` 서비스 추가 (profile 없음, 항상 기동)
- `app` 서비스에 `backup_data:/backups` 볼륨 + `BACKUPS_DIR=/backups` 환경변수 추가

---

### Step 4 — 서버 API ✅ DONE

**신규 파일**: [server/src/routes/opsStatus.ts](../server/src/routes/opsStatus.ts)
**수정 파일**: [server/src/index.ts](../server/src/index.ts) (import + `app.use('/api/admin/ops', createOpsStatusRouter(pool))`)

```
GET  /api/admin/ops/backup-status       → monitor-report.json + backup-status.json 반환, 503 when absent
POST /api/admin/ops/backup-alerts/:runId/ack     → acknowledgedAt/By 설정 (idempotent)
POST /api/admin/ops/backup-alerts/:runId/resolve → resolvedAt/By 설정 (idempotent)
```

- `adminOnly` 미들웨어 사용 (기존 패턴 그대로)
- `VALID_RUN_ID = /^\d{8}_\d{6}$/` — path traversal 방어
- ack/resolve: atomic write (tmp → rename), DB 저장 없음 (볼륨 파일이 단일 진실)

---

### Step 5 — 관리자 UI ✅ DONE

**신규 파일**: [src/core/hooks/useOpsStatus.js](../src/core/hooks/useOpsStatus.js)
- 5분 폴링, admin + authenticated 조건에서만 활성화
- `showBanner`: `['stale', 'alert_open', 'stale_and_alert']` 일 때만 true
- `dry_run_alert_open`은 배너 미발생

**수정**: [src/core/components/AdminConsoleModal.jsx](../src/core/components/AdminConsoleModal.jsx)
- `OpsTab` 컴포넌트 추가 (모니터 리포트 + 백업 상태 + 미처리 alert 목록 + ack/resolve 버튼)
- `TABS`에 `{ id: 'ops', label: '운영 상태' }` 추가

**수정**: [src/App.jsx](../src/App.jsx)
- `useOpsStatus` hook 추가, `showOpsBanner` 파생
- `<button className="ops-alert-banner" ...>` — MainHeader 하단에 렌더링, 클릭 시 관리자 콘솔 오픈

**수정**: [src/index.css](../src/index.css)
- `.ops-alert-banner`, `.admin-card` CSS 추가

---

### Step 6 — OPERATIONS_RUNBOOK.md ✅ DONE

**신규 파일**: [docs/OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md)

포함 내용:
1. 백업 모니터링 구조 다이어그램 + 파일 위치 표
2. summary 값 의미 및 배너 표시 기준
3. 경보 수신 → 원인 파악 → 케이스별 복구 → alert ack/resolve 절차
4. Step 14 검증 6단계 체크리스트 (PASS 기준 포함)
5. 정기 점검 항목 (일/주/월/분기/연 주기)

---

### Step 7 — 테스트 ✅ DONE

**단위 테스트** (`services/backup-monitor/__tests__/isStale.test.js`) — 16건 PASS:
- isStale: null/undefined/empty/35h/36h 경계/37h/커스텀 threshold/부패 날짜 (fail-closed)
- computeSummary: ok/stale/alert_open/stale_and_alert/dry_run_alert_open/혼합

**API 테스트** (`server/src/routes/__tests__/opsBackupStatus.test.ts`) — 17건 PASS:
- GET: 미인증 401, 비관리자 403, 파일 없음 503
- GET: live openAlerts overlay — resolve 직후 즉시 배너 해제 확인
- GET: summary 재계산 — stale+dry-run only → 'stale', 비stale+dry-run → 'dry_run_alert_open'
- POST ack: 미인증 401, 비관리자 403, CSRF 없음 403, 잘못된 runId 400, 없는 파일 404
- POST ack: acknowledgedAt/acknowledgedBy 설정, 멱등성 (재호출 시 writeFile 미호출)
- POST resolve: CSRF 없음 403, resolvedAt/resolvedBy 설정, 멱등성

**UI 테스트**: 수동 검증 (Step 8)으로 커버

---

### Step 8 — 검증 (수동) ✅ DONE (2026-05-15)

**검증 결과**:
- `FAILED_20260515_062108.json` 생성 확인 — `dryRun: true`, `purpose: "step14_verification"`, `reasonClass: "gpg_encrypt_failed"` ✅
- backup-monitor가 alert 감지, `summary: "alert_open"` 반영 ✅
- 관리자 UI 배너 표시 ✅
- ack/resolve 처리 후 배너 사라짐 ✅
- 운영 `backup-status.json`은 dry-run으로 미변경 ✅

**Step 14 판정**: Conditional PASS
- 외부 Slack/메일 알림 없음 (IT 협조 시 T46에서 추가)
- 실제 운영 백업 1회 성공 후 `summary: ok` 확인 권장

> **주의**: 백업 컨테이너의 기본 커맨드는 `crond`이므로, `docker compose run`으로 즉시 실행할 때는
> 반드시 끝에 `sh /scripts/backup.sh`를 명시해야 합니다.

```powershell
# 1. dry-run 실패 alert 생성 (DB/GPG 건드리지 않음)
docker compose run --rm `
  -e BACKUP_DRY_RUN=1 `
  -e BACKUP_DRY_RUN_FAIL_REASON=gpg_encrypt_failed `
  backup sh /scripts/backup.sh

# 2. FAILED_*.json 파일 확인
docker compose exec app cat /backups/_alerts/FAILED_*.json
# → dryRun: true, purpose: "step14_verification", reasonClass: "gpg_encrypt_failed"

# 3. monitor가 alert를 감지했는지 확인 (재시작 후 30초 대기)
docker compose restart backup-monitor
Start-Sleep -Seconds 30
docker compose exec app cat /backups/_status/monitor-report.json
# → summary: "alert_open" 또는 "stale_and_alert"

# 4. 관리자 UI 접속 → 배너 표시 확인

# 5. [확인] 버튼 클릭 → acknowledgedAt 설정 확인
# 6. [해결] 버튼 클릭 → resolvedAt 설정 확인, 배너 사라짐 확인

# 7. 성공 status-file 기록 검증
docker compose run --rm `
  -e BACKUP_DRY_RUN=1 `
  backup sh /scripts/backup.sh
docker compose exec app cat /backups/_status/backup-status-dry.json
# → status: "success", dryRun: true (backup-status.json은 미변경)
```

---

## 영향 받는 파일

| 파일 | 상태 | 내용 |
|------|------|------|
| `scripts/backup.sh` | ✅ DONE | 상태/알림 JSON 기록, dry-run 분리, FAIL_REASON whitelist |
| `services/backup-monitor/index.js` | ✅ DONE | hourly check, isStale, monitor-report.json |
| `services/backup-monitor/Dockerfile` | ✅ DONE | node:20-alpine, 의존성 없음 |
| `docker-compose.yml` | ✅ DONE | backup-monitor 서비스 추가, app에 볼륨 + BACKUPS_DIR |
| `server/src/routes/opsStatus.ts` | ✅ DONE | GET/POST ops 엔드포인트, VALID_RUN_ID 방어 |
| `server/src/index.ts` | ✅ DONE | /api/admin/ops 마운트 |
| `src/core/hooks/useOpsStatus.js` | ✅ DONE | 5분 폴링, showBanner 파생 |
| `src/core/components/AdminConsoleModal.jsx` | ✅ DONE | OpsTab + 운영 상태 탭 |
| `src/App.jsx` | ✅ DONE | ops-alert-banner 렌더링 |
| `src/index.css` | ✅ DONE | .ops-alert-banner, .admin-card CSS |
| `docs/OPERATIONS_RUNBOOK.md` | ✅ DONE | 운영 절차서 (구조·조치·Step14 검증·정기점검) |
| `services/backup-monitor/__tests__/isStale.test.js` | ✅ DONE | isStale 9건 + computeSummary 7건 PASS |
| `server/src/routes/__tests__/opsBackupStatus.test.ts` | ✅ DONE | API 테스트 17건 PASS |

---

## T46 이관 (이번 범위 밖)

- 백업 후 로컬 평문 데이터 정리 정책
- 409 Conflict 자동 alreadySynced 변환 (마이그레이션)
- `migration_local_read` audit 로그 (서버 측)
- backup-monitor → 외부 알림 연동 (이메일/Slack, IT 협조 시)

### backup_alerts 볼륨 전환 절차

`backup_alerts` named volume을 신규 도입했기 때문에, 이미 `backup_data/_alerts/` 하위에 alert 파일이 있는 환경에서는 새 마운트(`backup_alerts:/backups/_alerts`)가 기존 디렉토리를 가립니다.

**초기 운영 환경 (alert 파일 없음)**: 별도 작업 불필요. `docker compose up -d`로 바로 적용.

**이미 alert 파일이 있는 환경**:
```powershell
# 1. 기존 alert 파일 목록 확인
docker compose exec app ls /backups/_alerts/

# 2. 새 볼륨에 파일 복사 (임시 컨테이너 활용)
docker run --rm \
  -v wr-evaluation-unified_backup_data:/src \
  -v wr-evaluation-unified_backup_alerts:/dst \
  alpine sh -c "cp -a /src/_alerts/. /dst/"

# 3. docker compose up -d --force-recreate
```

Step 14 검증용 dry-run alert는 재생성하면 되므로 이전 없이 초기화해도 무방합니다.

### STALE_*.json 미구현 (설계 결정)

`_alerts/STALE_<runId>.json` 형식의 persistent stale alert 파일은 구현하지 않음.
`monitor-report.json`의 `isStale: true` + `summary: "stale"` 필드가 동일 목적을 수행하며,
모니터가 매 시간 재계산하므로 별도 파일 없이도 staleness 상태가 정확히 반영됨.
필요 시 T46에서 stale alert 파일 도입 검토.
