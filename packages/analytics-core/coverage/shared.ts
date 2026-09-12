// §5.3 coverage inventory — patient.data.shared 전체 필드. 출처: src/core/utils/data.js의
// createSharedData()/createDiagnosis()/createSharedJob()/createVideoAnalysisData(), 그리고
// AssessmentTab.jsx/AssessmentIndividualFields.jsx가 진단 항목에 동적으로 채우는 필드들
// (side별 판정 필드는 하나의 팩토리 함수가 아니라 UI에서 계약처럼 붙는다).
import type { CoverageInventory } from './types';

const DEFERRED = 'PR0-B3 전체 카탈로그 확장 대상 — 현재 7개 대표 변수의 dependsOn에는 없음';
const FREE_TEXT = '자유 서술 텍스트 — 계산에 관여하지 않음';
const TECHNICAL_ID = '기술 ID/FK — 계산값이 아니라 참조·라우팅용';

export const SHARED_INVENTORY: CoverageInventory = {
  // activeModules는 shared 소속은 아니지만(data.activeModules) 7개 대표 변수 전부의
  // dependsOn에 공통으로 나열되므로 여기서 함께 기록한다.
  activeModules: { included: true },

  'shared.patientNo': { included: false, reason: FREE_TEXT },
  'shared.name': { included: false, reason: FREE_TEXT },
  'shared.gender': { included: true }, // spine.mddm/vibration dependsOn
  'shared.height': { included: false, reason: DEFERRED },
  'shared.weight': { included: false, reason: DEFERRED },
  'shared.birthDate': { included: true }, // knee.relatedness.max dependsOn
  'shared.injuryDate': { included: true }, // knee.relatedness.max dependsOn
  'shared.hospitalName': { included: false, reason: FREE_TEXT },
  'shared.department': { included: false, reason: FREE_TEXT },
  'shared.doctorName': { included: false, reason: FREE_TEXT },
  'shared.evaluationDate': { included: false, reason: DEFERRED },
  'shared.medicalRecord': { included: false, reason: FREE_TEXT },
  'shared.highBloodPressure': { included: false, reason: DEFERRED },
  'shared.diabetes': { included: false, reason: DEFERRED },
  'shared.visitHistory': { included: false, reason: FREE_TEXT },
  'shared.consultReplyOrtho': { included: false, reason: FREE_TEXT },
  'shared.consultReplyNeuro': { included: false, reason: FREE_TEXT },
  'shared.consultReplyRehab': { included: false, reason: FREE_TEXT },
  'shared.consultReplyOther': { included: false, reason: FREE_TEXT },
  'shared.specialNotes': { included: false, reason: FREE_TEXT },
  // diagnoses[]/jobs[]/videoAnalysis 자체는 배열/객체 컨테이너 — 그 원소 필드로 분류한다.
  'shared.diagnoses': { included: false, reason: '컨테이너(원소 필드로 분류)' },
  'shared.jobs': { included: false, reason: '컨테이너(원소 필드로 분류)' },
  'shared.videoAnalysis': { included: false, reason: '컨테이너(원소 필드로 분류)' },
  // CLAUDE.md에 문서화되지 않았지만 shared/contracts/patient.ts:47-58에서 실제로 검증되는
  // 필드 — AssessmentStep.jsx/AssessmentTab.jsx가 지연 생성한다.
  'shared.reportOptions': { included: false, reason: 'UI 전용 — 소견서 출력 옵션 묶음, 계산에 관여하지 않음' },

  // --- shared.diagnoses[] — 기본(createDiagnosis, core/utils/data.js) ---
  'shared.diagnoses[].id': { included: true }, // elbow/wrist dependsOn
  'shared.diagnoses[].code': { included: true }, // elbow/wrist dependsOn
  'shared.diagnoses[].name': { included: true }, // elbow/wrist dependsOn
  'shared.diagnoses[].moduleId': { included: true }, // elbow/wrist dependsOn(라우팅 힌트)
  // PR0-B3 Part B — diagnosis_side grain 엔터티 열거(enumerateDiagnosisSideEntities)가
  // side==='both'를 우/좌로 explode하는 데 직접 쓴다.
  'shared.diagnoses[].side': { included: true },

  // --- knee/shoulder 전용 진단 확장(createKneeDiagnosis/createShoulderDiagnosis) ---
  // PR0-B3 Part B — knee.diagnosisSide.appliedConfirmedMismatch("신청≠확정 여부") dependsOn.
  'shared.diagnoses[].confirmedCode': { included: true },
  'shared.diagnoses[].confirmedName': { included: true },
  // knee.diagnosisSide.klGrade dependsOn.
  'shared.diagnoses[].klgRight': { included: true },
  'shared.diagnoses[].klgLeft': { included: true },
  // shoulder.diagnosisSide.ellmanClass dependsOn.
  'shared.diagnoses[].ellmanRight': { included: true },
  'shared.diagnoses[].ellmanLeft': { included: true },

  // --- 판정 공통 필드(AssessmentTab.jsx의 SideAssessment) ---
  // knee.diagnosisSide.confirmedStatus dependsOn. assessmentRight/Left("업무관련성")와
  // reasonRight/Left(낮음 사유)는 이번 Part B 범위에 없는 별개 변수 후보라 그대로 DEFERRED.
  'shared.diagnoses[].confirmedRight': { included: true },
  'shared.diagnoses[].confirmedLeft': { included: true },
  'shared.diagnoses[].assessmentRight': { included: false, reason: DEFERRED + ' — isXAssessmentComplete가 읽지만 대표 변수 dependsOn에는 없음' },
  'shared.diagnoses[].assessmentLeft': { included: false, reason: DEFERRED + ' — isXAssessmentComplete가 읽지만 대표 변수 dependsOn에는 없음' },
  'shared.diagnoses[].reasonRight': { included: false, reason: DEFERRED },
  'shared.diagnoses[].reasonLeft': { included: false, reason: DEFERRED },
  'shared.diagnoses[].reasonRightOther': { included: false, reason: FREE_TEXT },
  'shared.diagnoses[].reasonLeftOther': { included: false, reason: FREE_TEXT },

  // --- 척추 전용(AssessmentTab.jsx — spineAssessmentMigration.js의 SPINE_COMMON_FIELDS) ---
  // PR0-B3 Part B — spine.diagnosis.verticalDistribution/concomitantSpondylosis(case grain)
  // dependsOn. §5.5가 경고한 "case grain 값이 diagnosis 행에 저장됨" 함정은 extractor가
  // 그 case의 spine 진단 전체를 취합하고 값이 갈리면 conflicting_common_field로 반영해 해소했다.
  'shared.diagnoses[].verticalDistribution': { included: true },
  'shared.diagnoses[].concomitantSpondylosis': { included: true },

  // --- shared.jobs[] (createSharedJob) ---
  'shared.jobs[].id': { included: true },
  'shared.jobs[].jobName': { included: true }, // spine dependsOn
  'shared.jobs[].presetId': { included: false, reason: TECHNICAL_ID },
  'shared.jobs[].startDate': { included: true },
  'shared.jobs[].endDate': { included: true },
  'shared.jobs[].workPeriodOverride': { included: true },
  'shared.jobs[].workDaysPerYear': { included: true },

  // --- shared.videoAnalysis(createVideoAnalysisData) — 영상분석 워크스트림(6.0-x) 산출물,
  // 이번 PR의 6개 모듈 계산과 무관 ---
  'shared.videoAnalysis.processes': { included: false, reason: '영상분석 워크스트림 산출물 — 이번 PR 범위 밖' },
  'shared.videoAnalysis.clips': { included: false, reason: '영상분석 워크스트림 산출물 — 이번 PR 범위 밖' },
  'shared.videoAnalysis.processFeatures': { included: false, reason: '영상분석 워크스트림 산출물 — 이번 PR 범위 밖' },
  'shared.videoAnalysis.jobFeatures': { included: false, reason: '영상분석 워크스트림 산출물 — 이번 PR 범위 밖' },
  'shared.videoAnalysis.candidateFeatures': { included: false, reason: '영상분석 워크스트림 산출물 — 이번 PR 범위 밖' },
  'shared.videoAnalysis.appliedInputs': { included: false, reason: '영상분석 워크스트림 산출물 — 이번 PR 범위 밖' },
  'shared.videoAnalysis.settings.retentionMode': { included: false, reason: 'UI/운영 설정 — 계산에 관여하지 않음' },
};
