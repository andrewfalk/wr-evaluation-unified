import { registerModule } from '../../core/moduleRegistry';
import { KneeEvaluation } from './KneeEvaluation';
import { createKneeModuleData, createKneeDiagnosis } from './utils/data';
import { computeKneeCalc, isKneeAssessmentComplete } from './utils/calculations';
import { kneeExportHandlers } from './utils/exportHandlers';

registerModule({
  id: 'knee',
  name: '무릎 (슬관절)',
  icon: '\uD83E\uDDBF',
  description: '근골격계 질환 업무관련성 평가',
  EvaluationComponent: KneeEvaluation,
  createModuleData: createKneeModuleData,
  createDiagnosis: createKneeDiagnosis,
  computeCalc: computeKneeCalc,
  isComplete: isKneeAssessmentComplete,
  exportHandlers: kneeExportHandlers,
  tabs: [
    { id: 'job', label: '신체부담 평가' },
  ]
});
