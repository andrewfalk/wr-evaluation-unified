// 일괄 내보내기(엑셀 일괄 입력 형식) 어깨 구간 — Phase 2 C6 P2-55a. 옛 core 열 표의 shoulder 6열 그대로.
// ctx = BatchRowContext(src/core/export/batchColumns.ts) — shoulderExtra는 그 행 직업의 jobExtras.
export const shoulderBatchExport = {
  order: 20,
  columns: [
    { header: '오버헤드(시간/일)', cell: ({ shoulderExtra }) => shoulderExtra?.overheadHours ?? '' },
    { header: '반복중간(시간/일)', cell: ({ shoulderExtra }) => shoulderExtra?.repetitiveMediumHours ?? '' },
    { header: '반복빠름(시간/일)', cell: ({ shoulderExtra }) => shoulderExtra?.repetitiveFastHours ?? '' },
    { header: '중량물횟수(회/일)', cell: ({ shoulderExtra }) => shoulderExtra?.heavyLoadCount ?? '' },
    { header: '중량물시간(초/회)', cell: ({ shoulderExtra }) => shoulderExtra?.heavyLoadSeconds ?? '' },
    { header: '진동(시간/일)', cell: ({ shoulderExtra }) => shoulderExtra?.vibrationHours ?? '' },
  ],
};
