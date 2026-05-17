# 직업성 질환 통합 평가 시스템 (wr-evaluation-unified)

> **Version:** 5.0.0 | **Status:** 인트라넷 백엔드 통합 완료 / 오프라인 배포 준비 완료

직업환경의학 전문의가 **업무상 질병 인정 여부를 판단**할 때 사용하는 통합 평가 도구.
무릎(슬관절), 척추(요추 MDDM), 경추(목 BK2109), 팔꿈치(주관절 BK2101/2103/2105/2106), 어깨(견관절 BK2117), 손목(수관절 BK2113/2101/2103/2106) 평가를 지원하며, 향후 고관절 등을 플러그인 형태로 확장할 수 있다.

**3가지 배포 형태 지원:**
- **웹 (Vercel/Standalone)**: 개인 사용자가 브라우저에서 사용 — localStorage 기반
- **데스크톱 (Electron Standalone)**: 단일 PC 설치 — 파일 시스템 기반
- **병원 인트라넷 (Electron + 서버)**: 다중 사용자 + 서버 DB + 감사 로그 + 백업 (v5.0.0 신규)

## 기술 스택

### 프론트엔드 / 클라이언트

| 영역 | 기술 |
|------|------|
| 프론트엔드 | React 18, CSS Variables (다크모드 지원) |
| 빌드 | Vite 5 |
| 데스크톱 | Electron 22 + electron-builder (NSIS) |
| 웹 배포 | Vercel (서버리스) |
| AI | Google Gemini API (기본) + Claude API (Vercel 서버리스 / Electron IPC) |
| 내보내기 | xlsx (엑셀), html2pdf.js (PDF), jszip |
| 폰트 | Pretendard (CDN), Noto Sans KR (fallback) |

### 백엔드 / 인프라 (인트라넷 모드, v5.0.0)

| 영역 | 기술 |
|------|------|
| API 서버 | Node.js 20 + TypeScript + Express |
| 데이터베이스 | PostgreSQL 16 (감사 로그 파티셔닝 포함) |
| 리버스 프록시 / HTTPS | Caddy 2 (내부 CA 자동 발급) |
| 컨테이너 | Docker Compose v2.17+ (profile 기반 backup 분리) |
| 백업 | pg_dump + GPG 암호화 (cron 자동 실행) |
| 백업 모니터링 | 별도 컨테이너 (stale 감지, alert 생성) |
| 인증 | JWT (access + refresh) + bcrypt, must_change_password 정책 |
| 감사 로그 | Ed25519 서명 (Electron 디바이스 키페어), append-only 파티션 |
| 디바이스 관리 | 인트라넷 PC 등록/승인 (admin 콘솔) |
| 테스트 | Vitest (server/) + Vitest (renderer/) |

## 빌드 & 실행

### 공통

```bash
npm install               # 의존성 설치
npm run dev               # 개발 서버 (localhost:3000)
npm run build:web         # 웹 빌드 → dist/web/
```

### Standalone (단일 PC / 웹)

```bash
npm run build:electron               # Electron 빌드 → dist/electron/
npm run electron:dev                 # Electron 개발 실행 (standalone)
npm run electron:build               # Electron 패키징 (standalone, NSIS)
```

### 인트라넷 모드 (서버 + 다중 클라이언트)

```bash
# 1) 서버 측 — Docker Compose 기반 풀스택
docker compose up -d                              # 개발용
docker compose -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file .env.production -p wr-prod up -d     # 프로덕션

# 2) 인트라넷 빌드 Electron 클라이언트
npm run electron:build:intranet                   # 인트라넷용 NSIS 인스톨러

# 3) 오프라인 배포 패키지 생성 (서버 + 클라이언트 인스톨러 + 설치 스크립트)
.\scripts\export-offline-package.ps1 -Version "5.0.0"
```

### Vercel 배포 (웹/standalone)

```bash
npm i -g vercel
vercel login
vercel --prod --scope <your-scope>
vercel env add GEMINI_API_KEY    # Gemini AI 분석용 (기본)
vercel env add CLAUDE_API_KEY    # Claude AI 분석용 (선택)
```

### 인트라넷 배포 (병원 air-gapped 환경)

자세한 절차는 [docs/OFFLINE_DEPLOYMENT_PACKAGE.md](docs/OFFLINE_DEPLOYMENT_PACKAGE.md) 참조:
1. 개발 PC에서 `export-offline-package.ps1` 실행 → `wr-evaluation-unified-5.0.0-intranet.zip` 생성
2. USB로 병원 서버 PC에 전달 후 압축 해제
3. `install-prod.ps1` 자동 실행 → Docker 이미지 로드 + 서비스 기동
4. Caddy 내부 CA 루트 인증서 추출 → 클라이언트 PC들에 신뢰 저장소 등록
5. Electron 인트라넷 인스톨러로 클라이언트 PC 설치 → 서버 URL 설정 → device 승인

## 핵심 아키텍처

### 플러그인 모듈 시스템

각 평가 모듈은 `src/modules/<name>/index.js`에서 `registerModule()`을 호출하여 자기 자신을 등록한다.

```javascript
registerModule({
  id: 'knee',
  name: '무릎 (슬관절)',
  icon: '🦵',
  EvaluationComponent,    // 메인 UI 컴포넌트
  createModuleData,       // 초기 데이터 팩토리
  computeCalc,            // 계산/점수 산출 함수
  isComplete,             // 완료 판정 함수
  exportHandlers,         // 내보내기 핸들러
  tabs: [{ id: 'job', label: '신체부담 평가' }],
  presetConfig: {         // 프리셋 시스템 연동 (선택)
    label, fields,
    extractFromModule(moduleData, sharedJobId) { ... },
    applyToModule(moduleData, sharedJobId, presetData) { ... },
  },
});
```

**새 모듈 추가:**
1. `src/modules/<name>/` 디렉토리 생성
2. `index.js`에서 `registerModule()` 호출
3. `src/App.jsx`에 `import './modules/<name>'` 한 줄 추가
4. (선택) `src/core/utils/diagnosisMapping.js`에 ICD 코드 매핑 추가

### 데이터 모델

```
Patient
├── id, phase
└── data
    ├── shared                     ← 모듈 공통
    │   ├── patientNo, name, gender, height, weight, birthDate, injuryDate
    │   ├── hospitalName, department, doctorName
    │   ├── medicalRecord, highBloodPressure, diabetes, visitHistory
    │   ├── consultReplyOrtho/Neuro/Rehab/Other  ← 다학제 회신
    │   ├── diagnoses[]            ← 상병 목록 { id, code, name, side }
    │   └── jobs[]                 ← 직업력 { id, jobName, startDate, endDate, ... }
    ├── modules
    │   ├── knee                   ← 무릎 전용 (jobExtras[], returnConsiderations)
    │   ├── shoulder               ← 어깨 전용 (jobExtras[], returnConsiderations)
    │   ├── elbow                  ← 팔꿈치 전용 (jobEvaluations[], temporalSequence)
    │   ├── wrist                  ← 손목 전용 (jobEvaluations[], temporalSequence)
    │   ├── cervical               ← 경추 전용 (tasks[] — sharedJobId로 직업 연결)
    │   ├── spine                  ← 척추 전용 (tasks[] — sharedJobId로 직업 연결)
    └── activeModules: ['knee', 'spine', 'shoulder', 'elbow', 'wrist', 'cervical']
```

## UI 흐름 (위자드)

```
[공유] 기본정보 → 상병 입력 → 모듈 선택
[무릎] 🦵 신체부담 평가
[팔꿈치] 💪 신체부담 평가
[손목] ✋ 신체부담 평가
[어깨] 🙆 신체부담 평가
[경추] 👤 부담 노출 평가
[척추] ⚕️ 신체부담 평가
[공유] 종합소견 → AI 분석
```

### 종합소견

좌우 2패널 레이아웃:
- **좌측**: 상병별 상태 확인 및 업무관련성 평가 (무릎: KLG/좌우 구분, 어깨: Ellman Class/좌우 구분, 팔꿈치/손목: BK 유형 자동 제안/수동 + 공통 시간적 선후관계, 경추/척추: 수직분포원리/동반성 척추증 확인 + 업무관련성, 좌우 구분 없음)
- **우측**: 전체 모듈 결과 통합 미리보기

## 평가 모듈

### 무릎 모듈 (knee)

한국 산재보상보험법 근골격계 질환 업무관련성 평가 기준 적용.

- **입력**: 쪼그려앉기 시간, 중량물 무게, 보조변수 6개
- **결과**: 신체부담기여도(%), 누적신체부담 판정, 직종별 부담등급 (고도/중등도상/중등도하/경도)

### 팔꿈치 모듈 (elbow)

독일 산재보험 BK2101/2103/2105/2106 기반 공통 신체부담 평가. 임계값/스코어가 아닌 **Gate-and-Flag 판정** 방식.

| BK 유형 | 질환 |
|---------|------|
| BK2101 | 상과병변 / 부착부 건병증 |
| BK2103 | 팔꿈치 골관절염 / 박리성 골연골염 |
| BK2105 | 팔꿈치 점액낭염 |
| BK2106 | 주관증후군 / 척골신경병변 |

- **데이터 구조**: `jobEvaluations[]` (직업 × 상병 2차원 entry) + 모듈 전체 공통 `temporalSequence` 1회 입력
- **자동 BK 매핑**: ICD(M77.0/M77.1/T75.2) + 상병명 키워드(상과염, 테니스·골프엘보, 주관증후군, 점액낭염, 진동성 팔꿈치 관절병증). 수동 선택 지원(`bkSelectionMode: auto | manual`)
- **입력**: 핵심 동작 연결성, 공통 노출유형(반복/힘/비중립 자세), 1일 노출시간, 하루 작업 비중, 작업 형태, 휴식 분포, BK 분기별 세부 필드
- **판정**: 공통 필수 입력 게이트 통과 시 15+ flag(daily_share_high/moderate/low, rest_unfavorable, core_exposure_present, BK별 pattern_supported, temporal_fit_high 등). `work_pattern === 'continuous'` 시 daily_share 임계값 상향(1.5h/20% vs 3h/40%)
- **결과**: 상병별 위험 요인 목록 + narrative 서술 + 종합평가 문장

### 손목 모듈 (wrist)

팔꿈치 모듈과 동일한 Gate-and-Flag 판정 방식을 따르며 손목/손가락 특화 지표(BK2113 등)를 추가로 수집하여 서술 형태 보고서를 자동화.

| BK 유형 | 질환 |
|---------|------|
| BK2113 | 수근관 증후군 (손목터널증후군) |
| BK2101 | 건초염 (방아쇠수지, 드퀘르벵 등) |
| BK2103 | 손목 관절병증 (진동) |
| BK2106 | Guyon canal 증후군 / 압박성 신경병증 |

- **데이터 구조**: `jobEvaluations[]` (직업 × 상병 2차원 entry) + 모듈 전체 공통 `temporalSequence` 1회 입력
- **입력**: 팔꿈치 공통 노출 항목 + 손목 고유 추가 지표(예: BK2113 반복적 손목 굴곡 유무 등)
- **판정 및 결과**: 팔꿈치와 마찬가지로 공통 필수 임계값 게이트 통과 이후 flag 조합에 따른 서술형 평가 반영.

### 어깨 모듈 (shoulder)

독일 직업병 BK2117 기준 — 어깨 근골격계 질환 누적 노출 평가.

- **입력**: 오버헤드 작업, 반복동작(중간/고도), 중량물 취급(횟수+시간), 손-팔 진동 (각 직업별 일일 노출량)
- **계산**: 일일노출 × 연간근무일수 × 근무년수 → 직력 전체 누적시간 합산
- **결과**: 5개 노출 유형별 BK2117 임계값 대비 누적시간/비율 비교
- **누적 신체부담 판정**: 임계값 초과 항목이 1개 이상이면 "충분", 초과 없이 50%↑ ≥3개 또는 75%↑ ≥2개이면 "복합 노출 고려 충분", 그 외 "불충분"

| 노출 유형 | 임계값 |
|-----------|--------|
| 오버헤드 작업 | 3,600시간 |
| 반복동작 중간속도 | 38,000시간 |
| 반복동작 고도 | 9,400시간 |
| 중량물(≥20kg) | 200시간 |
| 손-팔 진동 | 5,300시간 |

### 경추 모듈 (cervical)

독일 산재보험 BK2109 기준 — 경추 질환 부담 노출 평가. 팔꿈치/손목 모듈과 유사한 **Gate-and-Flag 판정** 방식.

- **평가 대상**: 경추간판 탈출증(M50), 경추 협착증(M48.02) 등 경추 질환
- **노출 유형**: 어깨에 무거운 하중 운반(BK2109), 장시간 비중립·정적 목 부하(Awkward/Static Neck Load)
- **데이터 구조**: `tasks[]` (sharedJobId로 직업 연결) — 척추(spine)와 동일 패턴
- **입력**: 대표 문제 작업, 하중(kg), 교대당 운반 시간, 부자연스러운 목 자세 강제 여부, 비중립 정적 자세 시간(시간/일), 굴곡/회전 동시 발생, 고도의 정밀 작업
- **판정**: BK2109 하중 ≥40kg → heavy_load_met, 비중립 자세 ≥1.5~2시간 → static_load_met 등 flag 판정 후 narrative 및 종합평가 문장 자동 생성
- **종합소견**: 척추(spine) 모듈과 동일하게 좌우 구분 없는 축(Axial) 상병으로 처리
- **프리셋 지원**: 경추 공통 노출 7개 필드(`main_task_name`, `load_weight_kg`, `carry_hours_per_shift` 등) 추출/적용

### 척추 모듈 (spine)

MDDM (Mainz-Dortmund Dose Model) 독일 직업성 요추 질환 평가 모델 적용.

- **입력**: 작업 자세 G1~G11 (들기/운반/들고 있기 3개 카테고리), 중량물 무게, 빈도, 시간, 보정계수
- **직업별 관리**: 2개 이상 직업 시 직업별 탭으로 작업 분리, 각 직업별 일일선량/누적선량 개별 산출 후 합산
- **압박력 최소 기준**: 남녀 공통 1,900N (기준 미만 작업은 일일 선량 제외)
- **4,000N 규칙**: 작업 중 하나라도 압박력 ≥ 4,000N이면 일일 누적 용량 임계치(2.0 kN·h) 미만이어도 평생 누적 용량 계산에 포함
- **일일 노출 중증도**: 고도(일 >4kN·h 또는 최대 ≥6kN) / 중등도상(>3kN·h 또는 ≥5kN) / 중등도하(≥2kN·h 또는 ≥4kN) / 경도
- **종합소견**: 수직분포원리(확인/미확인) + 동반성 척추증(확인/미확인) 드롭다운
- **결과**: 최대 압박력(N), 일일 누적 용량(kN·h) + 중증도, 평생 누적 용량(MN·h), 직업별 누적선량 내역, 업무관련성 등급

| 기준 | 남성 | 여성 |
|------|------|------|
| DWS2 연구 기준 | 7.0 MN·h | 3.0 MN·h |
| 독일 법원 기준 | 12.5 MN·h | 8.5 MN·h |
| MDDM 기준 | 25 MN·h | 17 MN·h |

## AI 분석

통합 AI 분석 탭에서 **Google Gemini**(기본) 또는 **Anthropic Claude**를 선택하여 분석.

| 모델 | 특징 |
|------|------|
| Gemini 2.5 Flash (기본) | 빠름/저비용 |
| Gemini 2.5 Pro | 정밀 (thinking 기능 내장) |
| Claude Haiku 4.5 | 빠름/저비용 |
| Claude Sonnet 4.6 | 정밀 |

| 플랫폼 | 경로 | API 키 관리 |
|--------|------|-------------|
| 웹 (Vercel) | `POST /api/analyze` → 서버리스 | 서버 환경변수 `GEMINI_API_KEY` / `CLAUDE_API_KEY` |
| Electron | `window.electron.analyzeAI()` → IPC | 사용자 입력 키 (설정 모달) |

## 내보내기

각 Excel 버튼(현재/선택/전체)은 드롭다운으로 형식 선택 가능:

| 형식 | 모드 | 출력 |
|------|------|------|
| **EMR 형식** | 현재/선택/전체 | EMR 소견서 `.xlsx` (선택/전체는 `.zip`) |
| **일괄입력용** | 현재/선택/전체 | flat table `.xlsx` (75열, roundtrip 지원) |
| PDF | - | 보고서 미리보기 영역 PDF 변환 |

일괄 Import: 엑셀 파일에서 복수 환자 일괄 등록 (드래그 앤 드롭, 무릎+어깨+척추 작업+팔꿈치 BK 엔트리+등록일 포함)

## 디렉토리 구조

> **v5.0.0 기준** — 인트라넷 백엔드, 디바이스 감사, 동기화 hooks/services, 배포 스크립트 등이 추가됨.

```
wr-evaluation-unified/
├── docker-compose.yml                  # 기본 compose (dev + intranet 공통)
├── docker-compose.prod.yml             # 프로덕션 오버레이 (포트 미노출, healthcheck)
├── .env.production.example             # 프로덕션 env 템플릿
│
├── server/                             # API 백엔드 (v5.0.0 신규)
│   ├── Dockerfile
│   ├── migrations/                     # 15개 SQL migration
│   │   ├── 0001_initial.sql ... 0015_backfill_assigned_doctor_from_payload.sql
│   ├── src/
│   │   ├── index.ts                    # Express 진입점, 두 개의 pool (메인 + audit reader)
│   │   ├── config.ts                   # 환경변수 검증
│   │   ├── middleware/
│   │   │   ├── auth.ts                 # JWT 검증
│   │   │   ├── audit.ts                # writeAuditLog 헬퍼
│   │   │   ├── corsMiddleware.ts
│   │   │   ├── rateLimit.ts
│   │   │   └── security.ts
│   │   ├── routes/
│   │   │   ├── auth.ts                 # /api/auth (login, refresh, signup-request, change-password)
│   │   │   ├── patients.ts             # /api/patients (CRUD + 충돌 감지)
│   │   │   ├── presets.ts              # /api/presets (custom preset CRUD)
│   │   │   ├── workspaces.ts           # /api/workspaces (자동저장/스냅샷)
│   │   │   ├── admin.ts                # /api/admin (users, devices, audit, ops)
│   │   │   ├── audit.ts                # /api/audit (POST 서명된 감사 로그 수신)
│   │   │   ├── devices.ts              # /api/devices/register
│   │   │   ├── ai.ts                   # /api/ai (Gemini/Claude 프록시)
│   │   │   └── opsStatus.ts            # /api/ops/* (백업 상태, alert)
│   │   ├── jobs/                       # 백그라운드 잡 (workspace retention 등)
│   │   ├── db/                         # patient_persons, assigned_doctor 해결 등
│   │   └── cli/                        # seedAdmin, runRetention
│   └── package.json
│
├── services/
│   └── backup-monitor/                 # 백업 stale 감지 + alert 컨테이너
│       ├── Dockerfile
│       ├── index.js
│       └── __tests__/isStale.test.js
│
├── backup/
│   └── Dockerfile                      # backup 사이드카 (postgres:16-alpine + gnupg + cron)
│
├── caddy/
│   └── Caddyfile                       # HTTPS + 내부 CA 자동 발급
│
├── scripts/
│   ├── backup.sh                       # pg_dump → GPG 암호화 (alert 권한 fix 포함)
│   ├── restore.sh                      # 복호화 → pg_restore (GPG_PASSPHRASE 지원)
│   ├── audit-partition.sh              # 감사 로그 월별 파티션 생성
│   ├── backup-crontab, partition-crontab
│   ├── export-offline-package.ps1      # 오프라인 패키지 생성 (v5.0.0 신규)
│   ├── import-images.ps1 / .sh         # docker load 일괄
│   ├── install-prod.ps1                # Windows 자동 설치
│   ├── set-build-target.mjs            # standalone/intranet 빌드 타깃 토글
│   ├── verify-csp.mjs                  # CSP 헤더 검증
│   └── mock-intranet-server.mjs        # 개발용 mock 서버
│
├── shared/                             # contracts (server ↔ client 공유 타입, v5.0.0 신규)
│   └── contracts/
│       ├── auth.ts, patient.ts, preset.ts
│       └── index.ts
│
├── electron/                           # Electron 데스크톱 (v5.0.0 분기 빌드)
│   ├── main.js                         # 메인 프로세스
│   ├── preload-standalone.js           # standalone 빌드용 preload
│   ├── preload-intranet.js             # intranet 빌드용 preload (device 등록 IPC 등)
│   ├── audit.js                        # device 키페어 + Ed25519 서명 + 큐 (v5.0.0)
│   ├── auditQueue.js                   # 감사 로그 디스크 큐
│   ├── migrationGate.js                # 인트라넷 모드 첫 진입 시 마이그레이션 게이트
│   ├── migrationDataReader.js          # standalone 데이터 → 서버 마이그레이션
│   ├── paths.js, build-target.json
│   └── emr-helper/                     # EMR 자동화 (C#)
│
├── src/                                # 프론트엔드 (React)
│   ├── App.jsx
│   ├── index.css
│   ├── core/
│   │   ├── moduleRegistry.js
│   │   ├── auth/                       # AuthContext, authChannel, session (v5.0.0 신규)
│   │   ├── components/
│   │   │   ├── LandingScreen, IntakeWizard, PatientSidebar, MainHeader, ...
│   │   │   ├── LoginModal, ChangePasswordModal, AccountProfileModal     # v5.0.0
│   │   │   ├── AdminConsoleModal, SignupRequestModal                    # v5.0.0
│   │   │   ├── ConflictResolveModal, MigrationReportModal               # v5.0.0
│   │   │   ├── PresetSearch, PresetManageModal, PresetsSection
│   │   │   ├── BatchImportModal, SettingsModal, ...
│   │   ├── hooks/
│   │   │   ├── useAIAnalysis, useAIAvailable
│   │   │   ├── usePatientList, usePatientCrud
│   │   │   ├── usePatientSync (v5.0.0)        # 인트라넷 환자 동기화
│   │   │   ├── useMigration (v5.0.0)          # standalone → 서버 마이그레이션
│   │   │   ├── useServerConfig, useOpsStatus  # v5.0.0
│   │   │   ├── useWorkspacePersistence, ...
│   │   ├── services/
│   │   │   ├── presetRepository, patientRecords, workspaceRepository
│   │   │   ├── patientServerRepository (v5.0.0)            # 서버 CRUD
│   │   │   ├── intranetWorkspaceRepository (v5.0.0)        # 서버 workspace
│   │   │   ├── patientConflictResolution (v5.0.0)
│   │   │   ├── localToServerMigrator (v5.0.0)
│   │   │   ├── httpClient, analysisClient, integrationStatus
│   │   ├── utils/
│   │   │   ├── steps, data, diagnosisMapping, reportGenerator
│   │   │   ├── exportService, storage, platform, common
│   │   │   └── csrfCookie (v5.0.0)
│   ├── modules/
│   │   ├── knee, spine, shoulder, elbow, wrist, cervical
│   └── api/analyze.js                  # Vercel 서버리스 (standalone 모드)
│
├── public/
│   ├── images/                         # G1~G11 자세 이미지
│   └── job-presets.json                # builtin 직업 프리셋
│
└── docs/                               # 운영/배포 문서
    ├── PRD.md, README.md
    ├── OFFLINE_DEPLOYMENT_PACKAGE.md   # 오프라인 설치 가이드 (v5.0.0)
    ├── PRODUCTION_RELEASE_PLAN.md      # 운영 절차서
    ├── T46_GO_NO_GO.md                 # 리허설 결과표
    ├── T46_IMPLEMENTATION_PLAN.md
    ├── OPERATIONS_RUNBOOK.md
    ├── BACKUP_MONITORING_PLAN.md
    ├── INTRANET_DEPLOYMENT.md          # HTTPS / 인증서 신뢰 등록
    └── BACKUP_RESTORE.md
```

기존 모듈/유틸 세부 구조는 PRD.md 11절을 참조하세요.

```
src/  # (기존 standalone 부분만 발췌)
├── App.jsx                          # 메인 앱 진입점 (로직 분리 후 200줄 이하)
├── index.css                        # 글로벌 스타일 (CSS Variables)
├── core/                            # 공유 프레임워크
│   ├── moduleRegistry.js            # 모듈 등록/조회 API
│   ├── components/                  # 핵심 UI 컴포넌트
│   │   ├── LandingScreen.jsx        # 홈 화면 및 환자 목록
│   │   ├── IntakeWizard.jsx         # 신규 환자 생성 3단계 위자드
│   │   ├── PatientSidebar.jsx       # 환자 목록 사이드바 (검색/필터)
│   │   ├── MainHeader.jsx           # 상단 헤더 (환자 정보, 설정)
│   │   ├── StepContent.jsx          # 활성 스텝 콘텐츠 렌더러
│   │   ├── StepIndicator.jsx        # 위자드 진행 표시기
│   │   ├── SaveLoadModals.jsx       # 저장/로드 모달
│   │   ├── BasicInfoForm/           # 기본정보 입력 & 사이드패널
│   │   ├── DiagnosisForm/           # 상병 입력
│   │   ├── AssessmentStep/          # 모듈별 평가 스텝
│   │   ├── PresetSearch/            # 프리셋 검색/적용
│   │   ├── PresetManageModal/       # 프리셋 저장/삭제
│   │   ├── BatchImportModal/        # 일괄입력 (드래그&드롭)
│   │   ├── SettingsModal/           # 설정 모달 (AI 키, 폰트 등)
│   │   └── ...
│   ├── hooks/                       # 사용자 정의 훅
│   │   ├── useEMRIntegration.js     # EMR 통합 상태 & 동기화
│   │   ├── useExportHandlers.js     # 내보내기 (Excel/PDF) 로직
│   │   ├── useIntakeWizard.js       # 신규 환자 위자드 상태
│   │   ├── usePatientCrud.js        # 환자 생성/조회/수정/삭제
│   │   ├── usePresetManagement.js   # 프리셋 로드/저장/캐싱
│   │   ├── useStepNavigation.js     # 스텝 네비게이션
│   │   ├── useWorkspacePersistence.js # 워크스페이스 자동 저장/복구
│   │   ├── useAIAnalysis.js         # AI 모델 선택 (Gemini/Claude)
│   │   ├── usePatientList.js        # 환자 목록 로드
│   │   └── useIntegrationStatus.js  # EMR 연동 상태
│   ├── services/                    # 비즈니스 로직 서비스
│   │   ├── presetRepository.js      # 프리셋 CRUD (builtin+custom 병합)
│   │   ├── patientRecords.js        # 환자 레코드 관리
│   │   ├── workspaceRepository.js   # 워크스페이스 저장/복구
│   │   └── ...
│   ├── utils/                       # 유틸리티 함수
│   │   ├── steps.js                 # buildSteps() — 동적 스텝 생성
│   │   ├── data.js                  # 데이터 초기화 & 마이그레이션
│   │   ├── diagnosisMapping.js      # ICD 코드 → 모듈 매핑
│   │   ├── reportGenerator.js       # 통합 미리보기 보고서
│   │   ├── exportService.js         # 엑셀/PDF 내보내기
│   │   ├── patientCompletion.js     # 환자 완료 판정
│   │   ├── storage.js               # localStorage/Electron FS 추상화
│   │   ├── platform.js              # 웹/Electron 플랫폼 분기
│   │   └── common.js                # 공통 상수 & 헬퍼
│   └── auth/                        # 인증 (향후 사용)
├── modules/
│   ├── knee/                        # 무릎 모듈 (한국 산재 기준)
│   │   ├── KneeEvaluation.jsx       # 메인 컴포넌트
│   │   ├── components/              # JobTab, KneeResultPanel, AssessmentTab
│   │   ├── utils/                   # calculations, data, exportHandlers
│   │   └── index.js                 # 모듈 등록
│   ├── spine/                       # 척추 모듈 (MDDM)
│   │   ├── SpineEvaluation.jsx      # 메인 컴포넌트
│   │   ├── components/              # TaskManager, TaskEditor, SpineResultPanel
│   │   ├── utils/                   # calculations, formulaDB, thresholds, data
│   │   └── index.js                 # 모듈 등록
│   ├── shoulder/                    # 어깨 모듈 (BK2117)
│   │   ├── ShoulderEvaluation.jsx   # 메인 컴포넌트
│   │   ├── components/              # JobTab, ShoulderResultPanel
│   │   ├── utils/                   # calculations, data, exportHandlers
│   │   └── index.js                 # 모듈 등록
│   ├── elbow/                       # 팔꿈치 모듈 (BK2101/2103/2105/2106)
│   │   ├── ElbowEvaluation.jsx      # 메인 컴포넌트
│   │   ├── components/              # ExposureForm, DiseaseSpecificFields, ElbowResultPanel
│   │   ├── utils/                   # calculations, data, exportHandlers
│   │   └── index.js                 # 모듈 등록
│   ├── wrist/                       # 손목 모듈 (BK2113/BK2101/2103/2106)
│   │   ├── WristEvaluation.jsx      # 메인 컴포넌트
│   │   ├── components/              # ExposureForm, DiseaseSpecificFields, WristResultPanel
│   │   ├── utils/                   # calculations, data, exportHandlers
│   │   └── index.js                 # 모듈 등록
│   └── cervical/                    # 경추 모듈 (BK2109)
│       ├── CervicalEvaluation.jsx   # 메인 컴포넌트
│       ├── components/              # TaskManager, TaskEditor, CervicalResultPanel
│       ├── utils/                   # calculations, data, exportHandlers
│       └── index.js                 # 모듈 등록
├── api/
│   └── analyze.js                   # Vercel 서버리스 (Gemini/Claude API 프록시)
├── electron/                        # Electron 데스크톱 앱
│   ├── main.js                      # 메인 프로세스 (윈도우/메뉴 관리)
│   ├── preload.js                   # 프리로드 스크립트 (IPC 브릿지)
│   └── emr-helper/                  # EMR 데이터 추출 헬퍼 (C#)
├── public/
│   ├── images/                      # G1~G11 자세 이미지
│   ├── job-presets.json             # 직업 프리셋 (builtin)
│   └── index.html                   # HTML 진입점
```

## 상병 자동 매핑

ICD 코드 기반 모듈 자동 추천:

| ICD 코드 패턴 | 추천 모듈 |
|---------------|-----------|
| M17, M22, M23, M70.4, M76.5, S83 | 무릎 (knee) |
| M77.0, M77.1, T75.2 | 팔꿈치 (elbow) |
| G56.0, M65.3, M65.4, M65.8, M19.04 | 손목 (wrist) |
| M75, S43, S46, M19.01 | 어깨 (shoulder) |
| M50, M48.02 | 경추 (cervical) |
| M51, M54, M47, M48, M53 | 척추 (spine) |

## 향후 로드맵

| 우선순위 | 항목 | 설명 |
|----------|------|------|
| P1 | 고관절 모듈 | hip 모듈 추가 (플러그인 패턴 활용) |
| P2 | ~~척추 프리셋 연동~~ | ~~직업 프리셋 선택 시 MDDM 작업/변수 자동 채움~~ → v3.2.1 완료 |
| P2 | ~~EMR 데이터 추출~~ | ~~진료기록분석지/다학제회신 자동 추출~~ → v3.3.0 완료 |
| P2 | 통합 PDF/Word | 통합 보고서를 PDF/Word 형식으로도 출력 |
| P3 | ~~다중 사용자~~ | ~~서버 기반 데이터 저장 + 사용자 인증~~ → v5.0.0 완료 (인트라넷 모드) |
| P3 | 현장 device smoke | 실제 병원 PC에 인트라넷 인스톨러 배포 + 의료진 device 등록 검증 |
| P3 | 백업 자동 재해 복구 훈련 | 분기별 1회 복구 전용 환경에서 실제 복원 검증 |

---

## 변경 이력

### v5.0.0 (2026-05-16) — 인트라넷 백엔드 + 다중 사용자 모드 + 오프라인 배포

병원 인트라넷 환경에서 다중 사용자 운영을 위한 풀스택 백엔드를 도입했다.
기존 standalone(Electron/웹) 모드는 그대로 유지하며, **빌드 타깃**으로 인트라넷 모드를 분리.

**백엔드 인프라 (신규)**
- **API 서버**: Node.js 20 + TypeScript + Express, JWT 인증, bcrypt, must_change_password 정책
- **DB**: PostgreSQL 16, 15개 migration (사용자/조직/환자/직업력/상병/세션/감사로그/디바이스/프리셋/idempotency/retention/signup_request 등)
- **HTTPS 리버스 프록시**: Caddy 2 (내부 CA 자동 발급, leaf 인증서 자동 갱신)
- **감사 로그**: append-only 파티션 + 별도 read-only role(`wr_audit_reader`)
- **백업 + 모니터링**: 별도 컨테이너, GPG 암호화, stale 감지 + alert 파일 생성
- **컨테이너**: Docker Compose v2.17+ `!reset` 태그로 prod 오버레이 (포트 미노출, healthcheck)

**Electron 인트라넷 빌드 (신규)**
- **build-target**: `electron/build-target.json`으로 standalone/intranet 분기 (preload 분리)
- **Device 등록**: 앱 첫 실행 시 Ed25519 키페어 생성, 서버에 공개키 등록(pending → admin 승인 → active)
- **감사 로그 서명**: 모든 사용자 액션이 device 개인키로 서명되어 서버에 전송 + 큐 백업
- **EMR 접근 제어**: device active 상태일 때만 EMR helper 동작 허용
- **자가 치유**: `flushQueue` (5분 간격)에서 pending → active 자동 인식

**다중 사용자 시스템 (신규)**
- **역할**: admin / doctor / nurse / staff
- **AccountProfileModal**: 본인 정보/비밀번호 변경
- **AdminConsoleModal**: 사용자 관리, device 승인, 감사 로그 조회, 백업 상태, 가입 요청 처리
- **SignupRequestModal**: 비로그인 가입 요청 → admin 승인
- **ChangePasswordModal**: must_change_password 강제 흐름
- **LoginModal**: 인트라넷 모드 진입점

**데이터 동기화 (인트라넷)**
- **patientServerRepository**: 환자 데이터 서버 CRUD (assigned_doctor 자동 해결)
- **usePatientSync**: 실시간 환자 목록 동기화 + 충돌 감지
- **ConflictResolveModal**: 동일 환자 동시 편집 충돌 시 mine/theirs/merge 선택
- **localToServerMigrator**: 기존 standalone localStorage/파일 데이터 → 서버로 일회성 마이그레이션
- **MigrationReportModal**: 마이그레이션 결과 리포트

**오프라인 배포 패키징 (신규)**
- **scripts/export-offline-package.ps1**: Docker save → tar → zip 일괄 생성
  - app/backup-monitor/backup 이미지 + postgres:16-alpine + caddy:2-alpine + Electron 인스톨러 + 문서 + 스크립트
  - SHA256SUMS, release-manifest.json 자동 생성
  - 시크릿 누출 가드 (`.env`, `.asc` private key 등 패키지 제외 확인)
- **scripts/import-images.ps1 / .sh**: 오프라인 서버에서 `docker load` 일괄 처리
- **scripts/install-prod.ps1**: Windows 서버 자동 설치 (사전 검증 6단계 → up -d)
- **docker-compose.prod.yml**: prod 오버레이 (포트 미노출, healthcheck, image: 태그 고정)

**T46 프로덕션 릴리즈 리허설 (전 섹션 PASS)**
- volume 격리(`wr-prod_*`), migration 정합성, admin seed (비대화형 파이프 입력), 백업 + 복호화 검증, 롤백 dry-run, Go/No-Go 판정
- 발견된 개선 항목 모두 fix:
  - **alert resolve 권한**: `backup.sh`의 `write_json_atomic`에서 `_alerts/*.json` 생성 후 `chown 1000:1000` 적용 → admin 콘솔의 "해결" 버튼 500 에러 수정
  - **GPG passphrase**: `restore.sh`에 `GPG_PASSPHRASE` 환경변수 지원 추가 + 복구 전용 키페어(passphrase 없음) 별도 발급 가이드 추가

**문서 (신규/대폭 개정)**
- `docs/OFFLINE_DEPLOYMENT_PACKAGE.md` — 단계별 설치 절차 (Windows/Linux 분리, 12개 섹션, PowerShell 실행 정책 가이드 포함)
- `docs/PRODUCTION_RELEASE_PLAN.md` — 운영 절차서 (롤백 경로 6-2/6-3 분기)
- `docs/T46_GO_NO_GO.md` — 리허설 결과표
- `docs/T46_IMPLEMENTATION_PLAN.md` — 리허설 구현 계획
- `docs/OPERATIONS_RUNBOOK.md` — 운영 런북
- `docs/BACKUP_MONITORING_PLAN.md` — 백업 모니터링 설계
- `docs/INTRANET_DEPLOYMENT.md` — HTTPS / 내부 CA / 인증서 신뢰 등록 (3가지 방법)
- `docs/BACKUP_RESTORE.md` — 백업·복구 상세

### v4.2.1 (2026-04-27) — 대시보드 & 환자 관리 기능 강화

**대시보드 개선**
- **스택형 차트 추가**: 업무관련성 평가 결과별 세분화 (높음/낮음/미평가)
- **StackedBarChart 컴포넌트**: 범주별 색상 구분 + 인라인 범례 표시
- **차트 캡션**: 각 차트별 시간 범위 및 설명 추가
- **통계 함수 확대**: `dashboardStats.js`에 세분화된 계산 로직 추가

**환자 목록 & 검색 강화**
- **고급 정렬 기능**: 기본/이름/환자번호/생년월일/등록일/평가일 6가지 정렬 방식
- **인라인 정렬 토글**: 헤더 클릭으로 오름차순/내림차순 전환
- **고급 필터**: 모듈별/직업별/등록일 범위/평가일 범위 필터
- **직업 자동완성**: `JobFilterCombobox` 컴포넌트로 직업명 검색 제안
- **날짜 범위 선택**: 등록일/평가일 Start~End 범위 입력
- **필터 상태 기억**: 사용자가 설정한 정렬/필터 상태 유지
- **UX 개선**: 키보드 네비게이션 (↑↓ 화살표, Enter/Esc) 지원

**스타일 & CSS 변수**
- **차트 스타일**: `.dashboard-chart-area`, `.stacked-bar`, 범례 스타일 추가
- **필터 패널**: `.advanced-filter-section`, `.filter-group` 스타일 추가
- **자동완성 드롭다운**: `.jobfilter-combobox-list`, `.suggested-item` 스타일
- **다크모드 호환성**: 모든 신규 색상에 CSS 변수 적용

**코드 개선**
- **usePatientList**: 필터링 및 정렬 로직 모듈화
- **dashboardStats.js**: 세분화된 통계 함수 추가 (모듈별/평가결과별 집계)
- **컴포넌트 분리**: PatientSidebar에서 JobFilterCombobox 분리

### v4.2.0 (2026-04-25) — 아키텍처 리팩터링

**App.jsx 대규모 분리 리팩터링**
- **목표**: Monolithic App.jsx → 컴포넌트 + 훅으로 분리 (유지보수성·테스트 가능성 향상)
- **새로운 UI 컴포넌트** (`src/core/components/`)
  - `LandingScreen`: 홈 화면 및 환자 목록
  - `IntakeWizard`: 신규 환자 3단계 위자드 (기본정보 → 상병 → 모듈 선택)
  - `PatientSidebar`: 환자 목록 사이드바 (검색/필터/정렬)
  - `MainHeader`: 상단 헤더 (환자 정보, 설정, 도구)
  - `StepContent`: 활성 스텝 콘텐츠 렌더러
  - `StepIndicator`: 위자드 진행 표시기
  - `SaveLoadModals`: 저장/로드 모달
- **새로운 사용자 정의 훅** (`src/core/hooks/`)
  - `useEMRIntegration`: EMR 통합 상태 & 동기화
  - `useExportHandlers`: 내보내기 (Excel/PDF) 로직
  - `useIntakeWizard`: 신규 환자 위자드 상태
  - `usePatientCrud`: 환자 CRUD 작업
  - `usePresetManagement`: 프리셋 로드/저장/캐싱
  - `useStepNavigation`: 스텝 네비게이션
  - `useWorkspacePersistence`: 워크스페이스 자동 저장/복구
- **새로운 유틸** (`src/core/utils/`)
  - `steps.js`: `buildSteps()` — 활성 모듈에 따른 동적 스텝 생성
- **개선 사항**
  - App.jsx 파일 크기 1500줄 → 200줄 이하로 축소
  - 로직별 관심사 분리로 코드 이해도·유지보수성 향상
  - 번들 코드 스플릿 최적화 기반 마련

**경추 모듈 계산 로직 최적화**
- 완료 판정 완화: task가 있는 직업에만 필드 완성 체크
- RISK_FACTOR_FLAGS 정규화: warning tone 4개로 한정
- 파생 플래그 중복 제거 & 고아 task 자동 정리
- 프리셋 적용 안정성 개선

### v4.1.0 (2026-04-24)
- **경추 평가 완료 판정 완화**: 경추 task가 있는 직업에 대해서만 필드 완성 여부를 체크 — 경추와 무관한 직업이 있어도 "완료"로 표시
- **경추 위험요인 의미론 수정**: `RISK_FACTOR_FLAGS`를 `warning` tone 4개(하중/운반시간/강제목자세/누적하중)로 한정 — 진단 지지 플래그(positive/info)가 "업무관련성 위험 요인" 란에 혼입되던 문제 해결
- **파생 플래그 중복 집계 제거**: `mechanical_cervical_load_dominant`를 FLAG_ORDER에서 제외하고 종합 배지로만 표시 — 위험요인 카운트 중복 방지
- **isCervicalAssessmentComplete 중복 sync 제거**: 내부에서 `syncCervicalModuleData` 이중 호출 → `computeCervicalCalc` 단일 호출로 통합
- **고아 task 정리 (경추·척추)**: 삭제된 직업을 가리키는 task를 `syncCervicalModuleData` 및 `SpineEvaluation useEffect`에서 자동 제거; jobs 배열이 임시로 비는 경우 pruning 건너뜀(`shouldPrune` 가드)
- **프리셋 적용 시 기본 task 덮어쓰기 (경추·척추)**: `sharedJobId`가 비어 있는 초기 기본 task를 `applyToModule`에서 교체 대상으로 처리 — 프리셋 적용 후 "작업 1"이 잔존하던 문제 해결
- **경추 프리셋 id 이중 생성 제거**: `applyToModule`의 불필요한 `id: createCervicalTask(...).id` 재할당 삭제

### v4.0.0 (2026-04-23)
- **경추(목) 모듈 신설**: BK2109 기반 경추 질환 부담 노출 평가 — 어깨 하중 운반(≥40kg) + 비중립·정적 목 부하(≥1.5~2시간) Gate-and-Flag 판정
- 경추 전용 `tasks[]` (sharedJobId로 직업 연결 — 척추 패턴과 동일)
- 경추 프리셋 시스템 연동 (`presetConfig` — 공통 노출 7개 필드 추출/적용)
- 상병 자동 매핑에 경추 ICD 코드(M50, M48.02) 및 키워드(경추, 목디스크, 척수병) 추가
- 통합 미리보기/EMR 소견서/엑셀에 `<경추(목)>` 섹션 자동 포함
- 종합소견에서 경추 상병은 척추와 동일하게 좌우 구분 없는 축(Axial) 상병으로 처리
- **모듈 아이콘 호환성 개선**: 윈도우 7 기본 폰트에서 깨지지 않도록 Unicode 6.0 이하 기호로 일괄 교체
  - 경추: 👤 (Bust in Silhouette) / 어깨: 🙆 (Person Gesturing OK) / 팔꿈치: 💪 (Flexed Biceps) / 요추: ⚕️ (유지)
- **프리셋 모달 안정화**: `getPresetCategory`/`getPresetDescription` null 안전 처리 — 프리셋 저장 버튼 클릭 시 빈 화면 크래시 수정
- 프리셋 저장 정책 개선: 직종명+카테고리+설명 기반 identity 저장, 모듈별 비파괴 병합

### v3.4.0 (2026-04-21)
- **손목(수관절) 모듈 신설**: 수근관 증후군(BK2113), 건초염/방아쇠수지(BK2101) 등 평가 지원
- 팔꿈치 모듈과 동일한 Gate-and-Flag 아키텍처 적용
- 엑셀 일괄입력 서식 및 EMR 단일 보고서 통합 출력 강화(101열 지원)

### v3.3.0 (2026-04-20)
- **EMR 데이터 추출 (Electron)**: `EmrHelper.cs`에 진료기록분석지(`--extract-record`) / 다학제회신(`--extract-consultation`) 추출 모드 추가. IE COM 자동화로 환자명, 생년월일, 재해일자, 진료기록, 기저질환, 수진이력, 상병 목록, 과별 회신 자동 읽기
- **EMR 일괄 추출 UI**: 선택된 환자 또는 현재 환자의 환자등록번호 기반 순차 추출 + 프로그레스 바. patientNo 교차검증 포함
- **다학제 회신 추출/입력**: `다학제 추출` 버튼으로 과별 회신 읽기 → `다학제 보내기` 버튼으로 EMR 종합소견 2,3번 칸에 입력
- **환자등록번호 (`patientNo`)**: 기본정보 입력, 대시보드 테이블, 일괄 Import에 등록번호 컬럼 추가
- **EMR 연동 데이터 섹션**: 기본정보 사이드패널에 진료기록/기저질환(고혈압·당뇨)/수진이력 입력 섹션 추가 (섹션 3)
- **다학제 회신 섹션**: 정형외과/신경외과/재활의학과/기타 4과 회신 입력 (섹션 4). AutoResizeTextarea 적용
- **EMR 소견서 확장**: 개인적 요인에 고혈압/당뇨/수진이력 포함, 진료기록 필드(`txtMrecMedPovCont`) 직접입력 지원, 다학제 회신 요약을 종합소견 엑셀에 포함
- **팔꿈치 프리셋 지원**: 공통 노출 10개 필드 추출/적용, `_pendingPreset` 대기 메커니즘
- **모듈 jobExtras 자동 생성**: 무릎/어깨 직업 추가 시 자동 생성, 척추 미귀속 태스크 폴백
- **프리셋 내보내기/가져오기 개선**: 커스텀 프리셋만 정제 내보내기, category/description 보존
- **일괄 Import 필드 그룹 세분화**: 직업/무릎/어깨/척추/팔꿈치 공통/팔꿈치 BK별 6개 그룹으로 분리
- **EmrHelper 공통 래퍼**: `runHelper()` 함수로 EMR 헬퍼 실행 경로/타임아웃/에러 처리 통합

### v3.2.1 (2026-04-16)
- **커스텀 프리셋 생성/저장**: `PresetManageModal` — 현재 입력된 신체부담 데이터를 프리셋으로 저장. 모듈별 선택, 데이터 미리보기, 커스텀 프리셋 삭제 지원
- **프리셋 저장소 신설**: `presetRepository.js` — builtin(`job-presets.json`) + custom(localStorage/Electron FS) 이중 저장소, 병합 로드, JSON 내보내기/가져오기
- **전 모듈 presetConfig 지원**: 무릎(8개 필드), 어깨(6개 노출량), 척추(작업 배열 교체) — 각 모듈이 `extractFromModule`/`applyToModule` 계약으로 프리셋 시스템 연동
- **프리셋 검색 개선**: 모듈 배지 표시, 커스텀 프리셋 태그, 검색 결과 10개 확장
- **중복 저장 방지**: id + jobName 이중 매칭

### v3.2.0 (2026-04-16)
- **팔꿈치(주관절) 모듈 신설**: `src/modules/elbow/` — BK2101/2103/2105/2106 4유형 분기, Gate-and-Flag 판정, 공통 시간적 선후관계(모듈 전체 1회 입력), 직업 × 상병 2차원 `jobEvaluations[]` 구조
- **자동 BK 매핑**: ICD(M77.0, M77.1, T75.2) + 상병명 키워드(상과염/테니스·골프엘보/주관증후군/점액낭염/진동성 팔꿈치 관절병증). 수동 선택(`bkSelectionMode: auto | manual`) 지원
- **`work_pattern` 수식자**: `continuous` 시 daily_share 임계값 상향(1.5h/20% vs 3h/40%), rest_unfavorable이 `moderate` 휴식에서도 활성화
- **팔꿈치 결과**: ElbowResultPanel — 공통 시간적 선후관계 flag + 직업/상병별 Summary Card(BK 라벨, flag pill, narrative, 종합평가 문장)
- **팔꿈치 내보내기**: EMR 소견서 단일 시트 B5~B9 7행 구조(`excelSingle`) + html2pdf 기반 PDF
- **통합 미리보기**: `genElbowBurdenSection` 추가(`< 팔꿈치(주관절) >` 섹션). 척추 섹션은 helper 함수로 리팩터링되어 DWS2/법원/MDDM tiered 해석 문장 자동 생성
- **일괄입력용 서식 확장**: 팔꿈치 시간적 선후관계 4열 + BK 엔트리 27열(BK유형/선택방식/문제작업명/핵심동작/공통노출/세부지표 16열 + BK 분기 11열) 추가 → **총 75열**
- **복귀 고려사항 공유**: knee/shoulder/elbow 3개 모듈이 `returnConsiderations`를 공유하도록 fallback 확장
- **척추 압박력 기준 변경**: 남 2,700N / 여 2,000N → 남녀 공통 1,900N. 작업 압박력 ≥4,000N이면 일일 용량 임계치 미만이어도 평생 누적 포함
- **척추 일일 노출 중증도 표시**: 미리보기/엑셀에 일일 노출량 뒤 고도/중등도상/중등도하/경도 4단계 표시
- **척추 종합소견 드롭다운**: 수직분포원리(확인/미확인) + 동반성 척추증(확인/미확인)
- **어깨 누적 신체부담 판정**: 미리보기/엑셀/PDF에 BK2117 설명문 + 3단 해석(초과→충분, 복합노출→충분, 미달→불충분)
- **대시보드 개선**: 모듈 사용 카드 2×2 그리드(모듈별 개별 색상), 평균 처리일수 단위 인라인, 척추→허리 라벨 변경

### v3.1.0 (2026-04-04)
- **EMR 직접입력 개선**: C# EmrHelper를 reflection 기반 COM 접근으로 전면 재작성 — `dynamic` 키워드 제거, `[STAThread]` 추가, IHTMLDocument2 단일 시도로 lResult 소모 문제 해결, `--diagnose` 모드 추가
- **보안 하드닝**: Gemini API 키를 URL 쿼리에서 `x-goog-api-key` 헤더로 전환, CORS 오리진 허용 목록 적용(`*` 제거), IPC 경로 순회 방어(`sanitizeId`), `netRequest()` HTTP 상태코드 검사 추가
- **상태/UX 안정화**: Electron 메뉴 리스너 cleanup 추가, `handleStartIntake` stale closure 수정(useRef 패턴), 모듈 스텝 인덱스 동적 계산(하드코딩 `3` 제거), 단일 환자 삭제 시 확인 대화상자
- **저장 안정성**: 저장 snapshot ID를 `Date.now()` → `crypto.randomUUID()`로 변경, localStorage `QuotaExceededError` 처리(`safeSetItem` 래퍼)
- **빌드 정리**: EmrHelper 단일 빌드로 통합(x86/x64 이중 빌드 제거)

### v3.0.0 (2026-03-30)
- **어깨(견관절) 모듈 신설**: BK2117 독일 직업병 기준 누적 노출 평가 — 5개 노출 유형(오버헤드, 반복동작 중간/고도, 중량물, 진동) 직력 전체 누적 계산
- **중량물 입력 방식**: 횟수(회/일) + 시간(초/회) 분리 입력 → 내부 시간(시간/일) 자동 환산
- **어깨 종합소견**: Ellman Class(Grade 1/2/3/Full) 입력 + 상병별 좌/우 업무관련성 평가
- **종합소견 / 미리보기**: 어깨·척추 신체부담 섹션 추가 (기존에 무릎 섹션만 있던 문제 수정)
- **상병 자동 매핑**: 어깨 ICD 코드(M75 등) + 견관절/회전근개 등 키워드 추가
- **일괄입력용 서식**: 어깨 노출 6열 추가 → 44열
- **대시보드 개선**: 요약 카드 숫자 색상 구분 (총 환자/완료/진행 중/모듈), 모듈명 간소화

### v2.5.0 (2026-03-28)
- **대시보드 신설**: 현재 환자 목록 기반 통계(요약 카드, 월별 차트, 최근 활동 테이블) — 환자 이름 클릭 시 편집 화면으로 즉시 이동
- **등록일/평가일 분리**: `createdAt`(등록) / `updatedAt`(마지막 수정) / `evaluationDate`(평가 완료) 명확히 구분
- **목록 초기화**: 대시보드 및 메인 헤더에서 현재 환자 목록 전체 초기화
- **일괄 입력 등록일 컬럼 지원**: `등록일`/`접수일` 열 인식 (37열)
- **Electron 파일 기반 저장소**: 환자별 개별 JSON 파일(`{userData}/wr-eval-data/`) → localStorage 5-10MB 제한 극복, 수천 명 이상 관리 가능. 웹은 기존 localStorage 유지
- **앱 타이틀 변경**: "근골격계 질환 업무관련성 평가 및 소견서 작성 도우미"
- **홍길동 자동 입력 제거**: 첫 실행 시 예시 환자 자동 생성 삭제 (테스트 데이터 버튼은 유지)

### v2.4.1 (2026-03-26)
- **Electron IPC 복구**: preload.js의 `require('../package.json')` asar 경로 버그 수정 → 모든 IPC 기능 정상화
- **구버전 데이터 임포트**: LevelDB 파싱 + 마이그레이션 UI, 구버전 통합용 xlsx 내보내기 추가
- **다크모드 전면 개선**: 테두리 대비 강화, 시맨틱 색상 변수 도입, 하드코딩 색상 제거
- **KLG 등급 UI 컴팩트화**: 상병명 헤더 우측 인라인 드롭다운으로 축소
- **EMR 종합소견(b8) 개선**: 무릎 신체부담 데이터 + 참고문헌 삽입

상세 PRD는 [docs/PRD.md](docs/PRD.md)를 참고하세요.
