// EMR 전송용 텍스트(b5~b9, txtSyth1Cont 등) 생성 레이어. exportService.js에서 그대로
// 옮겨온 것으로, xlsx/jszip 의존성이 없어 미리보기 화면(AssessmentStep)이 byte 계산을
// 위해 가볍게 import할 수 있다.

import { getModule } from '../moduleRegistry';
import { getSideText } from '../../modules/knee/utils/calculations';
import { groupSummariesByBkType as groupElbowSummaries, mergeBkGroupSummaries as mergeElbowGroups } from '../../modules/elbow/utils/calculations';
import { BK_TYPE_LABELS as ELBOW_BK_LABELS } from '../../modules/elbow/utils/data';
import { groupSummariesByBkType as groupWristSummaries, mergeBkGroupSummaries as mergeWristGroups } from '../../modules/wrist/utils/calculations';
import { BK_TYPE_LABELS as WRIST_BK_LABELS } from '../../modules/wrist/utils/data';
import { EXPOSURE_TYPE_LABELS as CERVICAL_EXPOSURE_TYPE_LABELS } from '../../modules/cervical/utils/data';
import { buildSpineSectionText, buildSpineSectionSummary } from '../../modules/spine/utils/sectionText';
import { AUX_LABELS } from '../../modules/knee/utils/data';
import { calculateAge, calculateBMI } from './common';
import { getEffectiveWorkPeriodText } from './workPeriod';
import { EMR_TEXT_LIMIT_BYTES, truncateCp949Bytes } from './emrText';
import { buildAssessmentBlocks, formatGroupedAssessment } from './assessmentGroups';

function buildSpineExposureText(calc) {
  return buildSpineSectionText(calc);
}

function buildCervicalExposureText(calc) {
  let text = '\n<경추(목)>\n';

  (calc?.jobSummaries || []).forEach(jobSummary => {
    text += `- ${jobSummary.jobName || '-'}\n`;
    const burdenIndicatorText = jobSummary.flagItems?.length > 0
      ? jobSummary.flagItems.map(type => CERVICAL_EXPOSURE_TYPE_LABELS[type] || type).join(', ')
      : '확인된 부담 요인 없음';
    text += `  부담 요인: ${burdenIndicatorText}\n`;
  });

  return text;
}

function buildExposureSection(shared, modules, activeModules) {
  let text = '[직업력]\n';
  (shared.jobs || []).forEach((job, index) => {
    text += `- 직력${index + 1}: ${job.jobName || '-'} | ${getEffectiveWorkPeriodText(job)}\n`;
  });

  if (activeModules.length > 0) {
    text += '\n[부위별 신체부담 평가]\n';
  }

  if (activeModules.includes('knee')) {
    const calc = getModule('knee')?.computeCalc?.({ shared, module: modules.knee || {} });
    const avgRelatedness = calc?.relatedness
      ? ((Number(calc.relatedness.min) + Number(calc.relatedness.max)) / 2).toFixed(1)
      : null;

    text += '\n<무릎(슬관절)>\n';
    (calc?.jobBurdens || []).filter(job => job.jobName).forEach(job => {
      const checked = Object.entries(AUX_LABELS).filter(([key]) => job[key]).map(([, label]) => label);
      text += `직종: ${job.jobName || '-'}\n`;
      text += `일 중량물 취급량: ${job.weight || '-'}kg\n`;
      text += `일 쪼그려 앉기 시간: ${job.squatting || '-'}분\n`;
      if (checked.length > 0) text += `보조변수: ${checked.join(', ')}\n`;
      text += `무릎 부담 정도: ${job.burden?.level || '-'}\n\n`;
    });
    if (calc?.relatedness) {
      text += `참고) 신체부담 정도는 다음의 4단계로 구분함.\n`;
      text += `1) 고도: 퇴행성 변화를 유발 또는 가속하는 것이 확실함(definite)\n`;
      text += `2) 중등도상: 퇴행성 변화를 유발 또는 가속하기에 충분함(probable)\n`;
      text += `3) 중등도하: 퇴행성 변화를 유발 또는 가속할 가능성이 있음(possible)\n`;
      text += `4) 경도: 퇴행성 변화를 유발 또는 가속하기 어려움(no related)\n`;
      text += `\n[신체부담기여도] ${calc.relatedness.min}% ~ ${calc.relatedness.max}% (평균 ${avgRelatedness}%)\n`;
    }
    if (calc?.cumulativeBurden) {
      text += `[누적신체부담] ${calc.cumulativeBurden}\n`;
    }
    text += `\n**신체부담정도, 신체부담 기여도, 누적 신체부담에 관한 자세한 사항은\n`;
    text += `<근골격계 질환의 업무관련성 특별진찰 표준화를 위한 모델 개발\n`;
    text += `- 무릎 관절염을 대상으로 -, 대한직업환경의학회, 2025>\n`;
    text += `보고서를 참조하기 바람.\n`;
  }

  if (activeModules.includes('shoulder')) {
    const calc = getModule('shoulder')?.computeCalc?.({ shared, module: modules.shoulder || {} });
    text += '\n<어깨(견관절)>\n';
    text += '독일의 산재보험 번호 BK2117 장기간의 집중적인 기계적 부하로 인한 어깨 회전근개 병변에 사용하는 어깨 부담 평가 지침을 이용하여 평가하였음.\n\n';
    const shoulderTotals = calc?.totals || [];
    shoulderTotals.forEach(total => {
      const pct = total.totalHours > 0 ? ` / ${(total.ratio * 100).toFixed(0)}%` : '';
      text += `- ${total.label}: ${total.totalHours > 0 ? `${total.totalHours.toFixed(1)}시간` : '-'} (기준 ${total.limit.toLocaleString()}시간${pct}${total.exceeded ? ' [초과]' : ''})\n`;
    });
    const exceeded = shoulderTotals.filter(t => t.exceeded);
    if (exceeded.length > 0) {
      text += `\n** ${exceeded.map(t => t.label).join(', ')} 기준을 초과하여 누적 신체부담은 충분함.\n`;
    } else {
      const over75 = shoulderTotals.filter(t => t.ratio >= 0.75);
      const over50 = shoulderTotals.filter(t => t.ratio >= 0.50);
      if (over50.length >= 3 || over75.length >= 2) {
        text += `\n** 개별 기준 초과 항목은 없으나, 복합 노출을 고려하여 누적 신체부담은 충분함.\n`;
      } else {
        text += `\n** 노출 기준치에 미달하여 누적 신체부담 불충분함.\n`;
      }
    }
  }

  if (activeModules.includes('wrist')) {
    const calc = getModule('wrist')?.computeCalc?.({ shared, module: modules.wrist || {} });
    text += '\n<손목/손가락>\n';
    if (calc?.missingCommonFields?.length) {
      text += `- 공통 시간적 선후관계 누락: ${calc.missingCommonFields.join(', ')}\n`;
    }
    if (calc?.temporalFlagItems?.length > 0) {
      text += `- 공통 시간적 선후관계: ${calc.temporalFlagItems.map(flag => flag.label).join(', ')}\n`;
    }
    (calc?.jobSummaries || []).forEach(jobSummary => {
      text += `- ${jobSummary.jobName || '-'}\n`;
      const wristGroups = groupWristSummaries(jobSummary.diagnosisSummaries || []);
      wristGroups.forEach(group => {
        const merged = mergeWristGroups(group.summaries);
        const diagList = group.summaries
          .map(s => {
            const d = s.diagnosis || {};
            return `${d.code || ''} ${d.name || ''}${d.side ? ` (${getSideText(d.side)})` : ''}`.trim();
          })
          .join(' / ');
        const bkLabel = group.bkType ? WRIST_BK_LABELS[group.bkType] || group.bkType : null;
        const header = bkLabel ? `[${bkLabel}] ${diagList}` : diagList;
        text += `  - ${header}\n`;
        if (merged.missingFields?.length > 0) {
          text += `    입력 누락: ${merged.missingFields.join(', ')}\n`;
        }
        const riskFactorText = merged.riskFactorItems?.length > 0
          ? merged.riskFactorItems.map(flag => flag.label).join(', ')
          : '확인된 위험 요인 없음';
        text += `    분석 정리:\n`;
        text += `      ${(merged.narrative || '-').split('\n').join('\n      ')}\n`;
        text += `      업무에 포함된 위험 요인: ${riskFactorText}\n`;
        if (merged.riskFactorSentence) {
          text += `\n      **종합평가** ${merged.riskFactorSentence}\n`;
        }
      });
    });
  }

  if (activeModules.includes('elbow')) {
    const calc = getModule('elbow')?.computeCalc?.({ shared, module: modules.elbow || {} });
    text += '\n<팔꿈치(주관절)>\n';
    if (calc?.missingCommonFields?.length) {
      text += `- 공통 시간적 선후관계 누락: ${calc.missingCommonFields.join(', ')}\n`;
    }
    if (calc?.temporalFlagItems?.length > 0) {
      text += `- 공통 시간적 선후관계: ${calc.temporalFlagItems.map(flag => flag.label).join(', ')}\n`;
    }
    (calc?.jobSummaries || []).forEach(jobSummary => {
      text += `- ${jobSummary.jobName || '-'}\n`;
      const elbowGroups = groupElbowSummaries(jobSummary.diagnosisSummaries || []);
      elbowGroups.forEach(group => {
        const merged = mergeElbowGroups(group.summaries);
        const diagList = group.summaries
          .map(s => {
            const d = s.diagnosis || {};
            return `${d.code || ''} ${d.name || ''}${d.side ? ` (${getSideText(d.side)})` : ''}`.trim();
          })
          .join(' / ');
        const bkLabel = group.bkType ? ELBOW_BK_LABELS[group.bkType] || group.bkType : null;
        const header = bkLabel ? `[${bkLabel}] ${diagList}` : diagList;
        text += `  - ${header}\n`;
        if (merged.missingFields?.length > 0) {
          text += `    입력 누락: ${merged.missingFields.join(', ')}\n`;
        }
        const riskFactorText = merged.riskFactorItems?.length > 0
          ? merged.riskFactorItems.map(flag => flag.label).join(', ')
          : '확인된 위험 요인 없음';
        text += `    분석 정리:\n`;
        text += `      ${(merged.narrative || '-').split('\n').join('\n      ')}\n`;
        text += `      업무에 포함된 위험 요인: ${riskFactorText}\n`;
        if (merged.riskFactorSentence) {
          text += `\n      **종합평가** ${merged.riskFactorSentence}\n`;
        }
      });
    });
  }

  if (activeModules.includes('cervical')) {
    const calc = getModule('cervical')?.computeCalc?.({ shared, module: modules.cervical || {} });
    text += buildCervicalExposureText(calc);
  }

  if (activeModules.includes('spine')) {
    const calc = getModule('spine')?.computeCalc?.({ shared, module: modules.spine || {} });
    text += buildSpineExposureText(calc);
  }

  return text;
}

// buildExposureSection의 요약본 — b8(EMR 종합소견) byte 절감용. 결론(부담 정도·기여도·
// 누적신체부담·초과 판정)은 남기고, 참고문구·근거 상세·narrative는 뺀다. 전문은
// txtJobCusCont(4.직업적 요인, buildExposureSection)에 그대로 남아 있으므로 정보 손실은 없다.
function buildExposureSummary(shared, modules, activeModules) {
  let text = '[직업력]\n';
  (shared.jobs || []).forEach((job, index) => {
    text += `- 직력${index + 1}: ${job.jobName || '-'} | ${getEffectiveWorkPeriodText(job)}\n`;
  });

  if (activeModules.length > 0) {
    text += '\n[부위별 신체부담 평가]\n';
  }

  if (activeModules.includes('knee')) {
    const calc = getModule('knee')?.computeCalc?.({ shared, module: modules.knee || {} });
    const avgRelatedness = calc?.relatedness
      ? ((Number(calc.relatedness.min) + Number(calc.relatedness.max)) / 2).toFixed(1)
      : null;

    text += '\n<무릎(슬관절)>\n';
    (calc?.jobBurdens || []).filter(job => job.jobName).forEach(job => {
      text += `- ${job.jobName || '-'}: 중량물 ${job.weight || '-'}kg / 쪼그려앉기 ${job.squatting || '-'}분 / 부담 정도 ${job.burden?.level || '-'}\n`;
    });
    if (calc?.relatedness) {
      text += `[신체부담기여도] ${calc.relatedness.min}% ~ ${calc.relatedness.max}% (평균 ${avgRelatedness}%)\n`;
    }
    if (calc?.cumulativeBurden) {
      text += `[누적신체부담] ${calc.cumulativeBurden}\n`;
    }
  }

  if (activeModules.includes('shoulder')) {
    const calc = getModule('shoulder')?.computeCalc?.({ shared, module: modules.shoulder || {} });
    text += '\n<어깨(견관절)>\n';
    const shoulderTotals = calc?.totals || [];
    shoulderTotals.filter(total => total.exceeded || total.ratio >= 0.5).forEach(total => {
      const pct = total.totalHours > 0 ? ` / ${(total.ratio * 100).toFixed(0)}%` : '';
      text += `- ${total.label}: ${total.totalHours > 0 ? `${total.totalHours.toFixed(1)}시간` : '-'} (기준 ${total.limit.toLocaleString()}시간${pct}${total.exceeded ? ' [초과]' : ''})\n`;
    });
    const exceeded = shoulderTotals.filter(t => t.exceeded);
    if (exceeded.length > 0) {
      text += `** ${exceeded.map(t => t.label).join(', ')} 기준을 초과하여 누적 신체부담은 충분함.\n`;
    } else {
      const over75 = shoulderTotals.filter(t => t.ratio >= 0.75);
      const over50 = shoulderTotals.filter(t => t.ratio >= 0.50);
      if (over50.length >= 3 || over75.length >= 2) {
        text += `** 개별 기준 초과 항목은 없으나, 복합 노출을 고려하여 누적 신체부담은 충분함.\n`;
      } else {
        text += `** 노출 기준치에 미달하여 누적 신체부담 불충분함.\n`;
      }
    }
  }

  if (activeModules.includes('wrist')) {
    const calc = getModule('wrist')?.computeCalc?.({ shared, module: modules.wrist || {} });
    text += '\n<손목/손가락>\n';
    (calc?.jobSummaries || []).forEach(jobSummary => {
      const wristGroups = groupWristSummaries(jobSummary.diagnosisSummaries || []);
      wristGroups.forEach(group => {
        const merged = mergeWristGroups(group.summaries);
        const diagList = group.summaries
          .map(s => {
            const d = s.diagnosis || {};
            return `${d.code || ''} ${d.name || ''}${d.side ? ` (${getSideText(d.side)})` : ''}`.trim();
          })
          .join(' / ');
        const bkLabel = group.bkType ? WRIST_BK_LABELS[group.bkType] || group.bkType : null;
        const header = bkLabel ? `[${bkLabel}] ${diagList}` : diagList;
        text += `  - ${header}\n`;
        if (merged.missingFields?.length > 0) {
          text += `    입력 누락: ${merged.missingFields.join(', ')}\n`;
        }
        if (merged.riskFactorSentence) {
          text += `    **종합평가** ${merged.riskFactorSentence}\n`;
        }
      });
    });
  }

  if (activeModules.includes('elbow')) {
    const calc = getModule('elbow')?.computeCalc?.({ shared, module: modules.elbow || {} });
    text += '\n<팔꿈치(주관절)>\n';
    (calc?.jobSummaries || []).forEach(jobSummary => {
      const elbowGroups = groupElbowSummaries(jobSummary.diagnosisSummaries || []);
      elbowGroups.forEach(group => {
        const merged = mergeElbowGroups(group.summaries);
        const diagList = group.summaries
          .map(s => {
            const d = s.diagnosis || {};
            return `${d.code || ''} ${d.name || ''}${d.side ? ` (${getSideText(d.side)})` : ''}`.trim();
          })
          .join(' / ');
        const bkLabel = group.bkType ? ELBOW_BK_LABELS[group.bkType] || group.bkType : null;
        const header = bkLabel ? `[${bkLabel}] ${diagList}` : diagList;
        text += `  - ${header}\n`;
        if (merged.missingFields?.length > 0) {
          text += `    입력 누락: ${merged.missingFields.join(', ')}\n`;
        }
        if (merged.riskFactorSentence) {
          text += `    **종합평가** ${merged.riskFactorSentence}\n`;
        }
      });
    });
  }

  if (activeModules.includes('cervical')) {
    const calc = getModule('cervical')?.computeCalc?.({ shared, module: modules.cervical || {} });
    text += buildCervicalExposureText(calc); // 이미 요약 형태(작업당 1줄)라 그대로 재사용
  }

  if (activeModules.includes('spine')) {
    const calc = getModule('spine')?.computeCalc?.({ shared, module: modules.spine || {} });
    text += buildSpineSectionSummary(calc);
  }

  return text;
}

function formatEmrBoolean(value) {
  if (value === '유') return '(+)';
  if (value === '무') return '(-)';
  return value || '미상';
}

function buildPersonalFactorText(shared, age, bmi) {
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

function formatConsultReplySection(label, value) {
  const trimmed = value?.trim();
  if (!trimmed) return '';
  return `[ ${label} ]\n${trimmed}`;
}

function buildConsultReplySummary(shared) {
  const sections = [
    formatConsultReplySection('정형외과', shared.consultReplyOrtho),
    formatConsultReplySection('신경외과', shared.consultReplyNeuro),
    formatConsultReplySection('재활의학과', shared.consultReplyRehab),
    formatConsultReplySection('기타', shared.consultReplyOther),
  ].filter(Boolean);

  return sections.length > 0 ? `[ 다학제 회신 ]\n${sections.join('\n\n')}` : '';
}

function buildConsultReplySlots(shared) {
  const ortho = formatConsultReplySection('정형외과', shared.consultReplyOrtho);
  const neuro = formatConsultReplySection('신경외과', shared.consultReplyNeuro);
  const rehab = formatConsultReplySection('재활의학과', shared.consultReplyRehab);
  const other = formatConsultReplySection('기타', shared.consultReplyOther);

  let slot2 = '';
  let slot3 = '';

  const append = (slot, text) => (slot ? `${slot}\n${text}` : text);

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

export function generateUnifiedEMR(patient) {
  const shared = patient.data.shared || {};
  const modules = patient.data.modules || {};
  const activeModules = patient.data.activeModules || [];
  const diagnoses = shared.diagnoses || [];
  const groupOutput = !!shared.reportOptions?.groupAssessmentResults;

  const age = calculateAge(shared.birthDate, shared.injuryDate);
  const bmi = calculateBMI(shared.height, shared.weight);

  // 그룹 옵션이 켜졌을 때만 원본 배열 index 기준 번호를 붙인다 — 꺼짐(기존 환자 기본값)이면
  // 현재 출력과 완전히 동일하게 유지된다.
  const b5 = diagnoses
    .map((diag, index) => ({ diag, index }))
    .filter(({ diag }) => diag.code || diag.name)
    .map(({ diag, index }) => {
      const label = `${diag.code || ''} ${diag.name || ''}`.trim();
      return groupOutput ? `#${index + 1}. ${label}` : label;
    })
    .join('\n');

  const b6 = buildExposureSection(shared, modules, activeModules);
  const b7 = buildPersonalFactorText(shared, age, bmi);
  const consultReplySummary = buildConsultReplySummary(shared);

  const assessmentText = groupOutput
    ? formatGroupedAssessment(diagnoses, activeModules)
    : buildAssessmentBlocks(diagnoses, activeModules, { reasonIndent: '    ' }).join('\n\n');

  const b8 = [
    '[ 신체부담 평가 요약 ]\n※ 상세 내용은 4.직업적 요인 항목 참조',
    buildExposureSummary(shared, modules, activeModules),
    '[ 업무관련성 평가 결과 ]',
    assessmentText,
  ].filter(Boolean).join('\n\n');
  const b9 = modules.knee?.returnConsiderations
    || modules.wrist?.returnConsiderations
    || modules.shoulder?.returnConsiderations
    || modules.elbow?.returnConsiderations
    || modules.cervical?.returnConsiderations
    || '';

  return { b5, b6, b7, b8, b9, consultReplySummary };
}

export function generateEMRFieldData(patient) {
  const { b5, b6, b7, b8, b9 } = generateUnifiedEMR(patient);
  const shared = patient.data.shared || {};

  const truncatedFields = [];
  const tMrec = truncateCp949Bytes(shared.medicalRecord || '', EMR_TEXT_LIMIT_BYTES);
  if (tMrec.truncated) truncatedFields.push('txtMrec_Med_Pov_Cont');
  const t6 = truncateCp949Bytes(b6, EMR_TEXT_LIMIT_BYTES);
  if (t6.truncated) truncatedFields.push('txtJobCusCont');
  const t7 = truncateCp949Bytes(b7, EMR_TEXT_LIMIT_BYTES);
  if (t7.truncated) truncatedFields.push('txtPerCusCont');
  const t8 = truncateCp949Bytes(b8, EMR_TEXT_LIMIT_BYTES);
  if (t8.truncated) truncatedFields.push('txtSyth1Cont');

  return {
    txtAppvSickCont: b5 || '',
    txtMrecMedPovCont: tMrec.text,
    txtJobCusCont: t6.text,
    txtPerCusCont: t7.text,
    txtSyth1Cont: t8.text,
    txtArrv1Cont: b9 || '',
    txtIdacDte: shared.injuryDate || '',
    txtCpnyNm: '',
    rdoHcreTypeCd: '2',
    rdoCls: 'M',
    _truncatedFields: truncatedFields,
  };
}

export function generateConsultReplyFieldData(patient) {
  const shared = patient.data.shared || {};
  const consultSlots = buildConsultReplySlots(shared);

  const truncatedFields = [];
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
