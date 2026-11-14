// 엑셀 파일 읽기(REFACTORING_ROADMAP Phase 2 P-2a, P2-22) — xlsx 라이브러리를 쓰는 곳. 일괄입력 모달(지연 로딩 청크)만
// import하므로 xlsx는 그 모달을 처음 열 때 내려받는다(초기 화면에서 빠짐). 내보내기는 exportService(동적 import).
import * as XLSX from 'xlsx';

/** 첫 번째 시트의 행 배열(header: 1 — 각 행은 셀 값 배열). */
export function readFirstSheetRows(arrayBuffer) {
  const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1 });
}
