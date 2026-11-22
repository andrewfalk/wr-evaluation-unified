// 일괄 내보내기(엑셀 일괄 입력 형식) 척추 구간 — Phase 2 C6 P2-55a. 옛 core 열 표의 spine 7열 그대로.
// ctx = BatchRowContext(src/core/export/batchColumns.ts) — task는 core의 행 짝짓기가 고른 spine 작업.
// rowTasks: 행 짝짓기에 쓸 작업 목록 — MDDM이 '평가함'(present)일 때만 작업 행을 만든다. unknown(WBV-only)·none(해당없음)은 빈 배열.
import { resolveMddmStatus } from './utils/calculations';

export const spineBatchExport = {
  order: 60,
  columns: [
    { header: '작업명', cell: ({ task }) => task?.name || '' },
    { header: '자세코드', cell: ({ task }) => task?.posture || '' },
    { header: '작업중량(kg)', cell: ({ task }) => task?.weight ?? '' },
    { header: '횟수/분', cell: ({ task }) => task?.frequency ?? '' },
    { header: '시간값', cell: ({ task }) => task?.timeValue ?? '' },
    { header: '시간단위', cell: ({ task }) => task?.timeUnit || '' },
    { header: '보정계수', cell: ({ task }) => task?.correctionFactor ?? '' },
  ],
  rowTasks: (spineModule) => (resolveMddmStatus(spineModule) === 'present' ? (spineModule.tasks || []) : []),
};
