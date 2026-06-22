# 직업성 질환 통합 평가 시스템 (wr-evaluation-unified)

> **Version:** 6.0.0 | **Status:** M4 영상분석 시범 운영(참고용, 미검증 배너) + 에어갭 오프라인 배포 패키지 / 인트라넷 운영 중

직업환경의학 전문의가 **업무상 질병 인정 여부를 판단**할 때 사용하는 통합 평가 도구.
무릎(슬관절), 척추(요추 MDDM(BK2108) + 전신진동 BK2110), 경추(목 BK2109), 팔꿈치(주관절 BK2101/2103/2105/2106), 어깨(견관절 BK2117), 손목(수관절 BK2113/2101/2103/2106) 평가를 지원하며, 향후 고관절 등을 플러그인 형태로 확장할 수 있다.

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
1. 개발 PC에서 `export-offline-package.ps1` 실행 → `wr-evaluation-unified-{VERSION}-intranet.zip` 생성
2. USB로 병원 서버 PC에 전달 후 압축 해제
3. `install-prod.ps1` 자동 실행 → Docker 이미지 로드 + 서비스 기동
4. Caddy 내부 CA 루트 인증서 추출 → 클라이언트 PC들에 신뢰 저장소 등록
5. Electron 인트라넷 인스톨러로 클라이언트 PC 설치 → 서버 URL 설정 (`https://서버IP:8443`) → device 승인

> **기존 서버 업데이트**: `docs/UPDATE_5.1.0.md` 참조 (다운타임 ~10초, DB 변경 없음)

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

요추 압박력(MDDM, BK2108)과 **전신진동(BK2110)** 두 평가를 한 모듈에서 지원한다. 패널 상단 탭으로 편집 대상을 전환하지만, 두 평가는 **독립적으로 수행·출력**된다(종합소견·EMR·엑셀에 각각 별도 섹션). 각 평가는 3상태 토글(미평가/노출없음/노출있음)로 수행 여부를 관리하며, **'노출있음(present)'일 때만** 결과·산출물에 표시된다(MDDM 기본 '노출있음', 전신진동 기본 '미평가').

#### MDDM (요추 압박력, BK2108)

MDDM (Mainz-Dortmund Dose Model) 독일 직업성 요추 질환 평가 모델 적용.

- **입력**: 작업 자세 G1~G11 (들기/운반/들고 있기 3개 카테고리), 중량물 무게, 빈도, 시간, 보정계수
- **일일선량 공식**: `D_r = √(Σ F²·t / 8h) · 8h` (8시간 정규화 후 8시간 재곱, 단위 kN·h) — v5.1.3에서 원형 MDDM 공식과 단위 일치하도록 정정
- **직업별 관리**: 2개 이상 직업 시 직업별 탭으로 작업 분리, 각 직업별 일일선량/누적선량 개별 산출 후 합산
- **작업 순서 변경**: 같은 직업 탭 내에서 마우스 드래그앤드롭으로 순서 변경 — id 기반 재구성, 방향 인식 drop indicator (v5.1.0+)
- **압박력 최소 기준**: 남녀 공통 1,900N (기준 미만 작업은 일일 선량 제외)
- **4,000N 규칙**: 작업 중 하나라도 압박력 ≥ 4,000N이면 일일 누적 용량 임계치(2.0 kN·h) 미만이어도 평생 누적 용량 계산에 포함
- **일일 노출 중증도** (v5.1.3+ 남녀 분리):
  - 남성: 고도(일 >4 kN·h 또는 최대 ≥6,000 N) / 중등도상(>3 또는 ≥5,000) / 중등도하(≥2 또는 ≥4,000) / 경도
  - 여성: 고도(일 >3 kN·h 또는 최대 ≥5,000 N) / 중등도상(>2 또는 ≥4,000) / 중등도하(≥0.5 또는 ≥3,000) / 경도
- **레거시 결과 보존** (v5.1.3+): 모듈 데이터의 `formulaVersion` 플래그로 분기 — 기존 환자는 옛 공식 결과 그대로 유지, spine 작업을 실제로 추가/수정/삭제(드래그 reorder 포함)·프리셋 적용·BatchImport로 task 생성 시점에 `v5.1.3`으로 자동 승격되어 새 공식 적용
- **종합소견**: 수직분포원리(확인/미확인) + 동반성 척추증(확인/미확인) 드롭다운 — **첫 spine 진단에만** 표시, 첫 진단 삭제 시 살아남은 진단으로 값 자동 이송 (v5.1.0+)
- **결과**: 최대 압박력(N), 일일 누적 용량(kN·h) + 중증도, 평생 누적 용량(MN·h), 직업별 누적선량 내역, 업무관련성 등급

| 기준 | 남성 | 여성 |
|------|------|------|
| DWS2 연구 기준 | 7.0 MN·h | 3.0 MN·h |
| 독일 법원 기준 | 12.5 MN·h | 8.5 MN·h |
| MDDM 기준 | 25 MN·h | 17 MN·h |

#### 전신진동 (BK2110, v5.1.6+)

독일 BK2110(장기간 주로 수직 방향 전신진동 노출로 인한 요추간판 질환) 에너지형 진동노출 모델 적용. 간이 모드로, 진동가속도 aw를 **최소~최대 범위**로 입력받아 하한·상한 시나리오를 구간으로 산출한다(단일 대표축 단순화, k계수 생략).

- **입력**: 직업별 진동 노출 구간 — 대표 진동가속도 aw 하한·상한(m/s²), 1일 총 노출시간(시간/분/초)
- **공식**: 구간별 `A(8) = aw·√(T/8h)`, 직업 내 다구간은 에너지합 `A(8) = √((1/8h)·Σ aw_i²·T_i)`. 일일 지표 `Amax(8)`(직업별 에너지합), 평생 누적용량 `DV = Σ Amax(8)²·근무일수·근속연수`(직업별 합산, Amax(8) ≥ 0.63일 때만 산입)
- **다중 직업**: 일일 Amax(8)는 직업별 최대값으로 집계(서로 다른 기간을 동시 노출로 합산하지 않음), DV는 직업 간 합산
- **판정 기준**: 일일 `Amax(8) ≥ 0.63 m/s²`, 평생 `DV,RI = 1400 (m/s²)²` — 구간이 기준을 걸치면 '걸침', 하한도 넘으면 '초과'. 위험도는 평생 DV 기준(보조 참고: 일일 조치값 0.5, z축 한계 0.8 m/s²)
- **입력 유효성**: aw 상한 < 하한인 구간은 invalid로 계산 제외 + 경고, 완료 불가. 직업력 없으면 구간 추가 비활성
- **참고표**: 입력 패널 하단에 장비별 진동가속도(aw) 범위 차트(접기/펼치기) — aw 입력값 가이드
- **결과**: 일일 Amax(8) 범위, 평생 DV 범위, 0.63/1400 기준 대비 진행바, 직업별 내역

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
    ├── UPDATE_5.1.0.md                 # v5.0.x → v5.1.0 현장 업데이트 절차 (v5.1.0 신규)
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
│   ├── preload-intranet.js          # 프리로드 스크립트 (인트라넷 빌드, IPC 브릿지)
│   ├── preload-standalone.js        # 프리로드 스크립트 (스탠드얼론 빌드, IPC 브릿지)
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

### v6.0.0 (2026-06-22) — M4 영상분석 시범 운영(참고용) + 에어갭 패키징

근골격계 부담작업 영상분석(자세 추정 기반)을 "참고용 시범 운영"으로 활성화하고, 에어갭 인트라넷 서버용 오프라인 배포 패키지를 완성. (M4 6.0-9)

- **레시피 버전관리(§8.11)**: 분석 산출물에 `analysis_recipe`(코드 commit·가중치 sha·키포인트 계약)를 기록. 서버가 apply 시 레시피를 권위 검증(suffix diff·canonical prefix 불변·exact-set·서버 상수 대조·provenance 필수)하고, 미검증(unverified)은 fail-closed로 차단.
- **에어갭 컨테이너화**: Python 포즈 추론(rtmlib/onnxruntime-cpu)을 app 이미지에 동봉, baked 가중치의 실제 `.onnx` SHA256을 manifest와 대조해 불일치 시 fail-closed(`model_loader.verified_model_shas`). `server/Dockerfile` glibc(bookworm) 통일.
- **오프라인 패키지**: `scripts/export-offline-package.ps1` — 실파일 sha 검증·dirty 가드·`WR_GIT_COMMIT` 주입·`release-manifest.json`(videoInference 출처) 생성. compose에 `video_uploads` 볼륨 + 추론 mem/cpu 제한.
- **시범 운영 정책 B**: 영상분석 결과에 "미검증(참고용)" 배너 표시 + 제안 행 수정 시 수정사유(`editReason`) 입력 → 피드백 수집. 정확도 검증·임계값 배선 전까지 자동 게이팅은 비활성.
- **대시보드**: 관리자 의사별 통계 드롭다운 + 위험도 '낮음' 사유 7항목 분할.
- 검증: 서버 513 / 클라이언트 770 tests pass, `npm run build:web` 통과, docker build + `--network none` 추론 smoke 통과.

### v5.1.8 (2026-06-13) — 보안 점검 적용: AI 프록시 모델 allowlist + Electron IPC 보강 + PDF 푸터 이스케이프

전체 코드 리뷰(보안/리팩터링/정리) 1차 적용분. 즉시 적용 가능한 보안 보강과 정리 작업.

- **AI 프록시 모델 allowlist** (`api/analyze.js`): 허용된 Gemini/Claude 모델 외 요청은 400 반환 — 비용 탈취·경로 조작 방지.
- **Electron IPC 보강** (`electron/main.js`): `fs-migrate` 핸들러 3곳에 `sanitizeId()` 적용(path traversal 방지), `set-access-token`에 `isAllowedSender` origin 검사 추가.
- **PDF 푸터 XSS 방지**: elbow/wrist/shoulder 모듈 export의 PDF 푸터에 `escapeHtml` 적용 (knee는 기존부터 적용됨).
- **정리**: 미사용 `electron/preload.js`, `types/placeholder.d.ts`, `artifacts/elbow_module_structure.md` 삭제 + CLAUDE.md/AGENTS.md/README.md의 구조 참조를 `preload-intranet.js`/`preload-standalone.js`로 갱신.
- 검증: 클라이언트 446 tests pass, `npm run build:web` 통과. package.json 버전 미변경.

#### 2차 적용분 (2026-06-15) — 코드 구조 리팩터링 + 종합소견 Excel 일괄입출력

- **BatchImportModal 모듈화**: 587줄짜리 `handleImport`를 knee/shoulder/elbow/wrist/
  cervical/spine 6개 모듈의 `registerModule().batchImportConfig(columns/applyRow)`로
  분리, 공통 헬퍼는 `src/core/utils/batchImportHelpers.js`로 이동.
- **App.jsx 오케스트레이션 분할**: 987줄 → 624줄. 신규 훅 5개(`useAuthSync`,
  `useAppSettings`, `useEvaluationDateSync`, `useElectronMenuEvents`,
  `useConflictResolution`) + `AppModals.jsx` 컴포넌트로 순수 이동(로직 변경 없음).
- **AI 호출 모델 상수 공유**: 레포 루트에 `ai-models.config.cjs` 신설
  (ALLOWED_MODELS / DEFAULT_CLAUDE_MODEL / DEFAULT_GEMINI_MODEL / CLAUDE_MAX_TOKENS /
  GEMINI_MAX_OUTPUT_TOKENS) — `api/analyze.js`(ESM)와 `electron/main.js`(CJS) 양쪽의
  하드코딩 제거 후 공용 참조.
- **createTestPatients lazy 분리**: `src/core/utils/data.js`(859줄)의 테스트 데이터
  생성 로직을 `src/core/fixtures/createTestPatients.js`로 이동, `usePatientCrud.js`에서
  동적 import로 로드 — 빌드 시 별도 청크(`createTestPatients-*.js`)로 분리.
- **종합소견 Excel 일괄내보내기·일괄입력**: "일괄입력 형식" 엑셀(`BATCH_HEADERS`/
  `generateBatchRows`)의 'Ellman(좌)' 컬럼 뒤에 **상병상태(우/좌)·업무관련성(우/좌)·
  업무관련성낮음사유(우/좌)·수직분포원리·동반척추증** 8개 컬럼 추가. 재import 시
  `batchImportHelpers.js`의 `applyDiagnosisAssessment`가 값을 진단에 반영(spine
  전용 필드는 `moduleId === 'spine'`일 때만). 기존 환자·기존 진단의 평가값만 갱신되는
  재import도 "가져올 데이터가 없습니다"로 막히지 않도록 `stats.updatedAssessments`
  카운터를 완료 조건에 추가했고, 기존 값과 동일한 평가값은 갱신 건수에서 제외.
- **문서**: CLAUDE.md에 cervical/wrist/server(11개 라우터)/shared-contracts 섹션 추가,
  `docs/VERCEL_AI_PROXY_HARDENING.md` 신규(운영자용 Vercel 보안 설정 가이드).
- 검증: vitest 471 passed, `npm run build:web` / `build:electron` 통과, `npm run lint` 0 errors.

### v5.1.7 (2026-06-04) — 척추 MDDM dailyDose 임계치·중증도 사다리 하향 (임상 피드백)

v5.1.3 공식 환자의 일일선량(dailyDose) 임계치가 너무 높다는 임상 피드백 반영. 임계치는 평생누적용량 포함/제외 게이트이자 중증도 "중등도하" 진입값이라, 사다리 전체를 함께 하향.

- **dailyDose 임계치** (`thresholds.dailyDose.v513`): 남 5.5 / 여 3.5 → **남 4.0 / 여 3.0 kN·h** (legacy 남 2.0 / 여 0.5 불변).
- **중증도 사다리** (`classifySpineSeverity`): 정연한 비례(여=남×0.75)로 재설계 — 남 `중등도하 ≥4.0 / 중등도상 >6.0 / 고도 >8.0`, 여 `≥3.0 / >4.5 / >6.0`. 압박력(N) 경계(6,000/5,000/4,000N)와 단일 사다리 "모든 환자 일괄 적용" 구조는 불변.
- 단일 사다리라 legacy 공식 환자의 중증도 라벨도 새 기준을 따름(legacy dailyDose 스케일이 작아 실무 영향 미미).
- 변경: `thresholds.js`, `calculations.js`(classifySpineSeverity), 테스트(경계값 가드 보강), `docs/PRD.md`. 테스트 446개 통과.

### v5.1.6 (2026-06-01) — 척추 모듈에 전신진동(BK2110) 평가 추가 + MDDM과 공존

척추 모듈에 전신진동(BK2110) 평가를 추가하고, 기존 요추 압박력(MDDM)과 한 환자에서 독립적으로 공존하도록 구조 개편.

**전신진동(BK2110) 신규:**
- 진동가속도(aw)를 최소~최대 **범위**로 입력 → 하한·상한 시나리오로 Amax(8)·DV를 구간으로 산출(단일 대표축 단순화). 구간별 `A(8)=aw·√(T/8h)`, 직업 내 다구간 에너지합, 평생 `DV=Σ Amax(8)²·근무일수·근속연수`(Amax(8)≥0.63 게이트).
- 판정 기준: 일일 `Amax(8)≥0.63 m/s²`, 평생 `DV,RI=1400 (m/s²)²`. 다중 직업은 Amax(8) 직업별 최대 집계 + DV 직업 간 합산. 위험도는 평생 DV 기준.
- 입력 UI: aw 범위·1일 노출시간(단위별 max), invalid 구간(상한<하한) 계산 제외+경고, 직업력 없으면 추가 비활성, 장비별 진동가속도 참고표(접기/펼치기).
- 신규 파일: `vibrationCalc.js`(계산), `VibrationEvaluation.jsx`·`VibrationIntervalManager/Editor`·`VibrationResultPanel`(UI), `time.js`(순환참조 회피용 leaf), `sectionText.js`(WBV 섹션 텍스트), 테스트 `vibrationCalc.test.js`.

**MDDM ↔ WBV 공존 (구조 개편):**
- `computeSpineCalc`가 MDDM(top-level 평탄 필드) + WBV(`calc.vibration` 서브객체)를 함께 반환. 기존 `evalMethod` 디스패처(상호배타) 폐기 → 종합소견·EMR·엑셀에 두 평가 모두 출력.
- 두 평가 모두 3상태 토글(미평가/노출없음/노출있음). **present일 때만** 결과 패널·종합소견·내보내기에 표시(none·unknown은 공간 절약 위해 전부 생략). MDDM은 입력 부담↓ 위해 기본 present, WBV는 기본 unknown.
- 단일 패널 상단 탭(`activeSpineTab`)으로 MDDM/WBV 편집 전환, 결과 패널은 둘 다 렌더(각자 status로 게이트).
- 완료 판정: `(MDDM 유효 || WBV 유효) && 상병` — 둘 중 하나만 평가해도 완료.
- 하위호환: `resolveMddmStatus`/`resolveVibrationStatus` 헬퍼로 기존 환자(MDDM 작업 있으면 present)·1차 WBV 환자(intervals 있으면 present) 마이그레이션. 일괄 엑셀은 MDDM present일 때만 작업 행 생성.
- `patientCompletion`이 `isComplete`에 `activeModules` 전달(진단 모듈 매핑 fallback 보강). AI 시스템 프롬프트에 BK2110 기준 추가. cervical `generateJobNarrative` 미사용 인자 제거(lint).

테스트 442개 통과, build:web 성공.

### v5.1.5 (2026-05-29) — 척추 임계치·중증도 v5.1.3 스케일 재조정 + 위험/업무관련성 BSG 단일화

v5.1.3 일일선량 공식 정정으로 `dailyDoseKNh` 자릿수와 분포가 바뀐 뒤에도 임계치·중증도·위험/업무관련성 분기는 옛 공식 기준 그대로였음. 새 공식 스케일에 맞춰 일괄 재조정하고, KPI/위험/업무관련성이 비교 대상으로 삼는 기준을 독일 법원(BSG) 단일로 통일.

**척추(spine):**
- `thresholds.dailyDose` 버전별 분기 — v5.1.3: 남 5.5 / 여 3.5 kN·h, legacy: 남 2.0 / 여 0.5 kN·h (보존). `calculateLifetimeDose(..., formulaVersion)`이 환자 버전에 따라 임계치 선택.
- `classifySpineSeverity` 새 공식 스케일로 재조정 — 남 고도 `>10 kN·h`, 중등도상 `>8.0`, 중등도하 `≥5.5`; 여 고도 `>8.0`, 중등도상 `>5.5`, 중등도하 `≥3.5` (최대압박력 기준은 남녀 모두 6000/5000/4000N으로 통일).
- KPI "평생 누적 용량" 카드: 비교 기준 DWS2 → 독일 법원(BSG). 서브 = `독일 법원(BSG) NN%`, highlight = `court.percent ≥ 80`. 하단 3개 비교 카드(MDDM/독일 법원/DWS2)는 참고용으로 그대로 유지.
- 위험 배너(`assessRisk`): `comparison.court.percent` 직접 판정. `>100%` danger / `80~100%` warning / `<80%` safe.
- 업무관련성(`assessWorkRelatedness`): court 단일 3단계. `>courtLimit` 높음 / `courtHalf≤x≤courtLimit` 불충분(다른 요건 고려) / `<courtHalf` 낮음. 기여도 분모 = courtLimit.
- 종합소견 미리보기 / EMR 텍스트의 척추 섹션에서 `[적용 공식: …]` 라인 제거 — 외부로 나가는 산출물에는 비공개. SpineResultPanel 화면 배지는 임상가 확인용으로 유지.

**경추(cervical) 모듈:**
- "BK2109 위험 요인" / "업무관련성 위험 요인" 라벨 불일치를 **"확인된 목 부위 부담 지표"** 로 통일.
- 표시 항목 `riskFactorItems`(BK2109 한정 4개) → `flagItems`(확인된 모든 양성 flag)로 확장. 부담평가/종합소견 미리보기·EMR·통합 Excel 모두 동일.
- `generateJobNarrative` 첫 줄 `직업: {jobName}` 제거 → 카드 제목/`- 직력N:` 라인의 직업명 중복 해소.

**기타:**
- LandingScreen: 환자가 있는 intranet 모드에서 "환자 목록 보기"와 "작업 목록 돌아가기"가 동시 노출되던 중복 해소 — `patients.length === 0`일 때만 "환자 목록 보기" 노출(서버에 환자만 있는 케이스의 진입 경로 유지).
- AssessmentTab: "수직분포 정리" → "수직분포 원리" 오타 수정.

영향 범위: 환자 데이터 스키마 변경 없음. legacy 환자도 spine 작업을 편집하면 기존 `promoteSpineFormula`로 자동 v5.1.3 승격 + 새 임계치 적용(공식·임계치 묶음 일관). 397 tests pass.

### v5.1.4 (2026-05-28) — 척추 공식 버전 UI 노출

v5.1.3에서 환자별로 legacy / v5.1.3 공식이 분기되지만 UI에 표시되지 않아 임상가가 어느 공식 적용 중인지 알 수 없던 문제 해결.

- **SpineResultPanel**: "MDDM 결과" 제목 옆에 `MDDM v5.1.3` (초록) / `MDDM 레거시` (호박색) 배지 추가, 마우스 오버 시 의미 + 자동 승격 안내 tooltip
- **PDF (reportGenerator)·EMR (exportService)**: 척추 섹션 헤더에 `[적용 공식: ...]` 라인 추가 — 정적 산출물(소견서/내보내기 텍스트)에도 어느 공식으로 계산된 결과인지 기록되어 사후 추적·재발급 시점 비교 가능
- index.css에 `.spine-formula-badge` 스타일

배포 시 같은 v5.1.3 태그 덮어쓰기 회피를 위해 5.1.4로 patch 범프. 계산 로직 변경 없음, 기존 환자 데이터 영향 없음.

### v5.1.3 (2026-05-28) — 척추 일일선량 공식 정정 + 레거시 보존 + 여성 중증도 분리

**공식 정정**: `calculateDailyDose`를 원형 MDDM 공식 `D_r = √(Σ F²·t / 8h) · 8h`로 정정 (8h 정규화/재곱 누락, 시간을 초로 누적하던 단위 불일치 해결). 동일 입력에 대해 새 공식 결과가 이전 대비 약 ×2.83(=√8) 증가.

**레거시 결과 보존**: 모듈 데이터에 `formulaVersion` 필드 신설. 기존 환자(필드 부재)는 옛 공식 그대로 — 이전 PDF/EMR 출력과 100% 동일하게 일일선량·평생누적량·위험도·작업별 일일 기여 모두 보존. spine 작업을 실제로 추가/수정/삭제·드래그 reorder·프리셋 적용·BatchImport로 task 생성한 시점에 자동으로 `v5.1.3`으로 승격되어 새 공식 적용. sharedJobId 자동 정리(단순 열기) 경로에서는 승격 안 함. 서버 마이그레이션 불필요(JSONB payload에 자연 흡수).

**여성 중증도 경계값 분리**: 종합소견의 일일 노출 중증도(고도/중등도상/중등도하/경도) 기준이 기존 남녀 공통 → 남녀 분리. 남성은 기존 동일, 여성은 더 민감한 기준(0.5/2.0/3.0 kN·h, 3,000/4,000/5,000 N).

**작업별 일일 기여 표시**: v5.1.3 환자에서 작업별 기여는 총량을 `F²·t` 비중대로 배분 → 작업별 합 = 총 일일선량 보장(비가산성 해결). legacy 환자는 기존 단일 작업 공식 그대로 유지.

**코드 정리**: `reportGenerator.js`·`exportService.js`에 중복되던 spine 중증도 분류와 작업별 기여 계산을 `src/modules/spine/utils/calculations.js`의 `classifySpineSeverity`·`getSpineTaskDoses`로 추출. 상수는 `src/modules/spine/utils/formulaVersion.js`에 분리.

### v5.1.2 (2026-05-26) — 대시보드 통계 확장 + 최근활동 timestamp 계약 정리

서버 모드 전환 후 노출된 최근활동 회귀 (다음 날 옛 환자가 다시 상단에 올라오는 증상)를 데이터 계약 차원에서 수정. 대시보드 카드 의미 강화 + 인트라넷 테스트 버튼 가드.

**최근활동 timestamp 계약**
- 서버 `toResponse()`: `updatedAt`(DB `updated_at`으로 무조건 덮어쓰기, stale payload 차단) + `createdAt`(payload 값 우선, 없으면 DB `created_at`) 명시
- 클라이언트 `getRecentActivityTimestamp`: `updatedAt → _savedAt → createdAt` 폴백, `sync.lastSyncedAt`은 동기화 시각이라 의도적으로 제외, `Date.parse()` 숫자 비교
- `touchPatientRecord`가 모든 환자 변경 진입점에서 `updatedAt` 일관 set (이전엔 caller별로 비대칭)
- 회귀 테스트: 서버 4건, 클라이언트 4건

**대시보드 카드 확장**
- 헤더 3영역(좌 spacer / 중앙 로그인 배지 / 우 scope 토글)로 통합
- 내 환자 scope 마지막 카드: "내 미완료 평가" → **"내 환자 평가 완료율"** (진행중 카드와 중복 해소)
- 신규 카드 5종 (모두 전체/남/여 토글):
  1. 성별 비율 (SVG 도넛, 세그먼트 위 라벨 직접 표시)
  2. 평균 연령
  3. 연령대 분포 (30대↓ / 40대 / 50대 / 60대 / 70대↑)
  4. 대표 직종 Top 5 (`jobs[0].jobName` 기준)
  5. 상병 Top 5 (`diagnoses[].code` 기준, 한 환자 중복 카운트 없음)
- 신규 헬퍼: `normalizeGender`(`M/F`·`남/여`·`male/female` 정규화), `computeAge`(`formatBirthDate` 재사용으로 YYYYMMDD도 처리)
- 카드 그리드: `repeat(auto-fit, minmax(200px, 1fr))` + `grid-auto-rows: minmax(170px, 1fr)` — 카드 수 증가에 자동 적응, 모든 카드 동일 높이

**테스트 버튼 가드 (인트라넷)**
- 비admin: LandingScreen 버튼 자체 숨김 + 핸들러 early return (이중 방어, 콘솔 우회 차단)
- admin: `showConfirm`으로 "목록 교체 + 서버 동기화 가능성" 안내

### v5.1.1 (2026-05-20) — 진단별 모듈 수동 지정

자동 매핑이 실패한 진단을 모듈에 수동으로 지정할 수 있도록 정책과 UI 통합.

**진단 모델 + 매핑 정책**
- 진단에 `moduleId` 필드 추가 (`null`=자동, `'knee'/'spine'/...`=수동 지정, `'__none__'`=해당 없음)
- `resolveDiagnosisModule()` 우선순위 단일화: `__none__` → 수동 → 자동 키워드 hint → 단일 활성 모듈 fallback
- 모든 모듈 필터(`isCervicalDiagnosis`, `isElbowDiagnosis`, `isWristDiagnosis`, knee/spine/shoulder 인라인 필터)를 `resolveDiagnosisModule` 기반으로 통일 — 자동 매핑이 실패한 진단도 수동 지정만 하면 해당 모듈 화면에 즉시 노출
- `MODULE_LABELS` export + `isValidDiagnosisModuleId()` 헬퍼로 UI/resolve 유효성 기준 일원화
- 정책 회귀 보호용 단위 테스트 7건 추가

**UI**
- 진단 카드에 "평가 모듈" 드롭다운 추가 — "자동 (감지: 무릎)" / 등록 모듈 / "해당 없음"
- 수동 지정 시 진단 배지에 `· 수동` 표시
- 척추/경추 수동 지정 시 방향 라디오 자동 숨김
- 신규 환자 IntakeWizard 완료 시 진단의 명시 `moduleId`를 `selectedModules`에 자동 병합 → 모듈 선택 단계에서 빼먹어도 진단에 지정된 모듈은 자동 활성화
- 기존 환자 편집 시 `updateDiagnoses`가 수동 지정 모듈을 `activeModules`에 자동 추가 (기존 `modules[id]` 데이터는 보존)

**자동 매핑 키워드 보강**
- `족관절|발목` → knee 모듈로 임시 흡수 (전용 모듈 추가 시 분리 예정)
- `척골` → wrist 모듈

**인트라넷 Workspace Autosave 비활성화**
- 인트라넷 모드에서는 서버 patient sync가 단일 진실원이므로 로컬 autosave 복구 흐름 비활성화
- `workspaceAutosavePolicy` 헬퍼 신설, `useWorkspacePersistence` + `workspaceRepository` 인트라넷 가드 추가
- 로컬 모드 autosave UX는 변경 없음

### v5.1.0 (2026-05-20) — 다중 사용자 운영 UX 강화 + 권한 정책 + 척추 모듈 개선

v5.0.0 인트라넷 백엔드 도입 후 실제 운영에서 드러난 권한 미비점과 UX 결함을 정리.

**환자 권한 정책 (서버 + UI)**
- 환자 수정/삭제는 담당의(`assigned_doctor_user_id`) 또는 admin만 가능. 다른 의사 환자는 조회만 허용
- 신규 서버 미들웨어 `assignedDoctorOrAdmin` — `PATCH/DELETE /api/patients/:id`에 적용. 다른 org는 404(존재 누설 방지), 비담당은 403
- `POST /:id/assignment`(인계)는 현행 admin 전용 유지
- 신규 환자 생성 시 doctor 세션이면 클라이언트에서 `assignedDoctorUserId` 자동 mirroring → sync 전에도 본인 환자 정상 수정
- 클라이언트 헬퍼 `canEditPatient` / `canDeletePatient` — 로컬 모드는 단일 사용자라 항상 true, redacted는 항상 false
- PatientSidebar 삭제 버튼 게이팅 + 일괄 삭제는 patients 전체 기준 권한 검사
- StepContent 평가 영역을 HTML `inert` 속성으로 감싸 키보드 포커스/탭/스크린리더까지 차단
- `usePatientCrud.updatePatient` silent guard (EMR import / preset select / conflict resolve 등 우회 경로 차단)
- 동기화 시 403 받은 환자는 빨간 배너로 명시 표시, 정상 sync 시 자동 clear

**대시보드 scope 분리 (내 환자 / 전체)**
- 헤더 우상단 토글로 "내 환자 통계" ↔ "전체 통계" 전환 (인트라넷 + 로그인 시만 노출, 로컬 모드는 숨김)
- 별도 state로 분리 — 사이드바 환자 목록 sync는 건드리지 않음
- 'mine' 전용 카드: "내 미완료 평가 건수"
- 'all' 전용 카드: "의사별 환자 수 Top 5" (미배정 그룹 별도 표시)
- 빈 상태에서도 헤더+토글 보이고 "전체 보기로 전환" 버튼 제공

**다중 사용자 운영 UX**
- **인트라넷 차단 화면 탈출구**: 6개 차단 화면(서버 연결 중/연결 실패/세션 확인/로그인/비밀번호 변경/환자 목록 불러오는 중) 우상단에 "로컬 모드로 전환" 버튼 — 서버 장애/dev 환경에서 즉시 로컬 작업으로 전환 가능
- **랜딩에 "환자 목록 보기" 버튼**: 헤더 "대시보드" 클릭 후 랜딩에서 환자 목록으로 다시 빠져나가는 경로 마련 (인트라넷 + 환자 ≥ 1)
- **랜딩 로그인 사용자 배지**: 이름/역할 표시 (인트라넷만)
- **인트라넷에서 "초기화" 버튼 숨김**: 클라이언트 state만 비우는 동작이라 다중 사용자 환경에서는 삭제처럼 오해될 수 있어 인트라넷에서만 숨김. 로컬 모드는 유지

**척추 모듈 개선**
- 수직분포 / 동반 척추증을 **첫 spine 진단에만** 표시 (이전: 진단마다 반복). 기존 여러 진단에 흩어진 값은 첫 진단으로 자동 통합
- 첫 spine 진단 삭제 시 살아남은 진단으로 값 자동 이송 → 데이터 손실 방지
- **척추 작업 드래그앤드롭** — 같은 직업 탭 내에서 마우스로 작업 순서 변경. id 기반 재구성으로 다른 직업 순서 보존. 드래그 후 선택 유지. 위/아래 방향 인식 drop indicator
- 비목표: 터치/키보드 reorder (별도 작업)

**Caddy 호스트 포트 변경**
- 호스트 포트 80/443 → **8080/8443** (컨테이너 내부는 80/443 유지, Caddyfile 변경 없음)
- `CORS_ORIGINS` 환경변수에 `:8443` 포함 필요 (`.env.production`, `docker-compose.yml` 반영)
- 방화벽 인바운드 8080/8443 허용 필요

**개발 환경**
- 신규 `docker-compose.override.yml` — dev 스택만 `http://localhost:3000` (Vite) CORS 허용. prod compose는 영향 없음

**신규 문서**
- `docs/UPDATE_5.1.0.md` — v5.0.x → v5.1.0 현장 업데이트 절차 (예상 다운타임 ~10초, 검증 시나리오 8개, 롤백 무손실)

**검증**: 클라이언트 299 + 서버 369 = 668 tests pass. lint 0 errors. 빌드 성공.

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
