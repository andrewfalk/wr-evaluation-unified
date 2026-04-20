import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { getModule } from '../moduleRegistry';
import { getStatusText, getReasonText, getSideText } from '../../modules/knee/utils/calculations';
import { getBk2101RepetitionPerHour } from '../../modules/elbow/utils/calculations';
import { convertTimeToSeconds } from '../../modules/spine/utils/calculations';
import { thresholds } from '../../modules/spine/utils/thresholds';
import { AUX_LABELS } from '../../modules/knee/utils/data';
import { calculateAge, calculateBMI } from './common';
import { getEffectiveWorkPeriodText, getWorkPeriodYearMonth } from './workPeriod';

function buildAssessmentSummary(diagnoses = [], activeModules = []) {
  return diagnoses
    .filter(diag => diag.code || diag.name)
    .map((diag, index) => {
      let summary = `상병 #${index + 1}: ${diag.code || ''} ${diag.name || ''}`.trim();

      if (activeModules.includes('spine') && !diag.side) {
        summary += `\n  평가: 상병 상태(${getStatusText(diag.confirmedRight)}) / 업무관련성(${diag.assessmentRight === 'high' ? '높음' : diag.assessmentRight === 'low' ? '낮음' : '-'})`;
        if (diag.assessmentRight === 'low') {
          summary += `\n    낮음 사유:\n    - ${getReasonText(diag.reasonRight || [], diag.reasonRightOther).split('\n').join('\n    - ')}`;
        }
        return summary;
      }

      if (diag.side === 'right' || diag.side === 'both') {
        summary += `\n  우측: 상병 상태(${getStatusText(diag.confirmedRight)}) / 업무관련성(${diag.assessmentRight === 'high' ? '높음' : diag.assessmentRight === 'low' ? '낮음' : '-'})`;
        if (diag.assessmentRight === 'low') {
          summary += `\n    낮음 사유:\n    - ${getReasonText(diag.reasonRight || [], diag.reasonRightOther).split('\n').join('\n    - ')}`;
        }
      }

      if (diag.side === 'left' || diag.side === 'both') {
        summary += `\n  좌측: 상병 상태(${getStatusText(diag.confirmedLeft)}) / 업무관련성(${diag.assessmentLeft === 'high' ? '높음' : diag.assessmentLeft === 'low' ? '낮음' : '-'})`;
        if (diag.assessmentLeft === 'low') {
          summary += `\n    낮음 사유:\n    - ${getReasonText(diag.reasonLeft || [], diag.reasonLeftOther).split('\n').join('\n    - ')}`;
        }
      }

      return summary;
    })
    .join('\n\n');
}

function formatSpineNumber(value, digits = 2) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(digits) : '-';
}

function formatSpinePercent(item) {
  return Number.isFinite(item?.percent) ? item.percent.toFixed(0) : '0';
}

function formatSpineLimit(item) {
  return Number.isFinite(item?.limit) ? item.limit.toFixed(1) : '-';
}

function isSpineThresholdExceeded(item) {
  return Number.isFinite(item?.percent) && item.percent > 100;
}

function getSpineThresholdStatus(item) {
  return isSpineThresholdExceeded(item) ? '초과' : '미만';
}

function getSpineTaskDose(task) {
  const totalSeconds = convertTimeToSeconds(task.timeValue, task.timeUnit) * (Number(task.frequency) || 0);
  const force = Number(task.force) || 0;
  const singleForceThreshold = thresholds.singleForce;
  const included = force >= singleForceThreshold;
  const dailyContribution = included ? (force * Math.sqrt(totalSeconds)) / 1000 / 60 : 0;

  return {
    totalHours: totalSeconds / 3600,
    dailyContribution,
  };
}

function getSpineInterpretation(comparison) {
  if (!comparison) return '';

  const dws2Limit = formatSpineLimit(comparison.dws2);
  const courtLimit = formatSpineLimit(comparison.court);
  const mddmLimit = formatSpineLimit(comparison.mddm);

  if (isSpineThresholdExceeded(comparison.mddm)) {
    return `** 최신 DWS2 연구 기준(${dws2Limit} MN·h), 독일 연방 사회법원(BSG) 기준(${courtLimit} MN·h), 가장 보수적인 MDDM 최초 모델 기준(${mddmLimit} MN·h)을 모두 초과하여, 직업적 요인을 질병 발생의 주요 원인으로 강하게 추정 가능합니다.`;
  }

  if (isSpineThresholdExceeded(comparison.court)) {
    return `** 최신 DWS2 연구 기준(${dws2Limit} MN·h), 보다 보수적인 독일 연방 사회법원(BSG) 기준(${courtLimit} MN·h)을 초과하여, 직업적 요인을 질병 발생의 주요 원인으로 추정 가능합니다.`;
  }

  if (isSpineThresholdExceeded(comparison.dws2)) {
    return `** 최신 DWS2 연구 기준(${dws2Limit} MN·h)을 초과하여, 직업적 요인의 관여 가능성을 검토할 수 있습니다.`;
  }

  return `** DWS2 연구 기준(${dws2Limit} MN·h), 독일 연방 사회법원(BSG) 기준(${courtLimit} MN·h), MDDM 최초 모델 기준(${mddmLimit} MN·h)에 모두 미달하여, MDDM 누적 노출 기준만으로는 직업적 요인을 주요 원인으로 보기 어렵습니다.`;
}

function buildSpineExposureText(calc) {
  const { tasks, dailyDose, lifetimeDose, comparison, maxForce } = calc || {};
  const spineTasks = tasks || [];
  let text = '\n<허리(요추)>\n';
  text += '독일의 BK2108 장기간의 중량물 취급 또는 허리를 굽히기로 인해 발생한 요추간판 탈출증 평가에서 사용하는 척추 압박력 평가 모델(Mainz-Dortmund Dose Model, MDDM)을 이용하여 평가하였음.\n\n';

  text += '작업별 분석\n';
  if (spineTasks.length === 0) {
    text += '- 입력된 작업 없음\n';
  } else {
    spineTasks.forEach((task, index) => {
      const taskDose = getSpineTaskDose(task);
      text += `작업 ${index + 1}. ${task.name || '-'}\n`;
      text += `자세 ${task.posture || '-'} · ${task.weight || '-'}kg · ${task.frequency || 0}회/일\n`;
      text += `압박력 : ${(task.force || 0).toLocaleString()} N\n`;
      text += `일일 시간: ${formatSpineNumber(taskDose.totalHours, 3)} h | 일일 기여: ${formatSpineNumber(taskDose.dailyContribution, 2)} kN·h\n`;
    });
  }

  text += '\n종합\n';
  text += `- 최대 압박력: ${(maxForce || 0).toLocaleString()} N\n`;
  const dailyKNh = dailyDose?.dailyDoseKNh || 0;
  const mf = maxForce || 0;
  let severityLabel;
  if (dailyKNh > 4 || mf >= 6000) severityLabel = '고도';
  else if (dailyKNh > 3 || mf >= 5000) severityLabel = '중등도상';
  else if (dailyKNh >= 2 || mf >= 4000) severityLabel = '중등도하';
  else severityLabel = '경도';
  text += `- 일일 노출량: ${dailyKNh.toFixed(2)} kN·h (${severityLabel})\n`;
  text += `- **누적 노출량: ${lifetimeDose?.lifetimeDoseMNh?.toFixed(2) || '0.00'} MN·h **\n`;

  if (comparison) {
    text += '\n기준치 대비\n';
    text += `- **DWS2(독일 척추 연구) 기준 대비 : ${formatSpinePercent(comparison.dws2)}% (${formatSpineLimit(comparison.dws2)} MN·h) : ${getSpineThresholdStatus(comparison.dws2)}\n`;
    text += `- 독일 연방 사회법원(BSG) 기준 대비 : ${formatSpinePercent(comparison.court)}% (${formatSpineLimit(comparison.court)} MN·h) : ${getSpineThresholdStatus(comparison.court)}\n`;
    text += `- MDDM 최초 모델 기준 대비 : ${formatSpinePercent(comparison.mddm)}% (${formatSpineLimit(comparison.mddm)} MN·h) : ${getSpineThresholdStatus(comparison.mddm)}\n\n`;
    text += `${getSpineInterpretation(comparison)}\n`;
  }

  return text;
}

function buildExposureSection(shared, modules, activeModules) {
  let text = '[직업력]\n';
  (shared.jobs || []).forEach((job, index) => {
    text += `- 직력${index + 1}: ${job.jobName || '-'} | ${getEffectiveWorkPeriodText(job)}\n`;
  });

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
      (jobSummary.diagnosisSummaries || []).forEach(summary => {
        const diagnosis = summary.diagnosis || {};
        const riskFactorText = summary.riskFactorItems?.length > 0
          ? summary.riskFactorItems.map(flag => flag.label).join(', ')
          : '확인된 위험 요인 없음';

        text += `  - ${diagnosis.code || ''} ${diagnosis.name || ''}${diagnosis.side ? ` (${getSideText(diagnosis.side)})` : ''}\n`;
        if (summary.missingFields?.length > 0) {
          text += `    입력 누락: ${summary.missingFields.join(', ')}\n`;
        }
        text += `    분석 정리:\n`;
        text += `      ${(summary.narrative || '-').split('\n').join('\n      ')}\n`;
        text += `      업무에 포함된 위험 요인: ${riskFactorText}\n`;
        if (summary.riskFactorSentence) {
          text += `\n      **종합평가** ${summary.riskFactorSentence}\n`;
        }
      });
    });
  }

  if (activeModules.includes('spine')) {
    const calc = getModule('spine')?.computeCalc?.({ shared, module: modules.spine || {} });
    text += buildSpineExposureText(calc);
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

function generateUnifiedEMR(patient) {
  const shared = patient.data.shared || {};
  const modules = patient.data.modules || {};
  const activeModules = patient.data.activeModules || [];
  const diagnoses = shared.diagnoses || [];

  const age = calculateAge(shared.birthDate, shared.injuryDate);
  const bmi = calculateBMI(shared.height, shared.weight);

  const b5 = diagnoses
    .filter(diag => diag.code || diag.name)
    .map(diag => `${diag.code || ''} ${diag.name || ''}`.trim())
    .join('\n');

  const b6 = buildExposureSection(shared, modules, activeModules);
  const b7 = buildPersonalFactorText(shared, age, bmi);
  const consultReplySummary = buildConsultReplySummary(shared);
  const b8 = [
    b6,
    '[ 업무관련성 평가 결과 ]',
    buildAssessmentSummary(diagnoses, activeModules),
  ].filter(Boolean).join('\n\n');
  const b9 = modules.knee?.returnConsiderations || modules.shoulder?.returnConsiderations || modules.elbow?.returnConsiderations || '';

  return { b5, b6, b7, b8, b9, consultReplySummary };
}

function buildUnifiedWorkbook(patient) {
  const shared = patient.data.shared || {};
  const { b5, b6, b7, b8, b9, consultReplySummary } = generateUnifiedEMR(patient);
  const b8Full = consultReplySummary ? b8 + '\n\n' + consultReplySummary : b8;
  const wb = XLSX.utils.book_new();
  const wsData = [
    ['업무관련성특별진찰소견서(근골격계질병)', ''],
    ['항목', '내용'],
    ['1.신청상병명', ''],
    ['2.진료기록 및 의학적 소견', ''],
    ['3.최종 확인 상병명', b5],
    ['4.직업적 요인', b6],
    ['5.개인적 요인', b7],
    ['6.종합소견', b8Full],
    ['7.복귀 관련 고려사항', b9]
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 25 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, ws, '업무관련성평가');
  const name = (shared.name || '미입력').replace(/[\\/:*?"<>|]/g, '_');
  const date = (shared.injuryDate || new Date().toISOString().split('T')[0]).replace(/[\\/:*?"<>|]/g, '-');
  return { wb, fileName: `업무관련성평가_${name}_${date}.xlsx` };
}

export function exportSingle(patient) {
  const { wb, fileName } = buildUnifiedWorkbook(patient);
  XLSX.writeFile(wb, fileName);
}

async function exportAsZip(patientList, zipName) {
  const zip = new JSZip();
  const usedNames = {};

  for (const patient of patientList) {
    try {
      const { wb, fileName } = buildUnifiedWorkbook(patient);
      let finalName = fileName;
      if (usedNames[fileName]) {
        usedNames[fileName] += 1;
        finalName = fileName.replace('.xlsx', `_${usedNames[fileName]}.xlsx`);
      } else {
        usedNames[fileName] = 1;
      }

      const xlsxBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      zip.file(finalName, xlsxBuffer);
    } catch (error) {
      console.error(`Export failed: ${patient.data.shared?.name || 'unknown'}`, error);
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = zipName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function exportSelected(patients, selectedIds) {
  const selected = patients.filter(patient => selectedIds.has(patient.id) && patient.data.shared?.name);
  if (selected.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  await exportAsZip(selected, `업무관련성평가_선택${selected.length}명_${date}.zip`);
}

export async function exportBatch(patients) {
  const valid = patients.filter(patient => patient.data.shared?.name);
  if (valid.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  await exportAsZip(valid, `업무관련성평가_${valid.length}명_${date}.zip`);
}

const BATCH_HEADERS = [
  '이름', '생년월일', '재해일자', '키', '체중', '성별',
  '병원명', '진료과', '담당의', '특이사항', '복귀고려사항',
  '진단코드', '진단명', '방향', 'KLG(우)', 'KLG(좌)', 'Ellman(우)', 'Ellman(좌)',
  '직종명', '시작일', '종료일', '근무기간(년)', '근무기간(개월)',
  '중량물(kg)', '쪼그려앉기(분)', '계단오르내리기', '무릎비틀기', '출발정지반복', '좁은공간', '무릎접촉충격', '점프착지',
  '오버헤드(시간/일)', '반복중간(시간/일)', '반복빠름(시간/일)', '중량물횟수(회/일)', '중량물시간(초/회)', '진동(시간/일)',
  '팔꿈치_시간적선후관계_최근작업변화', '팔꿈치_시간적선후관계_작업변화시점', '팔꿈치_시간적선후관계_증상발생까지기간', '팔꿈치_시간적선후관계_휴식시호전',
  '팔꿈치_BK유형', '팔꿈치_BK선택방식', '팔꿈치_문제작업명', '팔꿈치_핵심동작연결성', '팔꿈치_공통핵심노출유형', '팔꿈치_반복동작정도',
  '팔꿈치_1일노출시간', '팔꿈치_하루작업비중', '팔꿈치_주당수행일수', '팔꿈치_작업형태', '팔꿈치_휴식분포',
  '팔꿈치_힘사용', '팔꿈치_비중립자세', '팔꿈치_정적유지', '팔꿈치_직접압박수준', '팔꿈치_진동노출',
  '팔꿈치_BK2101_주기초', '팔꿈치_BK2101_시간당반복횟수', '팔꿈치_BK2101_단조반복', '팔꿈치_BK2101_배측굴곡', '팔꿈치_BK2101_회내회외',
  '팔꿈치_BK2103_진동공구종류', '팔꿈치_BK2103_진동시간', '팔꿈치_BK2103_공구를강하게쥐거나누르면서사용하는작업',
  '팔꿈치_BK2105_팔꿈치지지', '팔꿈치_BK2105_압박원인',
  '팔꿈치_BK2106_압박원인',
  '작업명', '자세코드', '작업중량(kg)', '횟수/분', '시간값', '시간단위', '보정계수',
];

const GENDER_REVERSE = { male: '남', female: '여' };
const SIDE_REVERSE = { right: '우측', left: '좌측', both: '양측' };

function generateBatchRows(patientList) {
  const rows = [];

  for (const patient of patientList) {
    const shared = patient.data.shared || {};
    const modules = patient.data.modules || {};
    const diagnoses = (shared.diagnoses || []).filter(diag => diag.code || diag.name);
    const jobs = shared.jobs || [];
    const kneeExtras = modules.knee?.jobExtras || [];
    const shoulderExtras = modules.shoulder?.jobExtras || [];
    const spineTasks = modules.spine?.tasks || [];
    const elbowTemporal = modules.elbow?.temporalSequence || modules.elbow?.temporalRelation || {};
    const elbowJobEvaluations = modules.elbow?.jobEvaluations || [];

    const firstJobId = jobs[0]?.id || '';
    const jobTaskPairs = [];
    const elbowPairs = [];

    if (jobs.length > 0) {
      for (const job of jobs) {
        const jobSpineTasks = spineTasks.filter(task => (task.sharedJobId || firstJobId) === job.id);
        const kneeExtra = kneeExtras.find(extra => extra.sharedJobId === job.id) || null;
        const elbowJobEvaluation = elbowJobEvaluations.find(item => item.sharedJobId === job.id);

        (elbowJobEvaluation?.diagnosisEntries || []).forEach(entry => {
          const diagnosis = diagnoses.find(item => item.id === entry.diagnosisId);
          if (diagnosis) {
            elbowPairs.push({ job, diagnosis, entry });
          }
        });

        if (jobSpineTasks.length > 0) {
          jobSpineTasks.forEach(task => jobTaskPairs.push({ job, task, kneeExtra }));
        } else {
          jobTaskPairs.push({ job, task: null, kneeExtra });
        }
      }
    } else {
      spineTasks.forEach(task => jobTaskPairs.push({ job: null, task, kneeExtra: null }));
    }

    const rowCount = Math.max(1, diagnoses.length, jobTaskPairs.length, elbowPairs.length);

    for (let index = 0; index < rowCount; index += 1) {
      const row = [];
      const isFirst = index === 0;
      const elbowPair = elbowPairs[index] || null;
      const pair = jobTaskPairs[index];
      const diag = elbowPair?.diagnosis || diagnoses[index];
      const job = elbowPair?.job || pair?.job;
      const task = pair?.task;
      const kneeExtra = job ? (pair?.kneeExtra || kneeExtras.find(extra => extra.sharedJobId === job.id) || null) : pair?.kneeExtra;
      const shoulderExtra = job ? shoulderExtras.find(extra => extra.sharedJobId === job.id) : null;
      const elbowEntry = elbowPair?.entry || null;

      row.push(shared.name || '');
      row.push(shared.birthDate || '');
      row.push(shared.injuryDate || '');
      row.push(isFirst ? (shared.height || '') : '');
      row.push(isFirst ? (shared.weight || '') : '');
      row.push(isFirst ? (GENDER_REVERSE[shared.gender] || '') : '');
      row.push(isFirst ? (shared.hospitalName || '') : '');
      row.push(isFirst ? (shared.department || '') : '');
      row.push(isFirst ? (shared.doctorName || '') : '');
      row.push(isFirst ? (shared.specialNotes || '') : '');
      row.push(isFirst ? (modules.knee?.returnConsiderations || modules.shoulder?.returnConsiderations || modules.elbow?.returnConsiderations || '') : '');

      row.push(diag?.code || '');
      row.push(diag?.name || '');
      row.push(diag ? (SIDE_REVERSE[diag.side] || '') : '');
      row.push(diag?.klgRight || '');
      row.push(diag?.klgLeft || '');
      row.push(diag?.ellmanRight || '');
      row.push(diag?.ellmanLeft || '');

      row.push(job?.jobName || '');
      row.push(job?.startDate || '');
      row.push(job?.endDate || '');
      if (job) {
        const yearMonth = getWorkPeriodYearMonth(job);
        row.push(yearMonth.years || '');
        row.push(yearMonth.months || '');
      } else {
        row.push('');
        row.push('');
      }

      row.push(kneeExtra?.weight || '');
      row.push(kneeExtra?.squatting || '');
      row.push(kneeExtra?.stairs ? 'O' : '');
      row.push(kneeExtra?.kneeTwist ? 'O' : '');
      row.push(kneeExtra?.startStop ? 'O' : '');
      row.push(kneeExtra?.tightSpace ? 'O' : '');
      row.push(kneeExtra?.kneeContact ? 'O' : '');
      row.push(kneeExtra?.jumpDown ? 'O' : '');

      row.push(shoulderExtra?.overheadHours ?? '');
      row.push(shoulderExtra?.repetitiveMediumHours ?? '');
      row.push(shoulderExtra?.repetitiveFastHours ?? '');
      row.push(shoulderExtra?.heavyLoadCount ?? '');
      row.push(shoulderExtra?.heavyLoadSeconds ?? '');
      row.push(shoulderExtra?.vibrationHours ?? '');

      row.push(isFirst ? (elbowTemporal.recent_task_change || '') : '');
      row.push(isFirst ? (elbowTemporal.task_change_date || '') : '');
      row.push(isFirst ? (elbowTemporal.symptom_onset_interval || '') : '');
      row.push(isFirst ? (elbowTemporal.improves_with_rest || '') : '');
      row.push(elbowEntry?.selectedBkType || '');
      row.push(elbowEntry?.bkSelectionMode || '');
      row.push(elbowEntry?.main_task_name || '');
      row.push(elbowEntry?.direct_anatomic_link || '');
      row.push((elbowEntry?.exposure_types || []).join('|'));
      row.push(elbowEntry?.repetition_level || '');
      row.push(elbowEntry?.daily_exposure_hours || '');
      row.push(elbowEntry?.shift_share_percent || '');
      row.push(elbowEntry?.days_per_week || '');
      row.push(elbowEntry?.work_pattern || '');
      row.push(elbowEntry?.rest_distribution || '');
      row.push(elbowEntry?.force_level || '');
      row.push(elbowEntry?.awkward_posture_level || '');
      row.push(elbowEntry?.static_holding_level || '');
      row.push(elbowEntry?.direct_pressure_level || '');
      row.push(elbowEntry?.vibration_exposure || '');

      row.push(elbowEntry?.bk2101_cycle_seconds || '');
      row.push(elbowEntry ? getBk2101RepetitionPerHour(elbowEntry) || '' : '');
      row.push(elbowEntry?.bk2101_monotony || '');
      row.push(elbowEntry?.bk2101_forced_dorsal_extension || '');
      row.push(elbowEntry?.bk2101_prosupination || '');

      row.push((elbowEntry?.bk2103_vibration_tool_type || []).join('|'));
      row.push(elbowEntry?.bk2103_daily_vibration_hours || '');
      row.push(elbowEntry?.bk2103_tool_pressing || '');

      row.push(elbowEntry?.bk2105_elbow_leaning || '');
      row.push((elbowEntry?.bk2105_pressure_source || []).join('|'));
      row.push((elbowEntry?.bk2106_pressure_source || []).join('|'));

      row.push(task?.name || '');
      row.push(task?.posture || '');
      row.push(task?.weight ?? '');
      row.push(task?.frequency ?? '');
      row.push(task?.timeValue ?? '');
      row.push(task?.timeUnit || '');
      row.push(task?.correctionFactor ?? '');

      rows.push(row);
    }
  }

  return rows;
}

function buildBatchWorkbook(patientList) {
  const dataRows = generateBatchRows(patientList);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([BATCH_HEADERS, ...dataRows]);
  ws['!cols'] = BATCH_HEADERS.map(() => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, ws, '일괄입력');
  return wb;
}

export function exportBatchFormatSingle(patient) {
  const name = (patient.data.shared?.name || '미입력').replace(/[\\/:*?"<>|]/g, '_');
  const date = new Date().toISOString().split('T')[0];
  XLSX.writeFile(buildBatchWorkbook([patient]), `일괄입력_${name}_${date}.xlsx`);
}

export function exportBatchFormatSelected(patients, selectedIds) {
  const selected = patients.filter(patient => selectedIds.has(patient.id) && patient.data.shared?.name);
  if (selected.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  XLSX.writeFile(buildBatchWorkbook(selected), `일괄입력_${selected.length}명_${date}.xlsx`);
}

export function exportBatchFormatAll(patients) {
  const valid = patients.filter(patient => patient.data.shared?.name);
  if (valid.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  XLSX.writeFile(buildBatchWorkbook(valid), `일괄입력_${valid.length}명_${date}.xlsx`);
}

function truncateBytes(str, maxBytes, suffix = '\n...(이하 생략)') {
  if (!str) return { text: '', truncated: false };

  const suffixBytes = new Blob([suffix]).size;
  const totalBytes = new Blob([str]).size;
  if (totalBytes <= maxBytes) return { text: str, truncated: false };

  const limit = maxBytes - suffixBytes;
  let bytes = 0;
  let cutIndex = 0;
  for (const ch of str) {
    const charBytes = new Blob([ch]).size;
    if (bytes + charBytes > limit) break;
    bytes += charBytes;
    cutIndex += ch.length;
  }

  return { text: str.slice(0, cutIndex) + suffix, truncated: true };
}

export function generateEMRFieldData(patient) {
  const { b5, b6, b7, b8, b9 } = generateUnifiedEMR(patient);
  const shared = patient.data.shared || {};

  const truncatedFields = [];
  const tMrec = truncateBytes(shared.medicalRecord || '', 4000);
  if (tMrec.truncated) truncatedFields.push('txtMrec_Med_Pov_Cont');
  const t6 = truncateBytes(b6, 4000);
  if (t6.truncated) truncatedFields.push('txtJobCusCont');
  const t7 = truncateBytes(b7, 4000);
  if (t7.truncated) truncatedFields.push('txtPerCusCont');
  const t8 = truncateBytes(b8, 4000);
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
  const tSyth2 = truncateBytes(consultSlots.slot2, 4000);
  if (tSyth2.truncated) truncatedFields.push('txtSyth2Cont');
  const tSyth3 = truncateBytes(consultSlots.slot3, 4000);
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
