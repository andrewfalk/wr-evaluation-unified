// 팔꿈치·손목 일괄 내보내기 구간의 공통 앞부분 20열(시간적 선후관계 4 + 진단 항목 16) — 머리글 접두사만 다르다
// (REFACTORING_ROADMAP Phase 2 C6, P2-55b). 두 모듈의 batchExport.js가 같이 쓴다. 값 식은 옛 core 열 표 그대로.
// 모듈 매니페스트(첫 화면 청크)가 import하므로 타입 말고는 아무것도 import하지 않는다.
import type { BatchBkEntry, BatchColumn, BatchRowContext } from './batchColumns';

type Fields = { [field: string]: unknown };

export type BkPick = (ctx: BatchRowContext) => { temporal: Fields; entry: BatchBkEntry | null };

export function bkLeadColumns(prefix: string, pick: BkPick): BatchColumn[] {
  const temporal = (field: string): BatchColumn['cell'] => ctx => (ctx.isFirst ? (pick(ctx).temporal[field] || '') : '');
  const entry = (field: string): BatchColumn['cell'] => ctx => pick(ctx).entry?.[field] || '';
  return [
    { header: `${prefix}_시간적선후관계_최근작업변화`, cell: temporal('recent_task_change') },
    { header: `${prefix}_시간적선후관계_작업변화시점`, cell: temporal('task_change_date') },
    { header: `${prefix}_시간적선후관계_증상발생까지기간`, cell: temporal('symptom_onset_interval') },
    { header: `${prefix}_시간적선후관계_휴식시호전`, cell: temporal('improves_with_rest') },
    { header: `${prefix}_BK유형`, cell: entry('selectedBkType') },
    { header: `${prefix}_BK선택방식`, cell: entry('bkSelectionMode') },
    { header: `${prefix}_문제작업명`, cell: entry('main_task_name') },
    { header: `${prefix}_핵심동작연결성`, cell: entry('direct_anatomic_link') },
    { header: `${prefix}_공통핵심노출유형`, cell: ctx => (pick(ctx).entry?.exposure_types || []).join('|') },
    { header: `${prefix}_반복동작정도`, cell: entry('repetition_level') },
    { header: `${prefix}_1일노출시간`, cell: entry('daily_exposure_hours') },
    { header: `${prefix}_하루작업비중`, cell: entry('shift_share_percent') },
    { header: `${prefix}_주당수행일수`, cell: entry('days_per_week') },
    { header: `${prefix}_작업형태`, cell: entry('work_pattern') },
    { header: `${prefix}_휴식분포`, cell: entry('rest_distribution') },
    { header: `${prefix}_힘사용`, cell: entry('force_level') },
    { header: `${prefix}_비중립자세`, cell: entry('awkward_posture_level') },
    { header: `${prefix}_정적유지`, cell: entry('static_holding_level') },
    { header: `${prefix}_직접압박수준`, cell: entry('direct_pressure_level') },
    { header: `${prefix}_진동노출`, cell: entry('vibration_exposure') },
  ];
}
