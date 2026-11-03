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
9. [호스트 Caddy 전환 (접속자 실제 IP 기록)](#9-호스트-caddy-전환-접속자-실제-ip-기록)

---

## 1. 전제 조건

| 항목 | 요건 |
|---|---|
| 서버 OS | Linux Ubuntu 22.04 LTS 또는 Windows Server 2019+ |
| Docker Engine | 24.0 이상. **Linux 호스트는 28.0.0 이상** — 앱을 `127.0.0.1`에만 게시하는데, 28.0.0 이전 엔진은 같은 L2 네트워크의 다른 호스트가 localhost 게시 포트에 접근할 수 있다([moby#45610](https://github.com/moby/moby/issues/45610)). Windows Docker Desktop은 게시 포트를 Windows 루프백 리스너가 받으므로 이 제약과 무관하다. `scripts/check-app-publish.ps1`이 기동 전에 확인한다 |
| Docker Compose | v2.17 이상 (`!reset` tag 지원 필요). `!override`는 쓰지 않는다(v2.24.4 미만은 오류 없이 무시) |
| DNS | `wr.hospital.local` → 서버 IP (클라이언트 전 PC에 적용) |
| 방화벽 | 서버 포트 8443(HTTPS)·8080(HTTP → HTTPS 리다이렉트) 인바운드 허용. 호스트 Caddy 모드(9절)에서는 설치 스크립트가 `caddy.exe` 한정 규칙을 따로 만든다 |
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

### 3-0-1. (선택) 릴리스 PC에서 패키지 그대로 리허설 — `verify-stack.ps1`

운영 서버에 올리기 전에, 방금 만든 패키지를 이 PC의 Docker에서 운영과 같은 구성(Caddy TLS + 앱 + postgres)으로 띄워 인트라넷 설치본과 서명 업데이트를 시험한다. 인트라넷 설치본은 시작할 때 `https://wr.hospital.local:8443`을 불러오므로, 이 PC에 그 서버가 없으면 빈 화면이 된다. 이 스크립트가 그 서버 역할을 한다. 프로젝트 이름은 `wr-verify`로 고정이라 `wr-prod`(운영)나 개발 스택(Tier-3)의 컨테이너·볼륨을 건드리지 않는다.

```powershell
pwsh -File scripts/verify-stack.ps1 up -LaunchShell   # 이미지 ID 대조 → 기동 → 8443 응답·/updates 확인 → 설치본 실행
pwsh -File scripts/verify-stack.ps1 seed-admin        # 첫 관리자 계정 (최초 1회, 기관·로그인 ID·비밀번호 입력)
pwsh -File scripts/verify-stack.ps1 status            # 컨테이너·CA 신뢰·주소별 응답
pwsh -File scripts/verify-stack.ps1 down              # 내리기 (DB 유지)
pwsh -File scripts/verify-stack.ps1 purge -Force      # 볼륨까지 삭제 (공유 Caddy CA 볼륨은 보존)
```

- 필요: PowerShell 7, Docker, hosts의 `127.0.0.1 wr.hospital.local`, 패키지 폴더 `release\wr-evaluation-unified-<버전>-intranet`(`-PackageDir`로 지정 가능).
- **패키지 그대로**: 패키지의 `docker-compose.yml` + `docker-compose.prod.yml`과 패키지에 담긴 이미지를 쓴다. `up`은 로컬 이미지 ID가 `release-manifest.json`과 같은지 먼저 확인한다(다르면 `-LoadImages`로 패키지의 tar를 불러온다). 패키지의 `updates\`가 `/updates/`로 서빙되므로 서명된 `latest.yml.sig` 업데이트 시험에 쓴다.
- **환경 파일**: `release\.verify-stack\wr-verify.env`에 시험 전용 무작위 값으로 만든다. 실제 `.env.production`은 읽지 않는다. 통계 워크벤치는 기본으로 켜 둔다(서버가 꺼 두면 설치본에 통계분석 버튼이 뜨지 않는다). 영상 분석은 운영 기본값(꺼짐)을 따르며, 이 파일의 주석을 풀고 `up`을 다시 실행하면 켜진다.
- **TLS**: 기존 Caddy CA 볼륨(`wr-evaluation-unified_caddy_data`)을 재사용한다. 그 루트가 Windows에 신뢰 등록돼 있으면 별도 설치가 필요 없다(`up`·`status`가 지문으로 알려 준다). 새 CA를 쓰려면 `-FreshCa`이며 루트 인증서를 직접 신뢰 등록해야 한다. 오래 멈춰 있던 볼륨의 서버 인증서(수명 6일)는 만료돼 있으므로 `up`이 Caddy를 한 번 재시작해 새로 발급받는다.
- **호스트 Caddy 모드**: 관리자 창에서 `install-caddy-host.ps1 -Install … -ProjectName wr-verify` → `-Cutover`로 이 스택을 host 모드로 바꾸면(9절과 같은 절차, `-EnvFile release\.verify-stack\wr-verify.env -ComposeDir <패키지> -ExtraComposeFile release\.verify-stack\wr-verify.override.yml`) `up`·`status`가 그 상태를 알아보고 8443 을 쥔 `wr-caddy` 를 정상으로 본다. 설치 기록·서비스·환경 파일이 서로 맞지 않으면 무엇이 다른지 보여 주고 멈춘다. `verify-stack.ps1` 은 설치·전환·롤백을 하지 않는다.
- **수용 시험** `pwsh -File scripts/verify-stack.ps1 accept`(host 모드에서만): 루프백·이 PC의 LAN 주소 두 출발지에서 잘못된 로그인을 보내 ① 감사 로그 IP가 출발지 그대로·서로 다르게 남는지 ② 로그인 제한(분당 5회)이 출발지별 버킷인지 ③ 8 KiB 헤더가 통과하는지 확인한다. LAN 주소는 화면에만 출력한다.
- 이 스택은 리허설용이다. 백업 서비스(GPG)는 띄우지 않으며, 아래 4절(초기화)·5절(검증)의 운영 절차를 대체하지 않는다.

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

### 3-1-1. (선택) Electron 자동 업데이트용 `/updates/` 스테이징

트랙 2(electron-updater) 도입 이후 오프라인 패키지에는 설치본(.exe) + `.blockmap` +
`latest.yml`(또는 `canary.yml`) + 그 서명 `.sig`(7.1.4~, INTRANET_DEPLOYMENT.md 7-6) 4종이 **`electron/`(신규 PC 설치용)과 `updates/`(서버 서빙용) 두 곳에**
들어 있고, `electron/`에는 `update-policy.example.json` 템플릿이 추가로 있다. `docker-compose.yml`이
`./updates`를 컨테이너 `/app/updates`에 read-only 마운트하므로, **패키지 폴더에서 그대로 기동하면 4종은
별도 복사 없이 서빙된다.** 서명 없는 피드는 7.1.4 이후 셸이 모두 거부하므로 패키지는 서명 키(`export-offline-package.ps1 -UpdateSigningKey`)로 만들어야 하고, `updates/`에 yml만 따로 복사하지 말고 폴더를 통째로 복사한다. 이 단계는 최초 설치 자체에는 필요 없다 — 클라이언트 PC 설치는 여전히 5-2-1의
수동 인스톨러 실행 방식 그대로다(`update-policy.json`이 없으면 업데이터는 휴면).

**기존 서버를 새 패키지 폴더로 교체하는 경우**에는 compose의 `./updates`가 새 폴더를 가리키므로,
이전 폴더 `updates/`에 `update-policy.json`·canary 피드 등을 올려 둔 적이 있다면 새 폴더 `updates/`로
옮긴다(없으면 생략). **canary는 설치본·`.blockmap`·`canary.yml`·`canary.yml.sig` 4종을 함께** 옮긴다 —
`.sig` 없이 `canary.yml`만 옮기면 7.1.4 이상 canary PC가 업데이트를 거부한다:

```powershell
# 이전 패키지 폴더 → 새 패키지 폴더 (있는 것만)
Copy-Item "<이전 폴더>\updates\update-policy.json" "<새 폴더>\updates\"                # 정책 파일이 있을 때만
# canary 롤아웃 중일 때만 — canary 피드 4종을 한 벌로
Copy-Item "<이전 폴더>\updates\canary.yml*" "<새 폴더>\updates\"                      # canary.yml + canary.yml.sig
Copy-Item "<이전 폴더>\updates\<canary 설치본 파일명>*" "<새 폴더>\updates\"            # 설치본(.exe) + .blockmap
```

7.1.4 **이전**(서명 도입 전)에 만든 canary 피드에는 `.sig`가 없어 옮겨도 7.1.4 이상 canary PC는 받지 않는다(7.1.3 이하 PC는
서명을 보지 않으므로 받는다). 그런 canary는 옮기지 말고 7.1.4 패키지 기준으로 `-UpdateChannel canary -UpdateSigningKey ...`로
다시 만든다.

**`update-policy.json`(관리자 on/off 스위치)은 여기서 배치하지 않는다** — 템플릿(`update-policy.example.json`)만
동봉되어 있으며, 기본은 비활성 상태를 유지해야 한다. 실제 롤아웃(canary → 전체 → 휴면 복귀) 절차는
`INTRANET_DEPLOYMENT.md` 7절을 그대로 따른다. 최초 배포(빈 DB에서 처음 설치하는 리허설)에서는
아직 배포된 클라이언트가 없으므로 보통 이 단계를 건너뛰어도 무방하다.

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
# 5. app 포트 노출 확인 (루프백에만 게시돼 있어야 함)
# port 명령은 compose 설정을 읽으므로 전체 플래그 필요
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file .env.production \
  -p wr-prod \
  port app 3001
# 기대: 127.0.0.1:3001 (WR_APP_PORT를 바꿨으면 그 번호) — 0.0.0.0 이나 [::] 가 보이면 실패
# 앱은 서버 PC 안에서만 닿는 루프백에 게시된다(docker-compose.prod.yml이 호스트 주소를 127.0.0.1로 고정).
# 다른 PC(또는 서버의 LAN 주소)에서는 접속이 거부돼야 한다:
#   Test-NetConnection <서버 LAN 주소> -Port 3001   → TcpTestSucceeded : False
```

> **이전 기준과 다르다.** 루프백 게시 도입 전 패키지는 `ports: !reset []`로 앱을 전혀 게시하지 않아 위 명령이
> "빈 출력"이었다. 지금은 `127.0.0.1:<포트>`가 정상이며, 판정 기준은 "LAN에서 닿지 않음"이다. 기동 전 점검은
> `.\scripts\check-app-publish.ps1`(설치 스크립트가 자동 실행)이 한다.

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
| dev volume 미마운트 | postgres 컨테이너가 `wr-prod_postgres_data`만 마운트 | `docker inspect wr-prod-postgres-1 --format '{{range .Mounts}}{{println .Name}}{{end}}'` |
| app healthy | `STATUS: healthy` | `docker compose -p wr-prod ps` |
| caddy healthy | `STATUS: healthy` | `docker compose -p wr-prod ps` |
| migration 성공 | ERROR/FATAL 없음 + 위 테이블 목록 | `logs app + \dt` |
| app 포트 미노출 | `127.0.0.1:3001`(또는 `WR_APP_PORT` 번호)에만 게시, LAN 주소로는 접속 거부 | `docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production -p wr-prod port app 3001` + 다른 PC에서 `Test-NetConnection <서버 주소> -Port 3001` → False |

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
  --format '{{range .Mounts}}{{println .Name}}{{end}}'
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
   - (트랙 2 이후) 같은 디렉터리에 `.blockmap`/`latest.yml`(또는 `canary.yml`)/`.yml.sig`/
     `update-policy.example.json`이 함께 있으나, **첫 설치에는 `.exe`만 사용**한다 —
     나머지는 3-1-1의 서버 측 자동 업데이트 스테이징용이다.
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
| `wr-prod_caddy_data` | Caddy 내부 CA 키·인증서 | **영구 보존, 삭제 금지** — 잃으면 새 CA가 생겨 모든 클라이언트 PC에 루트 인증서를 다시 설치해야 한다. 일일 DB 백업 대상이 아니므로 7-1의 CA 키 백업이 필요. 호스트 Caddy 모드(9절)에서도 지우지 않는다 — 설치·재설치가 이 볼륨에서 CA를 복사하고(지문 대조), 롤백한 Docker Caddy도 이 볼륨을 쓴다 |
| `wr-prod_caddy_config` | Caddy 런타임 설정 | 재생성 가능 |
| `wr-prod_backup_data` | GPG 암호화 백업 파일 | 영구 보존 |
| `wr-prod_backup_alerts` | 백업 알림 파일 | 재생성 가능 |
| `wr-prod_backup_gnupg` | GPG keyring | 분실 시 재등록 필요 |

**규칙:**
- dev/staging volume (`wr-evaluation-unified_*`)과 절대 혼용하지 않는다.
- `wr-prod_postgres_data`와 `wr-prod_backup_data`는 정기 외장 미디어 또는 안전한 위치에 별도 보존 고려.
- `wr-prod_caddy_data`는 일일 백업 대상이 **아니다**. 최초 배포 직후·연 1회·서버 이전이나 볼륨 작업 직전에 `scripts\backup-caddy-ca.ps1`로 CA 키를 백업한다(7-1).
- 호스트 Caddy 모드의 CA 사본 `C:\ProgramData\wr-caddy\data`(관리자·SYSTEM·서비스 계정만 읽기)는 설치 스크립트가 볼륨에서 복사한 것이다. 제거(`-Uninstall`)해도 자동으로 지우지 않는다. 지울 때는 볼륨이 남아 있고 그 루트 지문이 클라이언트와 같은지 먼저 확인한다.

### 7-1. Caddy 내부 CA 키 백업·복구

**왜 필요한가**: 모든 클라이언트 PC가 Caddy 내부 CA의 루트 인증서를 신뢰 등록해 두었다(INTRANET_DEPLOYMENT.md 3절). `wr-prod_caddy_data` 볼륨을 잃으면 Caddy가 **새 CA**를 만들고, 그 루트 인증서를 병원 PC 전부에 다시 설치해야 한다. 이 볼륨은 일일 DB 백업(backup 서비스)의 대상이 아니다. 이 CA의 비밀 키(`root.key`, `intermediate.key`)를 가진 사람은 병원 PC가 신뢰하는 가짜 서버 인증서를 만들 수 있으므로, 백업 파일은 반드시 암호화하고 개인 키와 따로 보관한다.

**언제**: 최초 배포 직후 1회 · 이후 연 1회(루트는 약 10년 수명이지만 중간 인증서는 365일 수명이라 갱신될 수 있다) · 서버 이전, Docker 재설치, 볼륨 작업 직전.

**백업** (서버, 패키지 루트에서 실행. Windows PowerShell 5.1과 PowerShell 7 모두 된다):

```powershell
.\scripts\backup-caddy-ca.ps1
# 다른 compose 프로젝트(리허설 설치 등)라면:  -Project wr-prod-test -EnvFile .\.env.rehearsal
```

- `.env.production`에서 `BACKUP_GPG_RECIPIENT`와 `WR_VERSION`만 읽는다. 기존 DB 백업과 같은 **GPG 공개 키**로 암호화하며, 그 키가 `wr-prod_backup_gnupg` 볼륨에 등록돼 있어야 한다(BACKUP_RESTORE.md 3-2). 서버에는 복호화에 필요한 개인 키가 없다.
- 결과물: `caddy-ca-wr-prod-<시각>.tar.gpg`(암호화된 CA 키·인증서 4개)와 `.info.txt`(루트 인증서 지문 등 공개 정보만). 암호화되지 않은 파일은 디스크에 쓰지 않는다(tar는 컨테이너 메모리에만 만들어진다). `caddy_data` 볼륨은 읽기 전용으로 마운트하며 키 내용은 화면에 출력하지 않는다.
- 두 파일을 **오프라인 매체(USB·금고)**로 옮기고 서버의 작업 사본은 지운다. 복호화에 필요한 **개인 GPG 키는 이 파일과 다른 매체**에 보관한다(BACKUP_RESTORE.md 3-1).
- 백업 직후 `.info.txt`의 `Root SHA-1` 지문이 클라이언트 PC에 설치된 인증서의 지문(`Get-ChildItem Cert:\CurrentUser\Root` 또는 `LocalMachine\Root`의 `WR Evaluation Internal CA` 항목)과 같은지 한 번 확인한다.
- **호스트 Caddy 모드(9절)에서는** 서비스가 실제로 쓰는 사본(`C:\ProgramData\wr-caddy\data`)도 백업한다. 그 폴더는 관리자만 읽을 수 있으므로 **관리자 창**에서 실행한다. 스크립트가 파일 4개를 읽어 컨테이너 메모리로 넘기고, 원본과 SHA-256이 같을 때만 암호화한다(평문은 디스크에 남지 않는다). 아카이브 형식은 볼륨 백업과 같아 아래 복구 절차를 그대로 쓴다. 설치 기록의 루트와 다르면 아무것도 쓰지 않고 멈춘다.
  ```powershell
  .\scripts\backup-caddy-ca.ps1 -SourceDir C:\ProgramData\wr-caddy\data -EnvFile $envFile
  ```

**복구** (CA 볼륨을 잃었거나 새 서버로 옮길 때):

1. **개인 GPG 키가 있는 PC**에서 복호화한다. 결과는 `local\` 폴더(키 4개 — 평문이므로 취급 주의)다.
   ```powershell
   gpg --decrypt .\caddy-ca-wr-prod-<시각>.tar.gpg | tar -xf -
   ```
2. `local\` 폴더를 서버로 옮기고 Caddy를 멈춘다.
   ```powershell
   docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production -p wr-prod stop caddy
   ```
3. 볼륨에 덮어쓴다. `<폴더>`는 `local\`이 들어 있는 폴더의 전체 경로다.
   ```powershell
   docker run --rm --entrypoint sh -v wr-prod_caddy_data:/data -v "<폴더>:/in:ro" wr-backup:<WR_VERSION> -c 'mkdir -p /data/caddy/pki/authorities/local && cp -a /in/local/. /data/caddy/pki/authorities/local/ && chown -R 0:0 /data/caddy/pki/authorities/local && chmod 700 /data/caddy/pki/authorities/local && chmod 600 /data/caddy/pki/authorities/local/*'
   ```
4. Caddy를 시작하고(`... -p wr-prod up -d caddy`) 루트 지문이 `.info.txt`와 같은지 확인한다.
   ```powershell
   docker exec wr-prod-caddy-1 cat /data/caddy/pki/authorities/local/root.crt > check-root.crt
   (Get-PfxCertificate -FilePath .\check-root.crt).Thumbprint
   ```
5. 지문이 같으면 클라이언트 PC에서 할 일은 없다(같은 루트를 계속 신뢰한다). 평문 `local\` 폴더와 `check-root.crt`를 지운다.

복구 절차는 **운영 밖에서 한 번 리허설**해 두는 것이 좋다. 시험용 키로 백업을 만들어 복호화하고 새 볼륨에 복원했을 때 4개 파일이 원본과 바이트 단위로 같았다(스크립트 도입 시 확인).

**호스트 Caddy 모드(9절)에서의 복구** — 호스트 사본(`C:\ProgramData\wr-caddy\data`)에 직접 복원하지 않는다. 호스트 사본은 언제나 설치 스크립트(`-Install`)가 볼륨에서 지문을 대조해 복사한다. 아래 명령의 `$envFile`은 현재 운영 env의 절대 경로다(9절 "env 경로 규칙").

| 상황 | 절차 |
|---|---|
| 볼륨만 잃었고 호스트 사본은 정상 | 위 1~5단계로 백업 아카이브(`-SourceDir` 백업이든 볼륨 백업이든)를 새 볼륨에 복원한다. host 모드는 그대로 운영된다. Docker Caddy로 돌아가려면 그 뒤에 `.\caddy-host\install-caddy-host.ps1 -Rollback -EnvFile $envFile` |
| 둘 다 정상이고 다시 설치만 필요 | `-Rollback -EnvFile $envFile` → `-Uninstall` → `-Install …`(9-2) → `-Cutover -EnvFile $envFile`(9-3) |
| **호스트 사본이 없거나 손상됨** | `-Rollback`·`-Uninstall`은 시작할 때 호스트 사본의 루트를 검사하므로 멈추고, `-Install`도 기존 사본을 덮어쓰지 않는다. 아래 수동 절차로 Docker Caddy로 되돌린 뒤 설치 폴더를 지우고 다시 설치한다 |

호스트 사본이 없거나 손상됐을 때(관리자 창, 패키지 루트):

1. 볼륨도 없거나 손상됐으면 먼저 위 1~5단계로 복원하고, 볼륨의 루트 지문이 클라이언트 PC의 지문과 같은지 확인한다.
2. 서비스를 멈추고 자동 시작을 끈다.
   ```powershell
   Stop-Service wr-caddy -Force
   sc.exe config wr-caddy start= disabled
   ```
3. env 파일에서 `WR_CADDY_HTTPS_BIND`·`WR_CADDY_HTTP_BIND` **두 줄만** `C:\ProgramData\wr-caddy\state\host-mode.json`의 기록대로 되돌린다: `existedBefore`가 `true`면 `previousLine`으로 바꾸고, `false`면 그 줄을 지운다. 다른 키(`WR_VERSION`·비밀번호·`WR_APP_PORT` 등)는 건드리지 않는다.
4. Docker Caddy를 업데이트 때와 같은 파일·env로 다시 만들고 8443 응답을 확인한다.
   ```powershell
   docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps caddy
   curl.exe -k --resolve wr.hospital.local:8443:127.0.0.1 -o NUL -w "8443: %{http_code}`n" https://wr.hospital.local:8443/health
   ```
5. 방화벽 규칙과 서비스를 지운다.
   ```powershell
   Remove-NetFirewallRule -Group 'WR Evaluation Caddy'
   sc.exe delete wr-caddy
   ```
6. `C:\ProgramData\wr-caddy`를 지운다(로그가 필요하면 `logs\`를 먼저 다른 곳으로 옮긴다). 원본 CA는 볼륨에 있으므로 잃지 않는다.
7. 9-2(시범 설치)부터 다시 한다.

참고: 서버를 6일 넘게 멈췄다가 켜면 Caddy의 서버 인증서(수명 6일)가 만료돼 있다. 이때 Caddy는 만료된 파일을 지우고 갱신하다 실패하며 스스로 복구되지 않는다(검증 스택에서 확인). 접속 오류(`NotTimeValid`)가 보이면 `... -p wr-prod restart caddy`를 한 번 실행한다(호스트 Caddy 모드라면 관리자 창에서 `Restart-Service wr-caddy`). CA 키 복구와는 별개의 증상이다.

---

## 8. 릴리스 체크리스트

배포 전 최종 확인:

- [ ] `.env.production`에 `changeme_` 문자열 없음: `grep -i changeme .env.production`
- [ ] ACCESS_TOKEN_SECRET, REFRESH_TOKEN_SECRET이 32바이트 이상 랜덤값
- [ ] app 포트가 외부에 직접 노출되지 않음 (`docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production -p wr-prod port app 3001` → `127.0.0.1:3001`만, 다른 PC에서 `Test-NetConnection <서버 주소> -Port 3001` → False)
- [ ] Caddy 인증서 정상 발급: `https://wr.hospital.local` 접속 시 인증서 오류 없음
- [ ] admin 계정 초기 비밀번호 변경 완료
- [ ] AUDIT_DB_PASSWORD ALTER ROLE 실행 완료
- [ ] 사용자 정의 프리셋은 계정별 `private` 저장으로 동작함
- [ ] GPG 공개키 등록 및 백업 1회 성공
- [ ] Caddy 내부 CA 키 백업 완료(7-1): `caddy-ca-*.tar.gpg`가 오프라인 매체에 있고, 개인 GPG 키와 다른 곳에 보관됨
- [ ] 클라이언트 PC CA 인증서 설치 확인 (INTRANET_DEPLOYMENT.md 3절)
- [ ] (Electron 셸이 바뀐 릴리스인 경우) `/updates/` 스테이징 + `update-policy.json` 롤아웃 절차 확인 (3-1-1, INTRANET_DEPLOYMENT.md 7절)
- [ ] (Electron 셸이 바뀐 릴리스인 경우) 패키지가 서명 키로 만들어졌다: `release-manifest.json`의 `electronInstaller.updateFeedSigned`가 `true`이고 `updates/`에 yml·`.sig` 쌍이 있다. 서명 검증 명령(`node scripts/sign-update-feed.mjs --verify ...`)은 **소스가 있는 릴리스 PC에서** 실행한다 — 오프라인 패키지와 서버에는 이 도구가 없다(INTRANET_DEPLOYMENT.md 7-6). 서버에서는 `SHA256SUMS` 검증과 `curl.exe -k https://<서버>/updates/latest.yml.sig`(base64 한 줄)로 확인한다. 서명 키·암호가 서버·`.env.production`에 없음
- [ ] T46 Go/No-Go 결과표 PASS (docs/T46_GO_NO_GO.md)
- [ ] (호스트 Caddy 모드인 경우, 9절) `.\caddy-host\install-caddy-host.ps1 -Status -EnvFile $envFile` → `Status: OK`, 새 로그인의 감사 로그 IP가 실제 PC 주소
- [ ] (호스트 Caddy 모드에서 롤백한 경우) `sc.exe qc wr-caddy`가 `DISABLED`이고 8443을 Docker가 쓴다
- [ ] (호스트 Caddy 모드인 경우) CA 키 백업을 `-SourceDir`로도 받아 두었다(7-1)

---

## 9. 호스트 Caddy 전환 (접속자 실제 IP 기록)

### 9-0. 개요

Windows의 Docker Desktop은 게시 포트로 들어온 접속의 출발지 IP를 내부 게이트웨이 주소로 바꾼다. 그래서 Docker 안의 Caddy를 거치면 관리자 콘솔의 감사 로그·세션·장치 IP가 모두 같은 값으로 남고, IP 단위 로그인 제한(분당 5회)도 병원 전체가 한 버킷을 나눠 쓴다. Caddy를 **Windows 서비스(`wr-caddy`, `caddy.exe`)**로 돌리면 실제 접속자 IP를 보고 앱에 `X-Forwarded-For`로 넘긴다. 앱은 서버 PC 안에서만 닿는 `127.0.0.1:<WR_APP_PORT>`로 받는다(7.1.5부터).

| 모드 | 8443/8080을 쓰는 것 | `wr-caddy` 서비스 | env의 `WR_CADDY_HTTPS_BIND` / `WR_CADDY_HTTP_BIND` |
|---|---|---|---|
| 없음(설치 전) | Docker Caddy | 없음 | 없음(기본 8443/8080) |
| `pilot`(시범) | Docker Caddy | 자동 시작, 시범 포트 9443/9080 | 없음 |
| `host`(전환 후) | `wr-caddy` | 자동 시작, 8443/8080 | `127.0.0.1:18443` / `127.0.0.1:18080` (Docker Caddy는 서버 안 루프백으로 비켜 있다) |
| `docker`(롤백 후) | Docker Caddy | **사용 안 함(Disabled)**, 정지 | 전환 전 값으로 되돌림 |

- **클라이언트 PC 작업은 없다.** 같은 내부 CA(루트 인증서)를 그대로 쓴다. 설치 스크립트는 Docker 볼륨의 CA를 지문 대조 후 `C:\ProgramData\wr-caddy\data`로 복사한다.
- 모드는 env 파일에 남는다. 그래서 host 모드에서도 평소 업데이트 명령(2-파일 `up -d`)을 그대로 쓴다.
- 운영 작업은 세 단계로 나눈다: **1단계** 앱 루프백 게시(7.1.5 배포) → **2단계** 시범 설치(사용자 영향 없음) → **3단계** 8443 전환(점검 창 약 15분).
- 모든 명령은 **새 패키지 폴더(루트)**에서, **관리자 PowerShell**로 실행한다(`-Status`·`-WhatIf`는 일반 창에서도 된다). Windows PowerShell 5.1과 PowerShell 7 모두 된다.

**env 경로 규칙(이 절 전체)**: 아래 명령의 `$envFile`은 **현재 운영 `.env.production`의 절대 경로**다. 창을 열 때마다 먼저 받아 둔다.

```powershell
$envFile = '<운영 .env.production 절대경로>'
```

`-Cutover`·`-Rollback`·`-Status`·`-Reconfigure`에는 항상 `-EnvFile $envFile`을 준다. 빼면 `-Rollback`은 처음 전환할 때 기록한 경로를 쓰는데, 그 뒤 업데이트하면서 env 위치가 바뀌었다면 옛 파일만 고치거나 거부된다. 옛 파일만 고쳐지면 현재 env에는 host 값이 남아 다음 `up -d`에서 8443이 끊긴다.

### 9-1. 사전 준비 (전환 전날까지)

- [ ] 7.1.5(앱 루프백 게시)를 배포하고 관찰을 마쳤다(`docs/UPDATE_7.1.5.md`).
- [ ] CA 키를 백업했다(7-1). 설치 때 백업 아카이브와 `.info.txt`가 **둘 다 서버에** 있어야 한다(스크립트가 아카이브 해시를 대조한다) — 오프라인 매체에서 잠시 가져오고, 설치가 끝나면 다시 지운다.
- [ ] 클라이언트 PC 한 대에서 설치된 루트 인증서의 **SHA-256** 지문을 구했다(설치 스크립트의 `-ExpectedRootSha256`). 그 PC의 PowerShell에서:
  ```powershell
  $c = Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root | Where-Object Subject -like '*WR Evaluation Internal CA*' | Select-Object -First 1
  ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData))).Replace('-', '')
  ```
  이 값이 백업 `.info.txt`의 `Root SHA-256`과 같아야 한다.
- [ ] 서버의 보안 프로그램 담당자와 협의했다. `caddy.exe`에는 코드 서명이 없다. 허용 기준으로 `release-manifest.json`의 `caddyHost.exeSha512`(SHA-512)와 설치 경로 `C:\ProgramData\wr-caddy\bin\caddy.exe`를 전달한다. 새 Windows 서비스(`wr-caddy`, NT AUTHORITY\LocalService) 등록과 TCP 8443·8080(시범 때는 9443·9080) 인바운드 허용도 함께 알린다.
- [ ] 서버 시각이 맞다(서버 인증서 수명이 6일이라 시각이 틀리면 인증서 오류가 난다).
- [ ] **새 PowerShell 창**을 쓴다. 셸에 `WR_DOMAIN`·`WR_APP_PORT`·`WR_CADDY_*` 같은 변수가 있으면 env 파일보다 우선하므로 스크립트가 거부한다.

### 9-2. 2단계 — 시범 설치 (9443/9080, 사용자 영향 없음)

Docker Caddy는 8443/8080을 그대로 쓰고, `wr-caddy`가 시범 포트에서 같은 앱을 서비스한다.

```powershell
cd C:\wr\wr-evaluation-unified-<버전>-intranet
$envFile = '<운영 .env.production 절대경로>'
$info = '<CA 백업 .info.txt 경로>'
$fp = '<클라이언트 PC에서 구한 SHA-256 지문>'
.\caddy-host\install-caddy-host.ps1 -Install -ExpectedRootSha256 $fp -CaBackupInfo $info -EnvFile $envFile -WhatIf   # 점검만
.\caddy-host\install-caddy-host.ps1 -Install -ExpectedRootSha256 $fp -CaBackupInfo $info -EnvFile $envFile
.\caddy-host\install-caddy-host.ps1 -Status -EnvFile $envFile                                                         # → Status: OK
```

- 설치는 폴더 ACL → CA 복사(지문이 클라이언트·백업·볼륨 셋 다 같아야 진행) → `caddy validate` → 서비스·방화벽 → 기동·HTTPS 확인 순서다. 한 단계라도 실패하면 이번 실행이 만든 것을 되돌린다(복사한 CA는 남긴다).
- **실제 IP 확인**: Windows 10 이상 다른 PC에서 잘못된 로그인을 1회 보낸 뒤, 관리자 콘솔 감사 로그에 **그 PC의 IP**가 남았는지 본다.
  ```powershell
  Set-Content -Path .\trial-login.json -Value '{"loginId":"trial-check","password":"x"}' -Encoding ASCII
  curl.exe -k --resolve wr.hospital.local:9443:<서버 주소> -H "Content-Type: application/json" --data-binary "@trial-login.json" -o NUL -w "%{http_code}`n" https://wr.hospital.local:9443/api/auth/login   # → 401
  ```
  브라우저·설치본으로 9443에 접속하지 않는다(앱의 허용 출처가 8443이라 막힐 수 있다). 확인은 `curl.exe` 수준으로 한다.
- 문제가 있으면 `.\caddy-host\install-caddy-host.ps1 -Uninstall`로 되돌린다. 8443에는 영향이 없다.

### 9-3. 3단계 — 8443 전환 (점검 창 약 15분)

**전환 직전**: 마지막 업데이트(`up -d`)에 쓴 것과 **같은 패키지 폴더·같은 env 파일 경로**에서 실행한다. 스크립트는 실행 중인 caddy 컨테이너의 compose 라벨(폴더·compose 파일·env 파일)과 대조해, 다르면 아무것도 바꾸지 않고 멈춘다.

```powershell
.\caddy-host\install-caddy-host.ps1 -Cutover -EnvFile $envFile -WhatIf   # 점검만(아무것도 바꾸지 않음)
.\caddy-host\install-caddy-host.ps1 -Cutover -EnvFile $envFile
```

`-Cutover`가 하는 일(순서대로):

1. 점검 — 셸 변수, 컨테이너 라벨, 8443/8080을 Docker Caddy만 쓰는지, 18443/18080이 비었는지, 바꾼 뒤의 compose 구성(앱은 `127.0.0.1`, 같은 CA 볼륨, 같은 도메인), 새 설정 `caddy validate`.
2. 전환 기록(`C:\ProgramData\wr-caddy\state\host-mode.json`)을 먼저 남기고 시범 서비스를 멈춘다.
3. env의 `WR_CADDY_HTTPS_BIND`/`WR_CADDY_HTTP_BIND` 두 줄만 고친다(다른 키·주석·줄바꿈 그대로, 이전 파일은 `<env>.before-cutover-<시각>`으로 남는다).
4. **Docker Caddy 컨테이너만** 다시 만든다(`up -d --no-deps caddy` — 앱·DB는 그대로). Docker Caddy가 `127.0.0.1:18443/18080`으로 옮겨 가며 8443/8080이 빈다.
5. 새 설정을 넣고 방화벽 규칙(8443·8080, `caddy.exe` 한정)을 바꾼 뒤 서비스를 자동 시작으로 켠다.
6. 8443 HTTPS(같은 CA)·리스너를 확인하고 모드를 `host`로 기록한다.

중간에 실패하면 **스스로 Docker Caddy로 되돌아간다**(서비스 Disabled, env 두 줄 복원, Docker Caddy 재생성, 방화벽 규칙 제거). 되돌림마저 끝내지 못하면 남은 수동 절차를 순서대로 출력한다. 접속이 끊기는 시간은 8443이 비는 순간부터 서비스가 뜰 때까지 수 초다.

**사후 확인**:

- [ ] `.\caddy-host\install-caddy-host.ps1 -Status -EnvFile $envFile` → `Status: OK`
- [ ] 관리자 콘솔 감사 로그에서 새 로그인의 IP가 **실제 PC 주소**다. 서로 다른 두 PC가 서로 다른 IP로 남는다.
- [ ] 설치본(Electron)이 인증서 오류 없이 접속한다. EMR 연동·장치 등록이 된다.
- [ ] `curl.exe -k --resolve wr.hospital.local:8443:127.0.0.1 https://wr.hospital.local:8443/updates/latest.yml`(와 `.sig`)이 응답한다.
- [ ] 다른 PC에서 앱 포트(`WR_APP_PORT`, 기본 3001)와 18443에 연결되지 않는다(3-3 표의 "app 포트 미노출"과 같은 방법).

### 9-4. 평소 운영 (host 모드)

- **업데이트**: 평소 절차 그대로(2-파일 `up -d`). env에 남은 `WR_CADDY_*` 값 때문에 Docker Caddy는 루프백에 머문다. 패키지 폴더를 바꾼 업데이트 뒤에는 새 폴더에서 `-Status -EnvFile $envFile`로 확인한다.
- **앱 포트 변경**(`WR_APP_PORT`): env 수정 → `up -d` → `.\caddy-host\install-caddy-host.ps1 -Reconfigure -EnvFile $envFile`(새 포트로 설정 재생성·검증·재시작). 하지 않으면 `-Status`가 불일치를 보고하고 접속은 502가 된다.
- **상태 확인**: `-Status -EnvFile $envFile`(일반 창 가능 — CA·로그 폴더 검사는 관리자 창에서만 나온다).
- **로그**: `C:\ProgramData\wr-caddy\logs\caddy.log`·`access.log`(관리자만 읽기). URL의 쿼리 문자열(환자 검색어 등)은 기록하지 않는다. 100 MB마다 회전, 최대 10개·90일 보관.
- **재부팅**: 서비스는 로그온과 상관없이 자동으로 시작한다. Docker가 아직 뜨지 않은 동안에는 502이고, Docker·앱이 뜨면 저절로 정상이 된다. 프로세스가 죽으면 Windows가 다시 시작한다.
- **인증서 만료**(`NotTimeValid`, 서버를 오래 멈춘 뒤): 관리자 창에서 `Restart-Service wr-caddy`.
- **CA 키 백업**: 연 1회 `-SourceDir`로도 받는다(7-1).

### 9-5. 롤백 (Docker Caddy로 되돌리기, 약 2~3분)

현재 패키지 폴더에서:

```powershell
.\caddy-host\install-caddy-host.ps1 -Rollback -EnvFile $envFile
sc.exe qc wr-caddy        # → START_TYPE : 4 DISABLED
```

- 서비스를 멈추기 **전에** 되돌린 뒤의 구성(같은 CA 볼륨·도메인·앱 루프백)을 검사한다. 그다음 서비스 정지·Disabled → env의 `WR_CADDY_*` 두 줄만 전환 전 값으로(그 사이 바뀐 `WR_VERSION`·비밀번호·`WR_APP_PORT`는 그대로, 백업본을 통째로 되돌리지 않는다) → Docker Caddy만 재생성 → 8443을 같은 CA로 응답하는지 확인 → 방화벽 규칙 제거 순서다.
- 롤백 뒤 재부팅해도 `wr-caddy`는 시작하지 않는다(Disabled). 다시 전환하려면 `-Cutover -EnvFile $envFile`.
- 롤백이 중간에 실패했으면 원인을 고친 뒤 **같은 명령을 다시 실행**한다(이어서 진행한다).
- **중단된 전환**(전환 중 창을 닫음 등): `-Status`가 "A switch-over … did not finish"를 문제로 보고한다. 이 상태에서는 `-Uninstall`·`-Reconfigure`·`-Cutover`가 거부되고, `-Rollback -EnvFile $envFile`이 Docker Caddy로 마무리한다.
- **앱 롤백 규칙**:
  - 앱 이미지만 되돌릴 때는 **현재 패키지의 compose**로 `WR_VERSION`만 이전 값으로 바꿔 `up -d`한다. host 모드가 그대로 유지된다.
  - **이전 패키지 폴더의 compose로 되돌려야 하면 반드시 `-Rollback`을 먼저** 한다. 이전 compose(7.1.4 이하)에는 Caddy 게시 주소 변수가 없어 Docker Caddy가 8443을 다시 잡으려다 `wr-caddy`와 부딪친다.
- 호스트 CA 사본이 없거나 손상돼 `-Rollback`이 멈추면 7-1 "호스트 Caddy 모드에서의 복구"의 수동 절차를 따른다.

### 9-6. 제거

```powershell
.\caddy-host\install-caddy-host.ps1 -Rollback -EnvFile $envFile   # host 모드라면 먼저
.\caddy-host\install-caddy-host.ps1 -Uninstall
```

`-Uninstall`은 시범·docker 모드에서만 동작한다(host 모드나 중단된 전환에서는 거부 — 8443이 비게 되므로). 서비스·방화벽 규칙·`bin`·`state` 파일을 지우고, **CA 사본(`data`)과 로그는 자동으로 지우지 않는다**(7절).

### 9-7. 알려진 한계

- NAT 장비나 강제 프록시(PAC)를 **거쳐** 들어온 연결은 그 장비의 IP로 남는다. Electron 설치본은 프록시를 쓰지 않고 직접 연결하므로 PC의 실제 IP가 남는다.
- 서버를 재부팅한 뒤 Docker가 뜨기 전(로그온 전 자동 기동 설정이 없으면 로그온 전까지)에는 502다. 지금도 그 시간에는 접속이 되지 않으므로 증상만 달라진다.
- 서버 PC에 로그인한 사용자는 앱의 루프백 포트로 `X-Forwarded-For`를 위조할 수 있다(LAN의 다른 PC에서는 그 포트에 닿지 않는다).
- 리허설 PC에서는 같은 절차를 `verify-stack.ps1`의 검증 스택으로 미리 해 볼 수 있다(3-0-1, `accept`).
