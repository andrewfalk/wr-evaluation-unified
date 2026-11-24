// 일괄 내보내기(엑셀 일괄 입력 형식) 팔꿈치 구간 — Phase 2 C6 P2-55b. 옛 core 열 표의 elbow 31열 그대로.
// ctx = BatchRowContext(src/core/export/batchColumns.ts) — elbowEntry는 core의 행 짝짓기가 고른 진단 항목, elbowTemporal은 시간적 선후관계.
import { bkLeadColumns } from '../../core/export/bkLeadColumns';
import type { BatchExportConfig } from '../../core/modules/manifest';
import { getBk2101RepetitionPerHour } from './utils/calculations';

export const elbowBatchExport: BatchExportConfig = {
  order: 40,
  columns: [
    ...bkLeadColumns('팔꿈치', ctx => ({ temporal: ctx.elbowTemporal, entry: ctx.elbowEntry })),
    { header: '팔꿈치_BK2101_주기초', cell: ({ elbowEntry }) => elbowEntry?.bk2101_cycle_seconds || '' },
    { header: '팔꿈치_BK2101_시간당반복횟수', cell: ({ elbowEntry }) => (elbowEntry ? getBk2101RepetitionPerHour(elbowEntry) || '' : '') },
    { header: '팔꿈치_BK2101_단조반복', cell: ({ elbowEntry }) => elbowEntry?.bk2101_monotony || '' },
    { header: '팔꿈치_BK2101_배측굴곡', cell: ({ elbowEntry }) => elbowEntry?.bk2101_forced_dorsal_extension || '' },
    { header: '팔꿈치_BK2101_회내회외', cell: ({ elbowEntry }) => elbowEntry?.bk2101_prosupination || '' },
    { header: '팔꿈치_BK2103_진동공구종류', cell: ({ elbowEntry }) => (elbowEntry?.bk2103_vibration_tool_type || []).join('|') },
    { header: '팔꿈치_BK2103_진동시간', cell: ({ elbowEntry }) => elbowEntry?.bk2103_daily_vibration_hours || '' },
    { header: '팔꿈치_BK2103_공구를강하게쥐거나누르면서사용하는작업', cell: ({ elbowEntry }) => elbowEntry?.bk2103_tool_pressing || '' },
    { header: '팔꿈치_BK2105_팔꿈치지지', cell: ({ elbowEntry }) => elbowEntry?.bk2105_elbow_leaning || '' },
    { header: '팔꿈치_BK2105_압박원인', cell: ({ elbowEntry }) => (elbowEntry?.bk2105_pressure_source || []).join('|') },
    { header: '팔꿈치_BK2106_압박원인', cell: ({ elbowEntry }) => (elbowEntry?.bk2106_pressure_source || []).join('|') },
  ],
};
