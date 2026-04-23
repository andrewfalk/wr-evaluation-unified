import { registerModule } from '../../core/moduleRegistry';
import { ShoulderEvaluation } from './ShoulderEvaluation';
import { createShoulderModuleData, createShoulderDiagnosis, createShoulderJobExtras } from './utils/data';
import { computeShoulderCalc, isShoulderAssessmentComplete } from './utils/calculations';
import { shoulderExportHandlers } from './utils/exportHandlers';

registerModule({
  id: 'shoulder',
  name: '어깨',
  icon: '🙆',
  description: '어깨 근골격계 질환 업무관련성 평가',
  EvaluationComponent: ShoulderEvaluation,
  createModuleData: createShoulderModuleData,
  createDiagnosis: createShoulderDiagnosis,
  computeCalc: computeShoulderCalc,
  isComplete: isShoulderAssessmentComplete,
  exportHandlers: shoulderExportHandlers,
  tabs: [
    { id: 'job', label: '신체부담 평가' },
  ],
  presetConfig: {
    label: '어깨 신체부담',
    fields: [
      { key: 'overheadHours', label: '오버헤드 작업 (시간/일)', type: 'number' },
      { key: 'repetitiveMediumHours', label: '반복동작 중간속도 (시간/일)', type: 'number' },
      { key: 'repetitiveFastHours', label: '반복동작 고속 (시간/일)', type: 'number' },
      { key: 'heavyLoadCount', label: '중량물 취급 (회/일)', type: 'number' },
      { key: 'heavyLoadSeconds', label: '중량물 취급 (초/회)', type: 'number' },
      { key: 'vibrationHours', label: '진동 노출 (시간/일)', type: 'number' },
    ],
    extractFromModule(moduleData, sharedJobId) {
      const e = (moduleData.jobExtras || []).find(x => x.sharedJobId === sharedJobId);
      if (!e) return null;
      return {
        overheadHours: e.overheadHours, repetitiveMediumHours: e.repetitiveMediumHours,
        repetitiveFastHours: e.repetitiveFastHours, heavyLoadCount: e.heavyLoadCount,
        heavyLoadSeconds: e.heavyLoadSeconds, vibrationHours: e.vibrationHours,
      };
    },
    applyToModule(moduleData, sharedJobId, presetData) {
      const extras = [...(moduleData.jobExtras || [])];
      const idx = extras.findIndex(e => e.sharedJobId === sharedJobId);
      const patch = {
        ...createShoulderJobExtras(sharedJobId),
        overheadHours: String(presetData.overheadHours ?? ''),
        repetitiveMediumHours: String(presetData.repetitiveMediumHours ?? ''),
        repetitiveFastHours: String(presetData.repetitiveFastHours ?? ''),
        heavyLoadCount: String(presetData.heavyLoadCount ?? ''),
        heavyLoadSeconds: String(presetData.heavyLoadSeconds ?? ''),
        vibrationHours: String(presetData.vibrationHours ?? ''),
      };
      if (idx >= 0) extras[idx] = { ...extras[idx], ...patch };
      else extras.push(patch);
      return { ...moduleData, jobExtras: extras };
    },
  },
});
