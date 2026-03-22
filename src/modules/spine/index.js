import { registerModule } from '../../core/moduleRegistry';
import { SpineEvaluation } from './SpineEvaluation';
import { createSpineModuleData } from './utils/data';
import { computeSpineCalc, isSpineAssessmentComplete } from './utils/calculations';
import { spineExportHandlers } from './utils/exportHandlers';

registerModule({
  id: 'spine',
  name: '척추 (요추)',
  icon: '\uD83E\uDDB4',
  description: 'MDDM 척추압박력 평가',
  EvaluationComponent: SpineEvaluation,
  createModuleData: createSpineModuleData,
  computeCalc: computeSpineCalc,
  isComplete: isSpineAssessmentComplete,
  exportHandlers: spineExportHandlers,
  tabs: [
    { id: 'tasks', label: '신체부담 평가' },
  ]
});
