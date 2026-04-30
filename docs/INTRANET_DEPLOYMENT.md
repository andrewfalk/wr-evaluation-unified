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
7. [트러블슈팅](#7-트러블슈팅)

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

이후 Chrome/Edge에서 `https://wr.hospital.local`에 접속하면 인증서 경고 없이 정상 접속됩니다.

---

## 4. Electron 앱 인증서 처리

Electron 인트라넷 빌드는 `loadURL('https://wr.hospital.local')`로 서버에 접속합니다.  
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

Caddy는 내부 CA 인증서를 **자동으로 갱신**합니다. 만료 전에 새 인증서를 발급하므로 별도 작업이 불필요합니다.

**루트 CA 인증서는 10년 유효**합니다 (Caddy 기본값).  
서버 인증서(leaf)는 약 1년 주기로 Caddy가 자동 갱신합니다.

### 수동 확인 방법

```bash
# Caddy가 현재 사용 중인 인증서 만료일 확인
docker compose exec caddy caddy environ
# 또는 openssl로 확인
echo | openssl s_client -connect wr.hospital.local:443 2>/dev/null \
  | openssl x509 -noout -dates
```

### 강제 재발급 (필요 시)

```bash
docker compose restart caddy
```

Caddy는 재시작 시 인증서 상태를 점검하고 필요하면 재발급합니다.

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

## 7. 트러블슈팅

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
