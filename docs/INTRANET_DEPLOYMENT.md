# 인트라넷 배포 운영 가이드

병원 인트라넷 환경에서 `wr-evaluation-unified`를 운영하기 위한 절차를 설명합니다.

---

## 목차

1. [전제 조건](#1-전제-조건)
2. [최초 배포](#2-최초-배포)
3. [내부 CA 루트 인증서 — 클라이언트 PC 설치](#3-내부-ca-루트-인증서--클라이언트-pc-설치)
4. [Electron 앱 인증서 처리](#4-electron-앱-인증서-처리)
5. [인증서 갱신 절차](#5-인증서-갱신-절차)
6. [1년 만료 알림 설정](#6-1년-만료-알림-설정)
7. [자동 업데이트(electron-updater) 배포 절차](#7-자동-업데이트electron-updater-배포-절차)
8. [트러블슈팅](#8-트러블슈팅)

---

## 1. 전제 조건

| 항목 | 요건 |
|---|---|
| 서버 OS | Linux (Ubuntu 22.04 LTS 권장) 또는 Windows Server 2019+ |
| Docker | 24.0 이상 + Docker Compose v2 |
| DNS 또는 hosts | `wr.hospital.local` → 서버 IP 해석 (전 PC 적용) |
| 방화벽 | 서버 포트 80, 443 인바운드 허용 (클라이언트 망에서) |

---

## 2. 최초 배포

```bash
# 1. 환경 변수 설정
cp .env.example .env
# .env 편집: 아래 항목을 반드시 실제 값으로 변경
#   ACCESS_TOKEN_SECRET, REFRESH_TOKEN_SECRET   (openssl rand -hex 32)
#   CORS_ORIGINS, WR_DOMAIN
#   POSTGRES_PASSWORD                           (기본값 변경 필수)
#   AUDIT_DB_PASSWORD                           (기본값 changeme_audit_reader 반드시 변경)

# 2. 핵심 서비스 기동 (postgres + app + caddy)
docker compose up -d

# 3. Admin 계정 초기 생성 (최초 1회)
docker compose exec app node dist/cli/seedAdmin.js
# → stdin에서 비밀번호 입력 (shell history에 남지 않음)

# 4. audit reader 비밀번호를 .env의 AUDIT_DB_PASSWORD 값으로 동기화 (최초 1회)
#    migration이 기본값 'changeme_audit_reader'로 role을 생성하므로,
#    .env에서 변경한 값으로 아래 명령을 실행해야 합니다.
docker compose exec postgres psql -U wr_user -d wr_evaluation \
  -c "ALTER ROLE wr_audit_reader PASSWORD '실제_AUDIT_DB_PASSWORD_값';"

# 5. 백업 사이드카 활성화 (GPG 공개 키 설정 후)
# .env에 BACKUP_GPG_RECIPIENT 설정 → docs/BACKUP_RESTORE.md 3절 참조
# GPG 공개 키 등록 전에는 backup 서비스를 기동하지 마세요.
docker compose --profile backup up -d
```

> **⚠ 기본 비밀번호 주의**: `POSTGRES_PASSWORD`, `AUDIT_DB_PASSWORD`는 반드시 기본값에서 변경하세요.  
> 특히 `.env`의 `AUDIT_DB_PASSWORD` 값과 DB role `wr_audit_reader`의 실제 비밀번호가 반드시 일치해야 합니다 — 4단계의 `ALTER ROLE` 명령으로 동기화하며, 불일치 시 서버가 production 모드에서 기동을 거부합니다.

서비스가 정상 기동되면 Caddy가 자동으로 내부 CA를 생성하고 `wr.hospital.local`에 대한 인증서를 발급합니다.

---

## 3. 내부 CA 루트 인증서 — 클라이언트 PC 설치

Caddy의 내부 CA가 발급한 인증서는 브라우저/OS가 신뢰하지 않습니다.  
**모든 클라이언트 PC에 루트 CA 인증서를 한 번 설치해야 합니다.**

### 3-1. 루트 CA 인증서 추출

서버에서 실행:

```bash
docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt > wr-internal-ca.crt
```

`wr-internal-ca.crt` 파일을 클라이언트 PC에 배포합니다 (공유 폴더, USB, 내부 웹 서버 등).

### 3-2. Windows — 신뢰 저장소 설치

**방법 A: GUI**

1. `wr-internal-ca.crt` 파일을 더블클릭
2. [인증서 설치] 클릭
3. 저장소 위치: **로컬 컴퓨터** 선택 → 다음
4. **모든 인증서를 다음 저장소에 저장** 선택 → [찾아보기]
5. **신뢰할 수 있는 루트 인증 기관** 선택 → 확인 → 다음 → 마침
6. 보안 경고 창에서 [예] 클릭

**방법 B: PowerShell (관리자 권한)**

```powershell
Import-Certificate -FilePath ".\wr-internal-ca.crt" `
  -CertStoreLocation Cert:\LocalMachine\Root
```

**방법 C: certutil (관리자 권한)**

```cmd
certutil -addstore -f Root wr-internal-ca.crt
```

### 3-3. 설치 확인

PowerShell에서:

```powershell
Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like "*WR Evaluation*" }
```

출력에 `WR Evaluation Internal CA`가 표시되면 설치 완료입니다.

이후 Chrome/Edge에서 `https://wr.hospital.local:8443`에 접속하면 인증서 경고 없이 정상 접속됩니다.
(호스트 80/443이 다른 프로세스에 점유된 환경을 위해 Caddy는 호스트 8080/8443으로 매핑됩니다.
컨테이너 내부는 표준 80/443을 그대로 사용 — `docker-compose.yml`의 `caddy.ports` 참조.)

---

## 4. Electron 앱 인증서 처리

Electron 인트라넷 빌드는 `loadURL('https://wr.hospital.local:8443')`로 서버에 접속합니다.  
Windows 신뢰 저장소에 CA가 설치되어 있으면 Electron도 자동으로 신뢰합니다.

### 4-1. Windows 신뢰 저장소 미설치 PC 대응

> **운영 환경에서는 반드시 Windows 신뢰 저장소에 CA를 설치(3절)하는 방법만 사용하세요.**  
> `certificate-error` 이벤트에서 콜백으로 예외를 허용하는 방식은 PHI 환경에서 **운영 금지**입니다.  
> — CA 이름/issuer 문자열 검증은 공격자가 동일 이름의 CA를 만들어 우회할 수 있습니다.  
> — 불가피하게 예외가 필요한 경우, 아래 SPKI 핀닝 방식을 사용하되 보안팀 승인을 받으세요.

**SPKI 핀닝 예시 (최후 수단, 보안팀 승인 필요):**

```bash
# 1. 서버에서 루트 CA의 SPKI 핀 값 추출
docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary \
  | base64
# → 출력값(예: "abc123...==")을 아래 PINNED_SPKI에 하드코딩
```

```javascript
// electron/main.js — 인트라넷 빌드 전용, SPKI 핀으로만 허용
const PINNED_SPKI = 'abc123...=='; // 위에서 추출한 값을 하드코딩
const INTRANET_URL = process.env.WR_INTRANET_URL ?? '';

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  const spki = certificate.fingerprint256; // Electron은 sha256 fingerprint 제공
  // 실제 SPKI pin과 다르므로 아래는 개념 예시 — 실 구현은 Node crypto로 검증
  const isIntranet = url.startsWith(INTRANET_URL);
  // ⚠️ 이 예시를 그대로 사용하지 말 것. 보안팀과 함께 구현하세요.
  callback(false); // 기본은 항상 거부
});
```

> **권고**: SPKI 핀 방식도 CA 교체 시 앱 재배포가 필요합니다. Windows 신뢰 저장소 설치가 유일한 올바른 해법입니다.

### 4-2. `will-navigate` 외부 이동 차단

Electron main.js에는 외부 origin 이동 차단이 이미 구현되어 있습니다.  
인증서 오류 때문에 외부 origin으로 fallback 하지 않도록 위 처리를 함께 적용하세요.

---

## 5. 인증서 갱신 절차

Caddy는 내부 CA 인증서를 **자동으로 갱신**합니다. 다만 Caddy 내부 CA의 leaf 인증서 기본 유효기간은 **12시간**입니다.
이 프로젝트의 `caddy/Caddyfile`은 개발/인트라넷 검증 편의를 위해 서버 인증서(leaf)를 **6일**로 설정합니다.

**루트 CA 인증서는 10년 유효**합니다 (Caddy 기본값).  
중간 인증서(intermediate)는 프로젝트 설정상 365일을 요청하지만, 기존에 이미 생성된 중간 인증서는 기존 만료일까지 유지될 수 있습니다.
leaf 인증서 수명은 반드시 중간 인증서 수명보다 짧아야 하므로 현재 설정은 6일입니다.

### 수동 확인 방법

```bash
# Caddy가 현재 사용 중인 인증서 만료일 확인
docker compose exec caddy caddy environ
# 또는 openssl로 확인
echo | openssl s_client -connect wr.hospital.local:8443 2>/dev/null \
  | openssl x509 -noout -dates
```

### 강제 재발급 (필요 시)

```bash
docker compose restart caddy
```

Caddy는 재시작 시 인증서 상태를 점검하고 필요하면 재발급합니다.
이미 발급된 leaf 인증서의 수명 설정을 바꾼 직후에는 기존 인증서를 계속 사용할 수 있습니다. 이 경우 루트 CA는 유지하고 leaf 인증서만 삭제한 뒤 Caddy를 재시작합니다.

```bash
docker compose exec caddy sh -c "rm -f /data/caddy/certificates/local/wr.hospital.local/wr.hospital.local.crt /data/caddy/certificates/local/wr.hospital.local/wr.hospital.local.key /data/caddy/certificates/local/wr.hospital.local/wr.hospital.local.json"
docker compose restart caddy
```

---

## 6. 1년 만료 알림 설정

루트 CA 인증서의 만료일을 서버 cron으로 감시합니다.

```bash
# /etc/cron.d/wr-cert-check
# 매월 1일 09:00에 실행
0 9 1 * * root /opt/wr-evaluation/scripts/check-cert-expiry.sh
```

`scripts/check-cert-expiry.sh`:

```bash
#!/bin/bash
set -euo pipefail

DOMAIN="${WR_DOMAIN:-wr.hospital.local}"
WARN_DAYS=90
ALERT_EMAIL="${CERT_ALERT_EMAIL:-}"

expiry=$(echo | openssl s_client -connect "${DOMAIN}:443" 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null \
  | cut -d= -f2)

if [ -z "$expiry" ]; then
  echo "[wr-cert-check] 인증서 조회 실패 — Caddy가 실행 중인지 확인하세요." >&2
  exit 1
fi

expiry_epoch=$(date -d "$expiry" +%s)
now_epoch=$(date +%s)
days_left=$(( (expiry_epoch - now_epoch) / 86400 ))

echo "[wr-cert-check] 인증서 만료까지 ${days_left}일 남음 (만료: ${expiry})"

if [ "$days_left" -lt "$WARN_DAYS" ]; then
  msg="[경고] wr.hospital.local 인증서가 ${days_left}일 후 만료됩니다. 갱신 절차를 확인하세요."
  echo "$msg"
  if [ -n "$ALERT_EMAIL" ]; then
    echo "$msg" | mail -s "[WR] 인증서 만료 임박" "$ALERT_EMAIL"
  fi
fi
```

환경 변수 `CERT_ALERT_EMAIL`에 담당자 이메일을 설정하면 메일로도 알림이 전송됩니다.

---

## 7. 자동 업데이트(electron-updater) 배포 절차

Electron 셸(main.js) 자체를 바꿔야 하는 릴리스는 드뭅니다 — 대부분의 기능 업데이트는 인트라넷 서버가 화면 전체를 내려주므로(`loadURL`) 서버 재배포만으로 끝납니다. Electron 셸 업데이트가 실제로 필요할 때만 아래 절차로 배포합니다.

### 7-1. `/updates/` 디렉터리 구성

`docker-compose.yml`의 `app.volumes`가 호스트의 `./updates/`를 컨테이너 `/app/updates`에 읽기 전용으로 마운트합니다(운영자가 `docker exec`/`docker cp` 없이 파일 복사만으로 배포할 수 있게 하기 위함 — `./caddy/Caddyfile` 마운트와 동일 패턴). 서버 리포지터리 루트에 다음과 같이 둡니다:

```
updates/
├── 직업성 질환 통합 평가 프로그램 Setup 6.5.0.exe
├── 직업성 질환 통합 평가 프로그램 Setup 6.5.0.exe.blockmap
├── latest.yml                    # 정식 채널 메타데이터
├── canary.yml                    # canary 채널 메타데이터(canary 롤아웃 중에만 존재)
└── update-policy.json            # 관리자 on/off 스위치(아래 7-3)
```

`scripts/export-offline-package.ps1 -UpdateChannel latest|canary`가 설치본+`.blockmap`+메타데이터 3종을 SHA-512까지 검증한 뒤 패키지의 `electron/`에 담아줍니다(`scripts/verify-update-artifacts.mjs`). 이 3종은 함께 `updates/`에 올립니다. `update-policy.json`은 별도로 관리 — 패키지에는 `electron/update-policy.example.json` **템플릿만** 동봉되고 실제 위치로 자동 배치되지 않습니다(설치 직후부터 업데이터가 켜진 채 나가는 것을 막기 위해서입니다).

기본적으로 이 3종이 없으면 export 자체가 **실패**합니다(에어갭 패키지에 설치본이 빠지는 것을 막기 위함). Electron 셸을 건드리지 않은 **서버 전용 릴리스**에서만 `-AllowMissingElectronInstaller`로 이 검사를 명시적으로 건너뛸 수 있으며, 이 경우 `release-manifest.json`의 `electronInstaller.included`/`sha512Verified`가 `false`로 기록됩니다. **Electron 셸이 바뀐 롤아웃 패키지에는 이 플래그를 쓰지 마세요.**

### 7-2. 업로드 순서(필수)

**설치본 + `.blockmap` 먼저 → 메타데이터(`latest.yml`/`canary.yml`) 마지막.** 가능하면 메타데이터 파일을 임시 파일명으로 올린 뒤 원자적 rename으로 교체하세요(반쯤 올라간 상태에서 클라이언트가 읽는 것을 방지). 순서를 반대로 하면, 클라이언트가 메타데이터는 새 버전을 가리키는데 설치본이 아직 없는 상태를 순간적으로 볼 수 있습니다.

### 7-3. 관리자 on/off 스위치 — `update-policy.json`

```json
{ "enabled": true, "channels": ["canary"] }
```

- **`enabled: false` 또는 파일 없음/파싱 실패 → 업데이트 체크 자체를 안 함(평상시 기본 상태).** 이게 기본값이어야 합니다.
- **`channels`는 필수이며 명시적 배열이어야 합니다.** 문자열(`"channels": "canary"` 같은 오타)이나 생략, 빈 배열, 알 수 없는 채널값이 하나라도 섞이면 **전체가 비활성으로 처리**됩니다 — 안전 경계이므로 형식이 조금이라도 어긋나면 무조건 꺼지는 쪽으로 설계돼 있습니다. "생략하면 전체 허용" 같은 관대한 해석은 없습니다.
- 클라이언트는 이 파일을 15분~4시간 주기로 폴링합니다(첫 확인은 앱 시작 시 즉시). **정책을 켜도 바로 반영되지 않을 수 있습니다** — canary 검증처럼 빠른 반영이 필요하면 대상 PC의 앱을 재시작하세요.
- 정책을 `enabled:false`로 되돌려도 **이미 진행 중인 다운로드나 이미 표시된 설치 확인 다이얼로그는 취소되지 않습니다.** 롤아웃을 즉시 중단해야 한다면 메타데이터 파일 자체를 내리세요.

### 7-4. 배포 사이클(canary → 전체 → 휴면)

0. **평상시**: `update-policy.json` 없음 또는 `{"enabled": false}` — 전 PC 휴면, 로그·경고 없음.
1. canary 릴리스는 **prerelease 태그**로 빌드(예: `npm version 6.5.0-canary.0` 후 `electron:build:intranet`) — electron-builder가 `latest.yml`이 아니라 `canary.yml`을 생성합니다.
2. `export-offline-package.ps1 -UpdateChannel canary`로 canary 설치본+blockmap+`canary.yml`을 `updates/`에 추가(**기존 `latest.yml`은 그대로 둠** — 같은 디렉터리에 두 채널이 공존).
3. canary로 지정한 PC에서 `WR_UPDATE_CHANNEL=canary` 환경변수를 설정하고 앱을 재시작합니다(예: 시스템 환경변수 또는 서비스/바로가기의 실행 환경에 설정).
4. `update-policy.json`을 `{"enabled": true, "channels": ["canary"]}`로 올립니다(가장 마지막에). 반영을 즉시 확인하려면 canary PC를 한 번 더 재시작하세요.
5. canary PC에서 업데이트 수신·설치·정상 동작을 확인합니다.
6. 검증 통과 시 정식 버전(prerelease 태그 없음, 예: `6.5.0`)을 빌드해 `-UpdateChannel latest`로 `latest.yml`을 `updates/`에 올리고, 정책을 `{"enabled": true, "channels": ["latest"]}`로 교체합니다. 전체 PC는 각자의 폴링 주기(최대 4시간)에 걸쳐 순차적으로 반영됩니다 — 전 PC가 동시에 다운로드를 시작하지 않으므로 재시작을 강제하지 않습니다.
7. **롤아웃 완료 후 `update-policy.json`을 `{"enabled": false}`로 되돌립니다.**
8. **canary PC 원복(필수)** — `WR_UPDATE_CHANNEL=canary`를 계속 남겨두면 그 PC는 이후 `latest.yml` 갱신을 영원히 받지 못합니다. 검증이 끝나면 해당 PC들에서 환경변수를 제거하고 앱을 재시작해 일반 채널로 복귀시키세요.

### 7-5. 롤백 정책

electron-updater는 **더 낮은 버전을 설치하지 않습니다.** 장애 버전을 되돌려야 한다면 더 높은 hotfix 버전을 다시 게시하는 방식으로 대응하세요. 이전 설치본은 수동 복구용으로 별도 보관합니다.

### 7-6. 코드서명 — 현재 미서명, 정확한 보안 함의

**현재 설치본은 미서명입니다**(`electron-builder.intranet.yml`에 `certificateFile` 없음 — 후속 과제로 연기). sha512 무결성 검증(electron-updater 기본 동작, 서명과 무관)은 항상 켜져 있어 전송 손상은 잡아냅니다.

**"UAC 경고 문구가 뜨는 정도의 차이"로 축소해서 이해하면 안 됩니다.** 정확히는:
- sha512는 `latest.yml`/`canary.yml` **자체가 신뢰됨을 전제**로 설치본과의 정합성만 검증합니다.
- **설치본 발행자 검증 단계 자체가 생략됩니다**(비활성화되는 게 아니라 애초에 그 단계가 없습니다).
- `/updates/` 쓰기 권한을 가진 공격자가 설치본과 메타데이터 파일을 **함께** 교체하면 이 방어를 우회할 수 있습니다.

**따라서 canary 롤아웃을 처음 실사용하기 전에 반드시 다음을 완료하세요(코드 구현과 별개의 승인 절차입니다):**
1. `/updates/` 디렉터리(호스트 `./updates/`)의 **쓰기 권한을 최소 인원으로 제한**.
2. 해당 디렉터리에 대한 **접근 감사**(누가 언제 파일을 올렸는지 기록/확인 가능하게).
3. 미서명 상태에 대한 **명시적 보안 예외 승인**을 병원 보안 담당/책임자로부터 받아 문서로 남길 것.

코드서명 인증서 도입(자체 PKI 구축 포함 가능 — 3절의 Caddy CA와는 완전히 별개의 인증서/절차 필요)은 후속 과제로, 도입 시 `electron-builder.intranet.yml`에 `certificateFile`/`certificatePassword`를 추가합니다.

### 7-7. 내부 CA 신뢰 확인

브라우저 창(`loadURL`)은 Chromium 스택이라 3절에서 설치한 Windows 신뢰 저장소의 CA를 자동으로 신뢰하지만, **electron-updater는 자체 세션(`autoUpdater.netSession`)으로 통신**하므로 별도 확인이 필요합니다. `electron/main.js`의 `initAutoUpdater()`가 이 세션에도 `setProxy({mode:'direct'})`를 적용해 PAC 우회까지 맞춰주지만(§8.14 PAC 이슈와 동일한 문제), **내부 CA 인증서 신뢰 자체**는 실기기에서 직접 확인해야 합니다:

1. canary PC에서 정책 조회(`GET /updates/update-policy.json`, 기본 세션)가 성공하는지 확인.
2. 같은 PC에서 실제 업데이트 다운로드(`latest.yml`/`canary.yml`/설치본, updater 세션)가 성공하는지 **별도로** 확인 — ①만 되고 ②가 실패하면 updater 세션이 CA를 인식하지 못하는 것입니다.
3. 실패하면 `electron/main.js`의 `initAutoUpdater()` 안 `TODO(update-CA-trust)` 주석 위치에 `setCertificateVerifyProc`을 내부 CA에 한정해 추가하는 것을 검토하세요(전체 인증서 허용은 금지).

---

## 8. 트러블슈팅

### 브라우저에서 "인증서가 신뢰할 수 없음" 오류

1. 루트 CA 인증서가 **로컬 컴퓨터 > 신뢰할 수 있는 루트 인증 기관**에 설치되어 있는지 확인
2. Chrome/Edge는 Windows 신뢰 저장소를 사용합니다 — Firefox는 별도 인증서 관리자에서 설치 필요
3. 설치 후에도 오류가 지속되면 브라우저를 완전히 종료 후 재시작

### `WR_DOMAIN`이 해석되지 않음

클라이언트 PC의 DNS 또는 `hosts` 파일에 `wr.hospital.local → 서버 IP` 레코드가 없는 경우입니다.

```
# C:\Windows\System32\drivers\etc\hosts (관리자 권한으로 편집)
192.168.1.100   wr.hospital.local
```

병원 DNS 서버에 A 레코드를 추가하는 것을 권장합니다.

### Caddy 로그 확인

```bash
docker compose logs caddy --tail=100 -f
```

### 인증서 발급 실패 (Caddy 시작 직후)

내부 CA가 초기화되는 데 수 초가 걸립니다. `caddy` 컨테이너가 `service_healthy` 상태가 될 때까지 기다리세요:

```bash
docker compose ps
```
