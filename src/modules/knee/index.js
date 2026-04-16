import { registerModule } from '../../core/moduleRegistry';
import { KneeEvaluation } from './KneeEvaluation';
import { createKneeModuleData, createKneeDiagnosis, createKneeJobExtras } from './utils/data';
import { computeKneeCalc, isKneeAssessmentComplete } from './utils/calculations';
import { kneeExportHandlers } from './utils/exportHandlers';

registerModule({
  id: 'knee',
  name: '무릎 (슬관절)',
  icon: '\uD83C\uDFC3',
  description: '근골격계 질환 업무관련성 평가',
  EvaluationComponent: KneeEvaluation,
  createModuleData: createKneeModuleData,
  createDiagnosis: createKneeDiagnosis,
  computeCalc: computeKneeCalc,
  isComplete: isKneeAssessmentComplete,
  exportHandlers: kneeExportHandlers,
  tabs: [
    { id: 'job', label: '신체부담 평가' },
  ],
  presetConfig: {
    label: '무릎 신체부담',
    fields: [
      { key: 'weight', label: '중량물 (kg/일)', type: 'number' },
      { key: 'squatting', label: '쪼그려앉기 (분/일)', type: 'number' },
      { key: 'stairs', label: '계단오르내리기', type: 'boolean' },
      { key: 'kneeTwist', label: '무릎 비틀림', type: 'boolean' },
      { key: 'startStop', label: '출발/정지 반복', type: 'boolean' },
      { key: 'tightSpace', label: '좁은 공간', type: 'boolean' },
      { key: 'kneeContact', label: '무릎 접촉/충격', type: 'boolean' },
      { key: 'jumpDown', label: '뛰어내리기', type: 'boolean' },
    ],
    extractFromModule(moduleData, sharedJobId) {
      const e = (moduleData.jobExtras || []).find(x => x.sharedJobId === sharedJobId);
      if (!e) return null;
      return {
        weight: e.weight, squatting: e.squatting,
        stairs: e.stairs, kneeTwist: e.kneeTwist, startStop: e.startStop,
        tightSpace: e.tightSpace, kneeContact: e.kneeContact, jumpDown: e.jumpDown,
      };
    },
    applyToModule(moduleData, sharedJobId, presetData) {
      const extras = [...(moduleData.jobExtras || [])];
      const idx = extras.findIndex(e => e.sharedJobId === sharedJobId);
      const patch = {
        ...createKneeJobExtras(sharedJobId),
        weight: String(presetData.weight ?? ''),
        squatting: String(presetData.squatting ?? ''),
        stairs: presetData.stairs ?? false,
        kneeTwist: presetData.kneeTwist ?? false,
        startStop: presetData.startStop ?? false,
        tightSpace: presetData.tightSpace ?? false,
        kneeContact: presetData.kneeContact ?? false,
        jumpDown: presetData.jumpDown ?? false,
      };
      if (idx >= 0) extras[idx] = { ...extras[idx], ...patch };
      else extras.push(patch);
      return { ...moduleData, jobExtras: extras };
    },
  },
});
