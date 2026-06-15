import { registerModule } from '../../core/moduleRegistry';
import { ShoulderEvaluation } from './ShoulderEvaluation';
import { createShoulderModuleData, createShoulderDiagnosis, createShoulderJobExtras } from './utils/data';
import { computeShoulderCalc, isShoulderAssessmentComplete } from './utils/calculations';
import { shoulderExportHandlers } from './utils/exportHandlers';
import { ensureModule } from '../../core/utils/batchImportHelpers';
import { jobScopeWriteField, stringCoerce } from '../../core/utils/videoMapping';

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
  // 영상 분석 자동 매핑(§8.10). overhead·반복(중/고속) 시간(시간/일) 자동제안.
  // vibrationToolUseDurationCandidate는 candidate로 격하 — 모듈 미기입(가속도 측정 불가).
  videoMappingConfig: {
    scope: 'job',
    featureKeys: ['overheadHours', 'repetitiveMediumHours', 'repetitiveFastHours'],
    coerce: stringCoerce, // *_Hours는 문자열 저장
    writeField: (moduleData, ctx, featureKey, value) =>
      jobScopeWriteField('shoulder', createShoulderJobExtras, moduleData, ctx, featureKey, value),
  },
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
  batchImportConfig: {
    columns: {
      ellmanRight: ['ellman(우)', 'ellman_right'],
      ellmanLeft: ['ellman(좌)', 'ellman_left'],
      shoulderOverhead: ['오버헤드', 'overhead'],
      shoulderMedium: ['반복중간', 'repetitivemedium'],
      shoulderFast: ['반복빠름', 'repetitivefast'],
      shoulderHeavyCount: ['중량물횟수', 'heavyloadcount'],
      shoulderHeavySeconds: ['중량물시간', 'heavyloadseconds'],
      shoulderVibration: ['진동(시간/일)', 'vibration'],
    },
    applyRow({ patient, row, diagnosis, job, colMap, getCell }) {
      if (diagnosis && (getCell(row, colMap.ellmanRight) || getCell(row, colMap.ellmanLeft))) {
        diagnosis.ellmanRight = diagnosis.ellmanRight || String(getCell(row, colMap.ellmanRight) || '').trim();
        diagnosis.ellmanLeft = diagnosis.ellmanLeft || String(getCell(row, colMap.ellmanLeft) || '').trim();
      }

      const hasShoulderData = [colMap.shoulderOverhead, colMap.shoulderMedium, colMap.shoulderFast, colMap.shoulderHeavyCount, colMap.shoulderHeavySeconds, colMap.shoulderVibration].some(index => getCell(row, index));
      if (!hasShoulderData || !job) return;

      const shoulderData = ensureModule(patient, 'shoulder');
      if (!shoulderData.jobExtras) shoulderData.jobExtras = [];
      let extra = (shoulderData.jobExtras || []).find(item => item.sharedJobId === job.id);
      if (!extra) {
        extra = createShoulderJobExtras(job.id);
        shoulderData.jobExtras.push(extra);
      }
      Object.assign(extra, {
        overheadHours: String(getCell(row, colMap.shoulderOverhead) || extra.overheadHours || ''),
        repetitiveMediumHours: String(getCell(row, colMap.shoulderMedium) || extra.repetitiveMediumHours || ''),
        repetitiveFastHours: String(getCell(row, colMap.shoulderFast) || extra.repetitiveFastHours || ''),
        heavyLoadCount: String(getCell(row, colMap.shoulderHeavyCount) || extra.heavyLoadCount || ''),
        heavyLoadSeconds: String(getCell(row, colMap.shoulderHeavySeconds) || extra.heavyLoadSeconds || ''),
        vibrationHours: String(getCell(row, colMap.shoulderVibration) || extra.vibrationHours || ''),
      });
    },
  },
});
