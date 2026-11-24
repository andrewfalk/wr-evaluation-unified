# v7.3.1 → v7.3.2 업데이트 절차 (EMR 감사 기록 전송 경로 + 인트라넷 설치본 7.3.2)

이미 v7.3.1이 운영 중인 인트라넷 서버와 EMR 연동 PC를 v7.3.2로 올리는 절차. 형식은 [UPDATE_7.3.1.md](UPDATE_7.3.1.md)를 따른다.

> **이번 릴리스는 서버와 인트라넷 설치본(Electron 셸)을 함께 바꾼다.** 서버를 먼저 올리고(이전 설치본 7.1.4도 그대로 동작한다), 그다음 EMR PC의 설치본을 PC마다 7.3.2로 교체한다. **새 DB 마이그레이션은 없다**(마지막은 0042) — 서버는 7.3.1 이미지로 DB 복원 없이 되돌릴 수 있다.
>
> 7.3.2는 운영 7.3.1 코드에 이 수정만 더한 릴리스 가지(`release/7.3.2`)에서 만든다. main의 다른 리팩터링은 들어 있지 않다.
>
> 운영 서버가 호스트 Caddy(host 모드) 상태라고 본다. 호스트 Caddy 설정은 건드리지 않는다.

## 무엇이 바뀌나

### EMR 감사 기록 — 서버

| 변화 | 내용 |
|---|---|
| PC를 서명으로 찾는다 | EMR 감사 기록(`/api/audit/emr`)의 장치를 요청 헤더의 장치 ID가 아니라 **서명한 키(PC)** 로 찾는다. 설치본이 PC에서 만든 장치 ID를 그대로 보내도 기록된다 — 이전 설치본(7.1.4)도 서버만 올리면 기록이 들어온다. |
| 장치 승인은 PC 단위 | PC 하나(= Windows 사용자 프로필 하나의 장치 키)가 한 번 승인되면, **같은 기관의 다른 사용자도 그 PC에서 추가 승인 없이** EMR 연동을 쓰고 기록된다. 기록의 행위자는 로그인한 사람이다. |
| 한 PC는 한 기관 | 장치 키가 이미 다른 기관에 등록돼 있으면 등록을 거부한다(새 설치본에서는 EMR 버튼이 잠긴다). 기록의 기관은 언제나 그 PC의 기관이다. |
| 등록·승인·해지 | 같은 기관의 두 번째 사용자가 등록해도 새 행이 생기지 않는다. **해지는 그 PC의 모든 행에 적용**되고, 해지된 PC의 승인 대기 행은 승인할 수 없다(그 PC를 다시 쓰는 절차는 아래 F). |
| 거부 요약 | 서명은 맞는데 해지·승인 대기인 PC의 기록 요청은 거부하고, PC마다 10분에 한 건 `emr_audit_denied` 요약 행을 남긴다(이전 설치본은 해지를 알지 못해 EMR이 열려 있으므로, 그 사용이 관리자 콘솔에 보인다). |
| 이전 설치본의 기록 표시 | 이전 설치본은 동작한 사용자·시각을 보내지 않는다 — 행위자는 전송할 때 로그인한 사용자(로그인 전이면 그 PC의 첫 승인 등록자), 시각은 서버가 받은 시각이며 **"옛 설치본"·"행위자 불확실"** 로 표시된다. 같은 PC의 직전 기록과 1초 안에 들어온 기록(쌓인 기록을 몰아서 보낸 것)은 **"몰아서 전송"** 이 붙는다. |
| 새 설치본의 기록 | 7.3.2 설치본은 EMR 동작을 시작한 사용자와 시각을 함께 보낸다. 서버가 확인해 발생 시각을 남기고, 세션 사용자와 다르면(대기열을 거쳐 나중에 보낸 경우 등) **"행위자 미검증"** 으로 표시한다. |
| 제한 | 감사 요청의 주소별 제한(분당 120)은 실패한 요청만 센다. PC별 제한은 거부하지 않고 응답을 늦춘다(한 번에 300건, 그 뒤 초당 10건). 쌓인 기록을 순서대로 보내는 PC는 느려질 뿐 거부되지 않는다. |
| 직접입력 출처 | EMR 직접입력의 출처(자동/수정)가 기록 `extra.client_source`에 남는다. |

표시의 뜻은 [AUDIT_LOG_ACTIONS.md](AUDIT_LOG_ACTIONS.md) "EMR" 절.

### 관리자 콘솔

- **감사 로그 탭**에 "비고" 열: EMR 기록의 발생 시각과 "옛 설치본"·"행위자 불확실"·"행위자 미검증"·"몰아서 전송"·"기관 미확정" 표시.
- **디바이스 탭**에 "PC" 열(장치 키 지문 앞 8자리). 같은 PC에 행이 여럿이면 "같은 PC N행". 해지된 PC의 승인 실패 등은 한국어 안내로 나온다.

### 인트라넷 설치본 7.3.2

| 변화 | 내용 |
|---|---|
| 승인 상태가 기관에 묶임 | 새 서버의 응답을 받은 뒤에는, EMR 버튼이 **그 PC가 속한 기관으로 로그인했을 때만** 열린다. 다른 기관으로 로그인하면 "이 PC는 다른 기관에 등록되어 있어 EMR 연동을 사용할 수 없습니다." |
| 해지 반영 | 관리자가 해지하면, 설치본을 다시 실행하거나 EMR을 한 번 더 쓴 뒤 EMR 버튼이 잠긴다("이 PC의 EMR 접근이 해지되었습니다."). |
| 통신 오류에 잠기지 않음 | 서버 오류·네트워크 오류로는 EMR 버튼이 잠기지 않는다(승인 상태는 서버의 명시적 응답으로만 바뀐다). 서버를 7.3.1로 되돌린 동안에도 지금처럼 열린다. |
| 기록 시점 정보 | 감사 기록에 EMR 동작을 시작할 때 로그인한 사용자·시각을 담는다(동작 도중 계정을 바꿔도 시작한 사용자로 남는다). |
| 재전송 | 보내지 못한 기록의 재전송(5분마다)이 한 번에 한 회차만 돌고, 서버가 제한·오류를 알리면 회차를 멈추고 나머지를 남긴다(제한 시각을 지킨다). 서버가 그 기록만 받지 않으면(형식 오류) 그 기록을 따로 옮기고(`audit-emr-quarantine.enc`, 지우지 않음) 나머지를 보낸다. 재전송 중에 생긴 기록을 잃지 않는다. 대기열 파일에 깨진 줄이 있어도 그 줄만 옮기고 나머지는 보낸다. |

**이전 설치본(7.1.4)과의 차이** — 7.1.4는 재전송 회차 도중 새 기록의 전송이 실패하면 그 기록을 잃을 수 있다(회차 끝의 파일 쓰기가 덮는다). 서버 수정으로 "제한 때문에 실패하는 경우"는 없앴지만, 네트워크 오류 같은 다른 실패는 7.3.2 설치본으로 바꿔야 없어진다. **설치본 교체를 미루지 않는다.**

### 운영 설정

- **컨테이너 로그 크기 제한**: 모든 컨테이너의 로그가 json-file 50 MB × 5개(컨테이너당 약 250 MB)로 제한된다. 넘으면 오래된 줄부터 지워진다.
- **자동 백업 시각 = 한국 시간 02:00**: 백업 컨테이너에 `TZ=KST-9`가 들어가 크론 `0 2 * * *`가 한국 시간 02:00에 돈다(지금까지는 컨테이너 시계가 UTC라 한국 시간 11:00). **백업 파일 이름과 월·연 보존 태그도 한국 시간 기준**이 된다. 다른 컨테이너의 시계는 그대로(UTC).
- `.env.production`은 `WR_VERSION=7.3.2`만 바꾼다.

## 예상 다운타임

- **서버**: 1분 안팎(정지 → `migrate`(변경 0) → 앱 기동). 로그 설정이 바뀌므로 **postgres·caddy 등 모든 컨테이너가 다시 만들어진다**(데이터는 볼륨에 그대로 — 되돌릴 때도 같다).
- **EMR 사용**: 서버를 올린 뒤 각 PC에 쌓여 있던 기록이 들어오는 동안(아래 C) EMR 사용을 멈추는 것을 권한다.
- **설치본**: PC마다 설치하는 동안만.

---

## 배포 전 점검 (개발 PC)

### 1) 패키지 만들기 — 서명 키가 있는 PC에서 사용자가 직접

설치본을 포함한 최종 패키지는 **업데이트 피드 서명 키**가 있어야 만들 수 있다. 키 경로와 암호는 자기 터미널에서만 다룬다(문서·대화에 남기지 않는다).

```powershell
git fetch origin
git switch release/7.3.2
git pull --ff-only
npm ci
npm run check:full                       # 전 단계 PASS
npm run electron:build:intranet          # 인트라넷 설치본 7.3.2 (electron/build-target.json 이 intranet 으로 바뀐다 — git 이 추적하지 않는 파일이라 되돌리려면 빌드 뒤 node scripts/set-build-target.mjs standalone)
.\scripts\export-offline-package.ps1 -UpdateSigningKey "<서명 키 파일 경로>"   # 키에 암호가 있으면 먼저 $env:WR_UPDATE_SIGNING_PASSPHRASE
# → release\wr-evaluation-unified-7.3.2-intranet(.zip)
```

`release-manifest.json`에서 `version` 7.3.2, `gitCommit`이 패키지를 만든 커밋, 이미지 3종 7.3.2 태그, `electron/` 아래 설치본과 `updates/`의 서명 파일을 확인한다. 설치본을 수동으로만 배포할 때는 `-AllowMissingElectronInstaller`로 서버 전용 패키지를 만들고 설치 파일을 따로 가져가도 된다.

**7.3.1 패키지(`release\wr-evaluation-unified-7.3.1-intranet.zip`)는 그대로 함께 가져간다**(서버 되돌리기용).

### 2) 검증 스택 리허설

릴리스 가지에서 서버 전용 패키지로 한 리허설 결과는 아래 "사전 검증한 것"에 있다. 다시 할 때:

```powershell
pwsh -File scripts/verify-stack.ps1 up -PackageDir release\wr-evaluation-unified-7.3.1-intranet -LoadImages   # 7.3.1 스택
pwsh -File scripts/verify-stack.ps1 down -PackageDir release\wr-evaluation-unified-7.3.1-intranet
pwsh -File scripts/verify-stack.ps1 up -PackageDir release\wr-evaluation-unified-7.3.2-intranet -LoadImages   # 같은 볼륨으로 7.3.2
# Tier-3 EMR 감사 시나리오(7.1.4 설치본 사본 + 7.3.2 설치본 코드) — 대상 주소·DB 컨테이너는 환경 변수로
$env:WR_API_URL = '<검증 스택 주소>'; $env:WR_PG_CONTAINER = 'wr-verify-postgres-1'; $env:WR_IGNORE_HTTPS_ERRORS = '1'
node scripts/tier3/emr-audit-smoke.mjs --queue 1200
```

### 3) 설치본으로 점검 (개발 PC, 사람이 직접 — 리허설 서버에 대해)

시험 관리자 계정은 `pwsh -File scripts/verify-stack.ps1 seed-admin -PackageDir release\wr-evaluation-unified-7.3.2-intranet`으로 직접 만든다(계정 값은 남기지 않는다). 시험 사용자 둘(같은 기관)을 관리자 콘솔에서 만든다.

1. 7.3.2 설치본 설치 → 사용자 1로 로그인 → 관리자 콘솔 "디바이스"에 승인 대기 행이 보이고 승인된다.
2. 설치본을 다시 실행 → EMR 추출 버튼(이 PC에는 EMR이 없어 실패) → 감사 로그(대상 유형 `emr`)에 실패 기록이 사용자 1로 남고, 비고에 **발생 시각("발생 …")이 보이며 "옛 설치본"·"행위자 불확실" 표시는 없다**.
3. 같은 기관의 사용자 2로 로그인해 같은 확인 — 추가 승인 없이 기록되고 행위자가 사용자 2다. "디바이스"에 새 행이 생기지 않는다.
4. 관리자 콘솔에서 해지 → 설치본을 다시 실행 → EMR 버튼이 "해지되었습니다"로 잠긴다.
5. 다른 PC 프로필(또는 장치 키를 새로 만든 프로필 — 아래 F)에서 7.1.4 설치본으로 같은 서버에 접속해 승인·EMR 버튼 → 기록이 "옛 설치본"·"행위자 불확실"로 남는다.

---

## 사전 준비 (운영 서버)

### 0) 현재 상태 + 같은 장치 키가 여러 기관에 등록돼 있는지 확인 (읽기 전용)

```powershell
docker ps --filter "name=wr-prod-app-1" --format "{{.Image}}"            # → wr-app-server:7.3.1
$installDir = (docker inspect wr-prod-app-1 --format '{{json .Config.Labels}}' | ConvertFrom-Json).'com.docker.compose.project.working_dir'
$installDir                                                              # → 7.3.1 패키지 폴더(되돌리기용으로 남긴다)
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select public_key_fingerprint, count(distinct coalesce(organization_id::text, '-')) from devices group by 1 having count(distinct coalesce(organization_id::text, '-')) > 1"
# → 아무것도 나오지 않아야 한다
```

마지막 조회에 행이 나오면 그 장치 키는 여러 기관에 걸쳐 있다 — 7.3.2는 그 PC의 기록을 **행위자·기관 없이 "기관 미확정"** 으로 받는다(최상위 관리자만 본다). 배포 전에 개발 담당과 정리 방법(그 PC를 어느 기관에 둘지, 나머지 행 해지)을 정한다.

### 1) 패키지 이송·무결성 검증

[UPDATE_7.3.1.md](UPDATE_7.3.1.md) "사전 준비 1)"과 같다 — 7.3.2 zip과 **7.3.1 zip(되돌리기용)** 을 옮기고 SHA256과 `SHA256SUMS`를 확인한다. 7.3.1 폴더는 지우지 않는다.

### 2) 업데이트 직전 DB 백업(권장)

```powershell
docker exec wr-prod-backup-1 sh /scripts/backup.sh
docker exec wr-prod-backup-1 sh -c 'ls -lt /backups/daily | head -3'
```

### 3) .env.production

```
# 수정 전:   WR_VERSION=7.3.1
# 수정 후:   WR_VERSION=7.3.2
```

---

## 업데이트 절차

### A. 서버 업데이트 — **EMR 사용이 없는 시간에**

서버를 올리면 각 PC의 설치본(켜져 있으면 5분 안에)이 그동안 쌓아 둔 기록을 보내기 시작한다. 그 기록은 위 "이전 설치본의 기록 표시"처럼 전송 시점 기준으로 들어오므로, **EMR 사용이 없는 시간에 배포하고 C에서 PC별 기록이 다 들어온 것을 확인한 뒤 EMR 사용을 재개**하는 것을 권한다.

```powershell
cd C:\wr\wr-evaluation-unified-7.3.2-intranet
$envFile = '<운영 .env.production 절대경로>'

# 1. updates/ — 7.3.1 폴더의 파일 가운데 새 패키지의 updates/ 에 없는 것만 옮긴다(덮어쓰지 않는다):
#    관리자 스위치 update-policy.json, canary 피드(canary.yml·canary.yml.sig와 그 설치본·blockmap), 이전 설치본 파일.
#    설치본을 포함한 패키지면 서명된 7.3.2 latest 피드는 새 패키지의 것이 그대로 남고, 서버 전용 패키지면 7.3.1의 피드가 옮겨진다.
$installDir = (docker inspect wr-prod-app-1 --format '{{json .Config.Labels}}' | ConvertFrom-Json).'com.docker.compose.project.working_dir'
Get-ChildItem "$installDir\updates" -File | Where-Object { -not (Test-Path (Join-Path .\updates $_.Name)) } | Copy-Item -Destination .\updates\ -ErrorAction Stop
Get-ChildItem .\updates
# canary 채널을 쓰고 있었다면 canary.yml 이 가리키는 설치본·blockmap 이 함께 있는지 확인한다(없으면 canary PC의 업데이트가 실패한다).

# 2. 이미지 로드(wr-app-server / wr-backup-monitor / wr-backup 7.3.2)
.\scripts\import-images.ps1

# 3. 설정 확인 → 정지 → 기동
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml --profile backup config --quiet
.\scripts\check-app-publish.ps1 -EnvFile $envFile -ProjectName wr-prod
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml --profile backup stop
docker compose -p wr-prod --env-file $envFile -f docker-compose.yml -f docker-compose.prod.yml --profile backup up -d

# 4. 바로 수동 백업 1회 — 백업 시각이 11:00 → 02:00으로 바뀌는 날 감시 기준(36시간)을 넘기지 않게
docker exec wr-prod-backup-1 sh /scripts/backup.sh
```

### B. 서버 헬스 체크

```powershell
$compose = "docker compose -p wr-prod --env-file `"$envFile`" -f docker-compose.yml -f docker-compose.prod.yml"
Invoke-Expression "$compose --profile backup ps -a"                     # migrate Exited (0), 나머지 Up
Invoke-Expression "$compose logs migrate" | Select-Object -Last 2      # roles: 0 · grants: 0 … verified.
docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -tAc "select count(*), max(filename) from schema_migrations"   # → 42|0042_queue_namespace.sql
curl.exe -k --resolve wr.hospital.local:8443:127.0.0.1 -o NUL -w "8443: %{http_code}`n" https://wr.hospital.local:8443/health
# 로그 크기 제한(컨테이너마다 같은 값)
docker inspect wr-prod-app-1 --format '{{json .HostConfig.LogConfig}}'      # → {"Type":"json-file","Config":{"max-file":"5","max-size":"50m"}}
# 백업 컨테이너 시계 = 한국 시간, 크론 02:00
docker exec wr-prod-backup-1 date                                       # → … KST 2026
docker exec wr-prod-backup-1 crontab -l                                 # → 0 2 * * * sh /scripts/backup.sh
```

**호스트 내보내기 예약**(`register-backup-export-task.ps1`로 등록한 Windows 작업)이 있으면 그 시각이 한국 시간 02:00 뒤인지 확인한다(이전에는 11:00 백업 뒤를 기준으로 잡았을 수 있다).

### C. EMR 감사 기록 유입 확인

1. 관리자 콘솔 → "감사 로그" → "대상 유형" `emr` → 조회. 각 PC에서 쌓아 둔 기록이 "옛 설치본"·"행위자 불확실"·"몰아서 전송" 표시와 함께 들어오는지 본다.
2. 서버에서 PC별로(최근 1시간):
   ```powershell
   docker exec wr-prod-postgres-1 psql -U wr_user -d wr_evaluation -c "select left(extra->>'deviceId', 8) as pc, count(*), count(*) filter (where extra->>'burst' = 'true') as burst, min(created_at), max(created_at) from audit_logs where target_type = 'emr' and created_at > now() - interval '1 hour' group by 1 order by 1"
   ```
   `max(created_at)`이 더 늘지 않는 것은 **보조 지표**다 — 그 PC의 설치본이 꺼져 있거나 다음 재전송(5분)을 기다리는 동안에도 멈춰 보인다. 각 EMR PC에서 대기열 파일이 비었는지(아래 D의 명령 — `audit-emr-pending.enc`가 없거나 0바이트)를 직접 확인한 PC만 "다 들어왔다"로 본다.
3. 감사 요청의 응답 분포(최근 30분) — 대부분 200이어야 한다:
   ```powershell
   docker logs wr-prod-app-1 --since 30m 2>&1 | Select-String '"/api/audit/emr"' | ForEach-Object { if ($_ -match '"statusCode":(\d+)') { $Matches[1] } } | Group-Object | Format-Table Name, Count
   ```
   401이 계속 나오면 그 PC가 등록·승인되지 않았거나 해지된 것이다 — 관리자 콘솔 감사 로그의 `emr_audit_denied`(대상 유형 `device`)와 "디바이스" 탭을 본다. 등록된 적 없는 장치 키의 PC는 서버를 올려도 기록되지 않는다(그 PC에서 등록·승인이 필요하다).
4. 다 들어온 것을 확인한 뒤 EMR 사용을 재개한다.

### D. 설치본 교체 (EMR PC마다 — 미루지 않는다)

- **기본은 수동 설치**: 7.3.2 설치 파일을 PC로 옮겨 실행한다(설치본을 닫고 설치). 자동 업데이트는 서버의 `updates/update-policy.json`이 켜져 있고 피드가 서명돼 있을 때만 동작한다 — 쓰려면 [INTRANET_DEPLOYMENT.md](INTRANET_DEPLOYMENT.md) 7절("자동 업데이트")대로.
- **시범 PC 한 대 먼저**: 교체 뒤 로그인 → EMR 동작 한 번 → 감사 로그에 그 기록이 **로그인 사용자와 발생 시각**(비고 "발생 …")으로, "옛 설치본" 표시 없이 남는지 본다. 이상 없으면 나머지 PC를 바로 교체한다.
- **대기열 파일을 지우지 않는다**: `%APPDATA%\wr-evaluation-unified\audit-emr-pending.enc`(보내지 못한 기록). 7.3.2가 그대로 이어서 보낸다. "PC"는 정확히는 **Windows 사용자 프로필** 단위다 — 같은 PC라도 다른 Windows 계정으로 쓰면 장치 키·대기열이 따로다.
- PC의 대기열 상태(PowerShell 2.0에서도 됨):
  ```powershell
  Get-ChildItem "$env:APPDATA\wr-evaluation-unified" -Filter "audit-emr-*" | Select-Object Name, Length, LastWriteTime
  ```
  `audit-emr-pending.enc`가 없거나 줄어들면 전송 중이다. `audit-emr-quarantine.enc`가 생겼으면 서버가 받지 않은 기록이 따로 옮겨진 것이다(지우지 말고 개발 담당에게 알린다 — 관리자 콘솔에 `audit_queue_corrupt`(`kind: set_aside`) 기록이 함께 남는다).

### E. 클라이언트 화면

업데이트 전에 열려 있던 화면은 새로고침(F5)한다.

### F. 해지와 해지된 PC를 다시 쓰기

- 관리자 콘솔 "디바이스"에서 그 PC의 행을 "취소"하면 같은 PC의 행이 모두 해지된다.
- 7.3.2 설치본은 재시작하거나 EMR을 한 번 더 쓴 뒤 버튼이 잠긴다. **7.1.4 설치본에는 해지가 전달되지 않는다**(EMR은 열려 있고 기록은 거부되며 관리자 콘솔에 `emr_audit_denied` 요약이 남는다) — 해지할 PC는 7.3.2로 먼저 교체한다.
- 해지된 PC를 다시 쓰려면 그 PC(그 Windows 프로필)에서 설치본을 닫고 `%APPDATA%\wr-evaluation-unified`의 `wr-device.json`과 `wr-device-key.enc` **두 파일만** 지운 뒤(대기열 파일은 두고) 다시 실행·로그인한다 → 새 장치 키로 승인 대기 행이 생기고, 승인하면 쌓인 기록도 새 키로 나간다.

---

## 롤백 절차

- **서버 → 7.3.1**(DB 복원 없음, 마이그레이션 없음): 7.3.2 폴더에서 7.3.1 이미지를 로드하고 `WR_VERSION=7.3.1`로 바꿔 `--profile backup up -d`(또는 7.3.1 폴더에서 `up -d`). 그동안 7.3.2 설치본의 기록은 서버가 받지 않아 PC 대기열에 남고, EMR 버튼은 지금처럼 열린다 — 서버를 다시 7.3.2로 올리면 들어간다. 백업 시각은 7.3.1 compose 기준(한국 시간 11:00)으로 돌아간다.
- **설치본 → 7.1.4**: 7.1.4 설치 파일로 다시 설치한다. 7.3.2가 쓴 대기열 파일과 `wr-device.json`을 7.1.4가 그대로 읽는다.

## 과거 기록의 한계

- 7.1.4 설치본이 보낸 기록(서버 배포 전에 쌓인 것 포함)은 **행위자·시각이 전송 시점 기준**이다 — 쌓인 기록과 방금 한 동작을 서버가 구분하지 못한다. 로그인 화면에 머문 설치본이 보낸 것은 그 PC의 첫 승인 등록자 이름으로 들어온다. 모두 "옛 설치본"·"행위자 불확실"로 표시되고, 몰아서 들어온 것은 "몰아서 전송"이 붙는다(묶음의 첫 건은 붙지 않는다).
- 7.1.4는 재전송 회차가 5분을 넘겨 겹치면 같은 기록을 두 번 보낼 수 있다.

## 알려진 함정

- 서버를 올린 직후, 등록된 적 없는 장치 키의 PC나 해지된 PC의 7.1.4 설치본은 기록 요청이 계속 401이다(그 PC는 등록·승인 또는 F가 필요하다).
- 같은 Windows 프로필에서 설치본을 둘 띄우면 두 프로세스가 대기열 파일을 잠금 파일(`audit-emr-pending.enc.lock`)로 나눠 쓴다. 잠금을 잡지 못한 기록과 대기열 파일에 쓰지 못한 기록은 `audit-emr-pending.spool-*.enc`로 남았다가 다음 회차에 합쳐진다 — 이 파일들도 지우지 않는다.

---

## 사전 검증한 것 / 확인하지 못한 것

### 사전 검증한 것

- 자동 테스트: 서버 단위·실DB 통합 테스트(PC 찾기·한 PC 두 사용자·다른 기관·여러 기관에 걸친 키·nonce·해지·예약 키·제한·이전 설치본 표시·새 설치본의 행위자/발생 시각·등록/승인/해지/동시 등록), 설치본 단위 테스트(분리 전 코드와 같은 특성화, 상태 갱신·기관 게이트, 기록 시점 정보, 재전송 정책과 대기열 보존 — 대기열 파일 쓰기·읽기 오류 포함), 관리자 콘솔 렌더 테스트, compose 불변식.
- Tier-3(개발 서버): 7.1.4 설치본 사본 — 등록·승인·대기열 151건 한 회차·행위자/표시·같은 기관 다른 사용자·세션 없는 기록·재전송 중 새 기록. 7.3.2 설치본 코드 — 한 PC 두 사용자·대기열 기록의 행위자/시각·계정 전환·429 멈춤·다른 기관 거부·해지 반영.
- 백업 컨테이너 이미지에서 `TZ=KST-9`가 해석되고 crond가 한국 시각으로 실행됨, `docker inspect`의 로그 옵션.
- **릴리스 가지 리허설**(서버 전용 패키지, 검증 스택 — 7.3.1 패키지의 볼륨을 이어서):
  - 7.3.1 서버 + 7.3.2 설치본 코드: 승인 대기(이전 방식) → 승인 → 재시작 뒤 열림, 기록은 거부되어 대기열에 남음.
  - 7.3.1 → 7.3.2: `migrate` roles 0 · grants 0 · verified, 마이그레이션 42행·체크섬 빈 행 0, 앱 healthy, 모든 컨테이너의 `LogConfig` = json-file 50m × 5(postgres·caddy 컨테이너 재생성, 데이터 그대로). 7.3.1 동안 쌓인 7.3.2 설치본의 기록이 올린 뒤 시작한 사용자·발생 시각으로 들어감.
  - 백업 컨테이너(패키지 compose로 일회성 실행): `TZ=KST-9`, `date`가 한국 시각, 크론 `0 2 * * *`.
  - Tier-3(패키지 스택): 7.1.4 사본 — 쌓인 기록 1,201건이 한 회차에 거부 없이 들어감(약 90초: 300건 뒤 초당 약 10건으로 늦춰짐), 1,200건에 "몰아서 전송", 그 회차 도중의 새 기록도 기록됨. 7.3.2 설치본 코드 — 한 PC 두 사용자, 대기열 기록의 행위자·시각, 계정 전환, 429와 Retry-After, 다른 기관 거부, 해지 반영. 30/30. 설치본 대기열 코드의 마지막 수정(쓰지 못한 기록의 보조 파일 보존, 회차 끝 교체 조건) 뒤 릴리스 가지 코드로 다시 실행해 같은 결과.
  - 7.3.1 이미지로 되돌리기(DB 복원 없음): `migrate` 0 · 0, 데이터 그대로, 7.3.2 설치본 코드는 열린 채 기록을 대기열에 보존 → 다시 7.3.2로 올리면 그 기록이 들어감.
  - 시험 조직·사용자·장치는 매번 지웠고 검증 DB의 조직·사용자·환자·장치 건수가 시작 때와 같다(감사 로그 행은 추가 전용이라 남는다).
- 인트라넷 설치본 빌드(`npm run electron:build:intranet`)가 된다(서명하지 않은 확인용 — 최종 패키지는 위 1)대로 사용자가 만든다).

### 확인하지 못한 것

- 설치본 화면(GUI)과 **EMR 실기기**에서의 추출·입력 — 도구 세션은 설치본을 띄우지 못한다. 위 "설치본으로 점검"과 시범 PC가 첫 확인이다.
- 서명 키로 만든 최종 패키지와 자동 업데이트 경로.
- 운영 Compose v2.22에서의 `x-logging` 확장 필드·YAML 앵커(개발 PC Compose로 확인 — compose 명세의 기본 기능이다).
- 운영의 자동 업데이트 스위치 상태, 7.1.4를 현장에 깐 방식, 운영 기관 수와 여러 기관에 걸친 장치 키(사전 준비 0), 호스트 내보내기 예약 시각.
- 다른 EMR PC들의 장치 등록 상태(등록된 적 없는 키는 서버 수정 뒤에도 거부된다).
