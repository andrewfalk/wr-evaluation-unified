import { registerModule } from '../../core/moduleRegistry';
import { cervicalPresetChips } from './presetPreview';
import { cervicalNarrative } from './narrative';
import { CervicalEvaluation } from './CervicalEvaluation';
import { createCervicalModuleData, createCervicalTask, EXPOSURE_TYPE_OPTIONS } from './utils/data';
import { computeCervicalCalc, isCervicalAssessmentComplete } from './utils/calculations';
import { ensureModule, parseYesNo, splitList } from '../../core/utils/batchImportHelpers';
import { taskScopeWriteField, stringCoerce } from '../../core/utils/videoMapping';
import { cervicalBatchExport } from './batchExport';
import type { ComponentType } from 'react';
import type { ModuleEvaluationProps, ModuleManifest } from '../../core/modules/manifest';

/** applyRow가 받는 값 가운데 이 모듈이 읽는 모양(일괄 가져오기 — src/core/services/batchImport.ts). */
interface CervicalImportRowContext {
  patient: unknown;
  row: unknown[];
  diagnosis: unknown | null;
  job: { id: string } | null;
  colMap: Record<string, number | undefined>;
  getCell: (row: unknown[], index: number | undefined) => unknown;
  rowIndex: number;
}

/** 경추 작업 한 줄(createCervicalTask의 모양 — JS 팩토리의 추론 타입은 exposure_types가 never[]라 따로 적는다). */
interface CervicalTask {
  id: number;
  sharedJobId: string;
  name: string;
  exposure_types: string[];
  load_weight_kg: string;
  carry_hours_per_shift: string;
  forced_neck_posture: string;
  neck_nonneutral_hours_per_day: string;
  combined_flexion_rotation_posture: string;
  precision_work: string;
  notes: string;
}

interface CervicalModuleShape {
  tasks?: CervicalTask[];
}

const EXPOSURE_TYPE_LOOKUP = EXPOSURE_TYPE_OPTIONS.reduce<Record<string, string>>((acc, option) => {
  acc[option.value] = option.value;
  acc[option.label] = option.value;
  return acc;
}, {});

function parseExposureTypes(value: unknown): string[] {
  return splitList(value)
    .map(item => EXPOSURE_TYPE_LOOKUP[item] || item)
    .filter(mapped => EXPOSURE_TYPE_OPTIONS.some(option => option.value === mapped));
}

registerModule({
  id: 'cervical',
  name: '경추(목)',
  icon: '👤',
  description: '경추 질환 공통 부담 노출 평가',
  // 대시보드의 짧은 이름·색(P2-85b — 예전 Dashboard의 MODULE_LABELS·MODULE_COLORS 값 그대로).
  shortName: '목',
  color: '#06b6d4',
  EvaluationComponent: CervicalEvaluation as ComponentType<ModuleEvaluationProps>,
  createModuleData: createCervicalModuleData,
  computeCalc: computeCervicalCalc,
  isComplete: isCervicalAssessmentComplete,
  tabs: [
    { id: 'burden', label: '부담 노출 평가' },
  ],
  // 영상 분석 자동 매핑(§8.10). 공정≈task 1:1(task-scope). 목 20°↑ 굴곡 유지시간·굴곡 성분
  // 자동제안. neckCombinedFlexRot(회전·복합)은 candidate로 격하 — 모듈 미기입.
  videoMappingConfig: {
    scope: 'task',
    featureKeys: ['neckFlexionOver20HoursPerDay', 'neckForcedFlexion'],
    coerce: stringCoerce, // neck_* 필드는 문자열 저장
    writeField: (moduleData: unknown, ctx: unknown, featureKey: string, value: unknown) =>
      taskScopeWriteField('cervical', moduleData, ctx, featureKey, value),
  },
  presetConfig: {
    label: '경추 작업목록',
    fields: [{ key: 'tasks', type: 'taskList', chips: cervicalPresetChips }],
    extractFromModule(moduleData: CervicalModuleShape, sharedJobId: string) {
      const tasks = (moduleData.tasks || []).filter(task => task.sharedJobId === sharedJobId);
      if (!tasks.length) return null;

      return {
        tasks: tasks.map(task => ({
          name: task.name,
          exposure_types: [...(task.exposure_types || [])],
          load_weight_kg: task.load_weight_kg,
          carry_hours_per_shift: task.carry_hours_per_shift,
          forced_neck_posture: task.forced_neck_posture,
          neck_nonneutral_hours_per_day: task.neck_nonneutral_hours_per_day,
          combined_flexion_rotation_posture: task.combined_flexion_rotation_posture,
          precision_work: task.precision_work,
          notes: task.notes,
        })),
      };
    },
    applyToModule(moduleData: CervicalModuleShape, sharedJobId: string, presetData: { tasks?: Array<Partial<CervicalTask>> }) {
      // sharedJobId가 비어있는 레거시 태스크는 첫 직업에 귀속될 예정이므로 preset 적용 시 덮어씀
      const otherTasks = (moduleData.tasks || []).filter(task => task.sharedJobId && task.sharedJobId !== sharedJobId);
      const newTasks = (presetData.tasks || []).map((task, index) => ({
        ...createCervicalTask(index, sharedJobId),
        ...task,
        sharedJobId,
        exposure_types: [...(task.exposure_types || [])],
      }));

      return {
        ...moduleData,
        tasks: [...otherTasks, ...newTasks],
      };
    },
  },
  batchExport: cervicalBatchExport,
  narrative: cervicalNarrative,
  batchImportConfig: {
    columns: {
      cervicalTaskName: ['경추_작업명', 'cervical_task_name'],
      cervicalExposureTypes: ['경추_노출유형', 'cervical_exposure_types'],
      cervicalLoadWeightKg: ['경추_하중(kg)', 'cervical_load_weight_kg'],
      cervicalCarryHoursPerShift: ['경추_교대당운반시간', 'cervical_carry_hours_per_shift'],
      cervicalForcedNeckPosture: ['경추_부자연스러운목자세강제', 'cervical_forced_neck_posture'],
      cervicalNeckNonneutralHours: ['경추_비중립정적자세시간', 'cervical_neck_nonneutral_hours_per_day'],
      cervicalCombinedFlexionRotationPosture: ['경추_굴곡신전회전측굴동시발생', 'cervical_combined_flexion_rotation_posture'],
      cervicalPrecisionWork: ['경추_고도의정밀작업', 'cervical_precision_work'],
      cervicalNotes: ['경추_메모', 'cervical_notes'],
    },
    applyRow({ patient, row, job, colMap, getCell, rowIndex }: CervicalImportRowContext) {
      if (!job) return;

      const hasCervicalData = [
        colMap.cervicalTaskName,
        colMap.cervicalExposureTypes,
        colMap.cervicalLoadWeightKg,
        colMap.cervicalCarryHoursPerShift,
        colMap.cervicalForcedNeckPosture,
        colMap.cervicalNeckNonneutralHours,
        colMap.cervicalCombinedFlexionRotationPosture,
        colMap.cervicalPrecisionWork,
        colMap.cervicalNotes,
      ].some(index => getCell(row, index));
      if (!hasCervicalData) return;

      const cervicalData = ensureModule(patient, 'cervical') as CervicalModuleShape;
      if (!Array.isArray(cervicalData.tasks)) {
        cervicalData.tasks = [];
      }

      const taskName = String(getCell(row, colMap.cervicalTaskName) || '').trim();
      const exposureTypes = parseExposureTypes(getCell(row, colMap.cervicalExposureTypes));
      const taskKey = taskName || `__row_${rowIndex}`;

      let task = (cervicalData.tasks || []).find(item =>
        item.sharedJobId === job.id
        && (item.name || '') === taskKey
      );

      if (!task) {
        const jobTaskCount = (cervicalData.tasks || []).filter(item => item.sharedJobId === job.id).length;
        task = createCervicalTask(jobTaskCount, job.id);
        task.name = taskName || task.name;
        cervicalData.tasks.push(task);
      }

      Object.assign(task, {
        sharedJobId: job.id,
        name: taskName || task.name,
        exposure_types: exposureTypes.length > 0 ? exposureTypes : (task.exposure_types || []),
        load_weight_kg: String(getCell(row, colMap.cervicalLoadWeightKg) || task.load_weight_kg || ''),
        carry_hours_per_shift: String(getCell(row, colMap.cervicalCarryHoursPerShift) || task.carry_hours_per_shift || ''),
        forced_neck_posture: parseYesNo(getCell(row, colMap.cervicalForcedNeckPosture), task.forced_neck_posture || ''),
        neck_nonneutral_hours_per_day: String(getCell(row, colMap.cervicalNeckNonneutralHours) || task.neck_nonneutral_hours_per_day || ''),
        combined_flexion_rotation_posture: parseYesNo(
          getCell(row, colMap.cervicalCombinedFlexionRotationPosture),
          task.combined_flexion_rotation_posture || ''
        ),
        precision_work: parseYesNo(getCell(row, colMap.cervicalPrecisionWork), task.precision_work || ''),
        notes: String(getCell(row, colMap.cervicalNotes) || task.notes || '').trim(),
      });
    },
  },
} satisfies ModuleManifest);
