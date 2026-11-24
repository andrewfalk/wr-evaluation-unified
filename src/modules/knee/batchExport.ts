// 일괄 내보내기(엑셀 일괄 입력 형식) 무릎 구간 — Phase 2 C6 P2-55a. 옛 core 열 표의 knee 8열 그대로.
// ctx = BatchRowContext(src/core/export/batchColumns.ts) — kneeExtra는 core의 행 짝짓기가 고른 그 행 직업의 jobExtras.
import type { BatchExportConfig } from '../../core/modules/manifest';

export const kneeBatchExport: BatchExportConfig = {
  order: 10,
  columns: [
    { header: '중량물(kg)', cell: ({ kneeExtra }) => kneeExtra?.weight || '' },
    { header: '쪼그려앉기(분)', cell: ({ kneeExtra }) => kneeExtra?.squatting || '' },
    { header: '계단오르내리기', cell: ({ kneeExtra }) => (kneeExtra?.stairs ? 'O' : '') },
    { header: '무릎비틀기', cell: ({ kneeExtra }) => (kneeExtra?.kneeTwist ? 'O' : '') },
    { header: '출발정지반복', cell: ({ kneeExtra }) => (kneeExtra?.startStop ? 'O' : '') },
    { header: '좁은공간', cell: ({ kneeExtra }) => (kneeExtra?.tightSpace ? 'O' : '') },
    { header: '무릎접촉충격', cell: ({ kneeExtra }) => (kneeExtra?.kneeContact ? 'O' : '') },
    { header: '점프착지', cell: ({ kneeExtra }) => (kneeExtra?.jumpDown ? 'O' : '') },
  ],
};
