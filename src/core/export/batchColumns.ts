// 일괄 입력(엑셀) 내보내기 열 표 — REFACTORING_ROADMAP Phase 2 C6, P2-54b·55a.
//
// 옛 generateBatchRows(src/core/utils/exportService.js)의 row.push 126개(근무기간 if/else 때문에 열은 124)를 열 하나 = { header, cell(ctx) }
// 한 항목으로 1:1 옮겼다. 열은 구간 7개(core · knee · shoulder · cervical · elbow · wrist · spine)로 나누고, 구간마다 같은 번호 공간의 order를
// 준다 — 열 순서는 order가 정하고 모듈 등록 순서와는 무관하다(지금 순서 그대로: core 32열 → knee → shoulder → cervical → elbow → wrist → spine).
// 행 짝짓기(상병·직업·작업·팔꿈치/손목 항목을 한 행에 묶는 일)는 exportService가 그대로 하고, 한 행의 재료를 BatchRowContext로 넘긴다.
// P2-55a: knee·shoulder·spine 구간은 각 모듈 매니페스트의 batchExport(src/modules/*/batchExport.js)가 낸다 — 등록된 모듈의 구간만 붙고,
// 순서는 order가 정한다(등록 순서와 무관). 등록되지 않은 모듈의 구간·선택 함수는 없는 것으로 처리한다. P2-55b가 나머지 셋을 옮긴다.
import { getReasonText, getStatusText } from '../assessment/vocabulary';
import { getWorkPeriodYearMonth } from '../utils/workPeriod';
import { selectModuleNote } from '../utils/moduleNotes';
import { getAllModules } from '../moduleRegistry';
import type { ModuleManifest } from '../modules/manifest';
import { getBk2101RepetitionPerHour } from '../../modules/elbow/utils/calculations';
import { EXPOSURE_TYPE_LABELS as CERVICAL_EXPOSURE_TYPE_LABELS } from '../../modules/cervical/utils/data';

type Fields = { [field: string]: unknown };

export interface BatchDiagnosis extends Fields {
  reasonRight?: string | string[];
  reasonLeft?: string | string[];
  reasonRightOther?: string;
  reasonLeftOther?: string;
}

export interface BatchJob extends Fields {
  id: string;
  startDate?: string;
  endDate?: string;
  workPeriodOverride?: string;
}

/** 팔꿈치·손목 진단 항목(jobEvaluations[].diagnosisEntries[]) — 목록 값은 '|'로 이어 쓴다. */
export interface BatchBkEntry extends Fields {
  exposure_types?: string[];
  bk2103_vibration_tool_type?: string[];
  bk2105_pressure_source?: string[];
  bk2106_pressure_source?: string[];
}

export interface BatchCervicalTask extends Fields {
  exposure_types?: string[];
}

/** 한 행의 재료 — exportService.generateBatchRows가 행 짝짓기로 만든다. */
export interface BatchRowContext {
  shared: Fields;
  modules: Fields;
  activeModules: string[];
  isFirst: boolean;
  diag: BatchDiagnosis | undefined;
  job: BatchJob | null | undefined;
  task: Fields | null | undefined;
  cervicalTask: BatchCervicalTask | null | undefined;
  kneeExtra: Fields | null | undefined;
  shoulderExtra: Fields | null | undefined;
  elbowEntry: BatchBkEntry | null;
  wristEntry: BatchBkEntry | null;
  elbowTemporal: Fields;
  wristTemporal: Fields;
}

export interface BatchColumn {
  header: string;
  cell(ctx: BatchRowContext): unknown;
}

export interface BatchColumnSection {
  id: string;
  /** 같은 번호 공간에서 구간 순서(작을수록 왼쪽). core는 0. */
  order: number;
  columns: readonly BatchColumn[];
}

const GENDER_REVERSE: Record<string, string> = { male: '남', female: '여' };
const SIDE_REVERSE: Record<string, string> = { right: '우측', left: '좌측', both: '양측' };

function getAssessmentLevelText(level: unknown): string {
  return level === 'high' ? '높음' : level === 'low' ? '낮음' : '';
}

function formatCervicalExposureTypes(exposureTypes: string[] = []): string {
  return (exposureTypes || [])
    .map(type => CERVICAL_EXPOSURE_TYPE_LABELS[type] || type)
    .join('|');
}

function yesNoText(value: unknown): string {
  return value === 'yes' ? '예' : value === 'no' ? '아니오' : '';
}

const firstOnly = (ctx: BatchRowContext, value: unknown): unknown => (ctx.isFirst ? value : '');

// --- core 32열: 기본 12 · 진단 15 · 직업 5 ---
const CORE_COLUMNS: readonly BatchColumn[] = [
  { header: '등록번호', cell: ({ shared }) => shared.patientNo || '' },
  { header: '이름', cell: ({ shared }) => shared.name || '' },
  { header: '성별', cell: ctx => firstOnly(ctx, GENDER_REVERSE[String(ctx.shared.gender)] || '') },
  { header: '생년월일', cell: ({ shared }) => shared.birthDate || '' },
  { header: '재해일자', cell: ({ shared }) => shared.injuryDate || '' },
  { header: '키', cell: ctx => firstOnly(ctx, ctx.shared.height || '') },
  { header: '체중', cell: ctx => firstOnly(ctx, ctx.shared.weight || '') },
  { header: '병원명', cell: ctx => firstOnly(ctx, ctx.shared.hospitalName || '') },
  { header: '진료과', cell: ctx => firstOnly(ctx, ctx.shared.department || '') },
  { header: '담당의', cell: ctx => firstOnly(ctx, ctx.shared.doctorName || '') },
  { header: '특이사항', cell: ctx => firstOnly(ctx, ctx.shared.specialNotes || '') },
  { header: '특이사항메모', cell: ctx => (ctx.isFirst ? selectModuleNote(ctx.modules, ctx.activeModules) : '') },

  { header: '진단코드', cell: ({ diag }) => diag?.code || '' },
  { header: '진단명', cell: ({ diag }) => diag?.name || '' },
  { header: '방향', cell: ({ diag }) => (diag ? (SIDE_REVERSE[String(diag.side)] || '') : '') },
  { header: 'KLG(우)', cell: ({ diag }) => diag?.klgRight || '' },
  { header: 'KLG(좌)', cell: ({ diag }) => diag?.klgLeft || '' },
  { header: 'Ellman(우)', cell: ({ diag }) => diag?.ellmanRight || '' },
  { header: 'Ellman(좌)', cell: ({ diag }) => diag?.ellmanLeft || '' },
  { header: '상병상태(우)', cell: ({ diag }) => (diag?.confirmedRight ? getStatusText(diag.confirmedRight) : '') },
  { header: '상병상태(좌)', cell: ({ diag }) => (diag?.confirmedLeft ? getStatusText(diag.confirmedLeft) : '') },
  { header: '업무관련성(우)', cell: ({ diag }) => getAssessmentLevelText(diag?.assessmentRight) },
  { header: '업무관련성(좌)', cell: ({ diag }) => getAssessmentLevelText(diag?.assessmentLeft) },
  {
    header: '업무관련성낮음사유(우)',
    cell: ({ diag }) => (diag?.assessmentRight === 'low' ? getReasonText(diag.reasonRight || [], diag.reasonRightOther) : ''),
  },
  {
    header: '업무관련성낮음사유(좌)',
    cell: ({ diag }) => (diag?.assessmentLeft === 'low' ? getReasonText(diag.reasonLeft || [], diag.reasonLeftOther) : ''),
  },
  { header: '수직분포원리', cell: ({ diag }) => (diag?.verticalDistribution ? getStatusText(diag.verticalDistribution) : '') },
  { header: '동반척추증', cell: ({ diag }) => (diag?.concomitantSpondylosis ? getStatusText(diag.concomitantSpondylosis) : '') },

  { header: '직종명', cell: ({ job }) => job?.jobName || '' },
  { header: '시작일', cell: ({ job }) => job?.startDate || '' },
  { header: '종료일', cell: ({ job }) => job?.endDate || '' },
  { header: '근무기간(년)', cell: ({ job }) => (job ? getWorkPeriodYearMonth(job).years || '' : '') },
  { header: '근무기간(개월)', cell: ({ job }) => (job ? getWorkPeriodYearMonth(job).months || '' : '') },
];

// --- cervical 9열 ---
const CERVICAL_COLUMNS: readonly BatchColumn[] = [
  { header: '경추_작업명', cell: ({ cervicalTask }) => cervicalTask?.name || '' },
  { header: '경추_노출유형', cell: ({ cervicalTask }) => formatCervicalExposureTypes(cervicalTask?.exposure_types || []) },
  { header: '경추_하중(kg)', cell: ({ cervicalTask }) => cervicalTask?.load_weight_kg || '' },
  { header: '경추_교대당운반시간', cell: ({ cervicalTask }) => cervicalTask?.carry_hours_per_shift || '' },
  { header: '경추_부자연스러운목자세강제', cell: ({ cervicalTask }) => yesNoText(cervicalTask?.forced_neck_posture) },
  { header: '경추_비중립정적자세시간', cell: ({ cervicalTask }) => cervicalTask?.neck_nonneutral_hours_per_day || '' },
  { header: '경추_굴곡신전회전측굴동시발생', cell: ({ cervicalTask }) => yesNoText(cervicalTask?.combined_flexion_rotation_posture) },
  { header: '경추_고도의정밀작업', cell: ({ cervicalTask }) => yesNoText(cervicalTask?.precision_work) },
  { header: '경추_메모', cell: ({ cervicalTask }) => cervicalTask?.notes || '' },
];

// 팔꿈치·손목 공통 앞부분(시간적 선후관계 4 + 항목 16) — 머리글 접두사만 다르다.
function bkLeadColumns(prefix: string, pick: (ctx: BatchRowContext) => { temporal: Fields; entry: BatchBkEntry | null }): BatchColumn[] {
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

const elbowPick = (ctx: BatchRowContext) => ({ temporal: ctx.elbowTemporal, entry: ctx.elbowEntry });
const wristPick = (ctx: BatchRowContext) => ({ temporal: ctx.wristTemporal, entry: ctx.wristEntry });

// --- elbow 31열 ---
const ELBOW_COLUMNS: readonly BatchColumn[] = [
  ...bkLeadColumns('팔꿈치', elbowPick),
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
];

// --- wrist 31열 ---
const WRIST_COLUMNS: readonly BatchColumn[] = [
  ...bkLeadColumns('손목', wristPick),
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
];

/** core가 아직 들고 있는 구간(P2-55b에서 cervical·elbow·wrist가 모듈로 간다). */
const CORE_SECTIONS: readonly BatchColumnSection[] = [
  { id: 'core', order: 0, columns: CORE_COLUMNS },
  { id: 'cervical', order: 30, columns: CERVICAL_COLUMNS },
  { id: 'elbow', order: 40, columns: ELBOW_COLUMNS },
  { id: 'wrist', order: 50, columns: WRIST_COLUMNS },
];

/** core 구간 + 모듈 구간을 order 순으로. 같은 order나 같은 id가 둘이면 throw(열 순서가 등록 순서에 기대지 않도록). */
export function assembleBatchColumnSections(moduleSections: readonly BatchColumnSection[]): BatchColumnSection[] {
  const sections = [...CORE_SECTIONS, ...moduleSections];
  const seenOrders = new Map<number, string>();
  const seenIds = new Set<string>();
  for (const section of sections) {
    if (typeof section.order !== 'number' || !Number.isFinite(section.order)) {
      throw new TypeError(`[batchColumns] 구간 '${section.id}'의 order가 숫자가 아닙니다`);
    }
    const other = seenOrders.get(section.order);
    if (other !== undefined) throw new Error(`[batchColumns] 구간 order ${section.order}이 '${other}'와 '${section.id}'에 겹칩니다`);
    if (seenIds.has(section.id)) throw new Error(`[batchColumns] 구간 '${section.id}'가 두 번 있습니다`);
    seenOrders.set(section.order, section.id);
    seenIds.add(section.id);
  }
  return sections.sort((left, right) => left.order - right.order);
}

/** 지금 등록된 모듈의 batchExport를 붙인 구간 목록. */
export function getBatchColumnSections(): BatchColumnSection[] {
  const modules = getAllModules() as ModuleManifest[];
  return assembleBatchColumnSections(modules.flatMap(mod => (
    mod.batchExport ? [{ id: mod.id, order: mod.batchExport.order, columns: mod.batchExport.columns }] : []
  )));
}

export function getBatchColumns(): BatchColumn[] {
  return getBatchColumnSections().flatMap(section => section.columns);
}

/** 일괄 입력 시트 머리글(구간 order 순). 6모듈이 모두 등록돼 있으면 124개. */
export function getBatchHeaders(): string[] {
  return getBatchColumns().map(column => column.header);
}
