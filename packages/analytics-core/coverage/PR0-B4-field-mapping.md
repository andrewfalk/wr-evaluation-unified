# PR0-B4 필드 매핑표 (Slice -1 산출물, 4차 개정 확정 + 5차 개정: grain 단순화 + 6차 개정: person grain 재삭제)

계획 파일: `C:\Users\skirc\.claude\plans\project-stats-workbench-md-project-pr0-b-jazzy-hickey.md`

**1차 개정 대비 변경**: (1) 기존 카탈로그 21개 전체를 별도 표로 명시(요약 문장에만 일부 언급하던 걸 수정), (2) wrist를 elbow와 별개의 전수 표로 재작성(필드 자체가 다름 — "차이만"이 아님), (3) `reasonRight/Left`를 다중선택으로 재분류, (4) 무릎 job 필드 단위·명명 수정, (5) 모든 다중선택 필드의 실제 옵션 값을 코드에서 확인해 나열, (6) 전 표 8열로 통일, (7) 엔터티 키 전용 ID 필드의 범위결정을 "제외"로 통일.

**2차 개정 대비 변경**: (1) wrist에서 누락됐던 `static_holding_level`/`direct_pressure_level`/`vibration_exposure` 3개 행 추가, (2) elbow `static_holding_level`의 BK 분기 오류 정정(BK2105/BK2106 → **BK2101/BK2106**, UI 소스로 재확인), (3) 다중선택 필드 전부(`exposureType`/`bk2105·bk2106PressureSource`/`bk2103VibrationToolType`, elbow+wrist)를 원본 값→완전한 목표 키 대응표로 확정(더 이상 `<옵션>` 없음), (4) wrist `bk2103FrequentHighForceGrip` 대소문자 오타 정정, (5) 모든 소스 링크를 저장소 루트 기준 상대경로로 수정.

**3차 개정 대비 변경**: elbow/wrist `bk2101*` 5개 필드의 목표 키 와일드카드(`bk2101*`)를 `bk2101CycleSeconds`/`bk2101RepetitionPerHour`/`bk2101Monotony`/`bk2101ForcedDorsalExtension`/`bk2101Prosupination` 완전한 키 5행으로 확정. **4차 개정으로 Slice -1 산출물 확정 — Slice 0(catalog.test.ts 누적 검증 재작성) 착수 가능.**

**5차 개정(grain 단순화 + 공통변수 브로드캐스트, PR0-B4 개정) — 아래 §5/§6/§7과 §4의 task/vibration_interval 행, §0/§1의 해당 grain 행은 이 개정으로 소스코드까지 완전 삭제됐다. 이 문서는 삭제 전 상태를 그대로 남겨 감사 이력으로 보존하고(재작성하지 않음), 실제 최종 카탈로그 상태는 `packages/analytics-core/coverage/pr0B4FieldMapping.ts`가 정본이다.** 변경 요지만 기록:
- 최종 grain 4개: `person`/`case`/`job`/`disease`(구 `diagnosis_side`, "상병×측" 단위 — rename만, side-explode 로직 불변). `job_diagnosis`(elbow+wrist, §6/§7 전체)·`task`(spine, §4의 task 2행)·`cervical_task`(§5 전체)·`vibration_interval`(spine, §4의 vibrationIntervals 행) = **108개 변수 완전 삭제**.
- `person` grain 활성화: §1의 `gender`/`heightCm`/`weightKg`/`birthDate`/`highBloodPressure`/`diabetes` 6개가 `case`→`person`으로 재배치.
- 신규: `patient.identity.bmi`(person, `shared.height`+`shared.weight` 파생).
- 삭제(case grain 잔존분): `spine.case.evalMethod`/`careerYears`/`careerMonths`(§4).
- 공통변수 브로드캐스트: person/case(+서버 전용 meta 2종)의 브로드캐스트 안전 변수(`sensitivity!=='quasi_identifier' && type!=='high_cardinality'`)는 job/disease grain에서도 선택·필터 가능. 상세는 계획 파일(`C:\Users\skirc\.claude\plans\project-stats-workbench-md-project-pr0-b-jazzy-hickey.md`) 참고.

**6차 개정(person grain 재삭제, PR0-B4 후속)** — 위 5차 개정에서 활성화한 `person` grain은 case와 행 구성·계산 결과가 완전히 같아 실익이 없다고 판단해 다시 삭제했다. §1의 `gender`/`heightCm`/`weightKg`/`birthDate`/`highBloodPressure`/`diabetes`/`bmi` 7개는 삭제하지 않고 `case`로 환원했다(변수 자체는 유효, grain 소속만 원상복구). 최종 grain 3개: `case`/`job`/`disease`. 공통변수 브로드캐스트는 case→job/disease 단방향으로 유지된다. 상세는 같은 계획 파일 참고.

범위 결정 값: **기존유지**(이미 독립 카탈로그 변수 있음) / **신규등록**(이번 PR 대상) / **제외**(대상 아님) / **보류**(착수 시 재확인).

## 0. 기존 카탈로그 21개 — 전부 기존유지, 완료=예 (신규 등록 대상 아님)

analytics-core `getFullVariableCatalog()`가 실제로 반환하는 21개 전부. 서버 전용 `SNAPSHOT_COLUMN_VARIABLES` 2종(담당의·등록일)은 payload가 아니라 DB 컬럼이라 이 표(원본이 payload 필드인 것)의 대상이 아니므로 별도 각주로만 남긴다.

| key | grain | 원천 raw 필드(대표) | 상태 |
|---|---|---|---|
| `knee.relatedness.max` | case | `shared.birthDate`/`injuryDate`, `modules.knee.jobExtras[]` 등 | 완료 |
| `knee.diagnosisSide.klGrade` | disease(구 diagnosis_side) | `shared.diagnoses[].klgRight`/`klgLeft` | 완료 |
| `knee.diagnosisSide.confirmedStatus` | disease(구 diagnosis_side) | `shared.diagnoses[].confirmedRight`/`confirmedLeft` | 완료 |
| `knee.diagnosisSide.appliedConfirmedMismatch` | disease(구 diagnosis_side) | `shared.diagnoses[].confirmedCode`/`confirmedName` | 완료 |
| `shoulder.exposure.anyExceeded` | case | `modules.shoulder.jobExtras[].*` 6종 | 완료 |
| `shoulder.diagnosisSide.ellmanClass` | disease(구 diagnosis_side) | `shared.diagnoses[].ellmanRight`/`ellmanLeft` | 완료 |
| `elbow.assessment.burdenGradeMax` | case | diagnosisSummaries 파이프라인 | 완료 |
| `wrist.assessment.burdenGradeMax` | case | diagnosisSummaries 파이프라인 | 완료 |
| `cervical.case.maxJobCumulativeKgHours` | case | `modules.cervical.tasks[]` 집계 | 완료 |
| `spine.mddm.lifetimeDoseMNh` | case | `modules.spine.tasks[]`/career* 등 | 완료 |
| `spine.vibration.dvMax` | case | `modules.spine.vibrationIntervals[]` 등 | 완료 |
| ~~`spine.vibration.intervalA8Max`~~ | ~~vibration_interval~~ | **5차 개정 — vibration_interval grain 삭제로 이 변수도 소스코드까지 삭제됨** | — |
| ~~`spine.vibration.intervalExposureHours`~~ | ~~vibration_interval~~ | **5차 개정 — 동일** | — |
| `spine.diagnosis.verticalDistribution` | case | `shared.diagnoses[].verticalDistribution` | 완료 |
| `spine.diagnosis.concomitantSpondylosis` | case | `shared.diagnoses[].concomitantSpondylosis` | 완료 |
| ~~`spine.task.weightKg`~~ | ~~task~~ | **5차 개정 — task grain 삭제로 이 변수도 소스코드까지 삭제됨** | — |
| ~~`spine.task.frequencyPerDay`~~ | ~~task~~ | **5차 개정 — 동일** | — |
| `job.identity.jobNameNormalized` | job | `shared.jobs[].jobName` | 완료 |
| `job.identity.tenureYears` | job | `shared.jobs[].startDate`/`endDate`/`workPeriodOverride` | 완료 |
| `job.rollup.longestTenureJobNameNormalized` | case | 위 job 필드들의 roll-up | 완료 |
| `diagnosis.identity.moduleGroup` | disease(구 diagnosis_side) | `shared.diagnoses[].id`/`code`/`name`/`moduleId`(파생 그룹만 반환, 원본 필드 자체는 미노출 — 아래 §1의 별도 행 참고) | 완료 |
| `patient.identity.bmi` | person(5차 개정 신규) | `shared.height`/`weight` 파생 | 완료 |

서버 전용(참고, 이 표의 "원본 payload 필드" 범위 밖): `case.staff.assignedDoctorUserId`(categorical, analyzable), `case.meta.registeredAt`(date, filter_only).

## 1. shared

| 원본 필드 | 목표 카탈로그 키 | 범위결정 | 사유/비고 | grain | analysisRole | 슬라이스 | 완료 |
|---|---|---|---|---|---|---|---|
| `activeModules` | — | 제외 | 구조적 게이트, 변수 아님 | — | — | — | 아니오 |
| `patientNo`/`name`/`hospitalName`/`department`/`doctorName`/`medicalRecord`/`visitHistory`/`consultReply*`/`specialNotes` | — | 제외 | 자유 서술 텍스트 | — | — | — | 아니오 |
| `gender` | `patient.identity.gender` | 신규등록 | knee.relatedness.max dependsOn에만 흡수. **5차 개정 — grain을 case→person으로 재배치** | person(`patient` 신설) | analyzable | 5 | 예 |
| `height` | `patient.identity.heightCm` | 신규등록 | DEFERRED였음. 5차 개정 — case→person | person | analyzable | 5 | 예 |
| `weight` | `patient.identity.weightKg` | 신규등록 | DEFERRED였음. 5차 개정 — case→person | person | analyzable | 5 | 예 |
| `height`+`weight` | `patient.identity.bmi` | 신규등록(5차 개정) | 키/몸무게 파생 BMI | person | analyzable | 5차 개정 | 예 |
| `birthDate` | `patient.identity.birthDate` | 신규등록 | 날짜 정책. grain은 case 그대로(§확정 전제 — filter_only 변수는 재배치 대상 아님) | case | **filter_only** | 5 | 예 |
| `injuryDate` | `patient.identity.injuryDate` | 신규등록 | 날짜 정책 | case | **filter_only** | 5 | 예 |
| `evaluationDate` | `patient.identity.evaluationDate` | 신규등록 | DEFERRED였음, 날짜 정책 | case | **filter_only** | 5 | 예 |
| `highBloodPressure` | `patient.identity.highBloodPressure` | 신규등록 | DEFERRED였음. 5차 개정 — case→person | person | analyzable | 5 | 예 |
| `diabetes` | `patient.identity.diabetes` | 신규등록 | DEFERRED였음. 5차 개정 — case→person | person | analyzable | 5 | 예 |
| `diagnoses`/`jobs`/`videoAnalysis`(컨테이너), `reportOptions`, `videoAnalysis.*` | — | 제외 | 컨테이너/UI전용/영상분석 범위 밖 | — | — | — | 아니오 |
| `diagnoses[].id` | — | **제외**(1차 개정에서 정정) | disease grain(구 diagnosis_side) 엔터티 키 구성요소 — job.id·job_diagnosis의 diagnosisId와 동일 기준으로 통일 | — | — | — | 아니오 |
| `diagnoses[].code` | `diagnosis.identity.code` | 신규등록 | `moduleGroup`은 파생 그룹만 반환, 원본 코드 자체는 미노출 | disease(구 diagnosis_side) | analyzable(high_cardinality) | 6 | 예 |
| `diagnoses[].name` | `diagnosis.identity.name` | 신규등록 | 동일 | disease(구 diagnosis_side) | analyzable(high_cardinality) | 6 | 예 |
| `diagnoses[].moduleId` | — | 보류 | raw moduleId 자체의 노출 가치는 `moduleGroup`(이미 해석된 값) 대비 낮음 — Slice 6 최종 결정 | disease(구 diagnosis_side) | — | 6 | 아니오 |
| `diagnoses[].side` | — | 보류 | 현재 엔터티 키 구성에만 소비 — 독립 노출 여부 Slice 6 재검토 | disease(구 diagnosis_side) | — | 6 | 아니오 |
| `diagnoses[].confirmedCode` | `diagnosis.identity.confirmedCode` | 보류 | `appliedConfirmedMismatch`는 boolean만 반환 — Slice 6 결정 | disease(구 diagnosis_side) | analyzable(high_cardinality) | 6 | 아니오 |
| `diagnoses[].confirmedName` | `diagnosis.identity.confirmedName` | 보류 | 동일 | disease(구 diagnosis_side) | analyzable(high_cardinality) | 6 | 아니오 |
| `diagnoses[].klgRight`/`klgLeft` | `knee.diagnosisSide.klGrade` | **기존유지** | §0 참고 | — | — | — | 예 |
| `diagnoses[].ellmanRight`/`ellmanLeft` | `shoulder.diagnosisSide.ellmanClass` | **기존유지** | §0 참고 | — | — | — | 예 |
| `diagnoses[].confirmedRight`/`confirmedLeft` | `knee.diagnosisSide.confirmedStatus` | **기존유지** | §0 참고 | — | — | — | 예 |
| `diagnoses[].assessmentRight`/`assessmentLeft` | `diagnosis.assessment.status` | 신규등록 | DEFERRED였음. 값 도메인: `''`/`'high'`/`'low'`(select, [AssessmentTab.jsx:42](../../../src/core/components/AssessmentTab.jsx#L42)) — `''`는 `not_entered`, 그 외 2값을 categorical/boolean으로 | disease(구 diagnosis_side) | analyzable | 6 | 예 |
| `diagnoses[].reasonRight`/`reasonLeft` | `diagnosis.assessment.lowReason.<옵션>`(옵션 7개, 아래 표) | **신규등록(1차 개정에서 다중선택으로 재분류)** | 체크박스 배열(`AssessmentTab.jsx:53`), 단일값 아님 | disease(구 diagnosis_side) | analyzable(boolean, 옵션별) | 6 | 예 |
| `diagnoses[].reasonRightOther`/`reasonLeftOther` | — | 제외 | 자유 서술(`other` 선택 시 부가 텍스트) | — | — | — | 아니오 |
| `diagnoses[].verticalDistribution`/`concomitantSpondylosis` | `spine.diagnosis.*` | **기존유지** | §0 참고 | — | — | — | 예 |
| `jobs[].id` | — | 제외 | job grain 엔터티 키 | — | — | — | 아니오 |
| `jobs[].jobName` | `job.identity.jobNameNormalized` | **기존유지** | §0 참고 | — | — | — | 예 |
| `jobs[].presetId` | — | 제외 | 기술 ID/FK | — | — | — | 아니오 |
| `jobs[].startDate` | `job.raw.startDate` | 신규등록 | `tenureYears` 계산에만 흡수, 날짜 정책 | job | **filter_only** | 2 | 예 |
| `jobs[].endDate` | `job.raw.endDate` | 신규등록 | 동일 | job | **filter_only** | 2 | 예 |
| `jobs[].workPeriodOverride` | `job.raw.workPeriodOverride` | 보류 | 자유 서술형 기간 문자열("3년" 등) — Slice 2 최종 결정 | job | 보류 | 2 | 아니오 |
| `jobs[].workDaysPerYear` | `job.raw.workDaysPerYear` | 신규등록 | spine/shoulder/cervical dependsOn에만 흡수, job 자체 변수로는 미노출 | job | analyzable | 2 | 예 |

### `diagnosis.assessment.lowReason` 옵션 (출처 [`knee/utils/data.js:70-78`](../../../src/modules/knee/utils/data.js#L70-L78), shoulder도 동일 정의)

| 원본 값 | 목표 키 |
|---|---|
| `unrelated` | `diagnosis.assessment.lowReason.unrelated` |
| `unconfirmed` | `diagnosis.assessment.lowReason.unconfirmed` |
| `ageMild` | `diagnosis.assessment.lowReason.ageMild` |
| `delayed` | `diagnosis.assessment.lowReason.delayed` |
| `lowBurden` | `diagnosis.assessment.lowReason.lowBurden` |
| `belowThreshold` | `diagnosis.assessment.lowReason.belowThreshold` |
| `other` | `diagnosis.assessment.lowReason.other` |

**적용 조건(구조적 결측)**: `assessmentRight`/`assessmentLeft !== 'low'`이면 이 side의 7개 옵션 전부 `missing: 'not_applicable'`(입력폼 자체가 안 보임, [AssessmentTab.jsx:49](../../../src/core/components/AssessmentTab.jsx#L49)의 `{diag[assessmentKey] === 'low' && (...)}`). **`assessment`가 `'low'`에서 다른 값으로 바뀌어도 `reasonRight`/`reasonLeft` 배열 자체는 코드가 지우지 않으므로(폼이 숨겨질 뿐) 과거 값이 그대로 남아있을 수 있다** — extractor는 `assessment !== 'low'`이면 `reasonRight`/`reasonLeft`의 실제 배열 내용과 무관하게 무조건 `not_applicable`을 반환해야 한다(배열에 남은 값을 그대로 집계하면 이미 사유가 사라진 판정을 낮음-사유로 잘못 세는 결함이 생김).

## 2. knee

| 원본 필드 | 목표 카탈로그 키 | 범위결정 | 사유/비고 | grain | analysisRole | 슬라이스 | 완료 |
|---|---|---|---|---|---|---|---|
| `returnConsiderations` | — | 제외 | 자유 서술 | — | — | — | 아니오 |
| `jobs[]`(레거시 배열) | — | 제외 | BatchImportModal 마이그레이션 전까지의 구형식, 폐기 예정 | — | — | — | 아니오 |
| `jobExtras[].sharedJobId` | — | 제외 | job grain 엔터티 키 | — | — | — | 아니오 |
| `jobExtras[].squatting` | `knee.job.squattingMinutesPerDay` | 신규등록 | **1차 개정 — 단위 정정**: "쪼그려앉기 (분/일)"([JobTab.jsx:46](../../../src/modules/knee/components/JobTab.jsx#L46)), 시간이 아니라 분 단위 입력값 그대로 저장(변환 없음) | job(moduleId knee) | analyzable | 4 | 예 |
| `jobExtras[].weight` | `knee.job.dailyLoadKg` | 신규등록 | **1차 개정 — 명명 정정**: "중량물 (kg/일)"([JobTab.jsx:47](../../../src/modules/knee/components/JobTab.jsx#L47)) — 1회 중량이 아니라 일일 누적 중량물, 단순 `weightKg`로 명명하면 오독 위험 | job(moduleId knee) | analyzable | 4 | 예 |
| `jobExtras[].evidenceSources` | — | 제외 | 근거 출처 인용 태그 | — | — | — | 아니오 |
| `jobExtras[].stairs`/`kneeTwist`/`startStop`/`tightSpace`/`kneeContact`/`jumpDown` | `knee.job.stairs`/`kneeTwist`/`startStop`/`tightSpace`/`kneeContact`/`jumpDown` | 신규등록 | DEFERRED였음, 전부 체크박스(boolean 확정, [JobTab.jsx:50-52](../../../src/modules/knee/components/JobTab.jsx#L50-L52)) | job(moduleId knee) | analyzable(boolean) | 4 | 예 |

## 3. shoulder

| 원본 필드 | 목표 카탈로그 키 | 범위결정 | 사유/비고 | grain | analysisRole | 슬라이스 | 완료 |
|---|---|---|---|---|---|---|---|
| `returnConsiderations` | — | 제외 | 자유 서술 | — | — | — | 아니오 |
| `jobExtras[].sharedJobId` | — | 제외 | job grain 엔터티 키 | — | — | — | 아니오 |
| `jobExtras[].overheadHours` | `shoulder.job.overheadHours` | 신규등록 | `anyExceeded`(boolean)에만 흡수 | job(moduleId shoulder) | analyzable | 3 | 예 |
| `jobExtras[].repetitiveMediumHours` | `shoulder.job.repetitiveMediumHours` | 신규등록 | 동일 | job | analyzable | 3 | 예 |
| `jobExtras[].repetitiveFastHours` | `shoulder.job.repetitiveFastHours` | 신규등록 | 동일 | job | analyzable | 3 | 예 |
| `jobExtras[].heavyLoadCount` | `shoulder.job.heavyLoadCount` | 신규등록 | 동일 | job | analyzable | 3 | 예 |
| `jobExtras[].heavyLoadSeconds` | `shoulder.job.heavyLoadSeconds` | 신규등록 | 동일 | job | analyzable | 3 | 예 |
| `jobExtras[].vibrationHours` | `shoulder.job.vibrationHours` | 신규등록 | 동일 | job | analyzable | 3 | 예 |
| `jobExtras[].evidenceSources` | — | 제외 | 근거 출처 태그 | — | — | — | 아니오 |

## 4. spine

| 원본 필드 | 목표 카탈로그 키 | 범위결정 | 사유/비고 | grain | analysisRole | 슬라이스 | 완료 |
|---|---|---|---|---|---|---|---|
| `mddmStatus` | `spine.case.mddmStatus` | 신규등록 | `lifetimeDoseMNh` dependsOn에만 흡수 | case | analyzable | 1 | 예 |
| `vibrationExposureStatus` | `spine.case.vibrationExposureStatus` | 신규등록 | `dvMax` dependsOn에만 흡수 | case | analyzable | 1 | 예 |
| `activeSpineTab` | — | 제외 | UI 전용, "계산 분기 아님" 코드 명시 | — | — | — | 아니오 |
| `aiAnalysisResult` | — | 제외 | 계산 결과 캐시 | — | — | — | 아니오 |
| `formulaVersion` | `spine.case.formulaVersion` | 신규등록 | 공식 버전 문자열 | case | filter_only | 1 | 예 |
| `returnConsiderations` | — | 제외 | 자유 서술 | — | — | — | 아니오 |
| ~~`evalMethod`~~ | ~~`spine.case.evalMethod`~~ | ~~신규등록~~ | **5차 개정 — 삭제 대상으로 사용자가 직접 지정, 소스코드까지 삭제됨** | — | — | 1 | — |
| ~~`careerYears`/`careerMonths`~~ | ~~`spine.case.careerYears`/`careerMonths`~~ | ~~신규등록~~ | **5차 개정 — 동일(구형식 레거시 호환 필드, 삭제 대상으로 지정됨)** | — | — | 1 | — |
| `workDaysPerYear`(spine 자체) | `spine.case.workDaysPerYear` | 신규등록 | 레거시 호환 필드, 존재 자체가 계산 분기에 영향 — **5차 개정에서도 존치**(삭제 대상은 evalMethod/careerYears/careerMonths 3개뿐) | case | analyzable | 1 | 예 |
| `jobName`(spine 단일 필드, 레거시) | `spine.case.legacyJobName` | 보류 | `unsupported_legacy_spine_jobs` 판정용 — 노출 가치 낮음, Slice 1 최종 결정 | case | 보류 | 1 | 아니오 |
| ~~`tasks[].id`/`sharedJobId`/`name`/`posture`/`timeValue`/`timeUnit`/`correctionFactor`/`force`~~ | ~~task grain 전체~~ | — | **5차 개정 — task grain 소스코드까지 완전 삭제(§0 참고: weightKg/frequencyPerDay도 함께 삭제)** | — | — | 1 | — |
| ~~`vibrationIntervals[].id`/`sharedJobId`/`name`/`awMin`/`awMax`/`timeValue`/`timeUnit`~~ | ~~vibration_interval grain 전체~~ | — | **5차 개정 — vibration_interval grain 소스코드까지 완전 삭제(§0 참고: intervalA8Max/intervalExposureHours도 함께 삭제, dvMax는 case grain이라 존치)** | — | — | 1 | — |

## 5. cervical (`cervical_task` grain — **5차 개정에서 소스코드까지 완전 삭제됨**, 아래는 삭제 전 감사 이력)

**구조적 결측 규칙**(§다중선택 계약과 별개, 조건부 필드 게이팅): `forced_neck_posture`/`load_weight_kg`/`carry_hours_per_shift`는 `exposure_types`에 `'shoulder_heavy_load'`가 없으면 `not_applicable`(폼 자체가 안 보임, [TaskEditor.jsx:95](../../../src/modules/cervical/components/TaskEditor.jsx#L95)). `neck_nonneutral_hours_per_day`/`combined_flexion_rotation_posture`/`precision_work`는 `'awkward_static_neck_load'`가 없으면 `not_applicable`([TaskEditor.jsx:127](../../../src/modules/cervical/components/TaskEditor.jsx#L127)). `forced_neck_posture`/`combined_flexion_rotation_posture`/`precision_work`는 `'yes'`/`'no'`/`''` 문자열(boolean 아님, `YesNoField` 컴포넌트) — `''`→해당 게이트가 열려 있는데도 미입력이면 `not_entered`, 게이트 자체가 닫혀있으면 `not_applicable`, `'yes'`/`'no'`→boolean 변환.

| 원본 필드 | 목표 카탈로그 키 | 범위결정 | 사유/비고 | grain | analysisRole | 슬라이스 | 완료 |
|---|---|---|---|---|---|---|---|
| `returnConsiderations` | — | 제외 | 자유 서술 | — | — | — | 아니오 |
| `tasks[].id` | — | 제외 | coverage 명시 기술 ID | — | — | — | 아니오 |
| `tasks[].sharedJobId` | — | 제외 | cervical_task grain 엔터티 키(job) | — | — | — | 아니오 |
| `tasks[].name` | `cervical.task.name` | 신규등록 | `maxJobCumulativeKgHours`에만 흡수 | cervical_task | analyzable(high_cardinality 추정) | 7 | 예 |
| `tasks[].exposure_types` | `cervical.task.exposureType.shoulderHeavyLoad` / `.awkwardStaticNeckLoad` | 신규등록 | 다중선택, **옵션 2개뿐**(출처 [`cervical/utils/data.js:4-7`](../../../src/modules/cervical/utils/data.js#L4-L7): `shoulder_heavy_load`, `awkward_static_neck_load`) | cervical_task | analyzable(boolean ×2) | 7 | 예 |
| `tasks[].load_weight_kg` | `cervical.task.loadWeightKg` | 신규등록 | 게이트: exposure_types에 shoulder_heavy_load 포함 시만 | cervical_task | analyzable | 7 | 예 |
| `tasks[].carry_hours_per_shift` | `cervical.task.carryHoursPerShift` | 신규등록 | 동일 게이트 | cervical_task | analyzable | 7 | 예 |
| `tasks[].forced_neck_posture` | `cervical.task.forcedNeckPosture` | 신규등록 | 동일 게이트, `'yes'/'no'/''` → boolean 변환(위 규칙) | cervical_task | analyzable(boolean) | 7 | 예 |
| `tasks[].neck_nonneutral_hours_per_day` | `cervical.task.neckNonneutralHoursPerDay` | 신규등록 | 게이트: awkward_static_neck_load 포함 시만 | cervical_task | analyzable | 7 | 예 |
| `tasks[].combined_flexion_rotation_posture` | `cervical.task.combinedFlexionRotationPosture` | 신규등록 | 동일 게이트, boolean 변환 | cervical_task | analyzable(boolean) | 7 | 예 |
| `tasks[].precision_work` | `cervical.task.precisionWork` | 신규등록 | 동일 게이트, boolean 변환 | cervical_task | analyzable(boolean) | 7 | 예 |
| `tasks[].notes` | — | 제외 | 자유 서술 | — | — | — | 아니오 |

## 6. elbow (`job_diagnosis` grain — **5차 개정에서 소스코드까지 완전 삭제됨**, temporal 4개(case grain)만 존치, 아래는 삭제 전 감사 이력)

**구조적 결측 규칙(elbow 전체에 적용, §job_diagnosis 계약과 별개의 필드-레벨 게이팅)**:
- `direct_anatomic_link !== 'yes'`이면 `main_task_name`부터 모든 BK-공통·BK-분기 필드까지 전부 `not_applicable`([ExposureForm.jsx:132](../../../src/modules/elbow/components/ExposureForm.jsx#L132) `shouldShowExposureFields`).
- `exposure_types`에 `repetition`/`force`/`awkward_posture`가 없으면 그에 대응하는 `repetition_level`/`force_level`/`awkward_posture_level`은 `not_applicable`([ExposureForm.jsx:275](../../../src/modules/elbow/components/ExposureForm.jsx#L275) `EXPOSURE_DETAIL_CONFIG`).
- `direct_pressure_level`이 없거나 `'none'`이면 `bk2105_pressure_source`/`bk2106_pressure_source`는 `not_applicable`([DiseaseSpecificFields.jsx:65,67](../../../src/modules/elbow/components/DiseaseSpecificFields.jsx#L65)).
- `vibration_exposure !== 'present'`이면 `bk2103_vibration_tool_type`/`bk2103_daily_vibration_hours`는 `not_applicable`([DiseaseSpecificFields.jsx:66](../../../src/modules/elbow/components/DiseaseSpecificFields.jsx#L66)).
- BK 분기 필드(`bk2101_*`/`bk2105_*`/`bk2106_*`/`bk2103_*`)는 `selectedBkType`이 해당 유형이 아니면 `not_applicable`.

temporal 4개는 병합 결과(`temporalSequence ?? temporalRelation`) 기준 **case grain** 변수 4개로만 등록. 나머지는 `jobEvaluations[].diagnosisEntries[]`(신규)와 `diagnosisEvaluations[]`(레거시)가 병합돼 **하나의 job_diagnosis 변수**가 된다.

| 원본 필드 | 목표 카탈로그 키 | 범위결정 | 사유/비고 | grain | analysisRole | 슬라이스 | 완료 |
|---|---|---|---|---|---|---|---|
| `returnConsiderations` | — | 제외 | 자유 서술 | — | — | — | 아니오 |
| `temporalSequence`/`temporalRelation`.`recent_task_change` | `elbow.temporal.recentTaskChange` | 신규등록 | | case | analyzable | 8a | 예 |
| `...task_change_date` | `elbow.temporal.taskChangeDate` | 신규등록 | 날짜 정책 | case | **filter_only** | 8a | 예 |
| `...symptom_onset_interval` | `elbow.temporal.symptomOnsetInterval` | 신규등록 | | case | analyzable | 8a | 예 |
| `...improves_with_rest` | `elbow.temporal.improvesWithRest` | 신규등록 | | case | analyzable | 8a | 예 |
| `jobEvaluations[].sharedJobId` / `diagnosisEvaluations[].linkedJobId` | — | 제외 | job_diagnosis 엔터티 키(job) 구성요소 | — | — | — | 아니오 |
| `_pendingPreset` | — | 제외 | 저장 직전 제거되는 임시 상태 | — | — | — | 아니오 |
| `diagnosisEntries[].bkAutoSyncedFrom` | — | 제외 | provenance 내부용(`inferred_link` 플래그 생성에만 소비) | — | — | — | 아니오 |
| `diagnosisId` | — | 제외 | job_diagnosis 엔터티 키(diagnosis) 구성요소 — shared.diagnoses[].id와 동일 기준 | — | — | — | 아니오 |
| `selectedBkType` | `elbow.jobDiagnosis.selectedBkType` | 신규등록 | 값 도메인: `''`/`BK2101`/`BK2103`/`BK2105`/`BK2106`([BK_TYPE_OPTIONS](../../../src/modules/elbow/utils/data.js#L4-L10)) | job_diagnosis | analyzable(categorical) | 8b | 예 |
| `bkSelectionMode` | `elbow.jobDiagnosis.bkSelectionMode` | 보류 | `auto`/`manual` 내부 플래그, 노출 가치 Slice 8b에서 최종 결정 | job_diagnosis | 보류 | 8b | 아니오 |
| `main_task_name` | `elbow.jobDiagnosis.mainTaskName` | 신규등록 | job.identity.jobNameNormalized 선례 재사용(정규화+quasi_identifier). 게이트: direct_anatomic_link | job_diagnosis | analyzable(high_cardinality) | 8b | 예 |
| `direct_anatomic_link` | `elbow.jobDiagnosis.directAnatomicLink` | 신규등록 | 값 도메인: `''`/`yes`/`no`([DIRECT_LINK_OPTIONS](../../../src/modules/elbow/components/ExposureForm.jsx#L13-L16)) — 다른 필드의 게이트 자체 | job_diagnosis | analyzable(boolean) | 8b | 예 |
| `exposure_types` | `elbow.jobDiagnosis.exposureType.repetition`/`.force`/`.awkwardPosture` | 신규등록 | 다중선택, **옵션 3개**([EXPOSURE_TYPE_OPTIONS](../../../src/modules/elbow/utils/data.js#L16-L20): `repetition`/`force`/`awkward_posture`). 게이트: direct_anatomic_link | job_diagnosis | analyzable(boolean ×3) | 8b | 예 |
| `repetition_level` | `elbow.jobDiagnosis.repetitionLevel` | 신규등록 | 값 도메인: `''`/`occasional`/`frequent`([COMMON_FREQUENCY_OPTIONS](../../../src/modules/elbow/components/ExposureForm.jsx#L36-L39)). 게이트: exposure_types에 repetition 포함 | job_diagnosis | analyzable(ordinal, 2단계) | 8b | 예 |
| `force_level` | `elbow.jobDiagnosis.forceLevel` | 신규등록 | 값 도메인: `''`/`mild`/`moderate`/`high`([COMMON_FORCE_OPTIONS](../../../src/modules/elbow/components/ExposureForm.jsx#L30-L34)). 게이트: exposure_types에 force 포함 | job_diagnosis | analyzable(ordinal, 3단계) | 8b | 예 |
| `awkward_posture_level` | `elbow.jobDiagnosis.awkwardPostureLevel` | 신규등록 | 값 도메인: COMMON_FREQUENCY_OPTIONS(위와 동일). 게이트: exposure_types에 awkward_posture 포함 | job_diagnosis | analyzable(ordinal, 2단계) | 8b | 예 |
| `work_pattern` | `elbow.jobDiagnosis.workPattern` | 신규등록 | 값 도메인: `''`/`continuous`/`intermittent`/`mixed`([WORK_PATTERN_OPTIONS](../../../src/modules/elbow/components/ExposureForm.jsx#L18-L22)). 게이트: direct_anatomic_link | job_diagnosis | analyzable(categorical) | 8b | 예 |
| `rest_distribution` | `elbow.jobDiagnosis.restDistribution` | 신규등록 | 값 도메인: `''`/`adequate`/`moderate`/`insufficient`([REST_OPTIONS](../../../src/modules/elbow/components/ExposureForm.jsx#L24-L28)). 게이트: direct_anatomic_link | job_diagnosis | analyzable(ordinal, 3단계) | 8b | 예 |
| `daily_exposure_hours` | `elbow.jobDiagnosis.dailyExposureHours` | 신규등록 | 1차 조사 누락분. 게이트: direct_anatomic_link | job_diagnosis | analyzable | 8b | 예 |
| `shift_share_percent` | `elbow.jobDiagnosis.shiftSharePercent` | 신규등록 | 1차 조사 누락분 | job_diagnosis | analyzable | 8b | 예 |
| `days_per_week` | `elbow.jobDiagnosis.daysPerWeek` | 신규등록 | 1차 조사 누락분(0~7, 0.5 단위, [ExposureForm.jsx:257](../../../src/modules/elbow/components/ExposureForm.jsx#L257)) | job_diagnosis | analyzable | 8b | 예 |
| `static_holding_level` | `elbow.jobDiagnosis.staticHoldingLevel` | 신규등록 | **정정 — BK2101/BK2106 분기 전용**(BK2105엔 없음. BK2101: [DiseaseSpecificFields.jsx:108-116](../../../src/modules/elbow/components/DiseaseSpecificFields.jsx#L108-L116), BK2106: [:246-254](../../../src/modules/elbow/components/DiseaseSpecificFields.jsx#L246-L254)), FREQUENCY_OPTIONS(ordinal). `selectedBkType`이 BK2101/BK2106이 아니면 not_applicable | job_diagnosis | analyzable(ordinal) | 8c | 예 |
| `direct_pressure_level` | `elbow.jobDiagnosis.directPressureLevel` | 신규등록 | BK2105/BK2106 분기 전용(BK2105: [DiseaseSpecificFields.jsx:196-204](../../../src/modules/elbow/components/DiseaseSpecificFields.jsx#L196-L204), BK2106: [:229-237](../../../src/modules/elbow/components/DiseaseSpecificFields.jsx#L229-L237)), FREQUENCY_OPTIONS(ordinal), `bk2105/2106_pressure_source`의 게이트 자체 | job_diagnosis | analyzable(ordinal) | 8c | 예 |
| `vibration_exposure` | `elbow.jobDiagnosis.vibrationExposure` | 신규등록 | BK2103 분기 전용([DiseaseSpecificFields.jsx:147](../../../src/modules/elbow/components/DiseaseSpecificFields.jsx#L147)), `present` 여부가 bk2103 세부항목의 게이트 | job_diagnosis | analyzable | 8c | 예 |
| `bk2101_cycle_seconds` | `elbow.jobDiagnosis.bk2101CycleSeconds` | 신규등록 | `selectedBkType!=='BK2101'`이면 not_applicable | job_diagnosis | analyzable | 8c | 예 |
| `bk2101_repetition_per_hour` | `elbow.jobDiagnosis.bk2101RepetitionPerHour` | 신규등록 | 동일 게이트 | job_diagnosis | analyzable | 8c | 예 |
| `bk2101_monotony` | `elbow.jobDiagnosis.bk2101Monotony` | 신규등록 | 동일 게이트 | job_diagnosis | analyzable | 8c | 예 |
| `bk2101_forced_dorsal_extension` | `elbow.jobDiagnosis.bk2101ForcedDorsalExtension` | 신규등록 | 동일 게이트 | job_diagnosis | analyzable | 8c | 예 |
| `bk2101_prosupination` | `elbow.jobDiagnosis.bk2101Prosupination` | 신규등록 | 동일 게이트 | job_diagnosis | analyzable | 8c | 예 |
| `bk2105_elbow_leaning` | `elbow.jobDiagnosis.bk2105ElbowLeaning` | 신규등록 | `selectedBkType!=='BK2105'`이면 not_applicable | job_diagnosis | analyzable | 8c | 예 |
| `bk2105_repeated_friction_impact` | — | **제외** | LABEL_ONLY_UNUSED(계산 미사용, grep 확인됨) | — | — | — | 아니오 |
| `bk2105_pressure_source` | `elbow.jobDiagnosis.bk2105PressureSource.<옵션>`(5개, 아래 표) | 신규등록 | 다중선택, 게이트: direct_pressure_level | job_diagnosis | analyzable(boolean ×5) | 8c | 예 |
| `bk2106_repeated_mechanical_exposure`/`noncorrectable_posture`/`prolonged_joint_position` | — | **제외**(3개) | LABEL_ONLY_UNUSED | — | — | — | 아니오 |
| `bk2106_pressure_source` | `elbow.jobDiagnosis.bk2106PressureSource.<옵션>`(5개, elbow와 동일 옵션 세트) | 신규등록 | 다중선택, `selectedBkType!=='BK2106'`이면 not_applicable | job_diagnosis | analyzable(boolean ×5) | 8c | 예 |
| `bk2103_vibration_tool_type` | `elbow.jobDiagnosis.bk2103VibrationToolType.<옵션>`(13개, 아래 표) | 신규등록 | 다중선택, 게이트: vibration_exposure==='present' | job_diagnosis | analyzable(boolean ×13) | 8c | 예 |
| `bk2103_daily_vibration_hours` | `elbow.jobDiagnosis.bk2103DailyVibrationHours` | 신규등록 | 동일 게이트 | job_diagnosis | analyzable | 8c | 예 |
| `bk2103_handheld_or_guided` | — | **제외** | LABEL_ONLY_UNUSED | — | — | — | 아니오 |
| `bk2103_tool_pressing` | `elbow.jobDiagnosis.bk2103ToolPressing` | 신규등록 | `selectedBkType!=='BK2103'`이면 not_applicable | job_diagnosis | analyzable | 8c | 예 |
| `bk2103_frequent_high_force_grip` | `elbow.jobDiagnosis.bk2103FrequentHighForceGrip` | 신규등록 | 동일 | job_diagnosis | analyzable | 8c | 예 |
| `bk2106_tool_pressing`(레거시 유출) | `elbow.jobDiagnosis.bk2106ToolPressingLegacy` | 보류 | bk2103_tool_pressing 자동보정 소스, 레거시 전용 — 노출 가치 Slice 8c 재검토 | job_diagnosis | 보류 | 8c | 아니오 |
| `bk2106_frequent_high_force_grip`(레거시 유출) | `elbow.jobDiagnosis.bk2106FrequentHighForceGripLegacy` | 보류 | 동일 | job_diagnosis | 보류 | 8c | 아니오 |
| `diagnosisEvaluations[].bkSelectionMode` | — | 제외 | `buildLegacyEntryMap`이 무조건 재계산해 덮어씀 — 저장값이 결과에 영향 없음 | — | — | — | 아니오 |

### elbow 다중선택 옵션 → 목표 키 전체 대응표

명명 규칙: 원본 snake_case 값을 camelCase로 변환해 접미사로 붙인다(`awkward_posture`→`awkwardPosture`).

**`exposureType`**(3, [data.js:16-20](../../../src/modules/elbow/utils/data.js#L16-L20)):

| 원본 값 | 목표 키 |
|---|---|
| `repetition` | `elbow.jobDiagnosis.exposureType.repetition` |
| `force` | `elbow.jobDiagnosis.exposureType.force` |
| `awkward_posture` | `elbow.jobDiagnosis.exposureType.awkwardPosture` |

**`bk2105PressureSource`**(5, [data.js:26-32](../../../src/modules/elbow/utils/data.js#L26-L32), `selectedBkType==='BK2105'`에서만 analyzable):

| 원본 값 | 목표 키 |
|---|---|
| `hard_surface` | `elbow.jobDiagnosis.bk2105PressureSource.hardSurface` |
| `tool_edge` | `elbow.jobDiagnosis.bk2105PressureSource.toolEdge` |
| `ground_contact` | `elbow.jobDiagnosis.bk2105PressureSource.groundContact` |
| `carrying_contact` | `elbow.jobDiagnosis.bk2105PressureSource.carryingContact` |
| `other` | `elbow.jobDiagnosis.bk2105PressureSource.other` |

**`bk2106PressureSource`**(같은 5개 원본 값, `selectedBkType==='BK2106'`에서만 analyzable — bk2105와 옵션 값은 같지만 별도 필드·별도 키 namespace):

| 원본 값 | 목표 키 |
|---|---|
| `hard_surface` | `elbow.jobDiagnosis.bk2106PressureSource.hardSurface` |
| `tool_edge` | `elbow.jobDiagnosis.bk2106PressureSource.toolEdge` |
| `ground_contact` | `elbow.jobDiagnosis.bk2106PressureSource.groundContact` |
| `carrying_contact` | `elbow.jobDiagnosis.bk2106PressureSource.carryingContact` |
| `other` | `elbow.jobDiagnosis.bk2106PressureSource.other` |

**`bk2103VibrationToolType`**(13 — 공구 12종 + `other`, [data.js:38-51](../../../src/modules/elbow/utils/data.js#L38-L51)):

| 원본 값 | 목표 키 |
|---|---|
| `grinder` | `elbow.jobDiagnosis.bk2103VibrationToolType.grinder` |
| `jackhammer` | `elbow.jobDiagnosis.bk2103VibrationToolType.jackhammer` |
| `demolition_hammer` | `elbow.jobDiagnosis.bk2103VibrationToolType.demolitionHammer` |
| `chipping_hammer` | `elbow.jobDiagnosis.bk2103VibrationToolType.chippingHammer` |
| `tamping_machine` | `elbow.jobDiagnosis.bk2103VibrationToolType.tampingMachine` |
| `rotary_hammer` | `elbow.jobDiagnosis.bk2103VibrationToolType.rotaryHammer` |
| `compactor` | `elbow.jobDiagnosis.bk2103VibrationToolType.compactor` |
| `reciprocating_saw` | `elbow.jobDiagnosis.bk2103VibrationToolType.reciprocatingSaw` |
| `rivet_hammer` | `elbow.jobDiagnosis.bk2103VibrationToolType.rivetHammer` |
| `rust_hammer` | `elbow.jobDiagnosis.bk2103VibrationToolType.rustHammer` |
| `powder_actuated_tool` | `elbow.jobDiagnosis.bk2103VibrationToolType.powderActuatedTool` |
| `forging_hammer` | `elbow.jobDiagnosis.bk2103VibrationToolType.forgingHammer` |
| `other` | `elbow.jobDiagnosis.bk2103VibrationToolType.other` |

## 7. wrist (`job_diagnosis` grain — **5차 개정에서 소스코드까지 완전 삭제됨**, temporal 4개(case grain)만 존치, 아래는 삭제 전 감사 이력)

**1차 개정 정정**: elbow의 LABEL_ONLY_UNUSED 5개(`bk2105_*`/`bk2106_repeated_mechanical_exposure` 등)는 "wrist에서 계산에 쓰인다"가 아니라 **wrist 데이터 구조 자체에 그 필드들이 없다**([wrist coverage:12-41](../coverage/modules/wrist.ts#L12-L41) — `bk2105_*` 계열 자체가 wrist `DIAGNOSIS_ENTRY_FIELDS`에 없음). wrist는 elbow와 진단명만 다른 게 아니라 **BK 분기 자체가 다르다**(BK2113/BK2101/BK2103/BK2106 4종, elbow는 BK2101/2103/2105/2106 4종 — BK2105 없음, BK2113 elbow엔 없음). 압박원·진동공구 옵션값도 elbow와 다르다(아래).

구조적 결측 게이트는 elbow와 **동일하게 확인됨**(`wrist/components/ExposureForm.jsx:129,228`의 `shouldShowExposureFields = direct_anatomic_link === 'yes'`, `EXPOSURE_DETAIL_CONFIG` per-타입 게이트, `wrist/components/DiseaseSpecificFields.jsx:65-66`의 `direct_pressure_level`/`vibration_exposure==='present'` 게이트 — elbow 절의 "구조적 결측 규칙"을 wrist에도 그대로 적용).

| 원본 필드 | 목표 카탈로그 키 | 범위결정 | 사유/비고 | grain | analysisRole | 슬라이스 | 완료 |
|---|---|---|---|---|---|---|---|
| `returnConsiderations` | — | 제외 | 자유 서술 | — | — | — | 아니오 |
| `temporalSequence`/`temporalRelation`.`recent_task_change` | `wrist.temporal.recentTaskChange` | 신규등록 | | case | analyzable | 8a | 예 |
| `...task_change_date` | `wrist.temporal.taskChangeDate` | 신규등록 | 날짜 정책 | case | **filter_only** | 8a | 예 |
| `...symptom_onset_interval` | `wrist.temporal.symptomOnsetInterval` | 신규등록 | | case | analyzable | 8a | 예 |
| `...improves_with_rest` | `wrist.temporal.improvesWithRest` | 신규등록 | | case | analyzable | 8a | 예 |
| `jobEvaluations[].sharedJobId` / `diagnosisEvaluations[].linkedJobId` | — | 제외 | 엔터티 키(job) 구성요소 | — | — | — | 아니오 |
| `_pendingPreset` | — | 제외 | 저장 직전 제거 | — | — | — | 아니오 |
| `diagnosisEntries[].bkAutoSyncedFrom` | — | 제외 | provenance 내부용 | — | — | — | 아니오 |
| `diagnosisId` | — | 제외 | 엔터티 키(diagnosis) 구성요소 | — | — | — | 아니오 |
| `selectedBkType` | `wrist.jobDiagnosis.selectedBkType` | 신규등록 | 값 도메인: `''`/`BK2113`/`BK2101`/`BK2103`/`BK2106`([wrist BK_TYPE_OPTIONS](../../../src/modules/wrist/utils/data.js#L4-L10)) | job_diagnosis | analyzable(categorical) | 8b | 예 |
| `bkSelectionMode` | `wrist.jobDiagnosis.bkSelectionMode` | 보류 | elbow와 동일 사유 | job_diagnosis | 보류 | 8b | 아니오 |
| `main_task_name` | `wrist.jobDiagnosis.mainTaskName` | 신규등록 | job.identity.jobNameNormalized 선례 재사용 | job_diagnosis | analyzable(high_cardinality) | 8b | 예 |
| `direct_anatomic_link` | `wrist.jobDiagnosis.directAnatomicLink` | 신규등록 | 값 도메인 elbow와 동일 확인됨(`''`/`yes`/`no`, [wrist ExposureForm.jsx:13-16](../../../src/modules/wrist/components/ExposureForm.jsx#L13-L16)) — 다른 필드의 게이트 자체 | job_diagnosis | analyzable(boolean) | 8b | 예 |
| `exposure_types` | `wrist.jobDiagnosis.exposureType.repetition`/`.force`/`.awkwardPosture` | 신규등록 | 다중선택, **옵션 3개, elbow와 값은 같으나 라벨 다름**([wrist EXPOSURE_TYPE_OPTIONS](../../../src/modules/wrist/utils/data.js#L16-L20): `repetition`/`force`/`awkward_posture`) | job_diagnosis | analyzable(boolean ×3) | 8b | 예 |
| `repetition_level`/`force_level`/`awkward_posture_level` | `wrist.jobDiagnosis.repetitionLevel`/`forceLevel`/`awkwardPostureLevel` | 신규등록 | 옵션 값 elbow와 동일 확인됨(COMMON_FREQUENCY/FORCE_OPTIONS, [wrist ExposureForm.jsx:30-39](../../../src/modules/wrist/components/ExposureForm.jsx#L30-L39), 라벨만 "경도" vs elbow "경미") | job_diagnosis | analyzable(ordinal) | 8b | 예 |
| `work_pattern`/`rest_distribution` | `wrist.jobDiagnosis.workPattern`/`restDistribution` | 신규등록 | 옵션 값 elbow와 동일 확인됨([wrist ExposureForm.jsx:18-28](../../../src/modules/wrist/components/ExposureForm.jsx#L18-L28)) | job_diagnosis | analyzable | 8b | 예 |
| `daily_exposure_hours`/`shift_share_percent`/`days_per_week` | `wrist.jobDiagnosis.dailyExposureHours`/`shiftSharePercent`/`daysPerWeek` | 신규등록 | | job_diagnosis | analyzable | 8b | 예 |
| `static_holding_level` | `wrist.jobDiagnosis.staticHoldingLevel` | 신규등록 | **1차 개정에서 누락됐던 필드 — 추가.** BK2101/BK2106 분기 전용(BK2101: [DiseaseSpecificFields.jsx:126-134](../../../src/modules/wrist/components/DiseaseSpecificFields.jsx#L126-L134), BK2106: [:231-239](../../../src/modules/wrist/components/DiseaseSpecificFields.jsx#L231-L239)), FREQUENCY_OPTIONS(ordinal) | job_diagnosis | analyzable(ordinal) | 8c | 예 |
| `direct_pressure_level` | `wrist.jobDiagnosis.directPressureLevel` | 신규등록 | **1차 개정에서 누락됐던 필드 — 추가.** BK2106 분기 전용(wrist엔 BK2105가 없음, [DiseaseSpecificFields.jsx:214-222](../../../src/modules/wrist/components/DiseaseSpecificFields.jsx#L214-L222)), FREQUENCY_OPTIONS(ordinal), `bk2106_pressure_source`의 게이트 자체 | job_diagnosis | analyzable(ordinal) | 8c | 예 |
| `vibration_exposure` | `wrist.jobDiagnosis.vibrationExposure` | 신규등록 | **1차 개정에서 누락됐던 필드 — 추가.** BK2103 분기 전용([DiseaseSpecificFields.jsx:162-170](../../../src/modules/wrist/components/DiseaseSpecificFields.jsx#L162-L170)), `present` 여부가 bk2103 세부항목의 게이트 | job_diagnosis | analyzable | 8c | 예 |
| `bk2101_cycle_seconds` | `wrist.jobDiagnosis.bk2101CycleSeconds` | 신규등록 | `selectedBkType!=='BK2101'`이면 not_applicable | job_diagnosis | analyzable | 8c | 예 |
| `bk2101_repetition_per_hour` | `wrist.jobDiagnosis.bk2101RepetitionPerHour` | 신규등록 | 동일 게이트 | job_diagnosis | analyzable | 8c | 예 |
| `bk2101_monotony` | `wrist.jobDiagnosis.bk2101Monotony` | 신규등록 | 동일 게이트 | job_diagnosis | analyzable | 8c | 예 |
| `bk2101_forced_dorsal_extension` | `wrist.jobDiagnosis.bk2101ForcedDorsalExtension` | 신규등록 | 동일 게이트 | job_diagnosis | analyzable | 8c | 예 |
| `bk2101_prosupination` | `wrist.jobDiagnosis.bk2101Prosupination` | 신규등록 | 동일 게이트 | job_diagnosis | analyzable | 8c | 예 |
| `bk2106_pressure_source` | `wrist.jobDiagnosis.bk2106PressureSource.<옵션>`(5개, 아래 표 — **elbow와 다름**: `palm_contact` vs elbow `ground_contact`) | 신규등록 | 다중선택, `selectedBkType!=='BK2106'`이면 not_applicable | job_diagnosis | analyzable(boolean ×5) | 8c | 예 |
| `bk2103_vibration_tool_type` | `wrist.jobDiagnosis.bk2103VibrationToolType.<옵션>`(7개, 아래 표 — **elbow(13개)와 완전히 다른 목록**) | 신규등록 | 다중선택 | job_diagnosis | analyzable(boolean ×7) | 8c | 예 |
| `bk2103_daily_vibration_hours` | `wrist.jobDiagnosis.bk2103DailyVibrationHours` | 신규등록 | | job_diagnosis | analyzable | 8c | 예 |
| `bk2103_tool_pressing`/`frequent_high_force_grip` | `wrist.jobDiagnosis.bk2103ToolPressing`/`wrist.jobDiagnosis.bk2103FrequentHighForceGrip` | 신규등록 | **오타 정정**(1차 개정에서 `Bk2103...` 대문자 오기) | job_diagnosis | analyzable | 8c | 예 |
| `bk2113_repetitive_wrist_motion`(wrist 전용) | `wrist.jobDiagnosis.bk2113RepetitiveWristMotion` | 신규등록 | `selectedBkType!=='BK2113'`이면 not_applicable | job_diagnosis | analyzable | 8c | 예 |
| `diagnosisEvaluations[].bkSelectionMode` | — | 제외 | elbow와 동일 사유(무조건 재계산 덮어씀) | — | — | — | 아니오 |

`wrist/components/ExposureForm.jsx`/`DiseaseSpecificFields.jsx`를 직접 읽어 확인 완료: `direct_anatomic_link`/`work_pattern`/`rest_distribution`/`repetition_level`/`force_level`/`awkward_posture_level` 옵션 값과 게이트 조건(`direct_anatomic_link`→`EXPOSURE_DETAIL_CONFIG`→`direct_pressure_level`/`vibration_exposure`)은 elbow와 **동일**하다 — 다른 것은 압박원(`palm_contact` vs `ground_contact`)과 진동공구 목록(7개 vs 13개, 완전히 다른 공구 종류)뿐이다. **BK 분기 배치도 elbow와 동일**: `static_holding_level`은 BK2101/BK2106, `direct_pressure_level`은 BK2106(wrist엔 BK2105 자체가 없음), `vibration_exposure`는 BK2103.

### wrist 다중선택 옵션 → 목표 키 전체 대응표

**`exposureType`**(3, [wrist/data.js:16-20](../../../src/modules/wrist/utils/data.js#L16-L20)):

| 원본 값 | 목표 키 |
|---|---|
| `repetition` | `wrist.jobDiagnosis.exposureType.repetition` |
| `force` | `wrist.jobDiagnosis.exposureType.force` |
| `awkward_posture` | `wrist.jobDiagnosis.exposureType.awkwardPosture` |

**`bk2106PressureSource`**(5, [wrist/data.js:26-32](../../../src/modules/wrist/utils/data.js#L26-L32) — `palm_contact`가 elbow의 `ground_contact`를 대체):

| 원본 값 | 목표 키 |
|---|---|
| `hard_surface` | `wrist.jobDiagnosis.bk2106PressureSource.hardSurface` |
| `tool_edge` | `wrist.jobDiagnosis.bk2106PressureSource.toolEdge` |
| `palm_contact` | `wrist.jobDiagnosis.bk2106PressureSource.palmContact` |
| `carrying_contact` | `wrist.jobDiagnosis.bk2106PressureSource.carryingContact` |
| `other` | `wrist.jobDiagnosis.bk2106PressureSource.other` |

**`bk2103VibrationToolType`**(7 — 공구 6종 + `other`, [wrist/data.js:38-46](../../../src/modules/wrist/utils/data.js#L38-L46)):

| 원본 값 | 목표 키 |
|---|---|
| `grinder` | `wrist.jobDiagnosis.bk2103VibrationToolType.grinder` |
| `impact_wrench` | `wrist.jobDiagnosis.bk2103VibrationToolType.impactWrench` |
| `hammer_drill` | `wrist.jobDiagnosis.bk2103VibrationToolType.hammerDrill` |
| `jackhammer` | `wrist.jobDiagnosis.bk2103VibrationToolType.jackhammer` |
| `polisher` | `wrist.jobDiagnosis.bk2103VibrationToolType.polisher` |
| `sander` | `wrist.jobDiagnosis.bk2103VibrationToolType.sander` |
| `other` | `wrist.jobDiagnosis.bk2103VibrationToolType.other` |

## 요약 (갱신)

- **기존유지(완료)**: §0의 카탈로그 키 전부(5차 개정 이후 19개 — task/vibration_interval 4종 삭제, bmi 1종 추가) — 원본 raw 필드 기준으로는 klgRight/Left·ellmanRight/Left·confirmedRight/Left·confirmedCode/Name(파생 boolean만)·verticalDistribution·concomitantSpondylosis·jobName(job)·knee/shoulder/elbow/wrist/cervical/spine 각 대표 파생변수 자체
- **보류(슬라이스 착수 시 최종 결정, 총 10곳)**: diagnosis moduleId/side/confirmedCode/confirmedName 독립노출(6), job workPeriodOverride(2)·spine legacyJobName(1) 노출 가치, elbow/wrist bkSelectionMode 및 레거시 유출 필드 2종 — **단 elbow/wrist의 이 항목들 자체가 job_diagnosis grain 소속이라 5차 개정으로 이미 소스코드까지 삭제됨(더 이상 "보류" 대상 아님, 이 요약 항목은 삭제 전 이력)**
- **제외**: LABEL_ONLY_UNUSED 5개(elbow만 존재, job_diagnosis와 함께 이미 삭제됨), 컨테이너/기술ID/자유서술/UI전용/엔터티키 구성요소(diagnosis id 포함, 이번 개정에서 job/job_diagnosis와 기준 통일) 다수
- **신규등록**: 나머지 전부, Slice 1~8c에 배분. 다중선택 필드·게이트 조건·옵션 상수 전부 실제 코드 확인 완료(elbow/wrist/cervical) — 이후 5차 개정에서 job_diagnosis(elbow/wrist)·task/vibration_interval(spine)·cervical_task 전체와 spine.case.evalMethod/careerYears/careerMonths가 소스코드까지 삭제됐고, person grain 활성화(gender/heightCm/weightKg/highBloodPressure/diabetes 재배치)와 patient.identity.bmi 신규 등록·공통변수 브로드캐스트 메커니즘이 추가됐다. **최종 정본은 `packages/analytics-core/coverage/pr0B4FieldMapping.ts`.**
