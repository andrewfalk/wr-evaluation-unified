# T46 구현 계획 — Production Release Rehearsal

> **검토 완료 (2026-05-15)**  
> 아래 5가지 수정사항이 원본 계획에 반영되었습니다.

## 검토 노트 (Claude 검토)

1. **`.env.example` 이미 존재** — `.env.production.example`은 신규 파일로 추가. 기존 example과의 차이:
   `DEV_PORT=127.0.0.1:3001`(loopback 바인딩), fallback 비밀번호 완전 제거, 모든 필수값이 빈 값으로 명시.

2. **app 포트 노출 차단** — 기존 compose의 app 서비스가 `${DEV_PORT:-3001}:3001`으로 포트 노출.
   `docker-compose.prod.yml`에서 `ports: !reset []`로 덮어써야 함 (Compose v2.17+ 필요, Docker 24+ 기본 포함).
   Caddy만이 외부 80/443 처리.

3. **T46f — Electron 인트라넷 빌드 미완성** — 인트라넷 Electron 빌드는 별도 작업으로 미구현.
   T46f는 "빌드 아티팩트 준비 후 재검증" 조건부 항목으로 표시.

4. **T46c — SHA256 PowerShell 호환** — Linux `sha256sum` 사용 불가.
   PowerShell 스크립트에서는 `Get-FileHash -Algorithm SHA256` 사용 필요.

5. **T46e — AUDIT_DB_PASSWORD 변경 절차 누락** — migration이 기본값 `changeme_audit_reader`로 role 생성.
   빈 DB 설치 후 `ALTER ROLE wr_audit_reader PASSWORD '...'` 실행이 T46e 체크리스트에 명시되어야 함.

---

## T46 목표

- 검증 DB/volume을 production으로 승격하지 않는다.
- 오프라인/인트라넷 배포 패키지로 새 production-like 환경을 만든다.
- 빈 DB에서 migration/admin/device/smoke/backup/restore/rollback이 재현 가능해야 한다.

---

## T46a — 배포 패키지 구조 설계

**산출물:**
- `docs/PRODUCTION_RELEASE_PLAN.md`
- `docs/OFFLINE_DEPLOYMENT_PACKAGE.md`

**정의할 것:**

패키지에 포함할 항목:
- Docker images tar
- `docker-compose.yml` / `docker-compose.prod.yml`
- `.env.production.example`
- Caddy config
- backup/restore scripts
- Electron intranet installer (빌드 아티팩트 준비 후)
- CA 설치 안내
- GPG 공개키 import 안내
- checksum 파일
- version/release manifest

**검증 기준:**
- staging DB/volume을 production으로 복사하지 않는다고 명시
- 운영 데이터는 패키지에 포함하지 않음
- secret은 패키지에 포함하지 않고 example만 제공
- 설치 순서가 문서에 명령어 단위로 있음

---

## T46b — production compose/env 분리

**Claude 구현 범위:**
- `docker-compose.prod.yml` 추가
- `.env.production.example` 추가
- production project name/volume naming 규칙 문서화
- 기본 secret/changeme 차단 기준 문서화

**권장 명령어:**
```powershell
docker compose `
  -f docker-compose.yml `
  -f docker-compose.prod.yml `
  --env-file .env.production `
  -p wr-prod up -d
```

**검증 기준:**
- `wr-prod_postgres_data` 같은 새 volume 사용 가능
- 기존 dev/staging volume과 충돌 없음
- `.env.production.example`에 실제 secret 없음
- production 명령어에 `-p wr-prod`가 명시됨

**검토 포인트:**
- prod compose가 dev DB/volume을 실수로 재사용하지 않는지
- `backup_data` / `backup_alerts` / `backup_gnupg`도 prod project로 분리되는지
- `CORS_ORIGINS` / `WR_DOMAIN` / `DEPLOYMENT_MODE`가 production/intranet 기준인지

---

## T46c — 오프라인 패키지 export 스크립트

**Claude 구현 범위:**
- `scripts/export-offline-package.ps1`

**기능:**
- 필요 Docker image build
- `docker save`로 `images.tar` 생성
- compose/env example/docs/scripts 포함
- Electron intranet installer 포함 경로 준비
- `SHA256SUMS` 생성 (`Get-FileHash -Algorithm SHA256`)
- `release-manifest.json` 생성

**패키지 예시:**
```
release/wr-evaluation-unified-4.2.1-intranet/
  images/
    wr-images.tar
  compose/
    docker-compose.yml
    docker-compose.prod.yml
    .env.production.example
  scripts/
    backup.sh
    restore.sh
    import-images.ps1
    install-prod.ps1
  docs/
    INTRANET_DEPLOYMENT.md
    BACKUP_RESTORE.md
    OPERATIONS_RUNBOOK.md
  electron/
    직업성 질환 통합 평가 프로그램 Setup {VERSION}.exe   ← 실제 파일명은 manifest electronInstaller.fileName 참조
                                                          ← 빌드 아티팩트 없으면 PLACEHOLDER.txt
  SHA256SUMS
  release-manifest.json
```

**검증 기준:**
- 패키지에 `.env`, DB dump, private key 없음
- `SHA256SUMS` 생성됨
- `docker load` 가능한 tar 생성됨
- manifest에 version, git commit, build time, image names 있음

---

## T46d — 빈 production-like 환경 설치 리허설

**Claude 구현/문서 범위:**
- `docs/PRODUCTION_RELEASE_PLAN.md`에 설치 리허설 절차 추가

**검증 절차:**
```powershell
docker compose `
  -f docker-compose.yml `
  -f docker-compose.prod.yml `
  --env-file .env.production `
  -p wr-prod up -d
```

**합격 기준:**
- 새 postgres volume 생성
- app migration 성공
- app healthy
- caddy healthy
- backup-monitor running
- 기존 `wr-evaluation-unified_*` volume과 분리

**검증 명령어:**
```powershell
# $PROD 배열 정의 후 사용 (이 절 전체에서 공통)
$PROD = @("-f","docker-compose.yml","-f","docker-compose.prod.yml","--env-file",".env.production","-p","wr-prod")

docker volume ls | Select-String wr-prod
docker compose @PROD ps
docker compose @PROD logs app --tail=100
docker compose @PROD exec postgres psql -U wr_user -d wr_evaluation -c "\dt"
docker compose @PROD port app 3001

# volume 마운트 확인 (PASS 기준: wr-prod_postgres_data)
docker inspect wr-prod-postgres-1 --format '{{range .Mounts}}{{.Name}}{{"\n"}}{{end}}'
```

---

## T46e — 초기 admin + 계정 smoke

**Claude 구현/문서 범위:**
- admin seed 절차 문서화
- 초기 admin 생성 후 mustChangePassword 플로우 확인
- 운영 관리자 계정 관리 절차 보강

**검증 기준:**
- 빈 DB에서 admin seed 성공
- admin 로그인 성공
- 초기 비밀번호 변경 플로우 성공
- 일반 사용자 1명 생성
- 일반 사용자 로그인 성공

**⚠ AUDIT_DB_PASSWORD 변경 필수** (마이그레이션 후 즉시):
```sql
ALTER ROLE wr_audit_reader PASSWORD '실제_비밀번호';
```

---

## T46f — device + Electron intranet smoke

> **전제 조건**: Electron 인트라넷 빌드 아티팩트 필요. 빌드 미완성 시 T46f는 "조건부 PASS — Electron 인트라넷 빌드 후 재검증" 처리.

**검증 기준:**
- Electron intranet 실행
- device pending 등록
- admin 승인
- 승인 후 로그인/API 사용 가능
- 환자 1건 생성/조회 가능

**검증 쿼리:**
```sql
SELECT id, status, build_target, approved_at, revoked_at
FROM devices
ORDER BY registered_at DESC
LIMIT 5;
```

---

## T46g — production 백업/복구 리허설

**검증 기준:**
- 실제 백업 success
- monitor summary ok
- 별도 restore DB에 복구 성공
- 복구 DB에서 users/patient_records/audit_logs count 확인

**검증 명령어:**
```powershell
$PROD = @("-f","docker-compose.yml","-f","docker-compose.prod.yml","--env-file",".env.production","-p","wr-prod")

docker compose @PROD exec backup sh /scripts/backup.sh
docker compose @PROD exec app cat /backups/_status/backup-status.json
docker compose @PROD restart backup-monitor
docker compose @PROD exec app cat /backups/_status/monitor-report.json
```

---

## T46h — rollback 리허설

**Claude 구현/문서 범위:**
- `docs/PRODUCTION_RELEASE_PLAN.md` 내 rollback 섹션

**원칙:**
- `docker compose down -v` **금지** (volume 삭제)
- 이전 image tag로 app 컨테이너만 교체
- migration이 irreversible이면 DB restore로만 롤백 가능 (No-Go 조건)

---

## T46i — Go/No-Go 결과표

**산출물:** `docs/T46_GO_NO_GO.md`

| 항목 | 기준 | 증적 |
|---|---|---|
| production env 분리 | `wr-prod_*` volume 확인 | `docker volume ls` |
| offline package secret 누출 없음 | `.env` / private key 미포함 | `SHA256SUMS`/manifest |
| 빈 DB migration | app healthy + `\dt` 결과 | app logs |
| admin seed/login | mustChangePassword 플로우 | screenshot/log |
| device smoke | status=approved 확인 | devices 쿼리 |
| patient smoke | 환자 CRUD 성공 | patient_records count |
| backup success | backup-status.json ok | monitor-report.json |
| restore rehearsal | 복구 DB count 일치 | restore output |
| rollback rehearsal | image tag 교체 명령 dry-run | command log |

---

## 턴별 진행 계획

| 턴 | 범위 | 상태 |
|---|---|---|
| Turn 1 | T46a+b: 문서/env/compose 설계 구현 | **완료 (코덱스 리뷰 반영)** |
| Turn 2 | T46c: 오프라인 패키지 export 스크립트 | **완료** |
| Turn 3 | T46d+e: 빈 prod-like 설치/admin smoke 절차 | **완료** |
| Turn 4 | T46f: device/Electron smoke 문서화 | **완료** |
| Turn 5 | T46g: backup/restore prod-like 리허설 절차 | **완료** |
| Turn 6 | T46h+i: rollback + Go/No-Go 문서 | **완료** |

---

## T46 범위 제한

**T46에서 다시 깊게 안 볼 것:**
- backup-monitor dry-run/ack/resolve 상세 테스트 (T45 완료)
- audit reader 세부 권한 매트릭스 (T45 완료)
- device revoke 세부 케이스 (T45 완료)
- CSRF/API 권한 테스트 전체 (T45 완료)
- Electron origin 차단 상세 (T45 완료)

**T46에서 반드시 볼 것:**
- 새 production-like 환경 (새 volume, 새 project name)
- 빈 DB migration
- secret 분리
- 오프라인 패키지
- admin/device 최초 절차
- 실제 백업/복구
- rollback 명령
- Go/No-Go 증적
