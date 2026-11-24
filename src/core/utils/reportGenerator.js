import { getModule } from '../moduleRegistry';
import { getSideText } from '../i18n/sideLabels';
import { buildAssessmentBlocks, formatGroupedAssessment } from './assessmentGroups';
import { calculateAge, calculateBMI } from './common';
import { buildJobHistoryLines } from './jobHistory';
import { selectModuleNote } from './moduleNotes';

export function generateUnifiedReport(patient) {
  const shared = patient.data.shared || {};
  const modules = patient.data.modules || {};
  const activeModules = patient.data.activeModules || [];
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

  text += `\n[부위별 신체부담 평가]\n`;
  // 모듈 블록은 activeModules 순서로, 각 모듈의 서술(narrative)이 만든다(Phase 2 C7-a). 등록되지 않았거나 서술이 없는
  // 모듈은 건너뛴다. 계산은 computeCalc({ shared, module })로 부른다(activeModules를 넘기지 않는다 — 넘기면 팔꿈치·손목·
  // 경추가 상병을 걸러 문구가 바뀔 수 있다).
  for (const moduleId of activeModules) {
    const moduleManifest = getModule(moduleId);
    if (!moduleManifest?.computeCalc || !moduleManifest.narrative) continue;
    const calc = moduleManifest.computeCalc({
      shared,
      module: modules[moduleId] || {},
    });
    text += moduleManifest.narrative.render('report', calc, { jobNumberingByJobId: jobHistory.numberingByJobId });
  }

  text += `\n[업무관련성 평가 결과]\n`;
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
