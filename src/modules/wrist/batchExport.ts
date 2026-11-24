// 일괄 내보내기(엑셀 일괄 입력 형식) 손목 구간 — Phase 2 C6 P2-55b. 옛 core 열 표의 wrist 31열 그대로.
// ctx = BatchRowContext(src/core/export/batchColumns.ts) — wristEntry는 core의 행 짝짓기가 고른 진단 항목, wristTemporal은 시간적 선후관계.
// 시간당 반복 횟수는 손목 자체 함수를 쓴다(옛 core는 팔꿈치 것을 빌려 썼다 — analytics-core에서 두 구현은 글자까지 같다).
import { bkLeadColumns } from '../../core/export/bkLeadColumns';
import type { BatchExportConfig } from '../../core/modules/manifest';
import { getBk2101RepetitionPerHour } from './utils/calculations';

export const wristBatchExport: BatchExportConfig = {
  order: 50,
  columns: [
    ...bkLeadColumns('손목', ctx => ({ temporal: ctx.wristTemporal, entry: ctx.wristEntry })),
    { header: '손목_BK2113_반복손목운동', cell: ({ wristEntry }) => wristEntry?.bk2113_repetitive_wrist_motion || '' },
    { header: '손목_BK2101_주기초', cell: ({ wristEntry }) => wristEntry?.bk2101_cycle_seconds || '' },
    { header: '손목_BK2101_시간당반복횟수', cell: ({ wristEntry }) => (wristEntry ? getBk2101RepetitionPerHour(wristEntry) || '' : '') },
    { header: '손목_BK2101_단조반복', cell: ({ wristEntry }) => wristEntry?.bk2101_monotony || '' },
    { header: '손목_BK2101_배측굴곡', cell: ({ wristEntry }) => wristEntry?.bk2101_forced_dorsal_extension || '' },
    { header: '손목_BK2101_회내회외', cell: ({ wristEntry }) => wristEntry?.bk2101_prosupination || '' },
    { header: '손목_BK2103_진동공구종류', cell: ({ wristEntry }) => (wristEntry?.bk2103_vibration_tool_type || []).join('|') },
    { header: '손목_BK2103_진동시간', cell: ({ wristEntry }) => wristEntry?.bk2103_daily_vibration_hours || '' },
    { header: '손목_BK2103_공구압박', cell: ({ wristEntry }) => wristEntry?.bk2103_tool_pressing || '' },
    { header: '손목_BK2103_고강도파지', cell: ({ wristEntry }) => wristEntry?.bk2103_frequent_high_force_grip || '' },
    { header: '손목_BK2106_압박원인', cell: ({ wristEntry }) => (wristEntry?.bk2106_pressure_source || []).join('|') },
  ],
};
