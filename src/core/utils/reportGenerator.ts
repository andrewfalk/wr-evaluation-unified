import type { PatientData, SharedData } from '@wr/contracts';
import type { PatientRecord } from '../types/patient';
import { renderNarrativeBlocks } from '../narrative/renderBlocks';
import { getSideText } from '../i18n/sideLabels';
import { buildAssessmentBlocks, formatGroupedAssessment } from './assessmentGroups';
import { calculateAge, calculateBMI } from './common';
import { buildJobHistoryLines } from './jobHistory';
import { selectModuleNote } from './moduleNotes';

// 타입만 붙였다(P2-66g) — 실행 코드는 JS 시절과 같다. patient.data는 호출자가 늘 채워 넘기므로 단언한다(가드를 새로 넣지 않는다).
export function generateUnifiedReport(patient: PatientRecord): string {
  const shared: Partial<SharedData> = (patient.data as PatientData).shared || {};
  const modules = (patient.data as PatientData).modules || {};
  const activeModules = (patient.data as PatientData).activeModules || [];
  const diagnoses = shared.diagnoses || [];
  const jobs = shared.jobs || [];

  const age = calculateAge(shared.birthDate, shared.injuryDate);
  const bmi = calculateBMI(shared.height, shared.weight);

  let text = `업무관련성 통합 평가 보고서\n\n`;
  text += `이름: ${shared.name || '-'}(${shared.gender === 'male' ? '남' : shared.gender === 'female' ? '여' : '-'})\n`;
  text += `키/체중: ${shared.height || '-'}cm / ${shared.weight || '-'}kg (BMI: ${bmi || '-'})\n`;
  text += `생년월일: ${shared.birthDate || '-'}\n`;
  text += `재해일자: ${shared.injuryDate || '-'} (만 ${age || '-'}세)\n\n`;

  text += `[신청 상병]\n`;
  diagnoses.forEach((diag, index) => {
    if (diag.code || diag.name) {
      text += `#${index + 1}. ${diag.code || ''} ${diag.name || ''}${diag.side ? ` (${getSideText(diag.side)})` : ''}\n`;
    }
  });

  text += `\n[특이사항]\n${shared.specialNotes || '-'}\n`;

  const jobHistory = buildJobHistoryLines(jobs);
  text += `\n[직업력]\n`;
  text += jobHistory.text;

  // 머리글은 평가 부위가 하나라도 있을 때만(ADR 0001 B2 — EMR과 같게).
  if (activeModules.length > 0) {
    text += `\n[부위별 신체부담 평가]\n`;
  }
  // 모듈 블록은 activeModules 순서로, 각 모듈의 서술(narrative)이 만든다 — EMR b6·b8과 같은 조립 함수(core/narrative/renderBlocks.ts).
  text += renderNarrativeBlocks('report', shared, modules, activeModules, { jobNumberingByJobId: jobHistory.numberingByJobId });

  // 머리글 표기는 EMR 6번 칸과 같게(ADR 0001 B3).
  text += `\n[ 업무관련성 평가 결과 ]\n`;
  if (shared.reportOptions?.groupAssessmentResults) {
    text += `\n${formatGroupedAssessment(diagnoses, activeModules)}\n`;
  } else {
    text += buildAssessmentBlocks(diagnoses, activeModules, { reasonIndent: '  ' })
      .map(block => `\n${block}\n`)
      .join('');
  }

  const returnConsiderations = selectModuleNote(modules, activeModules);

  if (returnConsiderations) {
    text += `\n[특이 사항 메모]\n${returnConsiderations}\n`;
  }

  text += `\n${'-'.repeat(50)}\n${shared.evaluationDate || '-'}\n${shared.hospitalName || '-'} ${shared.department || ''}\n담당의 ${shared.doctorName || '-'}`;

  return text;
}
