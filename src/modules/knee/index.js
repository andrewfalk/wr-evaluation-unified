import { registerModule } from '../../core/moduleRegistry';
import { KneeEvaluation } from './KneeEvaluation';
import { createKneeModuleData, createKneeDiagnosis, createKneeJobExtras } from './utils/data';
import { computeKneeCalc, isKneeAssessmentComplete } from './utils/calculations';
import { kneeExportHandlers } from './utils/exportHandlers';
import { parseKlg, parseBool, ensureModule } from '../../core/utils/batchImportHelpers';
import { jobScopeWriteField, stringCoerce } from '../../core/utils/videoMapping';

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
  // 영상 분석 자동 매핑(§8.10). squatting(분/일)만 자동제안. kneeTwist는 candidate(suspectedKneeTwist)로 격하 — 모듈 미기입.
  videoMappingConfig: {
    scope: 'job',
    featureKeys: ['squatDuration'],
    coerce: stringCoerce, // squatting은 문자열 저장
    writeField: (moduleData, ctx, featureKey, value) =>
      jobScopeWriteField('knee', createKneeJobExtras, moduleData, ctx, featureKey, value),
  },
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
  batchImportConfig: {
    columns: {
      klgRight: ['klg(우)', 'klg_right'],
      klgLeft: ['klg(좌)', 'klg_left'],
      kneeWeight: ['중량물(kg)', 'jobweight'],
      kneeSquatting: ['쪼그려앉기', 'squat'],
      kneeStairs: ['계단오르내리기', 'stair'],
      kneeTwist: ['무릎비틀기', 'twist'],
      kneeStartStop: ['출발정지반복', 'startstop'],
      kneeTightSpace: ['좁은공간', 'tightspace'],
      kneeContact: ['무릎접촉충격', 'contact'],
      kneeJumpDown: ['점프착지', 'jump'],
    },
    applyRow({ patient, row, diagnosis, job, colMap, getCell }) {
      if (diagnosis && (getCell(row, colMap.klgRight) || getCell(row, colMap.klgLeft))) {
        diagnosis.klgRight = diagnosis.klgRight || parseKlg(getCell(row, colMap.klgRight));
        diagnosis.klgLeft = diagnosis.klgLeft || parseKlg(getCell(row, colMap.klgLeft));
      }

      const hasKneeData = [colMap.kneeWeight, colMap.kneeSquatting, colMap.kneeStairs, colMap.kneeTwist, colMap.kneeStartStop, colMap.kneeTightSpace, colMap.kneeContact, colMap.kneeJumpDown].some(index => getCell(row, index));
      if (!hasKneeData || !job) return;

      const kneeData = ensureModule(patient, 'knee');
      if (!kneeData.jobExtras) kneeData.jobExtras = [];
      let extra = (kneeData.jobExtras || []).find(item => item.sharedJobId === job.id);
      if (!extra) {
        extra = createKneeJobExtras(job.id);
        kneeData.jobExtras.push(extra);
      }
      Object.assign(extra, {
        weight: String(getCell(row, colMap.kneeWeight) || extra.weight || ''),
        squatting: String(getCell(row, colMap.kneeSquatting) || extra.squatting || ''),
        stairs: extra.stairs || parseBool(getCell(row, colMap.kneeStairs)),
        kneeTwist: extra.kneeTwist || parseBool(getCell(row, colMap.kneeTwist)),
        startStop: extra.startStop || parseBool(getCell(row, colMap.kneeStartStop)),
        tightSpace: extra.tightSpace || parseBool(getCell(row, colMap.kneeTightSpace)),
        kneeContact: extra.kneeContact || parseBool(getCell(row, colMap.kneeContact)),
        jumpDown: extra.jumpDown || parseBool(getCell(row, colMap.kneeJumpDown)),
      });
    },
  },
});
