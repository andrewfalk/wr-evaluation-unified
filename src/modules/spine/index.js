import { registerModule } from '../../core/moduleRegistry';
import { SpineEvaluation } from './SpineEvaluation';
import { createSpineModuleData, createTask } from './utils/data';
import { computeSpineCalc, isSpineAssessmentComplete } from './utils/calculations';
import { SPINE_FORMULA_V513 } from './utils/formulaVersion';
import { spineExportHandlers } from './utils/exportHandlers';
import { ensureModule } from '../../core/utils/batchImportHelpers';
import { taskScopeWriteField, numberCoerce } from '../../core/utils/videoMapping';

registerModule({
  id: 'spine',
  name: '요추(허리)',
  icon: '\u2695\uFE0F',
  description: 'MDDM 요추 압박력 및 BK2110 전신진동 평가',
  EvaluationComponent: SpineEvaluation,
  createModuleData: createSpineModuleData,
  computeCalc: computeSpineCalc,
  isComplete: isSpineAssessmentComplete,
  exportHandlers: spineExportHandlers,
  tabs: [
    { id: 'tasks', label: '신체부담 평가' },
  ],
  // 영상 분석 자동 매핑(§8.10). 공정≈task 1:1(task-scope). frequency(회/일)·timeValue(1회 소요시간)
  // 자동제안+수기확인. cycleSeconds는 항상 초 단위로 기입(timeUnit='sec'). trunkPostureG는 candidate.
  videoMappingConfig: {
    scope: 'task',
    featureKeys: ['cyclesPerDay', 'cycleSeconds'],
    coerce: numberCoerce, // frequency·timeValue는 숫자 저장
    // 직업 미연결 레거시 task도 대상 후보로 허용(extractFromModule과 동일 fallback). cervical은 미적용(엄격).
    taskFallbackUnlinked: true,
    writeField: (moduleData, ctx, featureKey, value) =>
      taskScopeWriteField('spine', moduleData, ctx, featureKey, value,
        (fk) => (fk === 'cycleSeconds' ? { timeUnit: 'sec' } : undefined)),
  },
  presetConfig: {
    label: '척추 작업목록',
    fields: 'tasks',
    extractFromModule(moduleData, sharedJobId) {
      let tasks = (moduleData.tasks || []).filter(t => t.sharedJobId === sharedJobId);
      // 연결되지 않은 task만 남아 있는 예전 데이터도 허용한다.
      if (!tasks.length) {
        const unlinked = (moduleData.tasks || []).filter(t => !t.sharedJobId);
        if (unlinked.length) tasks = unlinked;
      }
      if (!tasks.length) return null;
      return {
        tasks: tasks.map(({ name, posture, weight, frequency, timeValue, timeUnit, correctionFactor }) =>
          ({ name, posture, weight, frequency, timeValue, timeUnit, correctionFactor })),
      };
    },
    applyToModule(moduleData, sharedJobId, presetData) {
      // sharedJobId가 비어있는 기본/레거시 태스크는 첫 직업에 귀속될 예정이므로 preset 적용 시 덮어씀
      const otherTasks = (moduleData.tasks || []).filter(t => t.sharedJobId && t.sharedJobId !== sharedJobId);
      const newTasks = (presetData.tasks || []).map((t, i) => ({
        ...createTask(i, sharedJobId),
        ...t,
        sharedJobId,
      }));
      return { ...moduleData, tasks: [...otherTasks, ...newTasks], formulaVersion: SPINE_FORMULA_V513 };
    },
  },
  batchImportConfig: {
    columns: {
      taskName: ['작업명', 'task'],
      posture: ['자세코드', 'posture'],
      taskWeight: ['작업중량', 'taskweight'],
      frequency: ['횟수/분', 'frequency'],
      timeValue: ['시간값', 'timevalue'],
      timeUnit: ['시간단위', 'timeunit'],
      correctionFactor: ['보정계수', 'correction'],
    },
    applyRow({ patient, row, job, colMap, getCell }) {
      const hasSpineData = [colMap.taskName, colMap.posture].some(index => getCell(row, index));
      if (!hasSpineData) return;

      const spineData = ensureModule(patient, 'spine');
      if (!spineData.tasks) spineData.tasks = [];
      const taskName = String(getCell(row, colMap.taskName) || '').trim();
      const posture = String(getCell(row, colMap.posture) || '').trim();
      if (!taskName && !posture) return;

      let task = (spineData.tasks || []).find(item => item.name === taskName && item.posture === posture);
      if (!task) {
        task = createTask((spineData.tasks || []).length, job?.id || '');
        spineData.tasks.push(task);
      }
      Object.assign(task, {
        sharedJobId: job?.id || task.sharedJobId,
        name: taskName || task.name,
        posture: posture || task.posture,
        weight: Number(getCell(row, colMap.taskWeight) || task.weight || 0),
        frequency: Number(getCell(row, colMap.frequency) || task.frequency || 0),
        timeValue: Number(getCell(row, colMap.timeValue) || task.timeValue || 0),
        timeUnit: String(getCell(row, colMap.timeUnit) || task.timeUnit || 'sec').trim().toLowerCase(),
        correctionFactor: Number(getCell(row, colMap.correctionFactor) || task.correctionFactor || 1),
      });
      // 실제 task 생성/갱신이 일어난 경우에만 v5.1.3 공식으로 승격
      spineData.formulaVersion = SPINE_FORMULA_V513;
    },
  },
});
