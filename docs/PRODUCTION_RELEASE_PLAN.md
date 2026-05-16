# Production Release Plan — wr-evaluation-unified

**원칙**: 검증 DB/volume을 production으로 승격하지 않는다. 빈 환경에서 처음부터 설치하여 재현 가능성을 증명한다.

---

## 목차

1. [전제 조건](#1-전제-조건)
2. [비밀값 준비](#2-비밀값-준비)
3. [Production 환경 설치](#3-production-환경-설치)
4. [초기화 절차](#4-초기화-절차)
5. [검증 체크리스트](#5-검증-체크리스트)
6. [롤백 절차](#6-롤백-절차)
7. [Production Volume 정책](#7-production-volume-정책)
8. [릴리스 체크리스트](#8-릴리스-체크리스트)

---

## 1. 전제 조건

| 항목 | 요건 |
|---|---|
| 서버 OS | Linux Ubuntu 22.04 LTS 또는 Windows Server 2019+ |
| Docker Engine | 24.0 이상 |
| Docker Compose | v2.17 이상 (`!reset` tag 지원 필요) |
| DNS | `wr.hospital.local` → 서버 IP (클라이언트 전 PC에 적용) |
| 방화벽 | 서버 포트 80, 443 인바운드 허용 |
| GPG | 공개키 준비 완료 (백업 암호화용) |
| 오프라인 패키지 | `scripts/export-offline-package.ps1`으로 생성한 패키지 |

> **⚠ 주의**: staging/dev volume을 production으로 복사하거나 export하지 않는다.
> Production 환경은 항상 빈 DB에서 시작한다.

---

## 2. 비밀값 준비

production 서버에서 직접 생성. 절대 git에 커밋하지 않는다.

```bash
# 각 값을 별도로 생성
openssl rand -hex 32   # ACCESS_TOKEN_SECRET
openssl rand -hex 32   # REFRESH_TOKEN_SECRET
openssl rand -hex 32   # POSTGRES_PASSWORD (32자 이상 권장)
openssl rand -hex 32   # AUDIT_DB_PASSWORD
```

`.env.production.example`을 복사하여 `.env.production` 작성:

```bash
cp .env.production.example .env.production
# 편집기로 모든 빈 값을 채운다
```

**필수 변경 항목 (빈 값으로 시작, 반드시 채워야 함):**

| 변수 | 설명 |
|---|---|
| `ACCESS_TOKEN_SECRET` | JWT access token 서명 키 |
| `REFRESH_TOKEN_SECRET` | JWT refresh token 서명 키 |
| `POSTGRES_PASSWORD` | PostgreSQL 비밀번호 |
| `AUDIT_DB_PASSWORD` | wr_audit_reader 역할 비밀번호 |
| `BACKUP_GPG_RECIPIENT` | GPG 공개키 fingerprint 또는 이메일 |
| `CORS_ORIGINS` | 실제 인트라넷 도메인 (예: `https://wr.hospital.local`) |
| `WR_DOMAIN` | Caddy가 서빙할 도메인 (예: `wr.hospital.local`) |

`.env.production` 파일 권한 설정 (Linux):
```bash
chmod 600 .env.production
```

---

## 3. Production 환경 설치 (T46d 리허설)

> **이 절의 모든 `docker compose` 명령은 아래 플래그를 공통으로 사용한다.**
> 복사·붙여넣기 실수를 줄이기 위해 셸 변수로 정의해두고 사용한다.
>
> ```bash
> # Linux — 이 절 전체에서 $PROD 배열 사용
> PROD=(-f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production -p wr-prod)
> # 예: docker compose "${PROD[@]}" up -d
> ```
>
> ```powershell
> # Windows PowerShell — $PROD 배열 스플래팅
> $PROD = @("-f","docker-compose.yml","-f","docker-compose.prod.yml","--env-file",".env.production","-p","wr-prod")
> # 예: docker compose @PROD up -d
> ```

### 3-0. 사전 점검 (Pre-flight)

서비스 기동 전 아래 항목을 모두 확인한다.

| # | 점검 항목 | 명령 | 통과 기준 |
|---|---|---|---|
| 1 | Docker 실행 중 | `docker info` | 오류 없음 |
| 2 | Compose v2.17+ | `docker compose version` | v2.17 이상 |
| 3 | `.env.production` 존재 | `ls .env.production` | 파일 있음 |
| 4 | 빈 필수값 없음 | `grep -E '^[^#]+=\s*$' .env.production` | 출력 없음 |
| 5 | `changeme_` 없음 | `grep -i changeme .env.production` | 출력 없음 |
| 6 | `WR_VERSION` 설정됨 | `grep WR_VERSION .env.production` | 값 있음 |
| 7 | 기존 wr-prod 컨테이너 없음 | `docker compose -p wr-prod ps` | 빈 목록 |

> **Windows**에서는 `grep` 대신 `Select-String`을 사용한다:
> - `Get-Content .env.production | Select-String -Pattern '^[^#]+=\s*$'`
> - `Get-Content .env.production | Select-String -Pattern 'changeme'`

`install-prod.ps1`을 사용하면 위 점검을 자동으로 수행한다:
```powershell
# 점검 + 이미지 로드 시뮬레이션만 수행, 실제 docker load 및 서비스 기동 안 함
.\scripts\install-prod.ps1 -DryRun
```

### 3-1. 오프라인 패키지에서 이미지 로드 (인트라넷 환경)

```powershell
# Windows 서버 (패키지 루트에서 실행)
.\scripts\import-images.ps1
```

```bash
# Linux 서버 (패키지 루트에서 실행)
bash scripts/import-images.sh
```

이미지 로드 확인:
```bash
docker images | grep wr-
# 기대 출력:
# wr-app-server       4.2.1   ...
# wr-backup-monitor   4.2.1   ...
# wr-backup           4.2.1   ...
```

### 3-2. 서비스 기동

```powershell
# Windows
docker compose `
  -f docker-compose.yml `
  -f docker-compose.prod.yml `
  --env-file .env.production `
  -p wr-prod `
  up -d
```

```bash
# Linux
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file .env.production \
  -p wr-prod \
  up -d
```

> **`-p wr-prod`는 반드시 명시한다.** 누락 시 volume 이름이 디렉터리명 기반으로 생성되어
> dev/staging volume과 혼용될 수 있다.

### 3-3. 기동 확인 및 Migration 검증

```bash
# 1. 전체 서비스 상태 (ps/logs/exec는 실행 중인 컨테이너 대상이므로 -f 불필요)
docker compose -p wr-prod ps
```

기대 출력 (healthy까지 30–60초 소요):
```
NAME                          STATUS          PORTS
wr-prod-app-1                 healthy         ...
wr-prod-caddy-1               healthy         0.0.0.0:80->80, 0.0.0.0:443->443
wr-prod-postgres-1            healthy         ...
wr-prod-partition-1           running         ...
wr-prod-backup-monitor-1      running         ...
```

```bash
# 2. Migration 완료 로그 확인
docker compose -p wr-prod logs app 2>&1 | grep -iE "migrat|error|fatal"
# 기대: "X migrations run" 또는 "All migrations are up to date"
# 위험 신호: ERROR, FATAL, "migration failed"
```

```bash
# 3. Volume 격리 확인 (wr-prod_ 접두사 필수)
docker volume ls | grep wr-prod
# 기대:
# local   wr-prod_backup_alerts
# local   wr-prod_backup_data
# local   wr-prod_backup_gnupg
# local   wr-prod_caddy_config
# local   wr-prod_caddy_data
# local   wr-prod_postgres_data
```

```bash
# 4. DB 테이블 확인 (migration 성공 기준)
docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation -c "\dt"
```

```bash
# 5. app 포트 노출 확인 (빈 출력이어야 함)
# port 명령은 compose 설정을 읽으므로 전체 플래그 필요
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file .env.production \
  -p wr-prod \
  port app 3001
# 기대: 빈 출력 (host:3001 바인딩 없음 — docker-compose.prod.yml의 ports: !reset [] 적용 확인)
```

기대 테이블 목록:
```
 Schema |        Name         | Type  |  Owner
--------+---------------------+-------+---------
 public | audit_log_partitions| table | wr_user
 public | audit_logs          | table | wr_user
 public | devices             | table | wr_user
 public | organizations       | table | wr_user
 public | patient_records     | table | wr_user
 public | schema_migrations   | table | wr_user
 public | sessions            | table | wr_user
 public | users               | table | wr_user
 public | workspaces          | table | wr_user
```

**T46d 합격 기준:**

| 항목 | 기준 | 증적 명령 |
|---|---|---|
| volume 격리 | `wr-prod_postgres_data` 존재 | `docker volume ls \| grep wr-prod` |
| dev volume 미마운트 | postgres 컨테이너가 `wr-prod_postgres_data`만 마운트 | `docker inspect wr-prod-postgres-1 --format '{{range .Mounts}}{{.Name}}{{"\n"}}{{end}}'` |
| app healthy | `STATUS: healthy` | `docker compose -p wr-prod ps` |
| caddy healthy | `STATUS: healthy` | `docker compose -p wr-prod ps` |
| migration 성공 | ERROR/FATAL 없음 + 위 테이블 목록 | `logs app + \dt` |
| app 포트 미노출 | host 3001 바인딩 없음 → 빈 출력 | `docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production -p wr-prod port app 3001` |

---

## 4. 초기화 절차 (T46e Admin Smoke)

### 4-1. AUDIT_DB_PASSWORD 동기화 ⚠

migration이 기본값 `changeme_audit_reader`로 `wr_audit_reader` 역할을 생성한다.
`.env.production`의 실제 값으로 **즉시** 변경해야 한다. 이 단계를 생략하면
`AUDIT_DATABASE_URL`로 연결하는 audit reader가 인증에 실패한다.

```bash
docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation \
  -c "ALTER ROLE wr_audit_reader PASSWORD '실제_AUDIT_DB_PASSWORD값';"
```

변경 확인:
```bash
docker compose -p wr-prod exec app node -e \
  "const { Pool } = require('pg'); const p = new Pool({ connectionString: process.env.AUDIT_DATABASE_URL }); p.query('SELECT 1').then(() => { console.log('audit_reader OK'); p.end(); }).catch(e => { console.error('FAIL', e.message); p.end(); });"
```

### 4-2. Admin 계정 초기 생성

```bash
docker compose -p wr-prod exec app node dist/cli/seedAdmin.js
```

대화형 프롬프트 (stdin, 비밀번호는 화면에 표시 안 됨):
```
=== wr-evaluation-unified: Admin seed ===
This creates the first admin account in an empty database.

Initial hospital/organization name: ○○병원 직업환경의학과
Login ID (e.g. admin): admin
Password: ██████████████
Display name (e.g. 시스템 관리자): 시스템 관리자
```

**비밀번호 정책** (서버 `passwordPolicy.ts` 기준):
- 최소 10자 이상
- 영문 또는 한글 1자 이상
- 숫자 1자 이상
- 특수문자 1자 이상
- 최근 5개 비밀번호 재사용 금지 (변경 이력 관리)

> seedAdmin은 초기 비밀번호를 10자 이상만 검사한다 (정책 3·4 조건은 변경 시 적용).
> 초기값은 임시 비밀번호이므로 즉시 변경 플로우를 통해 정책 준수 비밀번호로 바꾼다.

성공 출력 예:
```
Admin account created successfully.
  ID:       xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  Login ID: admin
  Name:     시스템 관리자
  Role:     admin
  Organization: ○○병원 직업환경의학과 (xxxxxxxx-xxxx-...)
  must_change_password: true

Log in and change the password immediately.
```

**멱등성 확인** — 같은 login_id로 재실행 시 abort:
```
ERROR: User with login_id "admin" already exists.
```

DB 확인:
```sql
-- psql 확인
docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation \
  -c "SELECT login_id, name, role, must_change_password, created_at FROM users;"
```

기대 출력:
```
 login_id | name       | role  | must_change_password
----------+------------+-------+---------------------
 admin    | 시스템 관리자 | admin | t
```

### 4-3. Admin 첫 로그인 및 비밀번호 변경

**mustChangePassword 플로우:**

1. 브라우저에서 `https://wr.hospital.local` 접속
2. admin / 초기 비밀번호로 로그인
3. 로그인 응답에 `mustChangePassword: true` 포함 → 클라이언트가 비밀번호 변경 페이지로 리다이렉트
4. 새 비밀번호 입력 (정책 4가지 조건 모두 충족 필요)
5. 변경 완료 → `mustChangePassword: false`, 다른 세션 전체 revoke
6. 기존 access token 무효화 → 재로그인 필요

비밀번호 변경 후 DB 확인:
```sql
docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation \
  -c "SELECT login_id, must_change_password, password_changed_at FROM users WHERE login_id = 'admin';"
```

기대: `must_change_password = f`

audit log 확인 (비밀번호 변경 이벤트 기록 여부):
```sql
docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation \
  -c "SELECT action, outcome, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 5;"
```

기대 이벤트 (최신 순):
```
 action                  | outcome
-------------------------+---------
 auth_change_password    | success
 auth_login              | success
```

### 4-4. 일반 사용자 생성 및 로그인 smoke

1. admin으로 로그인된 상태에서 **설정 > 사용자 관리** 진입
2. 사용자 추가: `login_id=doctor01`, 이름, 역할=`staff` 또는 `doctor`
3. 초기 비밀번호 설정 (정책 준수, `must_change_password=true`)
4. 일반 사용자로 로그인 → 비밀번호 변경 플로우
5. 환자 목록 화면 진입 확인

DB 확인:
```sql
docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation \
  -c "SELECT login_id, role, must_change_password FROM users ORDER BY created_at;"
```

기대:
```
 login_id  | role  | must_change_password
-----------+-------+---------------------
 admin     | admin | f                   ← 변경 완료
 doctor01  | staff | t                   ← 아직 첫 로그인 전
```

**T46e 합격 기준:**

| 항목 | 기준 | 증적 |
|---|---|---|
| AUDIT_DB_PASSWORD | audit_reader 연결 성공 | node 확인 명령 출력 |
| seedAdmin 성공 | `must_change_password = t` | users 쿼리 |
| seedAdmin 멱등성 | 재실행 시 "already exists" abort | 콘솔 출력 |
| 첫 로그인 | `mustChangePassword: true` 수신 | 브라우저/API |
| 비밀번호 변경 | `must_change_password = f` | users 쿼리 |
| audit log | `auth_login`, `auth_change_password` 기록 | audit_logs 쿼리 |
| 일반 사용자 생성 | DB 확인 | users 쿼리 |
| 일반 사용자 로그인 | 환자 목록 진입 성공 | 브라우저 확인 |

### 4-5. 백업 GPG 키 등록 및 백업 서비스 활성화

```bash
# GPG 공개키 등록 (1회) — stdin pipe로 전달 (컨테이너 내부 경로 없음)
cat wr-backup-public.asc | docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file .env.production \
  -p wr-prod \
  --profile backup run --rm -T backup gpg --import
```

```powershell
# Windows PowerShell
Get-Content .\wr-backup-public.asc | docker compose `
  -f docker-compose.yml `
  -f docker-compose.prod.yml `
  --env-file .env.production `
  -p wr-prod `
  --profile backup run --rm -T backup gpg --import
```

```bash
# 백업 서비스 활성화
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file .env.production \
  -p wr-prod \
  --profile backup up -d
```

---

## 5. 검증 체크리스트

> T46d~T46g 리허설 절차. 실제 운영 전환 전 모두 PASS 확인 필요.

### 5-1. 환경 분리 확인

```bash
# 1. wr-prod_ 접두사 volume 존재 확인
docker volume ls | grep wr-prod
# 기대: wr-prod_postgres_data, wr-prod_backup_data 등 목록

# 2. PASS 기준 — 컨테이너가 dev volume을 마운트하지 않는 것
#    (같은 PC에서 리허설하면 dev volume 자체는 남아 있을 수 있음 — 그것은 실패가 아님)
docker inspect wr-prod-postgres-1 \
  --format '{{range .Mounts}}{{.Name}}{{"\n"}}{{end}}'
# 기대: wr-prod_postgres_data
# 실패: wr-evaluation-unified_postgres_data 또는 다른 프로젝트 이름

docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation -c "SELECT count(*) FROM users;"
```

### 5-2. Device 등록 및 승인 (T46f)

> **전제 조건**: Electron 인트라넷 빌드 아티팩트 필요.
> 빌드 미완성 시 이 절은 **조건부 PASS — Electron 인트라넷 빌드 후 재검증** 처리.

#### T46f 흐름 개요

```
Electron 앱 → 로그인 → POST /api/devices/register (publicKey, buildTarget='intranet')
  → DB: status='pending'
  → Admin 패널 UI: 승인 버튼 → POST /api/admin/devices/:id/approve (CSRF 토큰 포함)
  → DB: status='active', approved_at=now()
  → Electron: tryRegister() 재호출 → status='active' → 감사 로그 서명 활성화
  → Smoke: 환자 1건 생성/조회 (환자 CRUD는 device 승인으로 게이트되지 않음 — 앱 동작 확인용)
```

#### 5-2-1. Electron 앱 실행 및 서버 연결

1. 인스톨러 실행 (electron-builder `productName` 기준 파일명):
   - 기본: `직업성 질환 통합 평가 프로그램 Setup {VERSION}.exe`
   - 오프라인 패키지의 `electron/` 디렉터리에서 `.exe` 파일을 찾아 실행
2. 서버 URL `https://wr.hospital.local` 입력 후 저장
3. 일반 사용자 계정으로 로그인 (section 4-4에서 생성한 계정)

> **로그인 직후 자동으로 device 등록 요청이 발생한다.**
> Electron `audit.js`의 `tryRegister()`가 `POST /api/devices/register`를 호출하여
> `buildTarget: 'intranet'`, Ed25519 공개키를 서버에 등록한다.

#### 5-2-2. pending 등록 확인

```bash
# psql로 확인
docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation \
  -c "SELECT id, status, build_target, register_ip, registered_at FROM devices ORDER BY registered_at DESC LIMIT 5;"
```

기대 출력:
```
 id (uuid) | status  | build_target | register_ip | registered_at
-----------+---------+--------------+-------------+------------------------------
 ...       | pending | intranet     | ...         | 2026-05-16 ...
```

또는 admin 패널 `관리 > 기기 관리` 탭에서 "승인 대기" 목록 확인.

#### 5-2-3. Admin 패널에서 device 승인

**Admin 패널 사용 (권장)**:

1. admin 계정으로 웹 브라우저 로그인 (`https://wr.hospital.local`)
2. `관리 > 기기 관리` 탭 → 해당 device "승인" 버튼 클릭

> **API 직접 호출은 권장하지 않는다.**
> `POST /api/admin/devices/:id/approve`는 `Authorization` 헤더 외에
> CSRF 토큰(`x-csrf-token`)도 요구한다 (`admin.ts` csrfMiddleware 적용).
> CSRF 토큰은 브라우저 세션에서만 자연스럽게 발급되므로,
> curl 등으로 호출하면 403이 반환된다.
> 승인은 반드시 Admin 패널 UI를 통해 수행한다.

#### 5-2-4. 승인 후 상태 확인

```bash
# DB에서 status=active 확인
docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation \
  -c "SELECT id, status, approved_at, approved_by FROM devices ORDER BY registered_at DESC LIMIT 5;"
```

기대 출력:
```
 id (uuid) | status | approved_at               | approved_by (uuid)
-----------+--------+---------------------------+--------------------
 ...       | active | 2026-05-16 ...            | ...
```

```bash
# audit_logs에서 device_approve 이벤트 확인
docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation \
  -c "SELECT action, actor_user_id, target_id, created_at FROM audit_logs WHERE action='device_approve' ORDER BY created_at DESC LIMIT 3;"
```

#### 5-2-5. 승인 후 Electron 기능 확인

승인 후 Electron 앱에서:

1. 앱 재시작 또는 재로그인 → `tryRegister()` 재호출 → status='active' 수신
2. 환자 1건 생성: `새 평가 > 환자 정보 입력 > 저장`
3. 생성된 환자 목록에서 조회 확인

```bash
# DB에서 patient_records count 확인 (환자 생성 smoke)
docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation \
  -c "SELECT count(*) FROM patient_records;"
# 기대: count = 1 이상
```

4. **EMR 추출/주입 1회 실행** → device 서명 감사 로그 생성

> device_id가 포함된 감사 로그는 환자 생성이 아니라 EMR inject/extract (`POST /api/audit/emr`)
> 에서 생성된다. 감사 서명 검증은 EMR 동작 1회 후에 확인해야 한다.

```bash
# EMR 동작 후: device_id 있는 audit log 확인 (Electron 감사 서명 증적)
docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation \
  -c "SELECT action, device_id, created_at FROM audit_logs WHERE device_id IS NOT NULL ORDER BY created_at DESC LIMIT 5;"
# 기대: device_id 있는 행 1개 이상
```

**T46f 합격 기준:**

| 항목 | 기준 | 증적 |
|---|---|---|
| device pending 등록 | `status='pending'`, `build_target='intranet'` | devices 쿼리 |
| admin 승인 | `status='active'`, `approved_at` 존재 | devices 쿼리 |
| device_approve audit | `device_approve` 이벤트 기록 | audit_logs 쿼리 |
| 환자 생성 smoke | `patient_records` count ≥ 1 | patient_records 쿼리 |
| EMR 감사 서명 | EMR 동작 후 `device_id IS NOT NULL` audit log 존재 | audit_logs 쿼리 |

> **조건부 PASS 처리**: Electron 빌드 미완성 시 위 항목 전체를 "조건부 PASS"로 표시하고
> `docs/T46_GO_NO_GO.md`에 미완성 사유와 재검증 일정을 기록한다.

### 5-3. 백업/복구 리허설 (T46g)

#### 5-3-1. 백업 실행 및 상태 확인

```bash
# 수동 백업 실행 (exec는 실행 중 컨테이너 대상 — -f 불필요)
docker compose -p wr-prod exec backup sh /scripts/backup.sh
```

성공 로그 기대:
```
[backup] YYYY-MM-DD HH:MM:SS — starting pg_dump
[backup] pg_dump complete (...)
[backup] Encrypted: /backups/daily/wr-backup-YYYYMMDD_HHMMSS.dump.gpg
[backup] Retention pruning complete
[backup] Status: success (runId=YYYYMMDD_HHMMSS, dryRun=0)
```

```bash
# 백업 상태 파일 확인
docker compose -p wr-prod exec app \
  cat /backups/_status/backup-status.json
# 기대: {"status":"success","runId":"YYYYMMDD_HHMMSS",...}
```

```bash
# 백업 파일 목록 확인 (실제 파일 생성 확인)
docker compose -p wr-prod exec backup \
  ls -lh /backups/daily/
# 기대: wr-backup-YYYYMMDD_HHMMSS.dump.gpg
```

```bash
# monitor report 갱신 (restart는 compose 설정을 읽으므로 -f 필요)
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file .env.production \
  -p wr-prod \
  restart backup-monitor

docker compose -p wr-prod exec app \
  cat /backups/_status/monitor-report.json
# 기대: {"summary":"ok",...}
```

> **사전조건**: T46g 직전에 Step 14 dry-run alert가 미해결(`resolvedAt: null`)로 남아 있으면
> `summary`가 `dry_run_alert_open`으로 계산된다 (`server/src/routes/opsStatus.ts` 기준).
> T46g 전에 Admin 패널 `관리 > 백업 현황`에서 dry-run alert를 해결 완료 처리하거나,
> dry-run alert가 없는 상태에서 진행해야 `summary: ok`를 얻을 수 있다.

**백업 파일명 기록** (복구 리허설에서 사용):

```bash
# 가장 최근 백업 파일명 확인 후 메모해둔다
docker compose -p wr-prod exec backup \
  sh -c 'ls -t /backups/daily/*.gpg | head -1'
# 예: /backups/daily/wr-backup-20260516_020000.dump.gpg
```

#### 5-3-2. 복구 리허설 — 별도 임시 환경에서만 수행

> ❌ **`docker compose -p wr-prod exec backup sh /scripts/restore.sh`는 절대 리허설에 사용하지 않는다.**
> `PGHOST=postgres`가 기본값이므로 production DB를 즉시 덮어쓴다.
>
> ✅ `restore.sh`는 `PGHOST` 환경변수를 지원한다. 임시 postgres 컨테이너를 띄우고
> `PGHOST`를 그 컨테이너로 리다이렉트하면 production DB에 영향 없이 복구를 검증할 수 있다.

**사전 준비: 복구 전 production row count 기록**

```bash
# 리허설 전 production count 기록 (비교 기준)
docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation \
  -c "SELECT 'users' AS tbl, count(*) FROM users
      UNION ALL SELECT 'patient_records', count(*) FROM patient_records
      UNION ALL SELECT 'audit_logs',      count(*) FROM audit_logs;"
```

**GPG private key 정책:**

> 복구에 사용하는 GPG private key는 **passphrase 없는 복구 전용 키**여야 한다.
> `gpg --batch --import` + `gpg --batch --decrypt`는 pinentry/agent 없이 실행되므로
> passphrase가 설정된 키는 비대화형 컨테이너 환경에서 복호화에 실패한다.
> passphrase가 있는 키를 사용해야 한다면 `--pinentry-mode loopback --passphrase-fd 0`
> 방식으로 restore.sh를 수정해야 하며, 이는 별도 운영 정책으로 관리한다.

**복구 리허설 절차 — Linux:**

```bash
# ── 0. 준비 ──────────────────────────────────────────────────────────────────
ls wr-backup-private.asc   # GPG private key 존재 확인
# .env.production에서 WR_VERSION 읽기
WR_VERSION=$(grep '^WR_VERSION=' .env.production | cut -d= -f2)
echo "WR_VERSION=${WR_VERSION}"   # 빈 값이면 중단

# 복구할 파일 지정 (5-3-1에서 확인한 파일명으로 교체)
RESTORE_SOURCE=/backups/daily/wr-backup-YYYYMMDD_HHMMSS.dump.gpg

# ── 1. 임시 네트워크 + postgres 컨테이너 기동 ─────────────────────────────────
docker network create wr-restore-test-net

docker run -d \
  --name wr-restore-test-db \
  --network wr-restore-test-net \
  -e POSTGRES_PASSWORD=restore_test_pw \
  -e POSTGRES_USER=wr_user \
  -e POSTGRES_DB=wr_evaluation \
  -v wr-restore-test-data:/var/lib/postgresql/data \
  postgres:16-alpine

# postgres ready 대기
until docker exec wr-restore-test-db \
  pg_isready -U wr_user -d wr_evaluation 2>/dev/null; do sleep 2; done
echo "restore-test-db ready"

# ── 1-a. wr_audit_reader role 생성 ────────────────────────────────────────────
# backup dump에 wr_audit_reader GRANT가 포함되어 있으므로 role이 없으면 pg_restore 오류.
# production의 실제 비밀번호와 다른 임시값을 사용한다.
docker exec wr-restore-test-db \
  psql -U wr_user -d wr_evaluation \
  -c "CREATE ROLE wr_audit_reader LOGIN PASSWORD 'restore_audit_pw';"

# ── 2. 복구 실행 ──────────────────────────────────────────────────────────────
# - restore.sh는 이미지에 COPY되지 않으므로 bind mount 필수 (backup/Dockerfile 참조)
# - GPG private key는 ephemeral GNUPGHOME에 import → --rm 컨테이너 종료 시 자동 폐기
# - restore.sh의 "YES" 확인 프롬프트 때문에 -it 필수
docker run --rm -it \
  --network wr-restore-test-net \
  -e PGHOST=wr-restore-test-db \
  -e PGPORT=5432 \
  -e PGUSER=wr_user \
  -e PGPASSWORD=restore_test_pw \
  -e PGDATABASE=wr_evaluation \
  -e RESTORE_AUTH_TICKET="REHEARSAL-$(date +%Y%m%d)" \
  -v wr-prod_backup_data:/backups:ro \
  -v "$(pwd)/scripts/restore.sh:/scripts/restore.sh:ro" \
  -v "$(pwd)/wr-backup-private.asc:/tmp/private-key.asc:ro" \
  wr-backup:${WR_VERSION} \
  sh -c 'export GNUPGHOME=$(mktemp -d) \
    && gpg --batch --import /tmp/private-key.asc \
    && sh /scripts/restore.sh "'"${RESTORE_SOURCE}"'"'
# 프롬프트: "Type 'YES' to proceed:" → YES 입력
```

**복구 리허설 절차 — Windows PowerShell:**

```powershell
# ── 0. 준비 ──────────────────────────────────────────────────────────────────
if (-not (Test-Path wr-backup-private.asc)) { Write-Error "GPG key not found"; exit 1 }
$_match = Get-Content .env.production | Select-String '^WR_VERSION=(.+)$'
$WR_VERSION = if ($_match) { $_match.Matches[0].Groups[1].Value } else { $null }
if (-not $WR_VERSION) { Write-Error "WR_VERSION not set in .env.production"; exit 1 }
Write-Host "WR_VERSION=$WR_VERSION"

# 복구할 파일 지정 (5-3-1에서 확인한 파일명으로 교체)
$RESTORE_SOURCE = "/backups/daily/wr-backup-YYYYMMDD_HHMMSS.dump.gpg"
$TICKET = "REHEARSAL-$(Get-Date -Format yyyyMMdd)"
$SCRIPT_PATH = (Resolve-Path .\scripts\restore.sh).Path.Replace('\','/')
$KEY_PATH    = (Resolve-Path .\wr-backup-private.asc).Path.Replace('\','/')

# ── 1. 임시 네트워크 + postgres 컨테이너 기동 ─────────────────────────────────
docker network create wr-restore-test-net

docker run -d `
  --name wr-restore-test-db `
  --network wr-restore-test-net `
  -e POSTGRES_PASSWORD=restore_test_pw `
  -e POSTGRES_USER=wr_user `
  -e POSTGRES_DB=wr_evaluation `
  -v wr-restore-test-data:/var/lib/postgresql/data `
  postgres:16-alpine

# postgres ready 대기
do { Start-Sleep 2 } until (
  (docker exec wr-restore-test-db pg_isready -U wr_user -d wr_evaluation 2>$null) -and $?
)
Write-Host "restore-test-db ready"

# ── 1-a. wr_audit_reader role 생성 ────────────────────────────────────────────
docker exec wr-restore-test-db `
  psql -U wr_user -d wr_evaluation `
  -c "CREATE ROLE wr_audit_reader LOGIN PASSWORD 'restore_audit_pw';"

# ── 2. 복구 실행 ──────────────────────────────────────────────────────────────
docker run --rm -it `
  --network wr-restore-test-net `
  -e PGHOST=wr-restore-test-db `
  -e PGPORT=5432 `
  -e PGUSER=wr_user `
  -e PGPASSWORD=restore_test_pw `
  -e PGDATABASE=wr_evaluation `
  -e "RESTORE_AUTH_TICKET=$TICKET" `
  -v wr-prod_backup_data:/backups:ro `
  -v "${SCRIPT_PATH}:/scripts/restore.sh:ro" `
  -v "${KEY_PATH}:/tmp/private-key.asc:ro" `
  "wr-backup:${WR_VERSION}" `
  sh -c "export GNUPGHOME=`$(mktemp -d) && gpg --batch --import /tmp/private-key.asc && sh /scripts/restore.sh '${RESTORE_SOURCE}'"
# 프롬프트: "Type 'YES' to proceed:" → YES 입력
```

```bash
# ── 3. 복구 결과 확인 (임시 DB) — Linux ──────────────────────────────────────
docker exec wr-restore-test-db \
  psql -U wr_user -d wr_evaluation \
  -c "SELECT 'users' AS tbl, count(*) FROM users
      UNION ALL SELECT 'patient_records', count(*) FROM patient_records
      UNION ALL SELECT 'audit_logs',      count(*) FROM audit_logs;"
# 기대: 백업 시점의 count와 일치
```

```powershell
# ── 3. 복구 결과 확인 (임시 DB) — PowerShell ─────────────────────────────────
docker exec wr-restore-test-db psql -U wr_user -d wr_evaluation -c "SELECT 'users' AS tbl, count(*) FROM users UNION ALL SELECT 'patient_records', count(*) FROM patient_records UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs;"
```

```bash
# ── 4. production DB 불변 확인 — Linux ────────────────────────────────────────
docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation \
  -c "SELECT 'users' AS tbl, count(*) FROM users
      UNION ALL SELECT 'patient_records', count(*) FROM patient_records
      UNION ALL SELECT 'audit_logs',      count(*) FROM audit_logs;"
# 기대: 리허설 전 기록과 동일 (production 무영향 확인)
```

```powershell
# ── 4. production DB 불변 확인 — PowerShell ──────────────────────────────────
docker compose -p wr-prod exec postgres psql -U wr_user -d wr_evaluation -c "SELECT 'users' AS tbl, count(*) FROM users UNION ALL SELECT 'patient_records', count(*) FROM patient_records UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs;"
```

```bash
# ── 5. 임시 환경 정리 — Linux ────────────────────────────────────────────────
docker rm -f wr-restore-test-db
docker volume rm wr-restore-test-data
docker network rm wr-restore-test-net
rm -f wr-backup-private.asc
ls wr-backup-private.asc 2>/dev/null && echo "WARNING: key not deleted" || echo "Key deleted OK"
```

```powershell
# ── 5. 임시 환경 정리 — PowerShell ──────────────────────────────────────────
docker rm -f wr-restore-test-db
docker volume rm wr-restore-test-data
docker network rm wr-restore-test-net
Remove-Item -Force wr-backup-private.asc -ErrorAction SilentlyContinue
if (Test-Path wr-backup-private.asc) { Write-Warning "Key not deleted!" } else { Write-Host "Key deleted OK" }
```

**T46g 합격 기준:**

| 항목 | 기준 | 증적 |
|---|---|---|
| 백업 성공 | `backup-status.json` → `status: success` | exec app cat |
| 백업 파일 존재 | `/backups/daily/wr-backup-*.dump.gpg` 생성 | exec backup ls |
| monitor ok | `monitor-report.json` → `summary: ok` (dry-run alert 해결 후) | exec app cat |
| wr_audit_reader role | 임시 DB에 role 생성 후 pg_restore 오류 없음 | docker exec psql |
| 임시 DB 복구 | row count가 백업 시점과 일치 | docker exec psql |
| production 무영향 | 리허설 전후 production count 동일 | exec postgres psql |
| private key 삭제 | `wr-backup-private.asc` 없음 | ls / Test-Path |

자세한 절차: [BACKUP_RESTORE.md](BACKUP_RESTORE.md)

---

## 6. 롤백 절차 (T46h)

> **원칙**: volume을 절대 삭제하지 않는다. 데이터는 항상 보존한다.
> 롤백은 "app 이미지 교체"와 "DB restore를 수반한 전체 롤백" 두 경로만 존재한다.

### 6-0. 롤백 전 필수 확인

```bash
# 현재 running 이미지 tag 기록 (롤백 실패 시 복구 기준)
docker inspect wr-prod-app-1 --format '{{.Config.Image}}'
# 예: wr-app-server:4.2.1

# 현재 migration 상태 기록
docker compose -p wr-prod exec postgres \
  psql -U wr_user -d wr_evaluation \
  -c "SELECT id, applied_at FROM schema_migrations ORDER BY id DESC LIMIT 5;"

# 롤백 직전 수동 백업 1회 실행 (되돌릴 수 없는 작업 전 안전망)
docker compose -p wr-prod exec backup sh /scripts/backup.sh
```

### 6-1. 경로 판단: migration 적용 여부 확인

```bash
# 현재 버전 vs 이전 버전의 migration 파일 수 비교
# server/migrations/ 디렉터리에서 새 버전에서 추가된 파일이 있는지 확인
ls server/migrations/
# 현재: 0001~0015 (총 15개)

# 이전 버전 이미지의 migration 수 확인
docker run --rm wr-app-server:4.2.0 \
  ls /app/server/migrations/ 2>/dev/null | wc -l
```

| 상황 | 롤백 경로 |
|---|---|
| migration 추가 없음 (파일 수 동일) | **6-2: 이미지 교체만** |
| migration 추가 있음 (비가역) | **6-3: DB restore 수반 전체 롤백** |

### 6-2. 이미지 교체 롤백 (migration 없는 경우)

```bash
# 이전 버전 이미지가 로컬에 있는지 확인
docker images wr-app-server
# 없으면 이전 패키지의 wr-images.tar를 docker load 한다

# app 컨테이너만 이전 이미지로 교체 (--no-deps: postgres/caddy 중단 없음)
# .env.production의 WR_VERSION을 이전 버전으로 수정하거나 직접 지정
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file .env.production \
  -p wr-prod \
  up -d --no-deps \
  --scale app=1 \
  app
```

```powershell
# Windows PowerShell
docker compose `
  -f docker-compose.yml `
  -f docker-compose.prod.yml `
  --env-file .env.production `
  -p wr-prod `
  up -d --no-deps app
```

롤백 확인:
```bash
# 이미지가 이전 버전으로 바뀌었는지 확인
docker inspect wr-prod-app-1 --format '{{.Config.Image}}'
# 기대: wr-app-server:4.2.0

# app이 healthy인지 확인
docker compose -p wr-prod ps
# 기대: wr-prod-app-1  healthy
```

### 6-3. DB restore 수반 전체 롤백 (migration 적용된 경우)

> migration이 적용된 상태에서 이미지만 교체하면 구버전 app이 신 스키마에서 실행됨.
> 이 경우 **No-Go 조건** — DB restore가 필수다.

```bash
# 1. app 중지 (postgres/caddy는 유지)
docker compose -p wr-prod stop app

# 2. 롤백 직전 백업이 있는지 확인 (6-0에서 수행한 백업)
docker compose -p wr-prod exec backup \
  ls -lt /backups/daily/ | head -5

# 3. DB restore (PRODUCTION_RELEASE_PLAN.md section 5-3-2 + BACKUP_RESTORE.md 5절)
#    반드시 2인 승인 + RESTORE_AUTH_TICKET 획득 후 수행
#    대상: 이전 버전 배포 직전 백업 파일

# 4. .env.production의 WR_VERSION을 이전 버전으로 수정
#    (또는 docker-compose.prod.yml에서 image tag를 직접 지정)

# 5. 이전 버전 이미지로 app 재시작
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file .env.production \
  -p wr-prod \
  up -d --no-deps app

# 6. health 확인
docker compose -p wr-prod ps
docker compose -p wr-prod logs app --tail=50
```

### 6-4. 롤백 금지 명령어

```
docker compose -p wr-prod down -v          ❌  volume 삭제로 데이터 전체 유실
docker volume rm wr-prod_postgres_data     ❌  운영 DB 삭제
docker compose -p wr-prod down             ⚠️  컨테이너만 삭제 (volume 보존) — 불필요하면 사용 금지
```

### 6-5. 롤백 리허설 Dry-run (T46h 증적)

실제 production을 변경하지 않고 롤백 명령을 검증:

```bash
# 현재 이미지 tag 확인 (증적 기록)
docker inspect wr-prod-app-1 --format '{{.Config.Image}}'

# docker compose config로 이전 버전 이미지가 올바르게 지정되는지 검증
# (실제 up은 실행하지 않음)
WR_VERSION=4.2.0 docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file .env.production \
  -p wr-prod \
  config | grep "image:"
# 기대: image: wr-app-server:4.2.0 (app 서비스 라인)
```

```powershell
# Windows PowerShell dry-run
$env:WR_VERSION = "4.2.0"
docker compose `
  -f docker-compose.yml `
  -f docker-compose.prod.yml `
  --env-file .env.production `
  -p wr-prod `
  config | Select-String "image:"
$env:WR_VERSION = ""  # 원복
```

**T46h 합격 기준:**

| 항목 | 기준 | 증적 |
|---|---|---|
| 현재 이미지 tag 확인 | `docker inspect` 출력 | 콘솔 로그 |
| migration 판단 기준 적용 | 경로 6-2 또는 6-3 선택 근거 기록 | 문서 기록 |
| dry-run config 검증 | `config \| grep image:` → 이전 버전 tag 출력 | 콘솔 로그 |
| 금지 명령어 미실행 | `down -v` 미실행, `wr-prod_*` production volume 삭제 없음 | 명령 이력 |

---

## 7. Production Volume 정책

`-p wr-prod` 사용 시 생성되는 volume 이름:

| Volume | 용도 | 보존 정책 |
|---|---|---|
| `wr-prod_postgres_data` | 주 DB 데이터 | 영구 보존, 삭제 금지 |
| `wr-prod_caddy_data` | Caddy cert/CA | 재생성 가능 (인증서 재발급 필요) |
| `wr-prod_caddy_config` | Caddy 런타임 설정 | 재생성 가능 |
| `wr-prod_backup_data` | GPG 암호화 백업 파일 | 영구 보존 |
| `wr-prod_backup_alerts` | 백업 알림 파일 | 재생성 가능 |
| `wr-prod_backup_gnupg` | GPG keyring | 분실 시 재등록 필요 |

**규칙:**
- dev/staging volume (`wr-evaluation-unified_*`)과 절대 혼용하지 않는다.
- `wr-prod_postgres_data`와 `wr-prod_backup_data`는 정기 외장 미디어 또는 안전한 위치에 별도 보존 고려.

---

## 8. 릴리스 체크리스트

배포 전 최종 확인:

- [ ] `.env.production`에 `changeme_` 문자열 없음: `grep -i changeme .env.production`
- [ ] ACCESS_TOKEN_SECRET, REFRESH_TOKEN_SECRET이 32바이트 이상 랜덤값
- [ ] app 포트가 외부에 직접 노출되지 않음 (`docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production -p wr-prod port app 3001` → 빈 출력)
- [ ] Caddy 인증서 정상 발급: `https://wr.hospital.local` 접속 시 인증서 오류 없음
- [ ] admin 계정 초기 비밀번호 변경 완료
- [ ] AUDIT_DB_PASSWORD ALTER ROLE 실행 완료
- [ ] 사용자 정의 프리셋은 계정별 `private` 저장으로 동작함
- [ ] GPG 공개키 등록 및 백업 1회 성공
- [ ] 클라이언트 PC CA 인증서 설치 확인 (INTRANET_DEPLOYMENT.md 3절)
- [ ] T46 Go/No-Go 결과표 PASS (docs/T46_GO_NO_GO.md)
