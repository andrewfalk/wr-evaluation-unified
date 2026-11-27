// 팔꿈치·손목 공용 프리셋·일괄 가져오기 조립(REFACTORING_ROADMAP Phase 2 C8, P2-70b).
// 두 모듈 index의 presetConfig(라벨만 다름)와 batchImportConfig.applyRow(골격이 같고 열·필드·처리 순서가 다름)를 한 벌로 둔다.
// 모듈마다 다른 것은 config로 **지금 값 그대로** 받는다(규칙으로 생성하지 않는다 — 계획 K6):
//   · presetLabel·presetFields — 프리셋 창의 라벨
//   · columns — 열 키 → 엑셀 머리글 후보(열 배정이 키 순서·모듈 등록 순서에 기대므로 글자 그대로, 팔꿈치의 옛 키 포함)
//   · hasDataColumns — 이 열들 가운데 하나라도 값이 있어야 행을 반영한다
//   · rowFields — 엔트리에 적는 필드와 **순서**, 필드마다 처리 종류(trim·raw·list·mode·chain)와 열 키
//   · temporalColumns — 시간적 선후관계 4칸의 열 키
import { ensureModule, splitList, parseDate } from '../../../core/utils/batchImportHelpers';
import type { BatchImportConfig, PresetConfig, PresetFieldDef } from '../../../core/modules/manifest';
import type {
  UpperLimbDiagnosisEntry,
  UpperLimbDiagnosisLike,
  UpperLimbJobEvaluation,
  UpperLimbModuleData,
  UpperLimbModuleDataInput,
  UpperLimbTemporalSequence,
} from './dataFactories';

/** 프리셋에 저장할 공통 노출 필드(BK 유형과 무관한 직업 물리부담 정보) — 두 모듈 같다. */
export const UPPER_LIMB_PRESET_COMMON_FIELDS = [
  'main_task_name', 'direct_anatomic_link',
  'exposure_types', 'repetition_level',
  'daily_exposure_hours', 'shift_share_percent', 'days_per_week',
  'work_pattern', 'rest_distribution',
  'force_level', 'awkward_posture_level',
];

/**
 * 엔트리 필드 하나를 행에서 읽는 방법.
 *   trim  — String(셀 || 기존 값 || '').trim()
 *   raw   — String(셀 || 기존 값 || '') (숫자 칸 — 자르지 않는다)
 *   list  — splitList(셀)이 비지 않으면 그것, 아니면 기존 값 || []
 *   mode  — String(셀 || 기존 값 || 'manual').trim() || 'manual' (BK 선택 방식)
 *   chain — String(열1 셀 || 열2 셀 || … || 기존 값 || '').trim() (대체값 사슬)
 */
export type UpperLimbRowField =
  | { field: string; kind: 'trim' | 'raw' | 'list' | 'mode'; column: string }
  | { field: string; kind: 'chain'; columns: readonly string[] };

export interface UpperLimbModuleConfig {
  moduleId: string;
  presetLabel: string;
  presetFields: PresetFieldDef[];
  createModuleData(): UpperLimbModuleData;
  createJobEvaluation(sharedJobId: string): UpperLimbJobEvaluation;
  createDiagnosisEntry(diagnosis?: UpperLimbDiagnosisLike): UpperLimbDiagnosisEntry;
  columns: Record<string, string[]>;
  hasDataColumns: readonly string[];
  rowFields: readonly UpperLimbRowField[];
  temporalColumns: {
    recent_task_change: string;
    task_change_date: string;
    symptom_onset_interval: string;
    improves_with_rest: string;
  };
}

/** applyRow가 받는 값 가운데 이 코드가 읽는 모양(매니페스트의 BatchImportRowContext와 맞는다). */
interface UpperLimbImportRowContext {
  patient: unknown;
  row: unknown[];
  diagnosis: (UpperLimbDiagnosisLike & { id: string }) | null;
  job: { id: string } | null;
  colMap: Record<string, number | undefined>;
  getCell: (row: unknown[], index: number | undefined) => unknown;
  rowIndex: number;
}

function createPresetConfig(config: UpperLimbModuleConfig): PresetConfig {
  return {
    label: config.presetLabel,
    fields: config.presetFields,
    extractFromModule(moduleData: UpperLimbModuleDataInput, sharedJobId: string) {
      const jobEval = (moduleData.jobEvaluations || []).find(j => j.sharedJobId === sharedJobId);
      if (!jobEval) return null;
      // 첫 번째 유효 entry에서 공통 필드 추출
      const entry = (jobEval.diagnosisEntries || []).find(e =>
        e.daily_exposure_hours || e.main_task_name || (e.exposure_types && e.exposure_types.length)
      );
      if (!entry) return null;
      const result: Record<string, unknown> = {};
      for (const key of UPPER_LIMB_PRESET_COMMON_FIELDS) {
        const val = entry[key];
        if (val !== undefined && val !== '' && val !== null && !(Array.isArray(val) && val.length === 0)) {
          result[key] = val;
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    },
    applyToModule(moduleData: UpperLimbModuleDataInput, sharedJobId: string, presetData: Record<string, unknown>) {
      const jobEvals = [...(moduleData.jobEvaluations || [])];
      const idx = jobEvals.findIndex(j => j.sharedJobId === sharedJobId);
      if (idx < 0) {
        // jobEvaluation이 아직 없음 → 생성하고 _pendingPreset으로 보관
        jobEvals.push({ ...config.createJobEvaluation(sharedJobId), _pendingPreset: presetData });
        return { ...moduleData, jobEvaluations: jobEvals };
      }
      const jobEval = { ...jobEvals[idx] };
      if (!jobEval.diagnosisEntries || jobEval.diagnosisEntries.length === 0) {
        // 진단 엔트리 미생성 → _pendingPreset으로 보관
        jobEval._pendingPreset = presetData;
        jobEvals[idx] = jobEval;
        return { ...moduleData, jobEvaluations: jobEvals };
      }
      // 기존 엔트리에 공통 필드 직접 적용
      jobEval.diagnosisEntries = jobEval.diagnosisEntries.map(entry => {
        const patched = { ...entry };
        for (const key of UPPER_LIMB_PRESET_COMMON_FIELDS) {
          if (presetData[key] !== undefined) patched[key] = presetData[key];
        }
        return patched;
      });
      jobEvals[idx] = jobEval;
      return { ...moduleData, jobEvaluations: jobEvals };
    },
  };
}

function readRowField(spec: UpperLimbRowField, entry: UpperLimbDiagnosisEntry, cell: (key: string) => unknown): unknown {
  switch (spec.kind) {
    case 'trim':
      return String(cell(spec.column) || entry[spec.field] || '').trim();
    case 'raw':
      return String(cell(spec.column) || entry[spec.field] || '');
    case 'list':
      return splitList(cell(spec.column)).length ? splitList(cell(spec.column)) : (entry[spec.field] || []);
    case 'mode':
      return String(cell(spec.column) || entry[spec.field] || 'manual').trim() || 'manual';
    case 'chain': {
      let value: unknown = '';
      for (const column of spec.columns) {
        value = cell(column);
        if (value) break;
      }
      return String(value || entry[spec.field] || '').trim();
    }
  }
}

function createBatchImportConfig(config: UpperLimbModuleConfig): BatchImportConfig {
  return {
    columns: config.columns,
    applyRow({ patient, row, diagnosis, job, colMap, getCell }: UpperLimbImportRowContext) {
      if (!diagnosis || !job) return;
      const cell = (key: string) => getCell(row, colMap[key]);

      const hasModuleData = config.hasDataColumns.some(key => cell(key));
      if (!hasModuleData) return;

      const moduleData = ensureModule(patient, config.moduleId) as UpperLimbModuleDataInput;
      if (!moduleData.temporalSequence) {
        moduleData.temporalSequence = moduleData.temporalRelation || config.createModuleData().temporalSequence;
      }
      if (!Array.isArray(moduleData.jobEvaluations)) {
        moduleData.jobEvaluations = [];
      }

      let jobEvaluation = moduleData.jobEvaluations.find(item => item.sharedJobId === job.id);
      if (!jobEvaluation) {
        jobEvaluation = config.createJobEvaluation(job.id);
        moduleData.jobEvaluations.push(jobEvaluation);
      }
      if (!Array.isArray(jobEvaluation.diagnosisEntries)) {
        jobEvaluation.diagnosisEntries = [];
      }

      let entry = jobEvaluation.diagnosisEntries.find(item => item.diagnosisId === diagnosis.id);
      if (!entry) {
        entry = config.createDiagnosisEntry(diagnosis);
        jobEvaluation.diagnosisEntries.push(entry);
      }

      // 값을 모두 기존 엔트리 기준으로 먼저 읽고(옛 코드의 객체 리터럴과 같다) 그 순서대로 한 번에 적는다.
      const patch: Record<string, unknown> = {};
      for (const spec of config.rowFields) patch[spec.field] = readRowField(spec, entry, cell);
      Object.assign(entry, patch);

      const temporal = moduleData.temporalSequence as UpperLimbTemporalSequence;
      const columns = config.temporalColumns;
      if (cell(columns.recent_task_change)) {
        temporal.recent_task_change = String(cell(columns.recent_task_change)).trim();
      }
      if (cell(columns.task_change_date)) {
        temporal.task_change_date = parseDate(cell(columns.task_change_date));
      }
      if (cell(columns.symptom_onset_interval)) {
        temporal.symptom_onset_interval = String(cell(columns.symptom_onset_interval)).trim();
      }
      if (cell(columns.improves_with_rest)) {
        temporal.improves_with_rest = String(cell(columns.improves_with_rest)).trim();
      }
    },
  };
}

/** 프리셋·일괄 가져오기 설정을 모듈 config로 만든다(index.ts가 매니페스트에 넣는다). */
export function createUpperLimbModule(config: UpperLimbModuleConfig): { presetConfig: PresetConfig; batchImportConfig: BatchImportConfig } {
  return {
    presetConfig: createPresetConfig(config),
    batchImportConfig: createBatchImportConfig(config),
  };
}
