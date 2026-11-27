// EMR 전송용 텍스트(b5~b9, txtSyth1Cont 등) 생성 레이어. exportService.js에서 그대로
// 옮겨온 것으로, xlsx/jszip 의존성이 없어 미리보기 화면(AssessmentStep)이 byte 계산을
// 위해 가볍게 import할 수 있다.
//
// 타입만 붙였다(P2-66g) — 실행 코드는 JS 시절과 같다. patient.data는 호출자가 늘 채워 넘기므로 단언하고(가드를 새로 넣지 않는다),
// JS 의존 모듈(emrText.js 등)에서 흘러드는 any는 export 함수의 반환 타입을 적어 밖으로 새지 않게 한다.

import type { PatientData, SharedData, SharedJob } from '@wr/contracts';
import type { NarrativeVariant } from '../modules/manifest';
import type { PatientRecord } from '../types/patient';
import { renderNarrativeBlocks } from '../narrative/renderBlocks';
import { calculateAge, calculateBMI } from './common';
import { selectModuleNote } from './moduleNotes';
import { buildJobHistoryLines } from './jobHistory';
import { EMR_TEXT_LIMIT_BYTES, cp949ByteLength, truncateCp949Bytes } from './emrText';
import { buildAssessmentBlocks, buildConfirmedDiagnosisLines, formatGroupedAssessment } from './assessmentGroups';

type Shared = Partial<SharedData>;
type Modules = PatientData['modules'];
type JobHistory = ReturnType<typeof buildJobHistoryLines>;

/** generateUnifiedEMR의 결과 — EMR 칸별 원문(잘리기 전). */
export interface UnifiedEmr {
  b5: string;
  b6: string;
  b7: string;
  b8: string;
  b9: string;
  consultReplySummary: string;
}

/** resolveAssessment의 결과 — 6번 칸(b8)에 실제로 쓸 글과 직접 편집본의 상태. */
export interface ResolvedAssessment {
  text: string;
  generated: string;
  isOverride: boolean;
  isStale: boolean;
  hasInvalidOverride: boolean;
}

/** EMR 주입 페이로드(2.상병 ~ 6.종합소견 칸). */
export interface EmrFieldData {
  txtAppvSickCont: string;
  txtMrecMedPovCont: string;
  txtJobCusCont: string;
  txtPerCusCont: string;
  txtSyth1Cont: string;
  txtIdacDte: string;
  txtCpnyNm: string;
  rdoHcreTypeCd: string;
  rdoCls: string;
  _truncatedFields: string[];
}

/** prepareEmrInjection의 결과 — 페이로드와 전송 전 경고에 쓰는 바이트 정보. */
export interface EmrInjection {
  fieldData: EmrFieldData;
  effective: ResolvedAssessment;
  bytes: number;
  confirmedDx: { isEmpty: boolean; bytes: number; overLimit: boolean };
  exposureSection: { bytes: number; overLimit: boolean };
}

/** 다학제 회신 페이로드(txtSyth2Cont·txtSyth3Cont 칸). */
export interface ConsultReplyFieldData {
  txtSyth2Cont: string;
  txtSyth3Cont: string;
  rdoCureCost: string;
  rdoExamToDte: string;
  rdoIdacDcsDte: string;
  _truncatedFields: string[];
}

// 모듈 블록 — 소견서와 같은 조립 함수(core/narrative/renderBlocks.ts)로, activeModules 순서(ADR 0001 B1). 직업력 번호 맵도
// 소견서처럼 넘긴다(어깨 [직력별 기여]가 쓴다).
function buildModuleBlocks(variant: NarrativeVariant, shared: Shared, modules: Modules, activeModules: string[], jobHistory: JobHistory): string {
  return renderNarrativeBlocks(variant, shared, modules, activeModules, { jobNumberingByJobId: jobHistory.numberingByJobId });
}

function buildExposureSection(shared: Shared, modules: Modules, activeModules: string[]): string {
  const jobHistory = buildJobHistoryLines(shared.jobs as SharedJob[]);
  let text = '[직업력]\n';
  text += jobHistory.text;

  if (activeModules.length > 0) {
    text += '\n[부위별 신체부담 평가]\n';
  }

  text += buildModuleBlocks('emrSection', shared, modules, activeModules, jobHistory);
  return text;
}

// buildExposureSection의 요약본 — b8(EMR 종합소견) byte 절감용. 결론(부담 정도·기여도·
// 누적신체부담·초과 판정)은 남기고, 참고문구·근거 상세·narrative는 뺀다. 전문은
// txtJobCusCont(4.직업적 요인, buildExposureSection)에 그대로 남아 있으므로 정보 손실은 없다.
function buildExposureSummary(shared: Shared, modules: Modules, activeModules: string[]): string {
  const jobHistory = buildJobHistoryLines(shared.jobs as SharedJob[]);
  let text = '[직업력]\n';
  text += jobHistory.text;

  if (activeModules.length > 0) {
    text += '\n[부위별 신체부담 평가]\n';
  }

  text += buildModuleBlocks('emrSummary', shared, modules, activeModules, jobHistory);
  return text;
}

function formatEmrBoolean(value: string | undefined): string {
  if (value === '유') return '(+)';
  if (value === '무') return '(-)';
  return value || '미상';
}

function buildPersonalFactorText(shared: Shared, age: ReturnType<typeof calculateAge>, bmi: ReturnType<typeof calculateBMI>): string {
  const visitHistory = shared.visitHistory?.trim() || '없음';
  const specialNotes = shared.specialNotes?.trim() || '없음';

  return [
    `- 키 ${shared.height || '-'}cm`,
    `- 체중 ${shared.weight || '-'}kg`,
    `- BMI: ${bmi || '-'}`,
    `- 나이: ${age || '-'}세`,
    `- 고혈압: ${formatEmrBoolean(shared.highBloodPressure)}`,
    `- 당뇨병: ${formatEmrBoolean(shared.diabetes)}`,
    `- 수진이력: ${visitHistory}`,
    `- 특이사항: ${specialNotes}`,
  ].join('\n');
}

function formatConsultReplySection(label: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return '';
  return `[ ${label} ]\n${trimmed}`;
}

function buildConsultReplySummary(shared: Shared): string {
  const sections = [
    formatConsultReplySection('정형외과', shared.consultReplyOrtho),
    formatConsultReplySection('신경외과', shared.consultReplyNeuro),
    formatConsultReplySection('재활의학과', shared.consultReplyRehab),
    formatConsultReplySection('기타', shared.consultReplyOther),
  ].filter(Boolean);

  return sections.length > 0 ? `[ 다학제 회신 ]\n${sections.join('\n\n')}` : '';
}

function buildConsultReplySlots(shared: Shared): { slot2: string; slot3: string } {
  const ortho = formatConsultReplySection('정형외과', shared.consultReplyOrtho);
  const neuro = formatConsultReplySection('신경외과', shared.consultReplyNeuro);
  const rehab = formatConsultReplySection('재활의학과', shared.consultReplyRehab);
  const other = formatConsultReplySection('기타', shared.consultReplyOther);

  let slot2 = '';
  let slot3 = '';

  const append = (slot: string, text: string): string => (slot ? `${slot}\n${text}` : text);

  if (ortho) slot2 = append(slot2, ortho);

  if (neuro) {
    if (slot2.includes('정형외과')) slot3 = append(slot3, neuro);
    else slot2 = append(slot2, neuro);
  }

  if (rehab) {
    if (slot2.includes('정형외과') || slot2.includes('신경외과')) slot3 = append(slot3, rehab);
    else slot2 = append(slot2, rehab);
  }

  if (other) {
    if (!slot2) slot2 = append(slot2, other);
    else slot3 = append(slot3, other);
  }

  return { slot2, slot3 };
}

// groupOutputOverride: 생략하면 shared.reportOptions.groupAssessmentResults를 따른다.
// true/false를 명시하면 저장된 설정과 무관하게 그룹/개별 형식을 강제한다 — 미리보기에서
// 두 형식을 동시에 계산해 보여줄 때 사용한다(AssessmentStep.tsx).
export function generateUnifiedEMR(patient: PatientRecord, groupOutputOverride?: boolean): UnifiedEmr {
  const shared: Shared = (patient.data as PatientData).shared || {};
  const modules = (patient.data as PatientData).modules || {};
  const activeModules = (patient.data as PatientData).activeModules || [];
  const diagnoses = shared.diagnoses || [];
  const groupOutput = groupOutputOverride === undefined
    ? !!shared.reportOptions?.groupAssessmentResults
    : !!groupOutputOverride;

  const age = calculateAge(shared.birthDate, shared.injuryDate);
  const bmi = calculateBMI(shared.height, shared.weight);

  // 확인 상병: 신청 상병 전체가 아니라 종합소견에서 상태를 '확인'으로 입력한 상병만 보낸다.
  // 그룹 옵션이 켜졌을 때만 원본 배열 index 기준 번호를 붙인다.
  const b5 = buildConfirmedDiagnosisLines(diagnoses, activeModules, { groupOutput }).join('\n');

  const b6 = buildExposureSection(shared, modules, activeModules);
  const b7 = buildPersonalFactorText(shared, age, bmi);
  const consultReplySummary = buildConsultReplySummary(shared);

  const assessmentText = groupOutput
    ? formatGroupedAssessment(diagnoses, activeModules)
    : buildAssessmentBlocks(diagnoses, activeModules, { reasonIndent: '    ' }).join('\n\n');

  const b8 = [
    buildExposureSummary(shared, modules, activeModules),
    '[ 업무관련성 평가 결과 ]',
    assessmentText,
  ].filter(Boolean).join('\n\n');
  const b9 = selectModuleNote(modules, activeModules);

  return { b5, b6, b7, b8, b9, consultReplySummary };
}

// ── 종합소견(b8) 직접 편집 오버라이드 ──────────────────────────────────────
// 저장된 shared.reportOptions.assessmentOverride를 검증하고, 자동 생성본(generatedB8)과
// 비교해 낡음(isStale) 여부를 판정하는 접근자. 서버는 계약을 런타임에 참조하지 않고
// shared를 통째로 passthrough 저장하므로(patients.ts), 빈 문자열·깨진 형태에 대한
// 진짜 방어선은 여기다 — 계약의 .refine()은 저장 시점 보조 방어선일 뿐이다.
//
// Object.hasOwn은 Win7 구형 Chrome에서 지원하지 않는다([project_win7_browser_compat]) —
// hasOwnProperty.call을 사용한다.
export function resolveAssessment(patient: PatientRecord, generatedB8: string): ResolvedAssessment {
  const ro = (patient.data as PatientData).shared?.reportOptions;
  const hasKey = !!ro && Object.prototype.hasOwnProperty.call(ro, 'assessmentOverride');
  const ov = hasKey ? ro.assessmentOverride : undefined; // null도 hasKey=true → invalid로 잡힌다
  const valid = !!ov
    && typeof ov.text === 'string' && ov.text.trim().length > 0
    && typeof ov.baseText === 'string'
    && typeof ov.updatedAt === 'string' && !Number.isNaN(Date.parse(ov.updatedAt));
  if (!valid) {
    return {
      text: generatedB8, generated: generatedB8, isOverride: false, isStale: false,
      hasInvalidOverride: hasKey, // 키는 있는데 형태가 깨진 경우만 true
    };
  }
  return {
    text: ov.text, generated: generatedB8, isOverride: true,
    isStale: ov.baseText !== generatedB8, hasInvalidOverride: false,
  };
}

// b9(특이 사항 메모/returnConsiderations)는 의도적으로 EMR에 보내지 않는다 — 엑셀·텍스트
// 리포트는 generateUnifiedEMR()의 b9를 독립적으로 계속 소비한다(exportService.js 등).
// txtArrv1Cont 키를 아예 빼면, EmrHelper.cs의 SetField()가 빈 값에서 early-return하는
// 동작 덕에 EMR 쪽 기존 값이 지워지지 않고 그대로 유지된다(C# 재빌드 불필요).
function buildEmrFieldData(patient: PatientRecord, unified: UnifiedEmr, b8Text: string): EmrFieldData {
  const { b5, b6, b7 } = unified;
  const shared: Shared = (patient.data as PatientData).shared || {};

  const truncatedFields: string[] = [];
  const tAppv = truncateCp949Bytes(b5 || '', EMR_TEXT_LIMIT_BYTES);
  if (tAppv.truncated) truncatedFields.push('txtAppv_Sick_Cont');
  const tMrec = truncateCp949Bytes(shared.medicalRecord || '', EMR_TEXT_LIMIT_BYTES);
  if (tMrec.truncated) truncatedFields.push('txtMrec_Med_Pov_Cont');
  const t6 = truncateCp949Bytes(b6, EMR_TEXT_LIMIT_BYTES);
  if (t6.truncated) truncatedFields.push('txtJobCusCont');
  const t7 = truncateCp949Bytes(b7, EMR_TEXT_LIMIT_BYTES);
  if (t7.truncated) truncatedFields.push('txtPerCusCont');
  const t8 = truncateCp949Bytes(b8Text, EMR_TEXT_LIMIT_BYTES);
  if (t8.truncated) truncatedFields.push('txtSyth1Cont');

  return {
    txtAppvSickCont: tAppv.text,
    txtMrecMedPovCont: tMrec.text,
    txtJobCusCont: t6.text,
    txtPerCusCont: t7.text,
    txtSyth1Cont: t8.text,
    txtIdacDte: shared.injuryDate || '',
    txtCpnyNm: '',
    rdoHcreTypeCd: '2',
    rdoCls: 'M',
    _truncatedFields: truncatedFields,
  };
}

// EMR 전송 준비 — generateUnifiedEMR을 1회만 호출해 이전에 경고용 b8과 실제 페이로드를
// 각각 독립 계산하던 이중 계산을 해소한다. effective는 오버라이드 적용 여부·낡음 상태를
// 함께 담아 호출자(useEMRIntegration)가 재확인·차단 판단에 그대로 쓸 수 있게 한다.
export function prepareEmrInjection(patient: PatientRecord): EmrInjection {
  const unified = generateUnifiedEMR(patient);
  const effective = resolveAssessment(patient, unified.b8);
  const fieldData = buildEmrFieldData(patient, unified, effective.text);
  // confirmedDx: 전송 전 경고용 — 절단 전 원본 b5 기준(이미 절단된 fieldData.txtAppvSickCont로는
  // 한도 초과를 알 수 없다).
  const confirmedDxBytes = cp949ByteLength(unified.b5 || '');
  // exposureSection: 전송 전 경고용 — 절단 전 원본 b6(4.직업적 요인) 기준(게이트 C P2-66e). 4번 칸은 소견서와 같은 전문이라
  // 길어질 수 있고, 넘으면 뒤에 오는 부위부터 잘린다.
  const exposureSectionBytes = cp949ByteLength(unified.b6 || '');
  return {
    fieldData,
    effective,
    bytes: cp949ByteLength(effective.text),
    confirmedDx: { isEmpty: !unified.b5, bytes: confirmedDxBytes, overLimit: confirmedDxBytes > EMR_TEXT_LIMIT_BYTES },
    exposureSection: { bytes: exposureSectionBytes, overLimit: exposureSectionBytes > EMR_TEXT_LIMIT_BYTES },
  };
}

export function generateEMRFieldData(patient: PatientRecord): EmrFieldData { // 기존 시그니처 유지 — exportService.js 등 소비자 불변
  return prepareEmrInjection(patient).fieldData;
}

export function generateConsultReplyFieldData(patient: PatientRecord): ConsultReplyFieldData {
  const shared: Shared = (patient.data as PatientData).shared || {};
  const consultSlots = buildConsultReplySlots(shared);

  const truncatedFields: string[] = [];
  const tSyth2 = truncateCp949Bytes(consultSlots.slot2, EMR_TEXT_LIMIT_BYTES);
  if (tSyth2.truncated) truncatedFields.push('txtSyth2Cont');
  const tSyth3 = truncateCp949Bytes(consultSlots.slot3, EMR_TEXT_LIMIT_BYTES);
  if (tSyth3.truncated) truncatedFields.push('txtSyth3Cont');

  return {
    txtSyth2Cont: tSyth2.text,
    txtSyth3Cont: tSyth3.text,
    rdoCureCost: 'N',
    rdoExamToDte: 'N',
    rdoIdacDcsDte: 'N',
    _truncatedFields: truncatedFields,
  };
}
