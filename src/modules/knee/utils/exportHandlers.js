import * as XLSX from 'xlsx';
import html2pdf from 'html2pdf.js';
import { AUX_LABELS } from './data';
import { computeKneeCalc, getSideText, getStatusText, getReasonText } from './calculations';

export const genKneeReport = (patientData, c) => {
  const shared = patientData.shared || {};
  const mod = patientData.module || {};
  const { age, bmi, relatedness: r, cumulativeBurden: cum, jobBurdens: jb } = c || computeKneeCalc(patientData);
  const diagnoses = shared.diagnoses || [];

  let t = `업무관련성 특별진찰 소견서\n\n이름: ${shared.name}(${shared.gender === 'male' ? '남' : shared.gender === 'female' ? '여' : ''})\n`;
  t += `키/몸무게: ${shared.height || '-'}cm / ${shared.weight || '-'}kg (BMI: ${bmi || '-'})\n`;
  t += `생년월일: ${shared.birthDate || '-'}\n재해일자: ${shared.injuryDate || '-'} (만 ${age}세)\n\n`;
  t += `[신청 상병]\n`;
  diagnoses.forEach((d, i) => {
    if (d.code || d.name) t += `#${i + 1}. ${d.code} ${d.name} (${getSideText(d.side)})\n`;
  });
  t += `\n[특이사항]\n${shared.specialNotes || '-'}\n\n[직업력]\n`;
  jb.forEach((j, i) => {
    const checked = Object.entries(AUX_LABELS).filter(([k]) => j[k]).map(([, v]) => v);
    t += `직력${i + 1}: ${j.jobName || '-'} | ${j.period} | ${j.weight || '-'}kg | ${j.squatting || '-'}분 | ${j.burden.level}\n`;
    if (checked.length > 0) t += `  보조: ${checked.join(', ')}\n`;
  });
  t += `\n참고) 신체부담 정도는 다음의 4단계로 구분함.\n`;
  t += `1) 고도: 퇴행성 변화를 유발 또는 가속하는 것이 확실함(definite)\n`;
  t += `2) 중등도상: 퇴행성 변화를 유발 또는 가속하기에 충분함(probable)\n`;
  t += `3) 중등도하: 퇴행성 변화를 유발 또는 가속할 가능성이 있음(possible)\n`;
  t += `4) 경도: 퇴행성 변화를 유발 또는 가속하기 어려움(no related)\n`;
  t += `\n[신체부담기여도] ${r.min}% ~ ${r.max}%\n[누적신체부담] ${cum}\n\n[종합소견]\n`;

  diagnoses.forEach((d, i) => {
    if (d.code || d.name) {
      t += `\n상병 #${i + 1}: ${d.code} ${d.name}\n`;
      if (d.side === 'right' || d.side === 'both') {
        t += `  우측: 상병 상태(${getStatusText(d.confirmedRight)}) / 업무관련성(${d.assessmentRight === 'high' ? '높음' : d.assessmentRight === 'low' ? '낮음' : '-'})`;
        if (d.assessmentRight === 'low') t += `\n    낮음 사유:\n    - ${getReasonText(d.reasonRight, d.reasonRightOther).split('\n').join('\n    - ')}`;
        t += `\n`;
      }
      if (d.side === 'left' || d.side === 'both') {
        t += `  좌측: 상병 상태(${getStatusText(d.confirmedLeft)}) / 업무관련성(${d.assessmentLeft === 'high' ? '높음' : d.assessmentLeft === 'low' ? '낮음' : '-'})`;
        if (d.assessmentLeft === 'low') t += `\n    낮음 사유:\n    - ${getReasonText(d.reasonLeft, d.reasonLeftOther).split('\n').join('\n    - ')}`;
        t += `\n`;
      }
    }
  });

  if (mod.returnConsiderations) t += `\n[복귀 관련 고려사항]\n${mod.returnConsiderations}\n`;
  t += `\n${'─'.repeat(50)}\n${shared.evaluationDate}\n${shared.hospitalName} ${shared.department}\n담당의: ${shared.doctorName}`;
  return t;
};

const generateEMRData = (patientData, c) => {
  const shared = patientData.shared || {};
  const mod = patientData.module || {};
  const { age, bmi, relatedness: rel, cumulativeBurden: cum, jobBurdens: jb } = c || computeKneeCalc(patientData);
  const diagnoses = shared.diagnoses || [];

  const b5 = diagnoses
    .filter(d => d.confirmedCode || d.confirmedName)
    .map(d => {
      let line = `${d.confirmedCode || ''} ${d.confirmedName || ''}`.trim();
      if (d.side === 'right' || d.side === 'both') {
        line += `\n  - 우측: 상병 상태(${getStatusText(d.confirmedRight)}) / 업무관련성(${d.assessmentRight === 'high' ? '높음' : d.assessmentRight === 'low' ? '낮음' : '-'})`;
        if (d.assessmentRight === 'low') line += `\n    업무관련성 평가 낮음 사유:\n    - ${getReasonText(d.reasonRight, d.reasonRightOther).split('\n').join('\n    - ')}`;
      }
      if (d.side === 'left' || d.side === 'both') {
        line += `\n  - 좌측: 상병 상태(${getStatusText(d.confirmedLeft)}) / 업무관련성(${d.assessmentLeft === 'high' ? '높음' : d.assessmentLeft === 'low' ? '낮음' : '-'})`;
        if (d.assessmentLeft === 'low') line += `\n    업무관련성 평가 낮음 사유:\n    - ${getReasonText(d.reasonLeft, d.reasonLeftOther).split('\n').join('\n    - ')}`;
      }
      return line;
    }).join('\n\n');

  const jobLines = jb.filter(j => j.jobName).map(j => {
    const checked = Object.entries(AUX_LABELS).filter(([k]) => j[k]).map(([, v]) => v);
    let line = `- ${j.jobName}: ${j.period} | 중량물 ${j.weight || '-'}kg | 쪼그려앉기 ${j.squatting || '-'}분 | 신체부담 ${j.burden.level}`;
    if (checked.length > 0) line += `\n  보조: ${checked.join(', ')}`;
    return line;
  }).join('\n');
  const avgRel = ((+rel.min + +rel.max) / 2).toFixed(1);
  const burdenNote = `참고) 신체부담 정도는 다음의 4단계로 구분함.\n1) 고도: 퇴행성 변화를 유발 또는 가속하는 것이 확실함(definite)\n2) 중등도상: 퇴행성 변화를 유발 또는 가속하기에 충분함(probable)\n3) 중등도하: 퇴행성 변화를 유발 또는 가속할 가능성이 있음(possible)\n4) 경도: 퇴행성 변화를 유발 또는 가속하기 어려움(no related)`;
  const b6 = `[직업력]\n${jobLines}\n\n${burdenNote}\n\n[신체부담기여도 평가]\n- 최소: ${rel.min}%\n- 최대: ${rel.max}%\n- 평균: ${avgRel}%\n\n[누적신체부담]\n- ${cum}`;
  const b7 = `- 키: ${shared.height || '-'}cm\n- 몸무게: ${shared.weight || '-'}kg\n- BMI: ${bmi || '-'}\n- 나이: ${age || '-'}세 (재해일 기준)\n- 특이사항: ${shared.specialNotes || '없음'}`;

  const diagSummary = diagnoses.filter(d => d.code || d.name).map((d, i) => {
    let summary = `#${i + 1}. ${d.code} ${d.name} (${getSideText(d.side)})`;
    if (d.side === 'right' || d.side === 'both') {
      summary += `\n   상병 상태: ${getStatusText(d.confirmedRight)} / 업무관련성: ${d.assessmentRight === 'high' ? '높음' : d.assessmentRight === 'low' ? '낮음' : '-'}`;
      if (d.assessmentRight === 'low') summary += `\n   낮음 사유:\n   - ${getReasonText(d.reasonRight, d.reasonRightOther).split('\n').join('\n   - ')}`;
    }
    if (d.side === 'left' || d.side === 'both') {
      summary += `\n   상병 상태: ${getStatusText(d.confirmedLeft)} / 업무관련성: ${d.assessmentLeft === 'high' ? '높음' : d.assessmentLeft === 'low' ? '낮음' : '-'}`;
      if (d.assessmentLeft === 'low') summary += `\n   낮음 사유:\n   - ${getReasonText(d.reasonLeft, d.reasonLeftOther).split('\n').join('\n   - ')}`;
    }
    return summary;
  }).join('\n\n');
  const b8 = `\n\n${b6}\n\n[ 업무관련성 평가 결과 ]\n\n${diagSummary}`;
  const b9 = mod.returnConsiderations || '';

  return { b5, b6, b7, b8, b9 };
};

const buildWorkbook = (emrData) => {
  const { b5, b6, b7, b8, b9 } = emrData;
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
  return wb;
};

export const kneeExportHandlers = {
  excelSingle: (patientData, calc) => {
    const emrData = generateEMRData(patientData, calc);
    const wb = buildWorkbook(emrData);
    XLSX.writeFile(wb, `업무관련성평가_${patientData.shared?.name || '미입력'}_${new Date().toISOString().split('T')[0]}.xlsx`);
  },
  pdf: (patientData, calc) => {
    const shared = patientData.shared || {};
    const { age, bmi, relatedness: r, cumulativeBurden: cum, jobBurdens: jb } = calc;
    const diagnoses = shared.diagnoses || [];
    const td = 'border:1px solid #ddd; padding:8px;';
    const th = `${td} background:#f5f5f5;`;

    const assessmentHtml = diagnoses.filter(d => d.code || d.name).map((d, i) => {
      let html = `<div style="background:#f8f9fa; padding:12px; border-radius:8px; margin-bottom:10px;">`;
      html += `<div style="font-weight:bold; margin-bottom:8px;">상병 #${i + 1}: ${d.code} ${d.name} (${getSideText(d.side)})</div>`;
      const renderSide = (label, confirmed, assessment, reasons, reasonOther) => {
        let s = `<div style="margin-left:10px; margin-bottom:6px;"><b>${label}:</b> 상병 상태(${getStatusText(confirmed)}) / 업무관련성(${assessment === 'high' ? '높음' : assessment === 'low' ? '낮음' : '-'})`;
        if (assessment === 'low' && reasons?.length) s += `<div style="margin-left:15px; margin-top:4px; font-size:11px; color:#555;">낮음 사유: ${getReasonText(reasons, reasonOther).split('\n').join(', ')}</div>`;
        return s + `</div>`;
      };
      if (d.side === 'right' || d.side === 'both') html += renderSide('우측', d.confirmedRight, d.assessmentRight, d.reasonRight, d.reasonRightOther);
      if (d.side === 'left' || d.side === 'both') html += renderSide('좌측', d.confirmedLeft, d.assessmentLeft, d.reasonLeft, d.reasonLeftOther);
      return html + `</div>`;
    }).join('');

    const content = document.createElement('div');
    content.style.cssText = 'font-family: "Noto Sans KR", sans-serif; padding: 40px; max-width: 800px; font-size: 12px; line-height: 1.6;';
    content.innerHTML = `
      <h1 style="text-align:center; margin-bottom:30px; font-size:18px; border-bottom:2px solid #333; padding-bottom:10px;">업무관련성 특별진찰 소견서</h1>
      <table style="width:100%; border-collapse:collapse; margin-bottom:20px;">
        <tr><td style="${th} width:120px;"><b>이름/성별</b></td><td style="${td}">${shared.name} (${shared.gender === 'male' ? '남' : shared.gender === 'female' ? '여' : '-'})</td><td style="${th} width:120px;"><b>키/몸무게</b></td><td style="${td}">${shared.height || '-'}cm / ${shared.weight || '-'}kg (BMI: ${bmi})</td></tr>
        <tr><td style="${th}"><b>생년월일</b></td><td style="${td}">${shared.birthDate || '-'}</td><td style="${th}"><b>재해일자</b></td><td style="${td}">${shared.injuryDate || '-'} (만 ${age}세)</td></tr>
      </table>
      <div style="background:#667eea; color:white; padding:15px; border-radius:8px; margin:20px 0; text-align:center;">
        <div style="font-size:16px; font-weight:bold;">신체부담기여도: ${r.min}% ~ ${r.max}%</div>
        <div style="margin-top:5px;">누적신체부담: ${cum}</div>
      </div>
      <h3 style="margin:20px 0 10px; font-size:14px;">종합소견</h3>
      ${assessmentHtml}
      <div style="border-top:2px solid #333; margin-top:30px; padding-top:15px; text-align:center; font-size:12px; color:#555;">
        <div>${shared.evaluationDate || '-'}</div>
        <div style="margin-top:4px;">${shared.hospitalName || '-'} ${shared.department || ''}</div>
        <div style="margin-top:4px;">담당의: ${shared.doctorName || '-'}</div>
      </div>
    `;

    html2pdf().set({
      margin: 10,
      filename: `업무관련성평가_${shared.name || '미입력'}_${new Date().toISOString().split('T')[0]}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    }).from(content).save();
  }
};
