import * as XLSX from 'xlsx';
import html2pdf from 'html2pdf.js';
import { computeWristCalc, getReasonText, getSideText, getStatusText } from './calculations';

const escapeHtml = (str) => {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

function buildDiagnosisSummary(shared) {
  const diagnoses = shared.diagnoses || [];

  return diagnoses
    .filter(diag => diag.code || diag.name)
    .map((diag, index) => {
      let text = `#${index + 1}. ${diag.code || ''} ${diag.name || ''} (${getSideText(diag.side)})`;

      if (diag.side === 'right' || diag.side === 'both') {
        text += `\n  우측: 상병 상태(${getStatusText(diag.confirmedRight)}) / 업무관련성(${diag.assessmentRight === 'high' ? '높음' : diag.assessmentRight === 'low' ? '낮음' : '-'})`;
        if (diag.assessmentRight === 'low') {
          text += `\n    낮음 사유:\n    - ${getReasonText(diag.reasonRight, diag.reasonRightOther).split('\n').join('\n    - ')}`;
        }
      }

      if (diag.side === 'left' || diag.side === 'both') {
        text += `\n  좌측: 상병 상태(${getStatusText(diag.confirmedLeft)}) / 업무관련성(${diag.assessmentLeft === 'high' ? '높음' : diag.assessmentLeft === 'low' ? '낮음' : '-'})`;
        if (diag.assessmentLeft === 'low') {
          text += `\n    낮음 사유:\n    - ${getReasonText(diag.reasonLeft, diag.reasonLeftOther).split('\n').join('\n    - ')}`;
        }
      }

      return text;
    })
    .join('\n\n');
}

function buildJobNarratives(calc) {
  return (calc.jobSummaries || []).map(jobSummary => {
    const details = jobSummary.diagnosisSummaries.map(summary => {
      const flagText = summary.flagItems.length > 0
        ? summary.flagItems.map(flag => flag.label).join(', ')
        : '활성 신호 없음';

      return [
        `  - ${summary.diagnosis.code || ''} ${summary.diagnosis.name || ''}`.trim(),
        `    BK 유형: ${summary.branchLabel}`,
        `    주요 신호: ${flagText}`,
        `    요약: ${summary.narrative}`,
        `    종합평가: ${summary.riskFactorSentence || '-'}`,
      ].join('\n');
    }).join('\n');

    return [`- ${jobSummary.jobName || '직업 미입력'}`, details || '  - 상병 없음'].join('\n');
  }).join('\n\n');
}

function generateEMRData(patientData, calc) {
  const shared = patientData.shared || {};
  const mod = patientData.module || {};
  const c = calc || computeWristCalc(patientData);

  const b5 = buildDiagnosisSummary(shared);
  const b6 = [
    '[공통 시간적 선후관계]',
    `- 최근 작업변화: ${c.temporalSequence?.recent_task_change || '-'}`,
    `- 작업변화 시점: ${c.temporalSequence?.task_change_date || '-'}`,
    `- 증상발생까지 기간: ${c.temporalSequence?.symptom_onset_interval || '-'}`,
    `- 휴가/업무중단 시 호전: ${c.temporalSequence?.improves_with_rest || '-'}`,
    `- 주요 신호: ${c.temporalFlagItems?.length ? c.temporalFlagItems.map(flag => flag.label).join(', ') : '-'}`,
    '',
    '[직업별 손목/손가락 신체부담 평가]',
    buildJobNarratives(c) || '-',
  ].join('\n');

  const b7 = [
    `- 키 ${shared.height || '-'}cm`,
    `- 체중 ${shared.weight || '-'}kg`,
    `- BMI: ${c.bmi || '-'}`,
    `- 나이: ${c.age || '-'}`,
    `- 특이사항: ${shared.specialNotes || '없음'}`,
  ].join('\n');

  const b8 = `${b6}\n\n[업무관련성 평가 결과]\n\n${b5}`;
  const b9 = mod.returnConsiderations || '';

  return { b5, b6, b7, b8, b9 };
}

function buildWorkbook(emrData) {
  const { b5, b6, b7, b8, b9 } = emrData;
  const wb = XLSX.utils.book_new();
  const wsData = [
    ['업무관련성평가 통합 보고서(근골격계질환)', ''],
    ['항목', '내용'],
    ['1. 신청상병명', ''],
    ['2. 진료기록 및 의학적 소견', ''],
    ['3. 최종 확인 상병명', b5],
    ['4. 직업력/노출 소견', b6],
    ['5. 개인력/특이사항', b7],
    ['6. 종합평가', b8],
    ['7. 복귀 관련 고려사항', b9],
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 25 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, ws, '업무관련성평가');
  return wb;
}

export const wristExportHandlers = {
  excelSingle: (patientData, calc) => {
    const emrData = generateEMRData(patientData, calc);
    const wb = buildWorkbook(emrData);
    XLSX.writeFile(wb, `업무관련성평가_${(patientData.shared?.name || '미입력').replace(/[\\/:*?"<>|]/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`);
  },
  pdf: (patientData, calc) => {
    const shared = patientData.shared || {};
    const c = calc || computeWristCalc(patientData);
    const summaryHtml = (c.jobSummaries || []).map(jobSummary => `
      <div style="background:#f8f9fa; padding:12px; border-radius:8px; margin-bottom:10px;">
        <div style="font-weight:bold; margin-bottom:6px;">${escapeHtml(jobSummary.jobName || '직업 미입력')}</div>
        ${(jobSummary.diagnosisSummaries || []).map(summary => `
          <div style="background:white; padding:10px; border-radius:8px; margin-top:8px;">
            <div style="font-weight:700; margin-bottom:6px;">${escapeHtml(summary.diagnosis.code || '')} ${escapeHtml(summary.diagnosis.name || '')}</div>
            <div style="font-size:11px; color:#555; margin-bottom:6px;">${escapeHtml(summary.branchLabel)}</div>
            <div style="font-size:11px; margin-bottom:6px;">주요 신호: ${escapeHtml(summary.flagItems.map(flag => flag.label).join(', ') || '활성 신호 없음')}</div>
            <div style="font-size:11px; white-space:pre-wrap;">${escapeHtml(summary.narrative)}</div>
            <div style="font-size:11px; font-weight:600; margin-top:6px; color:#1a73e8;">${escapeHtml(summary.riskFactorSentence || '')}</div>
          </div>
        `).join('')}
      </div>
    `).join('');

    const content = document.createElement('div');
    content.style.cssText = 'font-family: "Noto Sans KR", sans-serif; padding: 40px; max-width: 800px; font-size: 12px; line-height: 1.6;';
    content.innerHTML = `
      <h1 style="text-align:center; margin-bottom:24px; font-size:16px; border-bottom:2px solid #333; padding-bottom:8px;">업무관련성 평가 보고서</h1>
      <div style="margin-bottom:12px;">이름: ${escapeHtml(shared.name || '-')}</div>
      <div style="margin-bottom:12px;">시간적 선후관계: ${escapeHtml(c.temporalFlagItems?.map(flag => flag.label).join(', ') || '-')}</div>
      ${summaryHtml || '<p style="color:#888;">손목/손가락 결과가 없습니다.</p>'}
      <div style="border-top:2px solid #333; margin-top:24px; padding-top:12px; text-align:center; font-size:11px; color:#555;">
        <div>${shared.evaluationDate || '-'}</div>
        <div style="margin-top:4px;">${shared.hospitalName || '-'} ${shared.department || ''}</div>
        <div style="margin-top:4px;">담당의 ${shared.doctorName || '-'}</div>
      </div>`;

    html2pdf().set({
      margin: 10,
      filename: `업무관련성평가_${(shared.name || '미입력').replace(/[\\/:*?"<>|]/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    }).from(content).save();
  },
};
