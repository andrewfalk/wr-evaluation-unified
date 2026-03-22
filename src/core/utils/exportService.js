import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { getModule } from '../moduleRegistry';
import { getSideText, getStatusText, getReasonText } from '../../modules/knee/utils/calculations';
import { AUX_LABELS } from '../../modules/knee/utils/data';
import { calculateAge, calculateBMI } from './common';
import { getEffectiveWorkPeriodText } from './workPeriod';

function generateUnifiedEMR(patient) {
  const shared = patient.data.shared || {};
  const modules = patient.data.modules || {};
  const activeModules = patient.data.activeModules || [];
  const diagnoses = shared.diagnoses || [];
  const jobs = shared.jobs || [];

  const age = calculateAge(shared.birthDate, shared.injuryDate);
  const bmi = calculateBMI(shared.height, shared.weight);

  const hasKnee = activeModules.includes('knee');
  const hasSpine = activeModules.includes('spine');

  // --- b5: 최종 확인 상병명 ---
  const b5 = diagnoses
    .filter(d => d.code || d.name)
    .map(d => {
      let line = `${d.code || ''} ${d.name || ''}`.trim();
      if (hasKnee) {
        if (d.side === 'right' || d.side === 'both') {
          line += `\n  - 우측: 상병 상태(${getStatusText(d.confirmedRight)}) / 업무관련성(${d.assessmentRight === 'high' ? '높음' : d.assessmentRight === 'low' ? '낮음' : '-'})`;
          if (d.assessmentRight === 'low') line += `\n    업무관련성 평가 낮음 사유:\n    - ${getReasonText(d.reasonRight, d.reasonRightOther).split('\n').join('\n    - ')}`;
        }
        if (d.side === 'left' || d.side === 'both') {
          line += `\n  - 좌측: 상병 상태(${getStatusText(d.confirmedLeft)}) / 업무관련성(${d.assessmentLeft === 'high' ? '높음' : d.assessmentLeft === 'low' ? '낮음' : '-'})`;
          if (d.assessmentLeft === 'low') line += `\n    업무관련성 평가 낮음 사유:\n    - ${getReasonText(d.reasonLeft, d.reasonLeftOther).split('\n').join('\n    - ')}`;
        }
      }
      return line;
    }).join('\n\n');

  // --- b6: 직업적 요인 ---
  let b6 = `[직업력]\n`;
  jobs.forEach((j, i) => {
    b6 += `- 직력${i + 1}: ${j.jobName || '-'} | ${getEffectiveWorkPeriodText(j)}\n`;
  });

  if (hasKnee) {
    const kneeMod = getModule('knee');
    const kneeCalc = kneeMod?.computeCalc?.({ shared, module: modules.knee || {} }) || {};
    const { relatedness: rel, cumulativeBurden: cum, jobBurdens: jb } = kneeCalc;

    b6 += `\n<무릎 (슬관절) 신체부담평가>\n`;
    (jb || []).filter(j => j.jobName).forEach(j => {
      const checked = Object.entries(AUX_LABELS).filter(([k]) => j[k]).map(([, v]) => v);
      b6 += `- ${j.jobName}: ${j.period} | 중량물 ${j.weight || '-'}kg | 쪼그려앉기 ${j.squatting || '-'}분 | 신체부담 ${j.burden.level}\n`;
      if (checked.length > 0) b6 += `  보조: ${checked.join(', ')}\n`;
    });
    const burdenNote = `참고) 신체부담 정도는 다음의 4단계로 구분함.\n1) 고도: 퇴행성 변화를 유발 또는 가속하는 것이 확실함(definite)\n2) 중등도상: 퇴행성 변화를 유발 또는 가속하기에 충분함(probable)\n3) 중등도하: 퇴행성 변화를 유발 또는 가속할 가능성이 있음(possible)\n4) 경도: 퇴행성 변화를 유발 또는 가속하기 어려움(no related)`;
    b6 += `\n${burdenNote}\n`;
    if (rel) {
      const avgRel = ((+rel.min + +rel.max) / 2).toFixed(1);
      b6 += `\n[신체부담기여도 평가]\n- 최소: ${rel.min}%\n- 최대: ${rel.max}%\n- 평균: ${avgRel}%\n`;
      b6 += `\n[누적신체부담]\n- ${cum}\n`;
    }
  }

  if (hasSpine) {
    const spineMod = getModule('spine');
    const spineCalc = spineMod?.computeCalc?.({ shared, module: modules.spine || {} }) || {};
    const { dailyDose, lifetimeDose, comparison, workRelatedness, maxForce } = spineCalc;

    b6 += `\n<척추 (요추) MDDM 평가>\n`;
    b6 += `[평가 결과]\n`;
    b6 += `최대 압박력: ${(maxForce || 0).toLocaleString()} N\n`;
    b6 += `일일선량: ${dailyDose?.dailyDoseKNh?.toFixed(2) || '0.00'} kN\xB7h\n`;
    b6 += `누적선량: ${lifetimeDose?.lifetimeDoseMNh?.toFixed(2) || '0.00'} MN\xB7h\n`;
    if (comparison) {
      b6 += `\n[기준 비교]\n`;
      b6 += `DWS2: ${comparison.dws2.percent.toFixed(0)}% (${comparison.dws2.limit} MN\xB7h)\n`;
      b6 += `법원기준: ${comparison.court.percent.toFixed(0)}% (${comparison.court.limit} MN\xB7h)\n`;
      b6 += `MDDM: ${comparison.mddm.percent.toFixed(0)}% (${comparison.mddm.limit} MN\xB7h)\n`;
    }
    if (workRelatedness) {
      b6 += `\n[업무관련성] ${workRelatedness.grade} (기여도: ${workRelatedness.workContribution}%)\n`;
      b6 += `${workRelatedness.detail}\n`;
    }
  }

  // --- b7: 개인적 요인 ---
  const b7 = `- 키: ${shared.height || '-'}cm\n- 몸무게: ${shared.weight || '-'}kg\n- BMI: ${bmi || '-'}\n- 나이: ${age || '-'}세 (재해일 기준)\n- 특이사항: ${shared.specialNotes || '없음'}`;

  // --- b8: 종합소견 ---
  let b8 = '';

  if (hasKnee) {
    const kneeMod = getModule('knee');
    const kneeCalc = kneeMod?.computeCalc?.({ shared, module: modules.knee || {} }) || {};
    const { relatedness: rel, cumulativeBurden: cum } = kneeCalc;
    if (rel) {
      b8 += `[신체부담기여도]\n- 신체부담기여도: ${rel.min}% ~ ${rel.max}%\n- 누적신체부담: ${cum}\n\n`;
    }
  }

  b8 += `[상병별 종합소견]\n`;
  b8 += diagnoses.filter(d => d.code || d.name).map((d, i) => {
    let summary = `#${i + 1}. ${d.code} ${d.name} (${getSideText(d.side)})`;
    if (hasKnee) {
      if (d.side === 'right' || d.side === 'both') {
        summary += `\n   상병 상태: ${getStatusText(d.confirmedRight)} / 업무관련성: ${d.assessmentRight === 'high' ? '높음' : d.assessmentRight === 'low' ? '낮음' : '-'}`;
        if (d.assessmentRight === 'low') summary += `\n   낮음 사유:\n   - ${getReasonText(d.reasonRight, d.reasonRightOther).split('\n').join('\n   - ')}`;
      }
      if (d.side === 'left' || d.side === 'both') {
        summary += `\n   상병 상태: ${getStatusText(d.confirmedLeft)} / 업무관련성: ${d.assessmentLeft === 'high' ? '높음' : d.assessmentLeft === 'low' ? '낮음' : '-'}`;
        if (d.assessmentLeft === 'low') summary += `\n   낮음 사유:\n   - ${getReasonText(d.reasonLeft, d.reasonLeftOther).split('\n').join('\n   - ')}`;
      }
    }
    return summary;
  }).join('\n\n');

  // --- b9: 복귀 관련 고려사항 ---
  const b9 = modules.knee?.returnConsiderations || '';

  return { b5, b6, b7, b8, b9 };
}

function buildUnifiedWorkbook(patient) {
  const shared = patient.data.shared || {};
  const { b5, b6, b7, b8, b9 } = generateUnifiedEMR(patient);
  const wb = XLSX.utils.book_new();
  const wsData = [
    ['업무관련성특별진찰소견서(근골격계질병)', ''],
    ['항목', '내용'],
    ['1.신청상병명', ''],
    ['2.진료기록 및 의학적 소견', ''],
    ['3.최종 확인 상병명', b5],
    ['4.직업적 요인', b6],
    ['5.개인적 요인', b7],
    ['6.종합소견', b8],
    ['7.복귀 관련 고려사항', b9]
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 25 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, ws, '업무관련성특별진찰소견서(근골격계질병)');
  const name = shared.name || '미입력';
  const date = shared.injuryDate || new Date().toISOString().split('T')[0];
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
    const { wb, fileName } = buildUnifiedWorkbook(patient);
    let finalName = fileName;
    if (usedNames[fileName]) {
      usedNames[fileName]++;
      finalName = fileName.replace('.xlsx', `_${usedNames[fileName]}.xlsx`);
    } else {
      usedNames[fileName] = 1;
    }
    const xlsxBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    zip.file(finalName, xlsxBuffer);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = zipName;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportSelected(patients, selectedIds) {
  const selected = patients.filter(p => selectedIds.has(p.id) && p.data.shared?.name);
  if (selected.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  await exportAsZip(selected, `업무관련성평가_선택${selected.length}명_${date}.zip`);
}

export async function exportBatch(patients) {
  const valid = patients.filter(p => p.data.shared?.name);
  if (valid.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  await exportAsZip(valid, `업무관련성평가_${valid.length}명_${date}.zip`);
}
