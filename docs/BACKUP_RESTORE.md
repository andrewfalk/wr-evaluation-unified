# 백업 및 복구 런북

`wr-evaluation-unified` 인트라넷 서버의 PostgreSQL 데이터베이스 백업·복구 절차입니다.

---

## 목차

1. [권한 매트릭스](#1-권한-매트릭스)
2. [아키텍처 개요](#2-아키텍처-개요)
3. [최초 GPG 키 설정](#3-최초-gpg-키-설정)
4. [백업 절차](#4-백업-절차)
5. [복구 절차](#5-복구-절차)
6. [분기 복구 리허설](#6-분기-복구-리허설)
7. [보존 정책](#7-보존-정책)
8. [GPG 키 교체 (연 1회)](#8-gpg-키-교체-연-1회)
9. [파기 절차](#9-파기-절차)
10. [트러블슈팅](#10-트러블슈팅)

---

## 1. 권한 매트릭스

| 행위 | 담당자 |
|---|---|
| GPG 개인 키 보관 | 병원 정보보안팀 (오프라인 매체 2곳 이상) |
| GPG 공개 키 서버 적용 | 시스템 관리자 |
| 복구 승인 | **시스템 관리자 + 정보보안팀 2인 동시 승인** |
| 복구 실행 | 시스템 관리자 (승인 티켓 번호 필수) |
| 분기 리허설 감독 | 정보보안팀 |
| 키 교체 실행 | 정보보안팀 + 시스템 관리자 공동 |

> **복구 시 2인 동시 승인이 없으면 `restore.sh`가 실행되지 않습니다.**  
> `RESTORE_AUTH_TICKET` 환경 변수에 승인 티켓 번호를 설정해야 합니다.

---

## 2. 아키텍처 개요

```
[backup 컨테이너]
  crond (02:00 daily)
    └─ backup.sh
         ├─ pg_dump (Fc format) → /tmp/wr-backup-YYYYMMDD_HHmmss.dump
         ├─ gpg --encrypt → /backups/daily/wr-backup-YYYYMMDD_HHmmss.dump.gpg
         ├─ (월 첫 백업) → /backups/monthly/wr-backup-YYYYMM.dump.gpg
         ├─ (연 첫 백업) → /backups/yearly/wr-backup-YYYY.dump.gpg
         └─ retention pruning
```

- 암호화: GPG 비대칭 암호화 (공개 키로 암호화 → 개인 키로만 복호화 가능)
- 평문 dump는 `/tmp`에 임시 생성 후 암호화 즉시 삭제
- `backup_data` 볼륨은 암호화된 파일만 보관
- `backup_gnupg` 볼륨은 공개 키 keyring 보관 (개인 키 없음)

---

## 3. 최초 GPG 키 설정

### 3-1. 정보보안팀: GPG 키 쌍 생성 (오프라인 에어갭 PC 권장)

```bash
gpg --full-generate-key
# 권장 설정:
#   종류: RSA and RSA
#   길이: 4096 bit
#   만료: 2y (2년, 교체 주기와 일치)
#   이름/이메일: WR Backup <wr-backup@hospital.local>

# 공개 키 내보내기
gpg --armor --export wr-backup@hospital.local > wr-backup-public.asc

# 개인 키 내보내기 (오프라인 매체 2곳에 안전 보관)
gpg --armor --export-secret-keys wr-backup@hospital.local > wr-backup-private.asc
```

> **개인 키(`wr-backup-private.asc`)는 절대 서버에 두지 마세요.**  
> 암호화된 USB 또는 HSM에 보관하고, 복사본을 별도 격리 매체에 보관합니다.

### 3-2. 시스템 관리자: 서버에 공개 키 등록

```bash
# 공개 키를 서버로 복사한 뒤
docker compose exec -T backup gpg --import < wr-backup-public.asc

# 등록 확인
docker compose exec backup gpg --list-keys
# → wr-backup@hospital.local 키가 표시되면 완료

# GPG 키 지문 확인 (BACKUP_GPG_RECIPIENT에 설정할 값)
docker compose exec backup gpg --fingerprint wr-backup@hospital.local
```

### 3-3. `.env`에 수신자 설정

```bash
BACKUP_GPG_RECIPIENT=ABCD1234EFGH5678...  # 위에서 확인한 지문 (공백 없이)
```

### 3-4. 수동 백업 테스트

```bash
docker compose exec backup sh /scripts/backup.sh
docker compose exec backup ls /backups/daily/
```

암호화된 `.gpg` 파일이 생성되면 설정 완료입니다.

---

## 4. 백업 절차

### 4-1. 자동 백업 (일반)

`backup` 컨테이너의 crond가 **매일 02:00**에 자동 실행합니다.  
`.env`에 `BACKUP_GPG_RECIPIENT`를 설정한 뒤 `--profile backup`으로 활성화합니다.

```bash
docker compose --profile backup up -d
```

백업 로그 확인 (crond 출력은 컨테이너 stdout으로 전달됩니다):

```bash
docker compose logs backup --tail=50
```

### 4-2. 수동 즉시 백업

```bash
docker compose exec backup sh /scripts/backup.sh
```

### 4-3. 백업 파일 외부 매체로 이동

백업 파일은 **서버 외부 격리 매체**(테이프, 오프사이트 NAS 등)로 주기적으로 이동해야 합니다.

```bash
# 백업 목록 확인
docker compose exec backup ls -lh /backups/daily/
docker compose exec backup ls -lh /backups/monthly/
docker compose exec backup ls -lh /backups/yearly/

# 특정 파일을 호스트로 복사
docker compose cp backup:/backups/yearly/wr-backup-2026.dump.gpg ./
```

---

## 5. 복구 절차

> **반드시 2인 승인 후 진행하세요.**  
> 복구는 되돌릴 수 없습니다. 프로덕션 DB에는 복구 리허설을 절대 실행하지 마세요.

### 5-1. 승인 획득

1. 시스템 관리자가 복구 요청 티켓 생성 (IT 헬프데스크 또는 이슈 트래커)
2. 정보보안팀 책임자가 티켓 승인
3. 승인된 **티켓 번호**를 복구 실행자에게 전달

> **T46/production 리허설 절차 우선**: production-like 환경에서의 복구 리허설은
> `PRODUCTION_RELEASE_PLAN.md` section 5-3을 정본으로 따릅니다.
> 이 절(5-2~5-4)은 실제 운영 복구(production DB 대상) 절차입니다.

> **GPG 개인키 정책**: 복구에 사용하는 개인키는 **passphrase 없는 복구 전용 키**여야 합니다.
> `gpg --batch --import` + `gpg --batch --decrypt`는 pinentry/agent 없이 실행되므로
> passphrase가 설정된 키는 비대화형 컨테이너 환경에서 실패합니다.

### 5-2. 복구 실행

```bash
# WR_VERSION을 .env.production에서 읽기
WR_VERSION=$(grep '^WR_VERSION=' .env.production | cut -d= -f2)
echo "WR_VERSION=${WR_VERSION}"   # 빈 값이면 중단

# 복구 전용 임시 컨테이너 — production backup 컨테이너와 무관
# restore.sh는 이미지에 포함되지 않으므로 :ro로 직접 마운트
# GPG 개인키는 ephemeral GNUPGHOME에만 import → --rm 종료 시 자동 폐기
# "YES" 확인 프롬프트 때문에 -it 필수
docker run --rm -it \
  -v "$(pwd)/wr-backup-private.asc:/tmp/private.asc:ro" \
  -v wr-prod_backup_data:/backups:ro \
  -v "$(pwd)/scripts/restore.sh:/scripts/restore.sh:ro" \
  -e PGHOST=<복구대상_DB호스트> \
  -e PGPASSWORD=<password> \
  -e PGDATABASE=wr_evaluation \
  -e RESTORE_AUTH_TICKET=<티켓번호> \
  "wr-backup:${WR_VERSION}" \
  sh -c 'export GNUPGHOME=$(mktemp -d) \
    && gpg --batch --import /tmp/private.asc \
    && sh /scripts/restore.sh /backups/daily/wr-backup-YYYYMMDD_HHMMSS.dump.gpg'
```

스크립트가 `YES` 입력을 요구합니다. 확인 후 입력하면 복구가 진행됩니다.

### 5-3. 복구 후 검증

```bash
# restore.sh가 자동으로 row count를 출력함 (users / patient_records / audit_logs)
# 애플리케이션 재기동 후 정상 동작 확인
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file .env.production \
  -p wr-prod \
  up -d app
docker compose -p wr-prod exec app wget -qO- http://localhost:3001/health
```

### 5-4. 개인키 삭제 (필수)

```bash
rm -f wr-backup-private.asc
ls wr-backup-private.asc 2>/dev/null && echo "WARNING: key not deleted" || echo "Key deleted OK"
```

---

## 6. 분기 복구 리허설

**분기 1회** (3월·6월·9월·12월 첫 주), 정보보안팀 감독 하에 실행합니다.

### 리허설 원칙

- 프로덕션 DB가 아닌 **별도 복구 테스트 환경** 사용
- 복구에 사용하는 데이터는 **비식별화된 샘플** (이름·생년월일·환자번호 마스킹)
- 리허설 완료 후 테스트 환경 즉시 삭제

### 리허설 절차

> **분기 리허설의 상세 절차는 `PRODUCTION_RELEASE_PLAN.md` section 5-3이 정본입니다.**
> 아래는 요약 참조용입니다.

```bash
WR_VERSION=$(grep '^WR_VERSION=' .env.production | cut -d= -f2)

# 1. 격리된 테스트 네트워크 + PostgreSQL 기동
docker network create wr-restore-test-net

docker run -d --name wr-restore-test \
  --network wr-restore-test-net \
  -e POSTGRES_DB=wr_evaluation \
  -e POSTGRES_USER=wr_user \
  -e POSTGRES_PASSWORD=test_only \
  postgres:16-alpine

until docker exec wr-restore-test \
  pg_isready -U wr_user -d wr_evaluation 2>/dev/null; do sleep 2; done

# 1-a. wr_audit_reader role 생성 (dump에 GRANT가 포함되므로 필수)
docker exec wr-restore-test \
  psql -U wr_user -d wr_evaluation \
  -c "CREATE ROLE wr_audit_reader LOGIN PASSWORD 'restore_audit_pw';"

# 2. 가장 최근 월간 백업으로 복구 시도
docker run --rm -it \
  --network wr-restore-test-net \
  -v "$(pwd)/wr-backup-private.asc:/tmp/private.asc:ro" \
  -v wr-prod_backup_data:/backups:ro \
  -v "$(pwd)/scripts/restore.sh:/scripts/restore.sh:ro" \
  -e PGHOST=wr-restore-test \
  -e PGUSER=wr_user \
  -e PGPASSWORD=test_only \
  -e PGDATABASE=wr_evaluation \
  -e "RESTORE_AUTH_TICKET=REHEARSAL-$(date +%Y%m)" \
  "wr-backup:${WR_VERSION}" \
  sh -c 'export GNUPGHOME=$(mktemp -d) \
    && gpg --batch --import /tmp/private.asc \
    && sh /scripts/restore.sh "/backups/monthly/wr-backup-$(date +%Y%m).dump.gpg"'

# 3. 복구 성공 확인 후 테스트 환경 전체 삭제
docker rm -f wr-restore-test
docker volume rm wr-restore-test-data 2>/dev/null || true
docker network rm wr-restore-test-net
rm -f wr-backup-private.asc
```

### 리허설 기록

리허설 결과를 IT 헬프데스크 또는 보안 운영 로그에 기록합니다:

| 항목 | 내용 |
|---|---|
| 실행일 | |
| 백업 파일 | |
| 복구 소요 시간 | |
| 검증 결과 (행 수 일치) | |
| 감독자 서명 | |

---

## 7. 보존 정책

| 구분 | 파일 위치 | 보존 기간 | 비고 |
|---|---|---|---|
| 일별 | `/backups/daily/` | 30일 | crond가 자동 삭제 |
| 월별 | `/backups/monthly/` | 12개월 | 월 첫 백업 보존 |
| 연별 | `/backups/yearly/` | **5년** | 감사 로그 보존 기간과 정합 |

5년 경과 후 파기 절차는 [9절](#9-파기-절차) 참조.

---

## 8. GPG 키 교체 (연 1회)

GPG 키는 **매년 1회** 교체합니다. 이전 키는 5년간 보관합니다.

### 8-1. 새 키 생성 (정보보안팀, 에어갭 PC)

```bash
gpg --full-generate-key
# 새 키 생성, 만료 2년 설정
gpg --armor --export <새_키_이메일> > wr-backup-public-$(date +%Y).asc
gpg --armor --export-secret-keys <새_키_이메일> > wr-backup-private-$(date +%Y).asc
```

### 8-2. 서버에 새 공개 키 등록

```bash
docker compose exec -T backup gpg --import < wr-backup-public-$(date +%Y).asc
```

### 8-3. `.env` 수정

```bash
BACKUP_GPG_RECIPIENT=<새_키_지문>
```

```bash
docker compose up -d backup
```

### 8-4. 교체 확인

```bash
docker compose exec backup sh /scripts/backup.sh
# 새 키로 암호화되는지 확인
```

### 8-5. 이전 키 보관

이전 개인 키는 오프라인 매체에 **5년간** 보관합니다 — 이전 기간의 백업을 복구할 때 필요합니다.

---

## 9. 파기 절차

보존 기간(5년) 만료 후:

1. `backup_data` 볼륨에서 해당 연도 파일을 `docker compose exec backup rm`으로 삭제
2. 해당 연도 이전 GPG 개인 키가 더 이상 필요 없으면:
   - 오프라인 매체에서 GPG 개인 키 파일 삭제
   - 매체 물리 파쇄 (도구: 3패스 덮어쓰기 후 파쇄 또는 소각)
3. 파기 사실을 보안 운영 로그에 기록 (날짜, 파기 키 지문, 담당자 서명)

---

## 10. 트러블슈팅

### 백업 실패 — `BACKUP_GPG_RECIPIENT is required`

`.env`에 `BACKUP_GPG_RECIPIENT`가 없거나 컨테이너가 재시작되지 않았습니다.

```bash
# .env 확인 후
docker compose up -d backup
```

### 백업 실패 — `gpg: <recipient>: No public key`

공개 키가 keyring에 없습니다. [3-2절](#3-2-시스템-관리자-서버에-공개-키-등록)을 다시 수행하세요.  
`backup_gnupg` 볼륨이 삭제되면 keyring이 초기화됩니다.

### 복구 실패 — `gpg: decryption failed: No secret key`

복구 환경에 개인 키가 임포트되지 않았습니다. [5-2절](#5-2-개인-키를-임시-복구-환경으로-가져오기)을 확인하세요.

### 백업 로그 확인

```bash
docker compose logs backup --tail=100 -f
```

### 백업 파일 무결성 확인 (복호화 없이)

```bash
docker compose exec backup gpg --list-packets /backups/daily/wr-backup-YYYYMMDD_HHmmss.dump.gpg
# → 정상: "encrypted data packet" 출력
# → 이상: 오류 메시지
```
