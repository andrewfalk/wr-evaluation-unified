import { registerModule } from '../../core/moduleRegistry';
import { ElbowEvaluation } from './ElbowEvaluation';
import { createElbowModuleData } from './utils/data';
import { computeElbowCalc, isElbowAssessmentComplete } from './utils/calculations';
import { elbowExportHandlers } from './utils/exportHandlers';

registerModule({
  id: 'elbow',
  name: '팔꿈치',
  icon: '🦾',
  description: '팔꿈치 질환 공통 신체부담 평가',
  EvaluationComponent: ElbowEvaluation,
  createModuleData: createElbowModuleData,
  computeCalc: computeElbowCalc,
  isComplete: isElbowAssessmentComplete,
  exportHandlers: elbowExportHandlers,
  tabs: [
    { id: 'burden', label: '신체부담 평가' },
  ],
});
