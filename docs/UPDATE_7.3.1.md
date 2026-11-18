# v7.2.0 → v7.3.1 업데이트 절차 (클라이언트 리팩터링 1차 + 7.3.0의 DB 역할 분리)

이미 v7.2.0이 운영 중인 인트라넷 서버를 **v7.3.0을 건너뛰고 v7.3.1로 바로** 올리는 절차. 형식은 [UPDATE_7.3.0.md](UPDATE_7.3.0.md)를 따르고, 그 문서의 절차(DB 계정 분리·새 비밀번호 2개·첫 EMR 감사 기록 확인)를 모두 담는다 — 운영자는 이 문서 하나만 따른다.

> **이번 릴리스도 서버 전용 패키지다(Electron 셸 변경 없음, 설치본 교체 불필요).** 7.3.1 = 7.3.0 + 화면 코드 정리이고 **새 DB 마이그레이션은 없다**. 대신 7.2.0에서 올라오므로 **7.3.0의 운영 구성 변화가 이번에 함께 적용된다** — 앱이 슈퍼유저 대신 권한이 좁은 DB 계정 `wr_app`으로 접속하고, 1회성 `migrate` 서비스가 `docker compose up`마다 DB 계정·마이그레이션·권한을 준비한다. `.env.production`에 비밀번호 2개를 더하고, DB 마이그레이션 1개(0042)가 적용되며, 테이블 소유자가 바뀐다. **업데이트 전 DB 백업이 필수**이고, **7.2.x로의 "이미지만 되돌리기"는 불가능하다**(롤백은 백업 복원). 7.3.0 이미지로는 DB 복원 없이 되돌릴 수 있다(롤백 ①).
>
> **전제 조건 — 운영이 7.2.0을 한 번 기동한 뒤에만 배포한다.** 7.2.0 첫 기동이 마이그레이션 체크섬을 기록하고(0038~0041 적용), 7.3.x는 체크섬 불일치를 기동 실패로 다룬다. 운영이 아직 7.1.x면 먼저 [UPDATE_7.2.0.md](UPDATE_7.2.0.md)대로 7.2.0을 올리고(그 안의 "현장 브라우저 버전" 확인 포함) 한 번 기동한 뒤 이 문서로 온다.
>
> 운영 서버가 **호스트 Caddy(host 모드, [PRODUCTION_RELEASE_PLAN.md](PRODUCTION_RELEASE_PLAN.md) 9-3)** 상태라고 본다. Docker Caddy가 8443을 쓰고 있다면 B-5(호스트 Caddy 확인)를 건너뛴다.
>
> **호스트 Caddy 설정은 건드리지 않는다.** 7.3.1 패키지의 Caddy 설정에는 응답 압축이 들어 있지만, 압축은 **Docker Caddy 모드에서만** 켜지고 host 모드 운영에서는 이번에 켜지지 않는다(설치된 호스트 Caddy 설정을 바꾸는 절차가 이번 릴리스에 없다). 정적 파일 캐시 헤더는 서버가 붙이므로 host 모드에서도 적용된다.
>
> **웹(Vercel)** 은 GitHub `main`에 머지될 때마다 반영되므로 7.3.1의 화면 변경은 이미 웹에 나가 있다. 이 문서는 인트라넷 서버만 다룬다.

## 무엇이 바뀌나

### 사용자에게 보이는 변화 ① — 7.3.0에서 온 것(계정 전환)

| 변화 | 내용 |
|---|---|
| 같은 새 등록번호 동시 저장 | 두 사람이 같은 새 환자 등록번호를 거의 동시에 저장하면 500 오류가 나던 것이 이제 한쪽은 정상 저장(201/200), 다른 쪽은 409(번호 충돌 안내)로 끝난다. |
| 로그아웃하면 화면을 비움 | 로그아웃하면 화면의 환자 목록이 비워진다. 저장되지 않은 환자(저장 대기·충돌·편집 권한 상실)가 있으면 먼저 "저장되지 않은 환자가 N명 있습니다…"로 묻고, 취소하면 로그아웃하지 않는다. |
| 다른 계정으로 로그인 | 다른 계정으로 로그인하면 작업 화면이 새로 시작된다(이전 계정의 목록·선택·검색어·열린 창이 남지 않는다). 세션 만료 뒤 **같은 계정**으로 다시 로그인하면 지금처럼 이어진다. |
| 로그아웃 상태의 "로컬 모드로 전환" | 빈 화면에서 시작한다. 로그인 요청이 진행 중인 동안에는 이 버튼을 누를 수 없다. |
| 같은 브라우저의 다른 탭 | 다른 탭에서 다른 계정으로 로그인하면, 먼저 쓰던 탭은 로그인 화면으로 간다(원래 계정으로 다시 로그인하면 이어진다). 그 탭을 새로 고치면 다시 로그인해야 할 수 있다. |
| 로컬 작업 중 로그인 | 로컬 모드에서 작업하다 로그인하면 화면의 로컬 작업은 이어지지 않는다. 로그인 직전에 로컬 자동저장으로 써 두므로, 다음에 로컬 모드로 들어가면 복원 안내가 뜬다(서버로 옮기려면 이관 도구를 쓴다). |
| 늦게 끝난 로그아웃 | 로그아웃 처리가 서버 응답을 기다리는 사이 다른 계정이 로그인했으면, 늦게 끝난 로그아웃은 새 계정에 영향을 주지 않는다. |

**공용 PC 안내**: 계정별 작업 분리를 위해, 여러 사람이 같은 PC·브라우저를 쓰는 곳은 업데이트 뒤 한 번 브라우저의 이 사이트 저장소(사이트 데이터)를 정리한다(로컬 모드의 자동저장은 계정이 아니라 브라우저 단위로 남는다).
- **정리하면 이 브라우저의 로컬 자동저장과 로컬 저장 목록도 함께 지워지고 되돌릴 수 없다.** 그 PC에서 로컬 모드로 작업한 환자가 있으면, 정리하기 전에 그 작업의 담당 사용자가 로그인해 설정 → 데이터 마이그레이션 → "이 PC의 로컬 환자 데이터를 서버로 이전"으로 서버에 옮기거나, 로컬 모드에서 엑셀로 내보낸다.
- 정리한 뒤 다음 접속에서 다시 로그인한다.

### 사용자에게 보이는 변화 ② — 7.3.1에서 더해진 것

기다리는 동안(서버 응답·EMR 추출·일괄 가져오기) 다른 작업으로 바뀐 최신 목록을 덮지 않도록 고친 것이 중심이다. 한 행에 한 동작이다.

| 변화 | 내용 |
|---|---|
| 삭제를 기다리는 동안의 작업 | 서버 삭제를 기다리는 동안 들어온 다른 환자의 편집·동기화 결과·새 환자가 사라지지 않고, 그사이 고른 환자를 덮지 않는다. |
| EMR 추출·다학제 회신 | 추출 결과를 **적용 시점의 최신 값**에 합친다 — 추출이 건드리지 않는 칸과 기다리는 동안 더한 상병이 남는다. 기다리는 동안 등록번호·재해일자가 바뀌었거나 환자가 삭제됐으면 적용하지 않고 완료 알림에 `건너뜀 N명`(`추출 중 환자 정보가 바뀌어 건너뜀`)이 붙는다. 다학제 회신은 확인 창을 띄운 시점의 등록번호와 다르면 저장하지 않고 알린다. |
| 평가일자 자동 설정 | 편집할 수 있는 환자에만 쓴다 — 다른 의사 담당 환자에는 쓰지 않고, 인트라넷 서버 환자는 편집 락을 얻은 뒤에 쓴다(쓰는 시점이 조금 늦어질 수 있다). |
| 동기화가 꺼지는 순간의 저장 응답 | 로그아웃 등으로 동기화가 꺼지는 순간 도착한 저장 응답은 목록에 남아 있는 환자에만 반영된다(지운 환자가 되살아나지 않는다). |
| 일괄 가져오기 | 엑셀 행이 실제로 바꾼 환자만 최신 목록에 합친다(손대지 않은 환자는 다시 저장되지 않는다). 가져오는 사이 바뀌었거나 지워진 환자는 건너뛰고 완료 알림에 `건너뜀 N명`이 붙는다. |
| 저장할 수 없는 환자가 있을 때 | 권한 등으로 저장되지 않는 환자가 있을 때 약 1초마다 반복되던 서버 요청이 멈춘다. |
| 다른 탭의 로그인 갱신 | 로컬 모드로 바뀐 직후의 탭에는 다른 탭의 로그인 갱신이 섞이지 않는다(로그인 상태는 그대로). |
| 재방문 속도 | 화면 파일(이름에 해시가 붙은 `/assets/…`)을 브라우저가 1년 캐시하고 첫 페이지(`index.html`)만 매번 확인한다 — 두 번째 접속부터 빨라진다. 응답 압축은 위 머리말대로 host 모드에서는 이번에 켜지지 않는다. |
| 일괄입력 첫 열기 | 엑셀 처리 코드를 일괄입력 창을 처음 열 때 받는다(첫 화면이 가벼워짐 — 첫 열기가 잠깐 늦을 수 있다). 그 파일을 받지 못하면(업데이트 직후 새로고침하지 않은 화면 등) "새로고침" 안내와 버튼이 뜬다. |
| 오류 문구의 서버 주소 | 오류 문구에 보이는 서버 주소 끝의 `/`가 정리된다(요청 주소는 그대로). |
| 환자가 많을 때 | 환자 수백 명을 연 상태에서도 입력이 가볍다. |

그 밖의 화면 동작은 바뀌지 않는다(구조 정리는 계산·출력·저장 형식을 테스트로 고정한 뒤 진행했다 — 브라우저에 저장된 자동저장·저장 목록은 그대로 읽힌다).

### 서버 운영

7.2.0과 비교한 변화다(7.3.1이 더한 서버 변화는 정적 파일 캐시 헤더뿐이다).

- **DB 계정 분리 (7.3.0의 M9)** — 계정이 셋으로 나뉜다. 비밀번호는 `.env.production` 값으로 **`up`마다 자동으로 맞춰진다**(수동 `ALTER ROLE` 단계 없음).

  | 계정 | 용도 | 비밀번호 키 |
  |---|---|---|
  | `wr_user` | 부트스트랩 슈퍼유저 — `migrate` 서비스의 계정 준비, 백업·복원, 점검용 `psql` | `POSTGRES_PASSWORD`(변경 시 자동 반영 안 됨 — 예전과 같다) |
  | `wr_owner` | **새 계정** — 테이블 소유, 마이그레이션, 감사 로그 파티션 사이드카 | **`OWNER_DB_PASSWORD`(새로 추가)** |
  | `wr_app` | **새 계정** — 앱 런타임. 소유권 없음, 감사 로그는 INSERT만 | **`APP_DB_PASSWORD`(새로 추가)** |
  | `wr_audit_reader` | 관리자 콘솔 감사 로그 조회(그대로) | `AUDIT_DB_PASSWORD` |

- **`migrate` 서비스(1회성)** — `up` 때 postgres 다음, 앱보다 먼저 돈다: 계정 준비·소유권 이전 → 미적용 마이그레이션(0042)을 `wr_owner`로 적용 → 권한 부여 → 역할 분리 검증 → 종료. `docker compose ps -a`에 **`Exited (0)`이 정상**이고 로그는 `docker compose logs migrate`. 0이 아닌 코드로 끝나면 `up`이 실패하고 앱이 뜨지 않는다.
- **앱은 마이그레이션을 하지 않는다** — 미적용 마이그레이션이 있거나, 앱 계정이 감사 로그를 바꿀 수 있거나, 감사 로그에 쓸 수 없으면 **기동을 거부**하고 재시작 정책으로 다시 시도한다. 그래서 `docker compose restart app`·`up -d --no-deps app`은 마이그레이션을 돌리지 않는다 — 업데이트는 반드시 전체 `up -d`로 한다.
- **마이그레이션 0042_queue_namespace** — 통계 run·영상 job에 큐 namespace 열과 유일 인덱스. 운영은 `default`. 7.3.1이 더한 마이그레이션은 없다(마지막은 0042).
- **마이그레이션 체크섬 enforce** — 적용한 마이그레이션 파일이 바뀌었으면 `migrate`와 앱이 기동을 거부한다(7.2.0은 경고만). 사전 준비 0)에서 7.2.0 로그에 경고가 없었는지 확인한다.
- **테이블 소유자 `wr_owner`** — 점검용 `psql -U wr_user`는 그대로 쓸 수 있다. 감사 로그 파티션 사이드카(`partition`)는 `wr_owner`로 접속하고, **기동 때 한 번** 파티션을 점검한다(로그 `docker compose logs partition`).
- **정상 종료** — `docker compose stop`/`down`에 처리 중 요청을 마치고 종료 코드 0으로 끝난다(최대 15초). 진행 중 통계·영상 작업은 실패로 끝나지 않고 대기열로 돌아가 다시 실행된다.
- **로그** — 서버 로그가 JSON 한 줄씩이다. 접근 로그(메서드·쿼리 없는 경로·상태·소요 시간·요청 ID)가 추가됐다. 읽기 좋게 보려면 개발 PC에서 `docker logs wr-prod-app-1 | npx pino-pretty`.
- **Node 22** — 서버·백업 모니터 이미지가 Node 22 기반이다(패키지에 이미지가 들어 있어 서버에서 받을 것은 없다).
- **보안** — 분석용 Python 프로세스(통계·영상·GPU 확인)는 DB 주소·비밀키를 받지 않는다. Docker Caddy 로그에서 쿼리스트링이 지워진다(호스트 Caddy는 7.1.6부터). base `docker-compose.yml`에 DB 비밀번호 기본값이 없어졌다(운영 오버레이는 원래 필수였으므로 운영 영향 없음).
- **정적 파일 캐시 헤더(7.3.1)** — 서버가 `/assets/*`에 `Cache-Control: public, max-age=31536000, immutable`, 그 밖의 화면 파일(`index.html` 등)에 `no-cache`를 붙인다(`/api`는 예전처럼 `no-store`).
- **복원 절차 변경** — "정지 → 복원 → `up -d` → 검증 → 백업 사이드카 재기동". [BACKUP_RESTORE.md](BACKUP_RESTORE.md) 5절. 7.3.x 이전 백업도 이 순서로 복원하면 `up -d` 뒤 정상이다.
- **환경변수** — `.env.production`에서:
  - `WR_VERSION=7.3.1`(필수)
  - **`OWNER_DB_PASSWORD`·`APP_DB_PASSWORD` 추가(필수)** — 없으면 설정 검증에서 멈춘다. 영숫자·`_`·`-`만(따옴표 없이, 64자 hex 권장). 사전 준비 3).
  - `REFRESH_TOKEN_SECRET`: 이제 지워도 된다(7.2.0 compose는 요구하지 않는다).
  - `MIGRATION_CHECKSUM_MODE`·`AUTO_MIGRATE`·`TRUST_PROXY`: 넣지 않는다(compose가 넘기지 않거나 파일에 고정).
- **클라이언트(Electron)** — 설치본 교체 불필요. 인트라넷 설치본은 서버가 주는 화면을 열므로 7.3.1 화면을 그대로 받는다(독립형 설치본은 이번 변경을 받지 않는다). 새 패키지의 `updates/`는 비어 있으니 7.2.0 폴더의 `updates/`를 통째로 옮긴다(업데이트 절차 A 2번).

## 예상 다운타임

- **서버**: 2분 안팎(전체 정지 → `migrate`(계정 준비·소유권 이전·0042·권한) → 앱 기동). 호스트 Caddy는 앱이 뜰 때까지 502를 돌려주다가 저절로 정상이 된다.
- **사용자**: 업데이트 뒤 **열려 있던 모든 화면은 새로고침하고, 설치본은 다시 실행한다**(세션은 유지된다). 새로고침하지 않은 옛 화면은 일부 기능에서 오류 알림을 띄운다(D절·"알려진 함정").

---

## 배포 전 점검 (릴리스 게이트) — 통과 전에는 배포하지 않는다

개발 PC에서 한다(1·2·4). 3은 운영 서버에서 한다.

### 1) 패키지 만들기

```powershell
git switch main; git pull --ff-only
npm run check:full                                              # 전 단계 PASS
.\scripts\export-offline-package.ps1 -AllowMissingElectronInstaller   # 서버 전용 — 설치본·서명 키 불필요
# → release\wr-evaluation-unified-7.3.1-intranet(.zip)
```

`release-manifest.json`에서 `version`이 7.3.1, `gitCommit`이 패키지를 만든 커밋, 이미지 3종이 7.3.1 태그, `electron/PLACEHOLDER.txt`가 있는지 본다. **7.3.0 패키지(`release\wr-evaluation-unified-7.3.0-intranet.zip`)는 다시 만들지 않고 그대로 함께 가져간다**(롤백 ①용).

### 2) 검증 스택 리허설 (7.2.0 → 7.3.1 업그레이드와 되돌리기)

```powershell
# a. 7.2.0 패키지로 새 검증 스택을 만들고 시험 데이터를 넣는다(로그인 실패 몇 번 = 감사 행)
pwsh -File scripts/verify-stack.ps1 purge -Force -PackageDir release\wr-evaluation-unified-7.2.0-intranet
pwsh -File scripts/verify-stack.ps1 up -PackageDir release\wr-evaluation-unified-7.2.0-intranet -LoadImages
#    → 6/7 단계가 "감사 계정 비밀번호 동기화(… 7.2.0 이하 패키지)"로 나온다(옛 패키지 경로)
# b. "업데이트 직전 백업" 대신 덤프를 하나 떠 둔다 — 롤백 리허설에서 restore.sh 가 읽도록 시험용 암호(대칭)로 암호화해
#    검증 스택의 백업 볼륨에 둔다. 비밀번호는 시험 환경 파일(release\.verify-stack\wr-verify.env)의 POSTGRES_PASSWORD.
$env:PGPASSWORD = ((Get-Content release\.verify-stack\wr-verify.env) -match '^POSTGRES_PASSWORD=' -replace '^POSTGRES_PASSWORD=', '')
docker run --rm --network wr-verify_default -e PGPASSWORD -v wr-verify_backup_data:/backups wr-backup:7.2.0 `
  sh -c 'pg_dump -h postgres -U wr_user -d wr_evaluation --format=custom --file=/tmp/pre731.dump && printf rehearsal | gpg --batch --pinentry-mode loopback --passphrase-fd 0 --symmetric --output /backups/pre731.dump.gpg /tmp/pre731.dump'
Remove-Item env:PGPASSWORD
# c. 정지 → 7.3.1 패키지로 업그레이드(시험 환경 파일에 OWNER/APP 비밀번호가 자동 보충된다)
pwsh -File scripts/verify-stack.ps1 down -PackageDir release\wr-evaluation-unified-7.2.0-intranet
pwsh -File scripts/verify-stack.ps1 up -PackageDir release\wr-evaluation-unified-7.3.1-intranet -LoadImages
```

| 확인 | 기대 결과 |
|---|---|
| verify-stack 6/7 | "DB 역할 준비 확인 (migrate 서비스)" → `migrate 종료 코드 0` |
| `logs migrate` 마지막 줄 | `[db-setup] Done — roles: N change(s), grants: M change(s); role separation verified.`, 그 앞에 `Applied: 0042_queue_namespace.sql` |
| `up -d` 한 번 더 | `logs migrate`의 새 마지막 줄이 `roles: 0 change(s), grants: 0 change(s)` |
| `pg_stat_activity`의 앱 연결 | 전부 `wr_app` |
| 테이블 소유자 | 전부 `wr_owner` |
| `logs partition` | 기동 때 `[audit-partition] … done` |
| 로그인 실패 1회 | 감사 행이 1 늘어난다(관리자 콘솔 감사 로그에 보인다) |
| 환자 열기·저장, 통계 분석 1회 | 7.2.0과 같다 |
| 업그레이드 전에 열어 둔 화면 | 새로고침 없이 "내보내기"를 누르면 오류 알림(아래 "알려진 함정"), 새로고침 뒤 정상·데이터 그대로 |
| **되돌리기 ① 리허설**(7.3.0 이미지) | 아래 "롤백 절차" ①을 검증 스택에서(프로젝트 `wr-verify`, 환경 파일 `release\.verify-stack\wr-verify.env`) → 로그인·데이터 그대로, `migrate` `roles: 0 · grants: 0`, 마이그레이션 42행 → 다시 7.3.1 |
| **되돌리기 ② 리허설**(7.2.0) | 7.3.1 스택에서 postgres 만 남기고 정지 → b의 덤프를 아래 "롤백 절차" ②의 복원 명령으로 복원(검증 스택에서는 `wr-verify_default`·`wr-verify_backup_data`, 키 import 대신 `-e GPG_PASSPHRASE=rehearsal`, 파일 `/backups/pre731.dump.gpg`) → 종료 코드 0, `Restore complete (committed)`와 행 수 → `verify-stack down` → 7.2.0 패키지 `up` → 앱 healthy, 마이그레이션 41행, 데이터 유지 |

### 3) 현장 브라우저 버전 (운영 서버, 관리자 PowerShell — 읽기 전용)

화면의 빌드 하한이 Chrome 108이다. 7.2.0 배포 뒤 호스트 Caddy 접속 기록에서 108 미만이 없는지 본다(7.2.0 업데이트 때 이미 확인했으면 그 뒤의 기록만 다시 본다).

```powershell
Get-Content C:\ProgramData\wr-caddy\logs\access.log |
  Select-String -Pattern 'Chrome/(\d+)\.' |
  ForEach-Object { [int]$_.Matches[0].Groups[1].Value } |
  Group-Object | Sort-Object { [int]$_.Name } | Format-Table Name, Count
# → 모든 Name(주 버전)이 108 이상이어야 한다(설치본은 108, Windows 7 Chrome은 109)
```

108 미만이 있으면 배포하지 않고 그 PC의 브라우저를 먼저 올린다(또는 설치본을 쓰게 한다).

### 4) 설치본으로 리허설 서버 점검 (개발 PC, 사람이 직접)

2)의 검증 스택(7.3.1)을 띄운 채 설치본(현장과 같은 인트라넷 셸)으로 접속해 화면을 본다. 시험 관리자 계정은 `pwsh -File scripts/verify-stack.ps1 seed-admin -PackageDir release\wr-evaluation-unified-7.3.1-intranet`으로 직접 만든다(계정 값은 문서·대화에 남기지 않는다).

- 로그인 · 환자 목록 · 편집·저장 · 환자 전환 · 편집 락
- 메뉴 3종(새로 만들기·초기화·통계) · 저장하지 않은 입력이 있을 때 창 닫기 확인 · 종료 시 로그아웃
- 일괄입력(창이 열리고 양식 내려받기) · 내보내기 · 다크 모드
- EMR 버튼 — EMR 프로그램이 없는 PC에서는 "창을 찾지 못함"이 정상
- AI 분석 버튼이 없는 것이 정상(운영 `AI_PROVIDER=none`)
- 점검에 쓴 설치본 버전을 적어 둔다(현장은 7.1.4 셸)

---

## 사전 준비 (운영 서버)

### 0) 현재 운영 환경 정보 파악 + 7.2.0 체크섬 경고 확인

```powershell
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}} {{.Ports}}"   # → wr-app-server:7.2.0 127.0.0.1:3001->3001/tcp
$installDir = (docker inspect wr-prod-app-1 --format '{{json .Config.Labels}}' | ConvertFrom-Json).'com.docker.compose.project.working_dir'
$installDir                                                              # → 7.2.0 패키지 폴더(아래 updates/ 이관 원본, 롤백용으로 남긴다)
Get-Service wr-caddy                                                     # → Running (host 모드)
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select count(*), max(filename), count(*) filter (where checksum is null) from schema_migrations"
# → 41|0041_signup_request_organization.sql|0     ← 7.2.0이 한 번 기동해 체크섬을 채운 상태여야 한다
docker logs wr-prod-app-1 2>&1 | Select-String "changed since they were applied"
# → 아무것도 나오지 않아야 한다. 나오면 업데이트하지 않고 파일 이름을 개발 담당에게 알린다(7.3.x는 이 상태면 기동하지 않는다)
```

같은 DB를 쓰는 다른 서버(다른 PC에서 운영 DB에 붙인 개발 서버 등)가 없는지도 확인한다.

### 1) 패키지 이송·무결성 검증

- `release\wr-evaluation-unified-7.3.1-intranet.zip`과 **`release\wr-evaluation-unified-7.3.0-intranet.zip`(롤백 ①용)** 을 서버로 복사하고 둘 다 압축을 푼다(예: `C:\wr\wr-evaluation-unified-7.3.1-intranet`, `C:\wr\wr-evaluation-unified-7.3.0-intranet`). **7.2.0 폴더는 지우지 않는다**(롤백 ②에 쓴다).
- zip을 옮긴 뒤 개발 PC에서 받은 SHA256 값과 같은지 본다: `Get-FileHash <zip 경로> -Algorithm SHA256`.
- 압축을 푼 폴더마다 무결성을 검증한다(7.3.1·7.3.0 폴더 각각에서):

```powershell
cd C:\wr\wr-evaluation-unified-7.3.1-intranet
$utf8 = New-Object System.Text.UTF8Encoding $false
$lines = [System.IO.File]::ReadAllLines("$pwd\SHA256SUMS", $utf8)
foreach ($line in $lines) {
  if (-not $line) { continue }
  $h, $f = ($line -split '  ', 2)
  $actual = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $h.ToLower()) { Write-Warning "MISMATCH: $f" }
}
Write-Host "Verified $($lines.Count) files"     # MISMATCH 경고가 없어야 한다
```

- `release-manifest.json`의 `version`이 7.3.1(7.3.0 폴더는 7.3.0), 이미지 3종이 같은 버전 태그인지 확인한다.

### 2) (필수) 업데이트 직전 DB 백업 — 7.2.0으로의 롤백은 이 백업으로만 된다

백업 시간대(매일 정해진 백업 시각)를 피해 진행한다.

```powershell
docker ps --filter "name=wr-prod-backup-1" --format "{{.Names}} {{.Status}}"   # → wr-prod-backup-1 Up ...
docker exec wr-prod-backup-1 sh /scripts/backup.sh
docker exec wr-prod-backup-1 sh -c 'ls -lt /backups/daily | head -3'          # 방금 만든 파일 이름을 적어 둔다
```

### 3) (필수) .env.production 수정 + 점검

새 비밀번호 2개를 만든다(PowerShell 5.1 가능, 한 번에 하나씩):

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
```

```
# === WR_VERSION (필수) ===
# 수정 전:   WR_VERSION=7.2.0
# 수정 후:   WR_VERSION=7.3.1
#
# === 새 DB 계정 비밀번호 (필수, 위 명령으로 만든 값을 따옴표 없이) ===
OWNER_DB_PASSWORD=<64자 hex>
APP_DB_PASSWORD=<64자 hex>
#
# REFRESH_TOKEN_SECRET 은 지워도 된다. MIGRATION_CHECKSUM_MODE·AUTO_MIGRATE 는 넣지 않는다.
```

수정한 뒤 **새 PowerShell 창**에서 새 패키지 폴더로 이동해 점검한다(읽기 전용 — 비밀값은 출력하지 않는다).

```powershell
cd C:\wr\wr-evaluation-unified-7.3.1-intranet
$envFile = '<운영 .env.production 절대경로>'      # 이후 모든 명령에 이 변수를 쓴다

# compose가 필수값을 모두 받는지(OWNER_DB_PASSWORD·APP_DB_PASSWORD 누락이면 여기서 이름을 대며 실패한다)
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml --profile backup config --quiet
# 서비스 목록에 migrate 가 있는지
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml config --services   # → … migrate …

.\scripts\check-app-publish.ps1 -EnvFile $envFile -ProjectName wr-prod
# → 마지막 줄 "App port pre-check passed." 이면 진행한다
```

---

## 업데이트 절차

### A. 서버 업데이트

서버에서 PowerShell 관리자 권한으로(위 점검과 같은 창):

```powershell
# 1. 새 패키지 폴더로 이동
cd C:\wr\wr-evaluation-unified-7.3.1-intranet

# 2. 7.2.0 폴더의 updates/ 를 통째로 옮긴다(이번 패키지의 updates/ 는 비어 있다)
#    원본 경로는 이 창에서 다시 구한다(사전 준비 0)의 변수는 그 창에만 있다). 아직 재생성 전이라 7.2.0 폴더가 나온다.
$installDir = (docker inspect wr-prod-app-1 --format '{{json .Config.Labels}}' | ConvertFrom-Json).'com.docker.compose.project.working_dir'
$installDir                                                                  # → 7.2.0 패키지 폴더여야 한다(아니면 7.2.0 폴더 경로를 직접 넣는다)
if (-not (Test-Path "$installDir\updates\latest.yml") -or -not (Test-Path "$installDir\updates\latest.yml.sig")) { throw "원본 updates 가 없습니다: $installDir\updates — 여기서 멈추고 경로를 확인한다" }
Copy-Item "$installDir\updates\*" ".\updates\" -Recurse -ErrorAction Stop
Get-ChildItem .\updates                                                      # → latest.yml·latest.yml.sig·설치본

# 3. 새 Docker 이미지 로드 + 확인 (wr-app-server / wr-backup-monitor / wr-backup 모두 7.3.1)
.\scripts\import-images.ps1
docker images | Select-String "wr-app-server|wr-backup"

# 4. 같은 DB를 쓰는 서비스 전부 정지(소유권 이전·0042가 테이블 잠금을 잡는다 — 다른 연결이 있으면 10초 뒤 포기)
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml --profile backup stop
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml --profile backup up -d postgres

# 5. DB 준비를 먼저 단독으로 실행해 결과를 본다(운영 Compose v2.22.0의 1회성 서비스 동작을 기대지 않는 순서)
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml run --rm migrate
# → 마지막 줄 "[db-setup] Done — roles: N change(s), grants: M change(s); role separation verified."
#   0이 아닌 코드로 끝나면 6번으로 가지 않는다 — "알려진 함정" 참고

# 6. 전체 기동 (migrate 가 한 번 더 돌고 "roles: 0 · grants: 0" 으로 끝난 뒤 앱이 뜬다)
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml --profile backup up -d
```

### B. 서버 헬스 체크

```powershell
$compose = "docker compose -p wr-prod --env-file `"$envFile`" -f docker-compose.yml -f docker-compose.prod.yml"

# 1. 서비스 상태 — migrate 는 Exited (0), 나머지는 Up(app healthy)
Invoke-Expression "$compose --profile backup ps -a"

# 2. migrate 로그 마지막 줄
Invoke-Expression "$compose logs migrate" | Select-Object -Last 3

# 3. 마이그레이션 42행·체크섬 빈 행 0, 테이블 소유자, 앱 연결 계정
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select count(*), max(filename), count(*) filter (where checksum is null) from schema_migrations"
# → 42|0042_queue_namespace.sql|0
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select string_agg(distinct pg_get_userbyid(relowner), ',') from pg_class where relnamespace='public'::regnamespace"
# → wr_owner
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select usename, count(*) from pg_stat_activity where datname='wr_evaluation' and usename is not null group by 1"
# → wr_app|N (그리고 지금 쓰는 psql 의 wr_user|1)

# 4. 파티션 사이드카 기동 점검
Invoke-Expression "$compose logs partition" | Select-String "audit-partition"   # → … ensuring … / … done

# 5. app health / 루프백 / 8443(호스트 Caddy) / 호스트 Caddy 상태
docker exec wr-prod-app-1 wget -qO- http://localhost:3001/health
curl.exe -s -o NUL -w "loopback 3001: %{http_code}`n" http://127.0.0.1:3001/health
curl.exe -k --resolve wr.hospital.local:8443:127.0.0.1 -o NUL -w "8443: %{http_code}`n" https://wr.hospital.local:8443/health
.\caddy-host\install-caddy-host.ps1 -Status -EnvFile $envFile

# 6. updates/ (옮긴 피드)
curl.exe -k --resolve wr.hospital.local:8443:127.0.0.1 https://wr.hospital.local:8443/updates/latest.yml        # → version: 7.1.4
curl.exe -k --resolve wr.hospital.local:8443:127.0.0.1 https://wr.hospital.local:8443/updates/latest.yml.sig    # → base64 한 줄

# 7. 화면이 7.3.1 인지(정적 파일 캐시 헤더 — 첫 페이지는 no-cache)
curl.exe -k -s -D - -o NUL --resolve wr.hospital.local:8443:127.0.0.1 https://wr.hospital.local:8443/ | Select-String "Cache-Control"   # → Cache-Control: no-cache
```

### C. 통계 워크벤치 확인 (`STATS_WORKBENCH_ENABLED=true`인 경우)

```powershell
docker exec wr-prod-app-1 /opt/stats-venv/bin/python /app/stats-engine/analyze.py --selfcheck   # → stats-engine selfcheck OK
curl.exe -k --resolve wr.hospital.local:8443:127.0.0.1 https://wr.hospital.local:8443/api/config/public   # → "statsWorkbenchAvailable": true
```

### D. 클라이언트 PC (필수)

**업데이트 전에 열려 있던 모든 화면은 새로고침(F5)하고, 설치본은 한 번 종료했다가 다시 실행한다.** 설치본 교체는 필요 없다.

새로고침하지 않은 옛 화면은 서버에서 이미 사라진 이전 화면 파일을 찾다가, "내보내기"·"EMR 입력" 같은 일부 기능에서 영어 오류 알림을 띄운다(데이터는 잃지 않고 새로고침하면 해소 — "알려진 함정"). 옛 화면에는 7.3.x의 계정 전환 보호도 적용되지 않으므로, 사용자에게 업데이트 직후 새로고침을 꼭 안내한다.

### E. 첫 EMR 감사 기록 확인 (배포 당일, EMR이 있는 PC에서)

7.3.x부터 감사 로그는 앱 계정 `wr_app`(감사 테이블에 INSERT만)으로 기록된다. 개발 PC에는 EMR이 없어 리허설에서 이 경로를 확인하지 못했으므로, 배포 뒤 처음 EMR을 쓸 때 한 번 확인한다.

**알아 둘 동작**: 설치본은 EMR 동작이 끝난 뒤 감사 기록을 서버로 따로 보낸다(`/api/audit/emr`). 보내기가 실패해도 **EMR 동작 자체는 막히지 않고 화면에도 오류가 나지 않는다** — 기록은 그 PC의 암호화된 대기열에 쌓였다가 5분마다 다시 보내진다. 그래서 "화면이 정상"만으로는 확인이 안 되고, 감사 로그에 행이 생겼는지를 봐야 한다.

1. EMR 프로그램이 있는 PC의 설치본(7.1.4 셸)으로 로그인해 EMR 동작을 **한 번** 한다. EMR에 쓰지 않는 읽기 동작을 권한다.

   | 화면 버튼 | 감사 로그의 동작 이름 |
   |---|---|
   | **EMR 추출**(환자를 연 상태 또는 목록에서 선택) | `emr_extract_record` |
   | 다학제 추출 | `emr_extract_consultation` |
   | EMR 직접입력 · 다학제 보내기(EMR에 쓴다) | `emr_inject` |

   동작 직전 시각과 그 PC의 IP 주소, 로그인한 아이디를 적어 둔다 — 다른 PC가 같은 시간에 EMR을 쓴 행과 구분하기 위해서다.
2. 1분 안에 기록이 생겼는지 본다. 둘 중 하나로 확인한다. **판정 기준: 적어 둔 시각 이후의 행이고, 액션이 위 표의 이름이며, 그 PC의 IP·아이디와 맞는 행이 있으면 기록 경로 정상**이다.
   - **관리자 콘솔** → "감사 로그" 탭 → "대상 유형" 칸에 `emr` 입력 → 조회. 시각·액션·IP 열로 위 기준을 본다("사용자 ID" 열은 내부 ID 앞 8자리라 아이디 대조는 아래 SQL로 한다). "액션 필터" 칸은 이름이 정확히 같아야 걸린다(예: `emr_extract_record`).
   - **서버에서 직접**:
     ```powershell
     docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -c "select now() - a.created_at as ago, a.action, a.outcome, u.login_id, a.ip from audit_logs a left join users u on u.id = a.actor_user_id where a.action like 'emr_%' order by a.created_at desc limit 5"
     ```
     → `ago`가 적어 둔 시각 이후(동작한 지 지난 시간보다 짧다)이고 `login_id`·`ip`가 시험한 아이디·PC와 같은 행을 찾는다. `outcome`은 EMR 동작의 결과다 — `failure`(예: EMR 창을 찾지 못함)여도 감사 기록 자체는 된 것이다. EMR 동작이 실제로 됐는지는 화면에서 따로 본다.
3. **행이 생기지 않으면**:
   - 서버 로그에서 그 요청을 찾는다:
     ```powershell
     docker logs wr-prod-app-1 --since 15m 2>&1 | Select-String "/api/audit/emr"
     ```
     - `"statusCode":500`이면 서버가 기록에 실패한 것이다(이 경로는 기록 실패를 성공으로 넘기지 않는다). 같은 요청의 `request failed` 줄(같은 명령에 함께 걸린다)에 `PostgreSQL error <코드>`가 남는다 — `42501`(권한 없음)이면 B의 `logs migrate` 마지막 줄이 `role separation verified.`인지 확인하고, 아니면 `--profile backup up -d`를 한 번 더 해 `migrate`가 권한을 다시 맞추게 한 뒤 1부터 다시 한다.
     - `"statusCode":401`이면 장치 문제다(서명·장치 상태). 관리자 콘솔 "디바이스" 탭에서 그 PC의 장치가 활성(승인됨)인지 본다.
     - 줄이 하나도 없으면 설치본이 아직 보내지 않은 것이다 — 장치가 승인 대기면 기록은 PC에 쌓여 있다가 승인 뒤 전송된다. "디바이스" 탭을 확인한다.
   - 서버 쪽 원인을 고치면 PC에 쌓인 기록은 5분 안에 다시 전송되어 행이 생긴다(세션이 끝난 뒤 보낸 것은 `extra`에 `actor_from_queue`가 붙는다).
   - 고쳐지지 않고 EMR 감사 기록이 남지 않는 상태로 운영할 수 없으면 아래 "롤백 절차" ②로 7.2.0으로 되돌린다(7.3.0도 같은 계정 구성이라 ①로는 해결되지 않는다).
4. **EMR 추출 결과 반영(7.3.1)**: 같은 PC에서 환자를 연 상태로 "EMR 추출"을 한 번 해, 추출한 값이 화면에 들어가고 완료 알림에 `건너뜀`이 붙지 않는지 본다(추출하는 동안 그 환자의 등록번호·재해일자를 바꾸지 않았다면 건너뛰지 않는 것이 정상). 개발 PC에 EMR이 없어 이 동작은 실기기에서 확인하지 못했다.

---

## 검증 시나리오

| 시나리오 | 기대 결과 |
|---|---|
| 로그인·로그아웃, 기존 환자 열기·저장 | 7.2.0과 같다 |
| 관리자 콘솔 감사 로그 | 방금 한 로그인이 보인다(감사 조회 계정 정상, 감사 기록 정상) |
| 설치본(7.1.4 셸)으로 접속 | 인증서 오류 없이 접속, EMR 연동 정상 |
| 첫 EMR 사용(EMR이 있는 PC) | 감사 로그에 `emr_…` 행이 방금 시각으로 생긴다(위 E), 추출 값이 화면에 들어간다 |
| 통계 분석(켠 경우) | 결과 표시 |
| 다른 PC에서 `<서버 IP>:3001` | 접속 거부 |
| 새로고침한 화면에서 일괄입력 열기 | 창이 열리고 양식을 내려받을 수 있다 |
| 새로고침한 화면에서 내보내기 | 7.2.0과 같다 |
| 브라우저 자동저장·저장 목록 | 업데이트 전 것이 그대로 보인다 |

⟪리허설: 사전 검증한 것 / 확인하지 못한 것 — P2-47b에서 채움⟫

---

## 롤백 절차

### ① 화면 문제 → 7.3.0 이미지로 (DB 복원 없음)

7.3.1과 7.3.0은 DB 구성(계정·마이그레이션 0042)이 같다. 7.3.1 화면에 문제가 있으면 **백업을 복원하지 않고 이미지만 7.3.0으로** 돌린다 — 데이터는 그대로 남는다. 7.3.1 폴더(compose·스크립트는 7.3.0과 같다)를 그대로 쓴다.

```powershell
cd C:\wr\wr-evaluation-unified-7.3.1-intranet
# 1. 7.3.0 이미지 로드(사전 준비 1에서 압축을 푼 7.3.0 폴더의 이미지)
.\scripts\import-images.ps1 -ImagesPath C:\wr\wr-evaluation-unified-7.3.0-intranet\images\wr-images.tar
docker images | Select-String "wr-app-server|wr-backup"                    # → 7.3.0 과 7.3.1 이 함께 보인다
# 2. .env.production: WR_VERSION=7.3.1 → 7.3.0 (비밀번호는 그대로)
# 3. 전체 기동 — migrate 가 "roles: 0 · grants: 0" 으로 끝나고 7.3.0 앱이 뜬다
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml --profile backup up -d
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}} {{.Status}}"    # → wr-app-server:7.3.0 … (healthy)
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select count(*) from schema_migrations"   # → 42
```

- 되돌린 뒤 **열려 있던 모든 화면을 새로고침**한다(D절과 같은 이유).
- ⟪리허설: 7.3.0·7.3.1 tar의 postgres·caddy base 이미지가 같은지와 postgres 컨테이너 재생성 여부⟫
- 다시 7.3.1로 올릴 때는 `WR_VERSION=7.3.1`로 고치고 3의 `up -d`만 하면 된다(7.3.1 이미지는 이미 로드돼 있다).

### ② 7.2.0으로 (직전 백업 복원)

**이미지만 되돌리기는 불가능하다** — 7.2.0 이미지에는 `migrate` 서비스(`dbSetup`)가 없고, 0042 적용 뒤 7.2.x로 되돌리지 않는다. 업데이트 직전 백업(사전 준비 2)을 복원하고 7.2.0 패키지 폴더로 기동한다. 백업 이후 저장된 내용은 사라진다.

```powershell
# 1. 7.3.1 정지(볼륨은 남긴다)
cd C:\wr\wr-evaluation-unified-7.3.1-intranet
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml --profile backup stop

# 2. postgres 만 올리고, 사전 준비 2)의 백업을 복원한다. 복원 승인(2인)·복구 전용 키 정책은 BACKUP_RESTORE.md 5절과 같다.
#    이 블록은 $envFile 의 값을 쓴다(현재 폴더에 .env.production 이 없어도 된다). 비밀번호는 화면에 출력하지 않는다.
#    복구 전용 개인키(wr-backup-private.asc)를 이 폴더(7.3.1 패키지 폴더)에 잠시 둔다.
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml up -d postgres
$cfg = docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml config --format json | ConvertFrom-Json
$env:PGPASSWORD = [string]$cfg.services.postgres.environment.POSTGRES_PASSWORD; Remove-Variable cfg
docker run --rm -it --network wr-prod_default `
  -v "${PWD}\wr-backup-private.asc:/tmp/private.asc:ro" `
  -v wr-prod_backup_data:/backups:ro `
  -v "${PWD}\scripts\restore.sh:/scripts/restore.sh:ro" `
  -e PGHOST=postgres -e PGPASSWORD -e PGDATABASE=wr_evaluation -e RESTORE_AUTH_TICKET=<티켓번호> `
  wr-backup:7.3.1 `
  sh -c 'export GNUPGHOME=$(mktemp -d) && gpg --batch --import /tmp/private.asc && sh /scripts/restore.sh /backups/daily/<사전 준비 2)에서 적어 둔 파일 이름>'
Remove-Item env:PGPASSWORD
Remove-Item .\wr-backup-private.asc                                       # 복구 전용 키는 바로 지운다(BACKUP_RESTORE.md 5-4)
#    restore.sh 는 복원 전체를 한 트랜잭션으로 실행하고, 성공하면 "Restore complete (committed)"와 행 수를 출력한 뒤
#    종료 코드 0으로 끝난다(기존 DB 위 덮어쓰기라 "NOTICE:  pre-clean: … audit_logs_pkey" 한 줄이 나오는 것은 정상).
#    "restore failed — the transaction was rolled back"으로 끝났으면 DB는 복원 전(7.3.1) 그대로다 — 위 ERROR 줄의
#    원인을 고친 뒤 다시 실행한다(BACKUP_RESTORE.md 5-2). "Restore complete (committed)" 뒤에 끊겼으면 복원은 반영됐다.
#    마이그레이션 수까지 확인한다:
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select count(*) from schema_migrations; select count(*) from patient_records; select count(*) from audit_logs"
# → 41 / 백업 시점의 환자 수 / 백업 시점의 감사 행 수(restore.sh 출력과 같다)

# 3. .env.production: WR_VERSION=7.3.1 → 7.2.0 (OWNER_DB_PASSWORD·APP_DB_PASSWORD 는 남겨 둬도 7.2.0이 무시한다)
# 4. 7.2.0 폴더에서 기동
cd <7.2.0 패키지 폴더>
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml --profile backup up -d
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select count(*), max(filename) from schema_migrations"   # → 41|0041_…
```

- 복원 뒤 7.2.0 앱은 예전처럼 `wr_user`로 접속한다. DB에 남은 `wr_owner`·`wr_app` 계정은 쓰이지 않을 뿐 해가 없다.
- 다시 7.3.1로 올릴 때는 이 문서를 처음부터 따른다(`migrate`가 소유권·권한을 다시 맞춘다).

---

## 알려진 함정·한계

### 업데이트 전에 열어 둔 화면에서 "내보내기"·"EMR 입력"을 누르면 영어 오류 알림
**원인**: 옛 화면은 기능을 처음 쓸 때 그 기능의 화면 파일을 서버에서 받는데, 업데이트 뒤 서버에는 새 파일만 있다. **알림 원문**: ⟪리허설 R5-a에서 실측⟫. **해결**: 화면을 새로고침한다(설치본은 다시 실행). 데이터는 잃지 않는다. 새 화면의 일괄입력은 같은 상황에서 영어 알림 대신 "새로고침" 안내와 버튼을 띄운다(나머지 기능의 안내는 다음 릴리스 후보).

### host 모드에서 응답이 압축되지 않음
**원인**: 이번 릴리스는 호스트 Caddy 설정을 바꾸지 않는다(머리말). **영향**: 첫 접속의 전송량이 Docker Caddy 모드보다 크다. 두 번째 접속부터는 캐시 헤더로 화면 파일을 다시 받지 않는다. 호스트 Caddy 설정 반영은 다음 릴리스 후보.

### 독립형 설치본은 옛 화면 그대로
**원인**: 독립형(로컬 전용) 설치본은 설치본 안의 화면을 연다. 이번 화면 변경은 인트라넷 서버와 웹에만 반영된다.

### AI 분석 버튼이 없음
운영은 `AI_PROVIDER=none`이라 AI 분석 버튼이 없는 것이 정상이다.

### `migrate`가 `Could not lock the tables to change their owner within the lock timeout`으로 실패
**원인**: 같은 DB에 다른 연결(멈추지 않은 앱·사이드카·다른 PC의 서버)이 테이블을 쓰고 있다. **해결**: A-4의 `stop`을 다시 하고 남은 연결을 확인한 뒤(`select usename, application_name, client_addr from pg_stat_activity where datname='wr_evaluation'`) `run --rm migrate`부터 다시.

### `migrate`가 `The database is not role-separated: …`(위반 목록)로 실패
**원인**: DB에 손으로 만든 스키마·`SECURITY DEFINER` 함수·rule, 혹은 정책 밖 권한이 있다. **해결**: 로그의 위반 목록을 개발 담당에게 알린다(권한 차이는 `migrate`가 스스로 맞추므로 보통 남지 않는다).

### `config`·`up`이 `required variable OWNER_DB_PASSWORD is missing a value: … for development use --env-file docker/dev.env`
**원인**: `.env.production`에 새 비밀번호가 없다. 메시지 끝의 `docker/dev.env` 안내는 개발용 문구다(compose가 운영 오버레이보다 base 파일을 먼저 검사한다). **해결**: 운영은 `.env.production`에 사전 준비 3)대로 넣는다.

### `migrate`가 `… must connect as wr_app` / 비밀번호 형식 오류
**원인**: `.env.production`의 새 비밀번호가 비었거나 허용 문자 밖이다(따옴표 포함). **해결**: 사전 준비 3)대로 hex 값을 따옴표 없이 넣는다.

### 앱이 `migration(s) not applied` / `connects as wr_user … superuser`로 기동 거부
**원인**: `restart app`·`up -d --no-deps app`처럼 `migrate`를 건너뛰었거나 옛 compose로 띄웠다. **해결**: 새 패키지 폴더에서 A-5·A-6.

### `Applied migration file(s) changed since they were applied`로 기동 거부
**원인**: 7.3.x는 체크섬 불일치를 기동 실패로 다룬다. **해결**: 업데이트를 멈추고 "롤백 절차" ②. 파일 이름을 개발 담당에게 알린다(사전 준비 0)에서 7.2.0 로그를 확인했다면 나오지 않는다).

### `docker compose up -d` 뒤 백업이 돌지 않음
**원인**: 백업 사이드카는 `--profile backup` 서비스라 프로필 없이 `up`하면 뜨지 않는다. **해결**: 이 문서의 명령처럼 항상 `--profile backup`을 붙인다.

### 서버 로그가 JSON이라 읽기 어려움
`docker logs wr-prod-app-1 --since 10m`을 파일로 받아 개발 PC에서 `npx pino-pretty`로 본다.

### 그 밖
- 운영 Compose v2.22.0에서 "1회성 서비스가 실패하면 `up`이 실패하고 앱이 뜨지 않는 것"은 개발 PC에서만 확인했다. 그래서 위 절차는 `run --rm migrate`로 결과를 먼저 보고, 앱도 스스로 미적용·권한 불일치면 기동을 거부한다.
- 앱 계정 `wr_app`은 자기 비밀번호를 바꿀 수 있다(다음 `up`에서 `.env` 값으로 되돌아간다). 임시 테이블은 `wr_owner`·슈퍼유저만 만들 수 있다. 백업은 계속 슈퍼유저 `wr_user`로 한다.
- 영상 분석 "검토 종료"가 Windows 개발 PC에서는 파일을 지우지 못하고 고아 정리가 회수하는 것을 봤다(운영 Linux 컨테이너는 미확인 — 관련 증상이 있으면 알린다).

---

## 부록 — 이미 7.3.0인 서버를 7.3.1로

운영이 이미 7.3.0이면 DB·계정 구성이 같으므로 **이미지만 바꾼다**(백업 복원 없이 되돌릴 수 있다).

1. 사전 준비 1)(7.3.1 zip 이송·무결성)·2)(백업 — 만일을 위해)를 한다. 7.3.0 폴더는 남긴다.
2. `.env.production`의 `WR_VERSION=7.3.0` → `7.3.1`(비밀번호는 그대로).
3. A의 1·2(updates/ 는 7.3.0 폴더에서)·3을 하고, 4·5 없이 6(`--profile backup up -d`)만 한다 — `migrate`가 `roles: 0 · grants: 0`으로 끝난다.
4. B·C·D를 한다(E는 7.3.0 배포 때 했으면 4번 — EMR 추출 결과 반영 — 만).
5. 되돌리기는 위 롤백 ①과 같다(7.3.0 폴더의 이미지가 이미 로드돼 있으면 1단계는 건너뛴다).

---

## 참고

- 변경 이력: [README.md](../README.md) 변경 이력 v7.3.1·v7.3.0, [PRD.md](PRD.md) v7.3.1·v7.3.0
- 리팩터링 계획과 진행: [REFACTORING_ROADMAP.md](REFACTORING_ROADMAP.md) Phase 2(진행 표의 flagged 항목), Phase 1(S7·S8·S9·S11·M9)
- 복원: [BACKUP_RESTORE.md](BACKUP_RESTORE.md) 5절, 배포 일반: [PRODUCTION_RELEASE_PLAN.md](PRODUCTION_RELEASE_PLAN.md)
- 이전 단계: [UPDATE_7.2.0.md](UPDATE_7.2.0.md)(7.1.6 → 7.2.0), 건너뛴 단계의 원문: [UPDATE_7.3.0.md](UPDATE_7.3.0.md)
