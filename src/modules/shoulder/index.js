import { registerModule } from '../../core/moduleRegistry';
import { ShoulderEvaluation } from './ShoulderEvaluation';
import { createShoulderModuleData, createShoulderDiagnosis } from './utils/data';
import { computeShoulderCalc, isShoulderAssessmentComplete } from './utils/calculations';
import { shoulderExportHandlers } from './utils/exportHandlers';

registerModule({
  id: 'shoulder',
  name: '어깨',
  icon: '\uD83D\uDCAA',
  description: '어깨 근골격계 질환 업무관련성 평가',
  EvaluationComponent: ShoulderEvaluation,
  createModuleData: createShoulderModuleData,
  createDiagnosis: createShoulderDiagnosis,
  computeCalc: computeShoulderCalc,
  isComplete: isShoulderAssessmentComplete,
  exportHandlers: shoulderExportHandlers,
  tabs: [
    { id: 'job', label: '신체부담 평가' },
  ]
});
