import * as XLSX from 'xlsx';
import html2pdf from 'html2pdf.js';
import { computeShoulderCalc, getSideText, getStatusText, getReasonText } from './calculations';

const escapeHtml = (str) => {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

function formatTotalsText(totals) {
  return (totals || []).map(t => {
    const ratioStr = t.totalHours > 0 ? ` / 비율 ${(t.ratio * 100).toFixed(0)}%${t.exceeded ? ' [초과]' : ''}` : '';
    return `  ${t.label}: ${t.totalHours > 0 ? t.totalHours.toFixed(1) + '시간' : '-'} (임계값 ${t.limit.toLocaleString()}시간${ratioStr})`;
  }).join('\n');
}

const generateEMRData = (patientData, c) => {
  const shared = patientData.shared || {};
  const mod    = patientData.module || {};
  const { age, bmi, jobBurdens: jb, totals } = c || computeShoulderCalc(patientData);
  const diagnoses = shared.diagnoses || [];

  const b5 = diagnoses
    .filter(d => d.confirmedCode || d.confirmedName)
    .map(d => {
      let line = `${d.confirmedCode || ''} ${d.confirmedName || ''}`.trim();
      if (d.side === 'right' || d.side === 'both') {
        line += `\n  - 우측: 상병 상태(${getStatusText(d.confirmedRight)}) / 업무관련성(${d.assessmentRight === 'high' ? '높음' : d.assessmentRight === 'low' ? '낮음' : '-'})`;
        if (d.assessmentRight === 'low') line += `\n    낮음 사유:\n    - ${getReasonText(d.reasonRight, d.reasonRightOther).split('\n').join('\n    - ')}`;
      }
      if (d.side === 'left' || d.side === 'both') {
        line += `\n  - 좌측: 상병 상태(${getStatusText(d.confirmedLeft)}) / 업무관련성(${d.assessmentLeft === 'high' ? '높음' : d.assessmentLeft === 'low' ? '낮음' : '-'})`;
        if (d.assessmentLeft === 'low') line += `\n    낮음 사유:\n    - ${getReasonText(d.reasonLeft, d.reasonLeftOther).split('\n').join('\n    - ')}`;
      }
      return line;
    }).join('\n\n');

  let b6 = `[직업력]\n`;
  (jb || []).filter(j => j.jobName).forEach((j, i) => {
    b6 += `- 직력${i + 1}: ${j.jobName} / ${j.periodYears > 0 ? j.periodYears.toFixed(1) + '년' : '-'} / 연간 ${j.workDaysPerYear}일 근무\n`;
    (j.exposures || []).forEach(exp => {
      if (exp.dailyHours > 0) b6 += `  ${exp.label}: ${parseFloat(exp.dailyHours.toFixed(2))}시간/일 → 누적 ${exp.cumulativeHours.toFixed(1)}시간\n`;
    });
  });

  b6 += `\n[BK2117 누적 기준 비교]\n${formatTotalsText(totals)}`;
  const exceededItems = (totals || []).filter(t => t.exceeded);
  if (exceededItems.length > 0) {
    b6 += `\n\n** ${exceededItems.map(t => t.label).join(', ')} 기준을 초과하여 누적 신체부담은 충분함.`;
  } else {
    const over75 = (totals || []).filter(t => t.ratio >= 0.75);
    const over50 = (totals || []).filter(t => t.ratio >= 0.50);
    if (over50.length >= 3 || over75.length >= 2) {
      b6 += `\n\n** 개별 기준 초과 항목은 없으나, 복합 노출을 고려하여 누적 신체부담은 충분함.`;
    } else {
      b6 += `\n\n** 노출 기준치에 미달하여 누적 신체부담 불충분함.`;
    }
  }

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

export const shoulderExportHandlers = {
  excelSingle: (patientData, calc) => {
    const emrData = generateEMRData(patientData, calc);
    const wb = buildWorkbook(emrData);
    XLSX.writeFile(wb, `업무관련성평가_${(patientData.shared?.name || '미입력').replace(/[\\/:*?"<>|]/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`);
  },
  pdf: (patientData, calc) => {
    const shared = patientData.shared || {};
    const { age, bmi, totals } = calc || computeShoulderCalc(patientData);
    const diagnoses = shared.diagnoses || [];
    const tdStyle = 'border:1px solid #ddd; padding:5px 8px;';
    const thStyle = `${tdStyle} background:#f5f5f5; font-weight:600;`;

    const totalsHtml = `
      <table style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:12px;">
        <tr>
          <th style="${thStyle}">노출 유형</th>
          <th style="${thStyle} text-align:right;">누적 시간</th>
          <th style="${thStyle} text-align:right;">임계값</th>
          <th style="${thStyle} text-align:right;">비율</th>
          <th style="${thStyle} text-align:center;">초과</th>
        </tr>
        ${(totals || []).map(t => `
          <tr style="${t.exceeded ? 'background:#fff5f5;' : ''}">
            <td style="${tdStyle}">${escapeHtml(t.label)}</td>
            <td style="${tdStyle} text-align:right; ${t.exceeded ? 'color:#dc3545; font-weight:bold;' : ''}">${t.totalHours > 0 ? t.totalHours.toFixed(1) + '시간' : '-'}</td>
            <td style="${tdStyle} text-align:right; color:#888;">${t.limit.toLocaleString()}시간</td>
            <td style="${tdStyle} text-align:right; ${t.exceeded ? 'color:#dc3545; font-weight:bold;' : 'color:#888;'}">${t.totalHours > 0 ? (t.ratio * 100).toFixed(0) + '%' : '-'}</td>
            <td style="${tdStyle} text-align:center; color:#dc3545; font-weight:bold;">${t.exceeded ? '✓' : ''}</td>
          </tr>`).join('')}
      </table>
      ${(() => {
        const exc = (totals || []).filter(t => t.exceeded);
        if (exc.length > 0) return `<p style="font-size:10px; color:#dc3545; font-weight:bold; margin-bottom:8px;">** ${exc.map(t => escapeHtml(t.label)).join(', ')} 기준을 초과하여 누적 신체부담은 충분함.</p>`;
        const o75 = (totals || []).filter(t => t.ratio >= 0.75);
        const o50 = (totals || []).filter(t => t.ratio >= 0.50);
        if (o50.length >= 3 || o75.length >= 2) return '<p style="font-size:10px; color:#e67700; font-weight:bold; margin-bottom:8px;">** 개별 기준 초과 항목은 없으나, 복합 노출을 고려하여 누적 신체부담은 충분함.</p>';
        return '<p style="font-size:10px; color:#888; margin-bottom:8px;">** 노출 기준치에 미달하여 누적 신체부담 불충분함.</p>';
      })()}`;

    const assessmentHtml = diagnoses.filter(d => d.code || d.name).map((d, i) => {
      let html = `<div style="background:#f8f9fa; padding:10px; border-radius:6px; margin-bottom:8px;">`;
      html += `<div style="font-weight:bold; margin-bottom:6px;">상병 #${i + 1}: ${escapeHtml(d.code)} ${escapeHtml(d.name)} (${escapeHtml(getSideText(d.side))})</div>`;
      const renderSide = (label, confirmed, assessment, reasons, reasonOther) => {
        let s = `<div style="margin-left:10px; margin-bottom:4px;"><b>${escapeHtml(label)}:</b> 상병 상태(${escapeHtml(getStatusText(confirmed))}) / 업무관련성(${assessment === 'high' ? '높음' : assessment === 'low' ? '낮음' : '-'})`;
        if (assessment === 'low' && reasons?.length) s += `<div style="margin-left:15px; font-size:10px; color:#555;">낮음 사유: ${escapeHtml(getReasonText(reasons, reasonOther).split('\n').join(', '))}</div>`;
        return s + `</div>`;
      };
      if (d.side === 'right' || d.side === 'both') html += renderSide('우측', d.confirmedRight, d.assessmentRight, d.reasonRight, d.reasonRightOther);
      if (d.side === 'left' || d.side === 'both') html += renderSide('좌측', d.confirmedLeft, d.assessmentLeft, d.reasonLeft, d.reasonLeftOther);
      return html + `</div>`;
    }).join('');

    const content = document.createElement('div');
    content.style.cssText = 'font-family: "Noto Sans KR", sans-serif; padding: 40px; max-width: 800px; font-size: 12px; line-height: 1.6;';
    content.innerHTML = `
      <h1 style="text-align:center; margin-bottom:24px; font-size:16px; border-bottom:2px solid #333; padding-bottom:8px;">업무관련성 특별진찰 소견서</h1>
      <table style="width:100%; border-collapse:collapse; margin-bottom:16px;">
        <tr><td style="${thStyle} width:100px;">이름/성별</td><td style="${tdStyle}">${escapeHtml(shared.name)} (${shared.gender === 'male' ? '남' : '여'})</td><td style="${thStyle} width:100px;">키/몸무게</td><td style="${tdStyle}">${shared.height || '-'}cm / ${shared.weight || '-'}kg (BMI: ${escapeHtml(bmi)})</td></tr>
        <tr><td style="${thStyle}">생년월일</td><td style="${tdStyle}">${shared.birthDate || '-'}</td><td style="${thStyle}">재해일자</td><td style="${tdStyle}">${shared.injuryDate || '-'} (만 ${escapeHtml(age)}세)</td></tr>
      </table>
      <h3 style="font-size:13px; margin:16px 0 8px;">BK2117 누적 기준 비교</h3>
      ${totalsHtml}
      <h3 style="font-size:13px; margin:16px 0 8px;">종합소견</h3>
      ${assessmentHtml || '<p style="color:#888;">상병 없음</p>'}
      <div style="border-top:2px solid #333; margin-top:24px; padding-top:12px; text-align:center; font-size:11px; color:#555;">
        <div>${shared.evaluationDate || '-'}</div>
        <div style="margin-top:4px;">${shared.hospitalName || '-'} ${shared.department || ''}</div>
        <div style="margin-top:4px;">담당의: ${shared.doctorName || '-'}</div>
      </div>`;

    html2pdf().set({
      margin: 10,
      filename: `업무관련성평가_${(shared.name || '미입력').replace(/[\\/:*?"<>|]/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    }).from(content).save();
  }
};
