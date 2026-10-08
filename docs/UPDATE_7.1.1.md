# v6.x / v7.0.0 / v7.1.0 → v7.1.1 업데이트 절차

이미 인트라넷 서버가 운영 중인 환경을 v7.1.1로 올리는 절차. 형식은 [UPDATE_5.1.0.md](UPDATE_5.1.0.md)·[UPDATE_7.0.0.md](UPDATE_7.0.0.md)를 따른다.

> **출발 버전 확인이 먼저다.** v7.0.0·v7.1.0은 패키지만 만들어졌고 운영에 배포되지 않았다면, 현재 운영 버전은 v6.5.4다. 이 경우 v7.0.0의 변경(통계 워크벤치·마이그레이션 0028~0033)이 이번 업데이트에 **함께** 들어간다. 현재 버전은 아래 "0) 현재 운영 환경 정보 파악"으로 확인한다.

## 무엇이 바뀌나

- **서버(=클라이언트 화면 포함)**: 서버가 SPA를 서빙하므로 서버 업데이트만으로 화면이 바뀐다.
  - 직력별 **"신체부담평가 포함/미포함"** 라디오(직력 카드), 6개 모듈 평가·결과·완료 판정 반영 (#140)
  - EMR·엑셀 **"확인 상병"** 칸을 종합소견에서 "확인"으로 입력한 상병만 내보내도록 변경 (#139)
  - 통계 워크벤치: 미포함 직력의 신체부담 변수 제외(카탈로그 v29, #141), 범주형 소수 범주 "기타" 병합·원본 범주 빈도(#137), 권한자 원본 히스토그램 경계 정렬(#138), 히스토그램 끝 구간 병합(7.1.0, #135)
  - 자세한 내용: [README.md](../README.md) 변경 이력 v7.1.1 / v7.1.0 / v7.0.0
- **DB 스키마**: 서버 기동 시 미적용 마이그레이션이 순차 자동 적용된다(별도 명령 불필요). **업데이트 전 백업 필수.**

  | 출발 버전 | 적용되는 마이그레이션 | 내용 |
  |---|---|---|
  | v6.5.4 | 0028~0035 (8건) | 0028 통계 권한 테이블, 0029·0030 환자 완료시각 컬럼, 0031~0033 `stats_runs`·비동기 큐, 0034·0035 권한 표시명 UPDATE |
  | v7.0.0 | 0034·0035 (2건) | `capabilities`의 `stats.export_limited_rows` 표시명·설명 UPDATE(키·grant 불변) |
  | v7.1.0 | 0035 (1건) | 위와 같은 표시명을 "제한 데이터 열람(원본 값·원본 분포)"로 확장 |

  - 7.1.1에서 **새로 추가된 마이그레이션은 0035 하나**이며, 직력 미포함 플래그는 환자 `shared` JSON 안의 선택 필드라 **스키마 변경이 없다**(기존 환자 행에 값을 채우거나 바꾸지 않는다).
- **환경변수**: `.env.production`에서
  - **`WR_VERSION=7.1.1` (필수)** — compose가 `wr-app-server`·`wr-backup-monitor`·`wr-backup` 세 이미지를 모두 `:${WR_VERSION}`으로 찾는다. 안 바꾸면 7.1.1 이미지를 로드해도 컨테이너는 구버전을 계속 쓴다.
  - **`STATS_WORKBENCH_ENABLED=true` (선택)** — 통계 워크벤치를 켤 때만. 이미 켜 둔 환경은 그대로 둔다. v6.x에서 올라오는 경우 기본값(false)이면 `/api/stats/*` 전체가 404이고 화면 버튼도 나타나지 않는다.
  - 그 밖의 `STATS_*` 변수는 선택(기본값 권장, [.env.production.example](../.env.production.example) 참고).
- **이미지 크기**: `wr-app-server`에 Python 통계 venv(`/opt/stats-venv`)가 포함돼 v6.5.4(2.22GB)보다 크다(7.0.0 기준 약 2.75GB). v7.0.0에서 올라오는 경우 크기 변화는 크지 않다. 서버 디스크 여유를 확인한다.
- **네트워크·인증서**: 변경 없음 (Caddy·포트 8080/8443 그대로).
- **클라이언트(Electron)**: **재설치 불필요.** 인트라넷 Electron은 서버가 서빙하는 SPA를 로드한다. 7.0.0 이후 Electron 셸·EMR 헬퍼(`EmrHelper.cs`) 코드는 바뀌지 않았다. 신규 PC에는 패키지의 7.1.1 설치본을 쓴다.
  - **EMR 주입으로 달라지는 값(확인 상병, `[직업력]`)은 서버 배포 후 클라이언트를 새로고침/재시작해야 반영**된다.

## 예상 다운타임

- **서버**: 수십 초 (app 컨테이너 재생성 + 마이그레이션 적용). postgres/caddy는 영향 없음. v6.5.4에서 올라올 때는 `ALTER TABLE`/제약 추가에 짧은 락이 걸릴 수 있으나 인트라넷 규모에서는 순간적이다.
- **클라이언트 PC**: 없음(새로고침으로 반영). 작업 중이던 환자 화면은 저장 후 새로고침한다.

## 사전 준비

### 0) 현재 운영 환경 정보 파악

compose 프로젝트 이름(`-p`, 보통 `wr-prod`)과 운영 `.env.production` 경로, 현재 `WR_VERSION`을 확인한다([UPDATE_5.1.0.md](UPDATE_5.1.0.md) "0)"과 동일).

```powershell
docker compose ls
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"      # 예: wr-app-server:6.5.4
$installDir = docker inspect wr-prod-app-1 --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
Get-Content (Join-Path $installDir ".env.production") | Select-String "WR_VERSION|STATS_"
```

### 1) 패키지 이송·무결성 검증

- `release\wr-evaluation-unified-7.1.1-intranet.zip`을 서버로 복사하고 압축을 푼다(이미지 로드 시 app 이미지 약 2.75GB 이상의 디스크 여유 필요).
- 무결성 검증은 [UPDATE_5.1.0.md](UPDATE_5.1.0.md) "2) 무결성 검증"(SHA256SUMS)과 동일. `release-manifest.json`의 `version`이 7.1.1인지, 이미지 3종이 모두 7.1.1 태그인지, `electron/`의 `latest.yml` 버전이 7.1.1인지 확인한다.

### 2) (필수) 업데이트 직전 DB 백업

```powershell
docker compose -p wr-prod --profile backup run --rm backup /scripts/backup.sh
```

`_status\last-success.txt`에 새 백업 시각이 찍히는지 확인한다. 롤백 시 DB 복원이 필요해질 수 있다(아래 "롤백 절차").

### 3) (필수) .env.production 수정

```
# === WR_VERSION (필수) ===
# 수정 전:   WR_VERSION=6.5.4   (또는 7.0.0 / 7.1.0)
# 수정 후:   WR_VERSION=7.1.1

# === 통계 워크벤치를 새로 켤 때만 (선택, 이미 켜 둔 환경은 유지) ===
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
cd C:\wr\wr-evaluation-unified-7.1.1-intranet

# 2. 새 Docker 이미지 로드
.\scripts\import-images.ps1

# 3. 로드된 이미지 확인 (wr-app-server / wr-backup-monitor / wr-backup 모두 7.1.1)
docker images | Select-String "wr-app-server|wr-backup"

# 4. 컨테이너 재생성 — 세 이미지가 모두 7.1.1 태그로 바뀌므로 app만이 아니라 전체를 올린다
docker compose `
  -p wr-prod `
  --env-file <운영 .env.production 절대경로> `
  -f docker-compose.yml -f docker-compose.prod.yml `
  --profile backup up -d
```

정상이면 `Recreate wr-prod-app-1`(및 backup-monitor/backup)이 출력된다. app 관련 출력이 없으면 `WR_VERSION`이 아직 이전 값으로 남아 있는 것이다.

### B. 서버 헬스 체크

```powershell
# 1. ★가장 중요★ app 이미지 태그
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"      # → wr-app-server:7.1.1

# 2. 전체 컨테이너 상태
docker ps --filter "name=wr-prod" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

# 3. 마이그레이션 적용 확인 (0035까지, 35행)
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select count(*), max(filename) from schema_migrations"
# → 35|0035_capability_limited_rows_label_v2.sql

# 4. 부팅 로그에서 마이그레이션·워커 확인
docker logs wr-prod-app-1 --tail 60 | Select-String "migrate|stats-runs-queue|error"
# → [migrate] Applied: 미적용분 (v6.5.4 출발=0028_… ~ 0035_…, v7.0.0=0034·0035, v7.1.0=0035),
#   (통계 활성화 시) [wr-server] stats-runs-queue worker enabled

# 5. app health / Caddy 경유 헬스
docker exec wr-prod-app-1 wget -qO- http://localhost:3001/health
curl.exe -k -o NUL -w "8443: %{http_code}`n" https://localhost:8443/health
```

### C. 통계 워크벤치 확인 (`STATS_WORKBENCH_ENABLED=true`인 경우)

```powershell
docker exec wr-prod-app-1 /opt/stats-venv/bin/python /app/stats-engine/analyze.py --selfcheck
# → stats-engine selfcheck OK

curl.exe -k https://localhost:8443/api/config/public
# → "statsWorkbenchAvailable": true
```

- 원본 값·원본 분포(이상치 원값·산점도 원시 점·회귀 관측치 진단값·원본 히스토그램·원본 범주 빈도)를 볼 사용자에게는 관리자 콘솔 **"통계 권한" 탭 → "제한 데이터 열람(원본 값·원본 분포)"**(`stats.export_limited_rows`)을 부여한다. 이미 부여된 사용자는 키가 같아 그대로 유지된다. 기본 허용 3종(열람·분석·집계 내보내기)은 grant가 필요 없다.
- **카탈로그 v29 / 결과 스키마 v10**: 업데이트 후 첫 분석부터 새 규칙으로 계산되며 이전 실행 결과 캐시는 재사용되지 않는다.

### D. 클라이언트 PC

기존 PC는 **별도 조치가 필요 없다.** 새로고침(또는 앱 재시작)하면 서버의 새 화면이 로드된다. 신규 PC는 패키지의 7.1.1 설치본(`직업성 질환 통합 평가 프로그램 Setup 7.1.1.exe`)을 설치한다. 점진 배포는 Electron 자동 업데이트(`update-policy.json`·canary 채널, [INTRANET_DEPLOYMENT.md](INTRANET_DEPLOYMENT.md) "자동 업데이트")를 쓸 수 있다.

---

## 검증 시나리오

| 시나리오 | 기대 결과 |
|---|---|
| 기존 환자 열기·저장 | 정상(기존 데이터 보존). 직력은 모두 "신체부담평가 포함"으로 보이고 평가 결과가 업데이트 전과 같다 |
| 직력 카드에서 한 직력을 "미포함"으로 변경 | 카드 음영·배지 표시. 6개 모듈 화면의 직력 탭·입력 카드에서 해당 직력이 사라지고 결과 수치에서 빠진다. 다시 "포함"으로 바꾸면 입력해 둔 값이 그대로 복원 |
| 모든 직력을 "미포함"으로 변경 | 각 모듈이 "평가 대상 없음"으로 완료 처리(상병 평가 입력은 여전히 필요). 결과·종합소견에 "※ 모든 직력이 신체부담평가에서 제외되어 평가 대상 없음" 한 줄 |
| 종합소견 미리보기·엑셀 "4.직업적 요인"·EMR 직업력 | 미포함 직력은 가장 끝에 `신체부담평가에는 미포함` 표기, 포함 직력은 직력1..k로 모듈 블록 번호와 일치 |
| 종합소견에서 상병 일부만 "확인" 입력 후 엑셀 "3.최종 확인 상병명" | 확인한 상병만 출력. 양측 상병에서 한쪽만 확인이면 `(우)`/`(좌)` |
| **병원 EMR 주입** (확인 상병 / 직업력) | `txtAppv_Sick_Cont`에 확인 상병만 입력, `[직업력]`에 미포함 표기. 확인 상병 0건이면 전송 전 경고(EMR에 이미 입력된 값은 남음) — 정상 동작 |
| (통계 활성화 시) 신체부담 변수로 기술통계, 미포함 직력이 있는 환자 포함 | 미포함 직력은 해당 변수에서 `not_applicable`, `job.identity.*`(직종명·근속)는 그대로 집계 |
| (통계 활성화 시) 범주형 변수 기술통계 | 소수 범주(1~9명)가 "기타"로 병합. 권한자는 원본 범주 빈도가 추가로 보임 |

> **이번 릴리스에서 사전 검증하지 못한 것**: 서버 DB 통합 테스트, 도커 postgres 종단(Tier-3) 확인, **병원 EMR 실제 주입**. 단위 테스트·빌드·화면 동작은 개발 환경에서 확인했다. EMR 항목은 업데이트 직후 한두 환자로 먼저 확인하고 전체 사용을 시작할 것을 권장한다.

---

## 롤백 절차

롤백은 **앱 이미지 되돌리기**와 **DB 복원**을 구분한다.

### 1) 앱 이미지만 되돌리기 (대부분의 경우 충분)

```powershell
# .env.production: WR_VERSION=7.1.1 → 이전 버전 (예: 6.5.4). STATS_WORKBENCH_ENABLED 줄은 지우거나 false
cd C:\wr\wr-evaluation-unified-<이전 버전>-intranet
docker images | Select-String "wr-app-server:<이전 버전>"      # 없으면 이전 패키지에서 .\scripts\import-images.ps1
docker compose -p wr-prod --env-file <env경로> -f docker-compose.yml -f docker-compose.prod.yml --profile backup up -d
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"
```

마이그레이션은 **이미 적용된 상태로 DB에 남는다**(down 마이그레이션 없음). 0034·0035는 표시명 UPDATE뿐이고 새 테이블·컬럼은 구버전 앱이 사용하지 않는다. 7.0.0 → 6.5.4 롤백 시 0028~0033 스키마에서 구버전 앱이 동작함은 v7.0.0 릴리즈 사전 검증에서 확인했다.

**직력 미포함 플래그에 대한 주의**: 구버전(7.1.0 이하) 앱은 `excludeFromAnalysis`를 모르므로 미포함으로 설정된 직력도 **평가 대상으로 취급**한다. 이 플래그가 이미 설정된 환자를 구버전에서 저장했을 때 플래그가 유지되는지는 검증하지 않았다. 롤백이 필요하면 가능한 한 빨리 7.1.1로 다시 올리고, 그 사이 편집한 환자는 플래그를 확인한다.

### 2) DB 복원 (스키마/데이터 자체에 문제가 있을 때만)

[BACKUP_RESTORE.md](BACKUP_RESTORE.md) 절차로 **업데이트 전 백업**을 복원한다. 복원하면 **그 백업 시각 이후의 모든 변경(환자 저장·편집, 통계 실행 기록, grant 등)이 사라진다.** 복원 후에는 `WR_VERSION`도 이전 값으로 되돌려야 하며, 복원 전에 현재 DB를 별도로 한 번 더 백업해 두는 것을 권장한다.

---

## 알려진 함정·한계

### `up -d` 실행했는데 컨테이너가 이전 버전 그대로
**원인**: `.env.production`의 `WR_VERSION`이 이전 값으로 남아 있음. **해결**: 사전 준비 3번대로 수정 후 다시 실행.

### 통계 버튼이 안 보임 / `/api/stats/*`가 404
**원인**: `STATS_WORKBENCH_ENABLED`가 true가 아니거나 `DEPLOYMENT_MODE`가 intranet이 아님, 또는 통계 엔진 런타임이 비정상. **해결**: env 값을 확인하고 `docker logs wr-prod-app-1`·`--selfcheck`로 엔진 상태를 본다. 404는 기능 존재를 숨기는 설계이며 권한 오류(403)와 다르다.

### 직력 카드에서 "미포함"을 선택할 수 없음
**원인**: 구형 직업 필드(`modules.knee.jobs`, 척추의 `jobName`·`careerYears`·`careerMonths`·`workDaysPerYear`)가 `shared.jobs`와 함께 남은 환자는 직력과 연결을 확정할 수 없어 UI에서 선택을 막고 플래그를 무력화한다. **해결**: 의도된 보호 동작이다. 정상적으로 마이그레이션된 환자에는 해당하지 않는다.

### EMR 확인 상병이 비어 있는데 EMR 칸에는 값이 남아 있음
**원인**: 확인 상병이 0건이면 EMR 헬퍼가 빈 값을 건드리지 않아, 이전 전송으로 입력된 값이 EMR에 그대로 남는다. 전송 전 경고가 이를 알린다. **해결**: 병원 정책상 비워도 되므로 필요하면 EMR에서 직접 지운다(헬퍼 변경 없음).

### 일괄 입력 양식을 다시 가져오면 "미포함"이 풀림
일괄 양식 엑셀은 raw 데이터 export라 미포함 직력도 행에 들어가지만, 그 파일을 다시 가져오면 미포함 설정은 "포함"으로 돌아간다(알려진 한계).

### 저장해 둔 통계 레시피 재실행 시 값이 달라짐
미포함 직력이 있는 환자의 신체부담 변수 값이 바뀔 수 있다(실행 결과 캐시만 버전으로 분리되며 레시피 자체는 카탈로그 버전을 갖지 않는다).

### 분석 결과가 "억제됨"으로 나옴
최소 코호트(10명) 미만 셀이거나 같은 사용자가 짧은 시간에 같은 코호트를 반복 질의해 차분 방지 예산을 소진한 경우다. 정상 보호 동작이며 코호트를 넓히거나 시간을 두고 다시 시도한다.

---

## 참고

- 변경 이력: [README.md](../README.md) 변경 이력 v7.1.1, [PRD.md](PRD.md) v7.1.1
- 직력 미포함 데이터 모델: [DOMAIN_SCHEMA.md](DOMAIN_SCHEMA.md) §9.4, [MODULE_STORAGE_CONVENTIONS.md](MODULE_STORAGE_CONVENTIONS.md)
- 통계 워크벤치 활성화·검증: [OFFLINE_DEPLOYMENT_PACKAGE.md](OFFLINE_DEPLOYMENT_PACKAGE.md) §16, 이전 단계 절차: [UPDATE_7.0.0.md](UPDATE_7.0.0.md)
- 신규 설치 가이드: [OFFLINE_DEPLOYMENT_PACKAGE.md](OFFLINE_DEPLOYMENT_PACKAGE.md), 백업/복구: [BACKUP_RESTORE.md](BACKUP_RESTORE.md)
