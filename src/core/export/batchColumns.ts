// 일괄 입력(엑셀) 내보내기 열 표 — REFACTORING_ROADMAP Phase 2 C6, P2-54b·55a·55b.
//
// 옛 generateBatchRows(src/core/utils/exportService.js)의 row.push 126개(근무기간 if/else 때문에 열은 124)를 열 하나 = { header, cell(ctx) }
// 한 항목으로 1:1 옮겼다. 열은 구간 7개(core · knee · shoulder · cervical · elbow · wrist · spine)로 나누고, 구간마다 같은 번호 공간의 order를
// 준다 — 열 순서는 order가 정하고 모듈 등록 순서와는 무관하다(지금 순서 그대로: core 32열 → knee → shoulder → cervical → elbow → wrist → spine).
// 행 짝짓기(상병·직업·작업·팔꿈치/손목 항목을 한 행에 묶는 일)는 exportService가 그대로 하고, 한 행의 재료를 BatchRowContext로 넘긴다.
// P2-55a·55b: 모듈 구간 6개는 각 모듈 매니페스트의 batchExport(src/modules/*/batchExport.js)가 낸다 — core는 core 구간(32열)만 들고,
// 등록된 모듈의 구간만 붙으며 순서는 order가 정한다(등록 순서와 무관). 등록되지 않은 모듈의 구간·선택 함수는 없는 것으로 처리한다.
import { getReasonText, getStatusText } from '../assessment/vocabulary';
import { getWorkPeriodYearMonth } from '../utils/workPeriod';
import { selectModuleNote } from '../utils/moduleNotes';
import { getAllModules } from '../moduleRegistry';
import type { ModuleManifest } from '../modules/manifest';

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

/** core가 드는 구간 — 기본·진단·직업 32열(진단 열은 상병 필드를 직접 읽으므로 core에 둔다). */
const CORE_SECTIONS: readonly BatchColumnSection[] = [
  { id: 'core', order: 0, columns: CORE_COLUMNS },
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
