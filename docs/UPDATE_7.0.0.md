# v6.x → v7.0.0 업데이트 절차

이미 v6.x(v6.5.4 기준)가 운영 중인 인트라넷 서버를 v7.0.0으로 업데이트하는 절차. 형식은 [UPDATE_5.1.0.md](UPDATE_5.1.0.md)를 따른다.

## 무엇이 바뀌나

- **서버**: 통계분석 워크벤치(인트라넷 전용, **기본 비활성**) — Python 통계 엔진·`@wr/analytics-core`·`/api/stats/*`·`/api/capabilities/*` 추가. 환자 완료시각 서버 재검증 추적. 영상 분석 UI·상병 입력·등록 마법사 등 클라이언트 개선(서버가 SPA를 서빙하므로 서버 업데이트만으로 반영).
- **DB 스키마**: **마이그레이션 6건(0028~0033) 신규** — 서버 기동 시 미적용분이 순차 자동 적용된다(별도 명령 불필요). 업데이트 전 백업 필수.
  - 0028 `capabilities`·`user_capability_grants`(+`users(id, organization_id)` 유니크 제약), 0029·0030 `patient_records` 완료시각 컬럼, 0031·0032·0033 `stats_runs` 테이블·비동기 큐(CHECK 제약 재정의 포함)
  - 기존 환자 행은 보존되며 새 컬럼은 비어 있는 상태로 시작한다(완료시각은 업데이트 이후부터 쌓인다).
- **이미지**: `wr-app-server`에 Python 통계 venv(`/opt/stats-venv`)가 추가돼 커졌다 — app 이미지 약 2.75GB(v6.5.4는 2.22GB), venv 약 391MB. 서버 디스크 여유를 확인한다.
- **환경변수**: `.env.production`에서
  - **`WR_VERSION=7.0.0` (필수)** — compose가 `wr-app-server`·`wr-backup-monitor`·`wr-backup` 세 이미지를 모두 `:${WR_VERSION}`으로 찾는다. 안 바꾸면 7.0.0 이미지를 로드해도 컨테이너는 구버전을 계속 쓴다.
  - **`STATS_WORKBENCH_ENABLED=true` (선택)** — 통계분석 워크벤치를 켤 때만 추가. 기본값 false면 `/api/stats/*` 전체가 404이고 화면 버튼도 나타나지 않는다. 켜지 않아도 업데이트·마이그레이션은 동일하게 적용된다.
  - `STATS_ENGINE_*`·`STATS_MAX_CONCURRENT_ANALYZE_REQUESTS`·`STATS_RUNS_RESULT_TTL_HOURS`는 선택(기본값 사용 권장, [.env.production.example](../.env.production.example) 참고). `STATS_ASYNC_*` 등은 compose가 컨테이너에 전달하지 않아 설정해도 적용되지 않는다(코드 기본값 고정).
- **네트워크·인증서**: 변경 없음 (Caddy·포트 8080/8443 그대로).
- **클라이언트(Electron)**: **재설치 불필요.** 인트라넷 Electron은 서버가 서빙하는 SPA를 로드하므로 통계 화면·"통계분석" 버튼(헤더/랜딩)은 서버 업데이트만으로 기존 클라이언트에도 나타난다. 새 설치본(7.0.0)에는 네이티브 메뉴 "통계분석 워크벤치" 항목이 추가됐을 뿐이며, 구 설치본은 이 메뉴만 없고 오류 없이 동작한다. 신규 PC에는 패키지의 7.0.0 설치본을 쓴다.

## 예상 다운타임

- **서버**: 수십 초 (app 컨테이너 재생성 + 마이그레이션 적용. 빈 DB가 아니므로 `ALTER TABLE`/제약 추가에 짧은 락이 걸릴 수 있으나 인트라넷 규모에서는 순간적). postgres/caddy는 영향 없음.
- **클라이언트 PC**: 없음(웹 리소스는 서버에서 로드, 새로고침으로 반영).

## 사전 준비

### 0) 현재 운영 환경 정보 파악

[UPDATE_5.1.0.md](UPDATE_5.1.0.md)의 "0) 현재 운영 환경 정보 파악"과 동일하게 compose 프로젝트 이름(`-p`, 보통 `wr-prod`)과 운영 `.env.production` 경로, 현재 `WR_VERSION`을 확인한다.

```powershell
docker compose ls
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"      # 예: wr-app-server:6.5.4
$installDir = docker inspect wr-prod-app-1 --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
Get-Content (Join-Path $installDir ".env.production") | Select-String "WR_VERSION|STATS_"
```

### 1) 패키지 이송·무결성 검증

- `release\wr-evaluation-unified-7.0.0-intranet.zip`을 서버로 복사하고 압축을 푼다(디스크 여유 필요: 이미지 로드 시 app 이미지 약 2.75GB).
- 무결성 검증은 [UPDATE_5.1.0.md](UPDATE_5.1.0.md) "2) 무결성 검증"(SHA256SUMS)과 동일. `release-manifest.json`의 `version`이 7.0.0인지, 이미지 3종이 모두 7.0.0 태그인지 확인한다.

### 2) (필수) 업데이트 직전 DB 백업

마이그레이션 6건이 적용되므로 **업데이트 전 백업을 반드시** 만든다. 롤백 시 DB 복원이 필요해질 수 있다(아래 "롤백 절차").

```powershell
docker compose -p wr-prod --profile backup run --rm backup /scripts/backup.sh
```

`_status\last-success.txt`에 새 백업 시각이 찍히는지 확인한다.

### 3) (필수) .env.production 수정

```
# === WR_VERSION (필수) ===
# 수정 전:   WR_VERSION=6.5.4
# 수정 후:   WR_VERSION=7.0.0

# === 통계분석 워크벤치를 켤 때만 추가 (선택) ===
STATS_WORKBENCH_ENABLED=true
```

수정 후 다시 확인:

```powershell
Get-Content "<env경로>" | Select-String "WR_VERSION|STATS_WORKBENCH_ENABLED"
```

---

## 업데이트 절차

### A. 서버 업데이트

서버에서 PowerShell 관리자 권한으로:

```powershell
# 1. 새 패키지 폴더로 이동
cd C:\wr\wr-evaluation-unified-7.0.0-intranet

# 2. 새 Docker 이미지 로드
.\scripts\import-images.ps1

# 3. 로드된 이미지 확인 (wr-app-server / wr-backup-monitor / wr-backup 모두 7.0.0)
docker images | Select-String "wr-app-server|wr-backup"

# 4. 컨테이너 재생성 — 세 이미지가 모두 7.0.0 태그로 바뀌므로 app만이 아니라 전체를 올린다
docker compose `
  -p wr-prod `
  --env-file <운영 .env.production 절대경로> `
  -f docker-compose.yml -f docker-compose.prod.yml `
  --profile backup up -d
```

정상이면 `Recreate wr-prod-app-1`(및 backup-monitor/backup)이 출력된다. app 관련 출력이 없으면 `WR_VERSION`이 아직 6.x로 남아 있는 것이다.

### B. 서버 헬스 체크

```powershell
# 1. ★가장 중요★ app 이미지 태그
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"      # → wr-app-server:7.0.0

# 2. 전체 컨테이너 상태
docker ps --filter "name=wr-prod" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

# 3. 마이그레이션 적용 확인 (0033까지, 33행)
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select count(*), max(filename) from schema_migrations"
# → 33|0033_stats_runs_async_queue.sql

# 4. 부팅 로그에서 마이그레이션·워커 확인
docker logs wr-prod-app-1 --tail 60 | Select-String "migrate|stats-runs-queue|error"
# → [migrate] Applied: 0028_… ~ 0033_…, (통계 활성화 시) [wr-server] stats-runs-queue worker enabled

# 5. app health / Caddy 경유 헬스
docker exec wr-prod-app-1 wget -qO- http://localhost:3001/health
curl.exe -k -o NUL -w "8443: %{http_code}`n" https://localhost:8443/health
```

### C. 통계분석 워크벤치 활성화 확인 (`STATS_WORKBENCH_ENABLED=true`로 켠 경우)

```powershell
# 통계 엔진 Python venv 동작 (네트워크 없이 baked venv로 계산 가능한지)
docker exec wr-prod-app-1 /opt/stats-venv/bin/python /app/stats-engine/analyze.py --selfcheck
# → stats-engine selfcheck OK

# 서버 설정 노출 여부 (비로그인 공개 설정)
curl.exe -k https://localhost:8443/api/config/public
# → "statsWorkbenchAvailable": true
```

브라우저/Electron에서 로그인한 뒤 헤더 또는 랜딩 화면에 **"통계분석"** 버튼이 보이면 활성화된 것이다. 일반 의사 계정도 **grant 없이** 열람·분석·집계 결과 내보내기를 쓸 수 있다(기본 허용 권한). 분석 응답에 이상치 원값·산점도 원시 점·회귀 관측치 진단값 같은 **제한 행데이터 필드**를 포함하려면 관리자 콘솔 "통계 권한" 탭에서 해당 사용자에게 `stats.export_limited_rows`를 부여한다(행 단위 CSV·PHI 내보내기는 아직 없다).

### D. 클라이언트 PC

기존 PC는 **별도 조치가 필요 없다.** 새로고침(또는 앱 재시작)하면 서버의 새 화면이 로드된다. 네이티브 메뉴 "통계분석 워크벤치"까지 쓰려면 7.0.0 설치본(`직업성 질환 통합 평가 프로그램 Setup 7.0.0.exe`)을 설치한다. 점진 배포는 Electron 자동 업데이트(`update-policy.json`·canary 채널, [INTRANET_DEPLOYMENT.md](INTRANET_DEPLOYMENT.md) "자동 업데이트")를 쓸 수 있다.

---

## 검증 시나리오

| 시나리오 | 기대 결과 |
|---|---|
| 기존 환자 열기·저장 | 정상(기존 데이터 보존, 완료시각 컬럼은 이후부터 쌓임) |
| 신규 환자 등록 마법사에서 필수값 누락 | 요약 목록·필드별 안내가 표시되고 이동은 허용 |
| 상병 입력에서 긴 진단명 | 잘리지 않고 줄바꿈, 진단코드:진단명 폭 1:3 |
| (활성화 시) 헤더 "통계분석" → 변수 선택 → 기술통계 실행 | 결과·히스토그램·박스플롯 표시 |
| (활성화 시) 이변량/회귀/예측 실행, 결과 CSV 내보내기 | 기술통계·회귀·예측 CSV 성공, 이변량·상관행렬은 "아직 지원하지 않습니다" 안내가 정상 |
| (활성화 시) 단시간 반복 실행 | 분당 20회 초과 시 429, 같은 코호트 반복 질의가 많으면 결과가 억제될 수 있음 — 모두 설계된 보호 동작 |
| (비활성) 헤더 | "통계분석" 버튼 없음, `/api/stats/*`는 404 |

---

## 롤백 절차

롤백은 **앱 이미지 되돌리기**와 **DB 복원**을 구분한다.

### 1) 앱 이미지만 되돌리기 (대부분의 경우 충분)

```powershell
# .env.production: WR_VERSION=7.0.0 → WR_VERSION=6.5.4 (STATS_WORKBENCH_ENABLED 줄은 지우거나 false)
cd C:\wr\wr-evaluation-unified-6.5.4-intranet
docker images | Select-String "wr-app-server:6.5.4"      # 없으면 6.5.4 패키지에서 .\scripts\import-images.ps1
docker compose -p wr-prod --env-file <env경로> -f docker-compose.yml -f docker-compose.prod.yml --profile backup up -d
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"      # → wr-app-server:6.5.4
```

마이그레이션 0028~0033은 **이미 적용된 상태로 DB에 남는다**(되돌리는 down 마이그레이션 없음). 추가된 테이블·컬럼은 구버전 앱이 사용하지 않아 구버전 앱은 그대로 동작한다(릴리즈 사전 검증에서 6.5.4 앱을 0033 스키마 DB에 붙여 마이그레이션 없이 기동하고 로그인·환자 목록이 정상임을 확인했다). 이 상태에서 다시 7.0.0으로 올려도 재적용이 필요 없다.

### 2) DB 복원 (스키마/데이터 자체에 문제가 있을 때만)

[BACKUP_RESTORE.md](BACKUP_RESTORE.md) 절차로 **업데이트 전 백업**을 복원한다. 복원하면 **그 백업 시각 이후의 모든 변경(환자 저장·편집, 통계 실행 기록, grant 등)이 사라진다.** 복원 후에는 `WR_VERSION`도 6.x로 되돌려야 하며, 복원 전에 현재 DB를 별도로 한 번 더 백업해 두는 것을 권장한다.

클라이언트 PC는 되돌릴 것이 없다(구 설치본·신 설치본 모두 서버가 서빙하는 화면을 쓴다).

---

## 알려진 함정

### `up -d` 실행했는데 컨테이너가 6.x 그대로
**원인**: `.env.production`의 `WR_VERSION`이 6.x로 남아 있음. **해결**: 사전 준비 3번대로 수정 후 다시 실행.

### 통계분석 버튼이 안 보임 / `/api/stats/*`가 404
**원인**: `STATS_WORKBENCH_ENABLED`가 true가 아니거나(기본 false) `DEPLOYMENT_MODE`가 intranet이 아님, 또는 통계 엔진 런타임이 비정상. **해결**: env 값을 확인하고 `docker logs wr-prod-app-1`·`--selfcheck`로 엔진 상태를 본다. 404는 기능 존재를 숨기는 설계이며 권한 오류(403)와 다르다.

### 분석 결과가 "억제됨"으로 나옴
**원인**: 최소 코호트(10명) 미만 셀이거나, 같은 사용자가 짧은 시간(15분)에 같은 코호트를 반복 질의해 차분 방지 예산(family 30회·전역 100쿼리)을 소진. **해결**: 정상 보호 동작이다. 코호트를 넓히거나 15분 뒤 다시 시도한다.

### 컨테이너 메모리 부족(OOM)
통계 엔진은 app 컨테이너(메모리 6g·CPU 4 상한)에서 영상 분석과 함께 돈다. 영상 분석과 통계를 동시에 많이 쓰는 환경이면 `APP_MEM_LIMIT`을 점검한다([OFFLINE_DEPLOYMENT_PACKAGE.md](OFFLINE_DEPLOYMENT_PACKAGE.md) §14).

---

## 참고

- 변경 이력: [PRD.md](PRD.md) v7.0.0, [README.md](../README.md) 변경 이력 v7.0.0
- 통계분석 워크벤치 상세: [PRD.md](PRD.md) §12.C
- 통계 엔진 활성화·검증: [OFFLINE_DEPLOYMENT_PACKAGE.md](OFFLINE_DEPLOYMENT_PACKAGE.md) §16
- 신규 설치 가이드: [OFFLINE_DEPLOYMENT_PACKAGE.md](OFFLINE_DEPLOYMENT_PACKAGE.md), 백업/복구: [BACKUP_RESTORE.md](BACKUP_RESTORE.md)
