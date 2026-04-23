import * as XLSX from 'xlsx';
import { computeCervicalCalc } from './calculations';

function buildWorkbook(patientData, calc) {
  const shared = patientData.shared || {};
  const c = calc || computeCervicalCalc(patientData);
  const rows = [
    ['경추 부담 노출 평가', ''],
    ['항목', '내용'],
    ['이름', shared.name || ''],
    ['진단', (shared.diagnoses || []).map(diag => `${diag.code || ''} ${diag.name || ''}`.trim()).join('\n')],
    ['요약', (c.diagnosisSummaries || []).map(summary =>
      `${summary.jobName || '-'} / ${summary.conclusionText}`
    ).join('\n')],
    ['복귀 고려사항', patientData.module?.returnConsiderations || ''],
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 25 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, ws, '경추평가');
  return wb;
}

export const cervicalExportHandlers = {
  excelSingle: (patientData, calc) => {
    const wb = buildWorkbook(patientData, calc);
    const safeName = (patientData.shared?.name || '미입력').replace(/[\\/:*?"<>|]/g, '_');
    XLSX.writeFile(wb, `경추평가_${safeName}_${new Date().toISOString().split('T')[0]}.xlsx`);
  },
};
