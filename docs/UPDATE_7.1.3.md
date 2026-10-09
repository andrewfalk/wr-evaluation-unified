# v7.1.1 → v7.1.3 업데이트 절차

이미 v7.1.1이 운영 중인 인트라넷 서버를 v7.1.3으로 올리는 절차. 형식은 [UPDATE_5.1.0.md](UPDATE_5.1.0.md)·[UPDATE_7.0.0.md](UPDATE_7.0.0.md)·[UPDATE_7.1.1.md](UPDATE_7.1.1.md)를 따른다.

> **v7.1.2는 운영에 배포된 적이 없다.** 운영은 v7.1.1까지만 올라가 있으므로, 이번 업데이트에는 v7.1.2(#143~#147)와 v7.1.3(#150~#155)의 변경이 **한꺼번에** 들어간다. 출발 버전이 v7.1.1이 맞는지는 아래 "0) 현재 운영 환경 정보 파악"으로 먼저 확인한다. v7.0.0 이하에서 올라오는 경우는 이 문서가 아니라 [UPDATE_7.1.1.md](UPDATE_7.1.1.md)(그리고 그 이전 문서)의 안내를 먼저 따라야 한다.
> 운영이 이미 v7.1.2라면 이 문서에서 **마이그레이션은 0037 하나만** 새로 적용된다(0036은 이미 적용돼 있다). 나머지 절차는 같다.

## 무엇이 바뀌나

- **서버(=클라이언트 화면 포함)**: 서버가 SPA를 서빙하므로 서버 업데이트만으로 화면이 바뀐다.
  - **제한 데이터 열람 권한자의 소수 셀(1~9명) 해제가 모든 분석으로 확대**됐다(#145·#150~#153). v7.1.1에서는 어떤 분석에서도 해제되지 않았고, 이번에 **기술통계·회귀·이변량·상관행렬·예측** 전부에 적용된다. 풀리는 것은 소수 인원 때문에 가려지던 부분뿐이고, 통계적 계산 가능 조건(최소 인원·EPV·반복측정 등)과 반복 질의 차단은 그대로다. 해제된 화면에는 "소수 인원(10명 미만) 보호가 해제된 결과" 배너가 뜬다. 권한이 없는 사용자의 화면과 결과는 바뀌지 않는다.
  - 예측이 추정 불가일 때 권한자에게 **완전사례 기준 전체·사건·비사건 인원**과 필요 기준(50·25·25명)을 표로 보여 준다(#155).
  - 통계 워크벤치 **무릎 노출 변수 4종 개편**(카탈로그 v30·v31, #146·#147): 직업력 단순합이던 쪼그려앉기·중량물 변수가 직력 **기간 가중평균·누적**으로 바뀌었다. 옛 변수 `knee.case.sumSquattingMinutesPerDay`·`knee.case.sumDailyLoadKg`는 삭제됐다.
  - 대표 직종명(`job.rollup.longestTenureJobNameNormalized`)을 상병(disease) 단위 분석에서도 선택할 수 있다(#146).
  - 자세한 내용: [README.md](../README.md) 변경 이력 v7.1.3 / v7.1.2
- **DB 스키마**: 서버 기동 시 미적용 마이그레이션 **2건(0036·0037)**이 자동 적용된다(별도 명령 불필요). **업데이트 전 백업 필수.**
  - **0036**: `capabilities`의 `stats.export_limited_rows` 설명 문구 UPDATE뿐이다(키·표시명·grant 불변).
  - **0037**: `stats_runs.limited_result`(JSONB, NULL 허용) 컬럼과 CHECK 제약 2개를 추가한다. 상관행렬·예측은 성공 직후 원본 행을 지워 조회 때 다시 계산할 수 없어서, 권한자가 **실행**할 때만 해제본을 이 컬럼에 함께 저장한다. 기존 행은 모두 `requested_disclosure_profile='aggregate'`라 제약을 그대로 통과하고 컬럼은 NULL로 남는다.
    - CHECK 1: `limited_result`는 성공한 실행에만 있을 수 있다.
    - CHECK 2: `requested_disclosure_profile`은 `aggregate` 또는 `lift_eligible`만 허용한다.
- **환경변수**: `.env.production`에서
  - **`WR_VERSION=7.1.3` (필수)** — compose가 `wr-app-server`·`wr-backup-monitor`·`wr-backup` 세 이미지를 모두 `:${WR_VERSION}`으로 찾는다. 안 바꾸면 7.1.3 이미지를 로드해도 컨테이너는 구버전을 계속 쓴다.
  - `STATS_WORKBENCH_ENABLED` 등 `STATS_*`는 **7.0.0에서 설정한 값을 그대로 둔다**(변경 없음). 새 환경변수는 없다.
- **이미지 크기**: 7.1.1과 비슷하다(app 이미지 약 2.75GB). 새 이미지를 로드하는 동안 이전 이미지도 남아 있으므로 서버 디스크 여유를 확인한다.
- **네트워크·인증서**: 변경 없음 (Caddy·포트 8080/8443 그대로).
- **`updates/` 폴더**: compose의 `./updates`는 **새 패키지 폴더 기준**이다. 이전(7.1.1) 폴더의 `update-policy.json`·`canary.yml`은 새 폴더에서 보이지 않으므로 아래 "업데이트 절차 A" 2번을 따른다. (v7.1.2에서 패키지에 `updates/`가 확실히 포함되도록 고쳤다 — #143·#144.)
- **클라이언트(Electron)**: **재설치 불필요.** 인트라넷 Electron은 서버가 서빙하는 SPA를 로드한다. v7.1.1 이후 Electron 셸·EMR 헬퍼(`EmrHelper.cs`) 코드는 바뀌지 않았다. 신규 PC에는 패키지의 7.1.3 설치본을 쓴다.

## 예상 다운타임

- **서버**: 수십 초 (app 컨테이너 재생성 + 마이그레이션 적용). postgres/caddy는 영향 없음. 0036은 `UPDATE` 한 건, 0037은 NULL 허용 컬럼 추가(재작성 없음)와 CHECK 제약 검증이라 `stats_runs`에 짧게 락이 걸릴 뿐이고 이 테이블은 결과 보존 기간(기본 7일)이 지난 행이 정리되어 작다. 수 초 안에 끝난다.
- **클라이언트 PC**: 없음(새로고침으로 반영). 작업 중이던 환자 화면은 저장 후 새로고침한다.

## 사전 준비

### 0) 현재 운영 환경 정보 파악

compose 프로젝트 이름(`-p`, 보통 `wr-prod`)과 운영 `.env.production` 경로, 현재 `WR_VERSION`을 확인한다([UPDATE_5.1.0.md](UPDATE_5.1.0.md) "0)"과 동일).

```powershell
docker compose ls
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"      # → wr-app-server:7.1.1 이어야 한다 (7.1.2면 위 안내처럼 0037만 적용된다. 그 외면 이 문서의 전제가 다르다)
$installDir = docker inspect wr-prod-app-1 --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
Get-Content (Join-Path $installDir ".env.production") | Select-String "WR_VERSION|STATS_"
```

### 1) 패키지 이송·무결성 검증

- `release\wr-evaluation-unified-7.1.3-intranet.zip`을 서버로 복사하고 압축을 푼다(이미지 로드 시 app 이미지 약 2.75GB 이상의 디스크 여유 필요).
- 무결성 검증은 [UPDATE_5.1.0.md](UPDATE_5.1.0.md) "2) 무결성 검증"(SHA256SUMS)과 동일. `release-manifest.json`의 `version`이 7.1.3인지, 이미지 3종이 모두 7.1.3 태그인지, `electron/`의 `latest.yml` 버전이 7.1.3인지 확인한다.

### 2) (필수) 업데이트 직전 DB 백업

```powershell
docker compose -p wr-prod --profile backup run --rm backup /scripts/backup.sh
```

`_status\last-success.txt`에 새 백업 시각이 찍히는지 확인한다. 롤백 시 DB 복원이 필요해질 수 있다(아래 "롤백 절차").

### 3) (필수) .env.production 수정

```
# === WR_VERSION (필수) ===
# 수정 전:   WR_VERSION=7.1.1
# 수정 후:   WR_VERSION=7.1.3
```

`STATS_WORKBENCH_ENABLED` 등 `STATS_*`는 7.0.0에서 정한 값을 그대로 둔다.

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
cd C:\wr\wr-evaluation-unified-7.1.3-intranet

# 2. (이전 폴더의 updates/ 에 정책·canary 파일을 둔 적이 있을 때만) 새 폴더의 updates/ 로 옮긴다.
#    compose의 ./updates 는 이 새 폴더 기준이라 이전 폴더 것은 더 이상 마운트되지 않는다.
#    새 패키지의 updates/ 에는 7.1.3 설치본·.blockmap·latest.yml 이 이미 들어 있고 update-policy.json 은 없다.
#    자동 업데이트를 켠 적이 없다면(update-policy.json 없음) 생략.
Test-Path "<이전 폴더>\updates\update-policy.json"
Copy-Item "<이전 폴더>\updates\update-policy.json" ".\updates\"      # 있을 때만
# canary 롤아웃을 진행 중이던 경우에만 canary.yml 과 그 설치본도 함께 옮긴다

# 3. 새 Docker 이미지 로드
.\scripts\import-images.ps1

# 4. 로드된 이미지 확인 (wr-app-server / wr-backup-monitor / wr-backup 모두 7.1.3)
docker images | Select-String "wr-app-server|wr-backup"

# 5. 컨테이너 재생성 — 세 이미지가 모두 7.1.3 태그로 바뀌므로 app만이 아니라 전체를 올린다
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
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"      # → wr-app-server:7.1.3

# 2. 전체 컨테이너 상태
docker ps --filter "name=wr-prod" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

# 3. 마이그레이션 적용 확인 (0037까지, 37행)
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select count(*), max(filename) from schema_migrations"
# → 37|0037_stats_runs_limited_result.sql

# 3-1. 0037 결과 확인 — 컬럼과 제약 2개
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select column_name from information_schema.columns where table_name='stats_runs' and column_name='limited_result'"
# → limited_result
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select conname from pg_constraint where conrelid='stats_runs'::regclass and conname in ('stats_runs_limited_result_succeeded','stats_runs_disclosure_profile_check') order by 1"
# → stats_runs_disclosure_profile_check / stats_runs_limited_result_succeeded

# 4. 부팅 로그에서 마이그레이션·워커 확인
docker logs wr-prod-app-1 --tail 60 | Select-String "migrate|stats-runs-queue|error"
# → [migrate] Applied: 0036_… , 0037_…
#   (통계 활성화 시) [wr-server] stats-runs-queue worker enabled

# 5. app health / Caddy 경유 헬스
docker exec wr-prod-app-1 wget -qO- http://localhost:3001/health
curl.exe -k -o NUL -w "8443: %{http_code}`n" https://localhost:8443/health

# 6. updates/ 마운트 (새 패키지의 updates/ 가 서빙되는지 — 정책 파일이 없으면 업데이터는 휴면이다)
curl.exe -k https://localhost:8443/updates/latest.yml
# → version: 7.1.3 이 포함된 YAML (404면 새 폴더의 updates/ 에 파일이 없는 것)
```

### C. 통계 워크벤치 확인 (`STATS_WORKBENCH_ENABLED=true`인 경우)

```powershell
docker exec wr-prod-app-1 /opt/stats-venv/bin/python /app/stats-engine/analyze.py --selfcheck
# → stats-engine selfcheck OK

curl.exe -k https://localhost:8443/api/config/public
# → "statsWorkbenchAvailable": true
```

- 소수 인원 해제를 볼 사용자에게는 관리자 콘솔 **"통계 권한" 탭 → "제한 데이터 열람(원본 값·원본 분포)"**(`stats.export_limited_rows`)을 부여한다. 이미 부여된 사용자는 키가 같아 그대로 유지되며, **이번 업데이트부터 그 권한은 기술통계뿐 아니라 회귀·이변량·상관행렬·예측의 소수 셀도 푼다**(아래 "알려진 함정·한계"의 설명 문구 항목 참고). 기본 허용 3종(열람·분석·집계 내보내기)은 grant가 필요 없다. 권한 부여는 해당 사용자가 해제된 화면을 캡처·반출·공유할 수 있다는 점을 알고 하도록 한다.
- **카탈로그 v31 / 결과 스키마 v11**: 업데이트 후 첫 분석부터 새 규칙으로 계산되며 이전(7.1.1) 실행 결과 캐시는 재사용되지 않는다. 이후 7.1.3 안에서는 버전 상수가 바뀌지 않아 캐시가 그대로 재사용된다.
- **무릎 변수 교체**: 쪼그려앉기·중량물 합계 변수를 쓴 저장 레시피는 다시 실행하면 삭제 안내가 나온다 — 새 변수(`knee.case.weightedSquattingMinutesPerDay`·`cumulativeSquattingHours`·`weightedDailyLoadKg`·`cumulativeLoadTon`)로 다시 선택한다. 값의 의미가 달라 자동으로 바꾸지 않는다.

### D. 클라이언트 PC

기존 PC는 **별도 조치가 필요 없다.** 새로고침(또는 앱 재시작)하면 서버의 새 화면이 로드된다. 신규 PC는 패키지의 7.1.3 설치본(`직업성 질환 통합 평가 프로그램 Setup 7.1.3.exe`)을 설치한다. 점진 배포는 Electron 자동 업데이트(`update-policy.json`·canary 채널, [INTRANET_DEPLOYMENT.md](INTRANET_DEPLOYMENT.md) "자동 업데이트")를 쓸 수 있다.

---

## 검증 시나리오

| 시나리오 | 기대 결과 |
|---|---|
| 기존 환자 열기·저장 | 정상(기존 데이터 보존). 무릎 평가 결과와 입력값이 업데이트 전과 같다 |
| (통계 활성화) **권한 없는** 일반 사용자 또는 같은 조직의 권한 없는 admin이 소수 인원 때문에 가려지던 분석을 실행 | 7.1.1과 똑같이 "공개 정책에 따라 결과가 표시되지 않음". 해제 배너·해제 수치가 없다 |
| **권한자**가 같은 분석을 실행 (기술통계·회귀·이변량·상관행렬·예측 각각) | 소수 인원이 보이는 결과 + "소수 인원(10명 미만) 보호가 해제된 결과" 배너. 통계 조건 때문에 계산할 수 없는 경우는 해제돼도 사유(예: 반복측정, 표본 부족)가 붙는다 |
| 권한자가 **예측**을 실행했는데 추정 불가 | 카드에 "완전사례 기준 인원" 표(전체·사건·비사건, 필요 기준 50·25·25명 이상, 충족/부족). 미리보기의 사건/비사건 수와 다를 수 있다 |
| 권한자가 **상관행렬·예측**을 실행한 뒤 DB 확인 | 아래 "DB 확인" 쿼리에서 그 실행이 `lift_eligible`이고 `limited_result`가 있다 |
| 권한자가 만든 실행을 같은 조직의 권한 없는 admin이 조회 (`GET /api/stats/runs/<id>`) | 일반(집계) 결과만 보이고 해제 수치가 없다 |
| 권한을 회수한 뒤 같은 실행 재조회 | 일반 결과로 돌아간다(조회자의 현재 권한 기준) |
| **권한을 받기 전에** 실행한 상관행렬·예측을 권한 부여 후 재조회 | 일반 결과 + "제한 해제에 필요한 원본이 보존되지 않았습니다 … 다시 실행하면 해제됩니다". 다시 실행하면 해제된다 |
| 쪼그려앉기·중량물 합계 변수를 쓴 저장 레시피 | 삭제 안내가 나오고 새 변수로 다시 선택해야 한다 |
| 결과 CSV 내보내기 | 해제 여부와 무관하게 집계 결과만 나간다(해제된 수치는 파일에 포함되지 않는다) |

### DB 확인 (선택)

권한자가 상관행렬·예측을 실행한 직후 해제본이 실제로 저장됐는지 보려면:

```powershell
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -c "select analysis_run_id, status, requested_disclosure_profile, (limited_result is not null) as has_limited, cacheable, created_at from stats_runs order by created_at desc limit 5"
```

권한자가 실행한 상관행렬·예측은 `lift_eligible` / `has_limited=t`, 그 외는 `aggregate` / `f`로 나와야 한다. `limited_result`에는 소수 인원이 들어 있으므로 값을 직접 조회·반출하지 않는다.

> **이번 릴리스에서 사전 검증한 것**: 서버 전체 테스트를 실제 Postgres·Python 엔진으로 순차 실행해 통과했다(실패 0). 개발 환경에서 권한자 계정으로 소수 인원 해제 화면(배너·사유·완전사례 표)이 정상 동작하는 것을 확인했다. **사전 검증하지 못한 것**: 운영 이미지·패키지 빌드와 `--network none` 환경 동작, **운영 데이터 규모에서의 응답 시간**(특히 회귀·이변량의 조회 시 재계산과 예측 실행 시간), 병원 EMR 실제 주입(이번 릴리스는 EMR 코드를 바꾸지 않았다). 업데이트 직후 권한자 계정으로 분석을 한두 번 실행해 응답 시간을 확인하고 전체 사용을 시작할 것을 권장한다.

---

## 롤백 절차

롤백은 **앱 이미지 되돌리기**와 **DB 복원**을 구분한다.

### 1) 앱 이미지만 되돌리기 (대부분의 경우 충분)

```powershell
# .env.production: WR_VERSION=7.1.3 → 7.1.1
cd C:\wr\wr-evaluation-unified-7.1.1-intranet      # 이전 패키지 폴더 (updates/ 도 그 폴더 기준으로 되돌아간다)
docker images | Select-String "wr-app-server:7.1.1"      # 없으면 이전 패키지에서 .\scripts\import-images.ps1
docker compose -p wr-prod --env-file <env경로> -f docker-compose.yml -f docker-compose.prod.yml --profile backup up -d
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"      # → wr-app-server:7.1.1
```

마이그레이션 0036·0037은 **이미 적용된 상태로 DB에 남는다**(down 마이그레이션 없음).

- 0036은 권한 설명 UPDATE뿐이고, 0037은 NULL 허용 컬럼 1개와 CHECK 2개를 추가했을 뿐이라 7.1.1 앱은 코드상 그대로 동작한다(7.1.1은 이 컬럼을 읽거나 쓰지 않고, 쓰는 `requested_disclosure_profile` 값 `aggregate`는 새 CHECK를 통과한다). **다만 7.1.1 앱을 이 상태의 DB에서 실제로 돌려 확인하지는 않았다.**
- 7.1.3에서 만들어진 `lift_eligible` 행은 7.1.1이 사용하는 캐시 키와 달라 7.1.1이 재사용하지 않는다. 7.1.1에서는 권한자에게도 소수 인원이 해제되지 않으므로 해제 화면이 사라진다.
- 7.1.2로 바뀐 **무릎 변수 4종**은 7.1.1 이미지에서 다시 옛 변수(`sum*`)로 돌아가므로, 그 사이 새 변수로 저장해 둔 레시피는 7.1.1에서 `UNKNOWN_VARIABLE`로 거부된다.

### 2) DB 복원 (스키마/데이터 자체에 문제가 있을 때만)

[BACKUP_RESTORE.md](BACKUP_RESTORE.md) 절차로 **업데이트 전 백업**을 복원한다. 복원하면 **그 백업 시각 이후의 모든 변경(환자 저장·편집, 통계 실행 기록, grant 등)이 사라진다.** 복원 후에는 `WR_VERSION`도 이전 값으로 되돌려야 하며, 복원 전에 현재 DB를 별도로 한 번 더 백업해 두는 것을 권장한다.

---

## 알려진 함정·한계

### `up -d` 실행했는데 컨테이너가 이전 버전 그대로
**원인**: `.env.production`의 `WR_VERSION`이 이전 값으로 남아 있음. **해결**: 사전 준비 3번대로 수정 후 다시 실행.

### 새 패키지로 바꿨는데 자동 업데이트 정책/canary 설정이 사라짐
**원인**: compose의 `./updates`는 compose 파일이 있는 패키지 폴더 기준이라, 새 폴더에서 기동하면 이전 폴더 `updates/`의 `update-policy.json`·`canary.yml`이 보이지 않는다(정책 파일이 없으면 업데이터는 휴면). **해결**: 이전 폴더 `updates/`에서 새 폴더 `updates/`로 옮긴다(업데이트 절차 A 2번).

### 통계 버튼이 안 보임 / `/api/stats/*`가 404
**원인**: `STATS_WORKBENCH_ENABLED`가 true가 아니거나 `DEPLOYMENT_MODE`가 intranet이 아님, 또는 통계 엔진 런타임이 비정상. **해결**: env 값을 확인하고 `docker logs wr-prod-app-1`·`--selfcheck`로 엔진 상태를 본다. 404는 기능 존재를 숨기는 설계이며 권한 오류(403)와 다르다.

### 권한자인데 상관행렬·예측이 해제되지 않고 "다시 실행하면 해제됩니다"가 나온다
**원인**: 상관행렬·예측의 해제본은 **권한자가 실행하는 시점에** 저장된다. 권한을 받기 전에 실행한 결과, 또는 실행 도중 권한이 회수된 결과에는 해제본이 없다. **해결**: 권한이 있는 상태에서 같은 분석을 다시 실행한다. 이 동작은 의도된 것이다(원본 행을 보존하지 않으므로 나중에 해제본을 만들 수 없다).

### 권한자의 회귀·이변량 조회가 해제되지 않고 일반 결과로 돌아옴 ("계산에 실패해 일반(집계) 결과를 표시")
**원인**: 회귀·이변량은 조회할 때 원본으로 다시 계산하는데, 엔진 제한 시간(기본 30초) 안에 끝나지 않았거나 다른 계산과 겹쳤다. **해결**: 잠시 후 다시 조회한다. 데이터가 매우 커서 반복되면 필터로 범위를 줄인다.

### 예측이 권한자에게도 "사건/비사건 인원 수가 부족합니다"
**원인**: 소수 인원 해제와 무관한 통계 조건이다. 예측은 선택한 예측변수 값이 **모두 있는 사람(완전사례)**만 쓰며, 전체 50명·사건 25명·비사건 25명 이상이어야 한다. 미리보기의 사건/비사건 수는 결과변수만 관측된 인원이라 훨씬 클 수 있다. **해결**: 권한자 화면의 "완전사례 기준 인원" 표로 어느 쪽이 부족한지 보고, 결측이 적은 예측변수로 바꾸거나 해당 값을 더 입력한다.

### 관리자 콘솔의 권한 설명이 기술통계만 언급함
**원인**: 마이그레이션 0036이 정한 `stats.export_limited_rows` 설명은 "기술통계(담당의별 표 포함)에서는 … 해제"까지만 적혀 있다. 실제로는 이번 릴리스부터 회귀·이변량·상관행렬·예측에도 적용된다(키·grant는 그대로). 권한을 부여하는 관리자가 범위를 좁게 오해할 수 있으므로 **부여 시 이 점을 알린다.** 설명 문구 갱신은 다음 릴리스의 마이그레이션으로 처리한다.

### 연간 근무일 250 가정
**원인**: 앱이 모든 직력의 연간 근무일을 250으로 기본 채우고 입력값과 구분할 수 없어, 근무일을 확인하지 않은 직력의 무릎 누적 변수(쪼그려앉기 시간·중량물 톤)는 250일/년 가정으로 계산된다. 입력 여부 추적은 후속 과제다.

### 저장해 둔 통계 레시피 재실행 시 값이 달라짐
의미가 바뀐 변수(무릎 노출 변수 등)를 쓴 저장 레시피는 재실행하면 새 규칙으로 계산된다(실행 결과 캐시만 버전으로 분리되며 레시피 자체는 카탈로그 버전을 갖지 않는다).

### 분석 결과가 "억제됨"으로 나옴
권한이 없는 사용자에게 최소 코호트(10명) 미만 셀이거나, 같은 사용자가 짧은 시간에 같은 코호트를 반복 질의해 차분 방지 예산을 소진한 경우다. 정상 보호 동작이며 코호트를 넓히거나 시간을 두고 다시 시도한다. **반복 질의 차단은 권한자에게도 풀리지 않는다.**

### 해제된 화면의 취급
해제된 결과에는 소수 인원이 그대로 보이므로 화면 캡처·반출·공유에 주의한다. 해제된 응답은 사용자·실행·시각이 감사 기록에 남고, 결과 CSV에는 해제 수치가 포함되지 않는다. 상관행렬·예측의 해제본은 실행 기록과 함께 보존 기간(기본 168시간, `STATS_RUNS_RESULT_TTL_HOURS`)이 지나면 삭제된다.

---

## 참고

- 변경 이력: [README.md](../README.md) 변경 이력 v7.1.3·v7.1.2, [PRD.md](PRD.md) v7.1.3·v7.1.2
- 통계 워크벤치 활성화·검증: [OFFLINE_DEPLOYMENT_PACKAGE.md](OFFLINE_DEPLOYMENT_PACKAGE.md) §16, 이전 단계 절차: [UPDATE_7.1.1.md](UPDATE_7.1.1.md)·[UPDATE_7.0.0.md](UPDATE_7.0.0.md)
- 신규 설치 가이드: [OFFLINE_DEPLOYMENT_PACKAGE.md](OFFLINE_DEPLOYMENT_PACKAGE.md), 백업/복구: [BACKUP_RESTORE.md](BACKUP_RESTORE.md)
